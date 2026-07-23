// scripts/provision-advisor-users.js
//
// Crea (o confirma) el usuario de Supabase Auth para cada asesor que ya
// tenga un email cargado en la tabla advisors. Usa la service_role key
// (permisos de administrador), nunca la anon key.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/provision-advisor-users.js

const { createClient } = require('@supabase/supabase-js');

const ALLOWED_DOMAIN = '@intruckscorp.com';

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY como variables de entorno.');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: advisors, error } = await supabase
    .from('advisors')
    .select('id, name, email, role')
    .not('email', 'is', null);

  if (error) throw error;

  for (const advisor of advisors) {
    if (!advisor.email.toLowerCase().endsWith(ALLOWED_DOMAIN)) {
      console.log(`SALTADO (dominio no permitido): ${advisor.email}`);
      continue;
    }

    const { data, error: createError } = await supabase.auth.admin.createUser({
      email: advisor.email,
      email_confirm: true, // no requiere que confirme por link, ya queda activo
    });

    if (createError) {
      if (createError.message && createError.message.includes('already been registered')) {
        console.log(`Ya existia: ${advisor.email}`);
      } else {
        console.error(`Error creando ${advisor.email}:`, createError.message);
      }
      continue;
    }

    console.log(`Creado: ${advisor.email} (${advisor.name}, role=${advisor.role})`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});