-- Spare Part Management — let Operator request new equipment, with
-- Admin/Supervisor approval.
--
-- Run this once in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run.
--
-- Replaces add_stock_item from db/add_stock_item.sql with a role-aware version,
-- matching how submit_transaction already handles receive/issue: Admin/Supervisor
-- act immediately, Operator's request waits for approval.
--
-- Flow: Operator "สร้างรายการอุปกรณ์ใหม่" -> "รออนุมัติ" -> Admin/Supervisor
-- "อนุมัติ" (sets Min/Max at the same time) -> the item appears everywhere
-- (table, movement forms, donut) and its picture can be added the same way as
-- any other item, from the inventory table.

alter table public.stock add column if not exists status         text not null default 'active' check (status in ('active','pending'));
alter table public.stock add column if not exists requested_by   uuid references public.profiles(id);
alter table public.stock add column if not exists requested_name text;
alter table public.stock add column if not exists approved_by    uuid references public.profiles(id);
alter table public.stock add column if not exists approved_name  text;

drop function if exists public.add_stock_item(text, text, text, integer, integer, integer);

create or replace function public.submit_stock_item(
  p_code     text,
  p_category text,
  p_unit     text,
  p_qty      integer default 0,
  p_min      integer default null,
  p_max      integer default null
)
returns public.stock
language plpgsql security definer set search_path = public as $$
declare
  v_caller public.profiles;
  v_code   text;
  v_direct boolean;
  v_item   public.stock;
begin
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller is null or v_caller.status <> 'active' then
    raise exception 'ไม่มีสิทธิ์ทำรายการนี้';
  end if;

  v_code := trim(coalesce(p_code, ''));
  if v_code = '' then
    raise exception 'กรุณาระบุชื่ออุปกรณ์';
  end if;
  if exists (select 1 from public.stock where lower(trim(code)) = lower(v_code)) then
    raise exception 'มีอุปกรณ์ชื่อนี้อยู่แล้ว';
  end if;
  if coalesce(p_qty, 0) < 0 then
    raise exception 'จำนวนต้องไม่ติดลบ';
  end if;

  v_direct := v_caller.role in ('admin','supervisor');

  insert into public.stock (
    code, category, unit, qty, min, max, status,
    requested_by, requested_name, approved_by, approved_name
  ) values (
    v_code, trim(coalesce(p_category, '')), trim(coalesce(p_unit, '')), coalesce(p_qty, 0),
    -- Admin/Supervisor set Min/Max themselves right away; Operator's request
    -- carries none, since deciding those is exactly what approval is for.
    case when v_direct then coalesce(p_min, 1) else 0 end,
    case when v_direct then coalesce(p_max, 1) else 0 end,
    case when v_direct then 'active' else 'pending' end,
    v_caller.id, v_caller.name,
    case when v_direct then v_caller.id else null end,
    case when v_direct then v_caller.name else null end
  ) returning * into v_item;

  return v_item;
end;
$$;

create or replace function public.approve_stock_item(p_item_id bigint, p_min integer, p_max integer)
returns public.stock
language plpgsql security definer set search_path = public as $$
declare
  v_caller public.profiles;
  v_item   public.stock;
begin
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller is null or v_caller.status <> 'active' or v_caller.role not in ('admin','supervisor') then
    raise exception 'ไม่มีสิทธิ์อนุมัติรายการนี้';
  end if;
  if coalesce(p_min, 0) < 0 or coalesce(p_max, 0) < 0 then
    raise exception 'ค่า Min/Max ไม่ถูกต้อง';
  end if;

  update public.stock
     set status = 'active', min = coalesce(p_min, 0), max = coalesce(p_max, 0),
         approved_by = v_caller.id, approved_name = v_caller.name, updated_at = now()
   where id = p_item_id and status = 'pending'
   returning * into v_item;

  if v_item is null then
    raise exception 'ไม่พบรายการที่รออนุมัติ';
  end if;
  return v_item;
end;
$$;

-- Rejecting removes the request outright rather than archiving it: a pending
-- item is never reachable from the movement forms or the inventory table, so
-- nothing can already reference it, and there is no login identity here worth
-- preserving the way a rejected user account is.
create or replace function public.reject_stock_item(p_item_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_deleted bigint;
begin
  if not public.can_direct_stock() then
    raise exception 'ไม่มีสิทธิ์ปฏิเสธรายการนี้';
  end if;

  delete from public.stock where id = p_item_id and status = 'pending'
    returning id into v_deleted;

  if v_deleted is null then
    raise exception 'ไม่พบรายการที่รออนุมัติ';
  end if;
end;
$$;

grant execute on function public.submit_stock_item(text, text, text, integer, integer, integer) to authenticated;
grant execute on function public.approve_stock_item(bigint, integer, integer) to authenticated;
grant execute on function public.reject_stock_item(bigint) to authenticated;
