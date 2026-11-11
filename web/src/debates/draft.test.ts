import { describe, expect, it } from 'vitest';
import { DRAFT_KEY, eraseDraft, needsEligibilityRecheck, readDraft, saveDraft } from './draft';

function tab() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}

describe('tab debate draft', () => {
  const accountId = 'owner.near';
  // spec: add-debates › Debate invitation screen › success × known-pet selection
  // spec: add-debates › Debate invitation screen › success × topic edit
  // spec: add-debates › Debate invitation screen › success × opener selection
  // spec: add-debates › Debate invitation screen › success × reload
  it('restores only the selected pet, topic and opener for the same pet tab', () => {
    const storage = tab();
    saveDraft({ accountId, tokenId: '9', epoch: 2, selectedPet: '5', topic: 'Rain?', openerPet: '5', open: true }, storage);
    expect(readDraft('9', accountId, storage)).toEqual({ accountId, tokenId: '9', epoch: 2, selectedPet: '5', topic: 'Rain?', openerPet: '5', open: true });
    expect(readDraft('2', accountId, storage)).toBeNull();
    expect(readDraft('9', 'new-owner.near', storage)).toBeNull();
  });

  // spec: add-debates › Debate invitation screen › signed-out × sign-out/session expiry
  // spec: add-debates › Debate invitation screen › success × sign-out
  // spec: add-debates › Debate invitation screen › success × session expiry
  it('leaves the unsent draft in the tab while a session ends', () => {
    const storage = tab();
    saveDraft({ accountId, tokenId: '9', epoch: 2, selectedPet: '5', topic: 'Rain?', openerPet: '9', open: true }, storage);
    expect(readDraft('9', accountId, storage)?.topic).toBe('Rain?');
  });

  // spec: add-debates › Debate invitation screen › success × 00:00 UTC
  it('rechecks at the next UTC day', () => {
    expect(needsEligibilityRecheck(Date.UTC(2026, 10, 11, 23, 59), Date.UTC(2026, 10, 12))).toBe(true);
    expect(needsEligibilityRecheck(Date.UTC(2026, 10, 11, 3), Date.UTC(2026, 10, 11, 23))).toBe(false);
  });

  // spec: add-debates › Debate invitation screen › success × site data erased
  it('starts empty after site data is erased or malformed', () => {
    const storage = tab();
    storage.setItem(DRAFT_KEY, '{');
    expect(readDraft('9', accountId, storage)).toBeNull();
    saveDraft({ accountId, tokenId: '9', epoch: 2, selectedPet: '5', topic: 'Rain?', openerPet: '9', open: true }, storage);
    eraseDraft(storage);
    expect(readDraft('9', accountId, storage)).toBeNull();
  });

  // spec: add-debates › Debate invitation screen › success × memory clear
  it('rejects a draft from before a memory epoch change', () => {
    const storage = tab();
    saveDraft({ accountId, tokenId: '9', epoch: 2, selectedPet: '5', topic: 'Rain?', openerPet: '9', open: true }, storage);
    expect(readDraft('9', accountId, storage, 3)).toBeNull();
  });
});
