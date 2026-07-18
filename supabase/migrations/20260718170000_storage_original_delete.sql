drop policy if exists storage_delete_own on storage.objects;

create policy storage_delete_own
on storage.objects
for delete
using (
  bucket_id in ('originals', 'derived', 'layer-assets')
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
