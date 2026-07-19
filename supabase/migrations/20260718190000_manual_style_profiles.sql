alter table public.style_profiles
  drop constraint if exists style_profiles_reference_photo_ids_check;

alter table public.style_profiles
  add constraint style_profiles_reference_photo_ids_check
  check (
    cardinality(reference_photo_ids) = 0
    or cardinality(reference_photo_ids) between 3 and 8
  );

comment on column public.style_profiles.reference_photo_ids is
  'Empty for presets saved from manual edits; three to eight IDs for legacy generated Looks.';
