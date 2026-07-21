// api/cron/reminder-attempt1.js
//
// Se ejecuta cada 5 min (vía GitHub Actions). Busca casos en 'Pendiente'
// cuyos 15 minutos de margen ya pasaron sin que exista el intento 1,
// y notifica al asesor. NOTA: el envío del recordatorio interno (Teams)
// se deja marcado como TODO -- falta confirmar si se usa Microsoft Graph
// API o un webhook de canal de Teams; ver README.

const { getSupabaseAdmin } = require('../../lib/supabase');
const { isAuthorizedCron } = require('../../lib/cronAuth');

module.exports = async (req, res) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const supabase = getSupabaseAdmin();
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const { data: pendingCases, error } = await supabase
    .from('missed_calls')
    .select('*, advisors(*)')
    .eq('status', 'Pendiente')
    .lte('received_at', fifteenMinAgo);

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'query_failed' });
  }

  const results = [];
  for (const missedCall of pendingCases || []) {
    // Solo recordar si aún no existe el intento 1 registrado
    const { data: attempt1 } = await supabase
      .from('call_attempts')
      .select('id')
      .eq('missed_call_id', missedCall.id)
      .eq('attempt_number', 1)
      .maybeSingle();

    if (attempt1) continue;

    // TODO: enviar recordatorio real a Teams (Microsoft Graph API)
    // usando missedCall.advisors.teams_user_id
    console.log(`Recordatorio intento 1 pendiente para asesor ${missedCall.advisor_id}`);
    results.push(missedCall.id);
  }

  return res.status(200).json({ reminded: results.length, ids: results });
};
