create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.links (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  url text not null,
  normalized_url text not null,
  title text not null,
  page_url text,
  is_seen boolean not null default false,
  seen_at timestamptz,
  is_favorite boolean not null default false,
  favorited_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz
);

alter table public.links
  add column if not exists is_seen boolean not null default false;

alter table public.links
  add column if not exists seen_at timestamptz;

alter table public.links
  add column if not exists is_favorite boolean not null default false;

alter table public.links
  add column if not exists favorited_at timestamptz;

create unique index if not exists links_user_id_normalized_url_key
  on public.links (user_id, normalized_url);

create index if not exists links_user_id_updated_at_idx
  on public.links (user_id, updated_at desc);

create index if not exists links_user_id_deleted_at_idx
  on public.links (user_id, deleted_at);

drop trigger if exists set_links_updated_at on public.links;

create trigger set_links_updated_at
before update on public.links
for each row
execute function public.set_updated_at();

alter table public.links enable row level security;

drop policy if exists "Users can read their own links" on public.links;
create policy "Users can read their own links"
on public.links
for select
using (auth.uid() = user_id);

drop policy if exists "Users can insert their own links" on public.links;
create policy "Users can insert their own links"
on public.links
for insert
with check (auth.uid() = user_id);

drop policy if exists "Users can update their own links" on public.links;
create policy "Users can update their own links"
on public.links
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own links" on public.links;
create policy "Users can delete their own links"
on public.links
for delete
using (auth.uid() = user_id);