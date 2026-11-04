import type { VerificationThought } from '../seams/worker-types';
import { signedText, type ChainReceipt } from './check';

/** NEAR AI's public page receives only the signed receipt fields, never a request or reply. */
export function hardwareHref(thought: VerificationThought, n = 0, checked?: ChainReceipt | null): string | null {
  const call = checked?.calls[n] ?? thought.calls[n];
  const model = checked?.model ?? thought.model;
  const completionId = thought.calls[n]?.completion_id;
  if (!call || call.sig_kind !== 'provider_tee' || !completionId) return null;
  const receipt = { completionId, model, signatureKind: call.sig_kind,
    signingAlgo: 'ecdsa', signingAddress: call.signer,
    signedText: signedText({ req_sha256: call.req_sha256, res_sha256: call.res_sha256, sig_kind: 'provider_tee' }, model),
    signature: call.signature };
  const bytes = new TextEncoder().encode(JSON.stringify(receipt));
  const base64 = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return `https://cloud.near.ai/verify?model=${encodeURIComponent(model)}#receipt=${base64}`;
}
