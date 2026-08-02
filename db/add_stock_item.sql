-- Spare Part Management — allow adding new equipment beyond the original
-- 143-item master list.
--
-- Run this once in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run.
--
-- No RPC existed for inserting into `stock` at all — RLS grants only SELECT on
-- the table, so every row had to come from the original seed. This adds the
-- missing write path, gated the same as editing Min/Max (Admin/Supervisor).

create or replace function public.add_stock_item(
  p_code     text,
  p_category text,
  p_unit     text,
  p_qty      integer default 0,
  p_min      integer default 0,
  p_max      integer default 0
)
returns public.stock
language plpgsql security definer set search_path = public as $$
declare
  v_code text;
  v_item public.stock;
begin
  if not public.can_direct_stock() then
    raise exception 'ไม่มีสิทธิ์เพิ่มอุปกรณ์';
  end if;

  v_code := trim(coalesce(p_code, ''));
  if v_code = '' then
    raise exception 'กรุณาระบุชื่ออุปกรณ์';
  end if;

  -- Case-insensitive, matching how the app already looks up a typed code
  -- (findByCode trims and lowercases before comparing).
  if exists (select 1 from public.stock where lower(trim(code)) = lower(v_code)) then
    raise exception 'มีอุปกรณ์ชื่อนี้อยู่แล้ว';
  end if;

  if coalesce(p_qty, 0) < 0 or coalesce(p_min, 0) < 0 or coalesce(p_max, 0) < 0 then
    raise exception 'จำนวนต้องไม่ติดลบ';
  end if;

  insert into public.stock (code, category, unit, qty, min, max)
       values (v_code, trim(coalesce(p_category, '')), trim(coalesce(p_unit, '')),
               coalesce(p_qty, 0), coalesce(p_min, 0), coalesce(p_max, 0))
    returning * into v_item;

  return v_item;
end;
$$;

grant execute on function public.add_stock_item(text, text, text, integer, integer, integer) to authenticated;
