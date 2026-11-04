import { describe, expect, it } from 'vitest';
import type { VerificationThought } from '../seams/worker-types';
import { hardwareHref } from './hardware';

const thought = { model: 'Qwen/Qwen3.8-27B', calls: [{ n: 0, completion_id: 'cmpl-123', req_sha256: 'a'.repeat(64),
  res_sha256: 'b'.repeat(64), signature: '0x' + 'c'.repeat(130), sig_kind: 'provider_tee', signer: '0x' + 'd'.repeat(40),
  tokens_in: 1, tokens_out: 2, tokens_reasoning: 0, cut: false }] } as VerificationThought;

describe('NEAR AI hardware link', () => {
  // spec: add-verification › Verification screen › signed-out
  // spec: add-verification › Verification flow › аппаратная проверка
  it('passes only public, signed receipt fields to the model page', () => {
    const href = hardwareHref(thought)!;
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe('https://cloud.near.ai/verify');
    expect(url.searchParams.get('model')).toBe(thought.model);
    const encoded = url.hash.slice('#receipt='.length).replaceAll('-', '+').replaceAll('_', '/');
    const receipt = JSON.parse(atob(encoded)) as Record<string, unknown>;
    expect(receipt).toEqual({ completionId: 'cmpl-123', model: thought.model, signatureKind: 'provider_tee',
      signingAlgo: 'ecdsa', signingAddress: thought.calls[0]!.signer,
      signedText: `${thought.model}:${'a'.repeat(64)}:${'b'.repeat(64)}`, signature: thought.calls[0]!.signature });
    expect(JSON.stringify(receipt)).not.toContain('requestBase64');
    expect(JSON.stringify(receipt)).not.toContain('replyBase64');
  });

  // spec: add-verification › Verification flow › поток
  it('withholds the hardware link from a gateway signature and a missing completion ID', () => {
    expect(hardwareHref({ ...thought, calls: [{ ...thought.calls[0]!, sig_kind: 'gateway' }] })).toBeNull();
    expect(hardwareHref({ ...thought, calls: [{ ...thought.calls[0]!, completion_id: null }] })).toBeNull();
  });

  // spec: add-verification › Verification flow › два вызова
  it('links each call to its own completion and signed hashes', () => {
    const second = { ...thought.calls[0]!, n: 1, completion_id: 'cmpl-second', res_sha256: 'e'.repeat(64) };
    const url = new URL(hardwareHref({ ...thought, calls: [thought.calls[0]!, second] }, 1)!);
    const encoded = url.hash.slice('#receipt='.length).replaceAll('-', '+').replaceAll('_', '/');
    const receipt = JSON.parse(atob(encoded)) as { completionId: string; signedText: string };
    expect(receipt.completionId).toBe('cmpl-second');
    expect(receipt.signedText).toBe(`${thought.model}:${'a'.repeat(64)}:${'e'.repeat(64)}`);
  });

  // spec: add-verification › Verification flow › не сошлось
  it('uses checked model and signature fields when the pointer changed', () => {
    const chain = { token_id: '9', debit_id: 8, model: 'Onchain/permanent', price: '1', worker: null,
      calls: [{ ...thought.calls[0]!, sig_kind: 'provider_tee' as const, cut: false,
        signature: '0x' + 'e'.repeat(130) }] };
    const url = new URL(hardwareHref(thought, 0, chain)!);
    const encoded = url.hash.slice('#receipt='.length).replaceAll('-', '+').replaceAll('_', '/');
    const receipt = JSON.parse(atob(encoded)) as { model: string; signedText: string; signature: string };
    expect(url.searchParams.get('model')).toBe('Onchain/permanent');
    expect(receipt.signedText).toBe(`Onchain/permanent:${'a'.repeat(64)}:${'b'.repeat(64)}`);
    expect(receipt.signature).toBe(chain.calls[0]!.signature);
  });
});
