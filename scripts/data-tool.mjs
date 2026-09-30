#!/usr/bin/env node
const [action, raw = '{}'] = process.argv.slice(2);
const allowed = new Set(['search_catalog', 'describe_asset', 'execute_query', 'list_dags', 'inspect_dag', 'inspect_run', 'inspect_task_log']);
if (!allowed.has(action)) { console.error(`Неизвестный инструмент: ${action}`); process.exit(2); }
try {
  const response = await fetch(`${process.env.DBILDO_AGENT_URL || 'http://127.0.0.1:4317'}/api/agent-tool/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DBILDO_AGENT_TOKEN || ''}` },
    body: raw
  });
  const body = await response.text();
  process.stdout.write(body + '\n');
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error(String(error)); process.exitCode = 1;
}
