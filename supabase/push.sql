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
