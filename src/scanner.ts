import { randomUUID } from 'node:crypto';
import { loadConfig, loadHistory, loadLastRun, loadQueue, saveQueue } from './config.js';
import { searchMergedPRs, getPRFiles } from './github.js';
import type { Config, PullRequest, QueueItem, Queue, Assessment } from './types.js';

/** Default lookback if no last run exists: 14 days */
const DEFAULT_LOOKBACK_DAYS = 14;

/**
 * Run a full scan: fetch PRs, filter, group, and write queue.
 * Returns the updated queue.
 */
export async function runScan(configOverride?: Config): Promise<Queue> {
  const config = configOverride ?? loadConfig();
  const history = loadHistory();
  const lastRun = loadLastRun();
  const existingQueue = loadQueue();

  // Determine the start date for this scan
  const sinceDate = lastRun
    ? lastRun.lastRunDate
    : daysAgo(DEFAULT_LOOKBACK_DAYS);

  console.log(`Scanning PRs merged since ${sinceDate}`);
  console.log(`  Version pattern: ${config.versionLabelPattern}`);
  console.log(`  Release note filter: ${config.releaseNoteLabels.join(', ')}`);

  // Collect all known PR numbers from history (created or dismissed)
  const knownPRs = new Set(history.entries.flatMap((e) => e.prNumbers));

  // Preserve user edits from existing queue items
  const existingEdits = new Map<string, QueueItem['userEdits']>();
  for (const item of existingQueue.items) {
    if (item.userEdits) {
      const key = item.prs.map((p) => p.number).sort().join(',');
      existingEdits.set(key, item.userEdits);
    }
  }

  // Fetch PRs per category
  const allItems: QueueItem[] = [];

  for (const category of config.categories) {
    console.log(`  Scanning ${category.name} (${category.labels.join(', ')})...`);

    let prs: PullRequest[] = [];
    for (const label of category.labels) {
      const found = await searchMergedPRs(config, [label], sinceDate);
      prs.push(...found);
    }

    // Deduplicate PRs (a PR might match multiple labels in the same category)
    prs = deduplicatePRs(prs);

    // Filter: PR must have at least one release note label to be triaged.
    // GitHub search doesn't support OR across labels, so we filter locally.
    const releaseNoteLabels = new Set(config.releaseNoteLabels.map((l) => l.toLowerCase()));
    const beforeFilter = prs.length;
    prs = prs.filter((pr) =>
      pr.labels.some((l) => releaseNoteLabels.has(l.toLowerCase()))
    );
    if (beforeFilter > prs.length) {
      console.log(`    Filtered ${beforeFilter - prs.length} PRs without release note labels.`);
    }

    // Filter out PRs already in history
    prs = prs.filter((pr) => !knownPRs.has(pr.number));

    if (prs.length === 0) {
      console.log(`    No new PRs found.`);
      continue;
    }

    console.log(`    Found ${prs.length} new PRs.`);

    // Fetch changed files for each PR (useful for assessment)
    for (const pr of prs) {
      try {
        pr.changedFiles = await getPRFiles(
          config.sourceRepo.owner,
          config.sourceRepo.repo,
          pr.number
        );
      } catch {
        // Non-critical, continue without files
      }
    }

    // Group related PRs
    const groups = groupRelatedPRs(prs);

    for (const group of groups) {
      const item = buildQueueItem(group, category.name, config);

      // Restore user edits if this group was seen before
      const key = group.map((p) => p.number).sort().join(',');
      if (existingEdits.has(key)) {
        item.userEdits = existingEdits.get(key);
      }

      allItems.push(item);
    }
  }

  // Deduplicate items across categories: if the same PR(s) appear in multiple
  // categories, keep only the first occurrence and note the others in alsoAppliesTo
  const deduped = deduplicateAcrossCategories(allItems);

  const queue: Queue = {
    scannedAt: new Date().toISOString(),
    items: deduped,
  };

  // Log version breakdown
  const versionCounts = new Map<string, number>();
  for (const item of allItems) {
    versionCounts.set(item.version, (versionCounts.get(item.version) ?? 0) + 1);
  }
  if (versionCounts.size > 0) {
    console.log(`  Versions found: ${[...versionCounts.entries()].map(([v, n]) => `${v} (${n})`).join(', ')}`);
  }

  saveQueue(queue);
  console.log(`Scan complete. ${queue.items.length} items in queue.`);
  return queue;
}

/**
 * Group PRs that are likely about the same feature.
 * Conservative: only groups PRs that share a linked issue or have very similar titles.
 */
function groupRelatedPRs(prs: PullRequest[]): PullRequest[][] {
  const groups: PullRequest[][] = [];
  const assigned = new Set<number>();

  // Pass 1: group by shared GitHub issue reference in body
  const issueRefs = new Map<string, PullRequest[]>();
  for (const pr of prs) {
    const refs = extractIssueRefs(pr.body);
    for (const ref of refs) {
      if (!issueRefs.has(ref)) issueRefs.set(ref, []);
      issueRefs.get(ref)!.push(pr);
    }
  }

  for (const [, issuePRs] of issueRefs) {
    if (issuePRs.length > 1) {
      const group = issuePRs.filter((pr) => !assigned.has(pr.number));
      if (group.length > 1) {
        for (const pr of group) assigned.add(pr.number);
        groups.push(group);
      }
    }
  }

  // Pass 2: group by very similar titles (same prefix in brackets + similar rest)
  const remaining = prs.filter((pr) => !assigned.has(pr.number));
  const titleGroups = new Map<string, PullRequest[]>();

  for (const pr of remaining) {
    const key = normalizeTitleForGrouping(pr.title);
    if (!titleGroups.has(key)) titleGroups.set(key, []);
    titleGroups.get(key)!.push(pr);
  }

  for (const [, titlePRs] of titleGroups) {
    if (titlePRs.length > 1) {
      for (const pr of titlePRs) assigned.add(pr.number);
      groups.push(titlePRs);
    }
  }

  // Pass 3: remaining PRs are singletons
  for (const pr of prs) {
    if (!assigned.has(pr.number)) {
      groups.push([pr]);
    }
  }

  return groups;
}

/**
 * Extract GitHub issue references from PR body.
 * Matches: #1234, org/repo#1234, full GitHub issue URLs
 */
function extractIssueRefs(body: string): string[] {
  const refs = new Set<string>();
  // Match full URLs
  const urlPattern = /https:\/\/github\.com\/[\w-]+\/[\w-]+\/issues\/(\d+)/g;
  for (const match of body.matchAll(urlPattern)) {
    refs.add(match[0]);
  }
  // Match Closes #1234, Fixes #1234, Resolves #1234
  const closePattern = /(?:closes?|fixes?|resolves?)\s+#(\d+)/gi;
  for (const match of body.matchAll(closePattern)) {
    refs.add(`#${match[1]}`);
  }
  return [...refs];
}

/**
 * Normalize a PR title for grouping.
 * "[Lens] Add foo bar" and "[Lens] Add foo bar (part 2)" -> same key
 */
function normalizeTitleForGrouping(title: string): string {
  return title
    .replace(/\s*\(part\s*\d+\)/i, '')
    .replace(/\s*-\s*part\s*\d+/i, '')
    .replace(/\s*\d+\/\d+$/, '')
    .trim()
    .toLowerCase();
}

function deduplicatePRs(prs: PullRequest[]): PullRequest[] {
  const seen = new Map<number, PullRequest>();
  for (const pr of prs) {
    if (!seen.has(pr.number)) seen.set(pr.number, pr);
  }
  return [...seen.values()];
}

/**
 * Extract the version label from a PR's labels using the configured pattern.
 * Returns the first matching label, or "unknown" if none match.
 */
function detectVersion(prs: PullRequest[], pattern: string): string {
  const re = new RegExp(pattern);
  for (const pr of prs) {
    for (const label of pr.labels) {
      if (re.test(label)) return label;
    }
  }
  return 'unknown';
}

/**
 * Build a queue item from a group of PRs.
 * Produces a basic assessment (no AI). The skill layer adds richer assessments.
 */
function buildQueueItem(
  prs: PullRequest[],
  category: string,
  config: Config
): QueueItem {
  const primary = prs[0];
  const assessment = basicAssessment(prs);
  const version = detectVersion(prs, config.versionLabelPattern);

  // Build a suggested title
  const suggestedTitle = prs.length === 1
    ? cleanPRTitle(primary.title)
    : `${cleanPRTitle(primary.title)} (${prs.length} PRs)`;

  // Extract release note text and screenshots from all PR bodies
  const releaseNoteText = prs
    .map((pr) => extractReleaseNote(pr.body))
    .find((text) => text !== undefined);
  const screenshots = prs.flatMap((pr) => extractScreenshots(pr.body));
  if (screenshots.length > 0) {
    assessment.screenshots = screenshots;
  }

  return {
    id: randomUUID(),
    category,
    version,
    prs,
    assessment,
    suggestedTitle,
    suggestedBody: '', // Filled by template renderer in the API layer
    releaseNoteText,
  };
}

/**
 * Clean a PR title to make it suitable as an issue title.
 * Strips team prefixes like [Lens], [Discover], etc.
 */
function cleanPRTitle(title: string): string {
  return title
    .replace(/^\[[\w\s|]+\]\s*/, '')
    .replace(/^\[[\w\s|]+\]\s*/, '') // Handle double brackets
    .trim();
}

/**
 * Heuristic-based assessment (no AI).
 *
 * The primary signal is the release note label — every PR in the queue already
 * passed the release-note-label filter, so we know it has one of:
 *   release_note:breaking, release_note:deprecation, release_note:feature,
 *   release_note:enhancement, release_note:fix
 *
 * Assessment strategy:
 * - breaking / deprecation → always "yes" (high confidence)
 * - feature → always "yes"
 * - enhancement → "yes" unless title/body signals it's purely internal
 * - fix → "check" by default. Fixes rarely need docs unless the fix changes
 *   documented behavior or the PR was mistagged. Flag for manual review.
 */
function basicAssessment(prs: PullRequest[]): Assessment {
  const allLabels = prs.flatMap((p) => p.labels);
  const allLabelLower = allLabels.map((l) => l.toLowerCase());
  const allFiles = prs.flatMap((p) => p.changedFiles ?? []);
  const allTitles = prs.map((p) => p.title.toLowerCase()).join(' ');
  const allBodies = prs.map((p) => p.body.toLowerCase()).join(' ');
  const combined = allTitles + ' ' + allBodies;

  // Determine the "strongest" release note label on these PRs
  const hasBreaking = allLabelLower.includes('release_note:breaking');
  const hasDeprecation = allLabelLower.includes('release_note:deprecation');
  const hasFeature = allLabelLower.includes('release_note:feature');
  const hasEnhancement = allLabelLower.includes('release_note:enhancement');
  const hasFix = allLabelLower.includes('release_note:fix');

  // Signals that an enhancement/fix might be purely internal (no user-facing impact)
  const internalSignals = [
    'internal', 'refactor', 'cleanup', 'clean up', 'noop', 'no-op',
    'test', 'ci', 'chore', 'backport', 'revert',
  ];
  const looksInternal = internalSignals.some((s) => combined.includes(s));

  // Feature flag detection
  let featureFlag: string | undefined;
  const flagPatterns = [
    /feature[_\s]?flag[:\s]+["']?([\w.]+)/i,
    /xpack\.[\w.]+\.enabled/,
    /experimentalFeatures/,
    /uiSettings.*defaultValue:\s*false/,
  ];
  for (const pr of prs) {
    const text = pr.title + ' ' + pr.body;
    for (const pat of flagPatterns) {
      const m = text.match(pat);
      if (m) {
        featureFlag = m[1] ?? m[0];
        break;
      }
    }
    if (featureFlag) break;
  }

  // Feature status from labels
  let featureStatus: string | undefined;
  if (allLabels.some((l) => /preview/i.test(l))) featureStatus = 'preview';
  else if (allLabels.some((l) => /beta/i.test(l))) featureStatus = 'beta';
  else if (allLabels.some((l) => /\bga\b/i.test(l))) featureStatus = 'ga';

  // Product issue from body
  let productIssue: string | undefined;
  for (const pr of prs) {
    const issueMatch = pr.body.match(
      /https:\/\/github\.com\/elastic\/kibana\/issues\/\d+/
    );
    if (issueMatch) {
      productIssue = issueMatch[0];
      break;
    }
  }

  // Determine assessment based on release note label hierarchy
  let needsDocs: Assessment['needsDocs'];
  let confidence: number;
  let reasoning: string;

  if (hasBreaking) {
    needsDocs = 'yes';
    confidence = 0.95;
    reasoning = 'Breaking change — documentation update required.';
  } else if (hasDeprecation) {
    needsDocs = 'yes';
    confidence = 0.95;
    reasoning = 'Deprecation — documentation update required.';
  } else if (hasFeature) {
    needsDocs = 'yes';
    confidence = 0.9;
    reasoning = 'New feature — documentation needed.';
  } else if (hasEnhancement) {
    if (looksInternal) {
      needsDocs = 'check';
      confidence = 0.4;
      reasoning = 'Enhancement but title/body suggests internal change — verify if user-facing.';
    } else {
      needsDocs = 'yes';
      confidence = 0.75;
      reasoning = 'Enhancement — likely needs documentation update.';
    }
  } else if (hasFix) {
    // Fixes rarely need docs. They're included for completeness because
    // sometimes a fix is mistagged and is actually a behavior change, or
    // the fix corrects something that was documented incorrectly.
    needsDocs = 'check';
    confidence = 0.3;
    reasoning = 'Bug fix — usually no docs needed unless it changes documented behavior or was mistagged.';
  } else {
    needsDocs = 'check';
    confidence = 0.2;
    reasoning = 'No recognized release note label — manual review recommended.';
  }

  // Build summary from first PR body (truncated)
  const summary = buildSummary(prs);

  return {
    needsDocs,
    confidence,
    summary,
    reasoning,
    featureStatus,
    featureFlag,
    serverlessEstimate: undefined,
    existingDocs: [],
    productIssue,
  };
}

/**
 * Build a summary from PR bodies.
 * Extracts the first meaningful paragraph.
 */
function buildSummary(prs: PullRequest[]): string {
  const primary = prs[0];
  const body = primary.body;

  // Skip "## Summary" heading if present and take the paragraph after it
  const summaryMatch = body.match(/##\s*Summary\s*\n+([\s\S]*?)(?=\n##|\n---|\n\n\n|$)/i);
  const text = summaryMatch ? summaryMatch[1].trim() : body.trim();

  // Take first ~300 chars
  const truncated = text.slice(0, 300);
  return truncated.length < text.length ? truncated + '...' : truncated;
}

/**
 * Deduplicate queue items across categories.
 * If the same PR numbers appear in multiple categories (e.g., a PR tagged
 * with both Team:esql and Team:dataDiscovery), keep the first occurrence
 * and add the other categories to `alsoAppliesTo`.
 */
function deduplicateAcrossCategories(items: QueueItem[]): QueueItem[] {
  const seen = new Map<string, QueueItem>();

  for (const item of items) {
    const key = item.prs.map((p) => p.number).sort().join(',');
    const existing = seen.get(key);
    if (existing) {
      if (!existing.alsoAppliesTo) existing.alsoAppliesTo = [];
      if (!existing.alsoAppliesTo.includes(item.category)) {
        existing.alsoAppliesTo.push(item.category);
      }
    } else {
      seen.set(key, item);
    }
  }

  return [...seen.values()];
}

/**
 * Extract release note text from a PR body.
 * Matches common patterns like "### Release note:", "Release note: ...", etc.
 */
function extractReleaseNote(body: string): string | undefined {
  // Pattern 1: ### Release note / ## Release note section
  const sectionMatch = body.match(
    /#{2,3}\s*Release\s*note[s]?:?\s*\n+([\s\S]*?)(?=\n#{2,3}\s|\n---|\n\n\n|$)/i
  );
  if (sectionMatch) {
    const text = sectionMatch[1].trim();
    // Skip if it's just a placeholder or checkbox
    if (text && !text.match(/^(\s*[-*]\s*\[[ x]\]|N\/A|n\/a|none|TBD)\s*$/i)) {
      return text;
    }
  }

  // Pattern 2: Single-line "Release note: ..."
  const inlineMatch = body.match(/Release\s*note:\s*(.+)/i);
  if (inlineMatch) {
    const text = inlineMatch[1].trim();
    if (text && text.toLowerCase() !== 'n/a' && text.toLowerCase() !== 'none') {
      return text;
    }
  }

  return undefined;
}

/**
 * Extract image URLs (screenshots, GIFs) from a PR body.
 */
function extractScreenshots(body: string): string[] {
  const urls: string[] = [];

  // Match markdown images: ![alt](url)
  const mdImages = body.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g);
  for (const match of mdImages) {
    urls.push(match[2]);
  }

  // Match <img> tags with src
  const imgTags = body.matchAll(/<img[^>]+src="([^"]+)"/g);
  for (const match of imgTags) {
    urls.push(match[1]);
  }

  // Deduplicate
  return [...new Set(urls)];
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}
