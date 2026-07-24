// api/cron/verify-calls.js
//
// El corazón de la validación: cruza lo que el asesor reportó (o la falta
// de reporte) contra el log real de llamadas de RingCentral, y resuelve
// el status final de cada caso. Esto es lo que hace el indicador confiable
// en vez de depender de autorreporte. Ademas, detecta proactivamente si el
// asesor ya llamo sin haberlo marcado en el dashboard.
//
// PRIORIDAD DE PROCESAMIENTO (importante): primero se procesan los casos
// que YA tienen un intento marcado "contactado" esperando verificacion --
// esos son baratos y urgentes de cerrar. Solo se usa el cupo restante del
// lote para la deteccion proactiva de casos sin ningun intento registrado.
// Esto evita que casos viejos que fallan repetidamente (ej. por rate limit)
// tapen la fila e impidan que casos nuevos ya marcados se cierren.

const { getSupabaseAdmin } = require('../../lib/supabase');
const { getOutboundCallLog } = require('../../lib/ringcentral');
const { isAuthorizedCron } = require('../../lib/cronAuth');

const BATCH_SIZE = 3;

module.exports = async (req, res) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const supabase = getSupabaseAdmin();

  // 1. Prioridad: casos con un intento "contactado" sin verificar todavia.
  const { data: unverifiedAttempts, error: attemptsError } = await supabase
    .from('call_attempts')
    .select('missed_call_id')
    .eq('outcome', 'contactado')
    .eq('verified_via_api', false);

  if (attemptsError) {
    console.error(attemptsError);
    return res.status(500).json({ error: 'query_failed' });
  }

  const priorityIds = [...new Set((unverifiedAttempts || []).map((a) => a.missed_call_id))].slice(
    0,
    BATCH_SIZE
  );

  let openCases = [];
  if (priorityIds.length > 0) {
    const { data: priorityCases, error: priorityError } = await supabase
      .from('missed_calls')
      .select('*, advisors(*), call_attempts(*)')
      .in('id', priorityIds);

    if (priorityError) {
      console.error(priorityError);
      return res.status(500).json({ error: 'query_failed' });
    }
    openCases = priorityCases || [];
  }

  // 2. Llenar el cupo restante con deteccion proactiva (casos sin intentos).
  const remainingSlots = BATCH_SIZE - openCases.length;
  if (remainingSlots > 0) {
    const priorityIdSet = new Set(openCases.map((c) => c.id));
    const { data: candidates, error: candidatesError } = await supabase
      .from('missed_calls')
      .select('*, advisors(*), call_attempts(*)')
      .in('status', ['Pendiente', 'Reagendado'])
      .order('received_at', { ascending: true })
      .limit(remainingSlots + priorityIdSet.size);

    if (candidatesError) {
      console.error(candidatesError);
      return res.status(500).json({ error: 'query_failed' });
    }

    const filtered = (candidates || []).filter((c) => !priorityIdSet.has(c.id)).slice(0, remainingSlots);
    openCases = openCases.concat(filtered);
  }

  const updates = [];
  const errors = [];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const c of openCases) {
    try {
      await sleep(800);

      let attempts = c.call_attempts || [];
      let attempt1 = attempts.find((a) => a.attempt_number === 1);
      let attempt2 = attempts.find((a) => a.attempt_number === 2);

      if (!attempt1) {
        const realCall = await getOutboundCallLog({
          extensionId: c.advisors.ringcentral_extension_id,
          phoneNumber: c.client_phone,
          dateFrom: c.received_at,
        });

        if (realCall) {
          const { data: inserted } = await supabase
            .from('call_attempts')
            .insert({
              missed_call_id: c.id,
              attempt_number: 1,
              attempted_at: realCall.startTime || new Date().toISOString(),
              outcome: 'contactado',
              verified_via_api: true,
              ringcentral_call_id: realCall.id,
              notes: 'Detectado automaticamente contra el log de RingCentral (asesor no lo habia registrado)',
            })
            .select()
            .single();

          if (inserted) {
            attempt1 = inserted;
            attempts = [inserted];
          }
        }
      }

      let discrepancyFound = false;
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
            attempt.verified_via_api = true;
          } else {
            await supabase
              .from('missed_calls')
              .update({ status: 'Discrepancia' })
              .eq('id', c.id);
            updates.push({ id: c.id, new_status: 'Discrepancia' });
            discrepancyFound = true;
            break;
          }
        }
      }

      if (discrepancyFound) continue;

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
    } catch (caseErr) {
      console.error(`Error procesando caso ${c.id}:`, caseErr.message);
      errors.push({ id: c.id, error: caseErr.message });
    }
  }

  return res.status(200).json({ processed: openCases.length, updates, errors });
};