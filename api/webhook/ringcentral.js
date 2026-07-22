// api/webhook/ringcentral.js
//
// Endpoint que RingCentral llama cuando detecta una llamada perdida.
// URL final (una vez desplegado): https://<tu-proyecto>.vercel.app/api/webhook/ringcentral
// Esta es la URL que se registra como target de la suscripción en RingCentral.

const { getSupabaseAdmin } = require('../../lib/supabase');
const { sendSms } = require('../../lib/ringcentral');

module.exports = async (req, res) => {
  // 1. Handshake de validación: RingCentral manda este header SOLO al crear
  //    la suscripción, para confirmar que este endpoint es el dueño de la URL.
  //    Hay que responder con el MISMO valor en el header, en menos de 3s.
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

    // LOG TEMPORAL DE DIAGNOSTICO -- quitar una vez confirmado el formato real
    console.log('EVENTO RECIBIDO:', JSON.stringify(event));

    // El payload trae la sesión de telefonía; nos interesa el evento
    // de llamada perdida (missedCall) dentro de body.parties[0].
    const body = event.body || {};
    const parties = body.parties || [];
    const party = parties[0] || {};
    const extensionId = party.extensionId;
    const missedCall = party.missedCall === true;

    if (!missedCall || !extensionId) {
      // No es un evento de llamada perdida -- se reconoce igual con 200
      // para que RingCentral no reintente ni marque el endpoint como fallido.
      return res.status(200).json({ ignored: true });
    }

    const clientPhone = party.from && party.from.phoneNumber;
    const receivedAt = body.eventTime ? new Date(body.eventTime) : new Date();
    const deadlineAt = new Date(receivedAt.getTime() + 30 * 60 * 1000);

    const supabase = getSupabaseAdmin();

    // 2. Buscar al asesor dueño de esa extensión
    const { data: advisor, error: advisorError } = await supabase
      .from('advisors')
      .select('*')
      .eq('ringcentral_extension_id', String(extensionId))
      .single();

    if (advisorError || !advisor) {
      console.error('No se encontró asesor para la extensión', extensionId, advisorError);
      return res.status(200).json({ warning: 'advisor_not_found', extensionId });
    }

    // 3. Registrar el caso (idempotente: si ya existe esta sesión, no duplica)
    const { data: existing } = await supabase
      .from('missed_calls')
      .select('id')
      .eq('ringcentral_session_id', String(body.telephonySessionId))
      .maybeSingle();

    if (existing) {
      return res.status(200).json({ duplicate: true });
    }

    const { data: missedCallRow, error: insertError } = await supabase
      .from('missed_calls')
      .insert({
        ringcentral_session_id: String(body.telephonySessionId),
        client_phone: clientPhone,
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

    // 4. Notificar al cliente por SMS desde la línea del asesor
    if (advisor.sms_capable_number && clientPhone) {
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
    }

    return res.status(200).json({ ok: true, missed_call_id: missedCallRow.id });
  } catch (err) {
    console.error('Error en webhook de RingCentral:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
};