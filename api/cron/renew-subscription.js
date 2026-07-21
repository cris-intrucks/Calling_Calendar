// api/cron/renew-subscription.js
//
// Las suscripciones de webhook de RingCentral expiran y pueden quedar
// "blacklisted" si el endpoint falla. Esta función revisa la salud
// registrada en subscription_health y renueva antes de que venza.
// NOTA: la lógica de renovación real vía API (PUT /subscription/{id})
// se completa una vez tengamos el subscriptionId real -- por ahora
// deja el chequeo y la alerta listos.

const { getSupabaseAdmin } = require('../../lib/supabase');
const { getAccessToken, RC_SERVER } = require('../../lib/ringcentral');
const { isAuthorizedCron } = require('../../lib/cronAuth');

module.exports = async (req, res) => {
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const supabase = getSupabaseAdmin();
  const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // próxima hora

  const { data: subs, error } = await supabase
    .from('subscription_health')
    .select('*')
    .lte('expires_at', soon)
    .neq('status', 'blacklisted');

  if (error) {
    console.error(error);
    return res.status(500).json({ error: 'query_failed' });
  }

  const renewed = [];
  for (const sub of subs || []) {
    try {
      const token = await getAccessToken();
      const putRes = await fetch(`${RC_SERVER}/restapi/v1.0/subscription/${sub.subscription_id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!putRes.ok) {
        await supabase
          .from('subscription_health')
          .update({ status: 'blacklisted', updated_at: new Date().toISOString() })
          .eq('id', sub.id);
        continue;
      }

      const data = await putRes.json();
      await supabase
        .from('subscription_health')
        .update({
          expires_at: data.expirationTime,
          last_renewed_at: new Date().toISOString(),
          status: 'activa',
          updated_at: new Date().toISOString(),
        })
        .eq('id', sub.id);

      renewed.push(sub.subscription_id);
    } catch (err) {
      console.error('Error renovando suscripción', sub.subscription_id, err);
    }
  }

  return res.status(200).json({ renewed });
};
