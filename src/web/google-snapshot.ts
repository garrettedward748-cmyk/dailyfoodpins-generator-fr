import type { GoogleAccountView } from './views/google-accounts.js';

/**
 * The list of Google accounts, kept in the platform's own database.
 *
 * The accounts live in the image service, a separate container with its own
 * disk, so a platform backup used to leave them behind: a restored platform
 * met a service with one blank account. A copy of what the service holds
 * (names, Flow project IDs, limits, what each may make) is saved here every
 * time the page is opened, and it travels inside every backup. The sign-ins
 * themselves are browser profiles on the service's disk and do not move.
 */

export interface AccountSnap {
  id: number;
  label: string;
  project_id: string;
  daily_limit: number | null;
  monthly_limit: number | null;
  images: boolean;
  video: boolean;
}

export interface GoogleSnapshot {
  accounts: AccountSnap[];
  clip_cost: number | null;
}

export function takeSnapshot(accounts: GoogleAccountView[], clipCost?: number): GoogleSnapshot {
  return {
    accounts: accounts.map((a) => ({
      id: a.id,
      label: a.label,
      project_id: a.project_id ?? '',
      daily_limit: a.daily_limit ?? null,
      monthly_limit: a.monthly_limit ?? null,
      images: a.images !== false,
      video: a.video !== false,
    })),
    clip_cost: clipCost ?? null,
  };
}

export function parseSnapshot(raw: string): GoogleSnapshot | null {
  if (!raw.trim()) return null;
  try {
    const data = JSON.parse(raw) as GoogleSnapshot;
    return Array.isArray(data.accounts) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Whether the service holds less than the saved copy: an account it does not
 * have, or one whose Flow project it has lost. Then the copy is offered back
 * and is not overwritten with the emptier list.
 */
export function serviceIsBehind(snapshot: GoogleSnapshot, current: GoogleAccountView[]): boolean {
  return snapshot.accounts.some((saved) => {
    const now = current.find((a) => a.id === saved.id);
    if (!now) return true;
    return saved.project_id !== '' && !(now.project_id ?? '');
  });
}

/** How many accounts the copy would bring back or fill in. */
export function restorableCount(snapshot: GoogleSnapshot, current: GoogleAccountView[]): number {
  return snapshot.accounts.filter((saved) => {
    const now = current.find((a) => a.id === saved.id);
    return !now || (saved.project_id !== '' && !(now.project_id ?? ''));
  }).length;
}
