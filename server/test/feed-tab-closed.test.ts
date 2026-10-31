// The tab goes while a route is spending: the runtime cancels a request with its client, so a route
// that sends or settles keeps its work with `waitUntil`, and what it started ends the way it would
// have (`Feeding outcome rule` › «closed on its way»). A test cannot cut the connection: it holds the
// execution context the runtime would keep alive and looks at what was handed to it, while the call
// is still on the network.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { keyedPlayer, NEAR_ACCOUNT, token } from './helpers/network';
import worker from '../src/index';

const h = harness();
const NEAR = 10n ** 24n;
const MILLI = 10n ** 21n;
const OWNER = NEAR_ACCOUNT(71);

let ip = 0;

/** One request through the Worker with an execution context the test can look into. */
function call(path: string, tk: string, body?: unknown) {
  const kept: Promise<unknown>[] = [];
  const ctx = { waitUntil: (work: Promise<unknown>) => kept.push(work), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
  ip += 1;
  const request = new Request(`https://game.test${path}`, {
    method: body === undefined && path.endsWith('/feed') ? 'GET' : 'POST',
    headers: { 'privy-id-token': tk, 'cf-connecting-ip': `203.0.113.${ip}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { kept, answered: () => worker.fetch(request as never, env, ctx) };
}

async function asleepPet() {
  h.net().contract.addPet('7', OWNER, { project_food: '0' });
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx, slept_at) VALUES (?, ?, 1, ?, 1)').bind('7', OWNER, '').run();
}
async function player(balance = NEAR) {
  const p = keyedPlayer();
  h.net().contract.balances.set(p.account, balance);
  const tk = await token(`did:privy:${p.account}`, p.account);
  await env.DB.prepare('UPDATE players SET first_name = ? WHERE account_id = ?').bind('Maya', p.account).run();
  return { ...p, token: tk };
}
const rows = async (sql: string) => (await env.DB.prepare(sql).all<any>()).results;

describe('a tab closed on the way', () => {
  // spec: add-feeding › Feeding outcome rule › closed on its way × the tab closed
  it('leaves a friend\'s snack running: the work is held before the call leaves, and it settles whole', async () => {
    await asleepPet();
    const p = await player();
    const snack = call('/api/pets/7/snack', p.token);
    let heldAtTheSend = 0;
    h.net().contract.meanwhile.send_tx = async () => {
      heldAtTheSend = snack.kept.length;
    };
    await snack.answered();
    expect(heldAtTheSend).toBe(1);
    await Promise.all(snack.kept);
    expect(await rows('SELECT * FROM feedings')).toEqual([]);
    expect(await rows('SELECT account FROM known_index')).toEqual([{ account: p.account }]);
    expect(h.events().filter((e) => e.name === 'pet_fed')).toHaveLength(1);
  });

  // spec: add-feeding › Feeding outcome rule › closed on its way × the tab closed
  it('leaves a signed portion running to its settlement', async () => {
    await asleepPet();
    const p = await player();
    const built = await api('/api/pets/7/feed', { token: p.token, body: { portion: '0.01' } });
    const send = call('/api/pets/7/feed/send', p.token, await p.sign(built.body.tx));
    let heldAtTheSend = 0;
    h.net().contract.meanwhile.send_tx = async () => {
      heldAtTheSend = send.kept.length;
    };
    await send.answered();
    expect(heldAtTheSend).toBe(1);
    await Promise.all(send.kept);
    expect(h.events().filter((e) => e.name === 'pet_fed')).toHaveLength(1);
  });

  // spec: add-feeding › Feeding gas data › запас газа доложен × the tab closed
  it('leaves the top-up running once it is claimed: a claim never stands without its transfer', async () => {
    await asleepPet();
    const p = await player(10n * MILLI);
    const build = call('/api/pets/7/feed', p.token, { portion: '0.01' });
    let heldAtTheSend = 0;
    h.net().contract.meanwhile.send_tx = async () => {
      heldAtTheSend = build.kept.length;
    };
    await build.answered();
    expect(heldAtTheSend).toBe(1);
    expect(h.net().contract.sends.filter((s) => s.method === 'transfer')).toHaveLength(1);
  });

  // spec: add-feeding › Feeding outcome rule › closed on its way × the tab closed
  it('leaves a settlement that the outcome route or the sheet started running to its end', async () => {
    await asleepPet();
    const p = await player();
    const built = await api('/api/pets/7/feed', { token: p.token, body: { portion: '0.01' } });
    h.net().contract.mode = 'executed-but-silent';
    const first = await api('/api/pets/7/feed/send', { token: p.token, body: await p.sign(built.body.tx) });
    h.net().contract.mode = 'normal';

    const asked = call('/api/pets/7/feed/outcome', p.token, { id: first.body.hash, source: 'near' });
    await asked.answered();
    expect(asked.kept).toHaveLength(1);
    await Promise.all(asked.kept);
    expect(h.events().filter((e) => e.name === 'pet_fed')).toHaveLength(1);

    const again = await player();
    const next = await api('/api/pets/7/feed', { token: again.token, body: { portion: '0.01' } });
    h.net().contract.mode = 'executed-but-silent';
    await api('/api/pets/7/feed/send', { token: again.token, body: await again.sign(next.body.tx) });
    h.net().contract.mode = 'normal';
    const sheet = call('/api/pets/7/feed', again.token);
    await sheet.answered();
    expect(sheet.kept).toHaveLength(1);
    await Promise.all(sheet.kept);
    expect(h.events().filter((e) => e.name === 'pet_fed')).toHaveLength(2);
  });
});
