import { describe, expect, it } from 'vitest';
import { QuestionIndex, sameQuestion } from '../src/core/similar-title.js';

/** Blog questions get the same protection keywords have: one question, one article. */
describe('same question', () => {
  it.each([
    ['Can you freeze cheesecake?', 'Can You Freeze Cheesecake? Yes, Here Is How'],
    ['What is the difference between baking soda and baking powder?', 'Baking soda vs baking powder: what is the difference?'],
  ])('%s = %s', (a, b) => expect(sameQuestion(a, b)).toBe(true));

  it.each([
    ['Can you freeze cheesecake?', 'Can you freeze banana pudding?'],
    ['How long does cooked rice last in the fridge?', 'How long does cheesecake last in the fridge?'],
    ['Why is my cheesecake cracked?', 'How to stop cheesecake from cracking'],
  ])('%s ≠ %s', (a, b) => expect(sameQuestion(a, b)).toBe(false));

  it('pasted questions repeating one already there are left out', async () => {
    const { openDatabase, closeDatabase, run } = await import('../src/db/index.js');
    const { addBlogQuestions } = await import('../src/blog/repo.js');
    openDatabase(':memory:');
    try {
      run("INSERT INTO sites (name, domain, status) VALUES ('D', 'd.com', 'active')");
      expect(addBlogQuestions(1, ['Can you freeze cheesecake?']).added).toBe(1);
      const again = addBlogQuestions(1, ['Can You Freeze Cheesecake? Yes, Here Is How', 'Can you freeze banana pudding?']);
      expect(again).toMatchObject({ added: 1, skipped: 1 });
      expect(again.similar[0]).toMatch(/Can you freeze cheesecake/);
      expect(new QuestionIndex(['Can you freeze cheesecake?']).find('can you freeze cheesecake?', true)).toBeNull();
    } finally {
      closeDatabase();
    }
  });
});
