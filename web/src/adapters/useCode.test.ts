// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeRead, ToolView } from '../seams/worker-types';

const mocks = vi.hoisted(() => ({
  code: vi.fn(),
  testCode: vi.fn(),
  saveCode: vi.fn(),
  removeCode: vi.fn(),
  auth: { needSession: (): boolean => true, endSession: vi.fn() },
}));
vi.mock('../seams/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('../seams/worker', async () => ({
  ...(await import('../seams/worker-types')),
  workerApi: { code: mocks.code, testCode: mocks.testCode, saveCode: mocks.saveCode, removeCode: mocks.removeCode },
}));

import { WorkerError } from '../seams/worker';
import { useCode, type CodeHost } from './useCode';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAVED = 'export async function openerFor(month, day) { return { month, day }; }';
const EDITED = `${SAVED}\n// edited`;
const OPENER: ToolView = { name: 'openerFor', description: 'An opening line for a date.', params: [{ name: 'month', type: 'number', required: true }], tickable: true, ticked: true };
const RAW: ToolView = { name: 'rawFeed', description: 'The feed as it is.', params: [{ name: 'query', type: 'text', required: true }], tickable: false, reason: 'free_text' };
const WRITTEN: CodeRead = { code: SAVED, functions: [OPENER, RAW], testsLeft: 20 };

let root: Root | null = null;
let host: HTMLElement;
let sheet: ReturnType<typeof useCode>;
const done = vi.fn();
const refused = vi.fn();

function Harness(): ReactNode {
  const props: CodeHost = { tokenOf: async () => 'token', refused, done };
  sheet = useCode('9', props);
  return null;
}
async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Harness)));
}
const run = (fn: () => void | Promise<unknown>) => act(async () => void (await fn()));

beforeEach(() => {
  for (const m of [mocks.code, mocks.testCode, mocks.saveCode, mocks.removeCode, done, refused]) m.mockReset();
  mocks.auth.endSession.mockReset();
  mocks.auth.needSession = () => true;
  mocks.code.mockResolvedValue(WRITTEN);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
});

describe('Skill code sheet', () => {
  // spec: add-pet-errands › Skill code sheet screen › code already written × an edit after a passing run
  it('code already written × an edit after a passing run: the saved code is read with its functions; an edit turns «Save code» off until a test of the edited code passes', async () => {
    await mount();
    await run(() => sheet.openSheet());
    expect(sheet.code).toBe(SAVED);
    expect(sheet.written).toBe(true);
    expect(sheet.functions.map((f) => f.name)).toEqual(['openerFor', 'rawFeed']);
    expect(sheet.ticks).toEqual(['openerFor']);
    // the saved code, unchanged, still waits for one test of the day
    expect(sheet.canSave).toBe(false);
    mocks.testCode.mockResolvedValue({ outcome: 'ok', output: '"hi"', functions: [{ ...OPENER, ticked: undefined }, RAW] });
    await run(() => sheet.setFn('openerFor'));
    await run(() => sheet.setValues('11, 3'));
    await run(() => sheet.test());
    expect(sheet.canSave).toBe(true);
    // an edit: off
    await run(() => sheet.setCode(EDITED));
    expect(sheet.canSave).toBe(false);
    // a run that passes on the edited code: on
    await run(() => sheet.test());
    expect(mocks.testCode).toHaveBeenCalledWith('token', '9', { code: EDITED, fn: 'openerFor', values: '11, 3' });
    expect(sheet.outcome).toEqual({ kind: 'ok', output: '"hi"' });
    expect(sheet.canSave).toBe(true);
    // all but the function that takes text are ticked after a pass
    expect(sheet.ticks).toEqual(['openerFor']);
    // a second edit: off again
    await run(() => sheet.setCode(`${EDITED}\n// again`));
    expect(sheet.canSave).toBe(false);
    // putting the passed code back: on
    await run(() => sheet.setCode(EDITED));
    expect(sheet.canSave).toBe(true);
  });

  // spec: add-pet-errands › Skill code sheet screen › code already written × edit while Test run is pending
  it('keeps Save code off when the field changes during a passing test of the earlier code', async () => {
    await mount();
    await run(() => sheet.openSheet());
    await run(() => sheet.setFn('openerFor'));
    let finish!: (result: { outcome: 'ok'; output: string; functions: ToolView[] }) => void;
    mocks.testCode.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { void sheet.test(); });
    await run(() => sheet.setCode(EDITED));
    await act(async () => finish({ outcome: 'ok', output: '"hi"', functions: [OPENER] }));
    expect(mocks.testCode).toHaveBeenCalledWith('token', '9', { code: SAVED, fn: 'openerFor', values: '' });
    expect(sheet.canSave).toBe(false);
    await run(() => sheet.setCode(SAVED));
    expect(sheet.canSave).toBe(true);
  });

  // spec: add-pet-errands › Skill code sheet screen › success
  // spec: add-pet-errands › Skill code sheet screen › nothing to test
  it('success: a skill with no code opens a blank field, «Save code» off, and nothing to test until a function is named', async () => {
    mocks.code.mockResolvedValue({ code: null, functions: [], testsLeft: 20 });
    await mount();
    await run(() => sheet.openSheet());
    expect(sheet.code).toBe('');
    expect(sheet.written).toBe(false);
    expect(sheet.canSave).toBe(false);
    expect(sheet.canTest).toBe(false);
    await run(() => sheet.setCode('export const functions = {};'));
    expect(sheet.canTest).toBe(false);
    await run(() => sheet.setFn('openerFor'));
    expect(sheet.canTest).toBe(true);
    // typed, not tested: still off
    expect(sheet.canSave).toBe(false);
  });

  // spec: add-pet-errands › Skill code flow › cap reached
  it('cap reached: 429 tests_used_up is the cap line and no more runs; an opening with none left says it too', async () => {
    await mount();
    await run(() => sheet.openSheet());
    await run(() => sheet.setCode(EDITED));
    await run(() => sheet.setFn('openerFor'));
    mocks.testCode.mockRejectedValue(new WorkerError(429, 'tests_used_up'));
    await run(() => sheet.test());
    expect(sheet.outcome).toEqual({ kind: 'cap' });
    expect(sheet.testsLeft).toBe(0);
    expect(sheet.top).toBeNull();
    await run(() => sheet.close());
    mocks.code.mockResolvedValue({ ...WRITTEN, testsLeft: 0 });
    await run(() => sheet.openSheet());
    expect(sheet.outcome).toEqual({ kind: 'cap' });
  });

  // spec: add-pet-errands › Skill code flow › cap reached
  it('shows the cap after the twentieth run while keeping that run output', async () => {
    mocks.code.mockResolvedValue({ ...WRITTEN, testsLeft: 1 });
    await mount();
    await run(() => sheet.openSheet());
    await run(() => sheet.setFn('openerFor'));
    mocks.testCode.mockResolvedValue({ outcome: 'ok', output: '"last run"', functions: [OPENER] });
    await run(() => sheet.test());
    expect(sheet.testsLeft).toBe(0);
    expect(sheet.outcome).toEqual({ kind: 'ok', output: '"last run"' });
    expect(sheet.canTest).toBe(false);
  });

  // spec: add-pet-errands › Skill code flow › test passed
  it('keeps an unticked saved function unticked after a pass and ticks a new usable function', async () => {
    const second = { ...OPENER, name: 'newFunction', ticked: undefined };
    await mount();
    await run(() => sheet.openSheet());
    await run(() => sheet.setFn('openerFor'));
    await run(() => sheet.tick('openerFor', false));
    mocks.testCode.mockResolvedValue({ outcome: 'ok', output: '"hi"', functions: [{ ...OPENER, ticked: true }, second, RAW] });
    await run(() => sheet.test());
    expect(sheet.ticks).toEqual(['newFunction']);
  });

  // spec: add-pet-errands › Skill code sheet screen › success
  it('keeps code within the 32 KB UTF-8 limit', async () => {
    await mount();
    await run(() => sheet.openSheet());
    await run(() => sheet.setFn('openerFor'));
    await run(() => sheet.setCode('é'.repeat(16_385)));
    expect(sheet.tooLong).toBe(true);
    expect(sheet.canTest).toBe(false);
    expect(sheet.canSave).toBe(false);
    await run(() => sheet.test());
    expect(mocks.testCode).not.toHaveBeenCalled();
    await run(() => sheet.setCode('é'.repeat(16_384)));
    expect(sheet.tooLong).toBe(false);
    expect(sheet.canTest).toBe(true);
  });

  // spec: add-pet-errands › Skill code sheet screen › success × the session ends and sign-in returns
  it('keeps the open sheet and typed code when a request gets 401', async () => {
    await mount();
    await run(() => sheet.openSheet());
    await run(() => sheet.setCode(EDITED));
    await run(() => sheet.setFn('openerFor'));
    mocks.testCode.mockRejectedValue(new WorkerError(401, 'session_expired'));
    await run(() => sheet.test());
    expect(mocks.auth.endSession).toHaveBeenCalledWith(true, true);
    expect(sheet.open).toBe(true);
    expect(sheet.code).toBe(EDITED);
    expect(sheet.top).toEqual({ kind: 'session' });
    expect(refused).not.toHaveBeenCalled();
  });

  // spec: add-pet-errands › Skill code flow › game's code cap reached
  it("game's code cap reached: 429 game_capped is its line; the pet's runs are not spent and «Save code» stays off", async () => {
    await mount();
    await run(() => sheet.openSheet());
    await run(() => sheet.setCode(EDITED));
    await run(() => sheet.setFn('openerFor'));
    mocks.testCode.mockRejectedValue(new WorkerError(429, 'game_capped'));
    await run(() => sheet.test());
    expect(sheet.outcome).toEqual({ kind: 'game_cap' });
    expect(sheet.testsLeft).toBe(20);
    expect(sheet.canSave).toBe(false);
  });

  // spec: add-pet-errands › Skill code flow › function not declared
  it('function not declared: the line names the function, it uses one run of the day and «Save code» stays off', async () => {
    await mount();
    await run(() => sheet.openSheet());
    await run(() => sheet.setCode(EDITED));
    await run(() => sheet.setFn('nope'));
    mocks.testCode.mockResolvedValue({ outcome: 'undeclared', fn: 'nope' });
    await run(() => sheet.test());
    expect(sheet.outcome).toEqual({ kind: 'undeclared', fn: 'nope' });
    expect(sheet.testsLeft).toBe(19);
    expect(sheet.canSave).toBe(false);
  });

  // spec: add-pet-errands › Skill code sheet screen › error
  it('error: a request that did not come back is the line with «Try again», which repeats it; the field keeps its text', async () => {
    await mount();
    await run(() => sheet.openSheet());
    await run(() => sheet.setCode(EDITED));
    await run(() => sheet.setFn('openerFor'));
    mocks.testCode.mockRejectedValueOnce(new WorkerError(0, 'unreachable'));
    await run(() => sheet.test());
    expect(sheet.top).toEqual({ kind: 'failed', again: 'test' });
    expect(sheet.code).toBe(EDITED);
    mocks.testCode.mockResolvedValue({ outcome: 'limit' });
    await run(() => sheet.again());
    expect(mocks.testCode).toHaveBeenCalledTimes(2);
    expect(sheet.outcome).toEqual({ kind: 'limit' });
    expect(sheet.top).toBeNull();
  });

  // spec: add-pet-errands › Skill code flow › code saved
  it('code saved: «Save code» sends the code and the ticks and hands the sheet back with `saved`', async () => {
    await mount();
    await run(() => sheet.openSheet());
    mocks.testCode.mockResolvedValue({ outcome: 'ok', output: '"hi"', functions: [{ ...OPENER, ticked: undefined }, RAW] });
    await run(() => sheet.setFn('openerFor'));
    await run(() => sheet.test());
    await run(() => sheet.tick('openerFor', false));
    mocks.saveCode.mockResolvedValue({ code: { functions: [OPENER, RAW] } });
    await run(() => sheet.save());
    expect(mocks.saveCode).toHaveBeenCalledWith('token', '9', { code: SAVED, ticks: [] });
    expect(sheet.open).toBe(false);
    expect(done).toHaveBeenCalledWith({ kind: 'saved' });
  });

  // spec: add-pet-errands › Skill code flow › test from an earlier day
  it('test from an earlier day: 409 not_tested drops the pass and says so; the field and the ticks stay; a new passing run clears the line', async () => {
    await mount();
    await run(() => sheet.openSheet());
    mocks.testCode.mockResolvedValue({ outcome: 'ok', output: '"hi"', functions: [{ ...OPENER, ticked: undefined }, RAW] });
    await run(() => sheet.setFn('openerFor'));
    await run(() => sheet.test());
    await run(() => sheet.tick('openerFor', false));
    expect(sheet.canSave).toBe(true);
    mocks.saveCode.mockRejectedValue(new WorkerError(409, 'not_tested'));
    await run(() => sheet.save());
    expect(sheet.open).toBe(true);
    expect(done).not.toHaveBeenCalled();
    expect(sheet.stale).toBe(true);
    expect(sheet.top).toBeNull();
    expect(sheet.canSave).toBe(false);
    expect(sheet.code).toBe(SAVED);
    expect(sheet.ticks).toEqual([]);
    await run(() => sheet.test());
    expect(sheet.stale).toBe(false);
    expect(sheet.canSave).toBe(true);
  });

  // spec: add-pet-errands › Skill code flow › code removed
  it('code removed: «Remove code» hands the sheet back with `removed`', async () => {
    await mount();
    await run(() => sheet.openSheet());
    mocks.removeCode.mockResolvedValue({ removed: true });
    await run(() => sheet.remove());
    expect(sheet.open).toBe(false);
    expect(done).toHaveBeenCalledWith({ kind: 'removed' });
  });

  // spec: add-pet-errands › Skill code sheet screen › success × the session ends and sign-in returns
  it('success × the session ends and sign-in returns: with the session ended a tap sends nothing and meets the line; the sheet opens again with the code as typed, unsaved and untested', async () => {
    await mount();
    await run(() => sheet.openSheet());
    await run(() => sheet.setCode(EDITED));
    await run(() => sheet.setFn('openerFor'));
    mocks.auth.needSession = () => false;
    await run(() => sheet.test());
    expect(mocks.testCode).not.toHaveBeenCalled();
    expect(sheet.top).toEqual({ kind: 'session' });
    await run(() => sheet.close());
    mocks.auth.needSession = () => true;
    await run(() => sheet.openSheet({ code: EDITED, fn: 'openerFor', values: '11, 3' }));
    expect(sheet.code).toBe(EDITED);
    expect(sheet.fn).toBe('openerFor');
    expect(sheet.values).toBe('11, 3');
    expect(sheet.outcome).toBeNull();
    expect(sheet.canSave).toBe(false);
  });
});
