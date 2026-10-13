import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  deletePromptOverride,
  getPromptOverride,
  listPromptOverrides,
  setPromptOverride,
} from '../src/db/repos.js';
import {
  configurePrompts,
  invalidatePromptCache,
  loadPrompt,
  readShippedPrompt,
  render,
} from '../src/pipeline/prompts.js';
import { configurePromptFiles, listPromptFiles } from '../src/pipeline/prompt-files.js';
import { unknownVariables, variablesFor } from '../src/pipeline/prompt-contexts.js';

describe('editing a prompt', () => {
  beforeEach(() => {
    openDatabase(':memory:');
    configurePrompts('./prompts');
    configurePromptFiles('./prompts');
    invalidatePromptCache();
  });

  afterEach(() => {
    closeDatabase();
    invalidatePromptCache();
  });

  it('renders the shipped prompt when nothing is edited', () => {
    const context = { seo: { keyword: 'k' }, boardsJson: '[]' };
    const { user } = loadPrompt('pick-board', context);

    // loadPrompt renders; readShippedPrompt returns the raw template.
    expect(user.length).toBeGreaterThan(0);
    expect(user).toBe(render(readShippedPrompt('pick-board.user.txt'), context));
  });

  it('renders the edit once one is saved', () => {
    setPromptOverride('pick-board.user.txt', 'Pick a board for {{seo.keyword}}.');
    invalidatePromptCache();

    const { user } = loadPrompt('pick-board', { seo: { keyword: 'chicken' } });

    expect(user).toBe('Pick a board for chicken.');
  });

  it('goes back to the shipped text when the edit is deleted', () => {
    const shipped = readShippedPrompt('pick-board.user.txt');
    setPromptOverride('pick-board.user.txt', 'temporary');
    invalidatePromptCache();

    deletePromptOverride('pick-board.user.txt');
    invalidatePromptCache();

    const context = { seo: { keyword: 'k' }, boardsJson: '[]' };
    expect(loadPrompt('pick-board', context).user).toBe(render(shipped, context));
  });

  it('keeps the shipped text readable while an edit is in force', () => {
    // It is what "revert" restores, so it has to survive the edit.
    const shipped = readShippedPrompt('pick-board.user.txt');
    setPromptOverride('pick-board.user.txt', 'something else entirely');

    expect(readShippedPrompt('pick-board.user.txt')).toBe(shipped);
  });

  it('would serve a stale prompt without the cache being cleared', () => {
    loadPrompt('pick-board', { seo: { keyword: 'k' }, boardsJson: '[]' });
    setPromptOverride('pick-board.user.txt', 'brand new text');

    // Not cleared: the run in flight keeps the prompt it started with.
    const stale = loadPrompt('pick-board', { seo: { keyword: 'k' } }).user;
    expect(stale).not.toBe('brand new text');

    invalidatePromptCache();
    expect(loadPrompt('pick-board', { seo: { keyword: 'k' } }).user).toBe('brand new text');
  });

  it('marks an edited file in the listing', () => {
    setPromptOverride('pick-board.user.txt', 'edited');

    const listed = listPromptFiles().find((p) => p.file === 'pick-board.user.txt');

    expect(listed?.edited).toBe(true);
    expect(listPromptFiles().filter((p) => p.edited)).toHaveLength(1);
  });

  it('lists a file for every shipped prompt', () => {
    const files = listPromptFiles();

    expect(files.length).toBeGreaterThan(10);
    expect(files.every((f) => f.file.endsWith('.txt'))).toBe(true);
    expect(files.some((f) => f.prompt === 'part-1' && f.half === 'system')).toBe(true);
  });

  it('records the edit, not just the fact of it', () => {
    setPromptOverride('pick-board.user.txt', 'exact text');
    expect(getPromptOverride('pick-board.user.txt')).toBe('exact text');
    expect(listPromptOverrides()).toHaveLength(1);
  });
});

describe('the variables a prompt may use', () => {
  it('flattens the step context into dotted paths', () => {
    const variables = variablesFor('pick-board');

    expect(variables).toContain('seo.keyword');
    expect(variables).toContain('boardsJson');
  });

  it('knows the pin graphic template, which is not a prompt pair', () => {
    expect(variablesFor('pin-graphic.template')).toContain('imagePrompts.pin');
  });

  it('accepts a placeholder the step supplies', () => {
    expect(unknownVariables('pick-board', 'Board for {{seo.keyword}}')).toEqual([]);
  });

  it('flags one nothing supplies', () => {
    // These render as empty strings rather than failing, so the article comes
    // out quietly worse. Two shipped that way before this check existed.
    expect(unknownVariables('pick-board', 'Board for {{seo.nonsense}}')).toEqual(['seo.nonsense']);
  });

  it('reports each unknown placeholder once', () => {
    const body = '{{a.b}} then {{a.b}} again and {{c.d}}';
    expect(unknownVariables('pick-board', body).sort()).toEqual(['a.b', 'c.d']);
  });

  it('checks nothing for a file with no known context', () => {
    expect(unknownVariables('not-a-real-prompt', '{{anything.at.all}}')).toEqual([]);
  });
});
