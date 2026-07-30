-- Spare Part Management — fix accounts with a profile picture being unable to log in.
--
-- Run this once in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run.
--
-- The problem
-- -----------
-- Sign-up passed the picture through auth metadata (`raw_user_meta_data`).
-- Supabase copies that metadata into the JWT, and the JWT travels in an
-- `Authorization` header on every single request — so a base64 image there pushes
-- the header past what the gateway accepts. Measured against this project:
-- headers up to 32 KB answer normally, 64 KB returns 520, 256 KB returns 400.
-- A phone photo is far bigger than that, so every request from an account with a
-- picture failed, while accounts without one worked fine.
--
-- The fix has two halves: this script repairs existing accounts, and the app no
-- longer routes pictures through auth metadata (it calls set_my_avatar below).

-- 1. Preserve any picture already uploaded by moving it into `profiles`,
--    which is read with a normal query body instead of a request header.
update public.profiles p
   set avatar_url = u.raw_user_meta_data->>'avatar_url'
  from auth.users u
 where u.id = p.id
   and coalesce(u.raw_user_meta_data->>'avatar_url', '') <> ''
   and coalesce(p.avatar_url, '') = '';

-- 2. Strip it from auth metadata so newly minted JWTs are small again.
--    This is what actually restores login for the affected accounts.
update auth.users
   set raw_user_meta_data = raw_user_meta_data - 'avatar_url'
 where raw_user_meta_data ? 'avatar_url';

-- 3. Let a signed-in user store their own picture directly in `profiles`.
--    Called by the app right after sign-up, while the session from signUp() is
--    still valid. RLS grants no UPDATE on the table, so this runs as definer and
--    is restricted to the caller's own row.
create or replace function public.set_my_avatar(p_avatar text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;
  -- The app already downsizes to a ~128px thumbnail; this is a backstop so a
  -- caller cannot put the oversized-payload problem back by hand.
  if p_avatar is not null and length(p_avatar) > 120000 then
    raise exception 'รูปโปรไฟล์ใหญ่เกินไป';
  end if;
  update public.profiles
     set avatar_url = nullif(p_avatar, '')
   where id = auth.uid();
end;
$$;

grant execute on function public.set_my_avatar(text) to authenticated;

-- Check: avatar_len should be 0 for every row. Any non-zero value means an
-- account still carries a picture in its metadata and would fail to log in.
select u.email,
       length(coalesce(u.raw_user_meta_data->>'avatar_url', '')) as avatar_len_in_jwt,
       length(coalesce(p.avatar_url, ''))                        as avatar_len_in_profile,
       p.status
  from auth.users u
  join public.profiles p on p.id = u.id
 order by u.created_at;
