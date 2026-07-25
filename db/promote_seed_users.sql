-- Spare Part Management — promote the 3 demo accounts.
--
-- Run this AFTER you've created the three users in Supabase Dashboard →
-- Authentication → Users → Add user (see SUPABASE_SETUP.md, step 5).
--
-- The `handle_new_user` trigger in schema.sql already created a matching row in
-- `profiles` for each one, with role='operator' and status='pending' by default
-- (and username taken from the email prefix, e.g. "admin" from
-- admin@login.spareapart.internal — which is exactly the username the app's
-- login screen expects). This script just promotes them to their real role and
-- flips them to active so they can log in.

update public.profiles set role = 'admin',      status = 'active' where username = 'admin';
update public.profiles set role = 'supervisor', status = 'active' where username = 'supervisor';
update public.profiles set role = 'operator',   status = 'active' where username = 'operator';

-- Optional: give them the same display names/emails the old demo build used.
update public.profiles set name = 'สมชาย ใจดี',   email = 'somchai@company.co.th'  where username = 'admin';
update public.profiles set name = 'วิภาวี แสนดี',  email = 'wipawee@company.co.th'  where username = 'supervisor';
update public.profiles set name = 'กฤษฎา แก้วใส',  email = 'kritsada@company.co.th' where username = 'operator';

select username, name, role, status from public.profiles order by id;
