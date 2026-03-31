# Docs Quest Scanner

A documentation triage tool that scans merged GitHub PRs, assesses their documentation impact with AI, and helps you create doc issues through a review UI.

Built for use with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) as a skill — the AI handles PR analysis, doc gap detection, and issue drafting, while you review and decide in a local web UI.

## What it does

1. **Scans** merged PRs from a configured repo, filtered by team labels and release note labels
2. **Enriches** each PR with AI-powered analysis: summary, docs gap detection, effort estimate, existing page comparison
3. **Presents** a review UI where you triage items: accept (create issue) or skip
4. **Creates** GitHub issues with structured bodies, adds them to meta tracking issues, and sets GitHub Project board fields automatically

## Quick start

```bash
git clone https://github.com/florent-leborgne/docs-quest-scanner.git
cd docs-quest-scanner
./scripts/setup.sh
```

The setup script will:
- Install dependencies
- Configure your GitHub token
- Create a local `data/config.json` from defaults
- Install the Claude Code skill

Then edit `data/config.json` for your team (see [Configuration](#configuration) below), and run `/docs-quest-scanner` in Claude Code.

## Requirements

- Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- A GitHub token with the right scopes (see below)

### GitHub authentication

The recommended approach is to use the [GitHub CLI](https://cli.github.com/) (`gh`). The setup script will automatically pick up your token from it.

```bash
# Install gh if needed: https://cli.github.com/
gh auth login

# Add the project scope (needed for board integration)
gh auth refresh -s project
```

This gives you a token with `repo`, `read:org`, and `project` scopes — everything the tool needs.

Alternatively, you can create a [personal access token](https://github.com/settings/tokens) manually with those scopes and paste it during setup.

## Configuration

Edit `data/config.json` after setup. Key settings:

| Setting | Description | Example |
|---------|-------------|---------|
| `title` | Display name in the UI header | `"My Team Triage"` |
| `sourceRepo` | Repo to scan for PRs | `{ "owner": "my-org", "repo": "my-repo" }` |
| `targetRepo` | Repo where doc issues are created | `{ "owner": "my-org", "repo": "docs" }` |
| `categories` | Team labels to monitor, grouped by doc area | See below |
| `releaseNoteLabels` | PR labels that qualify for triage | `["release_note:feature", ...]` |
| `issueLabels` | Labels added to created issues | `["Team:Docs"]` |
| `project` | GitHub Project board integration | See below |

### Categories

Each category groups one or more team labels under a doc area name:

```json
{
  "categories": [
    {
      "name": "Search",
      "labels": ["Team:Search"]
    },
    {
      "name": "Dashboards",
      "labels": ["Team:Presentation", "Team:Visualizations"],
      "metaIssueHeading": "Dashboards and Visualizations"
    }
  ]
}
```

The optional `metaIssueHeading` is used when the meta tracking issue uses a different heading than the category name.

### GitHub Project integration

Auto-fill project board fields when creating issues:

```json
{
  "project": {
    "org": "my-org",
    "number": 42,
    "defaultArea": "My area",
    "defaultPriority": "P2 (Important)",
    "sizeMap": {
      "quick-fix": "XS",
      "update": "S",
      "new-content": "M"
    },
    "featureMap": {
      "Search": "Feature: Search",
      "Dashboards": "Feature: Dashboards"
    }
  }
}
```

Fields set automatically: **Release** (from version label), **Size** (from effort estimate), **Priority**, **Area**, **Feature** (from category mapping), **Serverless-pub** (computed deploy date).

Your GitHub token needs the `project` scope for this. If using the `gh` CLI:

```bash
gh auth refresh -s project
```

## Usage

In Claude Code, run:

```
/docs-quest-scanner
```

The skill will:
1. Run the scanner to fetch new PRs
2. Enrich each item with deep AI analysis
3. Start the review UI at http://localhost:3847

### Manual commands

```bash
yarn scan          # Scan only (no AI enrichment)
yarn dev           # Start the review UI
yarn start         # Start the UI (no file watching)
```

## How the review UI works

- **Queue tab**: Cards for each PR needing triage, with AI summary, availability info, and a suggested issue
- **Accept quest**: Creates the issue, adds it to the meta tracking issue, sets project fields
- **Skip**: Marks the item as not needing docs (with reason)
- **Mark scan complete**: Advances the scan timestamp so the next run only picks up new PRs

## Data files

All state is in `data/` (gitignored except defaults):

| File | Purpose |
|------|---------|
| `config.defaults.json` | Default settings (committed) |
| `config.json` | Your local overrides (gitignored) |
| `queue.json` | Current triage queue |
| `history.json` | All past decisions (created/dismissed) |
| `last_run.json` | Timestamp of last completed scan |

## Issue template

The generated issue body follows this structure:

1. **Summary** — AI-generated description of the change and why it needs docs
2. **Resources** — PR links, product issues, screenshots
3. **Availability** — Stack version, serverless deploy week, feature status
4. **Suggested edits** — Page-level docs gaps with current content quotes and suggested changes

The template is at `templates/issue-template.md` (Handlebars syntax) and can be customized.

## Re-scan behavior

- Each scan picks up PRs merged since the last completed scan
- Already-processed PRs (in history) are filtered out
- The scan date only advances when you click "Mark scan complete"
- Re-scanning re-fetches the same date range, merging with the existing queue and preserving your edits

## License

MIT

## Author

Crafted with hope by max lvl blacksmith [Florent LB](https://github.com/florent-leborgne)
