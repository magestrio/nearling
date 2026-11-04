import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import type { FakeState } from '../src/seams/fakes';
import type { VerificationIndex, VerificationThought } from '../src/seams/worker-types';
import { buildEnvFor } from '../build-env';

const CHARACTER = 'Curious and a little dramatic; counts things when nervous, loves small rituals.';
const HASH = createHash('sha256').update(CHARACTER).digest('hex');
const NORI_CHARACTER = 'Calm and precise; answers in short lines and finishes one thought before starting the next.';
const NORI_HASH = createHash('sha256').update(NORI_CHARACTER).digest('hex');
const MODEL = 'Qwen/Qwen3.8-27B';
const PRICE = '280000000000000000000';
const ACCOUNT = 'a'.repeat(64);
const CONTRACT = buildEnvFor('e2e').VITE_CONTRACT_ID;
const KEY = new Uint8Array(32).fill(1);
const PUBLIC = secp256k1.getPublicKey(KEY, false);
const SIGNER = `0x${Buffer.from(keccak_256(PUBLIC.slice(1)).slice(-20)).toString('hex')}`;
// Deterministic base58 encodings of 32-byte fixture digests, shaped like NEAR transaction hashes.
export const TX_HASHES = {
  birth: '9vhzmPyrGGRow17rgLBTmMDevQPzecmU4YywiC6mgVxy',
  teen: '3QseLiC2kY5i61W17t7PBS5E6JXHHgBC3k5LW7ABfiPz',
  adult: 'Cet8C7GpgK4AwZGUVVa9ExAHg2VHHeFoA2naEhoH1QdF',
  cap: 'DXqYdM9Pp5bbuUEsf6RiR4gUPkwYADG6GVyd2u4oy4Fn',
  crown: 'GcZ8XQc2KUB2Be9txKMBScDErs8SZ2yXPcWWWmESixwX',
  hat: '4WAbGx8fAwG76e5uPyWUfWwWC4e5CegR8isZyUyNXk51',
  receipt: '6VJXsf3nL3uGi7kJKBjHLgZE7sLjGpVvT45q9dtp6dg5',
  old: 'E4pHL2VsF3dSh9dkDRjSCcr7vaGp6KFmb1X91iawp73B',
} as const;
export const THINK_ID = 'a'.repeat(24);
export const OLD_ID = 'b'.repeat(24);
export const MISSING_ID = 'f'.repeat(24);
const REQUEST_BYTES = Buffer.from(JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: CHARACTER },
  { role: 'system', content: 'Grown-up · clever, sociable · Thinking cap · calm · 7 of 10 · 12 memories' },
  { role: 'user', content: "It's the chart nobody understands." }] }));
const REPLY = 'Start with the chart, then. Say what surprised you about it — people follow a surprise better than a number.';
const RESPONSE_BYTES = Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: REPLY } }],
  usage: { prompt_tokens: 1240, completion_tokens: 236, completion_tokens_details: { reasoning_tokens: 0 } } }));
const REQ = createHash('sha256').update(REQUEST_BYTES).digest('hex');
const RES = createHash('sha256').update(RESPONSE_BYTES).digest('hex');

function signature(): string {
  const message = new TextEncoder().encode(`${MODEL}:${REQ}:${RES}`);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const signed = new Uint8Array(prefix.length + message.length);
  signed.set(prefix); signed.set(message, prefix.length);
  const result = secp256k1.sign(keccak_256(signed), KEY);
  return `0x${Buffer.from(new Uint8Array([...result.toCompactRawBytes(), 27 + result.recovery!])).toString('hex')}`;
}

function callFor(n: number, response: Buffer, output: number, cut: boolean, request = REQUEST_BYTES, input = 1240,
  sigKind: 'provider_tee' | 'gateway' = 'provider_tee') {
  const reqHash = createHash('sha256').update(request).digest('hex');
  const resHash = createHash('sha256').update(response).digest('hex');
  const message = new TextEncoder().encode(sigKind === 'gateway' ? `${reqHash}:${resHash}` : `${MODEL}:${reqHash}:${resHash}`);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const signed = new Uint8Array(prefix.length + message.length);
  signed.set(prefix); signed.set(message, prefix.length);
  const result = secp256k1.sign(keccak_256(signed), KEY);
  return { ...call, n, sig_kind: sigKind, req_sha256: reqHash, res_sha256: resHash, tokens_in: input, tokens_out: output, cut,
    signature: `0x${Buffer.from(new Uint8Array([...result.toCompactRawBytes(), 27 + result.recovery!])).toString('hex')}` };
}

const call = { n: 0, req_sha256: REQ, res_sha256: RES, signature: signature(), sig_kind: 'provider_tee',
  signer: SIGNER, tokens_in: 1240, tokens_out: 236, tokens_reasoning: 0, cut: false, completion_id: 'cmpl-pixel-sample' };
const at = (day: number, hour: number, minute: number) => Date.UTC(2026, 9, day, hour, minute);
const rows = [
  { id: '0'.repeat(24), day: 30, hour: 14, minute: 31, status: 'pending' },
  { id: THINK_ID, day: 30, hour: 14, minute: 2, status: 'billed' },
  { id: '1'.repeat(24), day: 30, hour: 13, minute: 58, status: 'billed' },
  { id: '2'.repeat(24), day: 30, hour: 13, minute: 56, status: 'billed' },
  { id: '3'.repeat(24), day: 30, hour: 13, minute: 51, status: 'billed', withoutReply: true },
  { id: '4'.repeat(24), day: 30, hour: 9, minute: 12, status: 'billed' },
  { id: '5'.repeat(24), day: 29, hour: 21, minute: 40, status: 'project' },
  { id: '6'.repeat(24), day: 28, hour: 20, minute: 15, status: 'billed' },
  { id: OLD_ID, day: 27, hour: 19, minute: 20, status: 'billed' },
  { id: '7'.repeat(24), day: 26, hour: 17, minute: 3, status: 'billed' },
];
const priceFor = (id: string): string => id === THINK_ID ? PRICE
  : id === OLD_ID ? '260000000000000000000'
    : id === '4'.repeat(24) ? '1350000000000000000000'
      : id === '3'.repeat(24) ? '152000000000000000000'
        : '174000000000000000000';

const pointer = (row: typeof rows[number], viewer: VerificationThought['viewer']): VerificationThought => ({
  id: row.id, tokenId: '9', payingTokenId: '9', at: at(row.day, row.hour, row.minute),
  kind: 'deep', status: row.status, debitTxHash: row.status === 'billed' ? row.id === OLD_ID ? TX_HASHES.old : TX_HASHES.receipt : null,
  model: MODEL, priceYocto: priceFor(row.id), nearUsdRate: '4.59', workerTokenId: null, skilled: false, adapterUsed: false,
  erased: false, withoutReply: 'withoutReply' in row && row.withoutReply === true,
  calls: [call], viewer,
  playerText: "It's the chart nobody understands.", replyText: REPLY,
  ...(viewer === 'owner' ? { privateCalls: [{ n: 0, requestBase64: REQUEST_BYTES.toString('base64'),
    replyBase64: RESPONSE_BYTES.toString('base64') }] } : {}),
});

const transaction = (event: string, data: Record<string, unknown>, tokenId = '9') => ({
  status: { SuccessValue: '' }, transaction: { receiver_id: CONTRACT }, receipts_outcome: [{ outcome: {
    logs: [`EVENT_JSON:${JSON.stringify({ standard: 'nearling', version: '1.0.0', event, data: { token_id: tokenId, ...data } })}`],
  } }],
});
const receiptOutcome = (price = PRICE, calls: typeof call[] = [call], worker: string | null = null,
  hire?: Record<string, unknown>) => ({ status: { SuccessValue: '' }, transaction: { receiver_id: CONTRACT,
  actions: [{ FunctionCall: { method_name: 'debit_session', args: Buffer.from(JSON.stringify({ token_id: '9', debit_id: 8 })).toString('base64') } }] },
  receipts_outcome: [{ outcome: { logs: [
    `EVENT_JSON:${JSON.stringify({ standard: 'nearling', version: '1.0.0', event: 'receipt',
      data: { token_id: '9', debit_id: 8, model: MODEL, price, ...(worker ? { worker } : {}),
        calls: calls.map(({ n: _n, completion_id: _completion, ...chainCall }) => chainCall) } })}`,
    ...(hire ? [`EVENT_JSON:${JSON.stringify({ standard: 'nearling', version: '1.0.0', event: 'hire', data: hire })}`] : []),
  ] } }],
});

export function verificationFakes(options: { signedOut?: boolean; asleep?: boolean; empty?: boolean; missing?: boolean;
  old?: boolean; loading?: boolean; variant?: 'checking' | 'checked' | 'request-mismatch' | 'mismatch'
    | 'signature-mismatch' | 'price-mismatch' | 'fee-mismatch' | 'skill-mismatch' | 'tokens-mismatch'
    | 'stream' | 'pending' | 'pending-cleared' | 'project-paid' | 'memory-cleared' | 'two-calls' | 'empty-reply' | 'worker' | 'hire-question'
    | 'character-mismatch' | 'link-not-ready' | 'unread' | 'skilled' | 'skilled-public' | 'errand' | 'errand-cut' | 'errand-none' | 'errand-skill' } = {}): FakeState {
  const chosen = options.empty ? [] : rows;
  const viewer = options.signedOut ? 'visitor' : 'owner';
  const birth = { kind: 'birth', ref: 'birth', txHash: TX_HASHES.birth, at: at(26, 17, 3) };
  const state: FakeState = {
    ...(!options.signedOut ? { auth: { authenticated: true, nearAccountId: ACCOUNT } } : {}),
    worker: {
      owned: ['9'],
      pets: { '9': { tokenId: '9', name: 'Pixel', stage: options.empty ? 'baby' : 'adult',
        fullness: { state: options.asleep ? 'asleep' : 'full', level: options.asleep ? 0 : 1 }, mood: options.asleep ? null : 'happy',
        worn: options.empty ? null : 'thinking-cap' } },
      ...(options.loading ? { verificationDelayMs: 3_600_000 } : {}),
      verificationIndex: { tokenId: '9', worn: options.empty ? null : 'thinking-cap',
        transactions: [birth, ...(options.empty ? [] : [
          { kind: 'growth', ref: 'Teen', txHash: TX_HASHES.teen, at: at(27, 19, 20) },
          { kind: 'growth', ref: 'Adult', txHash: TX_HASHES.adult, at: at(28, 20, 15) },
          { kind: 'item', ref: 'thinking-cap', txHash: TX_HASHES.cap, at: at(30, 13, 0) },
          { kind: 'item', ref: 'daisy-crown', txHash: TX_HASHES.crown, at: at(29, 10, 0) },
          { kind: 'item', ref: 'party-hat', txHash: TX_HASHES.hat, at: at(30, 11, 0) },
        ])],
        thoughts: chosen.map((row) => ({ id: row.id, tokenId: '9', at: at(row.day, row.hour, row.minute),
          status: row.status, erased: false, withoutReply: 'withoutReply' in row && row.withoutReply === true,
          model: MODEL, priceYocto: priceFor(row.id), nearUsdRate: '4.59' })) },
      verificationThoughts: Object.fromEntries(chosen.map((row) => [row.id, pointer(row, viewer)])),
    },
    rpc: { viewResults: {
      pet_view: options.missing ? null : { owner_id: ACCOUNT, name: 'Pixel', character: CHARACTER,
        born_at: at(26, 17, 3) * 1_000_000, stage: options.empty ? 'Baby' : 'Adult',
        traits: options.empty ? [] : ['clever', 'sociable'], outfits: options.empty ? [] : [0, 2, 6] },
      contract_source_metadata: { version: '0.1.0', link: 'https://github.com/magestrio/nearling' },
    }, outcomes: {
      [TX_HASHES.birth]: transaction('pet_born', { character_sha256: HASH }),
      [TX_HASHES.teen]: transaction('grow', { stage: 'Teen', trait: 'clever' }),
      [TX_HASHES.adult]: transaction('grow', { stage: 'Adult', trait: 'sociable' }),
      [TX_HASHES.cap]: transaction('outfit', { item: 2 }),
      [TX_HASHES.crown]: transaction('outfit', { item: 0 }),
      [TX_HASHES.hat]: transaction('outfit', { item: 6, price: '1660000000000000000000' }),
      [TX_HASHES.receipt]: receiptOutcome(),
      ...(options.old ? Object.fromEntries([TX_HASHES.old, TX_HASHES.birth, TX_HASHES.teen, TX_HASHES.adult, TX_HASHES.crown]
        .map((hash) => [hash, { fail: 'UNKNOWN_TRANSACTION' }])) : {}),
    }, ...(options.old ? { archiveOutcome: { fail: '403 forbidden' } } : {}) },
  };
  const thought = state.worker!.verificationThoughts![THINK_ID] as VerificationThought;
  const index = state.worker!.verificationIndex as VerificationIndex;
  const first = index.thoughts.find((entry) => entry.id === THINK_ID)!;
  const variant = options.variant;
  if (variant === 'checking') {
    state.rpc!.transactionDelayMs = 3_600_000;
    state.rpc!.transactionDelayHash = TX_HASHES.receipt;
  }
  if (variant === 'mismatch') {
    // another reply with the same usage block: its hash differs from the receipt, its token counts still read true
    const held = JSON.parse(Buffer.from(thought.privateCalls![0]!.replyBase64!, 'base64').toString('utf8')) as
      { choices: Array<{ message: { content: string } }> };
    held.choices[0]!.message.content = 'a different reply';
    thought.privateCalls![0]!.replyBase64 = Buffer.from(JSON.stringify(held)).toString('base64');
  }
  if (variant === 'request-mismatch') thought.privateCalls![0]!.requestBase64 = Buffer.from('different request').toString('base64');
  if (variant === 'signature-mismatch') {
    const unsigned = { ...call, signer: `0x${'f'.repeat(40)}` };
    thought.calls = [unsigned];
    state.rpc!.outcomes![TX_HASHES.receipt] = receiptOutcome(PRICE, [unsigned]);
  }
  if (variant === 'price-mismatch') thought.priceYocto = '1';
  if (variant === 'tokens-mismatch') {
    const mismatched = { ...call, tokens_out: call.tokens_out + 1 };
    thought.calls = [mismatched];
    state.rpc!.outcomes![TX_HASHES.receipt] = receiptOutcome(PRICE, [mismatched]);
  }
  if (variant === 'stream') {
    thought.kind = 'reply';
    thought.priceYocto = '170000000000000000000';
    const gateway = { ...call, sig_kind: 'gateway', signature: gatewaySignature() };
    thought.calls = [gateway];
    state.rpc!.outcomes![TX_HASHES.receipt] = receiptOutcome(thought.priceYocto, [gateway]);
  }
  if (variant === 'pending' || variant === 'pending-cleared' || variant === 'project-paid') {
    thought.status = variant === 'project-paid' ? 'project' : 'pending';
    thought.debitTxHash = null;
    first.status = thought.status;
  }
  if (variant === 'character-mismatch') state.rpc!.outcomes![TX_HASHES.birth] = transaction('pet_born', { character_sha256: 'f'.repeat(64) });
  if (variant === 'link-not-ready') index.transactions = index.transactions.filter((tx) => tx.txHash !== TX_HASHES.hat);
  if (variant === 'unread') state.rpc!.viewResults!.pet_view = { fail: 'rpc unavailable' };
  if (variant === 'memory-cleared' || variant === 'pending-cleared') {
    thought.erased = true;
    thought.replyText = null;
    thought.playerText = null;
    delete thought.privateCalls;
    first.erased = true;
  }
  if (variant === 'empty-reply') {
    thought.kind = 'reply';
    thought.priceYocto = '150000000000000000000';
    thought.withoutReply = true;
    thought.replyText = null;
    first.withoutReply = true;
    const response = Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }],
      usage: { prompt_tokens: 1240, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 0 } } }));
    const emptyCall = callFor(0, response, 4, false);
    thought.calls = [emptyCall];
    thought.privateCalls![0]!.replyBase64 = response.toString('base64');
    state.rpc!.outcomes![TX_HASHES.receipt] = receiptOutcome(thought.priceYocto, [emptyCall]);
  }
  if (variant === 'two-calls') {
    const firstResponse = Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }],
      usage: { prompt_tokens: 1240, completion_tokens: 3000, completion_tokens_details: { reasoning_tokens: 3000 } } }));
    const secondResponse = Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: REPLY } }],
      usage: { prompt_tokens: 1240, completion_tokens: 212, completion_tokens_details: { reasoning_tokens: 0 } } }));
    const second = callFor(1, secondResponse, 212, false);
    const firstCall = { ...callFor(0, firstResponse, 3000, true), tokens_reasoning: 3000 };
    thought.calls = [firstCall, second];
    thought.privateCalls = [{ n: 0, requestBase64: REQUEST_BYTES.toString('base64'), replyBase64: firstResponse.toString('base64') },
      { n: 1, requestBase64: REQUEST_BYTES.toString('base64'), replyBase64: secondResponse.toString('base64') }];
    thought.priceYocto = '1350000000000000000000';
    state.rpc!.outcomes![TX_HASHES.receipt] = receiptOutcome(thought.priceYocto, thought.calls as typeof call[]);
  }
  if (variant === 'worker' || variant === 'fee-mismatch' || variant === 'skill-mismatch'
    || variant === 'skilled' || variant === 'skilled-public') {
    const workerReply = 'Tell them what the chart changed for you. One sentence, then stop — silence after a point makes it land.';
    const workerRequest = Buffer.from(JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: NORI_CHARACTER },
      { role: 'user', content: 'How do you make a room care about a chart in one sentence?' }] }));
    const workerResponse = Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: workerReply } }],
      usage: { prompt_tokens: 1960, completion_tokens: 54, completion_tokens_details: { reasoning_tokens: 0 } } }));
    const skilled = variant === 'skilled' || variant === 'skilled-public';
    const skilledReply = 'Lead with the one number that changed, then the chart. Ten words on the slide, no more.';
    const skilledResponse = Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: skilledReply } }],
      usage: { prompt_tokens: 1960, completion_tokens: 54, completion_tokens_details: { reasoning_tokens: 0 } } }));
    const workerCall = callFor(0, skilled ? skilledResponse : workerResponse, 54, false, workerRequest, 1960);
    thought.kind = 'hire_answer';
    thought.tokenId = '5';
    thought.payingTokenId = '9';
    thought.workerTokenId = '5';
    thought.priceYocto = '170000000000000000000';
    thought.fee = { fee_yocto: '830000000000000000000', fee_usd_micros: 3800 };
    thought.replyText = workerReply;
    thought.calls = [workerCall];
    thought.privateCalls = [{ n: 0, requestBase64: workerRequest.toString('base64'), replyBase64: workerResponse.toString('base64') }];
    first.tokenId = '5';
    first.priceYocto = thought.priceYocto;
    index.tokenId = '5';
    index.thoughts = [first];
    index.transactions = index.transactions.filter((tx) => tx.kind !== 'item');
    index.transactions[0]!.at = at(20, 18, 2);
    index.transactions[1]!.at = at(21, 9, 40);
    index.transactions[2]!.at = at(22, 10, 14);
    index.worn = null;
    state.worker!.pets!['5'] = { ...state.worker!.pets!['9']!, tokenId: '5', name: 'Nori', worn: null };
    state.rpc!.viewResults!.pet_view = { ...state.rpc!.viewResults!.pet_view as Record<string, unknown>,
      name: 'Nori', character: NORI_CHARACTER, born_at: at(20, 18, 2) * 1_000_000,
      traits: ['thoughtful', 'thoughtful'], outfits: [] };
    for (const [hash, event, data] of [
      [TX_HASHES.birth, 'pet_born', { character_sha256: NORI_HASH }],
      [TX_HASHES.teen, 'grow', { stage: 'Teen', trait: 'thoughtful' }],
      [TX_HASHES.adult, 'grow', { stage: 'Adult', trait: 'thoughtful' }],
    ] as const) state.rpc!.outcomes![hash] = transaction(event, data, '5');
    thought.skilled = skilled;
    if (skilled) {
      thought.replyText = skilledReply;
      thought.privateCalls![0]!.requestBase64 = null;
      thought.privateCalls![0]!.replyBase64 = skilledResponse.toString('base64');
    }
    if (variant === 'skilled-public') {
      state.worker!.owned = [];
      thought.viewer = 'guest';
      thought.replyText = null;
      thought.playerText = null;
      delete thought.privateCalls;
    }
    state.rpc!.outcomes![TX_HASHES.receipt] = receiptOutcome(thought.priceYocto, [workerCall], '5', {
      debit_id: 8, hirer: '9', worker: '5', fee: thought.fee.fee_yocto, answer_cost: thought.priceYocto, skill: skilled,
    });
    if (variant === 'fee-mismatch') thought.fee.fee_yocto = '1';
    if (variant === 'skill-mismatch') thought.skilled = true;
  }
  if (variant === 'hire-question') {
    thought.kind = 'hire_question';
    thought.priceYocto = '170000000000000000000';
    thought.workerTokenId = '5';
    thought.replyText = 'To Nori: How do you make a room care about a chart in one sentence?';
    state.worker!.pets!['5'] = { ...state.worker!.pets!['9']!, tokenId: '5', name: 'Nori' };
    state.rpc!.outcomes![TX_HASHES.receipt] = receiptOutcome(thought.priceYocto);
  }
  if (variant === 'errand' || variant === 'errand-cut' || variant === 'errand-none' || variant === 'errand-skill') {
    const job = 'Find out: When does the next NEAR protocol upgrade ship?';
    const report = 'The next protocol upgrade is set for mid-November: validators vote this week, and the release notes name Nov 18 as the earliest date.';
    const searchRequest = Buffer.from(JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: job }] }));
    const searchResponse = Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Search results' } }],
      usage: { prompt_tokens: 420, completion_tokens: 96, completion_tokens_details: { reasoning_tokens: 0 } } }));
    const search1 = { ...callFor(0, searchResponse, 96, false, searchRequest, 420, 'gateway'), label: 'search' };
    const search2 = { ...callFor(1, searchResponse, 96, false, searchRequest, 420, 'gateway'), label: 'search' };
    const reportRequest = Buffer.from(JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: CHARACTER },
      { role: 'user', content: job }, { role: 'user', content: 'Read this: release notes and validator vote.' }] }));
    const reportResponse = Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: report } }],
      usage: { prompt_tokens: 2310, completion_tokens: 188, completion_tokens_details: { reasoning_tokens: 0 } } }));
    const reportCall = { ...callFor(2, reportResponse, 188, false, reportRequest, 2310), label: 'report' };
    const none = variant === 'errand-none';
    const stopped = variant === 'errand-cut';
    const skill = variant === 'errand-skill';
    const second = stopped ? { ...search2, signature: '', signer: '', tokens_in: 0, tokens_out: 0, cut: true } : search2;
    thought.kind = 'errand';
    thought.form = 'find';
    thought.searches = none ? 0 : 2;
    thought.skilled = skill;
    thought.playerText = job;
    thought.replyText = none ? null : report;
    thought.withoutReply = none;
    first.withoutReply = none;
    thought.priceYocto = none ? '830000000000000000000' : '3000000000000000000000';
    thought.calls = none ? [search1, search2] : [search1, second, reportCall];
    thought.privateCalls = [
      { n: 0, requestBase64: searchRequest.toString('base64'), replyBase64: searchResponse.toString('base64') },
      { n: 1, requestBase64: searchRequest.toString('base64'), replyBase64: stopped ? null : searchResponse.toString('base64') },
      ...(!none ? [{ n: 2, requestBase64: skill ? null : reportRequest.toString('base64'), replyBase64: reportResponse.toString('base64') }] : []),
    ];
    state.rpc!.outcomes![TX_HASHES.receipt] = receiptOutcome(thought.priceYocto, thought.calls as typeof call[]);
  }
  return state;
}

export const RECEIPT_CODE = '8'.repeat(64);

/** The live public route returns only a pointer and download paths; bytes stay behind per-call reads. */
export function receiptLinkFakes(options: { revoked?: boolean; unknown?: boolean; downloadError?: boolean } = {}): FakeState {
  const fakes = verificationFakes({ signedOut: true, variant: 'two-calls' });
  const thought = fakes.worker!.verificationThoughts![THINK_ID] as VerificationThought;
  fakes.worker!.sharedReceipt = options.unknown ? { fail: { status: 404, code: 'unknown_link' } }
    : options.revoked ? { code: 'revoked', tokenId: '9', thoughtId: THINK_ID }
      : { status: 'live', thought: { id: THINK_ID, tokenId: '9', payingTokenId: '9',
        calls: thought.calls.map((call) => ({ n: call.n, reqSha256: call.req_sha256, resSha256: call.res_sha256,
          request: `calls/${call.n}/request`, reply: `calls/${call.n}/reply` })) } };
  if (options.downloadError) fakes.worker!.receiptDownload = { fail: { status: 0, code: 'unreachable' } };
  return fakes;
}

function gatewaySignature(): string {
  const message = new TextEncoder().encode(`${REQ}:${RES}`);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const signed = new Uint8Array(prefix.length + message.length);
  signed.set(prefix); signed.set(message, prefix.length);
  const result = secp256k1.sign(keccak_256(signed), KEY);
  return `0x${Buffer.from(new Uint8Array([...result.toCompactRawBytes(), 27 + result.recovery!])).toString('hex')}`;
}
