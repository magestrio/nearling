import { KeyType, PublicKey, Signer, baseEncode } from 'near-api-js';

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The ed25519 public key an implicit account (64 hex characters) is made of. */
export function publicKeyFromImplicitAccount(accountId: string): PublicKey {
  if (!/^[0-9a-f]{64}$/.test(accountId)) throw new Error('not an implicit account id');
  const data = new Uint8Array(32);
  for (let i = 0; i < 32; i++) data[i] = parseInt(accountId.slice(i * 2, i * 2 + 2), 16);
  return new PublicKey({ keyType: KeyType.ED25519, data });
}

export function publicKeyString(key: PublicKey): string {
  return `ed25519:${baseEncode(key.data)}`;
}

/**
 * Signs NEAR transactions with a key the browser never holds: near-api-js hands it the sha256 of the
 * encoded transaction, `signHash` has Privy's `signRawHash` sign that hash.
 */
export class PrivySigner extends Signer {
  constructor(
    private readonly publicKey: PublicKey,
    private readonly signHash: (hashHex: string) => Promise<Uint8Array>,
  ) {
    super();
  }

  async getPublicKey(): Promise<PublicKey> {
    return this.publicKey;
  }

  protected async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    return this.signHash(bytesToHex(bytes));
  }
}
