import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReadQuery } from '../apps/server/src/connectors.ts';

test('accepts a single read query', () => {
  assert.equal(assertReadQuery(' SELECT * FROM public.orders; '), 'SELECT * FROM public.orders');
  assert.equal(assertReadQuery('WITH recent AS (SELECT 1) SELECT * FROM recent'), 'WITH recent AS (SELECT 1) SELECT * FROM recent');
});

test('rejects mutations and multiple statements before contacting a source', () => {
  for (const sql of ['DELETE FROM orders', 'DROP TABLE orders', 'SELECT 1; DELETE FROM orders']) {
    assert.throws(() => assertReadQuery(sql));
  }
});
