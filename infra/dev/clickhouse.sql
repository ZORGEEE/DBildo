CREATE TABLE IF NOT EXISTS default.orders (
  id UInt64,
  customer String,
  amount Decimal(12, 2),
  created_at DateTime('UTC')
) ENGINE = ReplacingMergeTree ORDER BY id;
