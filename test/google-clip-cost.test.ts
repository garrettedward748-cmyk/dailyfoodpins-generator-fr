import { expect, it } from 'vitest';
import { googleAccountsPage, type GoogleAccountView } from '../src/web/views/google-accounts.js';

/** A clip cost above an account's limit used to leave it silently unable to make any reel. */

const account = (id: number, daily: number | null): GoogleAccountView => ({
  id, label: String(id), status: 'ok', until: null, reason: null, active: id === 1,
  project_id: 'p', daily_limit: daily, monthly_limit: null, used_today: 0, used_month: 0,
});

it('warns when one clip costs more than an account limit', () => {
  const body = String(googleAccountsPage({ reachable: true, pending: null, clipCost: 10000, accounts: [account(1, 84), account(2, null)] }));
  expect(body).toContain('more than the limit of account');
  expect(body).toContain('#1');
  expect(body).toContain('can never make a reel');
});

it('treats 0 as not counting: no warning, and 0 is the default shown', () => {
  const body = String(googleAccountsPage({ reachable: true, pending: null, accounts: [account(1, 84)] }));
  expect(body).not.toContain('can never make a reel');
  expect(body).toContain('min="0" name="clip_cost" value="0"');
});
