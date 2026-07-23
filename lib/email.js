// lib/email.js
//
// Envio de correo transaccional via Resend (para el resumen de pendientes,
// no para el login -- eso sigue usando el motor de Supabase Auth).

async function sendEmail({ to, subject, html }) {
  const { RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!RESEND_API_KEY || !RESEND_FROM) {
    throw new Error('Faltan RESEND_API_KEY o RESEND_FROM en las Environment Variables.');
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fallo enviando correo (${res.status}): ${body}`);
  }

  return res.json();
}

module.exports = { sendEmail };