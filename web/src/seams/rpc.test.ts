import { describe, expect, it } from 'vitest';
import { fakeNearRpc } from './rpc.fake';

describe('verification RPC seam', () => {
  // spec: add-verification › Verification reads data › сервер не прочитал сеть
  it('keeps regular and archival outcomes separate and exposes failures', async () => {
    (globalThis as { __NEARLING_FAKES__?: unknown }).__NEARLING_FAKES__ = {
      rpc: { outcome: { status: { SuccessValue: '' } }, archiveOutcome: { fail: '403 forbidden' } },
    };
    expect(await fakeNearRpc.transaction('hash', 'signer')).toEqual({ status: { SuccessValue: '' } });
    await expect(fakeNearRpc.transaction('hash', 'signer', true)).rejects.toThrow('403 forbidden');
    (globalThis as { __NEARLING_FAKES__?: unknown }).__NEARLING_FAKES__ = undefined;
  });

  // spec: add-verification › Verification record rule › рост и черты
  // spec: add-verification › Verification record rule › вещи
  it('keeps each record transaction and each chain view distinct in a capture fixture', async () => {
    (globalThis as { __NEARLING_FAKES__?: unknown }).__NEARLING_FAKES__ = {
      rpc: { outcomes: { birth: { event: 'pet_born' }, outfit: { event: 'outfit' } },
        viewResults: { pet_view: { character: 'chain character' }, contract_source_metadata: { version: '0.1.0' } } },
    };
    expect(await fakeNearRpc.transaction('birth', 'server')).toEqual({ event: 'pet_born' });
    expect(await fakeNearRpc.transaction('outfit', 'server')).toEqual({ event: 'outfit' });
    expect(await fakeNearRpc.viewFunction('pets', 'pet_view', { token_id: '9' })).toEqual({ character: 'chain character' });
    expect(await fakeNearRpc.viewFunction('pets', 'contract_source_metadata', {})).toEqual({ version: '0.1.0' });
    (globalThis as { __NEARLING_FAKES__?: unknown }).__NEARLING_FAKES__ = undefined;
  });
});
