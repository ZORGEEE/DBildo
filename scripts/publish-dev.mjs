#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'workspace', 'dags');
const target = path.join(root, 'runtime', 'airflow', 'dags');
await fs.mkdir(target, { recursive: true });
for (const file of await fs.readdir(source)) {
  if (file.endsWith('.py')) {
    await fs.copyFile(path.join(source, file), path.join(target, file));
    console.log(`Опубликован dev DAG: ${file}`);
  }
}
