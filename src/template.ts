import Handlebars from 'handlebars';
import { loadIssueTemplate, loadConfig } from './config.js';
import type { QueueItem } from './types.js';

let compiledTemplate: HandlebarsTemplateDelegate | null = null;

/** Extract all version labels from a queue item's PR labels. */
function extractVersions(item: QueueItem): string {
  const re = /^v\d+\.\d+\.\d+$/;
  const set = new Set<string>();
  for (const pr of item.prs) {
    for (const label of pr.labels) {
      if (re.test(label)) set.add(label);
    }
  }
  return [...set].sort().join(', ');
}

/** Compute the serverless deploy week from a merge date (merge + 7d → next Monday–Friday). */
function computeServerlessWeek(mergedAt?: string): string | null {
  if (!mergedAt) return null;
  const d = new Date(mergedAt);
  d.setDate(d.getDate() + 7);
  const day = d.getDay();
  const diff = day === 0 ? -6 : -(day - 1);
  d.setDate(d.getDate() + diff);
  const mon = new Date(d);
  const fri = new Date(d);
  fri.setDate(fri.getDate() + 4);
  const fmt = (dt: Date) => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(mon)}–${fmt(fri)}`;
}

function getTemplate(): HandlebarsTemplateDelegate {
  if (!compiledTemplate) {
    const raw = loadIssueTemplate();
    compiledTemplate = Handlebars.compile(raw);
  }
  return compiledTemplate;
}

/** Clear cached template (e.g., after editing the template file) */
export function clearTemplateCache(): void {
  compiledTemplate = null;
}

/**
 * Render the issue body for a queue item, incorporating user edits.
 */
export function renderIssueBody(item: QueueItem, createdBy?: string): string {
  const config = loadConfig();
  const template = getTemplate();
  const edits = item.userEdits ?? {};

  const data = {
    summary: item.assessment.summary,
    reasoning: item.assessment.reasoning ?? null,
    prs: item.prs.map((pr) => ({
      number: pr.number,
      url: pr.url,
      title: pr.title,
    })),
    productIssue: item.assessment.productIssue,
    alsoAppliesTo: item.alsoAppliesTo?.length
      ? item.alsoAppliesTo.join(', ')
      : null,
    stackVersion: extractVersions(item) || 'TBD',
    serverlessEstimate:
      edits.serverlessEstimate ??
      item.assessment.serverlessEstimate ??
      computeServerlessWeek(
        item.prs.map((pr) => pr.mergedAt).filter(Boolean).sort().pop()
      ) ??
      'TBD',
    featureStatus:
      edits.featureStatus ??
      item.assessment.featureStatus ??
      null,
    featureFlag:
      edits.featureFlag ??
      item.assessment.featureFlag ??
      'None — active by default',
    existingDocs: item.assessment.existingDocs?.length
      ? item.assessment.existingDocs
      : null,
    docsGap: item.assessment.docsGap?.length
      ? item.assessment.docsGap
      : null,
    screenshots: item.assessment.screenshots?.length
      ? item.assessment.screenshots
      : null,
    createdBy: createdBy ?? null,
  };

  return template(data);
}
