import { describe, expect, it } from 'vitest';
import { cleanVideoTitle } from '../src/integrations/buffer.js';

describe('the title sent with a Facebook reel', () => {
  it('is plain text: one kind of space, no emoji or hidden characters', () => {
    expect(cleanVideoTitle('Tortilla de patatas au fromage : omelette espagnole fondante 🧀')).toBe(
      'Tortilla de patatas au fromage : omelette espagnole fondante',
    );
    expect(cleanVideoTitle('Fondant au caramel​, cœur coulant')).toBe('Fondant au caramel, cœur coulant');
    expect(cleanVideoTitle('x'.repeat(150))).toHaveLength(100);
  });
});
