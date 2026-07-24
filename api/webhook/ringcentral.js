// api/webhook/ringcentral.js
//
// Endpoint que RingCentral llama cuando detecta eventos de telefonía.
// Maneja dos escenarios:
//  1) Llamada perdida (missedCall === true) -> crea/actualiza el caso.
//  2) Llamada entrante CONTESTADA (direction Inbound, status Answered) que
//     coincide con un caso abierto -> el cliente se autoatendió llamando
//     de nuevo, sin que el asesor haya devuelto la llamada. Se categoriza
//     aparte (Recontacto_*) según el tiempo transcurrido desde la llamada
//     perdida original, para no mezclarlo con el desempeño real del asesor.

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
    const eventTime = body.eventTime ? new Date(body.eventTime) : new Date();

    const supabase = getSupabaseAdmin();

    // ---------- Escenario 2: cliente se autoatiende (llamada contestada) ----------
    if (!missedCall) {
      const isAnsweredInbound =
        party.direction === 'Inbound' && party.status && party.status.code === 'Answered';

      if (!isAnsweredInbound || !extensionId) {
        return res.status(200).json({ ignored: true });
      }

      const clientPhone = party.from && party.from.phoneNumber;

      const { data: advisor } = await supabase
        .from('advisors')
        .select('*')
        .eq('ringcentral_extension_id', String(extensionId))
        .single();

      if (!advisor) {
        return res.status(200).json({ warning: 'advisor_not_found_for_answered_call', extensionId });
      }

      const { data: openCase } = await supabase
        .from('missed_calls')
        .select('id, received_at, deadline_at')
        .eq('client_phone', clientPhone)
        .eq('advisor_id', advisor.id)
        .in('status', ['Pendiente', 'Reagendado'])
        .order('received_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      // No hay caso abierto para este cliente -- es una llamada contestada
      // normal, no relacionada a ningun protocolo de callback pendiente.
      if (!openCase) {
        return res.status(200).json({ ignored: true, reason: 'no_open_case_for_answered_call' });
      }

      const minSinceMissed = (eventTime - new Date(openCase.received_at)) / 60000;
      const withinDeadline = eventTime <= new Date(openCase.deadline_at);

      let newStatus;
      if (minSinceMissed <= 5) {
        newStatus = 'Recontacto_inmediato';
      } else if (withinDeadline) {
        newStatus = 'Recontacto_a_tiempo';
      } else {
        newStatus = 'Recontacto_tarde';
      }

      await supabase
        .from('missed_calls')
        .update({ status: newStatus, completed_at: eventTime.toISOString() })
        .eq('id', openCase.id);

      return res.status(200).json({
        ok: true,
        resolved_by_client_recontact: openCase.id,
        new_status: newStatus,
        minutes_since_missed: Math.round(minSinceMissed),
      });
    }

    // ---------- Escenario 1: llamada perdida ----------
    if (!extensionId) {
      return res.status(200).json({ ignored: true });
    }

    const clientPhone = party.from && party.from.phoneNumber;
    const clientName = (party.from && party.from.name) || null;
    const receivedAt = eventTime;
    const deadlineAt = new Date(receivedAt.getTime() + 20 * 60 * 1000);

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