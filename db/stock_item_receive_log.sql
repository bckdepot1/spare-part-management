drop function if exists public.submit_stock_item(text, text, text, integer, integer, integer);

-- Spare Part Management — make a new item's starting quantity count as a real
-- receive, showing up in ประวัติ/Log and every Overview figure that reads
-- from transactions (the รับเข้า KPI, the bar chart).
--
-- Run this once in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run.
--
-- Previously submit_stock_item wrote the starting quantity straight onto
-- stock.qty — the item existed with a balance, but no transactions row ever
-- recorded receiving it, so it was invisible everywhere that reads history
-- instead of the live table (Log, the รับเข้า KPI, the bar chart).
--
-- Fixed to match how every other receive already works in this app: a pending
-- request never touches stock.qty by itself — approving it is what applies the
-- quantity. So a request now starts stock.qty at 0 regardless of the number
-- typed, and carries that number on a linked transactions row instead; only
-- approve_stock_item (Admin/Supervisor, direct-add included) adds it to the
-- balance, the same moment it becomes an "อนุมัติแล้ว" row in the log.
--
-- create or replace with a different parameter list creates a second, overloaded
-- function rather than replacing the old one — the drop on line 1 clears that.

create or replace function public.submit_stock_item(
  p_code     text,
  p_category text,
  p_unit     text,
  p_qty      integer default 0,
  p_min      integer default null,
  p_max      integer default null,
  p_date     date default current_date
)
returns public.stock
language plpgsql security definer set search_path = public as $$
declare
  v_caller public.profiles;
  v_code   text;
  v_direct boolean;
  v_qty    integer;
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

  v_qty := coalesce(p_qty, 0);
  if v_qty < 0 then
    raise exception 'จำนวนต้องไม่ติดลบ';
  end if;

  v_direct := v_caller.role in ('admin','supervisor');

  insert into public.stock (
    code, category, unit, qty, min, max, status,
    requested_by, requested_name, approved_by, approved_name
  ) values (
    v_code, trim(coalesce(p_category, '')), trim(coalesce(p_unit, '')),
    -- Balance starts at 0 either way — a direct add's quantity is applied by
    -- the receive transaction inserted below, exactly like an Admin's normal
    -- direct receive already works, not written here a second time.
    0,
    case when v_direct then coalesce(p_min, 1) else 0 end,
    case when v_direct then coalesce(p_max, 1) else 0 end,
    case when v_direct then 'active' else 'pending' end,
    v_caller.id, v_caller.name,
    case when v_direct then v_caller.id else null end,
    case when v_direct then v_caller.name else null end
  ) returning * into v_item;

  if v_qty > 0 then
    insert into public.transactions (
      tx_date, tx_time, type, item_id, item_code, category, unit, qty,
      user_id, user_name, status, note, approver_id, approver_name
    ) values (
      coalesce(p_date, current_date), to_char(now(), 'HH24:MI'), 'in',
      v_item.id, v_item.code, v_item.category, v_item.unit, v_qty,
      v_caller.id, v_caller.name,
      case when v_direct then 'approved' else 'pending' end,
      'เพิ่มอุปกรณ์ใหม่',
      case when v_direct then v_caller.id else null end,
      case when v_direct then v_caller.name else null end
    );
  end if;

  if v_direct and v_qty > 0 then
    update public.stock set qty = v_qty, updated_at = now() where id = v_item.id
      returning * into v_item;
  end if;

  return v_item;
end;
$$;

create or replace function public.approve_stock_item(p_item_id bigint, p_min integer, p_max integer)
returns public.stock
language plpgsql security definer set search_path = public as $$
declare
  v_caller public.profiles;
  v_item   public.stock;
  v_qty    integer;
begin
  select * into v_caller from public.profiles where id = auth.uid();
  if v_caller is null or v_caller.status <> 'active' or v_caller.role not in ('admin','supervisor') then
    raise exception 'ไม่มีสิทธิ์อนุมัติรายการนี้';
  end if;
  if coalesce(p_min, 0) < 0 or coalesce(p_max, 0) < 0 then
    raise exception 'ค่า Min/Max ไม่ถูกต้อง';
  end if;

  select coalesce(sum(qty), 0) into v_qty
    from public.transactions
   where item_id = p_item_id and type = 'in' and status = 'pending';

  update public.transactions
     set status = 'approved', approver_id = v_caller.id, approver_name = v_caller.name
   where item_id = p_item_id and type = 'in' and status = 'pending';

  update public.stock
     set status = 'active', min = coalesce(p_min, 0), max = coalesce(p_max, 0),
         qty = qty + v_qty, approved_by = v_caller.id, approved_name = v_caller.name, updated_at = now()
   where id = p_item_id and status = 'pending'
   returning * into v_item;

  if v_item is null then
    raise exception 'ไม่พบรายการที่รออนุมัติ';
  end if;
  return v_item;
end;
$$;

-- Rejecting also cancels the linked "receive" record: nothing else can
-- reference it (transactions.item_id would otherwise block deleting the
-- stock row), and the request never became real stock to begin with.
create or replace function public.reject_stock_item(p_item_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_deleted bigint;
begin
  if not public.can_direct_stock() then
    raise exception 'ไม่มีสิทธิ์ปฏิเสธรายการนี้';
  end if;

  delete from public.transactions where item_id = p_item_id and status = 'pending';

  delete from public.stock where id = p_item_id and status = 'pending'
    returning id into v_deleted;

  if v_deleted is null then
    raise exception 'ไม่พบรายการที่รออนุมัติ';
  end if;
end;
$$;

grant execute on function public.submit_stock_item(text, text, text, integer, integer, integer, date) to authenticated;
grant execute on function public.approve_stock_item(bigint, integer, integer) to authenticated;
grant execute on function public.reject_stock_item(bigint) to authenticated;
