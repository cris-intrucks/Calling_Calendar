// api/config.js
//
// Expone la URL de Supabase y la anon key al frontend -- esto es seguro
// porque la anon key esta disenada para ser publica (la seguridad real
// la da RLS en la base de datos, no ocultar esta key). Nunca exponer aqui
// la service_role key.

module.exports = async (req, res) => {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'config_not_set' });
  }

  return res.status(200).json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
  });
};