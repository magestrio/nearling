import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cardSharedPayload, sendCardShared } from './shareEvent';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../seams/worker', () => ({ workerApi: { cardShared: send } }));

describe('completed card event', () => {
  beforeEach(() => { send.mockReset(); });

  // spec: add-showcase › Pet card sharing event data › image saved
  // spec: add-showcase › Pet card sharing event data › image shared
  it('sends only the allowlisted counters and opaque ids', async () => {
    const payload = cardSharedPayload('thought', 'save');
    expect(Object.keys(payload).sort()).toEqual(['at', 'delivery', 'kind', 'petId', 'playerId', 'tabId']);
    expect(payload).toMatchObject({ at: expect.any(Number), kind: 'thought', delivery: 'save', tabId: expect.any(String), playerId: expect.any(String), petId: expect.any(String) });
    expect(Object.values(payload).join(' ')).not.toMatch(/Pixel|\/pet\/|Start with the chart/);
    send.mockResolvedValue(undefined);
    await sendCardShared('identity-token', 'growth', 'share');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toMatchObject({ kind: 'growth', delivery: 'share' });
  });
});
