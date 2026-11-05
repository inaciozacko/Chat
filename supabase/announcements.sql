-- =====================================================================
--  Anúncios (pop-ups para todos os usuários)
--  Rode este arquivo no SQL Editor do Supabase (pode rodar mais de uma vez).
--  Só a conta com o e-mail abaixo pode criar/editar/apagar anúncios.
-- =====================================================================

-- Verifica no servidor (pela conta real em auth.users, não pelo que o navegador diz)
create or replace function public.is_app_admin()
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from auth.users u
    where u.id = auth.uid()
      and lower(u.email) in ('inacio.vitkoski@gmail.com')
  );
$$;

create table if not exists public.announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null default '',
  image_url   text,
  link_url    text,
  link_label  text,
  active      boolean not null default true,
  created_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz
);
create index if not exists announcements_created_idx on public.announcements(created_at desc);

create table if not exists public.announcement_reads (
  announcement_id  uuid not null references public.announcements(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  seen_at          timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

-- Só existe 1 anúncio ativo: ao publicar (ou reativar) um, os outros são desativados automaticamente
create or replace function public.keep_single_announcement()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.active then
    update public.announcements set active = false where id <> new.id and active;
  end if;
  return new;
end;
$$;

drop trigger if exists on_announcement_active on public.announcements;
create trigger on_announcement_active
  after insert or update of active on public.announcements
  for each row when (new.active) execute function public.keep_single_announcement();

alter table public.announcements      enable row level security;
alter table public.announcement_reads enable row level security;

-- todos veem anúncios ativos e dentro do prazo; o admin vê todos
drop policy if exists "announcements read"   on public.announcements;
drop policy if exists "announcements insert" on public.announcements;
drop policy if exists "announcements update" on public.announcements;
drop policy if exists "announcements delete" on public.announcements;
create policy "announcements read" on public.announcements for select to authenticated
  using (public.is_app_admin() or (active and (expires_at is null or expires_at > now())));
create policy "announcements insert" on public.announcements for insert to authenticated
  with check (public.is_app_admin());
create policy "announcements update" on public.announcements for update to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());
create policy "announcements delete" on public.announcements for delete to authenticated
  using (public.is_app_admin());

-- cada usuário marca o que já viu; o admin consegue contar as visualizações
drop policy if exists "announcement reads insert" on public.announcement_reads;
drop policy if exists "announcement reads select" on public.announcement_reads;
create policy "announcement reads insert" on public.announcement_reads for insert to authenticated
  with check (user_id = auth.uid());
create policy "announcement reads select" on public.announcement_reads for select to authenticated
  using (user_id = auth.uid() or public.is_app_admin());

-- tempo real: anúncio novo aparece na hora para quem está online
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'announcements'
  ) then
    alter publication supabase_realtime add table public.announcements;
  end if;
end $$;
