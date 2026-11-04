import { describe, expect, it, vi } from 'vitest';
import type { NearRpc } from '../seams/rpc';
import { buildRecord, characterHash, eventFromOutcome, loadRecord, type ChainPetRecord, type RecordEvidence, type RecordIndex } from './record';

const pet: ChainPetRecord = { owner_id: 'player.testnet', name: 'Pixel', character: 'Curious and dramatic.',
  born_at: Date.parse('2026-10-26T17:03:00Z') * 1_000_000, stage: 'Adult',
  traits: ['clever', 'clever'], outfits: [0, 2, 6] };
const index: RecordIndex = { tokenId: '9', worn: 'thinking-cap', transactions: [
  { kind: 'birth', ref: 'birth', txHash: 'birth-hash', at: 1 },
  { kind: 'growth', ref: 'Teen', txHash: 'teen-hash', at: 2 },
  { kind: 'growth', ref: 'Adult', txHash: 'adult-hash', at: 3 },
  { kind: 'item', ref: 'thinking-cap', txHash: 'cap-hash', at: 4 },
  { kind: 'item', ref: 'party-hat', txHash: 'hat-hash', at: 5 },
] };
const source = { version: '0.1.0', link: 'https://github.com/magestrio/nearling' };
const event = (name: 'pet_born' | 'grow' | 'outfit', data: Record<string, unknown>): RecordEvidence =>
  ({ kind: 'found', event: { event: name, data: { token_id: '9', ...data } } });
const evidence = (hash: string) => new Map<string, RecordEvidence>([
  ['birth-hash', event('pet_born', { character_sha256: hash })],
  ['teen-hash', event('grow', { stage: 'Teen', trait: 'clever' })],
  ['adult-hash', event('grow', { stage: 'Adult', trait: 'clever' })],
  ['cap-hash', event('outfit', { item: 2 })],
  ['hat-hash', event('outfit', { item: 6, price: '1660000000000000000000' })],
]);

describe('the public pet record', () => {
  // spec: add-verification › Verification record rule › характер запечатан
  // spec: add-verification › Verification record rule › код контракта
  it('links a matching hatch and states the upgradeable source metadata', async () => {
    const hash = await characterHash(pet.character);
    const record = buildRecord(pet, index, hash, evidence(hash), source, 'pets.testnet', 'testnet');
    expect(record.character).toBe('checked');
    expect(record.items[0]).toMatchObject({ kind: 'character', link: 'ready', txHash: 'birth-hash',
      proof: 'Sealed at hatch. This character matches the fingerprint Pixel got on NEAR on Oct 26, 2026.' });
    expect(record.items.at(-1)).toMatchObject({ kind: 'source', text: 'pets.testnet',
      proof: 'We can update the code with our key — every update is public.' });
    expect(record.source).toEqual(source);
  });

  // spec: add-verification › Verification record rule › характер не сошёлся
  it('withholds the hatch match when the current character differs', async () => {
    const record = buildRecord(pet, index, await characterHash(pet.character), evidence('f'.repeat(64)), source, 'pets.testnet', 'testnet');
    expect(record.character).toBe('mismatch');
    expect(record.items[0]?.proof).toBe("This character doesn't match the one sealed when Pixel hatched.");
  });

  // spec: add-verification › Verification record rule › рост и черты
  // spec: add-verification › Verification record rule › вещи
  it('preserves repeated traits, wardrobe order, a bought NEAR price, and the server-only worn line', async () => {
    const record = buildRecord(pet, index, await characterHash(pet.character), evidence(await characterHash(pet.character)), source, 'pets.testnet', 'testnet');
    expect(record.items.filter((item) => item.kind === 'growth').map((item) => item.text)).toEqual([
      'Became a teen — clever', 'Grew up — even more clever',
    ]);
    expect(record.items.filter((item) => item.kind === 'outfit').map((item) => item.text)).toEqual([
      'Thinking cap', 'Daisy crown', 'Party hat',
    ]);
    expect(record.items.find((item) => item.text === 'Thinking cap')?.proof).toBe('Wearing now · saved by the game, not on NEAR');
    expect(record.items.find((item) => item.text === 'Party hat')?.priceNear).toBe('0.00166 NEAR');
  });

  // spec: add-verification › Verification record rule › link not ready
  it('keeps on-chain items visible without guessing missing transaction links or claiming a hatch match', async () => {
    const without = { ...index, transactions: index.transactions.filter((tx) => tx.kind !== 'birth' && tx.ref !== 'party-hat') };
    const record = buildRecord(pet, without, await characterHash(pet.character), evidence(await characterHash(pet.character)), source, 'pets.testnet', 'testnet');
    expect(record.character).toBe('pending');
    expect(record.items[0]).toMatchObject({ kind: 'character', link: 'not-ready' });
    expect(record.items[0]?.proof).toBeUndefined();
    expect(record.items.find((item) => item.text === 'Party hat')?.link).toBe('not-ready');
    expect(record.items.find((item) => item.text === 'Party hat')?.txHash).toBeUndefined();
  });

  // spec: add-verification › Verification record rule › характер запечатан
  it('accepts only a successful transaction to this contract with the matching token event', () => {
    const log = (token: string) => `EVENT_JSON:${JSON.stringify({ standard: 'nearling', version: '1.0.0', event: 'pet_born', data: { token_id: token, character_sha256: 'a'.repeat(64) } })}`;
    const outcome = { status: { SuccessValue: '' }, transaction: { receiver_id: 'pets.testnet' }, receipts_outcome: [{ outcome: { logs: [log('9')] } }] };
    expect(eventFromOutcome(outcome, '9', 'pets.testnet')?.data.character_sha256).toBe('a'.repeat(64));
    expect(eventFromOutcome({ ...outcome, status: { Failure: {} } }, '9', 'pets.testnet')).toBeNull();
    expect(eventFromOutcome({ ...outcome, transaction: { receiver_id: 'other.testnet' } }, '9', 'pets.testnet')).toBeNull();
    expect(eventFromOutcome(outcome, '8', 'pets.testnet')).toBeNull();
  });

  // spec: add-verification › Verification record rule › характер запечатан
  // spec: add-verification › Verification record rule › код контракта
  it('loads pet_view and source metadata from RPC and checks the birth transaction there', async () => {
    const hash = await characterHash(pet.character);
    const log = `EVENT_JSON:${JSON.stringify({ standard: 'nearling', version: '1.0.0', event: 'pet_born', data: { token_id: '9', character_sha256: hash } })}`;
    const transaction = vi.fn().mockResolvedValue({ status: { SuccessValue: '' }, transaction: { receiver_id: 'pets.testnet' }, receipts_outcome: [{ outcome: { logs: [log] } }] });
    const viewFunction = vi.fn().mockImplementation((_id, method) => Promise.resolve(method === 'pet_view' ? pet : source));
    const record = await loadRecord({ viewFunction, transaction } as unknown as NearRpc, '9',
      { ...index, transactions: [index.transactions[0]!] }, 'pets.testnet', 'server.testnet', 'testnet');
    expect(viewFunction).toHaveBeenCalledWith('pets.testnet', 'pet_view', { token_id: '9' });
    expect(viewFunction).toHaveBeenCalledWith('pets.testnet', 'contract_source_metadata', {});
    expect(transaction).toHaveBeenCalledWith('birth-hash', 'server.testnet');
    expect(record?.character).toBe('checked');
    expect(record?.source).toEqual(source);
  });
});
