/** Domain types shared across the platform. */

export type SiteStatus = 'active' | 'paused';
export type LinkStatus = 'go' | 'done' | 'no';

/** A site as the selector sees it: config plus derived runtime facts. */
export interface SiteView {
  id: number;
  name: string;
  domain: string;
  status: SiteStatus;
  dailyTarget: number;
  /** Minimum gap between posts, in minutes. */
  intervalMinutes: number;
  /** Derived: COUNT(runs published today). Never stored. */
  publishedToday: number;
  /** Derived: MAX(runs.published_at). Never stored. ISO string or null. */
  lastPublishAt: string | null;
  /**
   * Derived: MAX(runs.started_at) over every run, failed ones included.
   *
   * Separate from lastPublishAt because the two answer different questions.
   * The interval asks "when did this site last publish"; taking turns asks
   * "when did this site last have a go". A site that fails never publishes, so
   * ordering the queue by lastPublishAt leaves it permanently first — it takes
   * every tick, fails, and no other site ever runs.
   */
  lastAttemptAt: string | null;
}

export interface KeywordView {
  id: number;
  seedKeyword: string;
  spyTitle: string;
  status: LinkStatus;
}

/** One cell of the keyword x site matrix. */
export interface LinkView {
  keywordId: number;
  siteId: number;
  status: LinkStatus;
  /**
   * Held back after repeated identical failures.
   *
   * Separate from `status` because they answer different questions: status is
   * what a person decided, this is what the scheduler observed. Merging them
   * would make "I said no" and "it gave up" the same fact.
   */
  blocked?: boolean;
}

export type DecisionKind = 'selected' | 'eligible' | 'rejected' | 'skipped' | 'none';
export type SubjectType = 'site' | 'keyword' | 'pair' | 'cycle';

export interface Decision {
  subjectType: SubjectType;
  subjectId: number | null;
  subjectLabel: string;
  decision: DecisionKind;
  reason: string;
}

/** The single valid publishing task the selector exists to produce. */
export interface PublishingTask {
  siteId: number;
  siteDomain: string;
  siteName: string;
  keywordId: number;
  seedKeyword: string;
}

export interface SelectionResult {
  task: PublishingTask | null;
  decisions: Decision[];
}
