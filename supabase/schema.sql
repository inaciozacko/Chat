-- =====================================================================
--  Zap Chat — schema completo para Supabase
--  Rode este arquivo inteiro no SQL Editor do seu projeto Supabase.
--  Ele é idempotente o suficiente para ser rodado de novo em caso de erro.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- TABELAS
-- ---------------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique,
  full_name   text not null default '',
  phone       text,
  about       text not null default 'Olá! Eu estou usando o Zap.',
  avatar_url  text,
  last_seen   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create table if not exists public.conversations (
  id               uuid primary key default gen_random_uuid(),
  is_group         boolean not null default false,
  name             text,
  description      text,
  avatar_url       text,
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  last_message_at  timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id    uuid not null references public.conversations(id) on delete cascade,
  user_id            uuid not null references public.profiles(id) on delete cascade,
  role               text not null default 'member' check (role in ('admin','member')),
  joined_at          timestamptz not null default now(),
  last_read_at       timestamptz not null default now(),
  last_delivered_at  timestamptz not null default now(),
  cleared_at         timestamptz not null default 'epoch',
  pinned             boolean not null default false,
  archived           boolean not null default false,
  muted              boolean not null default false,
  marked_unread      boolean not null default false,
  primary key (conversation_id, user_id)
);
create index if not exists conversation_members_user_idx on public.conversation_members(user_id);

create table if not exists public.messages (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id       uuid not null references public.conversations(id) on delete cascade,
  sender_id             uuid references public.profiles(id) on delete set null,
  type                  text not null default 'text'
                        check (type in ('text','image','video','audio','document','sticker','system')),
  content               text,
  media_url             text,
  media_name            text,
  media_size            bigint,
  media_mime            text,
  media_duration        numeric,
  reply_to              uuid references public.messages(id) on delete set null,
  forwarded             boolean not null default false,
  edited_at             timestamptz,
  deleted_for_everyone  boolean not null default false,
  created_at            timestamptz not null default now()
);
create index if not exists messages_conv_created_idx on public.messages(conversation_id, created_at desc);

create table if not exists public.message_reactions (
  message_id  uuid not null references public.messages(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  emoji       text not null,
  created_at  timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- "Apagar para mim"
create table if not exists public.message_hidden (
  message_id  uuid not null references public.messages(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  primary key (message_id, user_id)
);

create table if not exists public.starred_messages (
  message_id  uuid not null references public.messages(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- Coleção pessoal de figurinhas
create table if not exists public.stickers (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  image_url   text not null,
  storage_path text,
  emoji       text,
  favorite    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists stickers_owner_idx on public.stickers(owner_id, created_at desc);

-- Status (stories de 24h)
create table if not exists public.statuses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  type        text not null check (type in ('text','image')),
  content     text,
  media_url   text,
  bg_color    text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '24 hours'
);
create index if not exists statuses_user_idx on public.statuses(user_id, created_at desc);

create table if not exists public.status_views (
  status_id  uuid not null references public.statuses(id) on delete cascade,
  viewer_id  uuid not null references public.profiles(id) on delete cascade,
  viewed_at  timestamptz not null default now(),
  primary key (status_id, viewer_id)
);

-- ---------------------------------------------------------------------
-- FUNÇÕES AUXILIARES (security definer evita recursão de RLS)
-- ---------------------------------------------------------------------

create or replace function public.is_member(conv uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = conv and user_id = auth.uid()
  );
$$;

create or replace function public.is_admin(conv uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = conv and user_id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.shares_conversation(other uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select other = auth.uid() or exists (
    select 1
    from public.conversation_members a
    join public.conversation_members b on a.conversation_id = b.conversation_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

create or replace function public.can_see_message(msg uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.messages m
    join public.conversation_members cm on cm.conversation_id = m.conversation_id
    where m.id = msg and cm.user_id = auth.uid()
  );
$$;

-- Usada pelas policies do Realtime (canais privados "conv:<uuid>")
create or replace function public.can_access_topic(topic text)
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  if topic ~ '^conv:[0-9a-fA-F-]{36}$' then
    return public.is_member(substring(topic from 6)::uuid);
  end if;
  return false;
end;
$$;

-- ---------------------------------------------------------------------
-- TRIGGERS
-- ---------------------------------------------------------------------

-- Cria o perfil automaticamente quando alguém se cadastra
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uname text := nullif(lower(new.raw_user_meta_data->>'username'), '');
begin
  -- nome de usuário já em uso: cadastra sem ele (pode ser definido depois no perfil)
  if uname is not null and exists (select 1 from public.profiles where username = uname) then
    uname := null;
  end if;
  insert into public.profiles (id, full_name, username, phone)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), split_part(new.email, '@', 1)),
    uname,
    nullif(new.raw_user_meta_data->>'phone', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Atualiza last_message_at da conversa
create or replace function public.touch_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set last_message_at = new.created_at where id = new.conversation_id;
  -- quem envia já leu tudo até aqui
  if new.sender_id is not null then
    update public.conversation_members
       set last_read_at = new.created_at, last_delivered_at = new.created_at, marked_unread = false
     where conversation_id = new.conversation_id and user_id = new.sender_id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_message_created on public.messages;
create trigger on_message_created
  after insert on public.messages
  for each row execute function public.touch_conversation();

-- ---------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------

-- Abre (ou cria) uma conversa 1:1
create or replace function public.get_or_create_direct(other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare conv uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  select c.id into conv
  from public.conversations c
  join public.conversation_members a on a.conversation_id = c.id and a.user_id = auth.uid()
  join public.conversation_members b on b.conversation_id = c.id and b.user_id = other
  where not c.is_group
    and (other <> auth.uid() or (select count(*) from public.conversation_members x where x.conversation_id = c.id) = 1)
  limit 1;

  if conv is not null then return conv; end if;

  insert into public.conversations (is_group, created_by) values (false, auth.uid()) returning id into conv;
  insert into public.conversation_members (conversation_id, user_id, role) values (conv, auth.uid(), 'admin');
  if other <> auth.uid() then
    insert into public.conversation_members (conversation_id, user_id, role) values (conv, other, 'admin');
  end if;
  return conv;
end;
$$;

-- Cria grupo
create or replace function public.create_group(group_name text, member_ids uuid[], group_avatar text default null, group_description text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare conv uuid; m uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.conversations (is_group, name, avatar_url, description, created_by)
  values (true, group_name, group_avatar, group_description, auth.uid()) returning id into conv;

  insert into public.conversation_members (conversation_id, user_id, role) values (conv, auth.uid(), 'admin');
  foreach m in array member_ids loop
    if m <> auth.uid() then
      insert into public.conversation_members (conversation_id, user_id, role)
      values (conv, m, 'member') on conflict do nothing;
    end if;
  end loop;

  insert into public.messages (conversation_id, sender_id, type, content)
  values (conv, auth.uid(), 'system', 'created_group:' || group_name);
  return conv;
end;
$$;

-- Adiciona participantes (apenas admin)
create or replace function public.add_group_members(conv uuid, member_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare m uuid;
begin
  if not public.is_admin(conv) then raise exception 'only admins can add members'; end if;
  foreach m in array member_ids loop
    insert into public.conversation_members (conversation_id, user_id, role)
    values (conv, m, 'member') on conflict do nothing;
    insert into public.messages (conversation_id, sender_id, type, content)
    values (conv, auth.uid(), 'system', 'added:' || m::text);
  end loop;
end;
$$;

-- Remove participante (admin) ou sai do grupo (próprio usuário)
create or replace function public.remove_group_member(conv uuid, member uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if member <> auth.uid() and not public.is_admin(conv) then
    raise exception 'only admins can remove members';
  end if;
  insert into public.messages (conversation_id, sender_id, type, content)
  values (conv, auth.uid(), 'system', case when member = auth.uid() then 'left' else 'removed:' || member::text end);
  delete from public.conversation_members where conversation_id = conv and user_id = member;
  -- se ninguém sobrou como admin, promove o mais antigo
  if not exists (select 1 from public.conversation_members where conversation_id = conv and role = 'admin') then
    update public.conversation_members set role = 'admin'
     where conversation_id = conv and user_id = (
       select user_id from public.conversation_members where conversation_id = conv order by joined_at limit 1
     );
  end if;
end;
$$;

create or replace function public.set_member_role(conv uuid, member uuid, new_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin(conv) then raise exception 'only admins'; end if;
  update public.conversation_members set role = new_role where conversation_id = conv and user_id = member;
end;
$$;

-- Registra evento de grupo (renomeou, trocou imagem...) como mensagem de sistema
create or replace function public.log_group_event(conv uuid, note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(conv) then raise exception 'not a member'; end if;
  if note !~ '^(renamed:.*|changed_icon|changed_description)$' then raise exception 'invalid event'; end if;
  insert into public.messages (conversation_id, sender_id, type, content) values (conv, auth.uid(), 'system', note);
end;
$$;

-- Confirmações de leitura/entrega usando o relógio do servidor
create or replace function public.mark_read(conv uuid)
returns void language sql security definer set search_path = public as $$
  update public.conversation_members
     set last_read_at = now(), last_delivered_at = greatest(last_delivered_at, now()), marked_unread = false
   where conversation_id = conv and user_id = auth.uid();
$$;

create or replace function public.mark_delivered(conv uuid default null)
returns void language sql security definer set search_path = public as $$
  update public.conversation_members
     set last_delivered_at = now()
   where user_id = auth.uid() and (conv is null or conversation_id = conv)
     and last_delivered_at < (select coalesce(max(created_at), 'epoch') from public.messages m
                              where m.conversation_id = conversation_members.conversation_id);
$$;

-- Resumo da lista de conversas: última mensagem visível + não lidas
create or replace function public.chat_summaries()
returns table (conversation_id uuid, last_message jsonb, unread_count int)
language sql stable security definer set search_path = public as $$
  select cm.conversation_id,
    (select to_jsonb(m) from public.messages m
      where m.conversation_id = cm.conversation_id
        and m.created_at > cm.cleared_at
        and not exists (select 1 from public.message_hidden h where h.message_id = m.id and h.user_id = auth.uid())
      order by m.created_at desc limit 1) as last_message,
    (select count(*)::int from public.messages m
      where m.conversation_id = cm.conversation_id
        and m.created_at > cm.last_read_at
        and m.created_at > cm.cleared_at
        and m.sender_id is distinct from auth.uid()
        and m.type <> 'system') as unread_count
  from public.conversation_members cm
  where cm.user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------

alter table public.profiles             enable row level security;
alter table public.conversations        enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages             enable row level security;
alter table public.message_reactions    enable row level security;
alter table public.message_hidden       enable row level security;
alter table public.starred_messages     enable row level security;
alter table public.stickers             enable row level security;
alter table public.statuses             enable row level security;
alter table public.status_views         enable row level security;

-- profiles
drop policy if exists "profiles read"   on public.profiles;
drop policy if exists "profiles update" on public.profiles;
create policy "profiles read"   on public.profiles for select to authenticated using (true);
create policy "profiles update" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- conversations
drop policy if exists "conv read"   on public.conversations;
drop policy if exists "conv update" on public.conversations;
create policy "conv read"   on public.conversations for select to authenticated using (public.is_member(id));
create policy "conv update" on public.conversations for update to authenticated using (public.is_member(id)) with check (public.is_member(id));

-- conversation_members
drop policy if exists "members read"       on public.conversation_members;
drop policy if exists "members update own" on public.conversation_members;
create policy "members read"       on public.conversation_members for select to authenticated using (public.is_member(conversation_id));
create policy "members update own" on public.conversation_members for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- messages
drop policy if exists "messages read"   on public.messages;
drop policy if exists "messages insert" on public.messages;
drop policy if exists "messages update" on public.messages;
create policy "messages read"   on public.messages for select to authenticated using (public.is_member(conversation_id));
create policy "messages insert" on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and public.is_member(conversation_id) and type <> 'system');
create policy "messages update" on public.messages for update to authenticated
  using (sender_id = auth.uid()) with check (sender_id = auth.uid());

-- reactions
drop policy if exists "reactions read"  on public.message_reactions;
drop policy if exists "reactions write" on public.message_reactions;
create policy "reactions read"  on public.message_reactions for select to authenticated using (public.can_see_message(message_id));
create policy "reactions write" on public.message_reactions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.can_see_message(message_id));

-- hidden / starred
drop policy if exists "hidden own"  on public.message_hidden;
drop policy if exists "starred own" on public.starred_messages;
create policy "hidden own"  on public.message_hidden   for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "starred own" on public.starred_messages for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- stickers
drop policy if exists "stickers own" on public.stickers;
create policy "stickers own" on public.stickers for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- statuses: visíveis para quem tem conversa com o autor
drop policy if exists "statuses read"   on public.statuses;
drop policy if exists "statuses write"  on public.statuses;
drop policy if exists "statuses delete" on public.statuses;
create policy "statuses read"   on public.statuses for select to authenticated using (expires_at > now() and public.shares_conversation(user_id));
create policy "statuses write"  on public.statuses for insert to authenticated with check (user_id = auth.uid());
create policy "statuses delete" on public.statuses for delete to authenticated using (user_id = auth.uid());

drop policy if exists "status views insert" on public.status_views;
drop policy if exists "status views read"   on public.status_views;
create policy "status views insert" on public.status_views for insert to authenticated with check (viewer_id = auth.uid());
create policy "status views read"   on public.status_views for select to authenticated using (
  viewer_id = auth.uid() or exists (select 1 from public.statuses s where s.id = status_id and s.user_id = auth.uid())
);

-- ---------------------------------------------------------------------
-- REALTIME
-- ---------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['messages','message_reactions','conversation_members','conversations','profiles','statuses'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Canais privados de broadcast/presence por conversa (digitando..., chamadas)
drop policy if exists "conv topic read"  on realtime.messages;
drop policy if exists "conv topic write" on realtime.messages;
create policy "conv topic read"  on realtime.messages for select to authenticated using (public.can_access_topic(realtime.topic()));
create policy "conv topic write" on realtime.messages for insert to authenticated with check (public.can_access_topic(realtime.topic()));

-- ---------------------------------------------------------------------
-- STORAGE (buckets públicos; cada usuário só escreve na própria pasta <uid>/...)
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public) values
  ('avatars', 'avatars', true),
  ('media', 'media', true),
  ('stickers', 'stickers', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "zap upload own folder" on storage.objects;
drop policy if exists "zap update own folder" on storage.objects;
drop policy if exists "zap delete own folder" on storage.objects;
create policy "zap upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id in ('avatars','media','stickers') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "zap update own folder" on storage.objects for update to authenticated
  using (bucket_id in ('avatars','media','stickers') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "zap delete own folder" on storage.objects for delete to authenticated
  using (bucket_id in ('avatars','media','stickers') and (storage.foldername(name))[1] = auth.uid()::text);

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

-- =====================================================================
--  Notificações push (estilo WhatsApp: chegam com o app fechado)
--  Rode este arquivo no SQL Editor do Supabase (pode rodar mais de uma vez).
--
--  Cada aparelho/navegador que ativa as notificações vira uma linha aqui.
--  Quem envia o push é a função da Vercel (api/push.ts), usando a chave secreta do Supabase.
-- =====================================================================

create table if not exists public.push_subscriptions (
  endpoint    text primary key,                 -- endereço único do aparelho no serviço de push
  user_id     uuid not null references public.profiles(id) on delete cascade,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;

-- o usuário só enxerga/apaga os próprios aparelhos (a função da Vercel usa a chave secreta e ignora o RLS)
drop policy if exists "push own read"   on public.push_subscriptions;
drop policy if exists "push own delete" on public.push_subscriptions;
create policy "push own read" on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());
create policy "push own delete" on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

-- Salva o aparelho para o usuário logado. Se o mesmo aparelho estava em outra conta
-- (saiu e entrou com outra), ele passa para a conta atual — assim ninguém recebe notificação alheia.
create or replace function public.save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, updated_at)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth, p_user_agent, now())
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, updated_at = now();
end $$;

-- Ao sair da conta / desligar notificações: remove o aparelho (só se for da própria conta)
create or replace function public.delete_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.delete_push_subscription(text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.delete_push_subscription(text) to authenticated;

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
