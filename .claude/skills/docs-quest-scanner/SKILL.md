---
name: docs-quest-scanner
version: 3.4.0
description: Triage PRs for documentation impact. Scans merged PRs by team label and release note label, assesses doc needs, and opens a review UI to create or dismiss doc issues. Use when doing weekly docs triage, checking what's new in a Kibana release, or when asked to scan PRs for doc impact.
allowed-tools: Bash, Read, Grep, Glob, Agent, WebFetch, mcp__github__search_pull_requests, mcp__github__pull_request_read, mcp__github__issue_read, mcp__github__issue_write, mcp__github__add_issue_comment, mcp__elastic-docs__search_docs, mcp__elastic-docs__find_related_docs, mcp__elastic-docs__get_document_by_url, mcp__elastic-docs__check_docs_coherence
sources:
  - https://www.elastic.co/docs/contribute-docs/content-types
  - https://www.elastic.co/docs/contribute-docs/content-types/overviews
  - https://www.elastic.co/docs/contribute-docs/content-types/how-tos
  - https://www.elastic.co/docs/contribute-docs/content-types/tutorials
  - https://www.elastic.co/docs/contribute-docs/content-types/troubleshooting
  - https://www.elastic.co/docs/contribute-docs/content-types/changelogs
---

# PR Docs Triage Skill

You are a documentation triage assistant for Elastic's Kibana documentation. Your job is to scan merged PRs, assess their documentation impact with deep doc analysis, and help the user create doc issues.

## Tool location

The triage tool lives at: `~/Documents/github/docs-quest-scanner/`

## Workflow

### Step 1: Run the scanner

```bash
cd ~/Documents/github/docs-quest-scanner && yarn scan
```

This fetches merged PRs from `elastic/kibana` matching the configured team labels, filtered to only include PRs with a release note label (`release_note:breaking`, `release_note:deprecation`, `release_note:feature`, `release_note:enhancement`). It filters out already-processed PRs and writes a triage queue to `data/queue.json`.

The scanner automatically:
- Deduplicates PRs that appear in multiple categories (adds `alsoAppliesTo` field)
- Extracts screenshots/GIFs from PR bodies (stored in `assessment.screenshots`)
- Extracts release note text from PR bodies (stored in `releaseNoteText`)
- Detects version from PR labels (e.g., `v9.4.0`)
- Computes serverless estimates (merge date + 7 days)

### Step 2: Enrich with deep AI assessment

After the scan, read `data/queue.json` and for each item, perform deep enrichment. **Use parallel Agent calls** to process items in batches of 6-8 for efficiency. Each batch agent should:

#### 2a. Understand the change and verify the premise

Read the PR body, changed files, and release note text. Then do two things before any doc search:

**API-only early exit:** Check the changed file paths for these patterns:
- All changes in `*/server/routes/`, `*/server/schemas/`, `*/server/saved_objects/`, `*/common/types/` with nothing in `*/public/`
- Only `*.test.ts`, `*.mock.ts`, `index.ts` re-exports, CI config, dependency bumps

If the file pattern is purely server-side with zero `*/public/` or UI component files, and the PR body contains no mention of new UI elements, settings, or user-facing behavior — mark `needsDocs: "no"`, `confidence: 0.9`, write a one-sentence `reasoning`, and **stop**. Do not run the doc search.

**UI signal detection:** Before proceeding to doc analysis, look for concrete signals in the changed files:
- i18n strings: `i18n.translate(`, `.defaultMessage:` — strong signal of user-visible text change
- Settings: `uiSettings`, `experimentalFeatures`, `featureFlags`, `config.` — new configurable behavior
- UI components: files in `*/public/components/`, `*/public/pages/`, `*/public/hooks/` — new or changed UI

**Premise verification:** Cross-check the PR title and release note text against the diff. Assign `premiseAccuracy`:
- `"accurate"` — the diff clearly supports the stated user-facing change
- `"partially-accurate"` — some of the claim is in the diff, but parts are missing or overstated
- `"stale"` — the feature exists but the PR description describes an older state
- `"unsupported"` — the diff is a refactor, test fix, or internal change that does not match the stated user-facing claim

If `premiseAccuracy` is `"partially-accurate"`, `"stale"`, or `"unsupported"`: reduce `confidence` by 0.2–0.4, note the discrepancy in one clause of `reasoning`, and narrow `docsGap` to only what the diff actually supports. Do not scope docs work for claims the diff does not back up.

#### 2b. Deep doc analysis with content-type and assembly awareness

For each item's `existingDocs` URLs (and any additional pages found via search):
1. **Read the actual doc page** using `mcp__elastic-docs__get_document_by_url` with `includeBody: true`
2. **Search broadly** using `mcp__elastic-docs__search_docs` and `mcp__elastic-docs__find_related_docs` to find ALL pages that mention the feature — not just the obvious ones
3. **Compare** what the docs currently say vs what the PR changes
4. **Produce a `docsGap` array** — but only include entries that pass all quality gates below

**docsGap quality rules — be strict:**
- **Only flag a gap if the page currently discusses the topic at a level of detail where the omission would be wrong or misleading.** A page that says "the default is Prefix" when it's now Contains is a real gap. A generic overview page that doesn't list specific panel types is NOT a gap just because a new panel type exists.
- **Don't suggest adding specifics to pages that stay deliberately generic.** If a page says "save panels to the library" without listing which panel types support this, don't suggest adding "including Markdown." The page is correct at its chosen level of abstraction.
- **Do flag pages that make factually incorrect statements** due to the change (wrong defaults, wrong behavior descriptions, outdated status badges).
- **Do flag pages that describe a workflow that now has a new step or option** that users would miss without the update.
- **Don't pad the list.** 1-2 high-quality gaps are better than 5 marginal ones. If there's no real gap, return an empty array — that's fine.

**Assembly check — run before finalising each gap entry:**

For any gap where `actionType` would be `create-how-to` or `create-overview` (a new page), run this two-stage check:

*Stage 1 — sibling page check:*
- Use `mcp__elastic-docs__find_related_docs` to inspect sibling pages in the same section
- If the section already has a closely related page that covers adjacent territory, downgrade to `add-section` instead — prefer the smallest viable change
- Only proceed to stage 2 if no existing sibling page is an appropriate fit

*Stage 2 — content type validation (only for remaining `create-*` candidates):*
- Fetch the relevant guideline page live using `mcp__elastic-docs__get_document_by_url` with `includeBody: true`:
  - For `create-how-to`: `https://www.elastic.co/docs/contribute-docs/content-types/how-tos`
  - For `create-overview`: `https://www.elastic.co/docs/contribute-docs/content-types/overviews`
- Verify the recommended content actually meets the definition: a how-to must be task-based with a clear user goal and sequential steps; an overview must be concept/reference material not tied to a specific task
- If the content fits neither cleanly, downgrade to `add-section` on the most relevant existing page
- If the content type is confirmed, keep the `create-*` recommendation

For any gap that would affect navigation, section structure, or create a need for redirects or cross-reference updates in sibling pages, fold a brief note into the `gap` text (e.g., "Update X; also check the cross-reference in the parent overview page."). Do not add a separate field — keep it in `gap`.

**Apply cumulative documentation rules when writing each gap entry.** Elastic docs serve all active versions simultaneously — refer to the Cumulative documentation model section for the full rules. Key points:
- Ask: do users on earlier versions still need the old content? If yes, suggest preserving it alongside new content, not replacing it.
- Choose the lightest format: tagged paragraph/admonition → tagged list items → `applies-switch` tabs.
- For versioned products, lifecycle state changes are appended (`stack: ga 9.1+, preview =9.0`); for unversioned, the state is replaced.
- GA/deprecated feature removed from a versioned product → keep content, suggest `stack: removed 9.x`. Removed from unversioned only → content can be deleted.
- Never suggest version numbers in prose adjacent to a badge.

**Assign `actionType` for each entry** (stored in the queue for effortTag derivation, not rendered in the issue):
- `"update-existing"` — change a value, statement, or step on a page that already covers this topic
- `"add-section"` — add a new heading + content block to an existing page
- `"create-how-to"` — new standalone task-based page (confirmed by both assembly stages)
- `"create-overview"` — new concept or reference page (confirmed by both assembly stages)
- `"review-only"` — page may be affected but evidence is too weak to prescribe a specific change; drop this entry unless the gap is high confidence

Each entry:
```json
{
  "pageUrl": "https://www.elastic.co/docs/...",
  "pageTitle": "Page title",
  "section": "Specific heading within the page",
  "currentContent": "Brief quote of what the docs currently say",
  "gap": "What needs to change and why",
  "actionType": "update-existing"
}
```

#### 2c. Assess doc impact

- `release_note:breaking` or `release_note:deprecation` → almost always needs docs
- `release_note:feature` → likely needs docs
- `release_note:enhancement` → needs docs unless purely internal (see heuristics below)
- Assign `needsDocs`: `"yes"`, `"no"`, or `"check"`
- Assign `confidence`: 0.0–1.0 — then apply the premise accuracy adjustment from step 2a
- Assign `premiseAccuracy` from step 2a

**For `needsDocs: "no"` items that did not hit the API-only early exit in step 2a:**
Run the full doc analysis from step 2b — read page bodies, compare current content to the diff, apply the assembly check. If the full analysis surfaces a real gap (a page that currently says something the PR changes), upgrade `needsDocs` to `"check"` and note in `reasoning` that the initial assessment was revised based on doc content. If no real gap is found, leave `needsDocs: "no"` but still populate `existingDocs` with any related pages found. This catches cases where the heuristic assessment was wrong.

#### 2d. Write the issue title

Frame from the user's perspective — what they can now do or what changed. Not the PR title.
- Good: "Save Markdown panels to the Visualize library"
- Good: "Options List controls now default to Contains search"
- Bad: "Add library support for Markdown embeddable" (dev-facing)

If `premiseAccuracy` is not `"accurate"`, limit the title to what the diff actually confirms.

#### 2e. Write the summary

2-4 sentences explaining what changed and what it means for users. Incorporate the release note text from the PR body if available. Be specific: new UI elements, new settings, changed defaults, new commands. This goes into the issue body and should give a docs writer enough context to start working.

#### 2f. Assign effort tag

Derive from the `actionType` values in `docsGap`:
- Any entry is `create-how-to` or `create-overview` → `"new-content"`
- Any entry is `add-section` (and none are `create-*`) → `"new-content"` if the section is substantial, otherwise `"update"`
- All entries are `"update-existing"` → `"update"` if a section rewrite or screenshots, `"quick-fix"` if a value/sentence change
- Empty `docsGap` → `"quick-fix"` only if a badge/status update is needed, otherwise omit

#### 2g. Detect metadata

- **Feature status**: look for labels like `Feature:Preview`, `Feature:Beta`, or body mentions. Only set if clearly identifiable — omit if unknown (do NOT set to "TBD")
- **Feature flags**: look for `featureFlags`, `experimentalFeatures`, `uiSettings`, `config.` references
- **Product issues**: linked GitHub issues (Closes #X, Fixes #X, or issue URLs)

#### 2h. Update queue.json

Update `data/queue.json` with the enriched `assessment` (including `docsGap`, `effortTag`, `existingDocs`, `summary`, `needsDocs`, `confidence`, `premiseAccuracy`) and `suggestedTitle`. Clear `suggestedBody` to empty string so it re-renders fresh from the template.

**Always populate `suggestedTitle`**, even when `needsDocs` is `"no"` — the user may still decide to create an issue, so a blank title is unhelpful.

**Always populate `assessment.reasoning`** — this is rendered in the issue template as "Why this needs docs: …". Write a short 1-sentence rationale (e.g. "New UI toggle that changes the documented layout options." or "Purely cosmetic font change with no user-configurable settings."). If premise accuracy reduced confidence, include that in the reasoning (e.g. "PR description claims X but diff only confirms Y."). Do not omit it even for `needsDocs: "no"` items.

### Step 3: Start the review UI

```bash
cd ~/Documents/github/docs-quest-scanner && yarn dev
```

Tell the user: "The triage review UI is running at http://localhost:3847 — open it in your browser to review and create issues."

### Step 4: If asked to create issues directly

If the user asks you to create issues without the UI (e.g., for a specific PR or queue item), use the GitHub MCP tools:

1. Use `mcp__github__issue_write` to create the issue on the target repo
2. Use `mcp__github__issue_read` to find the meta issue (search for "Kibana X.Y" checklist)
3. Use `mcp__github__issue_write` to update the meta issue body with the new issue reference

## Configuration

Config is at `~/Documents/github/docs-quest-scanner/data/config.json` (falls back to `config.defaults.json`).

Key settings:
- `sourceRepo`: `elastic/kibana`
- `targetRepo`: `elastic/docs-content` (or `elastic/docs-content-internal`)
- `categories`: team labels grouped by doc area. Each category has an optional `metaIssueHeading` field — when set, this heading is used to match the section in the meta issue instead of the category `name`. This avoids creating duplicate sections when the meta issue uses different headings than the scan categories.
- `versionLabelPattern`: regex to detect version labels on PRs (default: `^v\d+\.\d+\.\d+$`)
- `releaseNoteLabels`: labels that qualify a PR for triage (breaking, deprecation, feature, enhancement)
- `issueLabels`: labels for created issues (e.g., `Team:Experience`)

## Issue template

The template is at `~/Documents/github/docs-quest-scanner/templates/issue-template.md`. It uses Handlebars syntax and includes: summary, reasoning, screenshots, PR links, product issue, cross-category note, availability table, and a suggested edits section with page-level and section-level findings.

## Re-scan behavior

- The scanner reads `data/last_run.json` to know when to start scanning from
- PRs that are in `data/history.json` (created or dismissed) are filtered out
- The last_run date only advances when the user clicks "Mark scan complete" in the UI, and it advances to the **scan date** (`queue.scannedAt`), not the current date — so there is no gap even if triage takes several days
- Re-running the scan fetches the same date range and merges with the existing queue (preserving user edits)

## Version handling

- The scan does not filter by version — it fetches all PRs matching team + release note labels since the last run date
- Each PR's version is auto-detected from its labels (matching `versionLabelPattern`)
- When an issue is created, the tool auto-detects the right meta issue for that version, adds the issue link under the matching section (using `metaIssueHeading` if configured), and updates the `_[Last check: ...]_` date in that section
- This means the tool naturally picks up new versions (e.g., v9.5.0) without config changes

## Assessment heuristics

When you're unsure about doc impact, lean toward `check` rather than `no`. It's better to flag something for review than to miss it.

**Things that almost always need docs:**
- New UI elements (buttons, panels, tabs, pages)
- New configuration options or settings
- Behavior changes (even "small" ones like default value changes)
- Deprecations and removals
- GA promotions (status badge updates on existing doc pages)

**Things that do NOT need docs:**
- **Pure API-level changes with no UI impact**: new routes, added request/response parameters, changed HTTP methods or status codes, new saved object types, schema changes — unless there is a corresponding change in the Kibana UI that users interact with. API-only changes are consumed by developers, not end-user docs readers. Mark these as `needsDocs: "no"`. Use the file pattern check in step 2a to detect these early.
- Test fixes, CI changes
- Internal refactors that don't change behavior
- Dependency bumps
- Backports (the original PR should have been triaged)
- Cosmetic-only styling changes (font weight, colors) with no new settings
- In-product onboarding tooltips/tours (self-contained, no external docs needed)
- Performance improvements that don't change UX
- Bug fixes that don't change documented behavior

## Cumulative documentation model

Elastic docs (V3, elastic.co/docs) are cumulative — a single page stays valid across versions and deployment types simultaneously. This shapes how `docsGap` entries and suggested edits should be written.

### Start with two questions

Before suggesting any doc change involving version-scoped content, ask:

1. **Do users on previous versions still need the old information?** Usually yes — docs serve all active versions. Preserve existing content alongside new content rather than replacing it.
2. **What is the simplest format that works?** Choose the lightest option:
   - A tagged paragraph or admonition — for additive changes that leave existing content untouched
   - Tagged bullet points — for lists where some items apply only to certain versions
   - `applies-switch` tabs — only when content truly diverges and can't be merged into a single flow

### When to suggest an applies_to tag

Suggest adding or updating an `applies_to` tag when:
- A feature is newly introduced in a specific version
- A feature changes lifecycle state (preview → beta → GA → deprecated → removed)
- Availability differs between stack and serverless, or across deployment types (ECE, ECK, ECH, self-managed)

Do **not** suggest tagging: typo fixes, rewording, restructuring, or features that are GA in unversioned (serverless) products with no lifecycle change to call out.

### Which syntax to suggest

There are three forms — choose based on what's being scoped:

| Scope | Form |
|-------|------|
| Whole page | YAML frontmatter (`applies_to: stack: ga 9.4`) |
| Whole section | Fenced block immediately after the heading |
| List item, definition term, table cell | Inline role at start/end of that element |

Never suggest inline `{applies_to}` mid-sentence in prose, or floating between sentences in a paragraph — flag for restructuring instead.

### Version syntax

| Intent | Syntax |
|--------|--------|
| 9.4 and later | `stack: ga 9.4` or `stack: ga 9.4+` |
| Exact version only | `stack: beta =9.1` |
| Multiple lifecycle states | `stack: ga 9.1+, preview =9.0` (newest first) |
| Serverless (unversioned) | `serverless: ga` |
| Unavailable in a context | `serverless: unavailable` (use sparingly) |

Do not suggest version numbers in prose adjacent to a badge — they contradict the "Planned" badge text before release.

### Lifecycle changes

- **Versioned (stack):** append the new state, keep the old: `stack: ga 9.1+, preview =9.0`
- **Unversioned (serverless):** replace the old state entirely

### Removals

- GA/deprecated feature removed from a versioned product → keep the content, suggest adding `stack: removed 9.x`
- Feature removed from an unversioned product only → content can be deleted
- Feature that was only ever preview/beta → content can be deleted regardless of product type

### Preserve existing content

Docs serve all active versions. When a feature changes behavior, don't suggest replacing old content — suggest adding version-scoped content alongside it, unless the old version is no longer supported.

## Skip reasons

The UI offers two skip actions to build signal over time:
- **"Skip – no docs"**: the change genuinely doesn't need documentation (internal, cosmetic, bug fix, etc.)
- **"Skip – already tracked"**: the change needs docs but is already tracked elsewhere (existing issue, another team's checklist, etc.)

Both are stored in `data/history.json` with the `reason` field. Over time, reviewing the "no docs needed" history can help refine the assessment heuristics above — patterns of what gets dismissed suggest the AI enrichment should mark those as `needsDocs: "no"` more confidently.

## Key technical notes

- The GET `/api/queue` endpoint always re-renders `suggestedBody` from the template (no caching). Enrichment scripts should clear `suggestedBody` to `""` so the server renders fresh.
- The `/api/user` endpoint uses `.then()/.catch()` instead of async/await due to Express 5 route handler limitations.
- Template cache must be cleared after editing `templates/issue-template.md`: `curl -s -X POST http://localhost:3847/api/clear-template-cache`
