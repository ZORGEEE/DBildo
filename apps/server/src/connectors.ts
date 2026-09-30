import pg from 'pg';
import { config } from './config.ts';

export type Source = 'postgres' | 'clickhouse';
export type QueryResult = { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; durationMs: number; queryId?: string };
export type Asset = { id: string; source: Source; database: string; schema: string; name: string; kind: string; rowCount?: number };

const pool = new pg.Pool({ connectionString: config.postgresUrl, connectionTimeoutMillis: 2500, max: 4 });

function url(base: string, path = '') { return `${base.replace(/\/$/, '')}${path}`; }

function clickhouseHeaders() {
  return {
    'X-ClickHouse-User': config.clickhouseUser,
    'X-ClickHouse-Key': config.clickhousePassword
  };
}

async function chQuery(sql: string, timeoutMs = 5000) {
  const endpoint = new URL(url(config.clickhouseUrl, '/'));
  endpoint.searchParams.set('query', sql);
  endpoint.searchParams.set('max_execution_time', String(Math.ceil(timeoutMs / 1000)));
  const response = await fetch(endpoint, { headers: clickhouseHeaders(), signal: AbortSignal.timeout(timeoutMs + 1000) });
  if (!response.ok) throw new Error(`ClickHouse ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.text();
}

export async function probeSources() {
  const [postgres, clickhouse] = await Promise.allSettled([
    pool.query('SELECT 1'), chQuery('SELECT 1')
  ]);
  return {
    postgres: { online: postgres.status === 'fulfilled', error: postgres.status === 'rejected' ? String(postgres.reason) : undefined },
    clickhouse: { online: clickhouse.status === 'fulfilled', error: clickhouse.status === 'rejected' ? String(clickhouse.reason) : undefined }
  };
}

export async function catalog(source: Source): Promise<Asset[]> {
  if (source === 'postgres') {
    const result = await pool.query(`SELECT current_database() AS database, table_schema AS schema, table_name AS name, table_type AS kind
      FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name LIMIT 1000`);
    return result.rows.map((row) => ({ ...row, source, id: `postgres:${row.database}.${row.schema}.${row.name}` }));
  }
  const raw = await chQuery(`SELECT database, '' AS schema, name, engine AS kind FROM system.tables WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA') ORDER BY database, name LIMIT 1000 FORMAT JSON`);
  const data = JSON.parse(raw) as { data: { database: string; schema: string; name: string; kind: string }[] };
  return data.data.map((row) => ({ ...row, source, id: `clickhouse:${row.database}.${row.name}` }));
}

export async function describe(source: Source, database: string, schema: string, name: string) {
  if (source === 'postgres') {
    const result = await pool.query(`SELECT column_name AS name, data_type AS type, is_nullable AS nullable, ordinal_position AS position
      FROM information_schema.columns WHERE table_catalog=$1 AND table_schema=$2 AND table_name=$3 ORDER BY ordinal_position`, [database, schema, name]);
    return { columns: result.rows };
  }
  const endpoint = new URL(url(config.clickhouseUrl, '/'));
  endpoint.searchParams.set('param_database', database);
  endpoint.searchParams.set('param_table', name);
  endpoint.searchParams.set('query', 'SELECT name, type, position FROM system.columns WHERE database={database:String} AND table={table:String} ORDER BY position FORMAT JSON');
  const response = await fetch(endpoint, {
    headers: clickhouseHeaders(),
    signal: AbortSignal.timeout(6000)
  });
  if (!response.ok) throw new Error(`ClickHouse ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return { columns: (await response.json() as { data: unknown[] }).data };
}

export function assertReadQuery(sql: string) {
  const cleaned = sql.trim().replace(/;\s*$/, '');
  if (!/^(select|with|show|explain|describe|desc)\b/i.test(cleaned) || /;/.test(cleaned)) {
    throw new Error('В этой версии разрешён один запрос чтения (SELECT, WITH, SHOW, EXPLAIN или DESCRIBE)');
  }
  if (cleaned.length > 100_000) throw new Error('Запрос слишком большой');
  return cleaned;
}

export async function execute(source: Source, sql: string, maxRows = 200): Promise<QueryResult> {
  const query = assertReadQuery(sql);
  const limit = Math.max(1, Math.min(1000, Math.trunc(maxRows)));
  const start = Date.now();
  if (source === 'postgres') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL statement_timeout = 30000');
      let result;
      if (/^(select|with)\b/i.test(query)) {
        await client.query(`DECLARE dbildo_result_cursor NO SCROLL CURSOR FOR ${query}`);
        result = await client.query(`FETCH FORWARD ${limit + 1} FROM dbildo_result_cursor`);
      } else {
        result = await client.query(query);
      }
      await client.query('COMMIT');
      return { columns: result.fields.map((field) => field.name), rows: result.rows.slice(0, limit), rowCount: result.rows.length, truncated: result.rows.length > limit, durationMs: Date.now() - start };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  const queryId = crypto.randomUUID();
  const endpoint = new URL(url(config.clickhouseUrl, '/'));
  endpoint.searchParams.set('max_execution_time', '30');
  endpoint.searchParams.set('max_result_rows', String(limit + 1));
  endpoint.searchParams.set('result_overflow_mode', 'break');
  endpoint.searchParams.set('query_id', queryId);
  endpoint.searchParams.set('query', `${query} FORMAT JSON`);
  const response = await fetch(endpoint, {
    headers: clickhouseHeaders(), signal: AbortSignal.timeout(32000)
  });
  if (!response.ok) throw new Error(`ClickHouse ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const result = await response.json() as { meta?: { name: string }[]; data?: Record<string, unknown>[]; rows?: number };
  const rows = result.data || [];
  return { columns: result.meta?.map((column) => column.name) || Object.keys(rows[0] || {}), rows: rows.slice(0, limit), rowCount: result.rows ?? rows.length, truncated: rows.length > limit, durationMs: Date.now() - start, queryId };
}

export async function closeSources() { await pool.end(); }
