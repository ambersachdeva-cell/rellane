/** Keep unfinished messages on this Mac without turning saved context into authority. */
export interface ComposerDraft {
  readonly text: string;
  readonly selected: readonly string[];
}

const STORAGE_PREFIX = 'rellane.workstation.draft.v1.';
const MAX_TEXT_LENGTH = 100000;
const MAX_RAW_LENGTH = 120000;
const MAX_SELECTED_COUNT = 20;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

function isValidKey(key: unknown): boolean {
  if (typeof key !== 'string' || key.length === 0 || key.length > 64) {
    return false;
  }
  if (key === 'new:personal') {
    return true;
  }
  if (key.startsWith('new:')) {
    return isValidUuid(key.slice(4));
  }
  return isValidUuid(key);
}

function isValidDraft(value: unknown): value is ComposerDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.text !== 'string' || candidate.text.length > MAX_TEXT_LENGTH) {
    return false;
  }
  if (!Array.isArray(candidate.selected) || candidate.selected.length > MAX_SELECTED_COUNT) {
    return false;
  }
  const seen = new Set<string>();
  for (const id of candidate.selected) {
    if (!isValidUuid(id) || seen.has(id)) {
      return false;
    }
    seen.add(id);
  }
  return true;
}

export function readComposerDraft(
  storage: Pick<Storage, 'getItem'>,
  key: string
): ComposerDraft | null {
  if (!isValidKey(key)) {
    return null;
  }
  const raw = storage.getItem(STORAGE_PREFIX + key);
  if (typeof raw !== 'string' || raw.length > MAX_RAW_LENGTH) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    record.version !== 1 ||
    !('text' in record) ||
    !('selected' in record)
  ) {
    return null;
  }
  if (!isValidDraft(record)) {
    return null;
  }
  return {
    text: record.text,
    selected: Object.freeze([...record.selected]),
  };
}

export function writeComposerDraft(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  key: string,
  value: ComposerDraft
): void {
  if (!isValidKey(key) || !isValidDraft(value)) {
    throw new Error('Invalid composer draft or key');
  }
  const namespacedKey = STORAGE_PREFIX + key;
  if (value.text === '' && value.selected.length === 0) {
    storage.removeItem(namespacedKey);
    return;
  }
  const payload = JSON.stringify({
    version: 1,
    text: value.text,
    selected: [...value.selected],
  });
  if (payload.length > MAX_RAW_LENGTH) throw new Error('The encoded draft is too large to save safely.');
  storage.setItem(namespacedKey, payload);
}
