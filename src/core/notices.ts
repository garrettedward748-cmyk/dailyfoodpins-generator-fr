import { get } from '../db/index.js';
import { noticeChanged } from '../db/repos.js';
import { readSupply, supplyWarning } from './supply.js';
import { TelegramClient } from '../integrations/telegram.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';

const log = createLogger('notices');

/**
 * The handful of things worth interrupting someone about.
 *
 * The wiring for Telegram existed and carried exactly one message: "published".
 * That is the event you least need to be told about — it is the system working.
 * What is worth a phone buzzing is the system having stopped, and nobody
 * knowing yet.
 *
 * Every notice here is a *state*, not an event, and each is announced only
 * when that state changes. A scheduler ticking every fifteen minutes would
 * otherwise send "the image service is down" ninety-six times before breakfast,
 * and a channel that cries wolf gets muted — which is worse than no channel.
 * Recovery is announced too: without it, "we are out of keywords" is the last
 * thing the channel ever says on the subject.
 *
 * Nothing here can fail a run. Every path is wrapped, and a notification that
 * did not send is not a reason for an article not to publish.
 */

export type NoticeKind =
  | 'supply'
  | 'site-failing'
  | 'image-service'
  | 'site-credentials'
  | 'awaiting-approval'
  | 'image-captcha';

export interface Notice {
  kind: NoticeKind;
  /** Identifies the thing this notice is about, so two sites are two notices. */
  subject: string;
  /** The state now. A message is sent only when this differs from last time. */
  state: string;
  message: string;
}

/** How many failures in a row before a site is worth mentioning. */
export const CONSECUTIVE_FAILURES_BEFORE_ALARM = 2;

/** Rejected image generations in the last day before it is worth saying. */
export const CAPTCHA_REJECTIONS_BEFORE_ALARM = 3;

/**
 * Image generations Google refused on a reCAPTCHA score, in the last day.
 *
 * Its own notice rather than folded into "a site is failing", because it is
 * not about a site: every site shares one browser session, and the fix is to
 * that session — open the Browser view and check the Google login. Left
 * unnamed it reads as several unrelated sites breaking at once.
 */
export function recentCaptchaRejections(): number {
  return (
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM runs
        WHERE status = 'failed'
          AND started_at >= datetime('now', '-1 day')
          AND error LIKE '%recaptcha%'`,
    )?.n ?? 0
  );
}

/**
 * Sites whose recent runs have failed `threshold` times in a row.
 *
 * Consecutive rather than a rate: three failures out of a hundred runs is
 * normal operation, three failures out of the last three means that site has
 * stopped working and nothing else will get through on it.
 */
export function failingSites(
  threshold = CONSECUTIVE_FAILURES_BEFORE_ALARM,
): { siteId: number; domain: string; failures: number; lastError: string }[] {
  const sites = get<{ n: number }>('SELECT COUNT(*) AS n FROM sites')?.n ?? 0;
  if (sites === 0) return [];

  // One pass per site is fine: this is a handful of rows on a schedule, and
  // the alternative is a window function this SQLite build need not have.
  const rows = get<{ ids: string }>("SELECT GROUP_CONCAT(id) AS ids FROM sites")?.ids ?? '';
  const failing: { siteId: number; domain: string; failures: number; lastError: string }[] = [];

  for (const raw of rows.split(',').filter(Boolean)) {
    const siteId = Number(raw);
    if (!Number.isFinite(siteId)) continue;

    const recent = get<{ statuses: string; domain: string; last_error: string | null }>(
      `SELECT (SELECT GROUP_CONCAT(status) FROM (
                 SELECT status FROM runs
                  WHERE site_id = ? AND status IN ('published', 'failed')
                  ORDER BY id DESC LIMIT ?
               ))                                              AS statuses,
              (SELECT domain FROM sites WHERE id = ?)          AS domain,
              (SELECT error FROM runs
                WHERE site_id = ? AND status = 'failed'
                ORDER BY id DESC LIMIT 1)                      AS last_error`,
      siteId,
      threshold,
      siteId,
      siteId,
    );

    const statuses = (recent?.statuses ?? '').split(',').filter(Boolean);
    if (statuses.length < threshold) continue;
    if (!statuses.every((s) => s === 'failed')) continue;

    failing.push({
      siteId,
      domain: recent?.domain ?? String(siteId),
      failures: statuses.length,
      lastError: (recent?.last_error ?? '').slice(0, 200),
    });
  }

  return failing;
}

/**
 * Everything currently worth saying, as states.
 *
 * `imageServiceProblem` is passed in rather than checked here: the web server
 * already polls it in the background, and a second poller would double the
 * traffic to a container that is by definition already struggling.
 */
export function currentNotices(imageServiceProblem: string | null): Notice[] {
  const notices: Notice[] = [];

  // -- Keyword supply ------------------------------------------------------
  const supply = readSupply();
  const supplyMessage = supplyWarning(supply);
  notices.push({
    kind: 'supply',
    subject: '',
    state: supply.level,
    message:
      supply.level === 'ok'
        ? `Keyword queue refilled — ${supply.readyPairs} article(s) queued.`
        : (supplyMessage ?? 'The keyword queue needs attention.'),
  });

  // -- The image service ---------------------------------------------------
  notices.push({
    kind: 'image-service',
    subject: '',
    state: imageServiceProblem ? 'down' : 'ok',
    message: imageServiceProblem
      ? `Image generation is not working: ${imageServiceProblem}`
      : 'Image generation is working again.',
  });

  // -- Sites that have stopped working ------------------------------------
  const broken = failingSites();
  const brokenIds = new Set(broken.map((s) => s.siteId));

  for (const site of broken) {
    notices.push({
      kind: 'site-failing',
      subject: site.domain,
      state: 'failing',
      message:
        `${site.domain} has failed its last ${site.failures} runs in a row.\n` +
        (site.lastError ? `Last error: ${site.lastError}` : ''),
    });
  }

  // Recovery for any site that was failing and is not any more. Only sites
  // with a run history are considered, so a newly added site does not
  // announce a recovery from a state it was never in.
  const known = get<{ ids: string }>(
    "SELECT GROUP_CONCAT(DISTINCT site_id) AS ids FROM runs WHERE site_id IS NOT NULL",
  )?.ids ?? '';

  for (const raw of known.split(',').filter(Boolean)) {
    const siteId = Number(raw);
    if (!Number.isFinite(siteId) || brokenIds.has(siteId)) continue;

    const domain = get<{ domain: string }>('SELECT domain FROM sites WHERE id = ?', siteId)?.domain;
    if (!domain) continue;

    notices.push({
      kind: 'site-failing',
      subject: domain,
      state: 'ok',
      message: `${domain} is publishing again.`,
    });
  }

  // -- Image generation being refused on its score -------------------------
  const rejections = recentCaptchaRejections();
  notices.push({
    kind: 'image-captcha',
    subject: '',
    state: rejections >= CAPTCHA_REJECTIONS_BEFORE_ALARM ? 'rejected' : 'ok',
    message:
      rejections >= CAPTCHA_REJECTIONS_BEFORE_ALARM
        ? `Google has refused ${rejections} image generation(s) in the last day on a ` +
          'reCAPTCHA score. The browser session is being treated as automated. ' +
          'Open Browser and check the Google login still looks normal.'
        : 'Image generations are being accepted again.',
  });

  // -- Articles waiting for a person --------------------------------------
  const waiting =
    get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE hold = 'awaiting'")?.n ?? 0;

  notices.push({
    kind: 'awaiting-approval',
    subject: '',
    // Bucketed, not the raw count: a message per article turns approval into
    // spam, and "some are waiting" is the whole of what needs saying.
    state: waiting === 0 ? 'none' : waiting < 5 ? 'some' : 'many',
    message:
      waiting === 0
        ? 'Every article waiting for approval has been dealt with.'
        : `${waiting} article(s) are written and waiting for you to approve them.`,
  });

  return notices;
}

/**
 * Send whatever has changed since the last check.
 *
 * Returns the messages actually sent, which is what the tests assert on —
 * "sent nothing the second time" being the property that matters most.
 */
export async function announceNotices(
  settings: Settings,
  imageServiceProblem: string | null,
): Promise<string[]> {
  if (!settings.getBool('telegram_enabled')) return [];

  const telegram = new TelegramClient(
    settings.get('telegram_bot_token'),
    settings.get('telegram_chat_id'),
  );

  const sent: string[] = [];

  for (const notice of currentNotices(imageServiceProblem)) {
    try {
      const key = notice.subject ? `${notice.kind}:${notice.subject}` : notice.kind;
      if (!noticeChanged(key, notice.state)) continue;

      // A first observation of a healthy state is not news. Without this every
      // fresh deployment opens with a burst of "X is working" messages.
      if (isHealthy(notice) && !seenBefore.has(key)) {
        seenBefore.add(key);
        continue;
      }
      seenBefore.add(key);

      await telegram.sendMessage(notice.message.trim());
      sent.push(notice.message.trim());
    } catch (err) {
      log.warn(`could not send the "${notice.kind}" notice: ${errorMessage(err)}`);
    }
  }

  return sent;
}

const isHealthy = (notice: Notice): boolean =>
  notice.state === 'ok' || notice.state === 'none';

/**
 * Which notices this process has already seen in some state.
 *
 * In memory on purpose. Its only job is to suppress the "everything is fine"
 * burst on the first check after a start, and persisting that would mean a
 * restart during an outage silently swallowing the recovery message.
 */
const seenBefore = new Set<string>();

/** Test seam: forget what this process has seen. */
export function resetNoticeMemory(): void {
  seenBefore.clear();
}
