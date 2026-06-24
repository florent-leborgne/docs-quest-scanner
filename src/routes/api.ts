import { Router } from 'express';
import {
  loadConfig,
  loadNormalizedConfig,
  normalizeConfig,
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
  const config = loadNormalizedConfig();
  const groupById = new Map(config.repos.map((g) => [g.id, g]));

  // Union of every selectable target repo across groups (target + cross-ref repos),
  // for the per-issue target dropdown.
  const targetOptions = [
    ...new Set(
      config.repos.flatMap((g) => [`${g.target.owner}/${g.target.repo}`, ...(g.crossRefRepos ?? [])])
    ),
  ];

  // Re-render bodies and attach each item's resolved routing (transient — not persisted)
  // so the UI can show source/target/project without reading the legacy config shape.
  const items = queue.items.map((item) => {
    let suggestedBody: string;
    try {
      suggestedBody = renderIssueBody(item);
    } catch {
      suggestedBody = '(template rendering failed)';
    }
    const group = groupById.get(item.repoId);
    return {
      ...item,
      suggestedBody,
      resolvedTarget: group ? `${group.target.owner}/${group.target.repo}` : undefined,
      repoLabel: group?.label ?? group?.id,
      projectNumber: group?.project?.number,
    };
  });

  res.json({ ...queue, items, targetOptions });
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

  const date = queue.scannedAt.split('T')[0];
  // The scan covered every configured group, so advance each group's date.
  // Keep the legacy global lastRunDate as a fallback for any newly added group.
  const prev = loadLastRun() ?? {};
  const byRepo = { ...(prev.byRepo ?? {}) };
  for (const group of loadNormalizedConfig().repos) {
    byRepo[group.id] = date;
  }
  saveLastRun({ lastRunDate: date, byRepo });

  res.json({ ok: true, lastRunDate: date });
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
    const config = loadNormalizedConfig();
    const queue = loadQueue();
    const history = loadHistory();

    const item = queue.items.find((i) => i.id === queueItemId);
    if (!item) {
      res.status(404).json({ error: 'Queue item not found' });
      return;
    }

    // Resolve the repo group this item belongs to. Fail loudly rather than
    // mis-route if the config changed since the scan.
    const group = config.repos.find((r) => r.id === item.repoId);
    if (!group) {
      res.status(409).json({
        error: `No repo group "${item.repoId}" in current config — re-run the scan after changing repos.`,
      });
      return;
    }

    const title = item.userEdits?.title ?? item.suggestedTitle;
    const ok = getOctokit();
    const { data: authUser } = await ok.users.getAuthenticated().catch(() => ({ data: null }));
    const body = renderIssueBody(item, authUser?.login);
    // Target repo stays a UI choice: the dropdown wins, defaulting to the group's
    // target. It only changes where the issue is filed — project/meta follow the group.
    const targetRepo = item.userEdits?.targetRepo ?? `${group.target.owner}/${group.target.repo}`;
    const [owner, repo] = targetRepo.split('/');

    // Create the issue
    const labels = [...(group.issueLabels ?? [])];
    if (goodFirstIssue) {
      labels.push('good first issue');
    }
    const issue = await createIssue(owner, repo, title, body, labels);

    // Try to set project fields
    let projectFields: Awaited<ReturnType<typeof setProjectFields>> | null = null;
    if (group.project) {
      const p = group.project;
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

      // Feature: a matching PR label (featureLabelMap, in declaration order)
      // wins over the category default, so multi-team categories route correctly.
      const prLabels = item.prs.flatMap((pr) => pr.labels ?? []);
      const labelFeature = Object.entries(p.featureLabelMap ?? {}).find(
        ([label]) => prLabels.includes(label)
      )?.[1];

      projectFields = await setProjectFields(
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
          feature: labelFeature ?? p.featureMap?.[item.category] ?? undefined,
          contentType: p.contentTypeMap?.[item.assessment.effortTag ?? ''] ?? undefined,
          serverlessPubDate,
        }
      );
    }

    // Link the created issue into the meta-issue checklist(s) for its version.
    // Each category can override the global meta-issue config (issue #2), so the
    // primary category and any also-applies categories may resolve to different
    // checklists. Categories without an override share the global config.
    if (item.version && item.version !== 'unknown') {
      const categoriesToLink = [item.category, ...(item.alsoAppliesTo ?? [])];
      // Cache meta-issue lookups by title pattern so categories sharing a
      // checklist don't trigger duplicate searches. Value `null` = not found.
      const metaCache = new Map<string, Awaited<ReturnType<typeof findMetaIssue>>>();
      for (const catName of categoriesToLink) {
        const cat = group.categories.find((c) => c.name === catName);
        const metaConfig = cat?.metaIssue ?? group.metaIssue;
        if (metaConfig?.enabled === false) continue;
        const titlePattern = metaConfig?.titlePattern;
        try {
          const cacheKey = titlePattern ?? '<default>';
          let meta = metaCache.get(cacheKey);
          if (meta === undefined) {
            meta = await findMetaIssue(owner, repo, item.version, titlePattern);
            metaCache.set(cacheKey, meta);
          }
          if (meta) {
            const heading = cat?.metaIssueHeading ?? catName;
            await addToMetaIssue(owner, repo, meta.number, heading, issue.url);
          } else {
            console.warn(`No meta issue found for version ${item.version} (pattern: "${titlePattern ?? 'Kibana {version}'}")`);
          }
        } catch (err) {
          console.warn(`Failed to update meta issue for ${catName} ${item.version}:`, err);
        }
      }
    }

    // Record in history
    const entry: HistoryEntry = {
      prNumbers: item.prs.map((p) => p.number),
      decision: 'created',
      repoId: item.repoId,
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

    res.json({ ok: true, issue, projectFields });
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
    repoId: item.repoId,
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
    const config = loadNormalizedConfig();
    const repoId = req.query.repoId as string | undefined;
    const group = (repoId && config.repos.find((r) => r.id === repoId)) || config.repos[0];
    const { owner, repo } = group.target;
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
