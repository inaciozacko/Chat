-- =====================================================================
--  App Android nativo + modo emergência
--  Rode este arquivo no SQL Editor do Supabase (pode rodar mais de uma vez).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 1) Aparelhos do app nativo (notificações pelo Firebase + resposta pela notificação)
--    O app gera um segredo aleatório; aqui fica só o hash dele. A função da Vercel
--    /api/reply usa esse segredo para saber de quem é a resposta escrita na notificação.
-- ---------------------------------------------------------------------
create table if not exists public.native_devices (
  fcm_token    text primary key,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  secret_hash  text not null unique,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists native_devices_user_idx on public.native_devices(user_id);
alter table public.native_devices enable row level security;
drop policy if exists "native own read" on public.native_devices;
create policy "native own read" on public.native_devices for select to authenticated using (user_id = auth.uid());

create or replace function public.save_native_device(p_token text, p_secret text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if length(p_secret) < 32 then raise exception 'weak secret'; end if;
  delete from public.native_devices
   where secret_hash = encode(digest(p_secret, 'sha256'), 'hex') and fcm_token <> p_token;
  insert into public.native_devices (fcm_token, user_id, secret_hash, updated_at)
  values (p_token, auth.uid(), encode(digest(p_secret, 'sha256'), 'hex'), now())
  on conflict (fcm_token) do update
    set user_id = excluded.user_id, secret_hash = excluded.secret_hash, updated_at = now();
end $$;

create or replace function public.delete_native_device(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from public.native_devices where fcm_token = p_token and user_id = auth.uid();
$$;

revoke all on function public.save_native_device(text, text) from public, anon;
revoke all on function public.delete_native_device(text) from public, anon;
grant execute on function public.save_native_device(text, text) to authenticated;
grant execute on function public.delete_native_device(text) to authenticated;

-- ---------------------------------------------------------------------
-- 2) Chaves públicas do modo emergência (uma por aparelho)
--    Mensagens sem internet viajam de celular em celular CRIPTOGRAFADAS:
--    só os aparelhos do destinatário conseguem ler; a assinatura prova quem enviou.
-- ---------------------------------------------------------------------
create table if not exists public.mesh_keys (
  device_id   text primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  enc_key     jsonb not null,     -- ECDH P-256 (JWK público)
  sign_key    jsonb not null,     -- ECDSA P-256 (JWK público)
  created_at  timestamptz not null default now()
);
create index if not exists mesh_keys_user_idx on public.mesh_keys(user_id);
alter table public.mesh_keys enable row level security;
drop policy if exists "mesh keys read" on public.mesh_keys;
drop policy if exists "mesh keys own write" on public.mesh_keys;
drop policy if exists "mesh keys own delete" on public.mesh_keys;
-- chave pública não é segredo: qualquer usuário logado pode ler
create policy "mesh keys read" on public.mesh_keys for select to authenticated using (true);
create policy "mesh keys own write" on public.mesh_keys for insert to authenticated with check (user_id = auth.uid());
create policy "mesh keys own delete" on public.mesh_keys for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 3) Caixa postal das mensagens de emergência
--    Quando um celular que carrega mensagens alheias encontra internet, ele as deposita aqui
--    (continuam criptografadas). O destinatário as recebe assim que tiver internet.
-- ---------------------------------------------------------------------
create table if not exists public.mesh_envelopes (
  id          text primary key,
  to_user     uuid not null references public.profiles(id) on delete cascade,
  from_user   uuid references public.profiles(id) on delete set null,
  kind        text not null default 'm' check (kind in ('m', 'a')),
  body        text not null check (length(body) < 20000),
  created_at  timestamptz not null default now()
);
create index if not exists mesh_envelopes_to_idx on public.mesh_envelopes(to_user, created_at desc);
alter table public.mesh_envelopes enable row level security;
drop policy if exists "mesh env deposit" on public.mesh_envelopes;
drop policy if exists "mesh env read own" on public.mesh_envelopes;
drop policy if exists "mesh env delete own" on public.mesh_envelopes;
create policy "mesh env deposit" on public.mesh_envelopes for insert to authenticated with check (true);
create policy "mesh env read own" on public.mesh_envelopes for select to authenticated using (to_user = auth.uid());
create policy "mesh env delete own" on public.mesh_envelopes for delete to authenticated using (to_user = auth.uid());
