create or replace function public.submit_transaction(
  p_item_id bigint,
  p_type    text,
  p_qty     integer,
  p_note    text,
  p_tx_date date
)
returns public.transactions
language plpgsql security definer set search_path = public as $$
-- Spare Part Management — refuse to issue or request a part that has no stock.
--
-- Run this once in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run.
--
-- The problem
-- -----------
-- The existing "not more than the balance" check was gated on v_direct, so it
-- only applied to Admin/Supervisor issuing directly. An Operator could raise a
-- request against an item with 0 on hand; approve_transaction would then refuse
-- it, so the request sat in the approval queue permanently un-approvable.
--
-- The empty-stock check below applies to everyone, so an item at 0 cannot be
-- requested in the first place. The quantity check stays gated on v_direct: for
-- an Operator that is deliberately left to approval time, so a request for more
-- than the balance is still a decision the approver gets to make.
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

  -- Applies to every role, including a pending request.
  if p_type = 'out' and v_item.qty <= 0 then
    raise exception 'อุปกรณ์นี้ไม่มีคงเหลือใน Stock จึงเบิกไม่ได้';
  end if;

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

grant execute on function public.submit_transaction(bigint, text, integer, text, date) to authenticated;
