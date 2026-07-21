// api/cron/reminder-attempt2.js
//
// Busca casos donde el intento 1 falló (buzon_voz / no_contesta / numero_invalido)
// y ya pasaron 2 horas desde ese intento, sin que exista el intento 2.
// Si tampoco hay intento 2 dentro de una ventana razonable después de este
// recordatorio, verify-calls / un cierre manual lo marcará Sin_respuesta.

const { getSupabaseAdmin } = require('../../lib/supabase');
const { isAuthorizedCron } = require('../../lib/cronAuth');

const FAILED_OUTCOMES = ['buzon_voz', 'no_contesta', 'numero_invalido'];

module.exports = async (req, res) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const supabase = getSupabaseAdmin();
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const { data: failedAttempt1s, error } = await supabase
    .from('call_attempts')
    .select('*, missed_calls(*, advisors(*))')
    .eq('attempt_number', 1)
    .in('outcome', FAILED_OUTCOMES)
    .lte('attempted_at', twoHoursAgo);

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'query_failed' });
  }

  const results = [];
  for (const attempt of failedAttempt1s || []) {
    const { data: attempt2 } = await supabase
      .from('call_attempts')
      .select('id')
      .eq('missed_call_id', attempt.missed_call_id)
      .eq('attempt_number', 2)
      .maybeSingle();

    if (attempt2) continue;

    // TODO: enviar recordatorio real a Teams para el intento 2
    console.log(
      `Recordatorio intento 2 pendiente para asesor ${attempt.missed_calls.advisor_id}, caso ${attempt.missed_call_id}`
    );
    results.push(attempt.missed_call_id);
  }

  return res.status(200).json({ reminded: results.length, ids: results });
};
