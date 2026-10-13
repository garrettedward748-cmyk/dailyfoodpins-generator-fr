import { evaluateSite, formatMinutes, type SelectorOptions } from './selector.js';
import type { LinkStatus, SiteView } from './types.js';

/**
 * Why one keyword is not publishing.
 *
 * Decisions answer this for a *cycle*: every site checked, every keyword
 * skipped. That is the right shape for "why did nothing happen at 14:15" and
 * the wrong shape for "why has this one keyword never gone out" — answering
 * that from decisions means reading cycles backwards until you find a mention
 * of it, and a keyword that is skipped early may not be mentioned at all.
 *
 * So this asks the question from the other end: given one keyword, walk every
 * site and say where it stands. Pure, like the selector, and built on the same
 * `evaluateSite` — a verdict here and a verdict in the scheduler cannot drift
 * apart because they are the same function.
 */

export interface SiteVerdict {
  siteId: number;
  domain: string;
  /** Where this keyword stands on this site: go / done / no, or unlinked. */
  link: LinkStatus | 'unlinked';
  /** True only when this keyword could publish here on the next tick. */
  ready: boolean;
  /** Plain sentence, always populated — for the ready case too. */
  reason: string;
  /** Roughly when this site is free again, when that is what is blocking. */
  waitMinutes: number | null;
  /** Held back by the scheduler after repeated failures, awaiting a person. */
  blocked?: boolean;
}

export interface KeywordDiagnosis {
  keywordStatus: LinkStatus;
  /** Blocking problem with the keyword itself, or null when it is fine. */
  keywordProblem: string | null;
  sites: SiteVerdict[];
  readyCount: number;
  /** One sentence covering the whole picture. */
  summary: string;
}

export function diagnoseKeyword(
  keyword: { id: number; seedKeyword: string; status: LinkStatus },
  sites: SiteView[],
  links: { siteId: number; status: LinkStatus; blocked?: boolean; blockedReason?: string }[],
  options: SelectorOptions,
): KeywordDiagnosis {
  const linkBySite = new Map(links.map((l) => [l.siteId, l.status]));
  const blockedBySite = new Map(
    links.filter((l) => l.blocked).map((l) => [l.siteId, l.blockedReason ?? '']),
  );

  const keywordProblem =
    keyword.status === 'go'
      ? null
      : keyword.status === 'done'
        ? 'The keyword is marked done, so the scheduler will not offer it anywhere.'
        : 'The keyword is marked no, so the scheduler will not offer it anywhere.';

  const verdicts: SiteVerdict[] = sites.map((site) => {
    const link: LinkStatus | 'unlinked' = linkBySite.get(site.id) ?? 'unlinked';
    const base = { siteId: site.id, domain: site.domain, link };

    if (link === 'unlinked') {
      return {
        ...base,
        ready: false,
        reason: 'Not linked to this site at all — set the cell to go on the Keywords page.',
        waitMinutes: null,
      };
    }
    if (link === 'done') {
      return {
        ...base,
        ready: false,
        reason: 'Already published here.',
        waitMinutes: null,
      };
    }
    if (link === 'no') {
      return {
        ...base,
        ready: false,
        reason: 'Set to no for this site.',
        waitMinutes: null,
      };
    }

    // Held back after repeated identical failures. Checked before the site's
    // condition because a healthy site does not make a blocked pair publish,
    // and "ready" here would be the exact lie this page exists to prevent.
    const blockedReason = blockedBySite.get(site.id);
    if (blockedReason !== undefined) {
      return {
        ...base,
        ready: false,
        blocked: true,
        reason: `Held back after repeated failures here. ${blockedReason}`.trim(),
        waitMinutes: null,
      };
    }

    // The cell says go, so from here it is entirely the site's condition.
    const verdict = evaluateSite(site, options);

    return {
      ...base,
      // A keyword whose global status blocks it is not ready anywhere, however
      // healthy the site is. Saying "ready" here and having it never publish
      // is the exact confusion this page exists to remove.
      ready: verdict.eligible && keywordProblem === null,
      reason:
        verdict.eligible && keywordProblem !== null
          ? `The site is ready, but ${keywordProblem[0]!.toLowerCase()}${keywordProblem.slice(1)}`
          : verdict.reason,
      waitMinutes: waitFrom(verdict.reason),
    };
  });

  const readyCount = verdicts.filter((v) => v.ready).length;

  return {
    keywordStatus: keyword.status,
    keywordProblem,
    sites: verdicts,
    readyCount,
    summary: summarise(keyword.seedKeyword, keywordProblem, verdicts, readyCount),
  };
}

/**
 * Pull the remaining wait out of an interval rejection.
 *
 * evaluateSite already formats it into its reason, and re-deriving it here
 * would mean two places that could disagree about the same number.
 */
function waitFrom(reason: string): number | null {
  const match = /(\d+)h (\d+)m remaining|(\d+)([mhd]) remaining/.exec(reason);
  if (!match) return null;

  if (match[1] !== undefined && match[2] !== undefined) {
    return Number(match[1]) * 60 + Number(match[2]);
  }

  const amount = Number(match[3]);
  const unit = match[4];
  if (!Number.isFinite(amount)) return null;
  return unit === 'd' ? amount * 1440 : unit === 'h' ? amount * 60 : amount;
}

function summarise(
  seedKeyword: string,
  keywordProblem: string | null,
  verdicts: SiteVerdict[],
  readyCount: number,
): string {
  if (readyCount > 0) {
    return `"${seedKeyword}" is ready to publish on ${readyCount} site(s) and will go out on the next check.`;
  }

  if (keywordProblem) return keywordProblem;

  const linked = verdicts.filter((v) => v.link === 'go');
  if (linked.length === 0) {
    const done = verdicts.filter((v) => v.link === 'done').length;
    return done > 0 && done === verdicts.filter((v) => v.link !== 'unlinked').length
      ? `"${seedKeyword}" has been published on every site it was linked to.`
      : `"${seedKeyword}" is not set to go on any site, so nothing will pick it up.`;
  }

  // Every site it wants is blocked. The soonest one is the useful number.
  const waits = linked.map((v) => v.waitMinutes).filter((w): w is number => w !== null);
  if (waits.length > 0) {
    const soonest = Math.min(...waits);
    return `"${seedKeyword}" is waiting on ${linked.length} site(s); the first is free in ${formatMinutes(soonest)}.`;
  }

  return `"${seedKeyword}" is set to go on ${linked.length} site(s), but none of them can publish right now — see the reasons below.`;
}
