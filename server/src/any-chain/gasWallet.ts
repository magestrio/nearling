import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { baseDecode, baseEncode } from 'near-api-js';
import { bytesHex } from './sweepPayload';
import { QuoteUnavailable, type Origin } from './quote';

export interface GasWallet { address: string; secret: Uint8Array }

/** Source gas keys are separate secrets; no source key is returned to the browser. */
export function gasWallet(env: Env, chain: Origin): GasWallet {
  try {
    if (chain === 'solana') {
      const raw = env.SOLANA_GAS_WALLET_KEY.replace(/^ed25519:/, '');
      const decoded = baseDecode(raw);
      if (decoded.length !== 32 && decoded.length !== 64) throw new Error('bad_key');
      const secret = decoded.slice(0, 32);
      return { secret, address: baseEncode(ed25519.getPublicKey(secret)) };
    }
    const raw = env.BASE_GAS_WALLET_KEY.replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('bad_key');
    const secret = Uint8Array.from(raw.match(/../g)!, (part) => parseInt(part, 16));
    const publicKey = secp256k1.getPublicKey(secret, false);
    return { secret, address: `0x${bytesHex(keccak_256(publicKey.slice(1)).slice(-20))}` };
  } catch { throw new QuoteUnavailable('source_gas_unavailable'); }
}
