// lib/cronAuth.js
// Los endpoints /api/cron/* no deben poder ser llamados por cualquiera --
// solo por GitHub Actions con el secreto correcto.
// Se valida un header: Authorization: Bearer <CRON_SECRET>

function isAuthorizedCron(req) {
  const expected = process.env.CRON_SECRET;
  const auth = req.headers['authorization'] || '';
  return Boolean(expected) && auth === `Bearer ${expected}`;
}

module.exports = { isAuthorizedCron };
