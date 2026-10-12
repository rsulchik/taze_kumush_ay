-- Performance indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_products_created_at ON public.products(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_sku ON public.products(sku);
CREATE INDEX IF NOT EXISTS idx_products_title ON public.products(title);
CREATE INDEX IF NOT EXISTS idx_products_status_created ON public.products(status, created_at DESC);
