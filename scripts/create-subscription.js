// scripts/create-subscription.js
//
// Script de UNA SOLA VEZ para registrar la suscripcion de webhook en
// RingCentral, a nivel de CUENTA (no por extension individual -- RC no
// permite suscribirse a llamadas perdidas de extensiones ajenas a la
// que autentica). Se ejecuta localmente con Node, usando las mismas
// credenciales que ya estan en Vercel.
//
// Uso:
//   RC_CLIENT_ID=... RC_CLIENT_SECRET=... RC_JWT=... \
//   WEBHOOK_URL=https://calling-calendar.vercel.app/api/webhook/ringcentral \
//   node scripts/create-subscription.js

const RC_SERVER = 'https://platform.ringcentral.com';

async function getAccessToken() {
  const { RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT } = process.env;
  if (!RC_CLIENT_ID || !RC_CLIENT_SECRET || !RC_JWT) {
    throw new Error('Faltan RC_CLIENT_ID, RC_CLIENT_SECRET o RC_JWT como variables de entorno.');
  }

  const basicAuth = Buffer.from(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: RC_JWT,
    }),
  });

  if (!res.ok) throw new Error(`Auth fallo (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

async function main() {
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) throw new Error('Falta WEBHOOK_URL como variable de entorno.');

  const token = await getAccessToken();

  const res = await fetch(`${RC_SERVER}/restapi/v1.0/subscription`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
    eventFilters: ['/restapi/v1.0/account/~/telephony/sessions?missedCall=true'],      deliveryMode: {
        transportType: 'WebHook',
        address: webhookUrl,
      },
      expiresIn: 604800, // 7 dias -- el maximo tipico para webhooks; renew-subscription.js la renueva antes
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('Error creando la suscripcion:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log('Suscripcion creada con exito:');
  console.log(JSON.stringify(data, null, 2));
  console.log('\n--- Guarda estos dos valores, los necesitas para el siguiente paso ---');
  console.log('subscription_id:', data.id);
  console.log('expires_at:', data.expirationTime);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});