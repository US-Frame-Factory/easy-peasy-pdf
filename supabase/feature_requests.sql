-- "Request a feature" table for Quick Fast PDF.
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run.
--
-- The app sends requests with the project's public anon key. Row-level security
-- lets that key ADD rows only: it can't read, change or delete any, so the key
-- being inside the app is safe. Read the requests in Table Editor > feature_requests.

create table if not exists public.feature_requests (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  message     text not null check (char_length(message) between 3 and 5000),
  name        text check (char_length(name) <= 200),
  email       text check (char_length(email) <= 200),
  app_version text check (char_length(app_version) <= 50),
  platform    text check (char_length(platform) <= 200),
  status      text not null default 'new'
                check (status in ('new', 'planned', 'in progress', 'done', 'declined')),
  notes       text
);

alter table public.feature_requests enable row level security;

drop policy if exists "app can submit requests" on public.feature_requests;
create policy "app can submit requests"
  on public.feature_requests for insert to anon
  with check (status = 'new' and notes is null);

-- Inserts only, and only of the columns the app sends.
revoke all on public.feature_requests from anon;
grant insert (message, name, email, app_version, platform, created_at) on public.feature_requests to anon;

-- Keep created_at honest (the app's clock may be off): the server time wins.
create or replace function public.feature_requests_stamp() returns trigger
language plpgsql as $$ begin new.created_at := now(); return new; end $$;
drop trigger if exists feature_requests_stamp on public.feature_requests;
create trigger feature_requests_stamp before insert on public.feature_requests
  for each row execute function public.feature_requests_stamp();
