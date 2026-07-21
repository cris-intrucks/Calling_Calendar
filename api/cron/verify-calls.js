// api/cron/verify-calls.js
//
// El corazón de la validación: cruza lo que el asesor reportó (o la falta
// de reporte) contra el log real de llamadas de RingCentral, y resuelve
// el status final de cada caso. Esto es lo que hace el indicador confiable
// en vez de depender de autorreporte.

const { getSupabaseAdmin } = require('../../lib/supabase');
const { getOutboundCallLog } = require('../../lib/ringcentral');
const { isAuthorizedCron } = require('../../lib/cronAuth');

module.exports = async (req, res) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const supabase = getSupabaseAdmin();

  // Trae casos abiertos (no resueltos aún) junto con sus intentos y asesor
  const { data: openCases, error } = await supabase
    .from('missed_calls')
    .select('*, advisors(*), call_attempts(*)')
    .in('status', ['Pendiente', 'Reagendado']);

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'query_failed' });
  }

  const updates = [];

  for (const c of openCases || []) {
    const attempts = c.call_attempts || [];
    const attempt1 = attempts.find((a) => a.attempt_number === 1);
    const attempt2 = attempts.find((a) => a.attempt_number === 2);

    // 1. Verificar contra el log real si el asesor marcó "contactado" pero
    //    no quedó verificado aún.
    for (const attempt of [attempt1, attempt2]) {
      if (attempt && attempt.outcome === 'contactado' && !attempt.verified_via_api) {
        const realCall = await getOutboundCallLog({
          extensionId: c.advisors.ringcentral_extension_id,
          phoneNumber: c.client_phone,
          dateFrom: c.received_at,
        });

        if (realCall) {
          await supabase
            .from('call_attempts')
            .update({ verified_via_api: true, ringcentral_call_id: realCall.id })
            .eq('id', attempt.id);
        } else {
          // El asesor dijo que contactó pero no hay registro real -> discrepancia
          await supabase
            .from('missed_calls')
            .update({ status: 'Discrepancia' })
            .eq('id', c.id);
          updates.push({ id: c.id, new_status: 'Discrepancia' });
          continue;
        }
      }
    }

    // 2. Resolver el status según la regla de 2 intentos mínimos
    if (attempt2) {
      const bothFailed =
        attempt1 &&
        ['buzon_voz', 'no_contesta', 'numero_invalido'].includes(attempt1.outcome) &&
        ['buzon_voz', 'no_contesta', 'numero_invalido'].includes(attempt2.outcome);

      if (bothFailed) {
        await supabase.from('missed_calls').update({ status: 'Sin_respuesta' }).eq('id', c.id);
        updates.push({ id: c.id, new_status: 'Sin_respuesta' });
      } else if (attempt2.outcome === 'contactado' || attempt1?.outcome === 'contactado') {
        const contactAttempt = attempt2.outcome === 'contactado' ? attempt2 : attempt1;
        const onTime = new Date(contactAttempt.attempted_at) <= new Date(c.deadline_at);
        const newStatus = onTime ? 'Completado_a_tiempo' : 'Completado_tarde';
        await supabase
          .from('missed_calls')
          .update({ status: newStatus, completed_at: contactAttempt.attempted_at })
          .eq('id', c.id);
        updates.push({ id: c.id, new_status: newStatus });
      } else if (attempt1?.outcome === 'cliente_reagendo' || attempt2.outcome === 'cliente_reagendo') {
        await supabase.from('missed_calls').update({ status: 'Reagendado' }).eq('id', c.id);
        updates.push({ id: c.id, new_status: 'Reagendado' });
      }
    } else if (attempt1?.outcome === 'contactado') {
      const onTime = new Date(attempt1.attempted_at) <= new Date(c.deadline_at);
      const newStatus = onTime ? 'Completado_a_tiempo' : 'Completado_tarde';
      await supabase
        .from('missed_calls')
        .update({ status: newStatus, completed_at: attempt1.attempted_at })
        .eq('id', c.id);
      updates.push({ id: c.id, new_status: newStatus });
    } else if (attempt1?.outcome === 'cliente_reagendo') {
      await supabase.from('missed_calls').update({ status: 'Reagendado' }).eq('id', c.id);
      updates.push({ id: c.id, new_status: 'Reagendado' });
    }
  }

  return res.status(200).json({ processed: (openCases || []).length, updates });
};
