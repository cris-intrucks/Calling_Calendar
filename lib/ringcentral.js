// lib/ringcentral.js
// Autenticación por JWT flow y helpers de llamadas a la API de RingCentral.

const RC_SERVER = 'https://platform.ringcentral.com';

// Cache del token en memoria -- se reutiliza mientras siga vigente, para no
// pedir un token nuevo en CADA llamada (eso agota el limite de RingCentral
// para el endpoint de autenticacion: error 429 "Request rate exceeded" en
// ejecuciones con varios casos, como verify-calls procesando varios asesores).
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  // Si el token en cache todavia es valido (con 60s de margen), reutilizarlo.
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60000) {
    return cachedToken;
  }

  const clientId = process.env.RC_CLIENT_ID;
  const clientSecret = process.env.RC_CLIENT_SECRET;
  const jwt = process.env.RC_JWT;

  if (!clientId || !clientSecret || !jwt) {
    throw new Error(
      'Faltan RC_CLIENT_ID, RC_CLIENT_SECRET o RC_JWT en las Environment Variables de Vercel.'
    );
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fallo autenticando con RingCentral (${res.status}): ${body}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

// Envía un SMS desde la línea del asesor (todas las líneas tienen SMS ilimitado).
async function sendSms({ fromExtensionId, fromNumber, toNumber, text }) {
  const token = await getAccessToken();

  const res = await fetch(
    `${RC_SERVER}/restapi/v1.0/account/~/extension/${fromExtensionId}/sms`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        from: { phoneNumber: fromNumber },
        to: [{ phoneNumber: toNumber }],
        text,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fallo enviando SMS (${res.status}): ${body}`);
  }

  return res.json();
}

// Consulta el log de llamadas de una extensión para verificar si hubo
// una llamada saliente real hacia el cliente (usado por verify-calls).
async function getOutboundCallLog({ extensionId, phoneNumber, dateFrom }) {
  const token = await getAccessToken();

  const params = new URLSearchParams({
    direction: 'Outbound',
    dateFrom,
    view: 'Detailed',
  });

  const res = await fetch(
    `${RC_SERVER}/restapi/v1.0/account/~/extension/${extensionId}/call-log?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fallo consultando call-log (${res.status}): ${body}`);
  }

  const data = await res.json();
  const records = data.records || [];

  // Filtra por número de destino y que la llamada haya conectado (duration > 0)
  return records.find(
    (r) =>
      r.to &&
      r.to.phoneNumber &&
      r.to.phoneNumber.replace(/\D/g, '').endsWith(phoneNumber.replace(/\D/g, '').slice(-9)) &&
      (r.duration || 0) > 0
  );
}

module.exports = { getAccessToken, sendSms, getOutboundCallLog, RC_SERVER };