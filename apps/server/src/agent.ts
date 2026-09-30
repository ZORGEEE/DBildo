import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { config, projectRoot } from './config.ts';

export const agentToken = crypto.randomBytes(32).toString('hex');
process.env.DBILDO_AGENT_TOKEN = agentToken;
process.env.DBILDO_AGENT_URL = `http://${config.host}:${config.port}`;

let harness: DeepSeekHarness | undefined;

export function agentAvailable() { return Boolean(config.agentKey); }

export async function runAgent(message: string, sessionId?: string, context?: unknown) {
  if (!config.agentKey) throw new Error('Укажите DEEPSEEK_API_KEY для запуска DeepSeek Harness');
  if (!harness) {
    const home = path.join(projectRoot, 'runtime', 'harness');
    fs.mkdirSync(home, { recursive: true });
    harness = new DeepSeekHarness({
      profile: 'sdk', provider: 'deepseek-official', model: config.agentModel,
      cwd: projectRoot, dshHome: home,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER,
        TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
        DEEPSEEK_API_KEY: config.agentKey,
        DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
        DBILDO_AGENT_TOKEN: agentToken,
        DBILDO_AGENT_URL: process.env.DBILDO_AGENT_URL
      }
    });
  }
  const instructions = `Ты агент в IDE дата-инженера DBildo. Работай с данными проекта и объясняй выводы по фактам.\n\n` +
    `Инструменты IDE доступны через shell-команду: node scripts/data-tool.mjs <действие> '<JSON>'.\n` +
    `Действия: search_catalog {source:"postgres"|"clickhouse"}, describe_asset {source,database,schema,name}, ` +
    `execute_query {source,sql}, list_dags {}, inspect_dag {dagId}, inspect_run {dagId,runId}, ` +
    `inspect_task_log {dagId,runId,taskId,tryNumber}.\n` +
    `Команды возвращают JSON и выполняются в локальном backend IDE. SQL сейчас только для чтения. ` +
    `Не раскрывай секреты. Если для вывода нужны данные, вызывай инструмент. ` +
    `Для предлагаемых правок сначала показывай diff и объясняй проверку.\n\n` +
    `Выбранный контекст IDE: ${JSON.stringify(context || {}).slice(0, 12000)}\n\nЗапрос пользователя: ${message}`;
  const result = await harness.run(instructions, sessionId ? { sessionId } : undefined);
  return { sessionId: result.sessionId, text: result.finalResponse || '', events: result.events.length };
}

export async function closeAgent() { await harness?.close(); harness = undefined; }
