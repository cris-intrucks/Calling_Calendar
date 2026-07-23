// lib/graphMail.js
// Autenticación client-credentials contra Microsoft Graph y envío de correos.

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getGraphToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60000) {
    return cachedToken;
  }

  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Faltan AZURE_TENANT_ID, AZURE_CLIENT_ID o AZURE_CLIENT_SECRET.');
  }

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fallo autenticando con Microsoft Graph (${res.status}): ${body}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

async function sendMail({ to, subject, html }) {
  const token = await getGraphToken();
  const fromMailbox = process.env.GRAPH_FROM_MAILBOX;

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${fromMailbox}/sendMail`,
    {
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
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fallo enviando correo a ${to} (${res.status}): ${body}`);
  }
}

module.exports = { getGraphToken, sendMail };