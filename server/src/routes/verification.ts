import { Hono } from 'hono';
import { ChainUnreachable, petView, type PetRecord } from '../chain';
import { TOKEN_ID, requireSession, type AppEnv } from '../http';
import { wornOf } from '../pet/outfits';
import { callBytes, intactCallHashes, matchingReceipt, type ReceiptThought, type StoredCall } from '../verification/receipt';
import { readSharedReceiptFunding } from '../errands/sharedSettle';

export const verificationRoutes = new Hono<AppEnv>();
const THOUGHT_ID = /^[0-9a-f]{24}$/;

interface Pointer {
  id: string;
  token_id: string;
  receipt_token_id: string | null;
  paying_token_id: string | null;
  created_at: number;
  kind: string;
  status: string;
  erased_at: number | null;
  without_reply: number | null;
  debit_tx_hash: string | null;
  model: string;
  price_yocto: string;
  near_usd_rate: string | null;
  worker_id: string | null;
  skilled: number;
  adapter_used: number;
  form: string | null;
  searches: number | null;
  data_labels: string | null;
  shared_job_hash: string | null;
}

export function publicPointer(row: Pointer) {
  const recorded = row.status === 'billed' && row.debit_tx_hash !== null;
  return {
    id: row.id,
    tokenId: row.receipt_token_id,
    payingTokenId: row.paying_token_id,
    at: row.created_at,
    kind: row.kind,
    status: row.status,
    erased: row.erased_at !== null,
    withoutReply: row.without_reply === 1,
    debitTxHash: recorded ? row.debit_tx_hash : null,
    model: recorded ? row.model : '',
    priceYocto: recorded ? row.price_yocto : '',
    nearUsdRate: recorded ? row.near_usd_rate : null,
    workerTokenId: row.worker_id,
    skilled: row.skilled === 1,
    adapterUsed: row.adapter_used === 1,
    form: row.form,
    searches: row.searches,
    dataLabels: row.data_labels === null ? null : JSON.parse(row.data_labels) as string[],
  };
}

const CODE = /^[0-9a-f]{64}$/;
const OPERATION = /^[A-Za-z0-9_-]{16,80}$/;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function codeFor(env: Env, thought: string, publisher: string, operation: string): Promise<string> {
  // The server key is already a Worker secret. Domain separation prevents a link operation
  // from being mistaken for a NEAR signature; the code is reproducible after a lost response.
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.NEAR_SERVER_KEY),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(`nearling-receipt-link\0${thought}\0${publisher}\0${operation}`))));
}

async function codeHash(code: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))));
}

async function receiptData(db: D1Database, thought: string): Promise<{ row: (Pointer & ReceiptThought) | null; calls: StoredCall[]; hire: { fee_yocto: string; skilled: number; status: string } | null }> {
  const row = await db.prepare('SELECT * FROM thoughts WHERE id = ?').bind(thought).first<Pointer & ReceiptThought>();
  if (row === null) return { row, calls: [], hire: null };
  const calls = await db.prepare('SELECT * FROM thought_calls WHERE thought_id = ? ORDER BY n').bind(thought).all<StoredCall>();
  const hire = await db.prepare('SELECT fee_yocto, skilled, status FROM hires WHERE answer_thought_id = ?')
    .bind(thought).first<{ fee_yocto: string; skilled: number; status: string }>();
  return { row, calls: calls.results, hire };
}

async function currentPet(env: Env, paying: string): Promise<PetRecord | null> {
  return petView(env, paying);
}

function ownerPointer(row: Pointer) {
  return { ...publicPointer(row), model: row.model, priceYocto: row.price_yocto,
    nearUsdRate: row.near_usd_rate };
}

function publicShared(row: Pointer & ReceiptThought, calls: StoredCall[]) {
  return { ...publicPointer(row), calls: calls.map((call) => ({ n: call.n,
    reqSha256: call.req_sha256, resSha256: call.res_sha256,
    request: `calls/${call.n}/request`, reply: `calls/${call.n}/reply`,
  })) };
}

verificationRoutes.post('/api/verification/pets/:id/thoughts/:thought/links', async (c) => {
  const session = requireSession(c);
  if (session instanceof Response) return session;
  const id = c.req.param('id');
  const thought = c.req.param('thought');
  if (!TOKEN_ID.test(id) || !THOUGHT_ID.test(thought)) return c.json({ code: 'no_thought' }, 404);
  const body = await c.req.json().catch(() => null) as { operationId?: unknown } | null;
  if (!body || typeof body.operationId !== 'string' || !OPERATION.test(body.operationId)) return c.json({ code: 'bad_operation' }, 400);
  const { row, calls, hire } = await receiptData(c.env.DB, thought);
  if (row === null || row.receipt_token_id !== id || row.paying_token_id === null) return c.json({ code: 'no_thought' }, 404);
  try {
    const pet = await currentPet(c.env, row.paying_token_id);
    if (pet?.owner_id !== session.accountId) return c.json({ code: 'not_owner' }, 403);
    if (!Number.isSafeInteger(pet.transfer_generation)) return c.json({ code: 'chain_unreachable' }, 503);
    if (!await matchingReceipt(c.env, row, calls, hire)) return c.json({ code: 'receipt_ineligible' }, 409);
    const code = await codeFor(c.env, thought, session.accountId, body.operationId);
    const digest = await codeHash(code);
    const made = await c.env.DB.prepare(
      `INSERT INTO receipt_links (code_hash, thought_id, paying_token_id, publisher, operation_id, published_at, transfer_generation)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS
         (SELECT 1 FROM thoughts WHERE id = ?2 AND status = 'billed' AND erased_at IS NULL AND link_eligible = 1)
       AND NOT EXISTS (SELECT 1 FROM gift_flights WHERE token_id = ?3 AND state IN ('prepared', 'sending', 'unknown'))
       AND NOT EXISTS (SELECT 1 FROM gift_flights WHERE token_id = ?3 AND state = 'ok' AND receiver <> ?4)
       ON CONFLICT(thought_id, publisher, operation_id) DO NOTHING RETURNING code_hash`,
    ).bind(digest, thought, row.paying_token_id, session.accountId, body.operationId, Date.now(), pet.transfer_generation).first<{ code_hash: string }>();
    if (made === null) {
      const prior = await c.env.DB.prepare('SELECT code_hash, revoked_at, transfer_generation FROM receipt_links WHERE thought_id = ? AND publisher = ? AND operation_id = ?')
        .bind(thought, session.accountId, body.operationId).first<{ code_hash: string; revoked_at: number | null; transfer_generation: number | null }>();
      if (prior?.code_hash !== digest || prior.revoked_at !== null || prior.transfer_generation !== pet.transfer_generation)
        return c.json({ code: 'receipt_ineligible' }, 409);
    }
    return c.json({ code, path: `/receipt/${code}` });
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
});

async function liveLink(env: Env, code: string) {
  const digest = await codeHash(code);
  const link = await env.DB.prepare('SELECT thought_id, paying_token_id, publisher, revoked_at, transfer_generation FROM receipt_links WHERE code_hash = ?')
    .bind(digest).first<{ thought_id: string; paying_token_id: string; publisher: string; revoked_at: number | null; transfer_generation: number | null }>();
  if (link === null) return { kind: 'unknown' } as const;
  if (link.revoked_at !== null) return { kind: 'revoked', thought: link.thought_id, token: link.paying_token_id } as const;
  const { row, calls, hire } = await receiptData(env.DB, link.thought_id);
  if (row === null || row.paying_token_id !== link.paying_token_id) return { kind: 'revoked', thought: link.thought_id, token: link.paying_token_id } as const;
  if (!await matchingReceipt(env, row, calls, hire)) return { kind: 'unavailable' } as const;
  const pet = await currentPet(env, link.paying_token_id);
  if (pet?.owner_id !== link.publisher || link.transfer_generation !== pet.transfer_generation) {
    await env.DB.prepare('UPDATE receipt_links SET revoked_at = ? WHERE code_hash = ? AND revoked_at IS NULL')
      .bind(Date.now(), digest).run();
    return { kind: 'revoked', thought: link.thought_id, token: link.paying_token_id } as const;
  }
  // This single D1 statement takes the live-link condition and every BLOB from one read after
  // the slow chain check. A clear committed during that check cannot be served from `calls` above.
  const fresh = await env.DB.prepare(
    `SELECT t.*, c.n AS call_n, c.req_bytes, c.res_bytes, c.req_sha256, c.res_sha256,
       c.signature, c.sig_kind, c.signer, c.tokens_in, c.tokens_out, c.tokens_reasoning, c.cut
     FROM receipt_links l JOIN thoughts t ON t.id = l.thought_id
       JOIN thought_calls c ON c.thought_id = t.id
     WHERE l.code_hash = ? AND l.revoked_at IS NULL AND l.publisher = ?
       AND l.transfer_generation = ? AND l.paying_token_id = t.paying_token_id
       AND t.status = 'billed' AND t.erased_at IS NULL AND t.link_eligible = 1
       AND NOT EXISTS (SELECT 1 FROM gift_flights g WHERE g.token_id = l.paying_token_id
         AND g.state IN ('prepared', 'sending', 'unknown'))
     ORDER BY c.n`,
  ).bind(digest, link.publisher, link.transfer_generation).all<Pointer & ReceiptThought & StoredCall & { call_n: number }>();
  if (fresh.results.length === 0) {
    const latest = await env.DB.prepare('SELECT revoked_at FROM receipt_links WHERE code_hash = ?')
      .bind(digest).first<{ revoked_at: number | null }>();
    if (latest?.revoked_at !== null) return { kind: 'revoked', thought: link.thought_id, token: link.paying_token_id } as const;
    return { kind: 'unavailable' } as const;
  }
  const currentCalls = fresh.results.map((item) => ({ ...item, n: item.call_n }));
  if (!await intactCallHashes(currentCalls) || currentCalls.length !== calls.length)
    return { kind: 'unavailable' } as const;
  return { kind: 'live', row: fresh.results[0]!, calls: currentCalls } as const;
}

verificationRoutes.get('/api/verification/receipts/:code', async (c) => {
  const code = c.req.param('code');
  if (!CODE.test(code)) return c.json({ code: 'unknown_link' }, 404);
  try {
    const result = await liveLink(c.env, code);
    if (result.kind === 'unknown') return c.json({ code: 'unknown_link' }, 404);
    if (result.kind === 'revoked') return c.json({ code: 'revoked', tokenId: result.token, thoughtId: result.thought });
    if (result.kind === 'unavailable') return c.json({ code: 'receipt_unavailable' }, 409);
    return c.json({ status: 'live', thought: publicShared(result.row, result.calls) });
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
});

verificationRoutes.get('/api/verification/receipts/:code/calls/:n/:part', async (c) => {
  const code = c.req.param('code');
  const n = Number(c.req.param('n'));
  const part = c.req.param('part');
  if (!CODE.test(code) || !Number.isSafeInteger(n) || n < 0 || n > 3 || (part !== 'request' && part !== 'reply'))
    return c.json({ code: 'unknown_link' }, 404);
  try {
    const result = await liveLink(c.env, code);
    if (result.kind === 'unknown') return c.json({ code: 'unknown_link' }, 404);
    if (result.kind === 'revoked') return c.json({ code: 'revoked' }, 410);
    if (result.kind === 'unavailable') return c.json({ code: 'receipt_unavailable' }, 409);
    const call = result.calls[n];
    if (call?.n !== n) return c.json({ code: 'unknown_call' }, 404);
    const bytes = callBytes(call, part);
    return new Response(bytes.slice().buffer, { headers: { 'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="call-${n}-${part}.bin"`, 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
});

function encodeBytes(value: ArrayBuffer | Uint8Array | null): string | null {
  if (value === null) return null;
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

verificationRoutes.get('/api/verification/pets/:id', async (c) => {
  const id = c.req.param('id');
  if (!TOKEN_ID.test(id)) return c.json({ code: 'no_pet' }, 404);
  const [thoughts, transactions, worn] = await Promise.all([
    c.env.DB.prepare("SELECT id, receipt_token_id, paying_token_id, created_at, status, debit_tx_hash, without_reply, erased_at, model, price_yocto, near_usd_rate, shared_job_hash FROM thoughts WHERE receipt_token_id = ? AND kind NOT IN ('growth', 'hire_event') ORDER BY created_at DESC, id DESC LIMIT 20")
      .bind(id).all<Pick<Pointer, 'id' | 'receipt_token_id' | 'paying_token_id' | 'created_at' | 'status' | 'debit_tx_hash' | 'without_reply' | 'erased_at' | 'model' | 'price_yocto' | 'near_usd_rate' | 'shared_job_hash'>>(),
    c.env.DB.prepare('SELECT kind, ref, tx_hash, at FROM pet_transactions WHERE token_id = ? ORDER BY at, kind, ref')
      .bind(id).all<{ kind: string; ref: string; tx_hash: string; at: number }>(),
    wornOf(c.env.DB, id),
  ]);
  const session = c.get('session');
  const ownerOf = new Map<string, boolean>();
  if (session !== null) {
    try {
      const payers = [...new Set(thoughts.results.filter((row) => row.status !== 'billed' || row.debit_tx_hash === null)
        .map((row) => row.paying_token_id).filter((value): value is string => value !== null))];
      const owners = await Promise.all(payers.map(async (paying) => [paying,
        (await currentPet(c.env, paying))?.owner_id === session.accountId] as const));
      for (const [paying, owns] of owners) ownerOf.set(paying, owns);
    } catch (error) {
      if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
      throw error;
    }
  }
  return c.json({
    tokenId: id,
    worn,
    transactions: transactions.results.map((row) => ({ kind: row.kind, ref: row.ref, txHash: row.tx_hash, at: row.at })),
    thoughts: thoughts.results.map((row) => ({ id: row.id, tokenId: row.receipt_token_id, at: row.created_at,
      shared: row.shared_job_hash !== null,
      status: row.status, erased: row.erased_at !== null, withoutReply: row.without_reply === 1,
      model: (row.status === 'billed' && row.debit_tx_hash !== null) || (row.paying_token_id !== null && ownerOf.get(row.paying_token_id)) ? row.model : '',
      priceYocto: (row.status === 'billed' && row.debit_tx_hash !== null) || (row.paying_token_id !== null && ownerOf.get(row.paying_token_id)) ? row.price_yocto : '',
      nearUsdRate: (row.status === 'billed' && row.debit_tx_hash !== null) || (row.paying_token_id !== null && ownerOf.get(row.paying_token_id)) ? row.near_usd_rate : null })),
  });
});

verificationRoutes.get('/api/verification/pets/:id/thoughts/:thought', async (c) => {
  const id = c.req.param('id');
  const thoughtId = c.req.param('thought');
  if (!TOKEN_ID.test(id) || !THOUGHT_ID.test(thoughtId)) return c.json({ code: 'no_thought' }, 404);
  const row = await c.env.DB.prepare("SELECT * FROM thoughts WHERE id = ? AND receipt_token_id = ? AND kind NOT IN ('growth', 'hire_event')")
    .bind(thoughtId, id).first<Pointer>();
  if (row === null) return c.json({ code: 'no_thought' }, 404);
  const calls = await c.env.DB.prepare('SELECT n, label, req_sha256, res_sha256, signature, sig_kind, signer, completion_id, tokens_in, tokens_out, tokens_reasoning, cut FROM thought_calls WHERE thought_id = ? ORDER BY n')
    .bind(thoughtId).all();
  const fee = row.worker_id === null ? null : await c.env.DB.prepare('SELECT fee_yocto, fee_usd_micros FROM hires WHERE answer_thought_id = ?')
    .bind(thoughtId).first<{ fee_yocto: string; fee_usd_micros: number }>();
  let linkedFunding: Array<{ txHash: string; source: string; amountYocto: string }> = [];
  if (row.shared_job_hash !== null && row.status === 'billed' && row.debit_tx_hash !== null) {
    try {
      const spent = await readSharedReceiptFunding(c.env, row.debit_tx_hash, row.shared_job_hash);
      const evidence = await c.env.DB.prepare('SELECT funding_index, tx_hash, source FROM shared_funding_evidence WHERE job_hash = ?')
        .bind(row.shared_job_hash).all<{ funding_index: number; tx_hash: string; source: string }>();
      linkedFunding = spent.map((entry) => {
        const pointer = evidence.results.find((one) => one.funding_index === entry.index && one.source === entry.kind);
        if (pointer === undefined) throw new ChainUnreachable();
        return { txHash: pointer.tx_hash, source: entry.kind, amountYocto: entry.amount };
      });
    } catch (error) {
      if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
      throw error;
    }
  }
  const publicPart = { ...publicPointer(row), calls: row.status === 'billed' && row.debit_tx_hash !== null ? calls.results : [], fee, linkedFunding };
  const session = c.get('session');
  if (session === null) return c.json({ ...publicPart, viewer: 'visitor' });
  const paying = row.paying_token_id;
  if (paying === null) return c.json({ ...publicPart, viewer: 'guest' });
  let pet;
  try {
    pet = await petView(c.env, paying);
  } catch (error) {
    if (error instanceof ChainUnreachable) return c.json({ code: 'chain_unreachable' }, 503);
    throw error;
  }
  if (pet === null || pet.owner_id !== session.accountId) return c.json({ ...publicPart, viewer: 'guest' });
  const ownerPart = { ...publicPart, ...ownerPointer(row) };
  if (row.erased_at !== null) return c.json({ ...ownerPart, viewer: 'owner' });
  const words = await c.env.DB.prepare('SELECT player_text, reply_text FROM thoughts WHERE id = ? AND erased_at IS NULL')
    .bind(thoughtId).first<{ player_text: string | null; reply_text: string | null }>();
  const bytes = await c.env.DB.prepare('SELECT n, req_bytes, res_bytes FROM thought_calls WHERE thought_id = ? ORDER BY n')
    .bind(thoughtId).all<{ n: number; req_bytes: ArrayBuffer | Uint8Array; res_bytes: ArrayBuffer | Uint8Array }>();
  const privateCalls = bytes.results.map((call) => ({ n: call.n,
    requestBase64: row.skilled === 1 || row.adapter_used === 1 ? null : encodeBytes(call.req_bytes),
    replyBase64: encodeBytes(call.res_bytes),
  }));
  return c.json({ ...ownerPart, viewer: 'owner', playerText: words?.player_text ?? null,
    replyText: words?.reply_text ?? null, privateCalls });
});
