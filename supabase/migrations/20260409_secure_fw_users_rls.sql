-- Secure fw_users with Row Level Security so each authenticated user can
-- only access their own account row.

alter table if exists public.fw_users enable row level security;
alter table if exists public.fw_users force row level security;

-- Remove permissive grants for anonymous users.
revoke all on table public.fw_users from anon;

-- Authenticated users can operate only on their own row (enforced by policies).
grant select, insert, update, delete on table public.fw_users to authenticated;

-- Recreate policies idempotently.
drop policy if exists fw_users_select_own on public.fw_users;
drop policy if exists fw_users_insert_own on public.fw_users;
drop policy if exists fw_users_update_own on public.fw_users;
drop policy if exists fw_users_delete_own on public.fw_users;

-- A row is considered "owned" if auth.uid matches auth_user_id
-- or the authenticated email matches row email.
create policy fw_users_select_own
on public.fw_users
for select
to authenticated
using (
  (
    auth.uid() is not null
    and coalesce(auth_user_id::text, '') = auth.uid()::text
  )
  or (
    coalesce(email, '') <> ''
    and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
);

create policy fw_users_insert_own
on public.fw_users
for insert
to authenticated
with check (
  (
    auth.uid() is not null
    and coalesce(auth_user_id::text, '') = auth.uid()::text
  )
  or (
    coalesce(email, '') <> ''
    and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
);

create policy fw_users_update_own
on public.fw_users
for update
to authenticated
using (
  (
    auth.uid() is not null
    and coalesce(auth_user_id::text, '') = auth.uid()::text
  )
  or (
    coalesce(email, '') <> ''
    and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
)
with check (
  (
    auth.uid() is not null
    and coalesce(auth_user_id::text, '') = auth.uid()::text
  )
  or (
    coalesce(email, '') <> ''
    and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
);

create policy fw_users_delete_own
on public.fw_users
for delete
to authenticated
using (
  (
    auth.uid() is not null
    and coalesce(auth_user_id::text, '') = auth.uid()::text
  )
  or (
    coalesce(email, '') <> ''
    and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
);
