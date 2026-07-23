// lib/email.js
//
// Envio de correo transaccional via Microsoft Graph API (reemplaza a Resend,
// reutilizando la misma app de Azure ya aprobada para Loss Runs). El buzon
// remitente esta restringido por una ApplicationAccessPolicy en Exchange --
// solo puede enviar desde el buzon incluido en ese scope.

const GRAPH_TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
const GRAPH_API = 'https://graph.microsoft.com/v1.0';

async function getGraphToken() {
  const { AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET } = process.env;
  if (!AZURE_TENANT_ID || !AZURE_CLIENT_ID || !AZURE_CLIENT_SECRET) {
    throw new Error('Faltan AZURE_TENANT_ID, AZURE_CLIENT_ID o AZURE_CLIENT_SECRET.');
  }

  const res = await fetch(GRAPH_TOKEN_URL(AZURE_TENANT_ID), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: AZURE_CLIENT_ID,
      client_secret: AZURE_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fallo autenticando con Graph (${res.status}): ${body}`);
  }

  return (await res.json()).access_token;
}

async function sendEmail({ to, subject, html }) {
  const { GRAPH_FROM_MAILBOX } = process.env;
  if (!GRAPH_FROM_MAILBOX) {
    throw new Error('Falta GRAPH_FROM_MAILBOX (el buzon remitente autorizado, ej. lossruns@intruckscorp.com).');
  }

  const token = await getGraphToken();

  const res = await fetch(`${GRAPH_API}/users/${GRAPH_FROM_MAILBOX}/sendMail`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fallo enviando correo via Graph (${res.status}): ${body}`);
  }

  return { ok: true };
}

module.exports = { sendEmail };