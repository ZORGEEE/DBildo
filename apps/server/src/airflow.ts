import { config } from './config.ts';

let currentToken = '';
let tokenExpiresAt = 0;

async function token() {
  if (config.airflowToken) return config.airflowToken;
  if (currentToken && Date.now() < tokenExpiresAt) return currentToken;
  const response = await fetch(`${config.airflowUrl}/auth/token`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`Airflow auth ${response.status}`);
  const data = await response.json() as { access_token: string };
  currentToken = data.access_token;
  tokenExpiresAt = Date.now() + 5 * 60_000;
  return currentToken;
}

async function request(path: string, method = 'GET', payload?: unknown) {
  const response = await fetch(`${config.airflowUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(7000)
  });
  if (response.status === 401 && !config.airflowToken) { currentToken = ''; tokenExpiresAt = 0; }
  if (!response.ok) throw new Error(`Airflow ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

export async function probeAirflow() {
  try { await request('/api/v2/dags?limit=1'); return { online: true }; }
  catch (error) { return { online: false, error: String(error) }; }
}

export async function dags() {
  const data = await request('/api/v2/dags?limit=100') as { dags: unknown[] };
  return data.dags;
}

export async function dagGraph(id: string) {
  const encoded = encodeURIComponent(id);
  const [tasksResult, runsResult] = await Promise.all([
    request(`/api/v2/dags/${encoded}/tasks`), request(`/api/v2/dags/${encoded}/dagRuns?limit=10&order_by=-start_date`)
  ]);
  const tasks = (tasksResult as { tasks?: unknown[] }).tasks || [];
  const runs = (runsResult as { dag_runs?: unknown[] }).dag_runs || [];
  return { tasks, runs };
}

export async function runDetails(dagId: string, runId: string) {
  const path = `/api/v2/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(runId)}`;
  const data = await request(`${path}/taskInstances`) as { task_instances?: unknown[] };
  return data.task_instances || [];
}

export async function taskLog(dagId: string, runId: string, taskId: string, tryNumber = 1) {
  const path = `/api/v2/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(runId)}/taskInstances/${encodeURIComponent(taskId)}/logs/${tryNumber}`;
  return request(path);
}

export async function triggerDag(dagId: string) {
  const runId = `dbildo__${crypto.randomUUID()}`;
  return request(`/api/v2/dags/${encodeURIComponent(dagId)}/dagRuns`, 'POST', { dag_run_id: runId, logical_date: null, conf: {} });
}

export async function setDagPaused(dagId: string, paused: boolean) {
  return request(`/api/v2/dags/${encodeURIComponent(dagId)}`, 'PATCH', { is_paused: paused });
}
