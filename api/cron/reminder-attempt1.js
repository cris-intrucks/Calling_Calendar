// api/cron/reminder-attempt1.js
//
// Se ejecuta cada 5 min (vía GitHub Actions). Busca casos en 'Pendiente'
// cuyos 10 minutos de margen ya pasaron (ventana total de 20 min) sin que
// exista el intento 1, y notifica al asesor.

const { getSupabaseAdmin } = require('../../lib/supabase');
const { isAuthorizedCron } = require('../../lib/cronAuth');

module.exports = async (req, res) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const supabase = getSupabaseAdmin();
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { data: pendingCases, error } = await supabase
    .from('missed_calls')
    .select('*, advisors(*)')
    .eq('status', 'Pendiente')
    .lte('received_at', tenMinAgo);

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'query_failed' });
  }

  const results = [];
  for (const missedCall of pendingCases || []) {
    const { data: attempt1 } = await supabase
      .from('call_attempts')
      .select('id')
      .eq('missed_call_id', missedCall.id)
      .eq('attempt_number', 1)
      .maybeSingle();

    if (attempt1) continue;

    console.log(`Recordatorio intento 1 pendiente para asesor ${missedCall.advisor_id}`);
    results.push(missedCall.id);
  }

  return res.status(200).json({ reminded: results.length, ids: results });
};