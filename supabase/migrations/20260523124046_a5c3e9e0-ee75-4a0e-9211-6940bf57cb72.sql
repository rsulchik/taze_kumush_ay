
-- Categories
CREATE TABLE public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Products (jewelry items)
CREATE TABLE public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  sku text NOT NULL UNIQUE,
  category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  size numeric,
  metal_type text NOT NULL CHECK (metal_type IN ('Золото','Серебро','Платина','Палладий')),
  assay integer NOT NULL,
  total_weight numeric NOT NULL,
  metal_weight numeric NOT NULL,
  price_per_gram numeric,
  cost_price numeric,
  sale_price numeric NOT NULL,
  status text NOT NULL DEFAULT 'в наличии' CHECK (status IN ('в наличии','продано','на реставрации','списано')),
  image_url text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_category ON public.products(category_id);
CREATE INDEX idx_products_status ON public.products(status);

-- Gemstones
CREATE TABLE public.gemstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  stone_name text NOT NULL,
  carat_weight numeric NOT NULL,
  cut_type text,
  quantity integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_gemstones_product ON public.gemstones(product_id);

-- Transactions
CREATE TABLE public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES public.products(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('sale','consignment','return','write-off')),
  final_price numeric NOT NULL,
  employee_name text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_transactions_type ON public.transactions(type);
CREATE INDEX idx_transactions_created ON public.transactions(created_at);

-- Enable RLS, open access (internal tool / demo). Users can later restrict by adding auth.
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gemstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public all categories" ON public.categories FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public all products" ON public.products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public all gemstones" ON public.gemstones FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "public all transactions" ON public.transactions FOR ALL USING (true) WITH CHECK (true);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER trg_products_updated
BEFORE UPDATE ON public.products
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
