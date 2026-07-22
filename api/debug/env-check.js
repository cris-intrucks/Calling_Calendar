// api/debug/env-check.js
//
// ENDPOINT TEMPORAL DE DIAGNÓSTICO -- eliminar una vez resuelto el problema
// de autenticación de los crons. No expone ningún valor real, solo si la
// variable existe y cuántos caracteres tiene, para comparar contra lo
// que sabemos que debería ser.

module.exports = async (req, res) => {
  const check = (name) => {
    const val = process.env[name];
    return {
      presente: val !== undefined && val !== '',
      longitud: val ? val.length : 0,
      muestra: val ? `${val.slice(0, 3)}...${val.slice(-3)}` : null,
    };
  };

  return res.status(200).json({
    CRON_SECRET: check('CRON_SECRET'),
    SUPABASE_URL: check('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: check('SUPABASE_SERVICE_ROLE_KEY'),
    RC_CLIENT_ID: check('RC_CLIENT_ID'),
    RC_CLIENT_SECRET: check('RC_CLIENT_SECRET'),
    RC_JWT: check('RC_JWT'),
  });
};