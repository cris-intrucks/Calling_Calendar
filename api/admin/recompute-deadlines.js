// api/admin/recompute-deadlines.js
//
// ENDPOINT TEMPORAL DE UN SOLO USO -- recalcula deadline_at de los casos
// abiertos (Pendiente/Reagendado) usando la logica de horario laboral,
// para los que se crearon ANTES de que existiera computeBusinessDeadline.
// Seguro de correr varias veces (idempotente). Se puede borrar despues.

const { getSupabaseAdmin } = require('../../lib/supabase');
const { computeBusinessDeadline } = require('../../lib/businessHours');
const { isAuthorizedCron } = require('../../lib/cronAuth');

module.exports = async (req, res) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const supabase = getSupabaseAdmin();

  const { data: openCases, error } = await supabase
    .from('missed_calls')
    .select('id, received_at, deadline_at')
    .in('status', ['Pendiente', 'Reagendado']);

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'query_failed' });
  }

  const updated = [];
  for (const c of openCases || []) {
    const newDeadline = computeBusinessDeadline(new Date(c.received_at), 20);
    const oldDeadline = new Date(c.deadline_at);

    if (newDeadline.getTime() !== oldDeadline.getTime()) {
      await supabase
        .from('missed_calls')
        .update({ deadline_at: newDeadline.toISOString() })
        .eq('id', c.id);

      updated.push({
        id: c.id,
        old_deadline: oldDeadline.toISOString(),
        new_deadline: newDeadline.toISOString(),
      });
    }
  }

  return res.status(200).json({ checked: (openCases || []).length, updated: updated.length, details: updated });
};