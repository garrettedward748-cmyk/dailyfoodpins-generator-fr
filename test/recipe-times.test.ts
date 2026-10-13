import { describe, expect, it } from 'vitest';
import {
  allowedMinutes, canonicalTimes, durationsIn, formatMinutes, parseMinutes, timeBlocks, timeProblems,
} from '../src/core/recipe-times.js';

/**
 * One page said "ready in just 27 minutes" in its description and "Total 47 min"
 * on its card. The card's author had added a 20-minute wait before cooking to
 * the 5-minute rest after it. These pin the arithmetic so it is done once.
 */

describe('reading a time', () => {
  it.each([
    ['15 minutes', 15],
    ['15 mins', 15],
    ['1 hour', 60],
    ['1 hour 30 minutes', 90],
    ['1 hr 5 min', 65],
    ['1 hour and 30 minutes', 90],
    ['1.5 hours', 90],
    ['1½ hours', 90],
    ['1 1/2 hours', 90],
    ['1/2 hour', 30],
    ['2 hours', 120],
    ['90', 90],
    [45, 45],
    ['0 minutes', 0],
    ['', 0],
    ['None', 0],
    ['No cooking', 0],
  ])('reads %j as %j minutes', (text, minutes) => {
    expect(parseMinutes(text)).toBe(minutes);
  });

  it('takes the upper end of a range, because a total that is too short is the mistake', () => {
    expect(parseMinutes('10-15 minutes')).toBe(15);
    expect(parseMinutes('2 to 3 hours')).toBe(180);
  });

  it.each(['overnight', 'see notes', 'a while', null, undefined, {}])('does not guess at %j', (value) => {
    expect(parseMinutes(value)).toBeNull();
  });

  it('formats minutes the way the recipe writes them', () => {
    expect(formatMinutes(27)).toBe('27 minutes');
    expect(formatMinutes(1)).toBe('1 minute');
    expect(formatMinutes(60)).toBe('1 hour');
    expect(formatMinutes(65)).toBe('1 hour 5 minutes');
    expect(formatMinutes(125)).toBe('2 hours 5 minutes');
  });
});

describe('finding durations in prose', () => {
  it('reads each one, and an hour with its minutes as a single time', () => {
    const found = durationsIn('Sear for 5 minutes, roast 1 hour 30 minutes, then rest 10 mins.');
    expect(found.map((d) => d.minutes)).toEqual([[5], [90], [10]]);
  });

  it('keeps both ends of a range, because each is a claim', () => {
    expect(durationsIn('Bake 20-25 minutes.')[0]!.minutes).toEqual([20, 25]);
    expect(durationsIn('Cook 2 to 3 minutes.')[0]!.minutes).toEqual([2, 3]);
  });

  it('reads "30-minute" as a duration, so a title that says it is held to the recipe', () => {
    expect(durationsIn('A 30-Minute Steak')[0]!.minutes).toEqual([30]);
  });

  it('does not mistake other numbers for times', () => {
    expect(durationsIn('Heat to 400°F, serve 4, use 2 lb and 3 cups.')).toEqual([]);
    expect(durationsIn('A minute amount, the minimum, a hoursemaid.')).toEqual([]);
  });
});

describe('the recipe times, worked out once', () => {
  it('REGRESSION: the steak — prep 10, cook 12, total 27 leaves a 5 minute rest, not 25', () => {
    const times = canonicalTimes({ prep_time: '10 minutes', cook_time: '12 minutes', total_time: '27 minutes' });

    expect(times).toEqual({ prep: 10, cook: 12, rest: 5, total: 27, adjusted: false });
  });

  it('raises a total that is shorter than prep plus cook, and says it did', () => {
    const times = canonicalTimes({ prep_time: '20 minutes', cook_time: '30 minutes', total_time: '35 minutes' });

    expect(times).toEqual({ prep: 20, cook: 30, rest: 0, total: 50, adjusted: true });
  });

  it('takes prep plus cook as the total when the recipe gave none', () => {
    expect(canonicalTimes({ prep_time: '10 minutes', cook_time: '5 minutes' })).toEqual(
      { prep: 10, cook: 5, rest: 0, total: 15, adjusted: false },
    );
  });

  it('works for a dish that is not cooked', () => {
    expect(canonicalTimes({ prep_time: '15 minutes', cook_time: '0 minutes', total_time: '4 hours' })).toEqual(
      { prep: 15, cook: 0, rest: 225, total: 240, adjusted: false },
    );
  });

  it('is unknown, not guessed, when prep or cook cannot be read', () => {
    expect(canonicalTimes({ prep_time: 'overnight', cook_time: '5 minutes' })).toBeNull();
    expect(canonicalTimes({ cook_time: '5 minutes', prep_time: 'a while' })).toBeNull();
  });

  it('hands the prompts the same numbers it checks against', () => {
    const blocks = timeBlocks({ prep: 10, cook: 12, rest: 5, total: 27, adjusted: false });

    expect(blocks.summary).toContain('Total: 27 minutes');
    expect(blocks.summary).toContain('Prep: 10 minutes');
    expect(blocks.card).toContain('prep_minutes 10');
    expect(blocks.card).toContain('rest_minutes 5');
    expect(blocks.total).toBe('27');
  });

  it('tells the model to state no duration when the times are unknown', () => {
    const blocks = timeBlocks(null);
    expect(blocks.summary).toContain('State NO duration');
    expect(blocks.total).toBe('');
  });
});

describe('holding prose to the recipe', () => {
  const recipe = JSON.stringify({
    prep_time: '10 minutes', cook_time: '12 minutes', total_time: '27 minutes',
    step_1: 'Leave the steak out for 20 minutes.',
    step_2: 'Rest for 5 minutes. Roast 3-4 minutes.',
  });
  const times = canonicalTimes({ prep_time: '10 minutes', cook_time: '12 minutes', total_time: '27 minutes' });
  const allowed = allowedMinutes(recipe, times);

  it('allows every time the recipe itself gives', () => {
    expect([...allowed].sort((a, b) => a - b)).toEqual([3, 4, 5, 10, 12, 20, 27]);
  });

  it('REGRESSION: lets "27 minutes" through and refuses the card\'s "47"', () => {
    expect(timeProblems('Ready in just 27 minutes.', allowed, 'meta_desc')).toEqual([]);
    const problems = timeProblems('Ready in just 47 minutes.', allowed, 'meta_desc');
    expect(problems).toHaveLength(1);
    expect(problems[0]!.detail).toContain('47 minutes');
  });

  it('refuses a time the recipe never gave, and a sum of two that it did', () => {
    expect(timeProblems('Done in 30 minutes.', allowed, 'x')).toHaveLength(1);
    expect(timeProblems('Rest 5 minutes, sear 3-4 minutes.', allowed, 'x')).toEqual([]);
    expect(timeProblems('Sear 3-6 minutes.', allowed, 'x')).toHaveLength(1);
  });

  it('allows "1 hour" where the recipe says 60 minutes', () => {
    const sixty = allowedMinutes('Chill for 60 minutes.', null);
    expect(timeProblems('Chill for 1 hour.', sixty, 'x')).toEqual([]);
  });
});
