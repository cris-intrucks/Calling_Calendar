// api/webhook/ringcentral.js
//
// Endpoint que RingCentral llama cuando detecta una llamada perdida.
// URL final (una vez desplegado): https://<tu-proyecto>.vercel.app/api/webhook/ringcentral
// Esta es la URL que se registra como target de la suscripción en RingCentral.

const { getSupabaseAdmin } = require('../../lib/supabase');
const { sendSms } = require('../../lib/ringcentral');

module.exports = async (req, res) => {
  const validationToken = req.headers['validation-token'];
  if (validationToken) {
    res.setHeader('Validation-Token', validationToken);
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const event = req.body;
    console.log('EVENTO RECIBIDO:', JSON.stringify(event));

    const body = event.body || {};
    const parties = body.parties || [];
    const party = parties[0] || {};
    const extensionId = party.extensionId;
    const missedCall = party.missedCall === true;

    if (!missedCall || !extensionId) {
      return res.status(200).json({ ignored: true });
    }

    const clientPhone = party.from && party.from.phoneNumber;
    // El nombre solo viene si RingCentral pudo resolverlo (directorio de la
    // empresa o CNAM del operador del cliente) -- puede venir null.
    const clientName = (party.from && party.from.name) || null;
    const receivedAt = body.eventTime ? new Date(body.eventTime) : new Date();
    const deadlineAt = new Date(receivedAt.getTime() + 20 * 60 * 1000);

    const supabase = getSupabaseAdmin();

    const { data: advisor, error: advisorError } = await supabase
      .from('advisors')
      .select('*')
      .eq('ringcentral_extension_id', String(extensionId))
      .single();

    if (advisorError || !advisor) {
      console.error('No se encontró asesor para la extensión', extensionId, advisorError);
      return res.status(200).json({ warning: 'advisor_not_found', extensionId });
    }

    const { data: existing } = await supabase
      .from('missed_calls')
      .select('id')
      .eq('ringcentral_session_id', String(body.telephonySessionId))
      .maybeSingle();

    if (existing) {
      return res.status(200).json({ duplicate: true });
    }

    // Deduplicación por cliente: si ya hay un caso abierto para este mismo
    // cliente+asesor, no se crea uno nuevo -- se actualiza con el intento
    // más reciente. Traemos tambien client_name existente para no perder
    // el nombre si ya se habia capturado antes y este nuevo evento no lo trae.
    const { data: openCase } = await supabase
      .from('missed_calls')
      .select('id, client_name')
      .eq('client_phone', clientPhone)
      .eq('advisor_id', advisor.id)
      .in('status', ['Pendiente', 'Reagendado'])
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (openCase) {
      await supabase
        .from('missed_calls')
        .update({
          received_at: receivedAt.toISOString(),
          deadline_at: deadlineAt.toISOString(),
          client_name: clientName || openCase.client_name,
        })
        .eq('id', openCase.id);

      return res.status(200).json({ merged_into_existing_case: openCase.id });
    }

    const { data: missedCallRow, error: insertError } = await supabase
      .from('missed_calls')
      .insert({
        ringcentral_session_id: String(body.telephonySessionId),
        client_phone: clientPhone,
        client_name: clientName,
        advisor_id: advisor.id,
        received_at: receivedAt.toISOString(),
        deadline_at: deadlineAt.toISOString(),
        status: 'Pendiente',
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error insertando missed_call', insertError);
      return res.status(500).json({ error: 'insert_failed' });
    }

    if (advisor.sms_capable_number && clientPhone) {
      try {
        const deadlineLocal = deadlineAt.toLocaleTimeString('es-CO', {
          hour: '2-digit',
          minute: '2-digit',
        });
        await sendSms({
          fromExtensionId: advisor.ringcentral_extension_id,
          fromNumber: advisor.sms_capable_number,
          toNumber: clientPhone,
          text: `Recibimos tu llamada. Un asesor te contactará antes de las ${deadlineLocal}.`,
        });

        await supabase
          .from('missed_calls')
          .update({ sms_sent_at: new Date().toISOString() })
          .eq('id', missedCallRow.id);
      } catch (smsErr) {
        console.error('Error enviando SMS (el caso ya quedo guardado):', smsErr.message);
      }
    }

    return res.status(200).json({ ok: true, missed_call_id: missedCallRow.id });
  } catch (err) {
    console.error('Error en webhook de RingCentral:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
};