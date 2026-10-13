import { presenterForPage } from '../db/repos.js';

/** The page's presenter as the prompt wants them, or null for a page without one. */
export function presenterFor(pageRowId: number | undefined): { name: string; voice: string } | null {
  if (!pageRowId) return null;
  const presenter = presenterForPage(pageRowId);
  return presenter ? { name: presenter.name, voice: presenter.voice_description } : null;
}
