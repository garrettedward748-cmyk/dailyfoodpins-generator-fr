import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferClient } from '../src/integrations/buffer.js';

afterEach(() => vi.unstubAllGlobals());

describe('a Buffer login with more than one organization', () => {
  it('finds a channel connected in the second organization, after the first one\'s', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
      const body = JSON.parse(String(init.body));
      if (String(body.query).includes('GetOrganizations')) {
        return new Response(JSON.stringify({ data: { account: { organizations: [{ id: 'org1' }, { id: 'org2' }] } } }));
      }
      const channels = body.variables.orgId === 'org1'
        ? [{ id: 'fb', name: 'Page', service: 'facebook' }]
        : [{ id: 'tt', name: 'Recipes', service: 'tiktok' }];
      return new Response(JSON.stringify({ data: { channels } }));
    }));
    const found = await new BufferClient('tok').getChannels('org1');
    expect(found.map((c) => `${c.id}:${c.service}`)).toEqual(['fb:facebook', 'tt:tiktok']);
  });
});
