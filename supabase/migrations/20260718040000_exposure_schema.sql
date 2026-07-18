create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  skill_level text not null default 'enthusiast' check (skill_level in ('beginner', 'enthusiast', 'professional')),
  feedback_detail text not null default 'detailed' check (feedback_detail in ('concise', 'detailed')),
  desired_mood text,
  export_metadata boolean not null default true,
  export_gps boolean not null default false,
  recommendation_feedback jsonb not null default '{"accepted":[],"rejected":[]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  original_path text not null,
  original_name text not null,
  original_mime_type text not null check (original_mime_type in ('image/jpeg', 'image/png', 'image/heic', 'image/heif')),
  original_byte_size bigint not null check (original_byte_size > 0),
  original_checksum text not null,
  capture_source text not null check (capture_source in ('camera', 'library', 'document', 'usb')),
  width integer check (width > 0),
  height integer check (height > 0),
  exif jsonb not null default '{}'::jsonb,
  current_version_id uuid,
  sync_state text not null default 'queued' check (sync_state in ('local', 'queued', 'syncing', 'synced', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, original_checksum)
);

create table public.photo_versions (
  id uuid primary key default gen_random_uuid(),
  photo_id uuid not null references public.photos(id) on delete cascade,
  parent_version_id uuid references public.photo_versions(id),
  restored_from_version_id uuid references public.photo_versions(id),
  label text not null,
  canvas_transform jsonb not null,
  layer_stack jsonb not null,
  analysis_proxy_path text,
  thumbnail_path text,
  preview_render_path text,
  export_render_path text,
  schema_version integer not null default 1,
  created_at timestamptz not null default now(),
  constraint photo_versions_layer_stack_is_array check (jsonb_typeof(layer_stack) = 'array'),
  constraint photo_versions_canvas_is_object check (jsonb_typeof(canvas_transform) = 'object')
);

alter table public.photos
  add constraint photos_current_version_fkey
  foreign key (current_version_id) references public.photo_versions(id)
  deferrable initially deferred;

create table public.layer_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  photo_id uuid not null references public.photos(id) on delete cascade,
  kind text not null check (kind in ('mask', 'donor_patch', 'imported_image', 'generated_patch')),
  storage_path text not null,
  checksum text not null,
  mime_type text not null,
  width integer check (width > 0),
  height integer check (height > 0),
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (owner_id, checksum, kind)
);

create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  photo_id uuid not null references public.photos(id) on delete cascade,
  version_id uuid not null references public.photo_versions(id) on delete cascade,
  checksum text not null,
  schema_version text not null,
  deterministic_model text not null,
  semantic_model text,
  metrics jsonb not null,
  subjects jsonb not null default '[]'::jsonb,
  lighting jsonb not null,
  composition jsonb not null default '{}'::jsonb,
  color jsonb not null default '{}'::jsonb,
  camera_recommendations jsonb not null default '[]'::jsonb,
  issues jsonb not null default '[]'::jsonb,
  summary text not null,
  created_at timestamptz not null default now(),
  unique (version_id, checksum, schema_version, deterministic_model, semantic_model)
);

create table public.style_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  reference_photo_ids uuid[] not null check (cardinality(reference_photo_ids) between 3 and 8),
  palette jsonb not null,
  adjustments jsonb not null,
  mood text not null,
  model_versions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.portfolio_reviews (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  selected_photo_ids uuid[] not null check (cardinality(selected_photo_ids) between 2 and 20),
  ordered_photo_ids uuid[] not null,
  excluded_photo_ids uuid[] not null default '{}',
  duplicate_groups jsonb not null default '[]'::jsonb,
  explanations jsonb not null default '{}'::jsonb,
  summary text not null,
  created_at timestamptz not null default now()
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  photo_id uuid references public.photos(id) on delete cascade,
  idempotency_key text not null,
  operation text not null check (operation in ('analyze', 'render', 'generative', 'portfolio_review', 'style_profile', 'style_apply')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  progress real not null default 0 check (progress between 0 and 1),
  request jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (owner_id, idempotency_key)
);

create index photos_owner_created_idx on public.photos(owner_id, created_at desc);
create index photo_versions_photo_created_idx on public.photo_versions(photo_id, created_at desc);
create index layer_assets_photo_idx on public.layer_assets(photo_id);
create index analyses_photo_version_idx on public.analyses(photo_id, version_id);
create index jobs_owner_status_idx on public.jobs(owner_id, status, created_at desc);

create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger photos_set_updated_at before update on public.photos for each row execute function public.set_updated_at();
create trigger style_profiles_set_updated_at before update on public.style_profiles for each row execute function public.set_updated_at();
create trigger jobs_set_updated_at before update on public.jobs for each row execute function public.set_updated_at();

create or replace function public.protect_photo_original()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id is distinct from old.owner_id
    or new.original_path is distinct from old.original_path
    or new.original_name is distinct from old.original_name
    or new.original_mime_type is distinct from old.original_mime_type
    or new.original_byte_size is distinct from old.original_byte_size
    or new.original_checksum is distinct from old.original_checksum
    or new.capture_source is distinct from old.capture_source
    or new.width is distinct from old.width
    or new.height is distinct from old.height
    or new.exif is distinct from old.exif
  then
    raise exception 'Exposure originals and their metadata are immutable';
  end if;
  return new;
end;
$$;

create trigger photos_protect_original before update on public.photos for each row execute function public.protect_photo_original();

alter table public.profiles enable row level security;
alter table public.photos enable row level security;
alter table public.photo_versions enable row level security;
alter table public.layer_assets enable row level security;
alter table public.analyses enable row level security;
alter table public.style_profiles enable row level security;
alter table public.portfolio_reviews enable row level security;
alter table public.jobs enable row level security;

create policy profiles_select_own on public.profiles for select using ((select auth.uid()) = id);
create policy profiles_insert_own on public.profiles for insert with check ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles for update using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy photos_select_own on public.photos for select using ((select auth.uid()) = owner_id);
create policy photos_insert_own on public.photos for insert with check ((select auth.uid()) = owner_id);
create policy photos_update_own on public.photos for update using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy photos_delete_own on public.photos for delete using ((select auth.uid()) = owner_id);

create policy photo_versions_select_own on public.photo_versions for select using (exists (select 1 from public.photos where photos.id = photo_versions.photo_id and photos.owner_id = (select auth.uid())));
create policy photo_versions_insert_own on public.photo_versions for insert with check (exists (select 1 from public.photos where photos.id = photo_versions.photo_id and photos.owner_id = (select auth.uid())));

create policy layer_assets_select_own on public.layer_assets for select using ((select auth.uid()) = owner_id);
create policy layer_assets_insert_own on public.layer_assets for insert with check ((select auth.uid()) = owner_id and exists (select 1 from public.photos where photos.id = layer_assets.photo_id and photos.owner_id = (select auth.uid())));
create policy layer_assets_delete_own on public.layer_assets for delete using ((select auth.uid()) = owner_id);

create policy analyses_select_own on public.analyses for select using ((select auth.uid()) = owner_id);
create policy analyses_insert_own on public.analyses for insert with check ((select auth.uid()) = owner_id and exists (select 1 from public.photos where photos.id = analyses.photo_id and photos.owner_id = (select auth.uid())));

create policy style_profiles_select_own on public.style_profiles for select using ((select auth.uid()) = owner_id);
create policy style_profiles_insert_own on public.style_profiles for insert with check ((select auth.uid()) = owner_id);
create policy style_profiles_update_own on public.style_profiles for update using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy style_profiles_delete_own on public.style_profiles for delete using ((select auth.uid()) = owner_id);

create policy portfolio_reviews_select_own on public.portfolio_reviews for select using ((select auth.uid()) = owner_id);
create policy portfolio_reviews_insert_own on public.portfolio_reviews for insert with check ((select auth.uid()) = owner_id);
create policy portfolio_reviews_delete_own on public.portfolio_reviews for delete using ((select auth.uid()) = owner_id);

create policy jobs_select_own on public.jobs for select using ((select auth.uid()) = owner_id);
create policy jobs_insert_own on public.jobs for insert with check ((select auth.uid()) = owner_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('originals', 'originals', false, 52428800, array['image/jpeg', 'image/png', 'image/heic', 'image/heif']),
  ('derived', 'derived', false, 52428800, array['image/jpeg', 'image/png']),
  ('layer-assets', 'layer-assets', false, 52428800, array['image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy storage_select_own on storage.objects for select using (bucket_id in ('originals', 'derived', 'layer-assets') and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy storage_insert_own on storage.objects for insert with check (bucket_id in ('originals', 'derived', 'layer-assets') and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy storage_update_own on storage.objects for update using (bucket_id in ('derived', 'layer-assets') and (storage.foldername(name))[1] = (select auth.uid())::text) with check (bucket_id in ('derived', 'layer-assets') and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy storage_delete_own on storage.objects for delete using (bucket_id in ('derived', 'layer-assets') and (storage.foldername(name))[1] = (select auth.uid())::text);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jobs'
  ) then
    alter publication supabase_realtime add table public.jobs;
  end if;
end;
$$;
