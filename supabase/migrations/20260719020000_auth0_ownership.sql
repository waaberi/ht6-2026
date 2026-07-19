-- Auth0 subject identifiers are strings such as `auth0|...` and
-- `google-oauth2|...`, while Supabase Auth subjects happen to be UUID strings.
-- Store both forms as text and authorize directly from the verified JWT `sub`.

drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists photos_select_own on public.photos;
drop policy if exists photos_insert_own on public.photos;
drop policy if exists photos_update_own on public.photos;
drop policy if exists photos_delete_own on public.photos;
drop policy if exists photo_versions_select_own on public.photo_versions;
drop policy if exists photo_versions_insert_own on public.photo_versions;
drop policy if exists layer_assets_select_own on public.layer_assets;
drop policy if exists layer_assets_insert_own on public.layer_assets;
drop policy if exists layer_assets_delete_own on public.layer_assets;
drop policy if exists analyses_select_own on public.analyses;
drop policy if exists analyses_insert_own on public.analyses;
drop policy if exists style_profiles_select_own on public.style_profiles;
drop policy if exists style_profiles_insert_own on public.style_profiles;
drop policy if exists style_profiles_update_own on public.style_profiles;
drop policy if exists style_profiles_delete_own on public.style_profiles;
drop policy if exists portfolio_reviews_select_own on public.portfolio_reviews;
drop policy if exists portfolio_reviews_insert_own on public.portfolio_reviews;
drop policy if exists portfolio_reviews_delete_own on public.portfolio_reviews;
drop policy if exists jobs_select_own on public.jobs;
drop policy if exists jobs_insert_own on public.jobs;
drop policy if exists storage_select_own on storage.objects;
drop policy if exists storage_insert_own on storage.objects;
drop policy if exists storage_update_own on storage.objects;
drop policy if exists storage_delete_own on storage.objects;

alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.photos drop constraint if exists photos_owner_id_fkey;
alter table public.layer_assets drop constraint if exists layer_assets_owner_id_fkey;
alter table public.analyses drop constraint if exists analyses_owner_id_fkey;
alter table public.style_profiles drop constraint if exists style_profiles_owner_id_fkey;
alter table public.portfolio_reviews drop constraint if exists portfolio_reviews_owner_id_fkey;
alter table public.jobs drop constraint if exists jobs_owner_id_fkey;

alter table public.profiles alter column id type text using id::text;
alter table public.photos alter column owner_id type text using owner_id::text;
alter table public.layer_assets alter column owner_id type text using owner_id::text;
alter table public.analyses alter column owner_id type text using owner_id::text;
alter table public.style_profiles alter column owner_id type text using owner_id::text;
alter table public.portfolio_reviews alter column owner_id type text using owner_id::text;
alter table public.jobs alter column owner_id type text using owner_id::text;

create or replace function public.request_user_id()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'sub', '');
$$;

revoke all on function public.request_user_id() from public;
grant execute on function public.request_user_id() to anon, authenticated;

-- RLS filters rows, while table privileges allow authenticated clients to
-- reach those policies through PostgREST. Granting a verb does not bypass a
-- missing policy, so immutable/history tables remain restricted as defined
-- below.
grant select, insert, update, delete on table
  public.profiles,
  public.photos,
  public.photo_versions,
  public.layer_assets,
  public.analyses,
  public.style_profiles,
  public.portfolio_reviews,
  public.jobs
to authenticated;

create policy profiles_select_own on public.profiles for select using ((select public.request_user_id()) = id);
create policy profiles_insert_own on public.profiles for insert with check ((select public.request_user_id()) = id);
create policy profiles_update_own on public.profiles for update using ((select public.request_user_id()) = id) with check ((select public.request_user_id()) = id);

create policy photos_select_own on public.photos for select using ((select public.request_user_id()) = owner_id);
create policy photos_insert_own on public.photos for insert with check ((select public.request_user_id()) = owner_id);
create policy photos_update_own on public.photos for update using ((select public.request_user_id()) = owner_id) with check ((select public.request_user_id()) = owner_id);
create policy photos_delete_own on public.photos for delete using ((select public.request_user_id()) = owner_id);

create policy photo_versions_select_own on public.photo_versions for select using (exists (select 1 from public.photos where photos.id = photo_versions.photo_id and photos.owner_id = (select public.request_user_id())));
create policy photo_versions_insert_own on public.photo_versions for insert with check (exists (select 1 from public.photos where photos.id = photo_versions.photo_id and photos.owner_id = (select public.request_user_id())));

create policy layer_assets_select_own on public.layer_assets for select using ((select public.request_user_id()) = owner_id);
create policy layer_assets_insert_own on public.layer_assets for insert with check ((select public.request_user_id()) = owner_id and exists (select 1 from public.photos where photos.id = layer_assets.photo_id and photos.owner_id = (select public.request_user_id())));
create policy layer_assets_delete_own on public.layer_assets for delete using ((select public.request_user_id()) = owner_id);

create policy analyses_select_own on public.analyses for select using ((select public.request_user_id()) = owner_id);
create policy analyses_insert_own on public.analyses for insert with check ((select public.request_user_id()) = owner_id and exists (select 1 from public.photos where photos.id = analyses.photo_id and photos.owner_id = (select public.request_user_id())));

create policy style_profiles_select_own on public.style_profiles for select using ((select public.request_user_id()) = owner_id);
create policy style_profiles_insert_own on public.style_profiles for insert with check ((select public.request_user_id()) = owner_id);
create policy style_profiles_update_own on public.style_profiles for update using ((select public.request_user_id()) = owner_id) with check ((select public.request_user_id()) = owner_id);
create policy style_profiles_delete_own on public.style_profiles for delete using ((select public.request_user_id()) = owner_id);

create policy portfolio_reviews_select_own on public.portfolio_reviews for select using ((select public.request_user_id()) = owner_id);
create policy portfolio_reviews_insert_own on public.portfolio_reviews for insert with check ((select public.request_user_id()) = owner_id);
create policy portfolio_reviews_delete_own on public.portfolio_reviews for delete using ((select public.request_user_id()) = owner_id);

create policy jobs_select_own on public.jobs for select using ((select public.request_user_id()) = owner_id);
create policy jobs_insert_own on public.jobs for insert with check ((select public.request_user_id()) = owner_id);

create policy storage_select_own on storage.objects for select using (
  bucket_id in ('originals', 'derived', 'layer-assets')
  and (storage.foldername(name))[1] = (select public.request_user_id())
);
create policy storage_insert_own on storage.objects for insert with check (
  bucket_id in ('originals', 'derived', 'layer-assets')
  and (storage.foldername(name))[1] = (select public.request_user_id())
);
create policy storage_update_own on storage.objects for update using (
  bucket_id in ('derived', 'layer-assets')
  and (storage.foldername(name))[1] = (select public.request_user_id())
) with check (
  bucket_id in ('derived', 'layer-assets')
  and (storage.foldername(name))[1] = (select public.request_user_id())
);
create policy storage_delete_own on storage.objects for delete using (
  bucket_id in ('originals', 'derived', 'layer-assets')
  and (storage.foldername(name))[1] = (select public.request_user_id())
);
