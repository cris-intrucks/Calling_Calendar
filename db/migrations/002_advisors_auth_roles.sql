-- 002: agrega email y rol a advisors, para login y control de visibilidad

alter table advisors add column email text unique;
alter table advisors add column role text not null default 'agente' check (role in ('agente','admin'));

-- Reemplaza las políticas de solo-lectura genéricas por políticas basadas
-- en el correo autenticado (auth.jwt() ->> 'email') y el rol del asesor.

drop policy if exists "internal_read_advisors" on advisors;
drop policy if exists "internal_read_missed_calls" on missed_calls;
drop policy if exists "internal_read_call_attempts" on call_attempts;
drop policy if exists "internal_read_subscription_health" on subscription_health;

-- advisors: cualquier usuario autenticado puede ver la lista de asesores
-- (nombres, equipos) -- no es informacion sensible por si sola.
create policy "read_advisors" on advisors
  for select using (auth.role() = 'authenticated');

-- missed_calls: un agente solo ve sus propios casos; un admin ve todos.
create policy "read_missed_calls" on missed_calls
  for select using (
    exists (
      select 1 from advisors a
      where a.email = auth.jwt() ->> 'email'
        and (a.role = 'admin' or a.id = missed_calls.advisor_id)
    )
  );

-- call_attempts: mismo criterio, a traves del caso al que pertenece.
create policy "read_call_attempts" on call_attempts
  for select using (
    exists (
      select 1 from missed_calls mc
      join advisors a on a.email = auth.jwt() ->> 'email'
      where mc.id = call_attempts.missed_call_id
        and (a.role = 'admin' or a.id = mc.advisor_id)
    )
  );

-- Un agente tambien necesita poder INSERTAR su propio intento (registrar
-- el resultado de la llamada) -- solo sobre sus propios casos.
create policy "insert_own_call_attempts" on call_attempts
  for insert with check (
    exists (
      select 1 from missed_calls mc
      join advisors a on a.email = auth.jwt() ->> 'email'
      where mc.id = call_attempts.missed_call_id
        and (a.role = 'admin' or a.id = mc.advisor_id)
    )
  );

-- subscription_health: solo admins la necesitan ver (info tecnica interna).
create policy "read_subscription_health_admin" on subscription_health
  for select using (
    exists (
      select 1 from advisors a
      where a.email = auth.jwt() ->> 'email' and a.role = 'admin'
    )
  );