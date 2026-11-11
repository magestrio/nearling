/** Public status codes for definitive contract refusals. Never expose raw VM text. */
export function contractReason(code: string): string | null {
  const reasons: Record<string, string> = {
    wrong_token_caller: 'token_rejected',
    credit_not_recoverable: 'route_not_recoverable',
    not_server: 'wrong_caller',
    no_pet: 'unknown_pet',
    bad_owner_approval: 'wrong_owner_approval',
    not_current_owner: 'wrong_owner_approval',
    sweep_approval_expired: 'expired_approval',
    sweep_sequence_used: 'expired_approval',
    wrong_sweep_path: 'wrong_derivation_path',
    unsupported_sweep_asset: 'unsupported_token_or_chain',
    sweep_amount_limit: 'excessive_sweep',
    sweep_already_active: 'duplicate_sweep',
    bad_route_id: 'duplicate_sweep',
    bad_sweep_destination: 'missing_quote_destination',
    bad_sweep_refund: 'wrong_refund_recipient',
  };
  return reasons[code] ?? null;
}
