import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Editor from '@monaco-editor/react';
import { ReactFlow, Background, Controls, MiniMap, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';

type Source = 'postgres' | 'clickhouse';
type Asset = { id: string; source: Source; database: string; schema: string; name: string; kind: string };
type Dag = { dag_id: string; description?: string; is_paused?: boolean };
type Task = { task_id: string; downstream_task_ids?: string[]; operator_name?: string };
type Run = { dag_run_id: string; state: string; start_date?: string };
type Lineage = { nodes: { id: string; label: string; kind: string; source: string }[]; edges: { from: string; to: string; evidence: string }[] };
type QueryResult = { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; durationMs: number; queryId?: string };
type Status = { sources: Record<Source, { online: boolean; error?: string }>; airflow: { online: boolean; error?: string }; agent: { configured: boolean } };
type View = 'overview' | 'sql' | 'dag' | 'files';

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}

function post<T>(url: string, value: unknown) { return api<T>(url, { method: 'POST', body: JSON.stringify(value) }); }

function graph(tasks: Task[], states: Map<string, string>): { nodes: Node[]; edges: Edge[] } {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  const inbound = new Map(tasks.map((task) => [task.task_id, 0]));
  for (const task of tasks) for (const target of task.downstream_task_ids || []) if (byId.has(target)) inbound.set(target, (inbound.get(target) || 0) + 1);
  const levels = new Map<string, number>();
  const queue = tasks.filter((task) => inbound.get(task.task_id) === 0).map((task) => task.task_id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of byId.get(id)?.downstream_task_ids || []) {
      if (!byId.has(child)) continue;
      levels.set(child, Math.max(levels.get(child) || 0, (levels.get(id) || 0) + 1));
      inbound.set(child, (inbound.get(child) || 0) - 1);
      if (inbound.get(child) === 0) queue.push(child);
    }
  }
  const rows = new Map<number, number>();
  const nodes: Node[] = tasks.map((task) => {
    const level = levels.get(task.task_id) || 0;
    const row = rows.get(level) || 0;
    rows.set(level, row + 1);
    return { id: task.task_id, position: { x: level * 290, y: row * 116 }, data: { label: <div><strong>{task.task_id}</strong><small>{task.operator_name || 'Task'}</small></div> }, className: `dag-node ${states.get(task.task_id) || ''}`, sourcePosition: 'right', targetPosition: 'left' } as Node;
  });
  const edges: Edge[] = tasks.flatMap((task) => (task.downstream_task_ids || []).filter((id) => byId.has(id)).map((target) => ({ id: `${task.task_id}->${target}`, source: task.task_id, target, animated: states.get(task.task_id) === 'running' })));
  return { nodes, edges };
}

function lineageGraph(lineage?: Lineage): { nodes: Node[]; edges: Edge[] } {
  if (!lineage) return { nodes: [], edges: [] };
  return {
    nodes: lineage.nodes.map((item, index) => ({
      id: item.id, position: { x: index * 300, y: 140 },
      data: { label: <div><strong>{item.label}</strong><small>{item.source} · {item.kind}</small></div> },
      className: 'dag-node', sourcePosition: 'right', targetPosition: 'left'
    } as Node)),
    edges: lineage.edges.map((edge) => ({ id: `${edge.from}->${edge.to}`, source: edge.from, target: edge.to, label: edge.evidence.split('/').at(-1) }))
  };
}

function DataChart({ result }: { result: QueryResult }) {
  const numeric = result.columns.filter((column) => result.rows.some((row) => row[column] !== null && row[column] !== '' && Number.isFinite(Number(row[column]))));
  const [x, setX] = useState(result.columns[0] || '');
  const [y, setY] = useState(numeric[0] || '');
  const rows = result.rows.slice(0, 30);
  const values = rows.map((row) => Number(row[y]));
  const max = Math.max(1, ...values.filter(Number.isFinite));
  return <div className="chart-view"><div className="chart-controls"><label>Категория <select value={x} onChange={(e) => setX(e.target.value)}>{result.columns.map((column) => <option key={column}>{column}</option>)}</select></label><label>Значение <select value={y} onChange={(e) => setY(e.target.value)}>{numeric.map((column) => <option key={column}>{column}</option>)}</select></label><span>Первые {rows.length} строк результата</span></div>{numeric.length ? <div className="chart-bars">{rows.map((row, index) => <div className="chart-row" key={index}><span title={String(row[x] ?? '')}>{String(row[x] ?? 'NULL')}</span><div><i style={{ width: `${Math.max(0, Number.isFinite(values[index]) ? values[index] / max * 100 : 0)}%` }}/></div><b>{Number.isFinite(values[index]) ? values[index].toLocaleString('ru-RU') : '—'}</b></div>)}</div> : <div className="blank-state">Для графика нужен числовой столбец</div>}</div>;
}

function App() {
  const [view, setView] = useState<View>('overview');
  const [status, setStatus] = useState<Status>();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [dags, setDags] = useState<Dag[]>([]);
  const [lineage, setLineage] = useState<Lineage>();
  const [graphMode, setGraphMode] = useState<'dag' | 'lineage'>('dag');
  const [files, setFiles] = useState<string[]>([]);
  const [source, setSource] = useState<Source>('postgres');
  const [selectedAsset, setSelectedAsset] = useState<Asset>();
  const [columns, setColumns] = useState<{ name: string; type: string; nullable?: string }[]>([]);
  const [selectedDag, setSelectedDag] = useState<string>();
  const [selectedTask, setSelectedTask] = useState<string>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState<string>();
  const [taskStates, setTaskStates] = useState<Map<string, string>>(new Map());
  const [taskLog, setTaskLog] = useState<string>();
  const [sql, setSql] = useState('SELECT * FROM public.orders LIMIT 100');
  const [result, setResult] = useState<QueryResult>();
  const [resultMode, setResultMode] = useState<'table' | 'chart'>('table');
  const [queryBusy, setQueryBusy] = useState(false);
  const [filePath, setFilePath] = useState<string>();
  const [fileText, setFileText] = useState('');
  const [fileHash, setFileHash] = useState('');
  const [fileDirty, setFileDirty] = useState(false);
  const [agentOpen, setAgentOpen] = useState(true);
  const [agentInput, setAgentInput] = useState('');
  const [agentBusy, setAgentBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(() => localStorage.getItem('dbildo.session') || undefined);
  const [messages, setMessages] = useState<{ role: 'user' | 'agent'; text: string }[]>([]);
  const [notice, setNotice] = useState<string>();

  async function refresh() {
    const [nextStatus, nextFiles, nextLineage] = await Promise.all([api<Status>('/api/status'), api<string[]>('/api/files'), api<Lineage>('/api/lineage')]);
    setStatus(nextStatus); setFiles(nextFiles); setLineage(nextLineage);
    const [pg, ch, airflow] = await Promise.allSettled([
      api<Asset[]>('/api/catalog?source=postgres'),
      api<Asset[]>('/api/catalog?source=clickhouse'),
      api<Dag[]>('/api/dags')
    ]);
    setAssets([...(pg.status === 'fulfilled' ? pg.value : []), ...(ch.status === 'fulfilled' ? ch.value : [])]);
    setDags(airflow.status === 'fulfilled' ? airflow.value : []);
  }

  useEffect(() => { refresh().catch((error) => setNotice(String(error))); }, []);
  useEffect(() => {
    if (!selectedAsset) return;
    const params = new URLSearchParams({ source: selectedAsset.source, database: selectedAsset.database, schema: selectedAsset.schema, name: selectedAsset.name });
    api<{ columns: typeof columns }>(`/api/describe?${params}`).then((data) => setColumns(data.columns)).catch((error) => setNotice(String(error)));
  }, [selectedAsset]);
  useEffect(() => {
    if (!selectedDag) return;
    api<{ tasks: Task[]; runs: Run[] }>(`/api/dags/${encodeURIComponent(selectedDag)}/graph`).then((data) => {
      setTasks(data.tasks); setRuns(data.runs); setSelectedRun(data.runs[0]?.dag_run_id); setSelectedTask(undefined);
    }).catch((error) => setNotice(String(error)));
  }, [selectedDag]);
  useEffect(() => {
    if (!selectedDag || !selectedRun) { setTaskStates(new Map()); return; }
    api<{ task_id: string; state: string }[]>(`/api/dags/${encodeURIComponent(selectedDag)}/runs/${encodeURIComponent(selectedRun)}`)
      .then((data) => setTaskStates(new Map(data.map((item) => [item.task_id, item.state]))))
      .catch((error) => setNotice(String(error)));
  }, [selectedDag, selectedRun]);
  useEffect(() => {
    if (!selectedDag || !selectedRun || !selectedTask) { setTaskLog(undefined); return; }
    const path = `/api/dags/${encodeURIComponent(selectedDag)}/runs/${encodeURIComponent(selectedRun)}/tasks/${encodeURIComponent(selectedTask)}/logs`;
    api<unknown>(path).then((data) => setTaskLog(typeof data === 'string' ? data : JSON.stringify(data, null, 2))).catch((error) => setTaskLog(String(error)));
  }, [selectedDag, selectedRun, selectedTask]);

  const dag = useMemo(() => graph(tasks, taskStates), [tasks, taskStates]);
  const lineageFlow = useMemo(() => lineageGraph(lineage), [lineage]);
  const filteredAssets = assets.filter((asset) => asset.source === source);

  async function runQuery() {
    setQueryBusy(true); setNotice(undefined);
    try { setResult(await post<QueryResult>('/api/query', { source, sql })); setResultMode('table'); }
    catch (error) { setNotice(String(error)); }
    finally { setQueryBusy(false); }
  }

  async function openFile(file: string) {
    if (fileDirty && !confirm('Есть несохранённые изменения. Открыть другой файл?')) return;
    try {
      const data = await api<{ content: string; hash: string }>(`/api/file?path=${encodeURIComponent(file)}`);
      setFilePath(file); setFileText(data.content); setFileHash(data.hash); setFileDirty(false); setView('files');
    } catch (error) { setNotice(String(error)); }
  }

  async function saveFile() {
    if (!filePath) return;
    try {
      const data = await api<{ hash: string }>('/api/file', { method: 'PUT', body: JSON.stringify({ path: filePath, content: fileText, hash: fileHash }) });
      setFileHash(data.hash); setFileDirty(false); setNotice('Файл сохранён в workspace');
    } catch (error) { setNotice(String(error)); }
  }

  async function publishFile() {
    if (!filePath || fileDirty) return;
    try {
      const data = await post<{ publishedAt: string }>('/api/publish-dev', { path: filePath, hash: fileHash });
      setNotice(`Снимок DAG для dev создан: ${new Date(data.publishedAt).toLocaleTimeString()}`);
    } catch (error) { setNotice(String(error)); }
  }

  async function sendAgent() {
    const message = agentInput.trim();
    if (!message || agentBusy) return;
    setAgentInput(''); setMessages((items) => [...items, { role: 'user', text: message }]); setAgentBusy(true);
    try {
      const response = await post<{ sessionId: string; text: string }>('/api/agent/run', {
        message, sessionId, context: { view, source, asset: selectedAsset, dagId: selectedDag, runId: selectedRun, taskId: selectedTask, filePath, sql: view === 'sql' ? sql : undefined }
      });
      setSessionId(response.sessionId); localStorage.setItem('dbildo.session', response.sessionId);
      setMessages((items) => [...items, { role: 'agent', text: response.text || 'Агент завершил ход без текстового ответа.' }]);
    } catch (error) { setMessages((items) => [...items, { role: 'agent', text: `Ошибка: ${String(error)}` }]); }
    finally { setAgentBusy(false); }
  }

  async function triggerSelectedDag() {
    if (!selectedDag) return;
    try {
      const run = await post<Run>(`/api/dags/${encodeURIComponent(selectedDag)}/trigger`, {});
      setRuns((items) => [run, ...items]); setSelectedRun(run.dag_run_id);
      setNotice(`DAG запущен: ${run.dag_run_id}`);
    } catch (error) { setNotice(String(error)); }
  }

  async function enableSelectedDag() {
    if (!selectedDag) return;
    try {
      await api(`/api/dags/${encodeURIComponent(selectedDag)}/paused`, { method: 'PUT', body: JSON.stringify({ paused: false }) });
      setDags((items) => items.map((item) => item.dag_id === selectedDag ? { ...item, is_paused: false } : item));
      setNotice(`DAG ${selectedDag} включён`);
    } catch (error) { setNotice(String(error)); }
  }

  function selectAsset(asset: Asset) {
    setSelectedAsset(asset); setSource(asset.source); setView('sql');
    const name = asset.source === 'postgres' ? `${asset.schema}.${asset.name}` : `${asset.database}.${asset.name}`;
    setSql(`SELECT * FROM ${name} LIMIT 100`);
  }

  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">◈</span><span>DBILDO</span><span className="brand-tag">DATA IDE</span></div>
      <div className="top-center">WORKSPACE <span className="sep">/</span> local-dev</div>
      <div className="top-actions"><span className="version">v0.1 PREVIEW</span><button onClick={() => refresh().catch((error) => setNotice(String(error)))}>↻ Обновить</button><button onClick={() => setAgentOpen(!agentOpen)}>{agentOpen ? 'Скрыть агента' : 'Открыть агента'}</button></div>
    </header>
    <div className="body">
      <nav className="rail">
        {([['overview', '▦', 'Обзор'], ['sql', '▤', 'SQL и данные'], ['dag', '◇', 'Пайплайны'], ['files', '⌘', 'Файлы']] as [View, string, string][]).map(([id, icon, label]) => <button key={id} title={label} className={view === id ? 'active' : ''} onClick={() => setView(id)}><span>{icon}</span><small>{label}</small></button>)}
      </nav>
      <aside className="explorer">
        <div className="section-head"><span>ИССЛЕДОВАТЕЛЬ</span><span>⌕</span></div>
        <div className="explorer-scroll">
          <div className="explorer-group"><div className="group-head">⌄ ПОДКЛЮЧЕНИЯ</div>
            <button className="source-item" onClick={() => { setSource('postgres'); setView('sql'); }}><span className={`status-dot ${status?.sources.postgres.online ? 'online' : ''}`}/><span>PostgreSQL</span><small>{assets.filter((x) => x.source === 'postgres').length}</small></button>
            <button className="source-item" onClick={() => { setSource('clickhouse'); setView('sql'); }}><span className={`status-dot ${status?.sources.clickhouse.online ? 'online' : ''}`}/><span>ClickHouse</span><small>{assets.filter((x) => x.source === 'clickhouse').length}</small></button>
            <button className="source-item" onClick={() => setView('dag')}><span className={`status-dot ${status?.airflow.online ? 'online' : ''}`}/><span>Airflow</span><small>{dags.length}</small></button>
          </div>
          <div className="explorer-group"><div className="group-head">⌄ ОБЪЕКТЫ ДАННЫХ</div>
            {assets.length ? assets.map((asset) => <button key={asset.id} className={`tree-item ${selectedAsset?.id === asset.id ? 'selected' : ''}`} onClick={() => selectAsset(asset)}><span className="tree-icon">▦</span><span title={asset.id}>{asset.name}</span><small>{asset.source === 'postgres' ? 'PG' : 'CH'}</small></button>) : <div className="empty-tree">Подключите dev-стенд, чтобы увидеть таблицы</div>}
          </div>
          <div className="explorer-group"><div className="group-head">⌄ AIRFLOW DAGS</div>
            {dags.length ? dags.map((item) => <button key={item.dag_id} className={`tree-item ${selectedDag === item.dag_id ? 'selected' : ''}`} onClick={() => { setSelectedDag(item.dag_id); setView('dag'); }}><span className="tree-icon">◇</span><span title={item.dag_id}>{item.dag_id}</span></button>) : <div className="empty-tree">DAG появятся после запуска Airflow</div>}
          </div>
          <div className="explorer-group"><div className="group-head">⌄ WORKSPACE</div>
            {files.map((file) => <button key={file} className={`tree-item ${filePath === file ? 'selected' : ''}`} onClick={() => openFile(file)}><span className="tree-icon">{file.endsWith('.py') ? 'Py' : '≡'}</span><span title={file}>{file.split('/').at(-1)}</span></button>)}
          </div>
        </div>
        <div className="explorer-foot">LOCAL DEVELOPMENT</div>
      </aside>
      <main className="main">
        {view === 'overview' && <div className="overview">
          <div className="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО <span> / </span> ОБЗОР</div>
          <div className="hero"><div><div className="hero-kicker">DATA ENGINEERING WORKSPACE</div><h1>Вся система данных.<br/><em>В одном контексте.</em></h1><p>Исследуйте базы, запускайте запросы, смотрите DAG и разбирайте сбои вместе с агентом.</p><div className="hero-actions"><button className="primary" onClick={() => setView('sql')}>Открыть SQL →</button><button onClick={() => setView('dag')}>Посмотреть DAG</button></div></div><div className="hero-art"><span className="art-dot a"/><span className="art-dot b"/><span className="art-dot c"/><span className="art-dot d"/><span className="art-line l1"/><span className="art-line l2"/><span className="art-line l3"/><div className="art-label">POSTGRES <span>→</span> AIRFLOW <span>→</span> CLICKHOUSE</div></div></div>
          <div className="section-title"><h2>Подключения</h2><span>Локальный dev-стенд</span></div>
          <div className="cards">{([['PostgreSQL', status?.sources.postgres.online, 'Источник данных', assets.filter((x) => x.source === 'postgres').length + ' объектов'], ['ClickHouse', status?.sources.clickhouse.online, 'Аналитическое хранилище', assets.filter((x) => x.source === 'clickhouse').length + ' объектов'], ['Airflow', status?.airflow.online, 'Оркестратор', dags.length + ' DAG'], ['DeepSeek Harness', status?.agent.configured, 'Агент данных', status?.agent.configured ? 'Ключ настроен' : 'Нужен API ключ']] as [string, boolean | undefined, string, string][]).map(([name, online, subtitle, detail]) => <div className="card" key={name}><div className="card-top"><div className="card-icon">{name === 'PostgreSQL' ? 'P' : name === 'ClickHouse' ? 'C' : name === 'Airflow' ? 'A' : '◈'}</div><span className={`pill ${online ? 'ok' : 'off'}`}>{online ? 'ONLINE' : 'OFFLINE'}</span></div><h3>{name}</h3><p>{subtitle}</p><div className="card-detail">{detail}</div></div>)}</div>
          <div className="section-title"><h2>Быстрый старт</h2></div><div className="steps"><div><b>01</b><span>Запустите dev-стенд</span><code>npm run infra:up</code></div><div><b>02</b><span>Исследуйте данные</span><small>Каталог · SQL · Результат</small></div><div><b>03</b><span>Разберите пайплайн</span><small>DAG · Запуски · Агент</small></div></div>
        </div>}
        {view === 'sql' && <div className="work-view">
          <div className="pane-title"><div><div className="eyebrow">РЕДАКТОР / SQL</div><h2>SQL и данные</h2></div><div className="pane-controls"><select value={source} onChange={(e) => setSource(e.target.value as Source)}><option value="postgres">PostgreSQL · source</option><option value="clickhouse">ClickHouse · default</option></select><button className="primary" onClick={runQuery} disabled={queryBusy}>{queryBusy ? 'Выполняется…' : '▶ Выполнить'}</button></div></div>
          <div className="sql-layout"><div className="editor-block"><div className="block-bar"><span>QUERY.SQL</span><span>{source === 'postgres' ? 'PostgreSQL' : 'ClickHouse'} <i className="green-dot"/></span></div><Editor height="100%" language="sql" theme="vs-dark" value={sql} onChange={(value) => setSql(value || '')} options={{ minimap: { enabled: false }, fontSize: 14, fontFamily: 'JetBrains Mono, Menlo, monospace', padding: { top: 22 }, automaticLayout: true, lineNumbersMinChars: 3, scrollBeyondLastLine: false }}/></div>
          <div className="results-block"><div className="block-bar"><span>РЕЗУЛЬТАТ {result ? `· ${result.rowCount} строк` : ''}</span><div className="result-actions">{result && <><button className={resultMode === 'table' ? 'active' : ''} onClick={() => setResultMode('table')}>Таблица</button><button className={resultMode === 'chart' ? 'active' : ''} onClick={() => setResultMode('chart')}>График</button></>}<span>{result ? `${result.durationMs} ms${result.truncated ? ' · усечён' : ''}` : 'Ожидание запроса'}</span></div></div>{result ? resultMode === 'chart' ? <DataChart key={`${source}:${result.queryId || result.durationMs}`} result={result}/> : <div className="table-wrap"><table><thead><tr>{result.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{result.rows.map((row, index) => <tr key={index}>{result.columns.map((column) => <td key={column}>{row[column] === null ? <span className="null">NULL</span> : typeof row[column] === 'object' ? JSON.stringify(row[column]) : String(row[column] ?? '')}</td>)}</tr>)}</tbody></table></div> : <div className="blank-state"><span>▤</span><h3>Результат появится здесь</h3><p>Введите SQL и нажмите «Выполнить»</p></div>}</div></div>
          {selectedAsset && <div className="schema-strip"><span>СХЕМА: {selectedAsset.id}</span>{columns.map((column) => <span key={column.name}>{column.name} <em>{column.type}</em></span>)}</div>}
        </div>}
        {view === 'dag' && <div className="work-view">
          <div className="pane-title"><div><div className="eyebrow">ПАЙПЛАЙНЫ / {graphMode === 'dag' ? 'AIRFLOW' : 'LINEAGE'}</div><h2>{graphMode === 'dag' ? selectedDag || 'Граф DAG' : 'Происхождение данных'}</h2></div><div className="pane-controls"><div className="mode-toggle"><button className={graphMode === 'dag' ? 'active' : ''} onClick={() => setGraphMode('dag')}>DAG</button><button className={graphMode === 'lineage' ? 'active' : ''} onClick={() => setGraphMode('lineage')}>Данные</button></div>{graphMode === 'dag' && <><select value={selectedDag || ''} onChange={(e) => setSelectedDag(e.target.value || undefined)}><option value="">Выберите DAG</option>{dags.map((item) => <option key={item.dag_id} value={item.dag_id}>{item.dag_id}</option>)}</select><select value={selectedRun || ''} onChange={(e) => setSelectedRun(e.target.value || undefined)}><option value="">Без запуска</option>{runs.map((item, index) => <option key={item.dag_run_id} value={item.dag_run_id}>{index === 0 ? 'Последний · ' : ''}{item.state} · {item.dag_run_id.slice(-8)}</option>)}</select>{selectedDag && dags.find((item) => item.dag_id === selectedDag)?.is_paused && <button onClick={enableSelectedDag}>Включить DAG</button>}<button className="primary" disabled={!selectedDag || dags.find((item) => item.dag_id === selectedDag)?.is_paused} onClick={triggerSelectedDag}>▶ Запустить</button></>}</div></div>
          <div className="dag-area">{graphMode === 'lineage' ? <ReactFlow nodes={lineageFlow.nodes} edges={lineageFlow.edges} fitView><Background color="#283442" gap={20} size={1}/><Controls/><MiniMap nodeColor="#64c7b3" maskColor="rgba(9,21,27,.75)" pannable zoomable/></ReactFlow> : selectedDag && tasks.length ? <ReactFlow nodes={dag.nodes} edges={dag.edges} fitView onNodeClick={(_, node) => setSelectedTask(node.id)}><Background color="#283442" gap={20} size={1}/><Controls/><MiniMap nodeColor="#64c7b3" maskColor="rgba(9,21,27,.75)" pannable zoomable/></ReactFlow> : <div className="blank-state"><span>◇</span><h3>{status?.airflow.online ? 'Выберите DAG слева' : 'Airflow пока недоступен'}</h3><p>{status?.airflow.online ? 'Задачи и зависимости появятся на графе' : 'Запустите локальный стенд и обновите подключения'}</p></div>}</div>
          {graphMode === 'dag' && selectedTask && <div className="task-detail"><div><span>ВЫБРАННАЯ ЗАДАЧА</span><h3>{selectedTask}</h3><p>{tasks.find((task) => task.task_id === selectedTask)?.operator_name || 'Task'}</p></div><span className={`pill ${taskStates.get(selectedTask) === 'success' ? 'ok' : 'off'}`}>{taskStates.get(selectedTask) || 'NO RUN'}</span><button onClick={() => { setAgentOpen(true); setAgentInput(`Исследуй задачу ${selectedTask} в DAG ${selectedDag}${selectedRun ? `, запуск ${selectedRun}` : ''}. Какие есть проблемы?`); }}>Обсудить с агентом →</button>{taskLog && <details className="task-log"><summary>Лог задачи</summary><pre>{taskLog}</pre></details>}</div>}
        </div>}
        {view === 'files' && <div className="work-view"><div className="pane-title"><div><div className="eyebrow">WORKSPACE / ФАЙЛЫ</div><h2>{filePath || 'Редактор файлов'}</h2></div><div className="pane-controls"><span className={fileDirty ? 'dirty-label' : 'saved-label'}>{fileDirty ? '● Не сохранено' : 'Сохранено'}</span>{filePath?.startsWith('dags/') && <button disabled={fileDirty} onClick={publishFile}>Опубликовать в dev</button>}<button className="primary" disabled={!filePath || !fileDirty} onClick={saveFile}>Сохранить</button></div></div><div className="file-editor">{filePath ? <Editor height="100%" language={filePath.endsWith('.py') ? 'python' : 'sql'} theme="vs-dark" value={fileText} onChange={(value) => { setFileText(value || ''); setFileDirty(true); }} options={{ minimap: { enabled: false }, fontSize: 14, automaticLayout: true, padding: { top: 20 } }}/> : <div className="blank-state"><span>⌘</span><h3>Откройте файл из workspace</h3><p>SQL, Python DAG и проверки доступны слева</p></div>}</div></div>}
      </main>
      {agentOpen && <aside className="agent"><div className="agent-head"><div className="agent-logo">◈</div><div><strong>DeepSeek Agent</strong><small>{status?.agent.configured ? 'HARNESS CONNECTED' : 'HARNESS · API KEY REQUIRED'}</small></div><button onClick={() => setAgentOpen(false)}>×</button></div><div className="agent-content">{messages.length ? messages.map((item, index) => <div className={`chat-message ${item.role}`} key={index}><span>{item.role === 'agent' ? '◈ AGENT' : 'YOU'}</span><p>{item.text}</p></div>) : <div className="agent-welcome"><div className="welcome-icon">✦</div><h3>Спросите о данных</h3><p>Агент может исследовать каталог, выполнять запросы и разбирать задачи Airflow с контекстом текущего экрана.</p><button onClick={() => setAgentInput('Какие источники данных доступны и какие DAG их используют?')}>Исследовать workspace ↗</button></div>}{agentBusy && <div className="agent-thinking">◌ Агент исследует контекст…</div>}</div><div className="agent-compose"><textarea placeholder="Спросите о данных или пайплайне…" value={agentInput} onChange={(e) => setAgentInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAgent(); } }}/><div><span>↵ отправить · Shift+↵ новая строка</span><button onClick={sendAgent} disabled={agentBusy || !agentInput.trim()}>↑</button></div></div></aside>}
    </div>
    <footer className="statusbar"><span><i className="green-dot"/> DBILDO LOCAL</span><span>{status?.sources.postgres.online ? 'PG ●' : 'PG ○'} &nbsp; {status?.sources.clickhouse.online ? 'CH ●' : 'CH ○'} &nbsp; {status?.airflow.online ? 'AF ●' : 'AF ○'}</span><span className="status-right">{notice ? <button onClick={() => setNotice(undefined)}>{notice} ×</button> : 'READY'}</span></footer>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
