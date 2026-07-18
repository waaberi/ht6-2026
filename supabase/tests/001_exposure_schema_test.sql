begin;
select plan(23);

select has_table('public', 'profiles', 'profiles table exists');
select has_table('public', 'photos', 'photos table exists');
select has_table('public', 'photo_versions', 'photo versions table exists');
select has_table('public', 'layer_assets', 'layer assets table exists');
select has_table('public', 'analyses', 'analyses table exists');
select has_table('public', 'style_profiles', 'style profiles table exists');
select has_table('public', 'portfolio_reviews', 'portfolio reviews table exists');
select has_table('public', 'jobs', 'jobs table exists');

select policies_are('public', 'profiles', array['profiles_insert_own', 'profiles_select_own', 'profiles_update_own']);
select policies_are('public', 'photos', array['photos_delete_own', 'photos_insert_own', 'photos_select_own', 'photos_update_own']);
select policies_are('public', 'photo_versions', array['photo_versions_insert_own', 'photo_versions_select_own']);
select policies_are('public', 'layer_assets', array['layer_assets_delete_own', 'layer_assets_insert_own', 'layer_assets_select_own']);
select policies_are('public', 'analyses', array['analyses_insert_own', 'analyses_select_own']);
select policies_are('public', 'style_profiles', array['style_profiles_delete_own', 'style_profiles_insert_own', 'style_profiles_select_own', 'style_profiles_update_own']);
select policies_are('public', 'portfolio_reviews', array['portfolio_reviews_delete_own', 'portfolio_reviews_insert_own', 'portfolio_reviews_select_own']);
select policies_are('public', 'jobs', array['jobs_insert_own', 'jobs_select_own']);

select is((select relrowsecurity from pg_class where oid = 'public.photos'::regclass), true, 'photos has RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.photo_versions'::regclass), true, 'photo versions have RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.layer_assets'::regclass), true, 'layer assets have RLS enabled');
select is((select relrowsecurity from pg_class where oid = 'public.analyses'::regclass), true, 'analyses have RLS enabled');
select has_trigger('public', 'photos', 'photos_protect_original', 'photo originals have an immutable-field trigger');
select has_fk('public', 'photos', 'photos_current_version_fkey');
select col_is_unique('public', 'jobs', array['owner_id', 'idempotency_key']);

select * from finish();
rollback;
