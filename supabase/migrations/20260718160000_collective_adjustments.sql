alter table public.photo_versions
  add column if not exists adjustments jsonb not null default '{}'::jsonb;
