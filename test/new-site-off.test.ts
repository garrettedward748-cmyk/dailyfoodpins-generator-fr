import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { addProfile, firstProfile, getSite, listProfiles, setProfileKinds, startSiteOff, updateProfile, upsertSite } from '../src/db/repos.js';

const KEY = randomBytes(32);

const newSite = (domain: string): number =>
  Number(
    upsertSite(
      { name: domain, domain, status: 'paused', pin_username: '', project_id: '', daily_target: 3, interval_minutes: 60 },
      KEY,
    ),
  );

describe('a site added from the interface starts with every network off', () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });

  afterEach(() => {
    closeDatabase();
  });

  it('switches off account 1 of every network and unticks posts and reels', () => {
    const siteId = newSite('new.example.com');

    startSiteOff(siteId);

    const profiles = listProfiles(siteId);
    expect(profiles.map((p) => p.platform).sort()).toEqual(['facebook', 'instagram', 'pinterest', 'tiktok', 'youtube']);
    for (const p of profiles) {
      expect(p.enabled).toBe(0);
      expect((p as { posts?: number }).posts).toBe(0);
      expect((p as { reels?: number }).reels).toBe(0);
    }
    const site = getSite(siteId) as { pin_posts: number; pin_reels: number; ig_posts: number; ig_reels: number };
    expect([site.pin_posts, site.pin_reels, site.ig_posts, site.ig_reels]).toEqual([0, 0, 0, 0]);
  });

  it('turns back on when the owner ticks Posts on the account', () => {
    const siteId = newSite('new.example.com');
    startSiteOff(siteId);
    const pin = firstProfile(siteId, 'pinterest');

    updateProfile(pin.id, { enabled: 1 });
    setProfileKinds(pin.id, true, false);

    expect((getSite(siteId) as { pin_posts: number }).pin_posts).toBe(1);
  });

  it('adds a further account switched off when asked', () => {
    const siteId = newSite('new.example.com');
    startSiteOff(siteId);

    const id = addProfile(siteId, 'pinterest', { off: true });
    const added = listProfiles(siteId, 'pinterest').find((p) => p.id === id)!;

    expect(added.enabled).toBe(0);
    expect(added.position).toBe(2);
  });

  it('REGRESSION new.recipenestle.com: an account switched off with its ticks still set makes no pins or reels', () => {
    const siteId = newSite('new.example.com');
    const pin = firstProfile(siteId, 'pinterest'); // on, Posts and Reels ticked
    const ig = firstProfile(siteId, 'instagram');
    setProfileKinds(pin.id, true, true);
    setProfileKinds(ig.id, true, true);

    updateProfile(pin.id, { enabled: 0 });
    updateProfile(ig.id, { enabled: 0 });

    const site = getSite(siteId) as { pin_posts: number; pin_reels: number; ig_posts: number; ig_reels: number };
    expect([site.pin_posts, site.pin_reels, site.ig_posts, site.ig_reels]).toEqual([0, 0, 0, 0]);

    updateProfile(pin.id, { enabled: 1 });
    expect((getSite(siteId) as { pin_posts: number; pin_reels: number }).pin_posts).toBe(1);
    expect((getSite(siteId) as { pin_posts: number; pin_reels: number }).pin_reels).toBe(1);
  });

  it('leaves the code default alone: an account made without the option is on', () => {
    const siteId = newSite('old.example.com');
    const pin = firstProfile(siteId, 'pinterest');
    expect(pin.enabled).toBe(1);
  });
});
