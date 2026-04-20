import { Octokit } from '@octokit/rest';
import type { Config, PullRequest } from './types.js';

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
 */
export async function searchMergedPRs(
  config: Config,
  teamLabels: string[],
  sinceDate: string
): Promise<PullRequest[]> {
  const ok = getOctokit();
  const { owner, repo } = config.sourceRepo;

  // Build label query: team label + date range (no version filter)
  const teamQ = teamLabels.map((l) => `label:"${l}"`).join(' ');
  const query = `repo:${owner}/${repo} is:pr is:merged merged:>=${sinceDate} ${teamQ}`;

  const allPRs: PullRequest[] = [];
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
      allPRs.push({
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

  return allPRs;
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
 * Auto-detect the meta issue for a given Kibana version.
 * Searches for issues with title matching "Kibana X.Y Analytics and Platform checklist".
 */
export async function findMetaIssue(
  owner: string,
  repo: string,
  versionLabel: string
): Promise<{ number: number; title: string; body: string } | null> {
  const ok = getOctokit();

  // Extract major.minor from "v9.4.0" -> "9.4"
  const versionMatch = versionLabel.match(/v?(\d+\.\d+)/);
  if (!versionMatch) return null;
  const version = versionMatch[1];

  const query = `repo:${owner}/${repo} is:issue is:open "Kibana ${version}" in:title`;
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
    const lastListIdx = lines.findLastIndex((l) => l.trim().startsWith('- '));

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

/**
 * Add an issue to a GitHub Project and set field values.
 * Non-blocking: logs warnings on failure but never throws.
 */
export async function setProjectFields(
  org: string,
  projectNumber: number,
  issueOwner: string,
  issueRepo: string,
  issueNumber: number,
  values: ProjectFieldValues
): Promise<void> {
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
  } catch (err) {
    console.warn('Failed to set project fields (non-blocking):', err);
  }
}
