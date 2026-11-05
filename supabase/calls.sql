-- =====================================================================
--  Histórico de ligações ("quem te ligou")
--  Rode este arquivo no SQL Editor do Supabase (pode rodar mais de uma vez).
-- =====================================================================

create table if not exists public.calls (
  id               uuid primary key,                -- mesmo id da chamada WebRTC
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  caller_id        uuid not null references public.profiles(id) on delete cascade,
  callee_id        uuid not null references public.profiles(id) on delete cascade,
  video            boolean not null default false,
  status           text not null default 'ringing'
                   check (status in ('ringing','answered','missed','rejected','busy','failed')),
  started_at       timestamptz not null default now(),
  answered_at      timestamptz,
  ended_at         timestamptz
);
create index if not exists calls_caller_idx on public.calls(caller_id, started_at desc);
create index if not exists calls_callee_idx on public.calls(callee_id, started_at desc);

-- "Limpar registro de ligações" é por usuário (o outro lado continua vendo o dele)
create table if not exists public.call_hidden (
  call_id  uuid not null references public.calls(id) on delete cascade,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  primary key (call_id, user_id)
);

alter table public.calls       enable row level security;
alter table public.call_hidden enable row level security;

drop policy if exists "calls read"   on public.calls;
drop policy if exists "calls insert" on public.calls;
drop policy if exists "calls update" on public.calls;
create policy "calls read" on public.calls for select to authenticated
  using (caller_id = auth.uid() or callee_id = auth.uid());
create policy "calls insert" on public.calls for insert to authenticated
  with check (caller_id = auth.uid() and public.is_member(conversation_id));
create policy "calls update" on public.calls for update to authenticated
  using (caller_id = auth.uid() or callee_id = auth.uid())
  with check (caller_id = auth.uid() or callee_id = auth.uid());

drop policy if exists "call hidden own" on public.call_hidden;
create policy "call hidden own" on public.call_hidden for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'calls'
  ) then
    alter publication supabase_realtime add table public.calls;
  end if;
end $$;
