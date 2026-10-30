// The network of a Worker test: every outbound `fetch` of the Worker lands here and nothing reaches
// the internet. Two services are played:
//
//  - Privy's JWKS (`PRIVY_JWKS_URL`): the public key of a key pair made for the test, so the test
//    signs identity tokens the Worker verifies (`token()`).
//  - The NEAR JSON-RPC (`NEAR_RPC_URL`): a small model of the Nearling contract answering
//    `pet_view`, `hatch_view`, `nft_supply_for_owner`, `view_account`, and executing `pet_mint`
//    from a transaction the Worker really signed and sent (`query`, `block`, `send_tx`, `tx` in the
//    shapes of nearcore's JSON-RPC). The model keeps the contract's rules that a Scenario relies on
//    (one pet per account, 50 a day, the pool, the name and character limits); the contract itself
//    is proved by `contract/tests/`.
//
// A fake answers what the real service answers; its shapes are nearcore's, read from near-api-js.
import { env } from 'cloudflare:workers';
import { baseDecode, baseEncode, decodeSignedTransaction, encodeTransaction } from 'near-api-js';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { vi } from 'vitest';

export const NEAR_ACCOUNT = (n: number) => n.toString(16).padStart(64, '0');

export interface FakePet {
  owner_id: string;
  name: string;
  character: string;
  born_at: number;
  project_food: string;
  given_food: string;
  debit_day: number;
  debited_today: string;
  last_debit_id: number;
  stage: string;
  stage_day: number;
  streak: number;
  freezes: number;
}

export type SendMode =
  | 'normal'
  // The transaction is executed but the answer never arrives: the outcome is unknown to the Worker.
  | 'executed-but-silent'
  // The transaction never reaches the chain and the answer never arrives.
  | 'lost'
  // The first delivery is rejected with an invalid nonce (nothing is executed), the next is fine.
  | 'nonce-once';

export class FakeContract {
  pets = new Map<string, FakePet>();
  hatchedBy = new Map<string, string>();
  /** The UTC day of the (faked) clock, as the contract's `block_timestamp` would say. */
  get day(): number {
    return Math.floor(Date.now() / 86_400_000);
  }
  /** What the next successful transaction burns, yoctoNEAR (`tokens_burnt` of its outcome). */
  burnt = '0';
  /** When set, `debit_session` fails with this contract code even if its rules would pass. */
  debitFails: string | null = null;
  bornToday = 0;
  pool = 1_000_000_000_000_000_000_000_000n; // 1 NEAR
  nextId = 0;
  serverBalance = 10_000_000_000_000_000_000_000_000n;
  /** Every contract view call the Worker made, as `method:args`. */
  reads: { method: string; args: Record<string, unknown> }[] = [];
  /** Every transaction the Worker sent to the contract. */
  sends: { method: string; args: Record<string, unknown>; gas: string; deposit: string; signer: string; nonce: number }[] = [];
  mode: SendMode = 'normal';
  /** Every transaction that reached the RPC (also the ones whose answer was lost). */
  attempts = 0;
  private signedHashes = new Set<string>();
  /** When set, the whole RPC answers 503. */
  down = false;
  /** When set, `pet_mint` fails with this contract code (a panic). */
  mintFails: string | null = null;
  /** How `tx` answers a hash it has never seen. nearcore polls until its own timeout (`TIMEOUT_ERROR`);
   * `UNKNOWN_TRANSACTION` comes only from a non-waiting status. */
  unseenTx: 'unknown' | 'timeout' = 'unknown';
  /** A node that has not reached the block yet: `tx` answers every hash as unseen. */
  txBlind = false;
  /** How far behind the next `pet_view`s answer, in accepted debits, one number per read: the reads
   * of a debit may hit RPC nodes at different heights. */
  lag: number[] = [];
  /** Each runs once, inside the next RPC call of that name and before it answers: what the rest of
   * the world does while the Worker waits on that call. */
  meanwhile: { view_account?: () => Promise<void>; pet_view?: () => Promise<void>; send_tx?: () => Promise<void> } = {};
  outcomes = new Map<string, unknown>();
  /** A pet as it stood before each of its accepted debits, the oldest first. */
  private past = new Map<string, FakePet[]>();
  private applied = new Set<string>();
  private nonce = 100;
  private nonceRejected = false;

  addPet(id: string, owner: string, patch: Partial<FakePet> = {}): FakePet {
    const pet: FakePet = {
      owner_id: owner,
      name: 'Pixel',
      character: 'I am a test character.',
      born_at: 1,
      project_food: env.STARTER_FOOD,
      given_food: '0',
      debit_day: this.day,
      debited_today: '0',
      last_debit_id: 0,
      stage: 'Baby',
      stage_day: this.day,
      streak: 0,
      freezes: 1,
      ...patch,
    };
    this.pets.set(id, pet);
    return pet;
  }

  ownedBy(account: string): number {
    return [...this.pets.values()].filter((p) => p.owner_id === account).length;
  }

  /** Views that fail (the node errors) while the rest of the contract answers. */
  failingViews = new Set<string>();

  view(method: string, args: Record<string, unknown>): unknown {
    this.reads.push({ method, args });
    if (this.failingViews.has(method)) throw new Error(`the fake node fails ${method}`);
    switch (method) {
      case 'pet_view': {
        const before = this.past.get(String(args.token_id)) ?? [];
        return before[before.length - (this.lag.shift() ?? 0)] ?? this.pets.get(String(args.token_id)) ?? null;
      }
      case 'hatch_view':
        return {
          token_id: this.hatchedBy.get(String(args.account_id)) ?? null,
          day: this.day,
          born_today: this.bornToday,
          pool: this.pool.toString(),
        };
      case 'nft_supply_for_owner':
        return String(this.ownedBy(String(args.account_id)));
      default:
        throw new Error(`the fake contract has no view ${method}`);
    }
  }

  /** The contract's `pet_mint`: a panic code, or the new token id. */
  mint(receiver: string, name: string, character: string): { code: string } | { tokenId: string } {
    const enc = new TextEncoder();
    if (this.mintFails !== null) return { code: this.mintFails };
    if (this.hatchedBy.has(receiver)) return { code: 'already_hatched' };
    if (this.bornToday >= 50) return { code: 'daily_births' };
    if (enc.encode(name).length > 32) return { code: 'name_too_long' };
    if (enc.encode(character).length > Number(env.MAX_CHARACTER_BYTES)) return { code: 'character_too_long' };
    const cost = BigInt(env.MAX_BIRTH_COST);
    if (this.pool < cost) return { code: 'pool_empty' };
    const id = String(this.nextId++);
    this.addPet(id, receiver, { name, character });
    this.hatchedBy.set(receiver, id);
    this.bornToday += 1;
    this.pool -= cost;
    return { tokenId: id };
  }

  /** The contract's `debit_session`: a panic code, or nothing. Its rules are the ones the Scenarios of
   * `Session debit contract` name; the contract itself is proved by `contract/tests/`. */
  debit(tokenId: string, debitId: number, thoughts: { price: string; calls: unknown[] }[]): { code: string } | null {
    const pet = this.pets.get(tokenId);
    if (this.debitFails !== null) return { code: this.debitFails };
    if (!pet) return { code: 'no_pet' };
    if (thoughts.length === 0) return { code: 'empty_batch' };
    if (thoughts.length > 12) return { code: 'too_many_thoughts' };
    if (debitId !== pet.last_debit_id + 1) return { code: 'bad_debit_id' };
    let sum = 0n;
    for (const t of thoughts) {
      const price = BigInt(t.price);
      if (price > 5_000_000_000_000_000_000_000n) return { code: 'price_over_cap' };
      sum += price;
    }
    const already = pet.debit_day === this.day ? BigInt(pet.debited_today) : 0n;
    if (already + sum > 50_000_000_000_000_000_000_000n) return { code: 'daily_cap' };
    const project = BigInt(pet.project_food);
    const given = BigInt(pet.given_food);
    if (sum > project + given) return { code: 'over_food' };
    const fromProject = sum < project ? sum : project;
    this.past.set(tokenId, [...(this.past.get(tokenId) ?? []), { ...pet }]);
    pet.project_food = (project - fromProject).toString();
    pet.given_food = (given - (sum - fromProject)).toString();
    pet.debit_day = this.day;
    pet.debited_today = (already + sum).toString();
    pet.last_debit_id = debitId;
    this.debits.push({ tokenId, debitId, thoughts });
    return null;
  }
  /** Every accepted `debit_session`. */
  debits: { tokenId: string; debitId: number; thoughts: { price: string; calls: unknown[] }[] }[] = [];

  /** Executes a signed transaction the Worker sent; returns the RPC answer or throws a network error. */
  private async deliver(base64: string): Promise<unknown> {
    const signed = decodeSignedTransaction(Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0)));
    const tx = signed.transaction;
    const action = tx.actions[0] as unknown as { functionCall: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint } };
    const call = action.functionCall;
    const args = JSON.parse(new TextDecoder().decode(Uint8Array.from(call.args as ArrayLike<number>))) as Record<string, unknown>;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encodeTransaction(tx)));
    // the same signed transaction may be delivered again by the RPC client's own retry: one attempt
    const sentHash = baseEncode(hash);
    if (!this.signedHashes.has(sentHash)) {
      this.signedHashes.add(sentHash);
      this.attempts += 1;
    }

    if (this.mode === 'nonce-once' && !this.nonceRejected) {
      this.nonceRejected = true;
      // nearcore's answer to a transaction with a stale nonce (JSON-RPC send_tx).
      return { error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION', info: {} }, code: -32000, message: 'Server error', data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: Number(tx.nonce), ak_nonce: Number(tx.nonce) + 5 } } } } } };
    }
    if (this.mode === 'lost') throw new TypeError('Failed to fetch');

    const key = baseEncode(hash);
    let outcome = this.outcomes.get(key);
    if (outcome === undefined && !this.applied.has(key)) {
      this.applied.add(key);
      this.sends.push({ method: call.methodName, args, gas: call.gas.toString(), deposit: call.deposit.toString(), signer: tx.signerId, nonce: Number(tx.nonce) });
      let status: unknown;
      if (call.methodName === 'pet_mint') {
        const result = this.mint(String(args.receiver), String(args.name), String(args.character));
        status =
          'code' in result
            ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${result.code}` } } } } }
            : { SuccessValue: btoa(JSON.stringify(result.tokenId)) };
      } else if (call.methodName === 'debit_session') {
        const refused = this.debit(String(args.token_id), Number(args.debit_id), args.thoughts as { price: string; calls: unknown[] }[]);
        status = refused
          ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${refused.code}` } } } } }
          : { SuccessValue: '' };
      } else {
        status = { SuccessValue: '' };
      }
      outcome = {
        final_execution_status: 'EXECUTED_OPTIMISTIC',
        status,
        transaction: { hash: key, signer_id: tx.signerId },
        transaction_outcome: { id: key, outcome: { tokens_burnt: this.burnt } },
        receipts_outcome: [],
      };
      this.outcomes.set(key, outcome);
    }
    if (this.mode === 'executed-but-silent') throw new TypeError('Failed to fetch');
    return { result: outcome };
  }

  private async during(call: keyof FakeContract['meanwhile']): Promise<void> {
    const work = this.meanwhile[call];
    delete this.meanwhile[call];
    await work?.();
  }

  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'query': {
        const type = params.request_type;
        if (type === 'call_function') {
          const args = JSON.parse(atob(String(params.args_base64))) as Record<string, unknown>;
          if (params.method_name === 'pet_view') await this.during('pet_view');
          const value = this.view(String(params.method_name), args);
          const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
          return { result: { result: bytes, logs: [], block_height: 1000, block_hash: BLOCK_HASH } };
        }
        if (type === 'view_access_key') {
          return { result: { nonce: this.nonce, permission: 'FullAccess', block_height: 1000, block_hash: BLOCK_HASH } };
        }
        if (type === 'view_account') {
          await this.during('view_account');
          return {
            result: {
              amount: this.serverBalance.toString(),
              locked: '0',
              code_hash: '11111111111111111111111111111111',
              storage_usage: 100,
              storage_paid_at: 0,
              block_height: 1000,
              block_hash: BLOCK_HASH,
            },
          };
        }
        throw new Error(`the fake RPC has no query ${String(type)}`);
      }
      case 'block':
        return { result: { header: { hash: BLOCK_HASH, height: 1000 } } };
      case 'send_tx':
        await this.during('send_tx');
        return await this.deliver(String(params.signed_tx_base64));
      case 'tx': {
        const outcome = this.txBlind ? undefined : this.outcomes.get(String(params.tx_hash));
        if (outcome === undefined) {
          if (this.unseenTx === 'timeout') return { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR', info: {} }, code: -32000, message: 'Server error', data: 'Timeout' } };
          return { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION', info: { requested_transaction_hash: params.tx_hash } }, code: -32000, message: 'Server error', data: 'unknown transaction' } };
        }
        return { result: outcome };
      }
      default:
        throw new Error(`the fake RPC has no method ${method}`);
    }
  }
}


/** What the next call of NEAR AI Cloud does. Anything not given is an ordinary short reply. */
export interface AiBehavior {
  /** HTTP status; 402 is the spend limit or the empty balance, 429 the rate limit. */
  status?: number;
  /** The `content` of the answer; `</think>` inside it ends the reasoning. `null` is allowed by the OpenAI shape. */
  content?: string | null;
  finish?: 'stop' | 'length';
  tokensIn?: number;
  tokensOut?: number;
  reasoning?: number;
  /** The wait ran out: `fetch` fails the way an aborted request does. */
  hang?: boolean;
  /** The first N signature requests are a 404 (the signature is not ready yet). */
  signatureLate?: number;
  /** How the signature endpoint answers: the right `provider_tee`, a `gateway`, or a wrong `text`. */
  signature?: 'ok' | 'gateway' | 'mismatch' | 'never';
  /** The answer takes this long (ms) to come: a second request can arrive while it is in flight. */
  delay?: number;
}

export interface AiCall {
  url: string;
  headers: Record<string, string>;
  reqBytes: Uint8Array;
  body: { model: string; messages: { role: string; content: string }[]; max_tokens: number; stream: boolean; chat_template_kwargs: { enable_thinking: boolean } };
}

const sha = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** NEAR AI Cloud as the Worker meets it: a chat completion whose answer bytes are NOT canonical JSON
 * (indented, a trailing newline), so a Worker that hashed a re-serialized object would sign
 * different bytes; and a signature endpoint whose `text` is made from the bytes it really saw. */
export class FakeNearAi {
  calls: AiCall[] = [];
  signatureRequests: string[] = [];
  probes = 0;
  /** Calls in flight now and the most there ever were at once. */
  active = 0;
  peak = 0;
  probeStatus = 200;
  /** Behaviors for the next calls in order; when empty, the default. */
  script: AiBehavior[] = [];
  /** The answers leave this field out. */
  broken: { usage?: boolean } = {};
  private seen = new Map<string, { req: string; res: string; behavior: AiBehavior; asked: number }>();
  private n = 0;

  push(...behaviors: AiBehavior[]): void {
    this.script.push(...behaviors);
  }

  async chat(url: string, headers: Record<string, string>, reqBytes: Uint8Array): Promise<Response> {
    const body = JSON.parse(new TextDecoder().decode(reqBytes)) as AiCall['body'];
    this.calls.push({ url, headers, reqBytes, body });
    const b = this.script.shift() ?? {};
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    try {
      if (b.delay) await new Promise((resolve) => setTimeout(resolve, b.delay));
      return await this.answer(b, body, reqBytes);
    } finally {
      this.active -= 1;
    }
  }

  private async answer(b: AiBehavior, body: AiCall['body'], reqBytes: Uint8Array): Promise<Response> {
    if (b.hang) throw new DOMException('The operation was aborted', 'AbortError');
    if (b.status !== undefined && b.status !== 200) {
      return Response.json({ error: { message: 'refused', type: 'x', param: null, code: null } }, { status: b.status });
    }
    this.n += 1;
    const id = `chatcmpl-test-${this.n}`;
    const tokensIn = b.tokensIn ?? Math.ceil(reqBytes.length / 4);
    const finish = b.finish ?? 'stop';
    const tokensOut = b.tokensOut ?? (finish === 'length' ? body.max_tokens : 30);
    const answer = {
      id,
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: b.content === undefined ? 'Hello there, friend.' : b.content }, finish_reason: finish }],
      ...(this.broken.usage ? {} : { usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut, completion_tokens_details: { reasoning_tokens: b.reasoning ?? 0 } } }),
    };
    // Indented with a trailing newline: not what JSON.stringify(JSON.parse(x)) gives back.
    const resBytes = new TextEncoder().encode(`${JSON.stringify(answer, null, 1)}\n`);
    this.seen.set(id, { req: await sha(reqBytes), res: await sha(resBytes), behavior: b, asked: 0 });
    return new Response(resBytes, { status: 200, headers: { 'content-type': 'application/json' } });
  }

  signature(id: string): Response {
    this.signatureRequests.push(id);
    const known = this.seen.get(id);
    if (!known || known.behavior.signature === 'never') return Response.json({ error: { message: 'not found' } }, { status: 404 });
    known.asked += 1;
    if (known.asked <= (known.behavior.signatureLate ?? 0)) return Response.json({ error: { message: 'not found' } }, { status: 404 });
    const kind = known.behavior.signature === 'gateway' ? 'gateway' : 'provider_tee';
    const text = known.behavior.signature === 'mismatch' ? `Qwen/Qwen3.8-27B:${known.req}:${'0'.repeat(64)}` : `Qwen/Qwen3.8-27B:${known.req}:${known.res}`;
    return Response.json({ text, signature: `0xsig-${id}`, signing_address: '0xsigner', signing_algo: 'ecdsa', signature_kind: kind });
  }

  /** The hashes of the request and the answer the fake saw for a completion id. */
  hashes(id: string): { req: string; res: string } | undefined {
    const k = this.seen.get(id);
    return k && { req: k.req, res: k.res };
  }
}

const BLOCK_HASH = baseEncode(new Uint8Array(32).fill(7));

const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };

export interface TokenOptions {
  expiresIn?: string;
  audience?: string;
  issuer?: string;
  kid?: string;
  /** Privy's session id claim; default `sid:<sub>`, `null` leaves the claim out. */
  sid?: string | null;
  /** The token is made for a player the server has no row of (a refusal's test, a sign-in's first call). */
  noPlayer?: boolean;
}

/** An identity token as Privy would issue it for `sub`, carrying a NEAR embedded wallet. Unless
 * `noPlayer`, the player has a row of this month, as one who passed the exchange of `POST /api/session`. */
export async function token(sub: string, accountId: string, opts: TokenOptions = {}): Promise<string> {
  if (opts.noPlayer !== true) {
    await env.DB.prepare('INSERT OR IGNORE INTO players (sub, account_id, month, created_at) VALUES (?, ?, ?, ?)')
      .bind(sub, accountId, new Date().toISOString().slice(0, 7), Date.now())
      .run();
  }
  const sid = opts.sid === undefined ? `sid:${sub}` : opts.sid;
  return new SignJWT({
    ...(sid === null ? {} : { sid }),
    linked_accounts: JSON.stringify([
      { type: 'google_oauth', subject: 'g-1', name: 'Test Player' },
      { type: 'wallet', chain_type: 'near', address: accountId, wallet_client_type: 'privy' },
    ]),
  })
    .setProtectedHeader({ alg: 'ES256', kid: opts.kid ?? 'test-key' })
    .setIssuer(opts.issuer ?? 'privy.io')
    .setAudience(opts.audience ?? env.PRIVY_APP_ID)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(privateKey);
}

export interface Network {
  contract: FakeContract;
  ai: FakeNearAi;
  /** Every URL fetched, for "nothing left the Worker" assertions. */
  fetched: string[];
  /** Privy's key set answers with this status (0: the fetch itself fails). */
  jwks: { status: number };
  restore: () => void;
}

/** Replaces `fetch` for the test. Call `restore()` (or use `afterEach`) when done. */
export function installNetwork(): Network {
  const contract = new FakeContract();
  const ai = new FakeNearAi();
  const fetched: string[] = [];
  const jwks = { status: 200 };
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetched.push(url);
    if (url === env.PRIVY_JWKS_URL) {
      if (jwks.status === 0) throw new TypeError('Failed to fetch');
      return jwks.status === 200 ? Response.json({ keys: [publicJwk] }) : new Response('unavailable', { status: jwks.status });
    }
    if (url === env.NEAR_RPC_URL) {
      if (contract.down) return new Response('unavailable', { status: 503 });
      const request = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}'))) as { id: string; method: string; params: Record<string, unknown> };
      const answer = (await contract.handle(request.method, request.params)) as { result?: unknown; error?: unknown };
      return Response.json({ jsonrpc: '2.0', id: request.id, ...answer });
    }
    if (url.startsWith('https://cloud-api.near.ai/v1/')) {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
      if (url.endsWith('/chat/completions')) return ai.chat(url, headers, init?.body as Uint8Array);
      if (url.includes('/signature/')) return ai.signature(decodeURIComponent(url.split('/signature/')[1]!.split('?')[0]!));
      if (url.endsWith('/check_api_key')) {
        ai.probes += 1;
        return ai.probeStatus === 200 ? Response.json({ valid: true }) : Response.json({ error: { message: 'x', type: 'x', param: null, code: null } }, { status: ai.probeStatus });
      }
    }
    throw new Error(`a test must not reach the network: ${url}`);
  });
  return { contract, ai, fetched, jwks, restore: () => spy.mockRestore() };
}

export { baseDecode };
