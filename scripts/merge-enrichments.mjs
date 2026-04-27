import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const queuePath = path.join(root, 'data', 'queue.json');
const enrichPath = path.join(root, 'data', 'enrichments.json');

const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
const enrichments = JSON.parse(fs.readFileSync(enrichPath, 'utf8'));

let applied = 0;
let missing = [];

for (const item of queue.items) {
  const e = enrichments[item.id];
  if (!e) {
    missing.push(item.id);
    continue;
  }

  item.assessment = item.assessment || {};
  item.assessment.needsDocs = e.needsDocs;
  item.assessment.confidence = e.confidence;
  item.assessment.premiseAccuracy = e.premiseAccuracy;
  item.assessment.summary = e.summary;
  item.assessment.reasoning = e.reasoning;
  item.assessment.existingDocs = e.existingDocs || [];
  item.assessment.docsGap = e.docsGap || [];
  if (e.effortTag) item.assessment.effortTag = e.effortTag;
  else delete item.assessment.effortTag;
  if (e.featureStatus) item.assessment.featureStatus = e.featureStatus;
  else delete item.assessment.featureStatus;
  if (e.featureFlags && e.featureFlags.length) item.assessment.featureFlags = e.featureFlags;
  else delete item.assessment.featureFlags;

  if (e.suggestedTitle) item.suggestedTitle = e.suggestedTitle;

  // Clear suggestedBody so the server re-renders fresh from the template.
  item.suggestedBody = '';

  applied++;
}

fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
console.log(`Applied ${applied} enrichments.`);
if (missing.length) console.log(`Missing enrichments for: ${missing.join(', ')}`);
