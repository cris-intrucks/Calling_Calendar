// lib/supabase.js
// Cliente de Supabase para uso EXCLUSIVO en el backend (funciones /api).
// Usa la service_role key, que ignora RLS -- nunca exponer esta key al frontend.

const { createClient } = require('@supabase/supabase-js');

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      'Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las Environment Variables de Vercel.'
    );
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
}

module.exports = { getSupabaseAdmin };
