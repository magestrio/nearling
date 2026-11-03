// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolView } from '../seams/worker-types';

const mocks = vi.hoisted(() => ({
  checkSource: vi.fn(),
  saveSource: vi.fn(),
  auth: { needSession: (): boolean => true, endSession: vi.fn() },
}));
vi.mock('../seams/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('../seams/worker', async () => ({
  ...(await import('../seams/worker-types')),
  workerApi: { checkSource: mocks.checkSource, saveSource: mocks.saveSource },
}));

import { WorkerError } from '../seams/worker';
import { useAdapter, type AdapterHost } from './useAdapter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOOL: ToolView = { name: 'events_on', description: 'Events on a date.', params: [{ name: 'day', type: 'number', required: true }], tickable: true, ticked: true };
let root: Root | null = null;
let host: HTMLElement;
let sheet: ReturnType<typeof useAdapter>;
const refused = vi.fn();
const back = vi.fn();

function Harness(): ReactNode {
  const props: AdapterHost = { tokenOf: async () => 'token', refused, done: vi.fn(), back };
  sheet = useAdapter('9', props);
  return null;
}
const run = (fn: () => void | Promise<unknown>) => act(async () => void (await fn()));

beforeEach(async () => {
  mocks.checkSource.mockReset();
  mocks.saveSource.mockReset();
  mocks.auth.endSession.mockReset();
  refused.mockReset();
  back.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Harness)));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
});

describe('Adapter address check', () => {
  // spec: add-pet-errands › Adapter connect flow › address answered × address edited while checking
  it('does not restore old tools after the address changes during a check', async () => {
    await run(() => sheet.openNew());
    await run(() => sheet.setAddress('https://old.example.com/mcp'));
    let finish!: (result: { tools: ToolView[] }) => void;
    mocks.checkSource.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => { void sheet.check(); });
    await run(() => sheet.setAddress('https://new.example.com/mcp'));
    await act(async () => finish({ tools: [TOOL] }));
    expect(mocks.checkSource).toHaveBeenCalledWith('token', '9', 'https://old.example.com/mcp');
    expect(sheet.tools).toBeNull();
    expect(sheet.ticks).toEqual([]);
    expect(sheet.revealed).toBe(false);
  });

  // spec: add-pet-errands › Adapter sheet screen › success × Check address on an empty field
  it('shows the address note when Check address is pressed on an empty field', async () => {
    await run(() => sheet.openNew());
    await run(() => sheet.check());
    expect(sheet.addressError).toBe(true);
    expect(mocks.checkSource).not.toHaveBeenCalled();
  });

  // spec: add-pet-errands › Adapter sheet screen › success × the session ends and sign-in returns
  it('keeps the open sheet and typed fields when a check gets 401', async () => {
    await run(() => sheet.openNew());
    await run(() => sheet.setLabel('Daybook'));
    await run(() => sheet.setAddress('https://daybook.example.com/mcp'));
    mocks.checkSource.mockRejectedValue(new WorkerError(401, 'session_expired'));
    await run(() => sheet.check());
    expect(mocks.auth.endSession).toHaveBeenCalledWith(true, true);
    expect(sheet.open).toBe(true);
    expect(sheet.label).toBe('Daybook');
    expect(sheet.address).toBe('https://daybook.example.com/mcp');
    expect(sheet.top).toEqual({ kind: 'session' });
    expect(refused).not.toHaveBeenCalled();
  });

  // spec: add-pet-errands › Adapter connect flow › no skill yet
  // spec: add-pet-errands › Adapter connect flow › a fourth source
  it.each(['no_skill', 'full'])('returns to refreshed Skill sheet on 409 %s at Save adapter', async (code) => {
    await run(() => sheet.openNew());
    await run(() => sheet.setLabel('Daybook'));
    await run(() => sheet.setAddress('https://daybook.example.com/mcp'));
    mocks.saveSource.mockRejectedValue(new WorkerError(409, code));
    await run(() => sheet.save());
    expect(sheet.open).toBe(false);
    expect(back).toHaveBeenCalledOnce();
    expect(sheet.top).toBeNull();
  });
});
