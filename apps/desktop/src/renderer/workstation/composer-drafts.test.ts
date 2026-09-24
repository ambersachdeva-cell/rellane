import { describe, expect, it } from 'vitest';
import {
  type ComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from './composer-drafts.js';

interface FakeStorageOverrides {
  getItem?: (key: string) => string | null;
  setItem?: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

function createFakeStorage(
  initial: Record<string, string> = {},
  overrides: FakeStorageOverrides = {}
) {
  const store = new Map<string, string>(Object.entries(initial));
  const storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
    getItem: (key: string) => {
      if (overrides.getItem) {
        return overrides.getItem(key);
      }
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem: (key: string, value: string) => {
      if (overrides.setItem) {
        return overrides.setItem(key, value);
      }
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      if (overrides.removeItem) {
        return overrides.removeItem(key);
      }
      store.delete(key);
    },
  };
  return { storage, store };
}

describe('composer-drafts', () => {
  it('preserves per-key roundtrip, source order, unicode, whitespace, and empty text with selections', () => {
    const { storage } = createFakeStorage();
    const taskKey = '550e8400-e29b-41d4-a716-446655440000';
    const newPersonalKey = 'new:personal';
    const newProjectKey = 'new:a0000000-0000-0000-0000-000000000001';

    const unicodeText = '  Prompt line 1\n\tTabbed line 2 🚀\r\n日本語 / Español café   ';
    const selectedOrder = [
      'c0000000-0000-0000-0000-000000000003',
      'b0000000-0000-0000-0000-000000000002',
      'a0000000-0000-0000-0000-000000000001',
    ];

    const taskDraft: ComposerDraft = {
      text: unicodeText,
      selected: selectedOrder,
    };
    const personalDraft: ComposerDraft = {
      text: '',
      selected: ['a0000000-0000-0000-0000-000000000001'],
    };
    const projectDraft: ComposerDraft = {
      text: 'Project text with exact whitespace \n\n ',
      selected: [],
    };

    writeComposerDraft(storage, taskKey, taskDraft);
    writeComposerDraft(storage, newPersonalKey, personalDraft);
    writeComposerDraft(storage, newProjectKey, projectDraft);

    const readTask = readComposerDraft(storage, taskKey);
    expect(readTask).not.toBeNull();
    expect(readTask?.text).toBe(unicodeText);
    expect(readTask?.selected).toEqual(selectedOrder);

    const readPersonal = readComposerDraft(storage, newPersonalKey);
    expect(readPersonal).not.toBeNull();
    expect(readPersonal?.text).toBe('');
    expect(readPersonal?.selected).toEqual(['a0000000-0000-0000-0000-000000000001']);

    const readProject = readComposerDraft(storage, newProjectKey);
    expect(readProject).not.toBeNull();
    expect(readProject?.text).toBe('Project text with exact whitespace \n\n ');
    expect(readProject?.selected).toEqual([]);
  });

  it('returns null on oversized (>120000 chars) raw data and malformed JSON', () => {
    const taskKey = '550e8400-e29b-41d4-a716-446655440000';
    const prefix = 'rellane.workstation.draft.v1.';
    const { storage, store } = createFakeStorage({
      [`${prefix}${taskKey}`]: 'x'.repeat(120001),
    });

    expect(readComposerDraft(storage, taskKey)).toBeNull();
    expect(store.get(`${prefix}${taskKey}`)).toBe('x'.repeat(120001));

    store.set(`${prefix}${taskKey}`, '{"version": 1, "text": "unclosed json');
    expect(readComposerDraft(storage, taskKey)).toBeNull();

    store.set(`${prefix}${taskKey}`, '12345');
    expect(readComposerDraft(storage, taskKey)).toBeNull();

    store.set(`${prefix}${taskKey}`, 'null');
    expect(readComposerDraft(storage, taskKey)).toBeNull();

    expect(readComposerDraft(storage, 'not-a-valid-key')).toBeNull();
  });

  it('returns null when stored data has wrong version, extra fields, or invalid selected UUIDs', () => {
    const taskKey = '550e8400-e29b-41d4-a716-446655440000';
    const prefix = 'rellane.workstation.draft.v1.';
    const { storage, store } = createFakeStorage();

    store.set(
      `${prefix}${taskKey}`,
      JSON.stringify({ version: 2, text: 'draft', selected: [] })
    );
    expect(readComposerDraft(storage, taskKey)).toBeNull();

    store.set(
      `${prefix}${taskKey}`,
      JSON.stringify({ version: 1, text: 'draft', selected: [], extra: 'disallowed' })
    );
    expect(readComposerDraft(storage, taskKey)).toBeNull();

    store.set(
      `${prefix}${taskKey}`,
      JSON.stringify({ version: 1, text: 'draft', selected: ['not-a-uuid'] })
    );
    expect(readComposerDraft(storage, taskKey)).toBeNull();

    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    store.set(
      `${prefix}${taskKey}`,
      JSON.stringify({ version: 1, text: 'draft', selected: [uuid, uuid] })
    );
    expect(readComposerDraft(storage, taskKey)).toBeNull();

    const twentyOneUuids = Array.from({ length: 21 }, (_, i) =>
      `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`
    );
    store.set(
      `${prefix}${taskKey}`,
      JSON.stringify({ version: 1, text: 'draft', selected: twentyOneUuids })
    );
    expect(readComposerDraft(storage, taskKey)).toBeNull();
  });

  it('rejects invalid writes before touching storage and preserves existing saved data', () => {
    const taskKey = '550e8400-e29b-41d4-a716-446655440000';
    const { storage } = createFakeStorage();

    const originalDraft: ComposerDraft = {
      text: 'Original preserved text',
      selected: ['a0000000-0000-0000-0000-000000000001'],
    };
    writeComposerDraft(storage, taskKey, originalDraft);

    expect(() => writeComposerDraft(storage, '', originalDraft)).toThrow();
    expect(() => writeComposerDraft(storage, 'not-a-uuid', originalDraft)).toThrow();
    expect(() => writeComposerDraft(storage, 'new:not-a-uuid', originalDraft)).toThrow();
    expect(() => writeComposerDraft(storage, 'key\nwith\ncontrol', originalDraft)).toThrow();

    const oversizedDraft: ComposerDraft = {
      text: 'a'.repeat(100001),
      selected: [],
    };
    expect(() => writeComposerDraft(storage, taskKey, oversizedDraft)).toThrow();
    expect(() => writeComposerDraft(storage, taskKey, { text: '\u0001'.repeat(100000), selected: [] })).toThrow();

    const twentyOneUuids = Array.from({ length: 21 }, (_, i) =>
      `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`
    );
    expect(() =>
      writeComposerDraft(storage, taskKey, { text: 'valid', selected: twentyOneUuids })
    ).toThrow();

    const duplicateUuid = 'a0000000-0000-0000-0000-000000000001';
    expect(() =>
      writeComposerDraft(storage, taskKey, {
        text: 'valid',
        selected: [duplicateUuid, duplicateUuid],
      })
    ).toThrow();

    const readBack = readComposerDraft(storage, taskKey);
    expect(readBack).toEqual(originalDraft);
  });

  it('propagates storage quota and getItem exceptions while preserving existing saved data', () => {
    const taskKey = '550e8400-e29b-41d4-a716-446655440000';
    const prefix = 'rellane.workstation.draft.v1.';
    const initialDraft: ComposerDraft = {
      text: 'Initial saved text',
      selected: ['a0000000-0000-0000-0000-000000000001'],
    };
    const { storage } = createFakeStorage({
      [`${prefix}${taskKey}`]: JSON.stringify({
        version: 1,
        text: initialDraft.text,
        selected: initialDraft.selected,
      }),
    });

    const quotaStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
      getItem: storage.getItem,
      removeItem: storage.removeItem,
      setItem: () => {
        throw new Error('QuotaExceededError: LocalStorage quota exceeded');
      },
    };

    const newDraft: ComposerDraft = {
      text: 'New attempt that will fail quota',
      selected: [],
    };

    expect(() => writeComposerDraft(quotaStorage, taskKey, newDraft)).toThrow(
      /QuotaExceededError/
    );

    const preserved = readComposerDraft(storage, taskKey);
    expect(preserved).toEqual(initialDraft);

    const throwingGetStorage: Pick<Storage, 'getItem'> = {
      getItem: () => {
        throw new Error('StorageAccessDenied');
      },
    };
    expect(() => readComposerDraft(throwingGetStorage, taskKey)).toThrow('StorageAccessDenied');
  });

  it('clears only its own namespaced key when text and selected are empty', () => {
    const taskKeyA = '550e8400-e29b-41d4-a716-446655440000';
    const taskKeyB = '660e8400-e29b-41d4-a716-446655440000';
    const unrelatedKey = 'other.app.setting';
    const { storage, store } = createFakeStorage({
      [unrelatedKey]: 'must-not-be-touched',
    });

    const draftA: ComposerDraft = { text: 'Draft A text', selected: [] };
    const draftB: ComposerDraft = { text: 'Draft B text', selected: [] };

    writeComposerDraft(storage, taskKeyA, draftA);
    writeComposerDraft(storage, taskKeyB, draftB);

    expect(readComposerDraft(storage, taskKeyA)?.text).toBe('Draft A text');
    expect(readComposerDraft(storage, taskKeyB)?.text).toBe('Draft B text');

    writeComposerDraft(storage, taskKeyA, { text: '', selected: [] });

    expect(readComposerDraft(storage, taskKeyA)).toBeNull();
    expect(readComposerDraft(storage, taskKeyB)?.text).toBe('Draft B text');
    expect(store.get(unrelatedKey)).toBe('must-not-be-touched');
    expect(store.has(`rellane.workstation.draft.v1.${taskKeyA}`)).toBe(false);
    expect(store.has(`rellane.workstation.draft.v1.${taskKeyB}`)).toBe(true);
  });
});
