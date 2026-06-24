import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, History, LastRun, Queue, NormalizedConfig, RepoGroup } from './types.js';

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
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }
}

function writeJson<T>(path: string, data: T): void {
  const serialized = JSON.stringify(data, null, 2) + '\n';
  // Verify the serialized output is valid JSON before writing
  JSON.parse(serialized);
  writeFileSync(path, serialized, 'utf-8');
}

/** Load config, falling back to defaults if no user config exists */
export function loadConfig(): Config {
  const userConfig = readJson<Config>(paths.config);
  if (userConfig) return userConfig;

  const defaults = readJson<Config>(paths.configDefaults);
  if (!defaults) throw new Error('Missing config.defaults.json');
  return defaults;
}

const DEFAULT_VERSION_PATTERN = '^v\\d+\\.\\d+\\.\\d+$';
const DEFAULT_RELEASE_NOTE_LABELS = [
  'release_note:breaking',
  'release_note:deprecation',
  'release_note:feature',
  'release_note:enhancement',
];

/** Fill per-group defaults derived from the group's source/target. */
function fillRepoDefaults(g: RepoGroup): RepoGroup {
  const target = `${g.target.owner}/${g.target.repo}`;
  return {
    ...g,
    id: g.id || `${g.source.owner}/${g.source.repo}`,
    versionLabelPattern: g.versionLabelPattern ?? DEFAULT_VERSION_PATTERN,
    releaseNoteLabels: g.releaseNoteLabels ?? DEFAULT_RELEASE_NOTE_LABELS,
    issueLabels: g.issueLabels ?? [],
    maxMergeAgeMonths: g.maxMergeAgeMonths ?? 6,
    crossRefRepos:
      g.crossRefRepos ??
      (g.target.repo.endsWith('-internal')
        ? [target]
        : [target, `${g.target.owner}/${g.target.repo}-internal`]),
    productIssuePattern:
      g.productIssuePattern ?? `https://github\\.com/${g.source.owner}/${g.source.repo}/issues/\\d+`,
  };
}

/**
 * Normalize either config shape into repo groups. A `repos[]` config is used
 * directly; a legacy flat config is wrapped into a single synthetic group so
 * the rest of the app only ever deals with `RepoGroup`s.
 */
export function normalizeConfig(raw: Config): NormalizedConfig {
  let groups: RepoGroup[];
  if (raw.repos?.length) {
    groups = raw.repos.map(fillRepoDefaults);
  } else {
    if (!raw.sourceRepo || !raw.targetRepo || !raw.categories) {
      throw new Error(
        'Config must define either `repos` or the legacy `sourceRepo`/`targetRepo`/`categories` fields.'
      );
    }
    groups = [
      fillRepoDefaults({
        id: `${raw.sourceRepo.owner}/${raw.sourceRepo.repo}`,
        source: raw.sourceRepo,
        target: raw.targetRepo,
        categories: raw.categories,
        project: raw.project,
        metaIssue: raw.metaIssue,
        issueLabels: raw.issueLabels,
        versionLabelPattern: raw.versionLabelPattern,
        releaseNoteLabels: raw.releaseNoteLabels,
        maxMergeAgeMonths: raw.maxMergeAgeMonths,
      }),
    ];
  }
  return { title: raw.title, repos: groups };
}

/** Load and normalize the config into repo groups (what scan/create code consumes). */
export function loadNormalizedConfig(): NormalizedConfig {
  return normalizeConfig(loadConfig());
}

export function saveConfig(config: Config): void {
  writeJson(paths.config, config);
}

export function loadQueue(): Queue {
  return readJson<Queue>(paths.queue) ?? { scannedAt: '', items: [] };
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
