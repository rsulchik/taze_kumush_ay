-- Колонка «количество на складе» + обновление кэша API
ALTER TABLE public.products
ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1 CHECK (quantity >= 0);

UPDATE public.products
SET quantity = COALESCE(
  NULLIF(quantity, 0),
  NULLIF(price_per_gram::integer, 0),
  1
);

NOTIFY pgrst, 'reload schema';
