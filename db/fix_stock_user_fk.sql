alter table public.stock drop constraint if exists stock_requested_by_fkey;

-- Spare Part Management — let a user be deleted after they have added or approved
-- equipment, the same way db/fix_delete_user.sql already allows it after they have
-- received or issued a part.
--
-- Run this once in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run.
--
-- The problem
-- -----------
-- db/stock_item_requests.sql added stock.requested_by and stock.approved_by as
-- plain references to profiles(id) with no ON DELETE rule, so Postgres defaulted
-- to blocking the delete:
--   update or delete on table "profiles" violates foreign key constraint
--   "stock_requested_by_fkey" on table "stock"
-- Deleting a departed staff member worked when that fix was written, because the
-- equipment-request feature did not exist yet. Anyone who has since added an item
-- or approved a request — which includes the Admin account — could no longer be
-- removed.
--
-- Why ON DELETE SET NULL is safe here
-- -----------------------------------
-- Nothing reads a person's name through these keys. stock stores requested_name
-- and approved_name as plain text, and those are what the pending-request card
-- displays; the app never renders requested_by or approved_by at all. Clearing the
-- id keeps the record and its attribution intact, and only drops the link to a
-- profile row that no longer exists.

alter table public.stock
  add constraint stock_requested_by_fkey
  foreign key (requested_by) references public.profiles(id) on delete set null;

alter table public.stock drop constraint if exists stock_approved_by_fkey;

alter table public.stock
  add constraint stock_approved_by_fkey
  foreign key (approved_by) references public.profiles(id) on delete set null;

-- Check: every foreign key pointing at a person should read SET NULL, so the row
-- survives the person being deleted. item_id keys are unrelated and may differ.
select tc.table_name, tc.constraint_name, rc.delete_rule
  from information_schema.table_constraints tc
  join information_schema.referential_constraints rc
    on rc.constraint_name = tc.constraint_name
 where tc.table_schema = 'public'
   and tc.table_name in ('stock', 'transactions')
   and tc.constraint_type = 'FOREIGN KEY'
 order by tc.table_name, tc.constraint_name;
