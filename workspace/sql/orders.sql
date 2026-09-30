-- Источник
SELECT id, customer, amount, created_at
FROM public.orders
ORDER BY id;

-- В ClickHouse выберите подключение ClickHouse и выполните:
-- SELECT * FROM default.orders FINAL ORDER BY id;
