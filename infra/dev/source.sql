CREATE TABLE IF NOT EXISTS public.orders (
  id BIGINT PRIMARY KEY,
  customer TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO public.orders (id, customer, amount, created_at) VALUES
  (101, 'Northwind', 129.90, '2026-09-29 09:00:00+00'),
  (102, 'Acme', 74.50, '2026-09-29 10:30:00+00'),
  (103, 'Globex', 420.00, '2026-09-29 12:15:00+00'),
  (104, 'Umbrella', 18.25, '2026-09-29 14:45:00+00')
ON CONFLICT (id) DO NOTHING;
