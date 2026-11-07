// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { THINK_ID, verificationFakes } from '../../e2e/verification.fixtures';
import type { VerificationThought } from '../seams/worker';
import { ReceiptPanel } from './VerificationPage';
import type { CheckState } from './checkMachine';
import type { ChainReceipt } from './check';

const record = { name: 'Pixel', characterHash: 'a'.repeat(64), character: 'checked' as const,
  items: [], source: { version: '1', link: 'https://example.test' } };

describe('Verification receipt page', () => {
  // spec: add-pet-experience › Experience claim rule › public proof opened
  it('places the paid-work limitation beside a public receipt', () => {
    const thought = verificationFakes({ signedOut: true }).worker!.verificationThoughts![THINK_ID] as VerificationThought;
    const html = renderToStaticMarkup(<ReceiptPanel thought={{ ...thought, paidWork: true }} proof={null} record={record} payerName={null} />);
    expect(html).toContain('A receipt records paid work. It does not prove the answer was correct.');
  });
  // spec: add-verification › Verification flow › не сошлось
  it('shows the permanent model, tokens and cut-off, naming each pointer difference', () => {
    const row = verificationFakes().worker!.verificationThoughts![THINK_ID] as VerificationThought;
    const original = row.calls[0]!;
    const thought = { ...row, model: 'Worker/changed', calls: [{ ...original, tokens_in: 999,
      tokens_out: 888, tokens_reasoning: 99, cut: false }] };
    const receipt: ChainReceipt = { token_id: '9', debit_id: 8, model: 'Onchain/permanent',
      price: row.priceYocto, worker: null, calls: [{ ...original, sig_kind: 'provider_tee', tokens_in: 1240,
        tokens_out: 236, tokens_reasoning: 3, cut: true }] };
    const proof: CheckState = { kind: 'mismatch', marks: { receipt, calls: [{ request: 'unavailable',
      reply: 'unavailable', signature: 'unavailable', tokens: 'unavailable' }],
      centsHundredths: 13, price: 'match', hireFee: 'unavailable', skill: 'unavailable', pointer: 'mismatch' } };
    const html = renderToStaticMarkup(<ReceiptPanel thought={thought} proof={proof} record={record} payerName={null} />);
    const element = document.createElement('div');
    element.innerHTML = html;
    const words = element.textContent ?? '';
    for (const line of ['permanent', '1,240 tokens in', '236 out', '3 thinking', 'Cut off at its limit',
      "Model doesn't match the receipt on NEAR", "Call 1 input token count doesn't match the receipt on NEAR",
      "Call 1 output token count doesn't match the receipt on NEAR",
      "Call 1 thinking token count doesn't match the receipt on NEAR",
      "Call 1 cut-off doesn't match the receipt on NEAR"]) expect(words).toContain(line);
    expect(words).not.toContain('999 tokens in');
    expect(words).not.toContain('changed');
  });

  // spec: add-verification › Verification flow › не сошлось
  it('withholds receipt values when no chain receipt can be identified uniquely', () => {
    const row = verificationFakes().worker!.verificationThoughts![THINK_ID] as VerificationThought;
    const thought = { ...row, model: 'Worker/unchecked-model', calls: [{ ...row.calls[0]!, tokens_in: 999 }] };
    const proof: CheckState = { kind: 'mismatch', marks: { receipt: null, calls: [], centsHundredths: null,
      price: 'unavailable', hireFee: 'unavailable', skill: 'unavailable', pointer: 'mismatch' } };
    const html = renderToStaticMarkup(<ReceiptPanel thought={thought} proof={proof} record={record} payerName={null} />);
    expect(html).not.toContain('unchecked-model');
    expect(html).not.toContain('999 tokens in');
    expect(html).not.toContain('0.00028 NEAR');
  });

  // spec: add-verification › Verification flow › не сошлось
  it('renders the chain call count when the pointer lists fewer calls', () => {
    const thought = verificationFakes().worker!.verificationThoughts![THINK_ID] as VerificationThought;
    const original = thought.calls[0]!;
    const receipt: ChainReceipt = { token_id: '9', debit_id: 8, model: thought.model,
      price: thought.priceYocto, worker: null, calls: [
        { ...original, sig_kind: 'provider_tee', cut: Boolean(original.cut) },
        { ...original, sig_kind: 'provider_tee', cut: true, tokens_in: 77, tokens_out: 5 },
      ] };
    const proof: CheckState = { kind: 'mismatch', marks: { receipt, calls: [], centsHundredths: 13,
      price: 'match', hireFee: 'unavailable', skill: 'unavailable', pointer: 'mismatch' } };
    const html = renderToStaticMarkup(<ReceiptPanel thought={thought} proof={proof} record={record} payerName={null} />);
    expect(html).toContain('Call count doesn&#x27;t match the receipt on NEAR');
    expect(html).toContain('77 tokens in');
    expect(html).toContain('Cut off at its limit');
  });

  // spec: add-verification › Receipt link flow › visitor opens link
  it('shows the selected shared reply to a visitor without exposing ordinary private words', () => {
    const thought = verificationFakes({ signedOut: true }).worker!.verificationThoughts![THINK_ID] as VerificationThought;
    const html = renderToStaticMarkup(<ReceiptPanel thought={{ ...thought, viewer: 'visitor', replyText: null }}
      proof={null} record={record} payerName={null} shared={{ onDownload: () => {}, marks: {} }}
      sharedReply="Reply from the published bytes" />);
    expect(html).toContain('Reply from the published bytes');
    expect(html).not.toContain('Only the owner of the pet');
  });
});
