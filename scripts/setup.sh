#!/bin/bash
set -e

echo ""
echo "  Docs Quest Scanner — Setup"
echo "  =========================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "  ✗ Node.js is required (v18+). Install it first."
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'.' -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "  ✗ Node.js v18+ required (found $(node -v))"
  exit 1
fi
echo "  ✓ Node.js $(node -v)"

# Install dependencies
echo ""
echo "  Installing dependencies..."
yarn install --silent 2>/dev/null || npm install --silent
echo "  ✓ Dependencies installed"

# GitHub token
echo ""
if [ -f .env ] && grep -q "GITHUB_TOKEN" .env; then
  echo "  ✓ .env file exists with GITHUB_TOKEN"
else
  echo "  Setting up GitHub token..."
  echo ""
  echo "  The tool needs a GitHub token with these scopes:"
  echo "    - repo (read issues, PRs)"
  echo "    - read:org (read org membership)"
  echo "    - project (read/write project fields)"
  echo ""

  if command -v gh &> /dev/null; then
    echo "  gh CLI detected. Checking auth..."
    GH_TOKEN=$(gh auth token 2>/dev/null || true)
    if [ -n "$GH_TOKEN" ]; then
      echo "GITHUB_TOKEN=$GH_TOKEN" > .env
      echo "  ✓ Token copied from gh CLI"
      echo ""
      echo "  Make sure your token has the 'project' scope:"
      echo "    gh auth refresh -s project"
    else
      echo "  gh CLI not authenticated. Run: gh auth login"
      exit 1
    fi
  else
    echo "  No gh CLI found. Create a token at:"
    echo "    https://github.com/settings/tokens"
    echo ""
    read -p "  Paste your token: " TOKEN
    echo "GITHUB_TOKEN=$TOKEN" > .env
    echo "  ✓ Token saved to .env"
  fi
fi

# Config
echo ""
if [ -f data/config.json ]; then
  echo "  ✓ data/config.json exists"
else
  echo "  Creating default config..."
  cp data/config.defaults.json data/config.json
  echo "  ✓ data/config.json created from defaults"
  echo ""
  echo "  Edit data/config.json to customize:"
  echo "    - title: display name in the UI header"
  echo "    - sourceRepo: the repo to scan for PRs"
  echo "    - targetRepo: where to create doc issues"
  echo "    - categories: team labels to monitor"
  echo "    - project: GitHub Project board integration"
  echo "    - featureMap: category → project Feature field"
fi

# Claude Code skill
echo ""
echo "  Installing Claude Code skill..."
echo ""
echo "  Where would you like to install the skill?"
echo "    1) Global — available in all projects (~/.claude/skills/)"
echo "    2) This repo only — available when working in this directory (.claude/skills/)"
echo ""
read -p "  Choice [1]: " SKILL_CHOICE
SKILL_CHOICE="${SKILL_CHOICE:-1}"

TOOL_DIR=$(pwd)

if [ "$SKILL_CHOICE" = "2" ]; then
  SKILL_DIR="$TOOL_DIR/.claude/skills/pr-docs-triage"
else
  SKILL_DIR="$HOME/.claude/skills/pr-docs-triage"
fi

mkdir -p "$SKILL_DIR"

cat > "$SKILL_DIR/skill.md" << SKILL_EOF
---
name: pr-docs-triage
version: 2.0.0
description: Triage PRs for documentation impact. Scans merged PRs by team label and release note label, assesses doc needs, and opens a review UI to create or dismiss doc issues.
allowed-tools: Bash, Read, Grep, Glob, Agent, WebFetch, mcp__github__search_pull_requests, mcp__github__pull_request_read, mcp__github__issue_read, mcp__github__issue_write, mcp__github__add_issue_comment, mcp__elastic-docs__search_docs, mcp__elastic-docs__find_related_docs, mcp__elastic-docs__get_document_by_url, mcp__elastic-docs__check_docs_coherence
---

# PR Docs Triage Skill

The triage tool lives at: \`$TOOL_DIR/\`

Run \`cd $TOOL_DIR && yarn scan\` to scan, then \`yarn dev\` to start the review UI.
SKILL_EOF

echo "  ✓ Skill installed at $SKILL_DIR"

echo ""
echo "  ✓ Setup complete!"
echo ""
echo "  Quick start:"
echo "    1. Edit data/config.json for your team"
echo "    2. In Claude Code, run /pr-docs-triage"
echo ""
