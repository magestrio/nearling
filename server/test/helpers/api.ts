import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, vi } from 'vitest';
import { setTrackSink, type TrackProps } from '../../src/track';
import { installNetwork, NEAR_ACCOUNT, token, type Network } from './network';

// Each test gets its own IP, so a request count (kept in memory by a Durable Object for a minute)
// never carries over from one test to the next.
let testCounter = 0;
let testIp = '198.51.100.1';

export interface Call {
  method?: string;
  token?: string;
  ip?: string;
  body?: unknown;
}

/** One request to the Worker, as the browser would send it. */
export async function api(path: string, call: Call = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (call.token !== undefined) headers['privy-id-token'] = call.token;
  headers['cf-connecting-ip'] = call.ip ?? testIp;
  if (call.body !== undefined) headers['content-type'] = 'application/json';
  const res = await SELF.fetch(`https://game.test${path}`, {
    method: call.method ?? (call.body === undefined ? 'GET' : 'POST'),
    headers,
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

export interface Harness {
  net: () => Network;
  events: () => { name: string; props: TrackProps }[];
  logs: () => string[];
}

/** The fake network, the event sink and the log spy of one test file, set up around each test. */
export function harness(): Harness {
  let network: Network;
  let events: { name: string; props: TrackProps }[] = [];
  let logs: string[] = [];
  let removeSink: () => void;

  beforeEach(async () => {
    testCounter += 1;
    testIp = `198.51.${Math.floor(testCounter / 250)}.${(testCounter % 250) + 1}`;
    // A new minute for every test: the shared copies a Durable Object keeps for 15 s and its
    // request counts never carry over from one test to the next.
    vi.useFakeTimers({ toFake: ['Date'] });
    // The year stays ahead of the real clock for good: `setAlarm` hands this time to workerd,
    // whose alarms run on the real clock, so a fake date the real one has passed fires them by themselves.
    vi.setSystemTime(new Date(Date.UTC(2036, 10, 1, 10, 0, 0) + testCounter * 60_000));
    network = installNetwork();
    events = [];
    logs = [];
    removeSink = setTrackSink((name, props) => events.push({ name, props }));
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    }
    // Clean tables between tests (storage is isolated per file, not per test).
    for (const table of ['receipt_links', 'gift_flights', 'gift_links', 'pet_public_ids', 'pets', 'thoughts', 'thought_calls', 'memory_notes', 'debit_sessions', 'pet_spend', 'empty_answers', 'jobs', 'project_spend', 'service_pause', 'births_in_flight', 'feedings', 'friend_snacks', 'known_index', 'pet_life', 'life_friends', 'pending_growth', 'ritual_days', 'riddles', 'riddle_answers', 'ritual_clock', 'wardrobe', 'outfit_grants', 'outfit_buys', 'item_sends', 'pet_transactions', 'hires', 'hire_modes', 'hire_offers', 'worker_answers', 'skills', 'work_records', 'errands', 'data_sources', 'catalog_entries', 'skill_code', 'code_tests', 'code_versions']) {
      await env.DB.exec(`DELETE FROM ${table}`);
    }
    // The players stay (a token makes its row once), the feeding side of their rows does not.
    await env.DB.exec("UPDATE players SET first_name = NULL, gas_topup_at = NULL, gift_topup_at = NULL, gift_topup_flight = NULL, gift_topup_op = NULL, gift_topup_signed_bytes = NULL, gift_topup_retry_at = NULL, current_pet = NULL, last_gifted_pet = NULL, gas_added_yocto = '0', wallet_seen_yocto = '0'");
  });

  afterEach(() => {
    network.restore();
    removeSink();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  return { net: () => network, events: () => events, logs: () => logs };
}

/** Waits (in D1, so the request limit is not spent) until the desk is done with a job, then reads
 * its outcome from the state route once. */
export async function settle(tk: string, tokenId: string, job: string): Promise<any> {
  for (let i = 0; i < 1000; i += 1) {
    const row = await env.DB.prepare('SELECT status FROM jobs WHERE id = ?').bind(job).first<{ status: string }>();
    if (row !== null && row.status !== 'queued' && row.status !== 'running') {
      const res = await api(`/api/pets/${tokenId}/state?job=${job}`, { token: tk });
      return res.status === 200 ? res.body : res;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the job did not finish');
}

/** The owner sends a line and waits for the pet's answer (or its refusal code). */
export async function say(tk: string, tokenId: string, text: string, mode: 'chat' | 'deep' = 'chat'): Promise<any> {
  const sent = await api(`/api/pets/${tokenId}/thoughts`, { token: tk, body: { text, mode } });
  if (sent.status !== 202) return { sent: sent.status, ...sent.body };
  return settle(tk, tokenId, sent.body.job);
}

/** The input bound (every byte of the messages counted as a token) of a thought that a fresh
 * standard pet would send for this line: a throwaway pet answers it, its request is measured, and
 * the fake's record of calls is cleared. Pets with the same name and character and no history send
 * the same request, so a test can place a limit exactly at the price of that call. A hungry pet
 * speaks with the sleepy mood layer (`Mood rule`), a longer request: `hungry` makes the throwaway one too. */
export async function learnBound(h: Harness, text: string, mode: 'chat' | 'deep' = 'chat', history: string[] = [], hungry = false): Promise<number> {
  const probeOwner = NEAR_ACCOUNT(900);
  h.net().contract.addPet('9000', probeOwner, hungry ? { project_food: (BigInt(env.STARTER_FOOD) / 2n).toString() } : {});
  await seedHistory('9000', history);
  const before = h.net().ai.calls.length;
  await say(await token('did:privy:probe', probeOwner), '9000', text, mode);
  const call = h.net().ai.calls[before]!;
  const enc = new TextEncoder();
  const bound = call.body.messages.reduce((sum, m) => sum + enc.encode(m.content).length, 0);
  h.net().ai.calls.length = 0;
  h.net().ai.signatureRequests.length = 0;
  h.events().length = 0;
  h.logs().length = 0;
  h.net().contract.pets.delete('9000');
  await env.DB.exec("DELETE FROM thoughts WHERE token_id = '9000'");
  await env.DB.exec("DELETE FROM thought_calls WHERE thought_id NOT IN (SELECT id FROM thoughts)");
  await env.DB.exec("DELETE FROM debit_sessions WHERE token_id = '9000'");
  await env.DB.exec("DELETE FROM project_spend");
  return bound;
}

/** Earlier exchanges of a pet (already debited), so that its next request carries a memory: the pet
 * has the lines in the order given, the newest last. */
export async function seedHistory(tokenId: string, replies: string[]): Promise<void> {
  for (const [i, reply] of replies.entries()) {
    await env.DB.prepare(
      "INSERT INTO thoughts (id, token_id, created_at, kind, player_text, reply_text, model, price_yocto, price_usd_micros, payer, status) VALUES (?, ?, ?, 'reply', ?, ?, 'm', '0', 0, 'pet', 'billed')",
    )
      .bind(crypto.randomUUID(), tokenId, 1000 + i, `question ${i}`, reply)
      .run();
  }
}
