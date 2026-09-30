import path from 'node:path';
import fs from 'node:fs';

export const projectRoot = path.resolve(import.meta.dirname, '../../..');
const envFile = path.join(projectRoot, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
export const config = {
  host: process.env.DBILDO_HOST || '127.0.0.1',
  port: Number(process.env.DBILDO_PORT || 4317),
  postgresUrl: process.env.PG_URL || 'postgres://dbildo:dbildo@localhost:5432/source',
  clickhouseUrl: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
  clickhouseUser: process.env.CLICKHOUSE_USER || 'dbildo',
  clickhousePassword: process.env.CLICKHOUSE_PASSWORD || 'dbildo',
  airflowUrl: process.env.AIRFLOW_URL || 'http://localhost:8080',
  airflowToken: process.env.AIRFLOW_TOKEN || '',
  agentKey: process.env.DEEPSEEK_API_KEY || '',
  agentModel: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
};
