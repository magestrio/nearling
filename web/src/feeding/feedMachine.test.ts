import { describe, expect, it } from 'vitest';
import type { FeedSheetData } from '../seams/worker-types';
import { canTap, initial, opening, reduce, type Action, type Phase } from './feedMachine';

const sheet = (over: Partial<FeedSheetData> = {}): FeedSheetData => ({
  chain: true,
  viewer: 'owner',
  name: 'Pixel',
  fullness: { state: 'hungry', level: 0.25 },
  portions: [
    { near: '0.01', yocto: '10000000000000000000000', cents: 5, missing: null },
    { near: '0.05', yocto: '50000000000000000000000', cents: 23, missing: null },
    { near: '0.2', yocto: '200000000000000000000000', cents: 92, missing: null },
  ],
  wallet: { state: 'some', balance: '310000000000000000000000' },
  snack: { state: 'none' },
  hatched: true,
  friend: null,
  pending: null,
  ...over,
});

const run = (phase: Phase, ...actions: Action[]): Phase => actions.reduce(reduce, phase);
const open = (over?: Partial<FeedSheetData>): Phase => ({ kind: 'open', sheet: sheet(over) });
const portion = { kind: 'portion', portion: '0.05' } as const;

describe('the phases of Feed sheet', () => {
  // spec: add-feeding › Feed sheet screen › success (владелец)
  it('opens reading, and the answer is the sheet', () => {
    expect(initial).toEqual({ kind: 'reading', failed: false });
    expect(run(initial, { type: 'answer', sheet: sheet() })).toEqual(open());
  });

  // spec: add-feeding › Feed sheet screen › error
  it('a read that fails is the error, and «Try again» reads again', () => {
    const failed = run(initial, { type: 'readFailed' });
    expect(failed).toEqual({ kind: 'reading', failed: true });
    expect(run(failed, { type: 'retry' })).toEqual({ kind: 'reading', failed: false });
    expect(run(failed, { type: 'retry' }, { type: 'answer', sheet: sheet() })).toEqual(open());
  });

  // spec: add-feeding › Feed sheet screen › лист обновляется сам
  it('a poll that fails leaves the sheet as it is, and a poll that answers redraws it', () => {
    expect(run(open(), { type: 'readFailed' })).toEqual(open());
    const guest = sheet({ viewer: 'guest', snack: { state: 'ready' } });
    expect(run(open(), { type: 'answer', sheet: guest })).toEqual({ kind: 'open', sheet: guest });
  });

  // spec: add-feeding › Feeding connection rule › сеть NEAR недоступна
  it('a network that does not read is a sheet with nothing to tap; «Try again» reads again', () => {
    const none = run(initial, { type: 'answer', sheet: { chain: false } });
    expect(none).toEqual({ kind: 'open', sheet: { chain: false } });
    expect(canTap(none)).toBe(false);
    expect(run(none, { type: 'tap', what: portion })).toBe(none);
    expect(run(none, { type: 'retry' })).toEqual({ kind: 'reading', failed: false });
  });

  // spec: add-feeding › Feeding outcome rule › отправлено × repeat tap
  it('a tap sends; a repeat tap, on the row or any other, does nothing', () => {
    const sending = run(open(), { type: 'tap', what: portion });
    expect(sending).toMatchObject({ kind: 'sending', what: portion, source: 'near', checking: false });
    expect(canTap(sending)).toBe(false);
    expect(run(sending, { type: 'tap', what: portion })).toBe(sending);
    expect(run(sending, { type: 'tap', what: { kind: 'snack' } })).toBe(sending);
  });

  // spec: add-feeding › Feeding outcome rule › исход неизвестен
  it('«Still checking…» at 10 s, and an unknown outcome keeps it', () => {
    const sending = run(open(), { type: 'tap', what: { kind: 'snack' } });
    const checking = run(sending, { type: 'checking' });
    expect(checking).toMatchObject({ kind: 'sending', checking: true, source: 'snack' });
    expect(run(sending, { type: 'outcome', status: 'unknown' })).toMatchObject({ kind: 'sending', checking: true });
    expect(run(checking, { type: 'outcome', status: 'unknown' })).toBe(checking);
    expect(canTap(checking)).toBe(false);
  });

  // spec: add-feeding › Feeding outcome rule › reopened on its way
  it('a sheet reopened while its answer carries a flight is «Still checking…» at once', () => {
    const pending = { id: 'h', source: 'near' as const, tokenId: '9' };
    const phase = run(initial, { type: 'answer', sheet: sheet({ pending }) });
    expect(phase).toMatchObject({ kind: 'sending', what: null, source: 'near', checking: true });
    expect(canTap(phase)).toBe(false);
    // then as «исход неизвестен»: the confirmation or the failure
    expect(run(phase, { type: 'outcome', status: 'ok' })).toMatchObject({ kind: 'yum' });
    expect(run(phase, { type: 'outcome', status: 'failed' })).toMatchObject({ kind: 'failed', what: null, source: 'near' });
  });

  // spec: add-feeding › Own pet feeding flow › накормил бодрствующего
  it('a confirmed meal for the owner\'s awake pet is «Yum!», and «Done» closes', () => {
    const yum = run(open(), { type: 'tap', what: portion }, { type: 'outcome', status: 'ok' });
    expect(yum).toMatchObject({ kind: 'yum' });
    expect(run(yum, { type: 'done' })).toEqual({ kind: 'done' });
  });

  // spec: add-feeding › Own pet feeding flow › разбудил
  it('a confirmed meal for the owner\'s asleep pet closes the sheet by itself', () => {
    const asleep = open({ fullness: { state: 'asleep', level: 0 } });
    expect(run(asleep, { type: 'tap', what: portion }, { type: 'outcome', status: 'ok' })).toEqual({ kind: 'done' });
  });

  // spec: add-feeding › Owner snack flow › даёт перекус
  it('a confirmed snack of the owner closes the sheet by itself', () => {
    const asleep = open({ fullness: { state: 'asleep', level: 0 }, snack: { state: 'ready' } });
    expect(run(asleep, { type: 'tap', what: { kind: 'snack' } }, { type: 'outcome', status: 'ok' })).toEqual({ kind: 'done' });
  });

  // spec: add-feeding › Feed by link flow › друг покормил
  it('a friend\'s confirmed meal or snack is the thanks with the name the server sent', () => {
    const guest = open({ viewer: 'guest', hatched: true });
    const thanks = run(guest, { type: 'tap', what: portion }, { type: 'outcome', status: 'ok', friend: 'Maya', hatched: true });
    expect(thanks).toMatchObject({ kind: 'thanks', friend: 'Maya', hatched: true });
    expect(run(guest, { type: 'tap', what: { kind: 'snack' } }, { type: 'outcome', status: 'ok', hatched: true })).toMatchObject({ kind: 'thanks', friend: null });
    expect(run(thanks, { type: 'done' })).toEqual({ kind: 'done' });
  });

  // spec: add-feeding › Feed by link flow › у друга нет своего питомца
  it('the thanks of a friend with no pet of their own says so', () => {
    const guest = open({ viewer: 'guest', hatched: false });
    expect(run(guest, { type: 'tap', what: portion }, { type: 'outcome', status: 'ok', hatched: false })).toMatchObject({ kind: 'thanks', hatched: false });
  });

  // spec: add-feeding › Feeding outcome rule › не прошло × Try again
  it('a failure keeps the other rows active; «Try again» sends the same portion or snack from the start', () => {
    const failed = run(open(), { type: 'tap', what: portion }, { type: 'outcome', status: 'failed' });
    expect(failed).toMatchObject({ kind: 'failed', what: portion, source: 'near' });
    expect(canTap(failed)).toBe(true);
    expect(run(failed, { type: 'retry' })).toMatchObject({ kind: 'sending', what: portion, checking: false });
    expect(run(failed, { type: 'tap', what: { kind: 'portion', portion: '0.2' } })).toMatchObject({ kind: 'sending', what: { portion: '0.2' } });
    const snackFailed = run(open(), { type: 'tap', what: { kind: 'snack' } }, { type: 'outcome', status: 'failed' });
    expect(run(snackFailed, { type: 'retry' })).toMatchObject({ kind: 'sending', what: { kind: 'snack' }, source: 'snack' });
  });

  // spec: add-feeding › Feeding outcome rule › не прошло × Try again
  it('«Try again» of a failure of another flight reads the sheet again', () => {
    const phase = run(initial, { type: 'answer', sheet: sheet({ pending: { id: 'h', source: 'near', tokenId: '9' } }) }, { type: 'outcome', status: 'failed' });
    expect(run(phase, { type: 'retry' })).toEqual({ kind: 'reading', failed: false });
  });

  // spec: add-feeding › Feed sheet screen › лист обновляется сам
  it('a newer sheet redraws under a line that stands and changes nothing once the thanks is on', () => {
    const sending = run(open(), { type: 'tap', what: portion });
    const newer = sheet({ fullness: { state: 'full', level: 1 } });
    expect(run(sending, { type: 'answer', sheet: newer })).toMatchObject({ kind: 'sending', sheet: newer, what: portion });
    expect(run(sending, { type: 'answer', sheet: { chain: false } })).toBe(sending);
    const yum = run(sending, { type: 'outcome', status: 'ok' });
    expect(run(yum, { type: 'answer', sheet: sheet() })).toBe(yum);
  });

  // spec: add-feeding › Feeding outcome rule › reopened on its way
  it('a sheet opened or refreshed while this tab\'s meal stands is «Still checking…» at once, whatever the server\'s row says', () => {
    const standing = { source: 'near' as const, wasAsleep: true };
    expect(run(initial, { type: 'answer', sheet: sheet(), standing })).toMatchObject({ kind: 'sending', what: null, checking: true, source: 'near', wasAsleep: true });
    // a meal of another tab shows in the answer's `pending`, also for a sheet that was open
    const pending = { id: 'h', source: 'snack' as const, tokenId: '2' };
    expect(run(open(), { type: 'answer', sheet: sheet({ pending }) })).toMatchObject({ kind: 'sending', what: null, checking: true, source: 'snack' });
  });

  // spec: add-feeding › Feeding outcome rule › reopened on its way × the network does not read
  it('a reopened sheet whose network does not read is «Still checking…», never the line that says nothing was spent', () => {
    const standing = { source: 'near' as const, wasAsleep: false };
    const blind = run(initial, { type: 'answer', sheet: { chain: false }, standing });
    expect(blind).toMatchObject({ kind: 'sending', sheet: null, what: null, source: 'near', checking: true });
    expect(canTap(blind)).toBe(false);
    // opened on the flight from the start: the same phase before any answer
    expect(opening(standing)).toMatchObject({ kind: 'sending', sheet: null, checking: true });
    expect(opening(null)).toBe(initial);
    // another answer without data, a poll or a refusal changes nothing
    expect(run(blind, { type: 'answer', sheet: { chain: false }, standing })).toBe(blind);
    // no flight, no answer with data: the plain «We can't feed {name} right now»
    expect(run(initial, { type: 'answer', sheet: { chain: false } })).toEqual({ kind: 'open', sheet: { chain: false } });
    // the first answer with data under the flight draws the sheet with the line standing
    expect(run(blind, { type: 'answer', sheet: sheet(), standing })).toMatchObject({ kind: 'sending', sheet: sheet(), what: null, checking: true });
  });

  // spec: add-feeding › Feeding outcome rule › reopened on its way × the network does not read
  it('an outcome that comes while the sheet is blind waits for the first answer with data, and the viewer decides how it is drawn', () => {
    const standing = { source: 'near' as const, wasAsleep: false };
    const blind = opening(standing);
    const okBlind = run(blind, { type: 'outcome', status: 'ok', friend: 'Maya', hatched: true });
    expect(okBlind).toMatchObject({ kind: 'sending', sheet: null });
    expect(run(okBlind, { type: 'answer', sheet: { chain: false } })).toBe(okBlind);
    expect(run(okBlind, { type: 'answer', sheet: sheet() })).toMatchObject({ kind: 'yum' });
    expect(run(okBlind, { type: 'answer', sheet: sheet({ viewer: 'guest' }) })).toMatchObject({ kind: 'thanks', friend: 'Maya', hatched: true });
    expect(run(opening({ source: 'near', wasAsleep: true }), { type: 'outcome', status: 'ok' }, { type: 'answer', sheet: sheet() })).toEqual({ kind: 'done' });
    const failedBlind = run(blind, { type: 'outcome', status: 'failed' }, { type: 'answer', sheet: sheet() });
    expect(failedBlind).toMatchObject({ kind: 'failed', what: null, source: 'near' });
    // an unknown outcome keeps the line
    expect(run(blind, { type: 'outcome', status: 'unknown' })).toBe(blind);
  });

  // spec: add-feeding › Feeding outcome rule › reopened on its way × another pet
  it('a sheet that watches a flight which is not its own opens again once the flight is gone, and reads again at its end', () => {
    const watching = run(initial, { type: 'answer', sheet: sheet(), standing: { source: 'near', wasAsleep: false } });
    // the flight still stands: nothing changes
    expect(run(watching, { type: 'answer', sheet: sheet(), standing: { source: 'near', wasAsleep: false } })).toMatchObject({ kind: 'sending', what: null });
    // no flight and no row: the poll finds the sheet idle
    expect(run(watching, { type: 'answer', sheet: sheet() })).toEqual(open());
    expect(run(watching, { type: 'reread' })).toEqual({ kind: 'reading', failed: false });
    // a meal of this sheet's own tap is not touched by an answer without a row
    const own = run(open(), { type: 'tap', what: portion });
    expect(run(own, { type: 'answer', sheet: sheet() })).toMatchObject({ kind: 'sending', what: portion });
  });

  // spec: add-feeding › Snack rule › друг уже давал перекус сегодня
  it('a flight that ended with the sheet changed under it — `409 short`, `snack_gone`, a network that does not read — draws that answer', () => {
    const sending = run(open(), { type: 'tap', what: { kind: 'snack' } });
    const gone = sheet({ viewer: 'guest', snack: { state: 'given' } });
    expect(run(sending, { type: 'redraw', sheet: gone })).toEqual({ kind: 'open', sheet: gone });
    expect(run(sending, { type: 'redraw', sheet: { chain: false } })).toEqual({ kind: 'open', sheet: { chain: false } });
    // nothing on its way: nothing to redraw
    expect(run(open(), { type: 'redraw', sheet: gone })).toEqual(open());
  });

  // spec: add-feeding › Own pet feeding flow › накормил бодрствующего
  it('the fullness read after a confirmed meal is the pet the thanks and «Yum!» show', () => {
    const yum = run(open(), { type: 'tap', what: portion }, { type: 'outcome', status: 'ok' });
    const full = { state: 'full' as const, level: 1 };
    expect(run(yum, { type: 'fullness', fullness: full })).toMatchObject({ kind: 'yum', sheet: { fullness: full } });
    expect(run(open(), { type: 'fullness', fullness: full })).toEqual(open());
  });

  // spec: add-feeding › Add NEAR sheet screen › success × Back, Close, Esc
  it('Add NEAR is a step; Back returns to the sheet it came from, with the new amount when NEAR arrived', () => {
    const step = run(open(), { type: 'addNear' });
    expect(step).toEqual({ kind: 'addNear', from: sheet() });
    expect(run(step, { type: 'back' })).toEqual(open());
    const richer = sheet({ wallet: { state: 'some', balance: '900000000000000000000000' } });
    expect(run(step, { type: 'back', sheet: richer })).toEqual({ kind: 'open', sheet: richer });
    // only an idle, read sheet has the step; a meal on its way does not
    const sending = run(open(), { type: 'tap', what: portion });
    expect(run(sending, { type: 'addNear' })).toBe(sending);
  });

  // spec: add-feeding › Feed sheet screen › мало NEAR × a failed line
  it('«Add NEAR» of a short portion works on a failed line, and Back returns to the open sheet', () => {
    const short = sheet({ portions: [{ near: '0.01', yocto: '10000000000000000000000', cents: 5, missing: '0.02' }] });
    const failed = run({ kind: 'open', sheet: short }, { type: 'tap', what: { kind: 'snack' } }, { type: 'outcome', status: 'failed' });
    expect(failed.kind).toBe('failed');
    const step = run(failed, { type: 'addNear' });
    expect(step).toEqual({ kind: 'addNear', from: short });
    expect(run(step, { type: 'back' })).toEqual({ kind: 'open', sheet: short });
  });
});
