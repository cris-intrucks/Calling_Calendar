// scripts/reverify-case.js
//
// Re-verifica manualmente uno o mas casos ya cerrados como Completado,
// para confirmar si la llamada real existe en RingCentral o si en
// realidad es una discrepancia que el bug anterior dejo pasar.
// NO cambia casos que ya estan bien -- solo corrige si encuentra
// una discrepancia real.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   RC_CLIENT_ID=... RC_CLIENT_SECRET=... RC_JWT=... \
//   node scripts/reverify-case.js <missed_call_id_1> <missed_call_id_2> ...

const { createClient } = require('@supabase/supabase-js');

async function getAccessToken() {
  const { RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT } = process.env;
  const basicAuth = Buffer.from(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://platform.ringcentral.com/restapi/oauth/token', {
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
  if (!res.ok) throw new Error(`Auth fallo: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function getOutboundCallLog(token, { extensionId, phoneNumber, dateFrom }) {
  const params = new URLSearchParams({ direction: 'Outbound', dateFrom, view: 'Detailed' });
  const res = await fetch(
    `https://platform.ringcentral.com/restapi/v1.0/account/~/extension/${extensionId}/call-log?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`call-log fallo: ${await res.text()}`);
  const data = await res.json();
  return (data.records || []).find(
    (r) =>
      r.to?.phoneNumber?.replace(/\D/g, '').endsWith(phoneNumber.replace(/\D/g, '').slice(-9)) &&
      (r.duration || 0) > 0
  );
}

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error('Uso: node scripts/reverify-case.js <id1> <id2> ...');
    process.exit(1);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const token = await getAccessToken();

  for (const id of ids) {
    const { data: c } = await supabase
      .from('missed_calls')
      .select('*, advisors(*)')
      .eq('id', id)
      .single();

    if (!c) {
      console.log(`${id}: no encontrado`);
      continue;
    }

    const realCall = await getOutboundCallLog(token, {
      extensionId: c.advisors.ringcentral_extension_id,
      phoneNumber: c.client_phone,
      dateFrom: c.received_at,
    });

    if (realCall) {
      console.log(`${id} (${c.client_phone}): OK -- llamada real confirmada, se deja como ${c.status}`);
    } else {
      await supabase.from('missed_calls').update({ status: 'Discrepancia' }).eq('id', id);
      console.log(`${id} (${c.client_phone}): DISCREPANCIA -- no se encontro llamada real, actualizado a Discrepancia`);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});