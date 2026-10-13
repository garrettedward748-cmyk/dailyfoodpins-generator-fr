import { readdirSync } from 'node:fs';
import { listPromptOverrides } from '../db/repos.js';
import { PROMPT_MODELS, readShippedPrompt } from './prompts.js';

/**
 * The prompt files, as the editor sees them.
 *
 * The list comes from what actually shipped in the image rather than from the
 * database, which also makes it the allow-list: a request names a file, and a
 * name that is not on this list reaches nothing. Without that, the file name
 * would be a path fragment pointing anywhere on disk.
 */

export interface PromptFile {
  file: string;
  prompt: string;
  half: string;
  model: string;
  edited: boolean;
  lines: number;
}

let promptsDir = './prompts';

export function configurePromptFiles(dir: string): void {
  promptsDir = dir;
}

function classify(file: string): { prompt: string; half: string } {
  const paired = /^(.+)\.(system|user)\.txt$/.exec(file);
  if (paired) return { prompt: paired[1]!, half: paired[2]! };
  return { prompt: file.replace(/\.txt$/, ''), half: 'template' };
}

export function listPromptFiles(): PromptFile[] {
  let files: string[];
  try {
    // The pin graphic has its own page (Setup -> Pin designs).
    files = readdirSync(promptsDir).filter((f) => f.endsWith('.txt') && f !== 'pin-graphic.template.txt');
  } catch {
    // A missing prompts directory means an editor with nothing in it, not a
    // crashed page.
    return [];
  }

  const edited = new Set(listPromptOverrides().map((o) => o.name));

  return files
    .map((file) => {
      const { prompt, half } = classify(file);
      const body = edited.has(file) ? '' : readShippedPrompt(file);
      return {
        file,
        prompt,
        half,
        model: PROMPT_MODELS[prompt]?.model ?? '',
        edited: edited.has(file),
        // Length of what will actually be sent, so an edit that doubles a
        // prompt is visible from the list.
        lines: (edited.has(file) ? overrideBody(file) : body).split('\n').length,
      };
    })
    .sort((a, b) => a.prompt.localeCompare(b.prompt) || a.half.localeCompare(b.half));
}

function overrideBody(file: string): string {
  return listPromptOverrides().find((o) => o.name === file)?.body ?? '';
}
