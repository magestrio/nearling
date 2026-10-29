import { KeyPair, actions, baseDecode, createTransaction, encodeTransaction, keyToImplicitAddress } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import { PrivySigner, bytesToHex, publicKeyFromImplicitAccount } from './privySigner';

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

describe('PrivySigner', () => {
  it('has the wallet sign the sha256 of the encoded transaction and returns a signature that verifies', async () => {
    const keyPair = KeyPair.fromRandom('ed25519');
    const accountId = keyToImplicitAddress(keyPair.getPublicKey());
    const publicKey = publicKeyFromImplicitAccount(accountId);
    expect(publicKey.toString()).toBe(keyPair.getPublicKey().toString());

    let hashHex = '';
    const signer = new PrivySigner(publicKey, async (h) => {
      hashHex = h;
      const hash = Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
      return keyPair.sign(hash).signature;
    });

    const blockHash = baseDecode('11111111111111111111111111111111');
    const tx = createTransaction(accountId, publicKey, 'receiver.testnet', 7n, [actions.transfer(1000n)], blockHash);
    const { signedTransaction } = await signer.signTransaction(tx);

    const digest = await sha256(encodeTransaction(tx));
    expect(hashHex).toBe(bytesToHex(digest));
    expect(hashHex).toHaveLength(64);
    const signature = signedTransaction.signature.ed25519Signature;
    expect(signature).toBeDefined();
    expect(signature!.data).toHaveLength(64);
    expect(publicKey.verify(digest, signature!.data)).toBe(true);
  });

  it('refuses an account id that is not a 64-hex implicit account', () => {
    expect(() => publicKeyFromImplicitAccount('alice.testnet')).toThrow('not an implicit account id');
  });
});
