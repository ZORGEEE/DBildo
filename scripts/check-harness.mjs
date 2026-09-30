import fs from 'node:fs/promises';
import path from 'node:path';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

const cwd = process.cwd();
const dshHome = path.join(cwd, 'runtime', 'harness-check');
await fs.mkdir(dshHome, { recursive: true });
const harness = new DeepSeekHarness({ profile: 'sdk', provider: 'deepseek-official', model: 'deepseek-v4-flash', cwd, dshHome });
try {
  await harness.start();
  console.log('DeepSeek Harness SDK: runtime запущен и handshake выполнен');
} finally {
  await harness.close();
}
