-- Protocolo de Callback - Retención InTrucks
-- Migración inicial: esquema completo

create extension if not exists "pgcrypto";

-- Asesores
create table advisors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  ringcentral_extension_id text not null unique,
  sms_capable_number text,
  teams_user_id text,
  team text check (team in ('Red','Blue','Retention','Freelance','CRM','TP')),
  created_at timestamptz not null default now()
);

-- Estados del caso
create type missed_call_status as enum (
  'Pendiente',
  'Reagendado',
  'Completado_a_tiempo',
  'Completado_tarde',
  'Sin_respuesta',
  'Discrepancia'
);

-- Casos (llamadas perdidas)
create table missed_calls (
  id uuid primary key default gen_random_uuid(),
  ringcentral_session_id text not null unique,
  client_phone text not null,
  advisor_id uuid not null references advisors(id),
  received_at timestamptz not null,
  deadline_at timestamptz not null,          -- received_at + 30 min
  sms_sent_at timestamptz,
  status missed_call_status not null default 'Pendiente',
  completed_at timestamptz,
  verified_outbound_call_id text,
  created_at timestamptz not null default now()
);

create index idx_missed_calls_advisor on missed_calls (advisor_id);
create index idx_missed_calls_status on missed_calls (status);

-- Resultado de cada intento
create type call_attempt_outcome as enum (
  'buzon_voz',
  'no_contesta',
  'numero_invalido',
  'cliente_reagendo',
  'contactado',
  'otro'
);

-- Intentos de contacto (máximo 2 antes de Sin_respuesta)
create table call_attempts (
  id uuid primary key default gen_random_uuid(),
  missed_call_id uuid not null references missed_calls(id) on delete cascade,
  attempt_number smallint not null check (attempt_number in (1,2)),
  attempted_at timestamptz not null,
  outcome call_attempt_outcome not null,
  verified_via_api boolean not null default false,
  ringcentral_call_id text,
  notes text,
  created_at timestamptz not null default now(),
  unique (missed_call_id, attempt_number)
);

-- Salud de la suscripción del webhook de RingCentral
create table subscription_health (
  id uuid primary key default gen_random_uuid(),
  subscription_id text not null unique,
  expires_at timestamptz not null,
  last_renewed_at timestamptz,
  status text not null default 'activa' check (status in ('activa','blacklisted','expirada')),
  updated_at timestamptz not null default now()
);

-- Vista del indicador (alimenta el dashboard)
create or replace view satisfaction_indicator as
select
  a.id as advisor_id,
  a.name as advisor_name,
  a.team,
  date_trunc('week', mc.received_at) as week,
  count(*) as total_casos,
  count(*) filter (where mc.status = 'Completado_a_tiempo') as a_tiempo,
  round(100.0 * count(*) filter (where mc.status = 'Completado_a_tiempo')
        / nullif(count(*),0), 1) as pct_dentro_ventana,
  round(avg(extract(epoch from (mc.completed_at - mc.received_at)) / 60.0)
        filter (where mc.completed_at is not null), 1) as tiempo_promedio_respuesta_min,
  count(*) filter (where mc.status = 'Sin_respuesta') as sin_respuesta,
  count(*) filter (where mc.status = 'Discrepancia') as discrepancias,
  round(100.0 * count(*) filter (where mc.status = 'Discrepancia')
        / nullif(count(*),0), 1) as pct_discrepancias
from missed_calls mc
join advisors a on a.id = mc.advisor_id
group by a.id, a.name, a.team, date_trunc('week', mc.received_at);

-- Row Level Security: activar antes de conectar cualquier frontend
alter table advisors enable row level security;
alter table missed_calls enable row level security;
alter table call_attempts enable row level security;
alter table subscription_health enable row level security;

-- Política base: solo lectura para usuarios autenticados internos.
-- Ajustar el rol/condición según cómo autentiquen al equipo en el dashboard.
create policy "internal_read_advisors" on advisors
  for select using (auth.role() = 'authenticated');
create policy "internal_read_missed_calls" on missed_calls
  for select using (auth.role() = 'authenticated');
create policy "internal_read_call_attempts" on call_attempts
  for select using (auth.role() = 'authenticated');
create policy "internal_read_subscription_health" on subscription_health
  for select using (auth.role() = 'authenticated');

-- Nota: las Lambdas deben escribir usando la service_role key de Supabase
-- (que ignora RLS), nunca la anon key. La anon key solo la usa el dashboard de lectura.
