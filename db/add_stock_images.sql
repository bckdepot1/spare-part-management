-- Spare Part Management — add pictures to the equipment list.
--
-- Run this once in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run.
--
-- Pictures live in their own table rather than as a column on `stock` on purpose:
-- the app re-reads `stock` every time anyone receives or issues a part (that is what
-- keeps everyone's screen in sync), and dragging every picture along on each of those
-- refreshes would burn the bandwidth quota for no benefit. Kept separate, the pictures
-- are fetched once when someone signs in and then left alone.

create table if not exists public.stock_images (
  item_id     bigint primary key references public.stock(id) on delete cascade,
  image       text not null,
  updated_at  timestamptz not null default now()
);

alter table public.stock_images enable row level security;

-- Readable by any signed-in active account, same as the stock list itself.
drop policy if exists stock_images_select on public.stock_images;
create policy stock_images_select on public.stock_images for select
  using (auth.uid() is not null and public.is_active_user());

-- No insert/update/delete policy: writes go through the function below, which
-- re-checks the caller's role itself.
create or replace function public.set_stock_image(p_item_id bigint, p_image text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  -- Same bar as editing Min/Max: Admin and Supervisor only.
  if not public.can_direct_stock() then
    raise exception 'ไม่มีสิทธิ์แก้ไขรูปอุปกรณ์';
  end if;

  if not exists (select 1 from public.stock where id = p_item_id) then
    raise exception 'ไม่พบอุปกรณ์';
  end if;

  -- Empty means "remove the picture".
  if p_image is null or p_image = '' then
    delete from public.stock_images where item_id = p_item_id;
    return;
  end if;

  -- The app downscales before sending; this is a backstop against a caller
  -- storing something big enough to slow the list down for everyone.
  if length(p_image) > 120000 then
    raise exception 'รูปใหญ่เกินไป';
  end if;

  insert into public.stock_images (item_id, image, updated_at)
       values (p_item_id, p_image, now())
  on conflict (item_id)
    do update set image = excluded.image, updated_at = now();
end;
$$;

grant execute on function public.set_stock_image(bigint, text) to authenticated;

select count(*) as pictures_stored from public.stock_images;
