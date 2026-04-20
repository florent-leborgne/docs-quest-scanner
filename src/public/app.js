// @ts-check

/** @typedef {import('../types.js').QueueItem} QueueItem */
/** @typedef {import('../types.js').Queue} Queue */
/** @typedef {import('../types.js').History} History */
/** @typedef {import('../types.js').Config} Config */

// ── State ───────────────────────────────────────────────

let state = {
  /** @type {Queue} */
  queue: { scannedAt: '', version: '', items: [] },
  /** @type {History} */
  history: { entries: [] },
  /** @type {Config | null} */
  config: null,
  lastRun: { lastRunDate: null, lastRunVersion: null },
  user: null,
  activeTab: 'queue',
};

// ── API helpers ─────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ── Init ────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await refreshAll();
  bindEvents();
  loadUserAvatar();
});

async function loadUserAvatar() {
  try {
    const user = await api('/user');
    state.user = user;
    if (user.avatarUrl) {
      const img = document.getElementById('user-avatar');
      img.src = user.avatarUrl;
      img.alt = user.login;
      img.title = user.login;
      img.style.display = '';
    }
    renderHeroGreeting();
  } catch {
    // Silently ignore — avatar is non-essential
  }
}

const QUEST_ANIMALS = [
  {
    svg: `<svg class="quest-animal" viewBox="0 0 24 20"><path d="M5,18 V11 M8,18 V11 M16,18 V11 M19,18 V11 M4,11 Q12,8 20,11 M5,11 V5 Q5,3 6,2 L8,3 L6,4 M20,11 Q22,10 21,12"/></svg>`,
    tooltips: ['Majestic as a llama on a mountaintop', 'Steady and sure-footed, like a llama carrying the team', 'The llama of documentation — calm, reliable, unstoppable'],
  },
  {
    svg: `<svg class="quest-animal" viewBox="0 0 22 20"><path d="M4,18 V11 M7,18 V11 M15,18 V11 M18,18 V11 M3,11 Q11,8 19,11 M4,11 V8 L3,6 M4,8 L3,4 M4,8 L5,4 M4,8 L4,11 M3,9 L2,11"/></svg>`,
    tooltips: ['Stubborn as a goat — in the best way', 'Climbs any mountain of PRs, goat-style', 'Has the heart of a mountain goat: fearless and sure'],
  },
  {
    svg: `<svg class="quest-animal" viewBox="0 0 24 20"><path d="M6,18 V12 M9,18 V12 M16,18 V12 M19,18 V12 M5,12 Q12,9 20,12 M5,12 L4,9 L5,6 L4,3 M5,6 L6,3 M5,8 L7,7 M20,12 Q23,8 21,6"/></svg>`,
    tooltips: ['Leads the pack like a wolf in moonlight', 'Loyal as a wolf — the team is lucky to have you', 'Sharp instincts, wolf-level focus'],
  },
  {
    svg: `<svg class="quest-animal" viewBox="0 0 28 18"><path d="M14,8 L8,4 L3,2 L1,5 L6,6 L10,7 M14,8 L20,4 L25,2 L27,5 L22,6 L18,7 M14,8 V14 L12,16 L14,15 L16,16 L14,14 M13,7 L11,8 L12,7"/></svg>`,
    tooltips: ['Eagle-eyed reviewer, nothing gets past you', 'Soaring above the PR queue with eagle grace', 'Vision of an eagle — spots every doc gap'],
  },
  {
    svg: `<svg class="quest-animal" viewBox="0 0 26 16"><path d="M1,10 Q7,6 12,8 L12,3 L14,8 Q20,6 24,10 Q20,12 14,11 Q8,12 1,10 M24,10 L26,8 M24,10 L26,12"/></svg>`,
    tooltips: ['Cuts through the backlog like a shark through water', 'Shark mode: fast, focused, unstoppable', 'The documentation shark — always moving forward'],
  },
  {
    svg: `<svg class="quest-animal" viewBox="0 0 24 20"><path d="M6,18 V12 M9,18 V12 M16,18 V12 M19,18 V12 M5,12 Q12,9 20,12 M5,12 L4,9 L3,6 M4,9 L5,6 M4,9 L6,8 M20,12 Q24,10 22,7 Q23,9 21,11"/></svg>`,
    tooltips: ['Clever as a fox — always finds the right page to update', 'Fox-like agility through the triage queue', 'Sly fox energy: quick, sharp, and charming'],
  },
  {
    svg: `<svg class="quest-animal" viewBox="0 0 24 16"><path d="M5,12 L4,14 M9,12 L8,14 M15,12 L16,14 M19,12 L20,14 M4,10 Q12,3 20,10 Q12,13 4,10 M8,7 Q12,5 16,7 M4,10 L2,9 L3,8"/></svg>`,
    tooltips: ['Slow and steady wins the triage, turtle wisdom', 'Tough shell, warm heart — the turtle way', 'Turtle power: methodical, thorough, legendary'],
  },
  {
    svg: `<svg class="quest-animal" viewBox="0 0 20 20"><path d="M10,2 Q4,2 4,8 L2,14 L6,12 L6,16 L10,18 L14,16 L14,12 L18,14 L16,8 Q16,2 10,2 M7,7 A1.5,1.5 0 1,0 7,10 A1.5,1.5 0 1,0 7,7 M13,7 A1.5,1.5 0 1,0 13,10 A1.5,1.5 0 1,0 13,7 M9,11 L10,12 L11,11"/></svg>`,
    tooltips: ['Wise as an owl — sees what others miss', 'The owl of the docs team: watchful, wise, wonderful', 'Night owl energy: gets it done when it matters'],
  },
];

function randomAnimal() {
  const animal = QUEST_ANIMALS[Math.floor(Math.random() * QUEST_ANIMALS.length)];
  const tooltip = animal.tooltips[Math.floor(Math.random() * animal.tooltips.length)];
  return `<span class="quest-animal-wrap" data-tooltip="${tooltip}">${animal.svg}</span>`;
}

function renderHeroGreeting() {
  const el = document.getElementById('hero-greeting');
  const textEl = document.getElementById('hero-text');
  const iconEl = document.getElementById('hero-icon');
  if (!el || !textEl) return;

  const user = state.user;
  let displayName = 'Adventurer';
  if (user?.name) {
    displayName = user.name.split(/\s+/)[0];
  } else if (user?.login) {
    displayName = user.login;
  }

  const queueCount = state.queue?.items?.length ?? 0;
  const animal = randomAnimal();

  iconEl.style.display = 'none';

  if (queueCount > 0) {
    const mark = '<span class="quest-mark">!</span> ';
    const s = queueCount === 1;
    const q = s ? 'quest' : 'quests';
    const greeting = Math.random() < 0.5 ? 'For the Light' : "Lok'tar ogar";
    const n = `<strong>${esc(displayName)}</strong>${animal}`;
    const questLines = [
      `${mark}${greeting}, ${n}! I have ${queueCount} ${q} that ${s ? 'requires' : 'require'} your attention.`,
      `${mark}${greeting}, ${n}! ${queueCount} ${q} ${s ? 'awaits' : 'await'} your judgment.`,
      `${mark}${greeting}, ${n}! The war effort needs you. ${queueCount} ${q} ${s ? 'remains' : 'remain'}.`,
      `${mark}${greeting}, ${n}! ${queueCount} ${q} ${s ? 'demands' : 'demand'} resolution.`,
      `${mark}${greeting}, ${n}! ${queueCount} urgent ${q} ${s ? 'has' : 'have'} arrived.`,
    ];
    textEl.innerHTML = questLines[Math.floor(Math.random() * questLines.length)];
    el.className = 'hero-greeting hero-quests';
  } else {
    const mark = '<span class="quest-mark quest-mark--done">?</span> ';
    const n = `<strong>${esc(displayName)}</strong>${animal}`;
    const restLines = [
      `${mark}Rest well, ${n}. You have no quests. The realm is at peace.`,
      `${mark}All quests complete, ${n}. Return to the inn and rest.`,
      `${mark}Your quest log is empty, ${n}. A rare moment of peace in Azeroth.`,
      `${mark}No new orders, ${n}. Even heroes need to rest at the hearthstone.`,
    ];
    textEl.innerHTML = restLines[Math.floor(Math.random() * restLines.length)];
    el.className = 'hero-greeting hero-rest';
  }

  el.style.display = '';
  requestAnimationFrame(() => el.classList.add('hero-visible'));
}



async function refreshAll() {
  try {
    const [queue, history, config, lastRun] = await Promise.all([
      api('/queue'),
      api('/history'),
      api('/config'),
      api('/last-run'),
    ]);
    state.queue = queue;
    state.history = history;
    state.config = config;
    state.lastRun = lastRun;
    render();
    renderHeroGreeting();
  } catch (err) {
    showToast(`Failed to load: ${err.message}`, 'error');
  }
}

// ── Rendering ───────────────────────────────────────────

function render() {
  renderStatusBar();
  renderScanContext();
  renderQueue();
  renderHistory();
  renderTabCounts();
}

function renderStatusBar() {
  const lastScanInfo = document.getElementById('last-scan-info');

  if (state.lastRun?.lastRunDate && !state.queue.scannedAt) {
    lastScanInfo.textContent = `Last scan: ${formatDate(state.lastRun.lastRunDate)}`;
  } else {
    lastScanInfo.textContent = '';
  }

  // Set title from config
  if (state.config?.title) {
    document.getElementById('app-title').textContent = state.config.title;
    document.title = state.config.title;
  }

  // Show last completed scan date near the complete button
  const infoEl = document.getElementById('scan-complete-info');
  if (infoEl) {
    const lastDate = state.lastRun?.lastRunDate;
    infoEl.textContent = lastDate
      ? `Last completed: ${formatDate(lastDate)}`
      : 'No previous scan completed';
  }
}

function renderScanContext() {
  const el = document.getElementById('scan-context');
  const config = state.config;
  if (!config) { el.style.display = 'none'; return; }

  const { owner, repo } = config.sourceRepo;
  const teamLabels = config.categories.flatMap((c) => c.labels);
  const releaseLabels = config.releaseNoteLabels ?? [];

  const since = state.lastRun?.lastRunDate ? formatDate(state.lastRun.lastRunDate) : null;
  const until = state.queue.scannedAt ? formatDate(state.queue.scannedAt) : null;
  const dateRange = since && until
    ? `${since} → ${until}`
    : since
      ? `Since ${since}`
      : until
        ? `Up to ${until}`
        : 'Not scanned yet';

  el.style.display = '';
  el.innerHTML = `
    <span class="scan-context-item">
      <svg class="octicon" viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/></svg>
      ${esc(owner)}/${esc(repo)}
    </span>
    <span class="scan-context-sep">·</span>
    <span class="scan-context-item">
      <svg class="octicon" viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M7.75 0a.75.75 0 0 1 .75.75V3h3.634c.414 0 .814.147 1.13.414l2.07 1.75a1.75 1.75 0 0 1 0 2.672l-2.07 1.75a1.75 1.75 0 0 1-1.13.414H8.5v5.25a.75.75 0 0 1-1.5 0V10H2.75A1.75 1.75 0 0 1 1 8.25v-3.5C1 3.784 1.784 3 2.75 3H7V.75A.75.75 0 0 1 7.75 0Zm4.384 4.5H8.5v4h3.634a.25.25 0 0 0 .161-.059l2.07-1.75a.25.25 0 0 0 0-.382l-2.07-1.75a.25.25 0 0 0-.161-.059ZM7 4.5H2.75a.25.25 0 0 0-.25.25v3.5c0 .138.112.25.25.25H7Z"/></svg>
      ${teamLabels.map((l) => `<span class="scan-context-label">${esc(l)}</span>`).join(' ')}
    </span>
    <span class="scan-context-sep">·</span>
    <span class="scan-context-item">
      ${releaseLabels.map((l) => `<span class="scan-context-label scan-context-label--release">${esc(l.replace('release_note:', ''))}</span>`).join(' ')}
    </span>
    <span class="scan-context-sep">·</span>
    <span class="scan-context-item">
      <svg class="octicon" viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M4.75 0a.75.75 0 0 1 .75.75V2h5V.75a.75.75 0 0 1 1.5 0V2h1.25c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25V3.75C1 2.784 1.784 2 2.75 2H4V.75A.75.75 0 0 1 4.75 0ZM2.5 7.5v6.75c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V7.5Zm10.75-4H2.75a.25.25 0 0 0-.25.25V6h11V3.75a.25.25 0 0 0-.25-.25Z"/></svg>
      ${esc(dateRange)}
    </span>
  `;
}

function renderTabCounts() {
  const items = state.queue.items;
  const yes = items.filter((i) => i.assessment.needsDocs === 'yes').length;
  const check = items.filter((i) => i.assessment.needsDocs === 'check').length;
  const no = items.filter((i) => i.assessment.needsDocs === 'no').length;

  const queueEl = document.getElementById('tab-queue-count');
  const parts = [];
  if (yes > 0) parts.push(`${yes} needs docs`);
  if (check > 0) parts.push(`${check} to check`);
  if (no > 0) parts.push(`${no} no docs`);
  queueEl.textContent = parts.length ? parts.join(' · ') : '0';

  document.getElementById('tab-history-count').textContent = String(state.history.entries.length);
}

function renderQueue() {
  const container = document.getElementById('queue-container');
  const empty = document.getElementById('queue-empty');

  const footer = document.getElementById('complete-scan-footer');

  const hasActiveScan = !!state.queue.scannedAt;

  if (state.queue.items.length === 0) {
    container.innerHTML = '';
    empty.style.display = '';
    if (footer) footer.style.display = hasActiveScan ? '' : 'none';
    return;
  }

  empty.style.display = 'none';
  if (footer) footer.style.display = hasActiveScan ? '' : 'none';

  // Group by category
  const grouped = groupByCategory(state.queue.items);
  let html = '';

  for (const [category, items] of grouped) {
    const yes = items.filter((i) => i.assessment.needsDocs === 'yes').length;
    const check = items.filter((i) => i.assessment.needsDocs === 'check').length;
    const no = items.filter((i) => i.assessment.needsDocs === 'no').length;
    html += `
      <div class="category-group">
        <div class="category-header">
          <h3>${esc(category)}</h3>
          <div class="category-pills">
            ${yes > 0 ? `<span class="pill pill-yes">${yes} needs docs</span>` : ''}
            ${check > 0 ? `<span class="pill pill-check">${check} to check</span>` : ''}
            ${no > 0 ? `<span class="pill pill-no">${no} no docs</span>` : ''}
          </div>
        </div>
        ${items.map((item) => renderCard(item)).join('')}
      </div>
    `;
  }

  // Skipped items — only show dismissals from the current scan period
  const scanDate = state.queue.scannedAt ? new Date(state.queue.scannedAt) : null;
  const skipped = scanDate
    ? state.history.entries.filter((e) => e.decision === 'dismissed' && new Date(e.timestamp) >= scanDate)
    : [];
  if (skipped.length > 0) {
    html += `
      <div class="skipped-section">
        <details>
          <summary class="skipped-summary">
            <span>Skipped</span>
            <span class="Counter ml-2">${skipped.length}</span>
          </summary>
          <div class="skipped-list">
            ${skipped.map((entry) => `
              <div class="skipped-item">
                <span class="skipped-title">${esc(entry.title || entry.prNumbers.map((n) => '#' + n).join(', '))}</span>
                ${entry.reason ? `<span class="Label Label--secondary ml-2" style="font-size:11px">${esc(entry.reason)}</span>` : ''}
                <button class="btn btn-sm btn-outline" data-action="unskip" data-prs="${entry.prNumbers.join(',')}">Restore</button>
              </div>
            `).join('')}
          </div>
        </details>
      </div>
    `;
  }

  container.innerHTML = html;
  bindCardEvents();

  // Bind unskip buttons
  container.querySelectorAll('[data-action="unskip"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const prNumbers = btn.dataset.prs.split(',').map(Number);
      await undoDismiss(prNumbers);
    });
  });
}

function effortBadge(tag) {
  if (!tag) return '';
  const config = {
    'quick-fix': { icon: `<svg class="octicon" viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M9.504.43a1.516 1.516 0 0 1 2.437 1.713L10.415 5.5h2.835c1.497 0 2.154 1.921.928 2.715l-6.862 4.44A1.516 1.516 0 0 1 4.879 10.857L6.585 7.5H3.75c-1.497 0-2.154-1.921-.928-2.715L9.504.43Z"/></svg>`, label: 'Quick fix', cls: 'effort-badge--quick' },
    'update': { icon: `<svg class="octicon" viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>`, label: 'Update', cls: 'effort-badge--update' },
    'new-content': { icon: `<svg class="octicon" viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/></svg>`, label: 'New content', cls: 'effort-badge--new' },
  };
  const c = config[tag] ?? { icon: '', label: tag, cls: '' };
  return `<span class="effort-badge ${c.cls}">${c.icon} ${c.label}</span>`;
}

function renderCard(item) {
  const badge = badgeClass(item.assessment.needsDocs);
  const badgeLabel = {
    yes: 'Needs docs',
    check: 'Check',
    no: 'No docs needed',
  }[item.assessment.needsDocs];

  const title = item.userEdits?.title ?? item.suggestedTitle;
  const avail = availabilityBadge(item);
  const confidence = item.assessment.confidence != null ? Math.round(item.assessment.confidence * 100) : null;
  const confStr = confidence != null ? ` · ${confidence}%` : '';

  return `
    <div class="triage-card" data-id="${item.id}">
      <div class="triage-card-header" data-action="toggle">
        <svg class="triage-card-chevron octicon" viewBox="0 0 16 16" width="16" height="16">
          <path fill="currentColor" d="m6.427 4.427 3.396 3.396a.25.25 0 0 1 0 .354l-3.396 3.396A.25.25 0 0 1 6 11.396V4.604a.25.25 0 0 1 .427-.177Z"/>
        </svg>
        <span class="triage-card-title">${esc(title)}</span>
        <div class="triage-card-meta">
          <span class="docs-badge ${badge}">${badgeLabel}<span class="docs-badge-conf">${confStr}</span></span>
          ${avail ? `<span class="avail-badge">${esc(avail)}</span>` : ''}
          ${effortBadge(item.assessment.effortTag)}
        </div>
      </div>
      <div class="triage-card-body">
        ${renderCardBody(item)}
      </div>
    </div>
  `;
}

function renderCardBody(item) {
  const pencil = `<svg class="octicon" viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>`;
  const edits = item.userEdits ?? {};
  const title = edits.title ?? item.suggestedTitle;
  const targetRepo = edits.targetRepo ?? (state.config ? `${state.config.targetRepo.owner}/${state.config.targetRepo.repo}` : 'elastic/docs-content');

  const versions = allVersions(item);
  const slWeek = effectiveServerless(item);
  const featureStatus = edits.featureStatus ?? item.assessment.featureStatus;
  const featureFlag = edits.featureFlag ?? item.assessment.featureFlag;

  return `
    <!-- Context table -->
    <table class="card-info-table">
      <tr>
        <td class="card-info-label">Pull requests</td>
        <td>
          <div class="pr-list-compact">
            ${item.prs.map((pr) => `
              <a class="pr-chip" href="${esc(pr.url)}" target="_blank" rel="noopener">
                <span class="pr-chip-number">#${pr.number}</span>
                <span class="pr-chip-title">${esc(pr.title)}</span>
                <span class="pr-chip-author">@${esc(pr.author)}</span>
              </a>
            `).join('')}
            ${item.alsoAppliesTo?.length ? `<span class="also-applies-tag">Also: ${item.alsoAppliesTo.map(c => esc(c)).join(', ')}</span>` : ''}
          </div>
        </td>
      </tr>
      <tr>
        <td class="card-info-label">Availability</td>
        <td>
          <div class="avail-items">
            ${versions.map(v => `<span class="avail-tag">${esc(v)}</span>`).join('')}
            ${slWeek ? `<span class="avail-tag avail-tag--sl">${esc(slWeek)} (serverless)</span>` : ''}
            ${featureStatus ? `<span class="avail-status-badge">${esc(featureStatus)}</span>` : ''}
            ${featureFlag ? `<span class="avail-tag avail-tag--flag">${esc(featureFlag)}</span>` : ''}
          </div>
        </td>
      </tr>
    </table>

    <!-- Issue suggestion -->
    <div class="card-section">
      <div class="card-section-label">Issue suggestion</div>
      <div class="issue-block">
        <div class="issue-block-header">
          <button class="btn-edit-inline" data-action="toggle-title-edit" data-item="${item.id}" title="Edit title">${pencil}</button>
          <span class="issue-block-title-text" data-title-display="${item.id}">${esc(title)}</span>
          <input class="issue-block-title" data-field="title" data-item="${item.id}"
            value="${esc(title)}" placeholder="Issue title" style="display:none" />
        </div>
        <div class="issue-body-editor">
          <div class="issue-body-tabs">
            <button class="issue-body-tab" data-editor="write" data-item="${item.id}">Write</button>
            <button class="issue-body-tab active" data-editor="preview" data-item="${item.id}">Preview</button>
          </div>
          <textarea class="issue-body-textarea" data-field="body" data-item="${item.id}"
            style="display:none"
            placeholder="Issue body (Markdown)">${esc(edits.body ?? item.suggestedBody)}</textarea>
          <div class="issue-body-preview" data-preview="${item.id}"></div>
        </div>
      </div>
    </div>

    <!-- 5. Actions -->
    <div class="card-actions">
      <div class="create-group">
        <label class="good-first-issue-label">
          <input type="checkbox" data-field="goodFirstIssue" data-item="${item.id}" />
          good first issue
        </label>
        <button class="btn btn-sm btn-primary" data-action="create" data-item="${item.id}">
          <svg class="octicon mr-1" viewBox="0 0 16 16" width="16" height="16">
            <path fill="currentColor" d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z"/>
          </svg>
          Accept quest and create issue
        </button>
      </div>
      <button class="btn btn-sm btn-danger" data-action="dismiss" data-item="${item.id}" data-reason="no docs needed">
        Skip – no docs
      </button>
      <button class="btn btn-sm btn-outline" data-action="dismiss" data-item="${item.id}" data-reason="already tracked">
        Skip – already tracked
      </button>
      <div class="target-repo-select">
        <label>Target:</label>
        <select data-field="targetRepo" data-item="${item.id}">
          <option value="elastic/docs-content" ${sel(targetRepo, 'elastic/docs-content')}>docs-content</option>
          <option value="elastic/docs-content-internal" ${sel(targetRepo, 'elastic/docs-content-internal')}>docs-content-internal</option>
        </select>
      </div>
    </div>
  `;
}

function renderHistory() {
  const container = document.getElementById('history-container');
  const empty = document.getElementById('history-empty');
  const filter = document.getElementById('history-filter').value;

  let entries = [...state.history.entries];
  if (filter !== 'all') {
    entries = entries.filter((e) => e.decision === filter);
  }

  if (entries.length === 0) {
    container.innerHTML = '';
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';

  // Group entries by session (scan date), most recent first
  const sessions = new Map();
  for (const entry of entries) {
    const key = entry.session || entry.timestamp.slice(0, 10);
    if (!sessions.has(key)) sessions.set(key, []);
    sessions.get(key).push(entry);
  }

  // Sort sessions: most recent first
  const sortedSessions = [...sessions.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  let html = '';
  for (const [session, sessionEntries] of sortedSessions) {
    const created = sessionEntries.filter((e) => e.decision === 'created').length;
    const skipped = sessionEntries.filter((e) => e.decision === 'dismissed').length;
    const versions = [...new Set(sessionEntries.map((e) => e.version).filter(Boolean))];
    const isFirst = sortedSessions[0][0] === session;

    const stats = [
      created > 0 ? `${created} accepted` : '',
      skipped > 0 ? `${skipped} skipped` : '',
    ].filter(Boolean).join(', ');

    html += `
      <details class="history-session" ${isFirst ? 'open' : ''}>
        <summary class="history-session-header">
          <span class="history-session-date">${esc(session)}</span>
          ${versions.map((v) => `<span class="Label Label--secondary">${esc(v)}</span>`).join(' ')}
          <span class="history-session-stats">${stats}</span>
        </summary>
        <div class="history-session-body">
          ${sessionEntries.map((entry) => renderHistoryEntry(entry)).join('')}
        </div>
      </details>
    `;
  }

  container.innerHTML = html;

  // Bind undo buttons
  container.querySelectorAll('[data-action="undo-dismiss"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const prNumbers = btn.dataset.prs.split(',').map(Number);
      await undoDismiss(prNumbers);
    });
  });
}

function renderHistoryEntry(entry) {
  const isCreated = entry.decision === 'created';
  const icon = isCreated
    ? `<svg class="octicon history-icon history-icon-created" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>`
    : `<svg class="octicon history-icon history-icon-dismissed" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z"/></svg>`;

  const link = isCreated && entry.issueUrl
    ? `<a href="${esc(entry.issueUrl)}" target="_blank" class="Link--primary">${esc(entry.title || `Issue #${entry.issueNumber}`)}</a>`
    : `<span>${esc(entry.title || entry.prNumbers.map((n) => `#${n}`).join(', '))}</span>`;

  return `
    <div class="history-item">
      ${icon}
      <span class="history-title">${link}</span>
      <span class="history-meta">${isCreated ? '' : esc(entry.reason || '')}</span>
    </div>
  `;
}

// ── Events ──────────────────────────────────────────────

function bindEvents() {
  // Tabs
  document.querySelectorAll('.UnderlineNav-item').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.UnderlineNav-item').forEach((t) => t.removeAttribute('aria-current'));
      tab.setAttribute('aria-current', 'page');
      state.activeTab = tab.dataset.tab;
      document.querySelectorAll('.tab-content').forEach((c) => c.style.display = 'none');
      document.getElementById(`tab-${state.activeTab}`).style.display = '';
    });
  });

  // Scan buttons
  document.getElementById('btn-scan-empty')?.addEventListener('click', triggerScan);

  // Mark complete
  document.getElementById('btn-complete').addEventListener('click', async () => {
    if (!confirm('Turn in all quests and return to the inn? The next scan will only pick up PRs merged after the scan date.')) return;
    try {
      await api('/scan/complete', { method: 'POST' });
      showQuestRewards();
      await refreshAll();
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  });

  // Settings
  document.getElementById('btn-settings').addEventListener('click', openSettings);
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-dialog').close();
  });
  document.getElementById('btn-cancel-settings').addEventListener('click', () => {
    document.getElementById('settings-dialog').close();
  });
  document.getElementById('settings-form').addEventListener('submit', saveSettings);
  document.getElementById('btn-add-category').addEventListener('click', addCategoryRow);

  // History filter
  document.getElementById('history-filter').addEventListener('change', renderHistory);

}

function bindCardEvents() {
  // Toggle expand/collapse
  document.querySelectorAll('[data-action="toggle"]').forEach((el) => {
    el.addEventListener('click', () => {
      el.closest('.triage-card').classList.toggle('expanded');
    });
  });

  // Create issue
  document.querySelectorAll('[data-action="create"]').forEach((btn) => {
    btn.addEventListener('click', () => createIssue(btn.dataset.item));
  });

  // Skip (immediate, no modal)
  document.querySelectorAll('[data-action="dismiss"]').forEach((btn) => {
    btn.addEventListener('click', () => skipItem(btn.dataset.item, btn.dataset.reason));
  });

  // Field edits (debounced save)
  document.querySelectorAll('[data-field][data-item]').forEach((el) => {
    const event = el.tagName === 'SELECT' ? 'change' : 'input';
    let timeout;
    el.addEventListener(event, () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => saveFieldEdit(el.dataset.item, el.dataset.field, el.value), 500);
    });
  });

  // Editor tabs (write/preview)
  document.querySelectorAll('[data-editor]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const itemId = tab.dataset.item;
      const card = tab.closest('.triage-card-body');
      const textarea = card.querySelector(`textarea[data-item="${itemId}"]`);
      const preview = card.querySelector(`[data-preview="${itemId}"]`);
      const tabs = card.querySelectorAll('[data-editor]');

      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      if (tab.dataset.editor === 'preview') {
        textarea.style.display = 'none';
        preview.style.display = '';
        preview.innerHTML = renderMarkdown(textarea.value);
      } else {
        textarea.style.display = '';
        preview.style.display = 'none';
      }
    });
  });

  // Render initial preview for issue bodies (default to preview mode)
  document.querySelectorAll('[data-preview]').forEach((preview) => {
    const itemId = preview.dataset.preview;
    const textarea = preview.closest('.triage-card-body')?.querySelector(`textarea[data-item="${itemId}"]`);
    if (textarea && textarea.value) {
      preview.innerHTML = renderMarkdown(textarea.value);
    }
  });

  // Toggle issue title edit
  document.querySelectorAll('[data-action="toggle-title-edit"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const itemId = btn.dataset.item;
      const header = btn.closest('.issue-block-header');
      const display = header.querySelector(`[data-title-display="${itemId}"]`);
      const input = header.querySelector(`input[data-field="title"]`);
      const editing = input.style.display !== 'none';

      if (editing) {
        display.textContent = input.value;
        display.style.display = '';
        input.style.display = 'none';
      } else {
        display.style.display = 'none';
        input.style.display = '';
        input.focus();
      }
    });
  });

  // Screenshot lightbox
  document.querySelectorAll('.screenshot-thumb').forEach((img) => {
    img.addEventListener('click', () => {
      const overlay = document.createElement('div');
      overlay.className = 'lightbox-overlay';
      overlay.innerHTML = `<img src="${img.src}" />`;
      overlay.addEventListener('click', () => overlay.remove());
      document.body.appendChild(overlay);
    });
  });
}

// ── Actions ─────────────────────────────────────────────

async function triggerScan() {
  showLoading(true);
  try {
    const queue = await api('/scan', { method: 'POST' });
    state.queue = queue;
    showToast(`Scan complete. ${queue.items.length} new quest${queue.items.length !== 1 ? 's' : ''} discovered.`, 'success');
    await refreshAll();
  } catch (err) {
    showToast(`Scan failed: ${err.message}`, 'error');
  } finally {
    showLoading(false);
  }
}

async function saveFieldEdit(itemId, field, value) {
  try {
    const payload = { userEdits: { [field]: value } };
    if (field === 'title') {
      payload.suggestedTitle = value;
    }
    const updated = await api(`/queue/${itemId}`, {
      method: 'PATCH',
      body: payload,
    });
    // Update local state
    const idx = state.queue.items.findIndex((i) => i.id === itemId);
    if (idx >= 0) state.queue.items[idx] = updated;
  } catch (err) {
    showToast(`Save failed: ${err.message}`, 'error');
  }
}

async function createIssue(itemId) {
  const card = document.querySelector(`.triage-card[data-id="${itemId}"]`);
  const btn = card.querySelector('[data-action="create"]');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const goodFirstIssue = card.querySelector('[data-field="goodFirstIssue"]')?.checked ?? false;
    const result = await api('/create-issue', {
      method: 'POST',
      body: { queueItemId: itemId, goodFirstIssue },
    });
    showToast(`Quest accepted! Issue #${result.issue.number} created.`, 'success');
    await refreshAll();
  } catch (err) {
    showToast(`Failed to create issue: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Create issue';
  }
}

async function skipItem(itemId, reason = 'no docs needed') {
  try {
    await api('/dismiss', {
      method: 'POST',
      body: { queueItemId: itemId, reason },
    });
    showToast(`Quest skipped. ${reason}.`, 'success');
    await refreshAll();
  } catch (err) {
    showToast(`Skip failed: ${err.message}`, 'error');
  }
}

async function undoDismiss(prNumbers) {
  try {
    await api('/undo-dismiss', {
      method: 'POST',
      body: { prNumbers },
    });
    showToast('Quest restored to your log.', 'success');
    await refreshAll();
  } catch (err) {
    showToast(`Undo failed: ${err.message}`, 'error');
  }
}

// ── Settings ────────────────────────────────────────────

function openSettings() {
  const config = state.config;
  if (!config) return;

  document.getElementById('cfg-title').value = config.title ?? '';
  document.getElementById('cfg-source-repo').value = `${config.sourceRepo.owner}/${config.sourceRepo.repo}`;
  document.getElementById('cfg-target-repo').value = `${config.targetRepo.owner}/${config.targetRepo.repo}`;
  document.getElementById('cfg-version-pattern').value = config.versionLabelPattern ?? '^v\\d+\\.\\d+\\.\\d+$';
  document.getElementById('cfg-release-note-labels').value = (config.releaseNoteLabels ?? []).join(', ');
  document.getElementById('cfg-issue-labels').value = config.issueLabels.join(', ');

  const catContainer = document.getElementById('cfg-categories');
  catContainer.innerHTML = '';
  for (const cat of config.categories) {
    catContainer.appendChild(createCategoryRow(cat.name, cat.labels.join(', ')));
  }

  document.getElementById('settings-dialog').showModal();
}

function createCategoryRow(name = '', labels = '') {
  const row = document.createElement('div');
  row.className = 'category-row';
  row.innerHTML = `
    <input class="form-control input-sm" placeholder="Category name" value="${esc(name)}" data-cat="name" />
    <input class="form-control input-sm" placeholder="Labels (comma-separated)" value="${esc(labels)}" data-cat="labels" />
    <button type="button" class="btn-octicon" aria-label="Remove" data-action="remove-category">
      <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
        <path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
      </svg>
    </button>
  `;
  row.querySelector('[data-action="remove-category"]').addEventListener('click', () => row.remove());
  return row;
}

function addCategoryRow() {
  document.getElementById('cfg-categories').appendChild(createCategoryRow());
}

async function saveSettings(e) {
  e.preventDefault();

  const parseRepo = (val) => {
    const [owner, repo] = val.split('/');
    return { owner: owner?.trim(), repo: repo?.trim() };
  };

  const categories = [];
  for (const row of document.querySelectorAll('.category-row')) {
    const name = row.querySelector('[data-cat="name"]').value.trim();
    const labels = row.querySelector('[data-cat="labels"]').value
      .split(',').map((l) => l.trim()).filter(Boolean);
    if (name && labels.length) categories.push({ name, labels });
  }

  const config = {
    title: document.getElementById('cfg-title').value.trim() || 'PR Docs Triage',
    sourceRepo: parseRepo(document.getElementById('cfg-source-repo').value),
    targetRepo: parseRepo(document.getElementById('cfg-target-repo').value),
    versionLabelPattern: document.getElementById('cfg-version-pattern').value.trim() || '^v\\d+\\.\\d+\\.\\d+$',
    releaseNoteLabels: document.getElementById('cfg-release-note-labels').value
      .split(',').map((l) => l.trim()).filter(Boolean),
    issueLabels: document.getElementById('cfg-issue-labels').value
      .split(',').map((l) => l.trim()).filter(Boolean),
    categories,
  };

  try {
    await api('/config', { method: 'PUT', body: config });
    document.getElementById('settings-dialog').close();
    showToast('Settings saved.', 'success');
    await refreshAll();
  } catch (err) {
    showToast(`Save failed: ${err.message}`, 'error');
  }
}

// ── Helpers ─────────────────────────────────────────────

function groupByCategory(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.category)) map.set(item.category, []);
    map.get(item.category).push(item);
  }
  return map;
}

function showQuestRewards() {
  const rewards = [
    { item: 'Gold', amount: `${Math.floor(Math.random() * 50 + 10)}g ${Math.floor(Math.random() * 99)}s`, icon: '🪙' },
    { item: 'Experience', amount: `${Math.floor(Math.random() * 5000 + 1000)} XP`, icon: '⭐' },
  ];

  const bonusPool = [
    { item: 'Tome of Documentation Mastery', amount: '+5 Intellect', icon: '📖' },
    { item: 'Cloak of the Diligent Reviewer', amount: '+3 Stamina', icon: '🧥' },
    { item: 'Ring of Clarity', amount: '+2 Spirit', icon: '💍' },
    { item: 'Scroll of Triage Efficiency', amount: 'Use: Next scan takes 50% less time', icon: '📜' },
    { item: "Hearthstone Biscuit", amount: 'Restores 10% sanity', icon: '🍪' },
    { item: 'Quill of the Lorekeeper', amount: '+4 Documentation Power', icon: '🪶' },
    { item: 'Badge of the Quest Completer', amount: 'Reputation: Exalted', icon: '🎖️' },
    { item: 'Elixir of Sustained Focus', amount: '+30 Concentration for 1 hour', icon: '🧪' },
  ];

  rewards.push(bonusPool[Math.floor(Math.random() * bonusPool.length)]);

  const overlay = document.createElement('div');
  overlay.className = 'reward-overlay';
  overlay.innerHTML = `
    <div class="reward-box">
      <div class="reward-header">Quest complete!</div>
      <div class="reward-subheader">You receive:</div>
      <ul class="reward-list">
        ${rewards.map((r) => `
          <li class="reward-item">
            <span class="reward-icon">${r.icon}</span>
            <span class="reward-name">${r.item}</span>
            <span class="reward-amount">${r.amount}</span>
          </li>
        `).join('')}
      </ul>
      <button class="reward-dismiss">Continue</button>
    </div>
  `;
  overlay.querySelector('.reward-dismiss').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function badgeClass(needsDocs) {
  return {
    yes: 'docs-badge-yes',
    check: 'docs-badge-check',
    no: 'docs-badge-no',
  }[needsDocs] ?? 'docs-badge-check';
}

function sel(value, option) {
  return (value ?? 'TBD') === option ? 'selected' : '';
}

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Compute the serverless deploy week from a merge date (merge + 7 days = Monday of deploy week). */
function serverlessWeek(mergedAt) {
  if (!mergedAt) return null;
  const d = new Date(mergedAt);
  d.setDate(d.getDate() + 7);
  // Roll back to Monday of that week
  const day = d.getDay();
  const diff = day === 0 ? -6 : -(day - 1);
  d.setDate(d.getDate() + diff);
  const mon = new Date(d);
  const fri = new Date(d);
  fri.setDate(fri.getDate() + 4);
  const fmt = (dt) => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(mon)}–${fmt(fri)}`;
}

/** Extract all version labels from a queue item's PR labels. */
function allVersions(item) {
  const pattern = state.config?.versionLabelPattern ? new RegExp(state.config.versionLabelPattern) : /^v\d+\.\d+\.\d+$/;
  const set = new Set();
  for (const pr of item.prs) {
    for (const label of pr.labels) {
      if (pattern.test(label)) set.add(label);
    }
  }
  return [...set].sort();
}

/** Compute the effective serverless week for an item (uses the latest merge date). */
function effectiveServerless(item) {
  const edits = item.userEdits ?? {};
  if (edits.serverlessEstimate || item.assessment?.serverlessEstimate) {
    return edits.serverlessEstimate || item.assessment.serverlessEstimate;
  }
  const latestMerge = item.prs
    .map((pr) => pr.mergedAt)
    .filter(Boolean)
    .sort()
    .pop();
  return serverlessWeek(latestMerge) || '';
}

/** Build an availability string like "v9.4.0 · Mar 10–14 (serverless)" */
function availabilityBadge(item) {
  const versions = allVersions(item);
  const sl = effectiveServerless(item);
  const parts = [];
  if (versions.length) parts.push(versions.join(', '));
  if (sl) parts.push(`${sl} (serverless)`);
  return parts.join(' · ');
}

/** Render Markdown to HTML using the marked library */
function renderMarkdown(md) {
  if (!md) return '';
  if (typeof marked !== 'undefined') {
    return marked.parse(md);
  }
  // Fallback: return escaped text with line breaks
  return '<p>' + esc(md).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
}

function showLoading(show) {
  document.getElementById('loading-overlay').style.display = show ? '' : 'none';
}

// ── Toasts ──────────────────────────────────────────────

let toastContainer;

function showToast(message, type = 'success') {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
