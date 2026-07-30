-- Spare Part Management — allow deleting a user who already has movement history.
--
-- Run this once in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run.
--
-- The problem
-- -----------
-- transactions.user_id and .approver_id referenced profiles(id) with no ON DELETE
-- rule, so Postgres defaulted to blocking the delete:
--   update or delete on table "profiles" violates foreign key constraint
--   "transactions_user_id_fkey" on table "transactions"
-- Anyone who had ever received or issued a part could therefore never be removed,
-- which is exactly the case for a staff member who has left.
--
-- Why ON DELETE SET NULL is safe here
-- -----------------------------------
-- The history does not read the person's name through this key — transactions
-- stores user_name and approver_name as plain text columns, and that is what the
-- ประวัติ/Log table and the approval cards display. Clearing the id keeps every
-- past row intact and still attributed by name; it only drops the link to a
-- profile row that no longer exists.

alter table public.transactions
  drop constraint if exists transactions_user_id_fkey;

-- Required before the id can be nulled out on delete.
alter table public.transactions
  alter column user_id drop not null;

alter table public.transactions
  add constraint transactions_user_id_fkey
  foreign key (user_id) references public.profiles(id) on delete set null;

alter table public.transactions
  drop constraint if exists transactions_approver_id_fkey;

alter table public.transactions
  add constraint transactions_approver_id_fkey
  foreign key (approver_id) references public.profiles(id) on delete set null;

-- Check: both rules should read SET NULL.
select tc.constraint_name, rc.delete_rule
  from information_schema.table_constraints tc
  join information_schema.referential_constraints rc
    on rc.constraint_name = tc.constraint_name
 where tc.table_schema = 'public'
   and tc.table_name = 'transactions'
   and tc.constraint_type = 'FOREIGN KEY'
 order by tc.constraint_name;
