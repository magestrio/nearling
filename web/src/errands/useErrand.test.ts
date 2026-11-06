// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrandQuote } from '../seams/worker-types';

const mocks = vi.hoisted(() => ({
  errand: vi.fn(),
  sendErrand: vi.fn(),
  prepareSharedErrand: vi.fn(),
  track: vi.fn(),
  auth: { needSession: (): boolean => true, endSession: vi.fn() },
}));
vi.mock('../seams/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('../track', () => ({ track: mocks.track }));
vi.mock('../seams/worker', async () => ({
  ...(await import('../seams/worker-types')),
  workerApi: { errand: mocks.errand, sendErrand: mocks.sendErrand, prepareSharedErrand: mocks.prepareSharedErrand },
}));

import { announceFed } from '../feeding/feedRequest';
import { WorkerError } from '../seams/worker';
import { useErrand, type ErrandHost } from './useErrand';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const QUOTE: ErrandQuote = {
  form: 'read',
  paused: false,
  read: { typical: { yocto: '325000000000000000000', cents: 0.15 }, base: '200000000000000000000', perToken: '42000000000000000' },
  search: { upTo: { yocto: '4330000000000000000000', cents: 2 }, full: true, short: false, searches: 3, allowance: 3 },
  block: null,
  labels: [],
  sharedNeeded: { yocto: '4330000000000000000000', cents: 2 },
};
const FOOD = { reason: 'food' as const, need: { yocto: '2000000000000000000000', cents: 0.93 } };

let root: Root | null = null;
let host: HTMLElement;
let sheet: ReturnType<typeof useErrand>;
let hostProps: ErrandHost;
const sent = vi.fn();
const away = vi.fn();
const refused = vi.fn();
const failed = vi.fn();

function Harness({ watch }: { watch: string }): ReactNode {
  hostProps = { tokenId: '9', tokenOf: async () => 'token', refused, failed, sent, away, watch };
  sheet = useErrand(hostProps);
  return null;
}
async function mount(watch = 'a') {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Harness, { watch })));
}
const rerender = (watch: string) => act(async () => root!.render(createElement(Harness, { watch })));
const run = (fn: () => void | Promise<void>) => act(async () => void (await fn()));

beforeEach(() => {
  for (const m of [mocks.errand, mocks.sendErrand, mocks.prepareSharedErrand, mocks.track, sent, away, refused, failed]) m.mockReset();
  mocks.auth.needSession = () => true;
  mocks.errand.mockImplementation(async (_t: unknown, _id: string, form: string) => ({ ...QUOTE, form }));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  window.history.replaceState(null, '', '/');
});

describe('Errand sheet', () => {
  // spec: add-pet-errands › Errand flow › can't pay
  it('keeps a fresh asleep opening share-only but shows the food block when an errand is reopened', async () => {
    mocks.errand.mockImplementation(async (_t: unknown, _id: string, form: string) => ({ ...QUOTE, form, block: FOOD }));
    await mount();
    await run(() => sheet.openSheet(undefined, true));
    expect(sheet.shareOnly).toBe(true);
    expect(sheet.block).toEqual(FOOD);
    await run(() => sheet.close());
    await run(() => sheet.openSheet({ form: 'find', job: 'When do the Leonids peak?' }, true));
    expect(sheet.shareOnly).toBe(false);
    expect(sheet.block).toEqual(FOOD);
    expect(sheet.job).toBe('When do the Leonids peak?');
  });
  // spec: add-pet-errands › Friend-funded errand flow › owner shares a job
  // spec: add-pet-errands › Friend-funded errand flow › another shared job is waiting
  it('prepares one search link without sending an errand and keeps the draft on an active-link refusal', async () => {
    await mount();
    await run(() => sheet.openSheet());
    await run(() => sheet.pick('find'));
    await run(() => sheet.setJob('A question'));
    const code = 'c'.repeat(64);
    mocks.prepareSharedErrand.mockRejectedValueOnce(new WorkerError(409, 'shared_job_active', { url: `/pet/9/errand/${code}` }));
    await run(() => sheet.prepareShared());
    expect(sheet.job).toBe('A question');
    expect(sheet.sharedLink).toBe(`/pet/9/errand/${code}`);
    mocks.prepareSharedErrand.mockResolvedValueOnce({ url: `/pet/9/errand/${code}`, code, needed: QUOTE.sharedNeeded, form: 'find', job: 'A question' });
    await run(() => sheet.prepareShared());
    expect(window.location.pathname).toBe(`/pet/9/errand/${code}`);
    expect(mocks.sendErrand).not.toHaveBeenCalled();
  });
  // spec: add-pet-errands › Errand sheet screen › success
  it('opens on «Read this» with the typical read, «Send» off while the field is empty, and moves the price with the text', async () => {
    await mount();
    await run(() => sheet.openSheet());
    expect(sheet.open).toBe(true);
    expect(sheet.form).toBe('read');
    expect(sheet.price).toBe('≈ 0.15¢');
    expect(sheet.canSend).toBe(false);
    await run(() => sheet.setJob('x'.repeat(8_000)));
    expect(sheet.canSend).toBe(true);
    expect(sheet.price).not.toBe('≈ 0.15¢');
    await run(() => sheet.setJob('https://example.com/dreams'));
    expect(sheet.price).toBe('≈ 0.15¢');
  });

  // spec: add-pet-errands › Errand sheet screen › a search form × switch the form
  it('keeps the text of each form while the sheet is open: switching back brings it', async () => {
    await mount();
    await run(() => sheet.openSheet());
    await run(() => sheet.setJob('https://example.com/dreams'));
    await run(() => sheet.pick('find'));
    expect(sheet.job).toBe('');
    expect(sheet.price).toBe('up to ≈ 2¢');
    await run(() => sheet.setJob('When do the Leonids peak?'));
    await run(() => sheet.pick('read'));
    expect(sheet.job).toBe('https://example.com/dreams');
    await run(() => sheet.close());
    await run(() => sheet.openSheet());
    expect(sheet.job).toBe('https://example.com/dreams');
    await run(() => sheet.pick('find'));
    expect(sheet.job).toBe('When do the Leonids peak?');
  });

  // spec: add-pet-errands › Errand sheet screen › error
  it('says the quote did not come, keeps the text, and «Try again» reads it again', async () => {
    mocks.errand.mockRejectedValueOnce(new WorkerError(0, 'unreachable'));
    await mount();
    await run(() => sheet.openSheet({ form: 'find', job: 'When do the Leonids peak?' }));
    expect(sheet.error).toBe(true);
    expect(sheet.job).toBe('When do the Leonids peak?');
    expect(sheet.price).toBeNull();
    expect(sheet.canSend).toBe(false);
    await run(() => sheet.refresh());
    expect(sheet.error).toBe(false);
    expect(sheet.canSend).toBe(true);
  });

  // spec: add-pet-errands › Errand sheet screen › error × a later quote refresh fails
  it('disables Send and keeps the draft when a refresh fails after a usable quote', async () => {
    await mount();
    await run(() => sheet.openSheet({ form: 'find', job: 'When do the Leonids peak?' }));
    expect(sheet.canSend).toBe(true);
    mocks.errand.mockRejectedValueOnce(new WorkerError(0, 'unreachable'));
    await run(() => sheet.refresh());
    expect(sheet.error).toBe(true);
    expect(sheet.quote).toBeNull();
    expect(sheet.canSend).toBe(false);
    await run(() => sheet.send());
    expect(mocks.sendErrand).not.toHaveBeenCalled();
    expect(sheet.job).toBe('When do the Leonids peak?');
  });

  // spec: add-pet-errands › Errand flow › several blocks at once
  it('shows only the first block the server names, and the text stays', async () => {
    // the server picks the first of services paused, food, energy, the cap; the sheet shows exactly that one
    mocks.errand.mockResolvedValue({ ...QUOTE, block: { reason: 'paused' } });
    await mount();
    await run(() => sheet.openSheet({ form: 'find', job: 'When do the Leonids peak?' }));
    expect(sheet.block).toEqual({ reason: 'paused' });
    expect(sheet.job).toBe('When do the Leonids peak?');
    expect(sheet.canSend).toBe(false);
  });

  // spec: add-pet-errands › Errand events data › errand blocked
  it('sends errand_blocked once per opening and form, with the reason, and nothing for a pause', async () => {
    mocks.errand.mockImplementation(async (_t: unknown, _id: string, form: string) => ({ ...QUOTE, form, block: form === 'read' ? { reason: 'energy', until: '2026-11-04T00:00:00.000Z' } : FOOD }));
    await mount();
    await run(() => sheet.openSheet());
    await run(() => sheet.refresh());
    expect(mocks.track.mock.calls).toEqual([['errand_blocked', { form: 'read', reason: 'energy' }]]);
    await run(() => sheet.pick('find'));
    await run(() => sheet.pick('read'));
    await run(() => sheet.pick('find'));
    expect(mocks.track.mock.calls).toEqual([
      ['errand_blocked', { form: 'read', reason: 'energy' }],
      ['errand_blocked', { form: 'find', reason: 'food' }],
    ]);
    // a new opening counts again
    await run(() => sheet.close());
    await run(() => sheet.openSheet());
    expect(mocks.track).toHaveBeenCalledTimes(3);
    // a pause logs nothing here
    mocks.track.mockReset();
    mocks.errand.mockResolvedValue({ ...QUOTE, block: { reason: 'paused' } });
    await run(() => sheet.close());
    await run(() => sheet.openSheet());
    expect(mocks.track).not.toHaveBeenCalled();
  });

  // spec: add-pet-errands › Errand sheet screen › success × the tab hidden and back
  it('reads the quote again when the tab comes back, and not while it is hidden', async () => {
    await mount();
    await run(() => sheet.openSheet());
    expect(mocks.errand).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    await run(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(mocks.errand).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    mocks.errand.mockResolvedValue({ ...QUOTE, read: { ...QUOTE.read, typical: { yocto: '400000000000000000000', cents: 0.18 } } });
    await run(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(mocks.errand).toHaveBeenCalledTimes(2);
    expect(sheet.price).toBe('≈ 0.18¢');
  });

  // spec: add-pet-errands › Errand flow › out of energy × 00:00 UTC
  it('reads the quote again when the pet\'s condition moves: the energy of the new day lifts the block, «Send» comes back', async () => {
    mocks.errand.mockResolvedValue({ ...QUOTE, block: { reason: 'energy', until: '2026-11-04T00:00:00.000Z' } });
    await mount('energy:0');
    await run(() => sheet.openSheet({ form: 'find', job: 'When do the Leonids peak?' }));
    expect(sheet.block?.reason).toBe('energy');
    expect(sheet.canSend).toBe(false);
    mocks.errand.mockResolvedValue({ ...QUOTE, block: null });
    await rerender('energy:10');
    expect(sheet.block).toBeNull();
    expect(sheet.canSend).toBe(true);
    expect(sheet.job).toBe('When do the Leonids peak?');
  });

  // spec: add-pet-errands › Errand flow › can't pay × Feed sheet and back
  it('brings «Send» back when a meal landed, with the text kept', async () => {
    mocks.errand.mockResolvedValue({ ...QUOTE, block: FOOD });
    await mount();
    await run(() => sheet.openSheet({ form: 'find', job: 'When do the Leonids peak?' }));
    expect(sheet.block?.reason).toBe('food');
    mocks.errand.mockResolvedValue({ ...QUOTE, block: null });
    await run(() => announceFed({ kind: 'fed', tokenId: '9', source: 'near' }));
    expect(sheet.block).toBeNull();
    expect(sheet.canSend).toBe(true);
    expect(sheet.job).toBe('When do the Leonids peak?');
    // another pet's meal is not this pet's
    mocks.errand.mockClear();
    await run(() => announceFed({ kind: 'fed', tokenId: '2', source: 'near' }));
    expect(mocks.errand).not.toHaveBeenCalled();
  });

  // spec: add-pet-errands › Errand flow › sent
  it('sends the form and the job, closes the sheet and tells the page; the draft stays for the next opening', async () => {
    mocks.sendErrand.mockResolvedValue({ job: 'job-1' });
    await mount();
    await run(() => sheet.openSheet({ form: 'check', job: 'Octopuses have three hearts.' }));
    await run(() => sheet.send());
    expect(mocks.sendErrand).toHaveBeenCalledWith('token', '9', { form: 'check', job: 'Octopuses have three hearts.' });
    expect(sheet.open).toBe(false);
    expect(sent).toHaveBeenCalledWith({ form: 'check', job: 'Octopuses have three hearts.', id: 'job-1' });
  });

  // spec: add-pet-errands › Errand sheet screen › success × the session ends and sign-in returns
  it('meets the ended session with a line and sends nothing; the text stays', async () => {
    mocks.auth.needSession = () => false;
    await mount();
    await run(() => sheet.openSheet({ form: 'read', job: 'https://example.com/dreams' }));
    await run(() => sheet.send());
    expect(mocks.sendErrand).not.toHaveBeenCalled();
    expect(sheet.session).toBe(true);
    expect(sheet.open).toBe(true);
    expect(sheet.job).toBe('https://example.com/dreams');
  });

  // spec: add-pet-errands › Errand sheet screen › success × the session ends and sign-in returns
  it('keeps the sheet and its quote when a read meets an ended session, and meets a 401 at «Send» with the line and the text kept', async () => {
    await mount();
    await run(() => sheet.openSheet({ form: 'find', job: 'When do the Leonids peak?' }));
    mocks.errand.mockRejectedValue(new WorkerError(401, 'signed_out'));
    await run(() => sheet.refresh());
    expect(sheet.open).toBe(true);
    expect(sheet.quote).not.toBeNull();
    expect(sheet.error).toBe(false);
    expect(refused).toHaveBeenCalledTimes(1);
    mocks.sendErrand.mockRejectedValue(new WorkerError(401, 'signed_out'));
    await run(() => sheet.send());
    expect(sheet.open).toBe(true);
    expect(sheet.session).toBe(true);
    expect(sheet.job).toBe('When do the Leonids peak?');
    expect(mocks.auth.endSession).toHaveBeenCalledWith(true, true);
  });

  // spec: add-pet-errands › Errand flow › blocked after Send
  it('puts the block that holds now in «Send»\'s place when the server refuses the send, and keeps the text', async () => {
    mocks.sendErrand.mockRejectedValue(new WorkerError(409, 'blocked', { code: 'blocked', block: { reason: 'cap', until: '2026-11-04T00:00:00.000Z' } }));
    await mount();
    await run(() => sheet.openSheet({ form: 'find', job: 'When do the Leonids peak?' }));
    expect(sheet.block).toBeNull();
    await run(() => sheet.send());
    expect(sheet.open).toBe(true);
    expect(sheet.block?.reason).toBe('cap');
    expect(sheet.job).toBe('When do the Leonids peak?');
    expect(sent).not.toHaveBeenCalled();
  });

  // spec: add-pet-errands › Errand flow › sent × another tab sent an errand
  it('closes the sheet when another tab\'s errand is already away', async () => {
    mocks.sendErrand.mockRejectedValue(new WorkerError(409, 'away'));
    await mount();
    await run(() => sheet.openSheet({ form: 'find', job: 'When do the Leonids peak?' }));
    await run(() => sheet.send());
    expect(sheet.open).toBe(false);
    expect(away).toHaveBeenCalledTimes(1);
  });

  // spec: add-pet-errands › Errand sheet screen › success × the pet given away
  it('closes the sheet and hands a refusal of the owner\'s right to the page', async () => {
    mocks.errand.mockRejectedValue(new WorkerError(403, 'not_owner'));
    await mount();
    await run(() => sheet.openSheet());
    expect(sheet.open).toBe(false);
    expect(refused).toHaveBeenCalledTimes(1);
  });
});
