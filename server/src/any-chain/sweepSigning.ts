import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { baseDecode, baseEncode } from 'near-api-js';
import { QuoteUnavailable, type Origin } from './quote';
import { baseSignedTransaction, baseSweepPayload, baseUnsignedTransaction,
  bytesHex, type BaseTransactionFields } from './sweepPayload';
import { base64Transaction, solanaSignature } from './sweepRpc';

function fromHex(value: string): Uint8Array {
  if (!/^(?:0x)?(?:[0-9a-fA-F]{2})+$/.test(value)) throw new QuoteUnavailable('source_unavailable');
  const raw = value.replace(/^0x/, '');
  return Uint8Array.from(raw.match(/../g)!, (part) => parseInt(part, 16));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

function padded32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32 || bytes.length === 0) throw new QuoteUnavailable('source_unavailable');
  const result = new Uint8Array(32);
  result.set(bytes, 32 - bytes.length);
  return result;
}

export interface SourceSigned { encoded: string; hash: string }

/** No source transaction is broadcast unless the MPC signature recovers the pinned pet address. */
export function signedPetSource(chain: Origin, payloadHex: string, mpcJson: string,
  petAddress: string, destination: string, amount: bigint, sourceMetaJson: string): SourceSigned {
  try {
    const payload = fromHex(payloadHex);
    const mpc = JSON.parse(mpcJson) as Record<string, unknown>;
    if (chain === 'solana') {
      const raw = mpc.signature;
      if (mpc.scheme !== 'Ed25519' || !Array.isArray(raw) || raw.length !== 64 ||
        !raw.every((value) => Number.isInteger(value) && value >= 0 && value <= 255))
        throw new Error('bad_signature');
      const signature = Uint8Array.from(raw as number[]);
      if (!ed25519.verify(signature, payload, baseDecode(petAddress))) throw new Error('wrong_signer');
      return { encoded: base64Transaction(payload, signature), hash: solanaSignature(signature) };
    }
    if (mpc.scheme !== 'Secp256k1' || typeof mpc.recovery_id !== 'number' ||
      (mpc.recovery_id !== 0 && mpc.recovery_id !== 1)) throw new Error('bad_signature');
    const bigR = (mpc.big_r as { affine_point?: unknown } | undefined)?.affine_point;
    const scalar = (mpc.s as { scalar?: unknown } | undefined)?.scalar;
    if (typeof bigR !== 'string' || typeof scalar !== 'string') throw new Error('bad_signature');
    const point = secp256k1.Point.fromBytes(fromHex(bigR)).toBytes(false);
    const r = point.slice(1, 33);
    const s = padded32(fromHex(scalar));
    const digest = keccak_256(payload);
    const recovered = secp256k1.recoverPublicKey(concat(Uint8Array.of(mpc.recovery_id), r, s),
      digest, { prehash: false });
    const address = `0x${bytesHex(keccak_256(secp256k1.Point.fromBytes(recovered).toBytes(false).slice(1)).slice(-20))}`;
    if (address.toLowerCase() !== petAddress.toLowerCase()) throw new Error('wrong_signer');
    const meta = JSON.parse(sourceMetaJson) as Record<string, string>;
    const fields: BaseTransactionFields = { nonce: BigInt(meta.nonce!), priorityFee: BigInt(meta.priority!),
      maxFee: BigInt(meta.maxFee!), gasLimit: BigInt(meta.gasLimit!),
      to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', value: 0n,
      data: new Uint8Array() };
    // The contract checked the ERC-20 call. Reconstruct its unsigned bytes exactly before signing.
    if (bytesHex(baseSweepPayload(destination, amount, fields.nonce, fields.priorityFee,
      fields.maxFee, fields.gasLimit)) !== payloadHex.toLowerCase()) throw new Error('payload_changed');
    const call = concat(fromHex('0xa9059cbb'), new Uint8Array(12), fromHex(destination),
      new Uint8Array(24), (() => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, amount, false); return out; })());
    fields.data = call;
    const signed = baseSignedTransaction(fields, mpc.recovery_id, r, s);
    return { encoded: `0x${bytesHex(signed)}`, hash: `0x${bytesHex(keccak_256(signed))}` };
  } catch { throw new QuoteUnavailable('source_unavailable'); }
}

export function signedBaseGasTransfer(secret: Uint8Array, nonce: bigint, to: string,
  amount: bigint, priorityFee: bigint, maxFee: bigint): SourceSigned {
  const fields: BaseTransactionFields = { nonce, priorityFee, maxFee, gasLimit: 21_000n,
    to, value: amount, data: new Uint8Array() };
  const digest = keccak_256(baseUnsignedTransaction(fields));
  const signature = secp256k1.sign(digest, secret, { prehash: false, format: 'recovered' });
  const raw = baseSignedTransaction(fields, signature[0]!, signature.slice(1, 33), signature.slice(33));
  return { encoded: `0x${bytesHex(raw)}`, hash: `0x${bytesHex(keccak_256(raw))}` };
}

export function signedSolanaGasTransaction(secret: Uint8Array, message: Uint8Array): SourceSigned {
  const signature = ed25519.sign(message, secret);
  return { encoded: base64Transaction(message, signature), hash: baseEncode(signature) };
}
