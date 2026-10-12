-- Public bucket for product photos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "product_images_public_read" ON storage.objects;
DROP POLICY IF EXISTS "product_images_public_insert" ON storage.objects;
DROP POLICY IF EXISTS "product_images_public_update" ON storage.objects;
DROP POLICY IF EXISTS "product_images_public_delete" ON storage.objects;

CREATE POLICY "product_images_public_read"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'product-images');

CREATE POLICY "product_images_public_insert"
ON storage.objects FOR INSERT
TO public
WITH CHECK (bucket_id = 'product-images');

CREATE POLICY "product_images_public_update"
ON storage.objects FOR UPDATE
TO public
USING (bucket_id = 'product-images');

CREATE POLICY "product_images_public_delete"
ON storage.objects FOR DELETE
TO public
USING (bucket_id = 'product-images');
