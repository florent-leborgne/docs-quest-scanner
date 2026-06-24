import { Octokit } from '@octokit/rest';
import type { Config, PullRequest, TrackedIssue } from './types.js';

let octokit: Octokit | null = null;

export function getOctokit(): Octokit {
  if (!octokit) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN environment variable is required');
    octokit = new Octokit({ auth: token });
  }
  return octokit;
}

/**
 * Search for merged PRs matching the given team labels,
 * merged after the given date. No version filter — version is
 * detected per-PR from its labels instead.
 *
 * Uses a dual-query strategy to also catch PRs where the team label
 * was added after the PR merged (late-labeled PRs):
 *   1. Primary: `merged:>=sinceDate` — the normal incremental scan
 *   2. Secondary: `updated:>=sinceDate` — catches PRs whose labels
 *      changed since the last scan even if they merged before it
 */
export async function searchMergedPRs(
  config: Config,
  teamLabels: string[],
  sinceDate: string
): Promise<PullRequest[]> {
  const ok = getOctokit();
  const { owner, repo } = config.sourceRepo;

  const teamQ = teamLabels.map((l) => `label:"${l}"`).join(' ');

  const mergedQuery = `repo:${owner}/${repo} is:pr is:merged merged:>=${sinceDate} ${teamQ}`;

  // Secondary query catches PRs where the team label was added after the PR
  // merged: GitHub's updated_at changes when labels are added/removed, so any
  // PR labeled since the last scan appears here even if it merged before sinceDate.
  const updatedQuery = `repo:${owner}/${repo} is:pr is:merged updated:>=${sinceDate} ${teamQ}`;

  const [primary, secondary] = await Promise.all([
    paginateSearch(ok, mergedQuery),
    paginateSearch(ok, updatedQuery),
  ]);

  // Merge and deduplicate by PR number — primary takes precedence
  const seen = new Map<number, PullRequest>();
  for (const pr of primary) {
    seen.set(pr.number, pr);
  }

  // Compute the merge-age cutoff: late-label entries merged before this date
  // are filtered out. They're typically PRs whose only recent activity is an
  // unrelated label edit (e.g., a version label removed years after merge).
  const maxAgeMonths = config.maxMergeAgeMonths ?? 6;
  const cutoff = new Date(sinceDate);
  cutoff.setMonth(cutoff.getMonth() - maxAgeMonths);
  const cutoffMs = cutoff.getTime();

  let lateCount = 0;
  let staleCount = 0;
  for (const pr of secondary) {
    if (seen.has(pr.number)) continue;
    const mergedMs = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN;
    if (Number.isFinite(mergedMs) && mergedMs < cutoffMs) {
      staleCount++;
      continue;
    }
    seen.set(pr.number, pr);
    lateCount++;
  }

  if (lateCount > 0) {
    console.log(
      `    (Late-label catch: found ${lateCount} additional PR${lateCount !== 1 ? 's' : ''} labeled after merging)`
    );
  }
  if (staleCount > 0) {
    console.log(
      `    (Skipped ${staleCount} late-label entr${staleCount !== 1 ? 'ies' : 'y'} merged >${maxAgeMonths} months ago)`
    );
  }

  return [...seen.values()];
}

/**
 * Paginate through all pages of a GitHub search query and return PullRequest objects.
 */
async function paginateSearch(ok: Octokit, query: string): Promise<PullRequest[]> {
  const results: PullRequest[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const result = await ok.search.issuesAndPullRequests({
      q: query,
      per_page: perPage,
      page,
      sort: 'updated',
      order: 'desc',
    });

    for (const item of result.data.items) {
      results.push({
        number: item.number,
        title: item.title,
        url: item.html_url,
        author: item.user?.login ?? 'unknown',
        mergedAt: (item.pull_request?.merged_at as string) ?? item.closed_at ?? '',
        body: item.body ?? '',
        labels: (item.labels ?? []).map((l) =>
          typeof l === 'string' ? l : l.name ?? ''
        ),
      });
    }

    if (result.data.items.length < perPage) break;
    page++;
  }

  return results;
}


/**
 * Fetch changed files for a specific PR.
 */
export async function getPRFiles(
  owner: string,
  repo: string,
  prNumber: number
): Promise<string[]> {
  const ok = getOctokit();
  const { data: files } = await ok.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  return files.map((f) => f.filename);
}

/**
 * Create an issue on the target repo.
 */
export async function createIssue(
  owner: string,
  repo: string,
  title: string,
  body: string,
  labels: string[]
): Promise<{ number: number; url: string }> {
  const ok = getOctokit();
  const { data } = await ok.issues.create({
    owner,
    repo,
    title,
    body,
    labels,
  });
  return { number: data.number, url: data.html_url };
}

/**
 * Auto-detect the meta issue for a given version in the target repo.
 *
 * @param titlePattern - Title search pattern with `{version}` placeholder.
 *   Defaults to `"Kibana {version}"`. The placeholder is replaced with
 *   the major.minor extracted from `versionLabel` (e.g., "v9.5.0" → "9.5").
 */
export async function findMetaIssue(
  owner: string,
  repo: string,
  versionLabel: string,
  titlePattern?: string
): Promise<{ number: number; title: string; body: string } | null> {
  const ok = getOctokit();

  // Extract major.minor from "v9.4.0" -> "9.4"
  const versionMatch = versionLabel.match(/v?(\d+\.\d+)/);
  if (!versionMatch) return null;
  const version = versionMatch[1];

  const pattern = titlePattern ?? 'Kibana {version}';
  const searchTitle = pattern.replace('{version}', version);

  const query = `repo:${owner}/${repo} is:issue is:open "${searchTitle}" in:title`;
  const { data } = await ok.search.issuesAndPullRequests({
    q: query,
    per_page: 5,
  });

  if (data.items.length === 0) return null;

  // Pick the best match
  const item = data.items[0];
  return {
    number: item.number,
    title: item.title,
    body: item.body ?? '',
  };
}

/**
 * Append an issue reference to the meta issue body under the right category section.
 */
export async function addToMetaIssue(
  owner: string,
  repo: string,
  metaIssueNumber: number,
  categoryName: string,
  issueUrl: string
): Promise<void> {
  const ok = getOctokit();

  // Get current body
  const { data: issue } = await ok.issues.get({
    owner,
    repo,
    issue_number: metaIssueNumber,
  });

  let body = issue.body ?? '';
  const newEntry = `- [ ] ${issueUrl}`;
  const todayStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  // Find the category heading (## Category name)
  // Try exact match first, then fuzzy
  const headingPattern = new RegExp(
    `(## ${escapeRegex(categoryName)}[^\n]*\n)((?:.*\n)*?)(?=\n## |$)`,
    'i'
  );
  const match = body.match(headingPattern);

  if (match) {
    // Insert after the last item in this section
    const sectionContent = match[2];
    const insertPos = (match.index ?? 0) + match[0].length;

    // Update "Last check" date if present, or insert one after the heading
    const lastCheckPattern = /_\[Last check: [^\]]*\]_/;
    const beforeSection = body.slice(0, (match.index ?? 0) + match[1].length);
    const afterSection = body.slice(insertPos);

    let updatedSection = sectionContent;
    if (lastCheckPattern.test(updatedSection)) {
      updatedSection = updatedSection.replace(lastCheckPattern, `_[Last check: ${todayStr}]_`);
    } else {
      // No "Last check" line — insert one right at the start of the section
      updatedSection = `_[Last check: ${todayStr}]_\n` + updatedSection;
    }

    // Find end of existing list items in the section
    const lines = updatedSection.trimEnd().split('\n');
    const lastListIdx = lines.reduceRight((found, l, i) => found === -1 && l.trim().startsWith('- ') ? i : found, -1);

    if (lastListIdx >= 0) {
      // Insert after last list item
      const sectionLines = updatedSection.split('\n');
      sectionLines.splice(lastListIdx + 1, 0, newEntry);
      body = beforeSection + sectionLines.join('\n') + afterSection;
    } else {
      // No items yet, add after section content
      body = beforeSection + updatedSection + newEntry + '\n' + afterSection;
    }
  } else {
    // Category not found — append at the end with a "Last check" line
    body = body.trimEnd() + `\n\n## ${categoryName}\n_[Last check: ${todayStr}]_\n${newEntry}\n`;
  }

  await ok.issues.update({
    owner,
    repo,
    issue_number: metaIssueNumber,
    body,
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fetch cross-reference events from a PR's timeline and return any issues
 * that reference it from one of the target repos (e.g., elastic/docs-content).
 *
 * GitHub automatically records a `cross-referenced` event on a PR whenever
 * another issue or PR mentions it — so this is more accurate than a text search
 * and doesn't touch the search API rate limit.
 */
export async function findCrossReferencedIssues(
  sourceOwner: string,
  sourceRepo: string,
  prNumber: number,
  targetRepos: string[]   // e.g. ["elastic/docs-content", "elastic/docs-content-internal"]
): Promise<TrackedIssue[]> {
  const ok = getOctokit();
  const found = new Map<number, TrackedIssue>();
  const targetSet = new Set(targetRepos.map((r) => r.toLowerCase()));

  try {
    const { data: events } = await ok.issues.listEventsForTimeline({
      owner: sourceOwner,
      repo: sourceRepo,
      issue_number: prNumber,
      per_page: 100,
    });

    for (const event of events) {
      if (event.event !== 'cross-referenced') continue;

      const src = (event as any).source;
      const issue = src?.issue;
      if (!issue) continue;

      const repoFullName: string = issue.repository?.full_name ?? '';
      if (!targetSet.has(repoFullName.toLowerCase())) continue;

      if (issue.pull_request) continue;

      if (!found.has(issue.number)) {
        found.set(issue.number, {
          number: issue.number,
          url: issue.html_url,
          title: issue.title,
        });
      }
    }
  } catch {
    // Non-critical
  }

  return [...found.values()];
}

// ── GitHub Projects v2 integration ──────────────────────

interface ProjectField {
  id: string;
  name: string;
  dataType: string;
  options?: { id: string; name: string }[];
}

interface ProjectSchema {
  projectId: string;
  fields: ProjectField[];
}

let cachedSchema: ProjectSchema | null = null;

/**
 * Fetch the project schema (field IDs + option IDs) via GraphQL.
 * Cached for the lifetime of the process.
 */
async function getProjectSchema(org: string, projectNumber: number): Promise<ProjectSchema> {
  if (cachedSchema) return cachedSchema;
  const ok = getOctokit();

  const query = `query($org: String!, $number: Int!) {
    organization(login: $org) {
      projectV2(number: $number) {
        id
        fields(first: 50) {
          nodes {
            ... on ProjectV2Field {
              id
              name
              dataType
            }
            ... on ProjectV2SingleSelectField {
              id
              name
              dataType
              options { id name }
            }
            ... on ProjectV2IterationField {
              id
              name
              dataType
            }
          }
        }
      }
    }
  }`;

  const result: any = await ok.graphql(query, { org, number: projectNumber });
  const project = result.organization.projectV2;

  cachedSchema = {
    projectId: project.id,
    fields: project.fields.nodes.map((f: any) => ({
      id: f.id,
      name: f.name,
      dataType: f.dataType,
      options: f.options ?? undefined,
    })),
  };

  return cachedSchema;
}

/**
 * Add an issue to a project and return the project item ID.
 */
async function addIssueToProject(projectId: string, issueNodeId: string): Promise<string> {
  const ok = getOctokit();
  const mutation = `mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item { id }
    }
  }`;
  const result: any = await ok.graphql(mutation, { projectId, contentId: issueNodeId });
  return result.addProjectV2ItemById.item.id;
}

/**
 * Set a single-select field on a project item.
 */
async function setSelectField(
  projectId: string,
  itemId: string,
  fieldId: string,
  optionId: string
): Promise<void> {
  const ok = getOctokit();
  await ok.graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId,
        fieldId: $fieldId, value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId, optionId }
  );
}

/**
 * Set a date field on a project item.
 */
async function setDateField(
  projectId: string,
  itemId: string,
  fieldId: string,
  date: string // ISO date string YYYY-MM-DD
): Promise<void> {
  const ok = getOctokit();
  await ok.graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $date: Date!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId,
        fieldId: $fieldId, value: { date: $date }
      }) { projectV2Item { id } }
    }`,
    { projectId, itemId, fieldId, date }
  );
}

/**
 * Find the option ID for a given field name and option value.
 * Uses fuzzy matching (case-insensitive, startsWith).
 */
function findOption(
  schema: ProjectSchema,
  fieldName: string,
  optionValue: string
): { fieldId: string; optionId: string } | null {
  const field = schema.fields.find(
    (f) => f.name.toLowerCase() === fieldName.toLowerCase() && f.options
  );
  if (!field?.options) return null;

  const lower = optionValue.toLowerCase();
  const option =
    field.options.find((o) => o.name.toLowerCase() === lower) ??
    field.options.find((o) => o.name.toLowerCase().startsWith(lower));
  if (!option) return null;

  return { fieldId: field.id, optionId: option.id };
}

/**
 * Find a date field by name.
 */
function findDateField(schema: ProjectSchema, fieldName: string): string | null {
  const field = schema.fields.find(
    (f) => f.name.toLowerCase() === fieldName.toLowerCase() && f.dataType === 'DATE'
  );
  return field?.id ?? null;
}

export interface ProjectFieldValues {
  /** e.g., "9.4" for Release */
  release?: string;
  /** e.g., "XS", "S", "M" for Size */
  size?: string;
  /** e.g., "P2 (Normal)" for Priority */
  priority?: string;
  /** e.g., "Kibana core" for Area */
  area?: string;
  /** e.g., "Kib: ES|QL" for Feature */
  feature?: string;
  /** YYYY-MM-DD for Serverless-pub */
  serverlessPubDate?: string;
}

export interface ProjectFieldResult {
  ok: boolean;
  /** Why it failed, when ok is false. */
  reason?: 'missing-scope' | 'error';
  /** Human-readable, UI-friendly message. */
  message?: string;
  /** Number of fields successfully set, when ok is true. */
  fieldsSet?: number;
}

/** OAuth scopes the GitHub Project mutations require (read schema + write fields). */
const PROJECT_SCOPE = 'project';

/**
 * Read the classic OAuth scopes carried by the current token, from the
 * `X-OAuth-Scopes` response header. Returns null when scopes can't be
 * determined — e.g. a fine-grained PAT, which doesn't report classic scopes
 * and uses a different permission model.
 */
export async function getTokenScopes(): Promise<string[] | null> {
  try {
    const ok = getOctokit();
    const res = await ok.request('GET /');
    const header = (res.headers as Record<string, string | undefined>)['x-oauth-scopes'];
    if (header == null) return null;
    return String(header)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Whether the token can read and write GitHub Projects v2.
 * Returns null when it can't be determined (assume OK in that case).
 */
export async function hasProjectScope(): Promise<boolean | null> {
  const scopes = await getTokenScopes();
  if (scopes === null) return null;
  return scopes.includes(PROJECT_SCOPE);
}

/**
 * Startup preflight: warn loudly if project board integration is configured
 * but the token can't write to projects. Turns the otherwise-silent per-issue
 * failure into an actionable banner. Never throws.
 */
export async function preflightProjectScope(projectConfigured: boolean): Promise<void> {
  if (!projectConfigured) return;
  const has = await hasProjectScope();
  if (has !== false) return; // true = OK; null = can't tell, don't cry wolf
  console.warn(
    [
      '',
      '⚠️  GitHub token is missing the `project` scope.',
      '   Issues will still be created, but they will NOT be added to the',
      '   project board or have Area / Size / Priority / Feature / Release set.',
      '',
      '   Fix it:   gh auth refresh -s project',
      '   Restart:  GITHUB_TOKEN=$(gh auth token) yarn dev',
      '',
    ].join('\n')
  );
}

/**
 * Add an issue to a GitHub Project and set field values.
 * Non-blocking: never throws. Returns a result describing what happened so
 * callers (and the UI) can surface failures instead of swallowing them.
 */
export async function setProjectFields(
  org: string,
  projectNumber: number,
  issueOwner: string,
  issueRepo: string,
  issueNumber: number,
  values: ProjectFieldValues
): Promise<ProjectFieldResult> {
  try {
    const ok = getOctokit();
    const schema = await getProjectSchema(org, projectNumber);

    // Get the issue's node ID
    const { data: issue } = await ok.issues.get({
      owner: issueOwner,
      repo: issueRepo,
      issue_number: issueNumber,
    });
    const issueNodeId = issue.node_id;

    // Add to project
    const itemId = await addIssueToProject(schema.projectId, issueNodeId);
    console.log(`  Added issue #${issueNumber} to project (item: ${itemId.slice(-8)})`);

    // Set fields in parallel
    const ops: Promise<void>[] = [];

    if (values.release) {
      const match = findOption(schema, 'Release', values.release);
      if (match) ops.push(setSelectField(schema.projectId, itemId, match.fieldId, match.optionId));
      else console.warn(`  Release option "${values.release}" not found in project`);
    }

    if (values.size) {
      const match = findOption(schema, 'Size', values.size);
      if (match) ops.push(setSelectField(schema.projectId, itemId, match.fieldId, match.optionId));
      else console.warn(`  Size option "${values.size}" not found in project`);
    }

    if (values.priority) {
      const match = findOption(schema, 'Priority', values.priority);
      if (match) ops.push(setSelectField(schema.projectId, itemId, match.fieldId, match.optionId));
      else console.warn(`  Priority option "${values.priority}" not found in project`);
    }

    if (values.area) {
      const match = findOption(schema, 'Area', values.area);
      if (match) ops.push(setSelectField(schema.projectId, itemId, match.fieldId, match.optionId));
      else console.warn(`  Area option "${values.area}" not found in project`);
    }

    if (values.feature) {
      const match = findOption(schema, 'Feature', values.feature);
      if (match) ops.push(setSelectField(schema.projectId, itemId, match.fieldId, match.optionId));
      else console.warn(`  Feature option "${values.feature}" not found in project`);
    }

    if (values.serverlessPubDate) {
      const fieldId = findDateField(schema, 'Serverless-pub');
      if (fieldId) ops.push(setDateField(schema.projectId, itemId, fieldId, values.serverlessPubDate));
      else console.warn(`  Serverless-pub date field not found in project`);
    }

    await Promise.all(ops);
    const count = ops.length;
    console.log(`  Set ${count} project field${count !== 1 ? 's' : ''}`);
    return { ok: true, fieldsSet: count };
  } catch (err) {
    const msg = String(err);
    const isScopeError =
      msg.includes('read:project') || (msg.includes('scope') && msg.includes('project'));
    if (isScopeError) {
      console.warn(
        'Project fields skipped: token missing `project` scope. Fix: gh auth refresh -s project'
      );
      return {
        ok: false,
        reason: 'missing-scope',
        message: 'Token missing `project` scope — run: gh auth refresh -s project',
      };
    }
    console.warn('Failed to set project fields (non-blocking):', err);
    return { ok: false, reason: 'error', message: msg };
  }
}
