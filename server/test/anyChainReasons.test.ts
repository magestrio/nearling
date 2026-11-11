import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { txStatus } from '../src/chain';
import { contractReason } from '../src/any-chain/reasons';
import { harness } from './helpers/api';

const h = harness();

describe('contract rejection reasons', () => {
  // spec: add-any-chain-feed › Pet sweep authorization contract › wrong refund recipient
  // spec: add-any-chain-feed › Pet sweep authorization contract › wrong caller
  // spec: add-any-chain-feed › Pet sweep authorization contract › unknown pet
  // spec: add-any-chain-feed › Pet sweep authorization contract › wrong or stale owner approval
  // spec: add-any-chain-feed › Pet sweep authorization contract › expired or reused approval
  // spec: add-any-chain-feed › Pet sweep authorization contract › wrong derivation path
  // spec: add-any-chain-feed › Pet sweep authorization contract › unsupported token or chain
  // spec: add-any-chain-feed › Pet sweep authorization contract › excessive sweep
  // spec: add-any-chain-feed › Pet sweep authorization contract › duplicate sweep
  // spec: add-any-chain-feed › Pet sweep authorization contract › missing quote destination
  // spec: add-any-chain-feed › wNEAR recovery contract › route not recoverable
  // spec: add-any-chain-feed › wNEAR recovery contract › retry failed route
  // spec: add-any-chain-feed › wNEAR receipt contract › wrong token caller
  it('maps real contract panic codes to public status reasons', () => {
    const cases: Record<string, string> = {
      wrong_token_caller: 'token_rejected', credit_not_recoverable: 'route_not_recoverable',
      not_server: 'wrong_caller', no_pet: 'unknown_pet', bad_owner_approval: 'wrong_owner_approval',
      sweep_approval_expired: 'expired_approval', wrong_sweep_path: 'wrong_derivation_path',
      unsupported_sweep_asset: 'unsupported_token_or_chain', sweep_amount_limit: 'excessive_sweep',
      sweep_already_active: 'duplicate_sweep', bad_sweep_destination: 'missing_quote_destination',
      bad_sweep_refund: 'wrong_refund_recipient',
    };
    for (const [code, reason] of Object.entries(cases)) expect(contractReason(code)).toBe(reason);
    expect(new Set([...Object.values(cases), 'retry_failed_route']).size).toBe(13);
    expect(contractReason('unrecognized_vm_text')).toBeNull();
  });

  // spec: add-any-chain-feed › Pet sweep authorization contract › wrong refund recipient
  it('reads the coded panic from a real-shaped final transaction outcome', async () => {
    const hash = 'B'.repeat(44);
    h.net().contract.outcomes.set(hash, { final_execution_status: 'FINAL',
      status: { Failure: { ActionError: { kind: { FunctionCallError: {
        ExecutionError: 'Smart contract panicked: bad_sweep_refund',
      } } } } },
      transaction: { hash, signer_id: env.SERVER_ACCOUNT_ID },
      transaction_outcome: { outcome: { tokens_burnt: '1000' } }, receipts_outcome: [] });
    const outcome = await txStatus(env, hash, env.SERVER_ACCOUNT_ID);
    expect(outcome).toMatchObject({ status: 'failed', code: 'bad_sweep_refund' });
    expect(outcome?.status === 'failed' ? contractReason(outcome.code) : null).toBe('wrong_refund_recipient');
  });
});
