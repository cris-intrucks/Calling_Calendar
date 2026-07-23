// api/cron/notify-advisors.js
//
// Corre cada hora. Por cada asesor con casos relevantes, envía UN correo
// resumen con dos secciones: los clientes que ya recibieron su llamada
// devuelta en la ultima hora, y los que siguen pendientes (sin importar
// cuanto tiempo llevan esperando).
//
// Solo envia en horario laboral: lunes a viernes, 8am-5pm hora Colombia.

const { getSupabaseAdmin } = require('../../lib/supabase');
const { sendMail } = require('../../lib/graphMail');
const { isAuthorizedCron } = require('../../lib/cronAuth');

function formatPhone(p) {
  return p || 'N/A';
}

function formatDateTime(iso) {
  if (!iso) return 'N/A';
  return new Date(iso).toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

function isWithinBusinessHours(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);

  const weekday = parts.find((p) => p.type === 'weekday').value;
  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);

  const isWeekday = !['Sat', 'Sun'].includes(weekday);
  const isWorkHour = hour >= 8 && hour < 17;

  return isWeekday && isWorkHour;
}

function buildEmailHtml({ advisorName, completedRecent, stillPending }) {
  const completedRows = completedRecent.length
    ? completedRecent
        .map(
          (c) => `
        <tr>
          <td style="padding:6px 10px;border:1px solid #ddd;">${formatPhone(c.client_phone)}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;">${formatDateTime(c.completed_at)}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;">${c.status === 'Completado_a_tiempo' ? 'A tiempo' : 'Tarde'}</td>
        </tr>`
        )
        .join('')
    : `<tr><td colspan="3" style="padding:6px 10px;border:1px solid #ddd;color:#888;">Sin llamadas completadas en la última hora</td></tr>`;

  const pendingRows = stillPending.length
    ? stillPending
        .map(
          (c) => `
        <tr>
          <td style="padding:6px 10px;border:1px solid #ddd;">${formatPhone(c.client_phone)}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;">${formatDateTime(c.received_at)}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;">${formatDateTime(c.deadline_at)}</td>
        </tr>`
        )
        .join('')
    : `<tr><td colspan="3" style="padding:6px 10px;border:1px solid #ddd;color:#888;">No hay clientes pendientes 🎉</td></tr>`;

  return `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;">
      <p>Hola ${advisorName},</p>
      <p>Este es tu resumen de llamadas perdidas actualizado.</p>

      <h3 style="margin-bottom:6px;">✅ Llamadas devueltas en la última hora</h3>
      <table style="border-collapse:collapse;width:100%;margin-bottom:20px;">
        <thead>
          <tr style="background:#f0f0f0;">
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Cliente</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Completado</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Resultado</th>
          </tr>
        </thead>
        <tbody>${completedRows}</tbody>
      </table>

      <h3 style="margin-bottom:6px;">⏳ Clientes pendientes por llamar</h3>
      <table style="border-collapse:collapse;width:100%;">
        <thead>
          <tr style="background:#f0f0f0;">
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Cliente</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Recibida</th>
            <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Límite</th>
          </tr>
        </thead>
        <tbody>${pendingRows}</tbody>
      </table>

      <p style="color:#888;font-size:12px;margin-top:20px;">Notificación automática — no responder a este correo.</p>
    </div>
  `;
}

module.exports = async (req, res) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const now = new Date();
  if (!isWithinBusinessHours(now)) {
    return res.status(200).json({ skipped: 'fuera_de_horario_laboral' });
  }

  const supabase = getSupabaseAdmin();

  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  const { data: cases, error } = await supabase
    .from('missed_calls')
    .select('*, advisors(*)')
    .or(
      `and(status.in.(Completado_a_tiempo,Completado_tarde),completed_at.gte.${oneHourAgo}),status.in.(Pendiente,Reagendado)`
    );

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'query_failed' });
  }

  const byAdvisor = new Map();
  for (const c of cases || []) {
    if (!c.advisors || !c.advisors.email) continue;
    const key = c.advisors.id;
    if (!byAdvisor.has(key)) {
      byAdvisor.set(key, { advisor: c.advisors, completedRecent: [], stillPending: [] });
    }
    const bucket = byAdvisor.get(key);
    if (c.status === 'Completado_a_tiempo' || c.status === 'Completado_tarde') {
      bucket.completedRecent.push(c);
    } else {
      bucket.stillPending.push(c);
    }
  }

  const sent = [];
  const errors = [];

  for (const { advisor, completedRecent, stillPending } of byAdvisor.values()) {
    if (completedRecent.length === 0 && stillPending.length === 0) continue;

    try {
      const html = buildEmailHtml({
        advisorName: advisor.name,
        completedRecent,
        stillPending,
      });

      await sendMail({
        to: advisor.email,
        subject: `Resumen de llamadas perdidas — ${advisor.name}`,
        html,
      });

      sent.push({ advisor: advisor.name, email: advisor.email });
    } catch (mailErr) {
      console.error(`Error enviando correo a ${advisor.email}:`, mailErr.message);
      errors.push({ advisor: advisor.name, error: mailErr.message });
    }
  }

  return res.status(200).json({ notified: sent.length, sent, errors });
};