import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, History, LastRun, Queue } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'data');

const paths = {
  configDefaults: resolve(DATA_DIR, 'config.defaults.json'),
  config: resolve(DATA_DIR, 'config.json'),
  queue: resolve(DATA_DIR, 'queue.json'),
  history: resolve(DATA_DIR, 'history.json'),
  lastRun: resolve(DATA_DIR, 'last_run.json'),
  issueTemplate: resolve(ROOT, 'templates', 'issue-template.md'),
};

export { paths, DATA_DIR, ROOT };

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function writeJson<T>(path: string, data: T): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/** Load config, falling back to defaults if no user config exists */
export function loadConfig(): Config {
  const userConfig = readJson<Config>(paths.config);
  if (userConfig) return userConfig;

  const defaults = readJson<Config>(paths.configDefaults);
  if (!defaults) throw new Error('Missing config.defaults.json');
  return defaults;
}

export function saveConfig(config: Config): void {
  writeJson(paths.config, config);
}

export function loadQueue(): Queue {
  return readJson<Queue>(paths.queue) ?? { scannedAt: '', version: '', items: [] };
}

export function saveQueue(queue: Queue): void {
  writeJson(paths.queue, queue);
}

export function loadHistory(): History {
  return readJson<History>(paths.history) ?? { entries: [] };
}

export function saveHistory(history: History): void {
  writeJson(paths.history, history);
}

export function loadLastRun(): LastRun | null {
  return readJson<LastRun>(paths.lastRun);
}

export function saveLastRun(lastRun: LastRun): void {
  writeJson(paths.lastRun, lastRun);
}

export function loadIssueTemplate(): string {
  return readFileSync(paths.issueTemplate, 'utf-8');
}
