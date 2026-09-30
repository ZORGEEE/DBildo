import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { agentAvailable, agentToken, closeAgent, runAgent } from './agent.ts';
import { dagGraph, dags, probeAirflow, runDetails, setDagPaused, taskLog, triggerDag } from './airflow.ts';
import { catalog, closeSources, describe, execute, probeSources, type Source } from './connectors.ts';
import { config, projectRoot } from './config.ts';

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function fail(res: ServerResponse, error: unknown, status = 500) {
  json(res, status, { error: error instanceof Error ? error.message : String(error) });
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Слишком большой запрос');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}

function source(value: unknown): Source {
  if (value !== 'postgres' && value !== 'clickhouse') throw new Error('Выберите PostgreSQL или ClickHouse');
  return value;
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Нужно указать ${name}`);
  return value;
}

function workspaceFile(raw: string) {
  const base = path.join(projectRoot, 'workspace');
  const full = path.resolve(base, raw);
  if (!full.startsWith(base + path.sep) || !/\.(sql|py|md)$/.test(full)) throw new Error('Недопустимый путь файла');
  return full;
}

async function files() {
  const base = path.join(projectRoot, 'workspace');
  const result: string[] = [];
  for (const dir of ['dags', 'sql', 'tests']) {
    for (const entry of await fs.readdir(path.join(base, dir), { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && /\.(py|sql|md)$/.test(entry.name)) result.push(`${dir}/${entry.name}`);
    }
  }
  return result;
}

async function api(req: IncomingMessage, res: ServerResponse, u: URL) {
  if (u.pathname === '/health') return json(res, 200, { ok: true });
  if (u.pathname === '/api/status' && req.method === 'GET') {
    const [sources, airflow] = await Promise.all([probeSources(), probeAirflow()]);
    return json(res, 200, { sources, airflow, agent: { configured: agentAvailable() } });
  }
  if (u.pathname === '/api/catalog' && req.method === 'GET') return json(res, 200, await catalog(source(u.searchParams.get('source'))));
  if (u.pathname === '/api/describe' && req.method === 'GET') {
    return json(res, 200, await describe(source(u.searchParams.get('source')), text(u.searchParams.get('database'), 'database'), u.searchParams.get('schema') || '', text(u.searchParams.get('name'), 'name')));
  }
  if (u.pathname === '/api/query' && req.method === 'POST') {
    const input = await body(req);
    return json(res, 200, await execute(source(input.source), text(input.sql, 'SQL'), 200));
  }
  if (u.pathname === '/api/dags' && req.method === 'GET') return json(res, 200, await dags());
  if (u.pathname === '/api/lineage' && req.method === 'GET') return json(res, 200, JSON.parse(await fs.readFile(path.join(projectRoot, 'workspace', 'lineage.json'), 'utf8')));
  const graph = /^\/api\/dags\/([^/]+)\/graph$/.exec(u.pathname);
  if (graph && req.method === 'GET') return json(res, 200, await dagGraph(decodeURIComponent(graph[1])));
  const trigger = /^\/api\/dags\/([^/]+)\/trigger$/.exec(u.pathname);
  if (trigger && req.method === 'POST') return json(res, 200, await triggerDag(decodeURIComponent(trigger[1])));
  const pause = /^\/api\/dags\/([^/]+)\/paused$/.exec(u.pathname);
  if (pause && req.method === 'PUT') {
    const input = await body(req);
    if (typeof input.paused !== 'boolean') throw new Error('paused должен быть boolean');
    return json(res, 200, await setDagPaused(decodeURIComponent(pause[1]), input.paused));
  }
  const run = /^\/api\/dags\/([^/]+)\/runs\/([^/]+)$/.exec(u.pathname);
  if (run && req.method === 'GET') return json(res, 200, await runDetails(decodeURIComponent(run[1]), decodeURIComponent(run[2])));
  const log = /^\/api\/dags\/([^/]+)\/runs\/([^/]+)\/tasks\/([^/]+)\/logs$/.exec(u.pathname);
  if (log && req.method === 'GET') return json(res, 200, await taskLog(decodeURIComponent(log[1]), decodeURIComponent(log[2]), decodeURIComponent(log[3]), Number(u.searchParams.get('try') || 1)));
  if (u.pathname === '/api/files' && req.method === 'GET') return json(res, 200, await files());
  if (u.pathname === '/api/file' && req.method === 'GET') {
    const file = workspaceFile(text(u.searchParams.get('path'), 'path'));
    const content = await fs.readFile(file, 'utf8');
    return json(res, 200, { path: u.searchParams.get('path'), content, hash: crypto.createHash('sha256').update(content).digest('hex') });
  }
  if (u.pathname === '/api/file' && req.method === 'PUT') {
    const input = await body(req);
    const file = workspaceFile(text(input.path, 'path'));
    const content = text(input.content, 'content');
    const before = await fs.readFile(file, 'utf8');
    const hash = crypto.createHash('sha256').update(before).digest('hex');
    if (hash !== input.hash) return fail(res, 'Файл изменён вне редактора; перечитайте его перед сохранением', 409);
    await fs.writeFile(file, content);
    return json(res, 200, { hash: crypto.createHash('sha256').update(content).digest('hex') });
  }
  if (u.pathname === '/api/publish-dev' && req.method === 'POST') {
    const input = await body(req);
    const relative = text(input.path, 'path');
    if (!/^dags\/[A-Za-z0-9_\-]+\.py$/.test(relative)) throw new Error('Публиковать можно только Python DAG из workspace/dags');
    const from = workspaceFile(relative);
    const content = await fs.readFile(from);
    const actualHash = crypto.createHash('sha256').update(content).digest('hex');
    if (input.hash !== actualHash) return fail(res, 'Файл изменился; сохраните его перед публикацией', 409);
    const target = path.join(projectRoot, 'runtime', 'airflow', 'dags', path.basename(from));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    return json(res, 200, { path: relative, hash: actualHash, publishedAt: new Date().toISOString() });
  }
  if (u.pathname === '/api/agent/run' && req.method === 'POST') {
    const input = await body(req);
    return json(res, 200, await runAgent(text(input.message, 'сообщение'), typeof input.sessionId === 'string' ? input.sessionId : undefined, input.context));
  }
  const tool = /^\/api\/agent-tool\/([a-z_]+)$/.exec(u.pathname);
  if (tool && req.method === 'POST') {
    if (req.headers.authorization !== `Bearer ${agentToken}`) return fail(res, 'Нет доступа к инструменту', 401);
    const input = await body(req);
    if (tool[1] === 'search_catalog') return json(res, 200, await catalog(source(input.source)));
    if (tool[1] === 'describe_asset') return json(res, 200, await describe(source(input.source), text(input.database, 'database'), String(input.schema || ''), text(input.name, 'name')));
    if (tool[1] === 'execute_query') return json(res, 200, await execute(source(input.source), text(input.sql, 'SQL'), 100));
    if (tool[1] === 'list_dags') return json(res, 200, await dags());
    if (tool[1] === 'inspect_dag') return json(res, 200, await dagGraph(text(input.dagId, 'dagId')));
    if (tool[1] === 'inspect_run') return json(res, 200, await runDetails(text(input.dagId, 'dagId'), text(input.runId, 'runId')));
    if (tool[1] === 'inspect_task_log') return json(res, 200, await taskLog(text(input.dagId, 'dagId'), text(input.runId, 'runId'), text(input.taskId, 'taskId'), Number(input.tryNumber || 1)));
  }
  return json(res, 404, { error: 'Не найдено' });
}

const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
async function staticUi(res: ServerResponse, pathname: string) {
  const base = path.join(projectRoot, 'dist', 'ui');
  const requested = path.resolve(base, '.' + pathname);
  const file = requested.startsWith(base + path.sep) ? requested : path.join(base, 'index.html');
  const data = await fs.readFile(file).catch(() => fs.readFile(path.join(base, 'index.html')));
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'text/html', 'Cache-Control': 'no-store' });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const origin = req.headers.origin;
  if (origin && !['http://127.0.0.1:5173', `http://127.0.0.1:${config.port}`].includes(origin)) return fail(res, 'Недопустимый origin', 403);
  try {
    if (u.pathname.startsWith('/api/') || u.pathname === '/health') await api(req, res, u);
    else await staticUi(res, u.pathname);
  } catch (error) { fail(res, error, error instanceof SyntaxError ? 400 : 500); }
});

server.listen(config.port, config.host, () => console.log(`DBildo backend: http://${config.host}:${config.port}`));

async function shutdown() {
  server.close();
  await Promise.allSettled([closeAgent(), closeSources()]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
