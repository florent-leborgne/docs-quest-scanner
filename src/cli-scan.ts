import { loadEnv } from './env.js';
loadEnv();

import { runScan } from './scanner.js';
import { loadQueue, saveQueue } from './config.js';
import { renderIssueBody } from './template.js';

async function main() {
  console.log('PR Docs Triage — Scanner\n');

  const queue = await runScan();

  // Render issue bodies
  for (const item of queue.items) {
    item.suggestedBody = renderIssueBody(item);
  }
  saveQueue(queue);

  // Print summary
  const categories = new Map<string, number>();
  for (const item of queue.items) {
    categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
  }

  console.log('\n── Queue summary ──');
  for (const [cat, count] of categories) {
    console.log(`  ${cat}: ${count} items`);
  }

  const needsDocs = queue.items.filter((i) => i.assessment.needsDocs === 'yes').length;
  const check = queue.items.filter((i) => i.assessment.needsDocs === 'check').length;
  const noDocs = queue.items.filter((i) => i.assessment.needsDocs === 'no').length;

  console.log(`\n  Needs docs: ${needsDocs}`);
  console.log(`  Check: ${check}`);
  console.log(`  No docs needed: ${noDocs}`);
  console.log(`\nRun 'yarn dev' to review in the browser.`);
}

main().catch((err) => {
  console.error('Scan failed:', err);
  process.exit(1);
});
