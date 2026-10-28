-- Sleep and Food Tracker backend: initial schema
-- Paste this whole file into the Supabase SQL Editor and press Run.
-- Run it in the SAME Supabase project as Saddle. It touches NO Saddle
-- tables: every new table here is prefixed sft_.
-- Safe to run once; create-if-not-exists + drop-policy-if-exists make a
-- re-run harmless (it will not wipe existing rows).

-- ---------------------------------------------------------------
-- 1. Food entries: one row per logged meal/snack/drink
-- ---------------------------------------------------------------
create table if not exists public.sft_food_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  date        date,
  meal        text,
  description text,
  calories    numeric,
  protein     numeric,
  carbs       numeric,
  fat         numeric,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists sft_food_entries_user_date_idx
  on public.sft_food_entries (user_id, date);

-- ---------------------------------------------------------------
-- 2. Sleep nights: one row per night (Garmin-first data, pushed by the
--    assistant after the morning report; never a prescribed bedtime)
-- ---------------------------------------------------------------
create table if not exists public.sft_sleep_nights (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  date         date,
  bedtime      text,
  wake_time    text,
  total_minutes int,
  score        int,
  deep_min     int,
  light_min    int,
  rem_min      int,
  awake_min    int,
  need_min     int,
  training_note text,
  created_at   timestamptz not null default now(),
  unique (user_id, date)
);
create index if not exists sft_sleep_nights_user_date_idx
  on public.sft_sleep_nights (user_id, date);

-- ---------------------------------------------------------------
-- 3. Favorites: one-tap meals saved by the user
-- ---------------------------------------------------------------
create table if not exists public.sft_favorites (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text,
  meal        text,
  description text,
  calories    numeric,
  protein     numeric,
  carbs       numeric,
  fat         numeric,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists sft_favorites_user_idx
  on public.sft_favorites (user_id);

-- ---------------------------------------------------------------
-- 4. Daily burn: total kcal burned per day (Garmin burn, pushed by the
--    assistant; never invented, never reported as zero when unknown)
-- ---------------------------------------------------------------
create table if not exists public.sft_daily_burn (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  date       date,
  total_kcal numeric,
  created_at timestamptz not null default now(),
  unique (user_id, date)
);
create index if not exists sft_daily_burn_user_date_idx
  on public.sft_daily_burn (user_id, date);

-- ---------------------------------------------------------------
-- 5. Weight entries
-- ---------------------------------------------------------------
create table if not exists public.sft_weight_entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  date       date,
  weight_lbs numeric,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists sft_weight_entries_user_date_idx
  on public.sft_weight_entries (user_id, date);

-- ---------------------------------------------------------------
-- 6. Grocery items: the shopping list
-- ---------------------------------------------------------------
create table if not exists public.sft_grocery_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text,
  qty        text,
  checked    boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists sft_grocery_items_user_idx
  on public.sft_grocery_items (user_id);

-- ---------------------------------------------------------------
-- 7. Settings: one row per user (targets the user can change)
-- ---------------------------------------------------------------
create table if not exists public.sft_settings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  protein_g        numeric not null default 160,
  fat_g            numeric not null default 90,
  grocery_target   numeric not null default 250,
  grocery_spent    numeric not null default 0,
  tonight_need_min int not null default 480,
  created_at       timestamptz not null default now(),
  unique (user_id)
);

-- ---------------------------------------------------------------
-- 8. Activities: runs, rides, swims, gym sessions
-- ---------------------------------------------------------------
create table if not exists public.sft_activities (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  date         date,
  title        text,
  type         text,
  distance_km  numeric,
  duration_min numeric,
  avg_hr       numeric,
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists sft_activities_user_date_idx
  on public.sft_activities (user_id, date);

-- ---------------------------------------------------------------
-- 9. Wellness: daily extras such as steps
-- ---------------------------------------------------------------
create table if not exists public.sft_wellness (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  date       date,
  steps      int,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists sft_wellness_user_date_idx
  on public.sft_wellness (user_id, date);

-- ---------------------------------------------------------------
-- 10. Race-morning checklist items
-- ---------------------------------------------------------------
create table if not exists public.sft_race_morning (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  label      text,
  detail     text,
  done       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists sft_race_morning_user_idx
  on public.sft_race_morning (user_id);

-- ---------------------------------------------------------------
-- Row Level Security: same pattern as Saddle — a person can only see
-- and change their own rows. No policies for the anon role, so an
-- anonymous caller can never read or write these tables through the
-- API; only signed-in users (role `authenticated`) with a matching
-- user_id can.
-- ---------------------------------------------------------------
alter table public.sft_food_entries  enable row level security;
alter table public.sft_sleep_nights  enable row level security;
alter table public.sft_favorites     enable row level security;
alter table public.sft_daily_burn    enable row level security;
alter table public.sft_weight_entries enable row level security;
alter table public.sft_grocery_items enable row level security;
alter table public.sft_settings      enable row level security;
alter table public.sft_activities    enable row level security;
alter table public.sft_wellness      enable row level security;
alter table public.sft_race_morning  enable row level security;

-- food_entries
drop policy if exists "food_entries: read own"   on public.sft_food_entries;
drop policy if exists "food_entries: insert own" on public.sft_food_entries;
drop policy if exists "food_entries: update own" on public.sft_food_entries;
drop policy if exists "food_entries: delete own" on public.sft_food_entries;
create policy "food_entries: read own"   on public.sft_food_entries for select to authenticated
  using (auth.uid() = user_id);
create policy "food_entries: insert own" on public.sft_food_entries for insert to authenticated
  with check (auth.uid() = user_id);
create policy "food_entries: update own" on public.sft_food_entries for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "food_entries: delete own" on public.sft_food_entries for delete to authenticated
  using (auth.uid() = user_id);

-- sleep_nights
drop policy if exists "sleep_nights: read own"   on public.sft_sleep_nights;
drop policy if exists "sleep_nights: insert own" on public.sft_sleep_nights;
drop policy if exists "sleep_nights: update own" on public.sft_sleep_nights;
drop policy if exists "sleep_nights: delete own" on public.sft_sleep_nights;
create policy "sleep_nights: read own"   on public.sft_sleep_nights for select to authenticated
  using (auth.uid() = user_id);
create policy "sleep_nights: insert own" on public.sft_sleep_nights for insert to authenticated
  with check (auth.uid() = user_id);
create policy "sleep_nights: update own" on public.sft_sleep_nights for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "sleep_nights: delete own" on public.sft_sleep_nights for delete to authenticated
  using (auth.uid() = user_id);

-- favorites
drop policy if exists "favorites: read own"   on public.sft_favorites;
drop policy if exists "favorites: insert own" on public.sft_favorites;
drop policy if exists "favorites: update own" on public.sft_favorites;
drop policy if exists "favorites: delete own" on public.sft_favorites;
create policy "favorites: read own"   on public.sft_favorites for select to authenticated
  using (auth.uid() = user_id);
create policy "favorites: insert own" on public.sft_favorites for insert to authenticated
  with check (auth.uid() = user_id);
create policy "favorites: update own" on public.sft_favorites for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "favorites: delete own" on public.sft_favorites for delete to authenticated
  using (auth.uid() = user_id);

-- daily_burn
drop policy if exists "daily_burn: read own"   on public.sft_daily_burn;
drop policy if exists "daily_burn: insert own" on public.sft_daily_burn;
drop policy if exists "daily_burn: update own" on public.sft_daily_burn;
drop policy if exists "daily_burn: delete own" on public.sft_daily_burn;
create policy "daily_burn: read own"   on public.sft_daily_burn for select to authenticated
  using (auth.uid() = user_id);
create policy "daily_burn: insert own" on public.sft_daily_burn for insert to authenticated
  with check (auth.uid() = user_id);
create policy "daily_burn: update own" on public.sft_daily_burn for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "daily_burn: delete own" on public.sft_daily_burn for delete to authenticated
  using (auth.uid() = user_id);

-- weight_entries
drop policy if exists "weight_entries: read own"   on public.sft_weight_entries;
drop policy if exists "weight_entries: insert own" on public.sft_weight_entries;
drop policy if exists "weight_entries: update own" on public.sft_weight_entries;
drop policy if exists "weight_entries: delete own" on public.sft_weight_entries;
create policy "weight_entries: read own"   on public.sft_weight_entries for select to authenticated
  using (auth.uid() = user_id);
create policy "weight_entries: insert own" on public.sft_weight_entries for insert to authenticated
  with check (auth.uid() = user_id);
create policy "weight_entries: update own" on public.sft_weight_entries for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "weight_entries: delete own" on public.sft_weight_entries for delete to authenticated
  using (auth.uid() = user_id);

-- grocery_items
drop policy if exists "grocery_items: read own"   on public.sft_grocery_items;
drop policy if exists "grocery_items: insert own" on public.sft_grocery_items;
drop policy if exists "grocery_items: update own" on public.sft_grocery_items;
drop policy if exists "grocery_items: delete own" on public.sft_grocery_items;
create policy "grocery_items: read own"   on public.sft_grocery_items for select to authenticated
  using (auth.uid() = user_id);
create policy "grocery_items: insert own" on public.sft_grocery_items for insert to authenticated
  with check (auth.uid() = user_id);
create policy "grocery_items: update own" on public.sft_grocery_items for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "grocery_items: delete own" on public.sft_grocery_items for delete to authenticated
  using (auth.uid() = user_id);

-- settings
drop policy if exists "settings: read own"   on public.sft_settings;
drop policy if exists "settings: insert own" on public.sft_settings;
drop policy if exists "settings: update own" on public.sft_settings;
drop policy if exists "settings: delete own" on public.sft_settings;
create policy "settings: read own"   on public.sft_settings for select to authenticated
  using (auth.uid() = user_id);
create policy "settings: insert own" on public.sft_settings for insert to authenticated
  with check (auth.uid() = user_id);
create policy "settings: update own" on public.sft_settings for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "settings: delete own" on public.sft_settings for delete to authenticated
  using (auth.uid() = user_id);

-- activities
drop policy if exists "activities: read own"   on public.sft_activities;
drop policy if exists "activities: insert own" on public.sft_activities;
drop policy if exists "activities: update own" on public.sft_activities;
drop policy if exists "activities: delete own" on public.sft_activities;
create policy "activities: read own"   on public.sft_activities for select to authenticated
  using (auth.uid() = user_id);
create policy "activities: insert own" on public.sft_activities for insert to authenticated
  with check (auth.uid() = user_id);
create policy "activities: update own" on public.sft_activities for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "activities: delete own" on public.sft_activities for delete to authenticated
  using (auth.uid() = user_id);

-- wellness
drop policy if exists "wellness: read own"   on public.sft_wellness;
drop policy if exists "wellness: insert own" on public.sft_wellness;
drop policy if exists "wellness: update own" on public.sft_wellness;
drop policy if exists "wellness: delete own" on public.sft_wellness;
create policy "wellness: read own"   on public.sft_wellness for select to authenticated
  using (auth.uid() = user_id);
create policy "wellness: insert own" on public.sft_wellness for insert to authenticated
  with check (auth.uid() = user_id);
create policy "wellness: update own" on public.sft_wellness for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "wellness: delete own" on public.sft_wellness for delete to authenticated
  using (auth.uid() = user_id);

-- race_morning
drop policy if exists "race_morning: read own"   on public.sft_race_morning;
drop policy if exists "race_morning: insert own" on public.sft_race_morning;
drop policy if exists "race_morning: update own" on public.sft_race_morning;
drop policy if exists "race_morning: delete own" on public.sft_race_morning;
create policy "race_morning: read own"   on public.sft_race_morning for select to authenticated
  using (auth.uid() = user_id);
create policy "race_morning: insert own" on public.sft_race_morning for insert to authenticated
  with check (auth.uid() = user_id);
create policy "race_morning: update own" on public.sft_race_morning for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "race_morning: delete own" on public.sft_race_morning for delete to authenticated
  using (auth.uid() = user_id);
