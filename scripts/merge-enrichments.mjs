import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const queuePath = path.join(root, 'data', 'queue.json');
const enrichPath = path.join(root, 'data', 'enrichments.json');

const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
const rawEnrichments = JSON.parse(fs.readFileSync(enrichPath, 'utf8'));

// Accept both flat and nested-under-"assessment" shapes. Agents drift between
// the two and silent field drops show up as "undefined" pills in the UI.
const enrichments = {};
let normalizedNested = 0;
const featureFields = new Set(['suggestedTitle']);
const assessmentFields = new Set([
  'needsDocs', 'confidence', 'premiseAccuracy', 'summary', 'reasoning',
  'existingDocs', 'docsGap', 'effortTag', 'featureStatus', 'featureFlags',
  'featureFlag', 'productIssue', 'screenshots',
  'serverlessApplies', 'serverlessEstimate'
]);
for (const [id, raw] of Object.entries(rawEnrichments)) {
  const flat = { ...raw };
  if (raw.assessment && typeof raw.assessment === 'object') {
    normalizedNested++;
    for (const [k, v] of Object.entries(raw.assessment)) {
      if (assessmentFields.has(k) && flat[k] === undefined) flat[k] = v;
    }
    delete flat.assessment;
  }
  enrichments[id] = flat;
}
if (normalizedNested) console.log(`Normalized ${normalizedNested} nested enrichments.`);

let applied = 0;
let missing = [];

for (const item of queue.items) {
  const e = enrichments[item.id];
  if (!e) {
    missing.push(item.id);
    continue;
  }

  item.assessment = item.assessment || {};
  // Only overwrite a field when the enrichment explicitly provides it.
  // Title-only or partial enrichments must not wipe existing values with undefined.
  if (e.needsDocs !== undefined) item.assessment.needsDocs = e.needsDocs;
  if (e.confidence !== undefined) item.assessment.confidence = e.confidence;
  if (e.premiseAccuracy !== undefined) item.assessment.premiseAccuracy = e.premiseAccuracy;
  if (e.summary !== undefined) item.assessment.summary = e.summary;
  if (e.reasoning !== undefined) item.assessment.reasoning = e.reasoning;
  if (e.existingDocs !== undefined) item.assessment.existingDocs = e.existingDocs || [];
  if (e.docsGap !== undefined) item.assessment.docsGap = e.docsGap || [];
  if (e.effortTag) item.assessment.effortTag = e.effortTag;
  else if (e.effortTag === null) delete item.assessment.effortTag;
  if (e.featureStatus) item.assessment.featureStatus = e.featureStatus;
  else if (e.featureStatus === null) delete item.assessment.featureStatus;
  // Serverless applicability gates the availability cell ('no' → "N/A").
  if (e.serverlessApplies) item.assessment.serverlessApplies = e.serverlessApplies;
  else if (e.serverlessApplies === null) delete item.assessment.serverlessApplies;
  if (e.serverlessEstimate) item.assessment.serverlessEstimate = e.serverlessEstimate;
  else if (e.serverlessEstimate === null) delete item.assessment.serverlessEstimate;
  // Accept singular featureFlag string or plural featureFlags array.
  const flags = e.featureFlags || (e.featureFlag ? [e.featureFlag] : null);
  if (flags && flags.length) item.assessment.featureFlags = flags;
  else delete item.assessment.featureFlags;

  if (e.suggestedTitle) item.suggestedTitle = e.suggestedTitle;

  // Clear suggestedBody so the server re-renders fresh from the template.
  item.suggestedBody = '';

  applied++;
}

fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
console.log(`Applied ${applied} enrichments.`);
if (missing.length) console.log(`Missing enrichments for: ${missing.join(', ')}`);
