import { Router } from 'express';
import {
  loadConfig,
  saveConfig,
  loadQueue,
  saveQueue,
  loadHistory,
  saveHistory,
  loadLastRun,
  saveLastRun,
} from '../config.js';
import { getOctokit, createIssue, addToMetaIssue, findMetaIssue, setProjectFields } from '../github.js';
import { runScan } from '../scanner.js';
import { renderIssueBody, clearTemplateCache } from '../template.js';
import type { HistoryEntry, QueueItem } from '../types.js';

export const apiRouter = Router();

// ── User ───────────────────────────────────────────────

apiRouter.get('/user', (_req, res, next) => {
  const ok = getOctokit();
  ok.users.getAuthenticated()
    .then(({ data }) => {
      res.json({ login: data.login, name: data.name, avatarUrl: data.avatar_url });
    })
    .catch((err: unknown) => {
      console.warn('Failed to fetch user:', err instanceof Error ? err.message : err);
      res.json({ login: null, avatarUrl: null });
    });
});

// ── Config ──────────────────────────────────────────────

apiRouter.get('/config', (_req, res) => {
  res.json(loadConfig());
});

apiRouter.put('/config', (req, res) => {
  try {
    saveConfig(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// ── Queue ───────────────────────────────────────────────

apiRouter.get('/queue', (_req, res) => {
  const queue = loadQueue();

  // Always re-render issue bodies from the template so they reflect
  // the latest assessment data (e.g., after AI enrichment)
  for (const item of queue.items) {
    try {
      item.suggestedBody = renderIssueBody(item);
    } catch {
      item.suggestedBody = '(template rendering failed)';
    }
  }

  res.json(queue);
});

/** Update user edits for a queue item */
apiRouter.patch('/queue/:id', (req, res) => {
  const queue = loadQueue();
  const item = queue.items.find((i) => i.id === req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Queue item not found' });
    return;
  }

  item.userEdits = { ...item.userEdits, ...req.body.userEdits };

  // Re-render the issue body with new edits
  if (req.body.suggestedTitle) item.suggestedTitle = req.body.suggestedTitle;
  item.suggestedBody = renderIssueBody(item);

  saveQueue(queue);
  res.json(item);
});

// ── Scan ────────────────────────────────────────────────

apiRouter.post('/scan', async (_req, res) => {
  try {
    const queue = await runScan();

    // Render bodies
    for (const item of queue.items) {
      item.suggestedBody = renderIssueBody(item);
    }
    saveQueue(queue);

    res.json(queue);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Mark the current scan as complete — advances the last_run date */
apiRouter.post('/scan/complete', (_req, res) => {
  const queue = loadQueue();
  if (!queue.scannedAt) {
    res.status(400).json({ error: 'No scan has been run yet' });
    return;
  }

  saveLastRun({
    lastRunDate: queue.scannedAt.split('T')[0],
  });

  res.json({ ok: true, lastRunDate: queue.scannedAt.split('T')[0] });
});

apiRouter.get('/last-run', (_req, res) => {
  res.json(loadLastRun() ?? { lastRunDate: null });
});

// ── History ─────────────────────────────────────────────

apiRouter.get('/history', (_req, res) => {
  res.json(loadHistory());
});

// ── Create issue ────────────────────────────────────────

apiRouter.post('/create-issue', async (req, res) => {
  try {
    const { queueItemId, goodFirstIssue } = req.body;
    const config = loadConfig();
    const queue = loadQueue();
    const history = loadHistory();

    const item = queue.items.find((i) => i.id === queueItemId);
    if (!item) {
      res.status(404).json({ error: 'Queue item not found' });
      return;
    }

    const title = item.userEdits?.title ?? item.suggestedTitle;
    const body = renderIssueBody(item);
    const targetRepo = item.userEdits?.targetRepo ?? `${config.targetRepo.owner}/${config.targetRepo.repo}`;
    const [owner, repo] = targetRepo.split('/');

    // Create the issue
    const labels = [...config.issueLabels];
    if (goodFirstIssue) {
      labels.push('good first issue');
    }
    const issue = await createIssue(owner, repo, title, body, labels);

    // Try to set project fields
    if (config.project) {
      const p = config.project;
      const versionMatch = item.version?.match(/v?(\d+\.\d+)/);
      const latestMerge = item.prs.map((pr) => pr.mergedAt).filter(Boolean).sort().pop();
      let serverlessPubDate: string | undefined;
      if (latestMerge) {
        const d = new Date(latestMerge);
        d.setDate(d.getDate() + 7);
        const day = d.getDay();
        const diff = day === 0 ? -6 : -(day - 1);
        d.setDate(d.getDate() + diff);
        serverlessPubDate = d.toISOString().split('T')[0];
      }

      await setProjectFields(
        p.org,
        p.number,
        owner,
        repo,
        issue.number,
        {
          release: versionMatch ? versionMatch[1] : undefined,
          size: p.sizeMap?.[item.assessment.effortTag ?? ''] ?? undefined,
          priority: p.defaultPriority ?? undefined,
          area: p.defaultArea ?? undefined,
          feature: p.featureMap?.[item.category] ?? undefined,
          serverlessPubDate,
        }
      );
    }

    // Try to add to the meta issue for this item's version
    if (item.version && item.version !== 'unknown') {
      try {
        const meta = await findMetaIssue(owner, repo, item.version);
        if (meta) {
          const cat = config.categories.find((c) => c.name === item.category);
          const heading = cat?.metaIssueHeading ?? item.category;
          await addToMetaIssue(owner, repo, meta.number, heading, issue.url);

          // Also update sections for cross-category matches (sequential to avoid stale reads)
          for (const alsoCat of item.alsoAppliesTo ?? []) {
            const alsoConfig = config.categories.find((c) => c.name === alsoCat);
            const alsoHeading = alsoConfig?.metaIssueHeading ?? alsoCat;
            await addToMetaIssue(owner, repo, meta.number, alsoHeading, issue.url);
          }
        } else {
          console.warn(`No meta issue found for version ${item.version}`);
        }
      } catch (err) {
        console.warn(`Failed to update meta issue for ${item.version}:`, err);
      }
    }

    // Record in history
    const entry: HistoryEntry = {
      prNumbers: item.prs.map((p) => p.number),
      decision: 'created',
      issueUrl: issue.url,
      issueNumber: issue.number,
      timestamp: new Date().toISOString(),
      version: item.version,
      title,
      session: queue.scannedAt?.split('T')[0],
    };
    history.entries.push(entry);
    saveHistory(history);

    // Remove from queue
    queue.items = queue.items.filter((i) => i.id !== queueItemId);
    saveQueue(queue);

    res.json({ ok: true, issue });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Dismiss ─────────────────────────────────────────────

apiRouter.post('/dismiss', (req, res) => {
  const { queueItemId, reason } = req.body;
  const config = loadConfig();
  const queue = loadQueue();
  const history = loadHistory();

  const item = queue.items.find((i) => i.id === queueItemId);
  if (!item) {
    res.status(404).json({ error: 'Queue item not found' });
    return;
  }

  const entry: HistoryEntry = {
    prNumbers: item.prs.map((p) => p.number),
    decision: 'dismissed',
    reason: reason ?? 'no docs needed',
    timestamp: new Date().toISOString(),
    version: item.version,
    title: item.userEdits?.title ?? item.suggestedTitle,
    session: queue.scannedAt?.split('T')[0],
  };
  history.entries.push(entry);
  saveHistory(history);

  queue.items = queue.items.filter((i) => i.id !== queueItemId);
  saveQueue(queue);

  res.json({ ok: true });
});

// ── Undo dismiss ────────────────────────────────────────

apiRouter.post('/undo-dismiss', (req, res) => {
  const { prNumbers } = req.body;
  const history = loadHistory();

  const idx = history.entries.findIndex(
    (e) =>
      e.decision === 'dismissed' &&
      e.prNumbers.length === prNumbers.length &&
      e.prNumbers.every((n: number) => prNumbers.includes(n))
  );

  if (idx === -1) {
    res.status(404).json({ error: 'History entry not found' });
    return;
  }

  history.entries.splice(idx, 1);
  saveHistory(history);

  res.json({ ok: true, message: 'Dismissed entry removed. Re-scan to pick up these PRs again.' });
});

// ── Meta issue detection ────────────────────────────────

/** Look up meta issue for a specific version (pass ?version=v9.4.0) */
apiRouter.get('/meta-issue', async (req, res) => {
  try {
    const version = req.query.version as string;
    if (!version) {
      res.status(400).json({ error: 'version query param required (e.g., ?version=v9.4.0)' });
      return;
    }
    const config = loadConfig();
    const { owner, repo } = config.targetRepo;
    const meta = await findMetaIssue(owner, repo, version);
    res.json(meta ?? { number: null });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Template ────────────────────────────────────────────

apiRouter.post('/clear-template-cache', (_req, res) => {
  clearTemplateCache();
  res.json({ ok: true });
});
