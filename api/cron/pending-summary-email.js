// api/cron/pending-summary-email.js
//
// Corre cada 30 min (via GitHub Actions). Agrupa por asesor los casos
// Pendiente/Reagendado cuyo deadline cae dentro de la proxima hora, y les
// manda un correo con el resumen -- para que no dependan de revisar el
// dashboard por su cuenta.

const { getSupabaseAdmin } = require('../../lib/supabase');
const { sendEmail } = require('../../lib/email');
const { isAuthorizedCron } = require('../../lib/cronAuth');

module.exports = async (req, res) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const supabase = getSupabaseAdmin();
  const now = new Date();
  const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);

  const { data: pendingCases, error } = await supabase
    .from('missed_calls')
    .select('*, advisors(*)')
    .in('status', ['Pendiente', 'Reagendado'])
    .lte('deadline_at', inOneHour.toISOString());

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'query_failed' });
  }

  const byAdvisor = {};
  for (const c of pendingCases || []) {
    if (!c.advisors || !c.advisors.email) continue;
    const key = c.advisors.id;
    if (!byAdvisor[key]) byAdvisor[key] = { advisor: c.advisors, cases: [] };
    byAdvisor[key].cases.push(c);
  }

  const sent = [];
  for (const { advisor, cases } of Object.values(byAdvisor)) {
    const rows = cases
      .map(
        (c) =>
          `<tr><td>${c.client_phone}</td><td>${new Date(c.deadline_at).toLocaleTimeString('es-CO', {
            hour: '2-digit',
            minute: '2-digit',
          })}</td><td>${c.status}</td></tr>`
      )
      .join('');

    const html = `
      <p>Hola ${advisor.name},</p>
      <p>Tienes ${cases.length} llamada(s) pendiente(s) de gestionar en la próxima hora:</p>
      <table border="1" cellpadding="6" cellspacing="0">
        <tr><th>Cliente</th><th>Deadline</th><th>Estado</th></tr>
        ${rows}
      </table>
      <p>Revisa el dashboard para registrar el resultado de cada intento.</p>
    `;

    try {
      await sendEmail({
        to: advisor.email,
        subject: `Tienes ${cases.length} llamada(s) pendiente(s) - Protocolo de Callback`,
        html,
      });
      sent.push(advisor.email);
    } catch (err) {
      console.error(`Error enviando resumen a ${advisor.email}:`, err.message);
    }
  }

  return res.status(200).json({ sent });
};