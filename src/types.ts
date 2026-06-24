/** A PR fetched from GitHub */
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  mergedAt: string;
  body: string;
  labels: string[];
  changedFiles?: string[];
}

/** An existing docs issue that already tracks this PR */
export interface TrackedIssue {
  number: number;
  url: string;
  title: string;
}

/** A specific gap found between current docs and the PR change */
export interface DocsGapEntry {
  /** URL of the doc page analyzed */
  pageUrl: string;
  /** Page title */
  pageTitle: string;
  /** Specific heading/section within the page that's affected (if identifiable) */
  section?: string;
  /** What the current docs say (brief quote or description) */
  currentContent?: string;
  /** What needs to change and why (may include assembly implications when relevant) */
  gap: string;
  /**
   * What kind of doc work this gap requires — used internally to drive effortTag
   * and filter marginal gaps before they reach the issue template.
   */
  actionType?: 'update-existing' | 'add-section' | 'create-how-to' | 'create-overview' | 'review-only';
}

/** Assessment of whether a PR needs documentation */
export interface Assessment {
  /** yes = needs docs, check = unsure, no = no docs needed */
  needsDocs: 'yes' | 'check' | 'no';
  /** 0–1 confidence score */
  confidence: number;
  /** Human-readable summary of the change, incorporating release note text if present */
  summary: string;
  /** Why this assessment was made */
  reasoning: string;
  /** preview, beta, ga, or unknown */
  featureStatus?: string;
  /** Feature flag name if behind one, or null */
  featureFlag?: string;
  /** Estimated serverless release date */
  serverlessEstimate?: string;
  /**
   * Whether the change reaches serverless at all. Defaults to 'yes' — most Kibana
   * platform features ship to serverless and versioned stack. Set to 'no' only with
   * config evidence (plugin disabled in config/serverless.yml). 'unknown' only when
   * no owning plugin can be resolved. Gates serverlessEstimate: 'no' renders "N/A".
   */
  serverlessApplies?: 'yes' | 'no' | 'unknown';
  /** URLs to existing documentation pages */
  existingDocs?: string[];
  /** Link to the product-side issue if found */
  productIssue?: string;
  /** Section-level analysis of what's missing or wrong in existing docs */
  docsGap?: DocsGapEntry[];
  /** Effort estimate: quick-fix (change a word/value), update (rewrite a section), new-content (new section or page) */
  effortTag?: 'quick-fix' | 'update' | 'new-content';
  /**
   * Whether the PR diff actually supports the stated change — used internally
   * to calibrate confidence and reasoning; not rendered in the issue template.
   */
  premiseAccuracy?: 'accurate' | 'partially-accurate' | 'stale' | 'unsupported';
  /** Screenshot/GIF URLs extracted from PR bodies */
  screenshots?: string[];
  /** Existing docs issues found in the target repo that already track this PR */
  trackedIn?: TrackedIssue[];
}

/** A single item in the triage queue — one or more related PRs */
export interface QueueItem {
  id: string;
  /** Primary category from config (e.g., "Dashboards and Visualizations") */
  category: string;
  /** Additional categories this item also applies to (from cross-category dedup) */
  alsoAppliesTo?: string[];
  /** Version label detected from PR labels (e.g., "v9.4.0") */
  version: string;
  prs: PullRequest[];
  assessment: Assessment;
  suggestedTitle: string;
  suggestedBody: string;
  /** Release note text extracted from PR body, if present */
  releaseNoteText?: string;
  /** User edits made in the review UI (persisted across re-scans) */
  userEdits?: {
    title?: string;
    body?: string;
    featureStatus?: string;
    featureFlag?: string;
    serverlessEstimate?: string;
    serverlessApplies?: 'yes' | 'no' | 'unknown';
    existingDocs?: string;
    targetRepo?: string;
  };
}

/** A triage queue written to queue.json */
export interface Queue {
  scannedAt: string;
  items: QueueItem[];
}

/** A record of a past decision */
export interface HistoryEntry {
  /** PR numbers covered by this decision */
  prNumbers: number[];
  decision: 'created' | 'dismissed';
  /** Why it was dismissed (e.g., "no docs needed", "already tracked") */
  reason?: string;
  /** URL of the created issue */
  issueUrl?: string;
  issueNumber?: number;
  timestamp: string;
  version: string;
  /** The suggested title at time of decision, for reference */
  title?: string;
  /** The scan date this entry belongs to, for grouping into sessions */
  session?: string;
}

/** Persisted history */
export interface History {
  entries: HistoryEntry[];
}

/** Last scan metadata */
export interface LastRun {
  /** ISO date of the last completed scan */
  lastRunDate: string;
}

/**
 * Meta issue configuration. A meta issue is a checklist issue in the target
 * repo that tracks all docs issues for a given release. When enabled, newly
 * created issues are automatically linked into the matching section.
 *
 * Can be set globally (`Config.metaIssue`) or per category (`Category.metaIssue`),
 * where the category value overrides the global one for that category only.
 */
export interface MetaIssueConfig {
  /** Whether to link created issues to a meta issue. Defaults to true. */
  enabled?: boolean;
  /**
   * Title search pattern used to find the meta issue in the target repo.
   * Use `{version}` as a placeholder for the major.minor version (e.g., "9.5").
   * Default: "Kibana {version}"
   *
   * Examples:
   *   "My Project {version} release checklist"
   *   "Docs tracker — {version}"
   */
  titlePattern?: string;
}

/** A team category with its GitHub labels */
export interface Category {
  name: string;
  labels: string[];
  /** Heading to match in the meta issue body (defaults to name if not set) */
  metaIssueHeading?: string;
  /**
   * Route this category's issues to a different meta issue than the global
   * (or repo-group) default. Overrides `Config.metaIssue` for this category only.
   * Set `{ enabled: false }` to opt this category out of meta-issue linking.
   */
  metaIssue?: MetaIssueConfig;
}

/** App configuration */
export interface Config {
  /** Display title shown in the header. */
  title?: string;
  sourceRepo: { owner: string; repo: string };
  targetRepo: { owner: string; repo: string };
  categories: Category[];
  /**
   * Regex pattern to detect version labels on PRs (e.g., "v9.4.0").
   * Applied against each PR's labels to extract the target version.
   * Default: /^v\d+\.\d+\.\d+$/
   */
  versionLabelPattern: string;
  /**
   * Release note labels that qualify a PR for docs triage.
   * Only PRs with at least one of these labels will be included in the scan.
   * Typically: release_note:breaking, release_note:deprecation,
   * release_note:feature, release_note:enhancement, release_note:fix.
   *
   * Note: release_note:fix PRs rarely need docs unless mistagged,
   * but are included for completeness.
   */
  releaseNoteLabels: string[];
  /**
   * Drop late-label-catch results whose mergedAt is older than this many
   * months before sinceDate. The dual-query strategy uses `updated:>=sinceDate`
   * to catch PRs labeled after merge, but it also surfaces PRs whose only
   * recent activity is an unrelated label edit. Setting a cap filters out
   * stale edits on old PRs without affecting the primary `merged:>=` query.
   * Default: 6.
   */
  maxMergeAgeMonths?: number;
  issueLabels: string[];
  /**
   * Global meta issue configuration. Applies to all categories unless a
   * category defines its own `metaIssue` override.
   *
   * Omit this field entirely to use the defaults (enabled, "Kibana {version}").
   * Set `enabled: false` to disable meta issue linking entirely.
   */
  metaIssue?: MetaIssueConfig;
  /**
   * GitHub Projects v2 integration. When set, newly created issues
   * are added to the project and fields are auto-filled.
   */
  project?: {
    /** GitHub org that owns the project (e.g., "elastic") */
    org: string;
    /** Project number (from the URL, e.g., 1034) */
    number: number;
    /** Default area field value (e.g., "Kibana core") */
    defaultArea?: string;
    /** Default priority field value (e.g., "P2 (Normal)") */
    defaultPriority?: string;
    /** Effort tag → Size mapping */
    sizeMap?: Record<string, string>;
    /** Effort tag → Content Type field value mapping */
    contentTypeMap?: Record<string, string>;
    /** Category name → Feature field value mapping */
    featureMap?: Record<string, string>;
    /**
     * PR-label → Feature field value mapping. Takes precedence over
     * featureMap when any of an item's PR labels matches — lets a single
     * category that spans teams (e.g. "Dashboards and Visualizations")
     * route by team label. Entry order sets priority (first match wins).
     */
    featureLabelMap?: Record<string, string>;
  };
}
