const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A Flow id as a person pastes it: on its own, or as the whole address of
 * the character's page. Either way the id is the last thing in it.
 */
export function idFromFlowUrl(value: string): string {
  const last = value.trim().split('/').filter(Boolean).pop() ?? '';
  const id = (last.split('?')[0] ?? '').toLowerCase();
  if (!ID.test(id)) {
    throw new Error(
      'That does not look like a Flow id. Copy it from the address bar: it is the long code after /character/.',
    );
  }
  return id;
}
