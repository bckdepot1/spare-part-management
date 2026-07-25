-- Spare Part Management — Supabase schema
--
-- Run this once in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run: every statement is guarded with IF NOT EXISTS / OR REPLACE / DROP..CREATE.
--
-- Design notes
-- ------------
-- * Auth uses Supabase's built-in `auth.users` (proper password hashing, sessions, JWTs).
--   The app's "User" field is a short handle like `admin`; Supabase Auth requires an email,
--   so the frontend logs in with a synthetic address `<username>@login.spareapart.internal`.
--   That address is never sent anywhere — it only has to satisfy the email format check.
-- * `profiles` holds everything the app needs to show/enforce per user (name, role, status)
--   and is 1:1 with `auth.users`, created automatically by the `handle_new_user` trigger below.
-- * Regular authenticated users can only ever SELECT the three tables directly. Every write
--   goes through a `SECURITY DEFINER` function that re-checks the caller's role/status itself,
--   so permission logic lives in one place (Postgres) instead of being trusted to the browser.
-- * Postgres cannot see the words "admin/supervisor/operator" as anything special — they are
--   plain text values enforced by CHECK constraints, matched against in the RPC functions below.

-- ----------------------------------------------------------------------------------- extensions

create extension if not exists pgcrypto;

-- --------------------------------------------------------------------------------------- tables

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique,
  name        text not null default '',
  email       text not null default '',
  avatar_url  text,
  role        text not null default 'operator' check (role in ('admin','supervisor','operator')),
  status      text not null default 'pending'  check (status in ('active','pending','rejected')),
  created_at  timestamptz not null default now()
);

create table if not exists public.stock (
  id          bigint generated always as identity primary key,
  code        text not null,
  category    text not null default '',
  unit        text not null default '',
  qty         integer not null default 0 check (qty >= 0),
  min         integer not null default 0 check (min >= 0),
  max         integer not null default 0 check (max >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.transactions (
  id              bigint generated always as identity primary key,
  tx_date         date not null,
  tx_time         text not null,
  type            text not null check (type in ('in','out')),
  item_id         bigint not null references public.stock(id),
  item_code       text not null,
  category        text,
  unit            text,
  qty             integer not null check (qty > 0),
  user_id         uuid not null references public.profiles(id),
  user_name       text not null,
  status          text not null default 'pending' check (status in ('approved','pending','rejected')),
  note            text default '',
  approver_id     uuid references public.profiles(id),
  approver_name   text,
  created_at      timestamptz not null default now()
);

create index if not exists transactions_status_idx on public.transactions(status);
create index if not exists transactions_item_idx on public.transactions(item_id);
create index if not exists stock_code_idx on public.stock(code);

alter table public.profiles enable row level security;
alter table public.stock enable row level security;
alter table public.transactions enable row level security;

-- ------------------------------------------------------------------------------- helper functions
-- SECURITY DEFINER + a fixed search_path so these are safe to call from RLS policies without
-- recursing back into the very policy that calls them.

create or replace function public.current_role_name()
returns text
language sql security definer stable set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_active_user()
returns boolean
language sql security definer stable set search_path = public as $$
  select coalesce((select status = 'active' from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.can_direct_stock()
returns boolean
language sql security definer stable set search_path = public as $$
  select coalesce(
    (select role in ('admin','supervisor') and status = 'active' from public.profiles where id = auth.uid()),
    false
  );
$$;

create or replace function public.is_admin_user()
returns boolean
language sql security definer stable set search_path = public as $$
  select coalesce((select role = 'admin' and status = 'active' from public.profiles where id = auth.uid()), false);
$$;

-- --------------------------------------------------------------------------------- read policies
-- Everything is readable by any signed-in *active* account — the UI itself hides pages/actions
-- a role shouldn't see, and every write is still separately locked down below.

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (auth.uid() is not null and public.is_active_user());

drop policy if exists stock_select on public.stock;
create policy stock_select on public.stock for select
  using (auth.uid() is not null and public.is_active_user());

drop policy if exists transactions_select on public.transactions;
create policy transactions_select on public.transactions for select
  using (auth.uid() is not null and public.is_active_user());

-- A brand new sign-up is not "active" yet, so it needs to read its own single profile row
-- to show the "รอการอนุมัติ" message after signing up.
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select
  using (auth.uid() = id);

-- No insert/update/delete policies are defined on purpose: direct table writes from the
-- anon/authenticated role are refused. All mutations happen through the functions below,
-- which run as the table owner and therefore bypass RLS internally.

-- ------------------------------------------------------------------------------ new user trigger

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, name, email, avatar_url, role, status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'name', ''),
    coalesce(new.raw_user_meta_data->>'contact_email', ''),
    new.raw_user_meta_data->>'avatar_url',
    'operator',
    'pending'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------------- transactions

create or replace function public.submit_transaction(
  p_item_id bigint,
  p_type    text,
  p_qty     integer,
  p_note    text,
  p_tx_date date
)
returns public.transactions
language plpgsql security definer set search_path = public as $$
declare
  v_caller   public.profiles;
  v_item     public.stock;
  v_direct   boolean;
  v_tx       public.transactions;
begin
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller is null or v_caller.status <> 'active' then
    raise exception 'ไม่มีสิทธิ์ทำรายการนี้';
  end if;
  if p_type not in ('in','out') then
    raise exception 'ประเภทไม่ถูกต้อง';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'จำนวนไม่ถูกต้อง';
  end if;

  select * into v_item from public.stock where id = p_item_id for update;
  if v_item is null then
    raise exception 'ไม่พบอุปกรณ์';
  end if;

  v_direct := v_caller.role in ('admin','supervisor');

  if p_type = 'out' and v_direct and p_qty > v_item.qty then
    raise exception 'จำนวนขอเบิกมากกว่าจำนวนคงเหลือใน Stock';
  end if;

  insert into public.transactions (
    tx_date, tx_time, type, item_id, item_code, category, unit, qty,
    user_id, user_name, status, note, approver_id, approver_name
  ) values (
    p_tx_date, to_char(now(), 'HH24:MI'), p_type, v_item.id, v_item.code, v_item.category, v_item.unit, p_qty,
    v_caller.id, v_caller.name,
    case when v_direct then 'approved' else 'pending' end,
    p_note,
    case when v_direct then v_caller.id else null end,
    case when v_direct then v_caller.name else null end
  ) returning * into v_tx;

  if v_direct then
    update public.stock
      set qty = case when p_type = 'in' then qty + p_qty else qty - p_qty end,
          updated_at = now()
      where id = v_item.id;
  end if;

  return v_tx;
end;
$$;

create or replace function public.approve_transaction(p_tx_id bigint)
returns public.transactions
language plpgsql security definer set search_path = public as $$
declare
  v_caller public.profiles;
  v_tx     public.transactions;
  v_item   public.stock;
begin
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller is null or v_caller.status <> 'active' or v_caller.role not in ('admin','supervisor') then
    raise exception 'ไม่มีสิทธิ์อนุมัติรายการ';
  end if;

  select * into v_tx from public.transactions where id = p_tx_id for update;
  if v_tx is null or v_tx.status <> 'pending' then
    raise exception 'ไม่พบรายการที่รออนุมัติ';
  end if;

  select * into v_item from public.stock where id = v_tx.item_id for update;
  if v_tx.type = 'out' and v_tx.qty > v_item.qty then
    raise exception 'อนุมัติไม่ได้: จำนวนขอเบิกมากกว่าคงเหลือใน Stock';
  end if;

  update public.stock
    set qty = case when v_tx.type = 'in' then qty + v_tx.qty else qty - v_tx.qty end,
        updated_at = now()
    where id = v_item.id;

  update public.transactions
    set status = 'approved', approver_id = v_caller.id, approver_name = v_caller.name
    where id = p_tx_id
    returning * into v_tx;

  return v_tx;
end;
$$;

create or replace function public.reject_transaction(p_tx_id bigint)
returns public.transactions
language plpgsql security definer set search_path = public as $$
declare
  v_caller public.profiles;
  v_tx     public.transactions;
begin
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller is null or v_caller.status <> 'active' or v_caller.role not in ('admin','supervisor') then
    raise exception 'ไม่มีสิทธิ์ปฏิเสธรายการ';
  end if;

  update public.transactions
    set status = 'rejected', approver_id = v_caller.id, approver_name = v_caller.name
    where id = p_tx_id and status = 'pending'
    returning * into v_tx;

  if v_tx is null then
    raise exception 'ไม่พบรายการที่รออนุมัติ';
  end if;

  return v_tx;
end;
$$;

-- --------------------------------------------------------------------------------------- stock

create or replace function public.update_stock_minmax(p_item_id bigint, p_field text, p_value integer)
returns public.stock
language plpgsql security definer set search_path = public as $$
declare
  v_item public.stock;
begin
  if not public.can_direct_stock() then
    raise exception 'ไม่มีสิทธิ์แก้ไขค่า Min/Max';
  end if;
  if p_field not in ('min','max') then
    raise exception 'field ไม่ถูกต้อง';
  end if;
  if p_value is null or p_value < 0 then
    raise exception 'ค่าไม่ถูกต้อง';
  end if;

  if p_field = 'min' then
    update public.stock set min = p_value, updated_at = now() where id = p_item_id returning * into v_item;
  else
    update public.stock set max = p_value, updated_at = now() where id = p_item_id returning * into v_item;
  end if;

  if v_item is null then
    raise exception 'ไม่พบอุปกรณ์';
  end if;
  return v_item;
end;
$$;

-- --------------------------------------------------------------------------------------- users

create or replace function public.approve_user(p_user_id uuid)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare v_row public.profiles;
begin
  if not public.can_direct_stock() then
    raise exception 'ไม่มีสิทธิ์อนุมัติบัญชีผู้ใช้งาน';
  end if;
  update public.profiles set status = 'active' where id = p_user_id returning * into v_row;
  if v_row is null then raise exception 'ไม่พบผู้ใช้งาน'; end if;
  return v_row;
end;
$$;

create or replace function public.reject_user(p_user_id uuid)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare v_row public.profiles;
begin
  if not public.can_direct_stock() then
    raise exception 'ไม่มีสิทธิ์ปฏิเสธบัญชีผู้ใช้งาน';
  end if;
  update public.profiles set status = 'rejected' where id = p_user_id returning * into v_row;
  if v_row is null then raise exception 'ไม่พบผู้ใช้งาน'; end if;
  return v_row;
end;
$$;

create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare v_row public.profiles;
begin
  if not public.is_admin_user() then
    raise exception 'ไม่มีสิทธิ์กำหนดสิทธิ์ผู้ใช้งาน';
  end if;
  if p_role not in ('admin','supervisor','operator') then
    raise exception 'สิทธิ์ไม่ถูกต้อง';
  end if;
  update public.profiles set role = p_role where id = p_user_id returning * into v_row;
  if v_row is null then raise exception 'ไม่พบผู้ใช้งาน'; end if;
  return v_row;
end;
$$;

-- Removes both the profile and the underlying auth user, so a deleted account cannot log back in.
create or replace function public.delete_user(p_user_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin_user() then
    raise exception 'ไม่มีสิทธิ์ลบผู้ใช้งาน';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'ไม่สามารถลบบัญชีที่ใช้งานอยู่ได้';
  end if;
  delete from auth.users where id = p_user_id;
end;
$$;

-- --------------------------------------------------------------------------------- grants
-- RLS above already blocks table writes; grant EXECUTE explicitly so PostgREST exposes
-- these functions to the anon/authenticated JS client via supabase.rpc(...).

grant execute on function
  public.submit_transaction(bigint, text, integer, text, date),
  public.approve_transaction(bigint),
  public.reject_transaction(bigint),
  public.update_stock_minmax(bigint, text, integer),
  public.approve_user(uuid),
  public.reject_user(uuid),
  public.set_user_role(uuid, text),
  public.delete_user(uuid)
to authenticated;
