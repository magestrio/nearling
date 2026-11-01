// The items a pet earns (`add-wardrobe` › groups 6.1–6.3): the Thinking cap for the first solved riddle,
// counted at the reveal and written by `pet/grant.ts` until it lands, and the streak items, whose event the
// mark's writer fires (`pet/mark.ts`). The client's notice is `web/e2e/wardrobe-notice.spec.ts`.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { OUTFIT_GRANT_TGAS } from '../src/chain';
import { clean, outfits, tick } from '../src/cron';
import { writeDueGrant } from '../src/pet/grant';
import { writeDueMark } from '../src/pet/mark';
import { finishReveal, riddleTick } from '../src/riddle/cron';
import { clearPause, setPause } from '../src/servicePause';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const OTHER = NEAR_ACCOUNT(2);
const owner = () => token('did:privy:owner', OWNER);
const DAY_MS = 86_400_000;
const DAY = Math.floor(Date.UTC(2036, 10, 4) / DAY_MS);
const at = (hh: number, mm: number, ss = 0, day = DAY) => {
  const t = day * DAY_MS + ((hh * 60 + mm) * 60 + ss) * 1000;
  vi.setSystemTime(t);
  return t;
};

const chainPet = (id = '7') => h.net().contract.pets.get(id)!;
const grantSends = () => h.net().contract.sends.filter((s) => s.method === 'outfit_grant');
const earned = (via: string) => h.events().filter((e) => e.name === 'outfit_earned' && e.props.via === via);
const grantRows = () => env.DB.prepare('SELECT * FROM outfit_grants').all<any>().then((r) => r.results);

/** A riddle of `day`, sealed and not revealed, and the answers of pets to it. */
async function riddle(day: number) {
  await env.DB.prepare('INSERT INTO riddles (day, text, answers, salt, hash, sealed_at) VALUES (?, ?, ?, ?, ?, 1)').bind(day, 'r', '["a clock"]', 's', 'h').run();
}
async function answered(tokenId: string, day: number, correct: boolean) {
  await env.DB.prepare('INSERT INTO riddle_answers (token_id, day, text, correct, answered_at) VALUES (?, ?, ?, ?, 1)').bind(tokenId, day, 'a clock', correct ? 1 : 0).run();
}
const answerRow = (tokenId: string, day: number) => env.DB.prepare('SELECT text, correct FROM riddle_answers WHERE token_id = ? AND day = ?').bind(tokenId, day).first<{ text: string; correct: number }>();

describe('Earned outfit flow: the riddle\'s item', () => {
  // spec: add-wardrobe › Earned outfit flow › наряд за загадки
  it('counts a right answer at the reveal, sends outfit_grant in the same minute and fires outfit_earned once', async () => {
    h.net().contract.fundRiddles();
    h.net().contract.addPet('7', OWNER);
    at(0, 1);
    await riddleTick(env, at(0, 1));
    // the owner answers rightly; the riddle of the day is revealed at the first tick of the next one
    await answered('7', DAY, true);
    h.net().contract.burnt = '1000000000000000000000';
    await tick(env, at(0, 1, 0, DAY + 1));

    expect((await env.DB.prepare('SELECT revealed_at FROM riddles WHERE day = ?').bind(DAY).first<any>()).revealed_at).not.toBeNull();
    expect(grantSends()).toHaveLength(1);
    expect(grantSends()[0]).toMatchObject({ args: { token_id: '7' }, gas: (OUTFIT_GRANT_TGAS * 10n ** 12n).toString(), deposit: '0', signer: env.SERVER_ACCOUNT_ID });
    expect(chainPet().outfits).toEqual([2]);
    expect(await grantRows()).toEqual([]);
    expect(earned('riddle')).toEqual([{ name: 'outfit_earned', props: { via: 'riddle' } }]);
    // the owner's view carries the notice
    expect((await api('/api/pets/7', { token: await owner() })).body).toMatchObject({ outfits: ['thinking-cap'], notices: ['thinking-cap'], worn: null });
    // the gas of the send is the project's
    const spend = await env.DB.prepare("SELECT usd_micros FROM project_spend WHERE kind = 'gas'").all<any>();
    expect(spend.results.length).toBeGreaterThanOrEqual(1);
    // the next minute sends nothing more
    await tick(env, at(0, 2, 0, DAY + 1));
    expect(grantSends()).toHaveLength(1);
    expect(earned('riddle')).toHaveLength(1);
  });

  // spec: add-wardrobe › Earned outfit flow › наряд за загадки × a wrong answer
  it('adds nothing for a wrong answer', async () => {
    h.net().contract.addPet('7', OWNER);
    await riddle(DAY);
    await answered('7', DAY, false);
    await finishReveal(env, DAY, at(0, 1, 0, DAY + 1), null);
    expect(await grantRows()).toEqual([]);
    await outfits(env, Date.now());
    expect(grantSends()).toEqual([]);
    expect(chainPet().outfits).toEqual([]);
  });

  // spec: add-wardrobe › Earned outfit flow › наряд за загадки × the owner never came
  it('adds nothing for a pet whose owner did not answer', async () => {
    h.net().contract.addPet('7', OWNER);
    await riddle(DAY);
    await finishReveal(env, DAY, at(0, 1, 0, DAY + 1), null);
    expect(await grantRows()).toEqual([]);
    await outfits(env, Date.now());
    expect(grantSends()).toEqual([]);
  });

  // spec: add-wardrobe › Earned outfit flow › наряд за загадки × a second solved riddle
  it('reads the chain for a second solved riddle: no send, no event', async () => {
    h.net().contract.addPet('7', OWNER, { outfits: [2] });
    await riddle(DAY);
    await answered('7', DAY, true);
    await finishReveal(env, DAY, at(0, 1, 0, DAY + 1), null);
    expect(await grantRows()).toHaveLength(1);
    await outfits(env, Date.now());
    expect(await grantRows()).toEqual([]);
    expect(grantSends()).toEqual([]);
    expect(earned('riddle')).toEqual([]);
    expect(chainPet().outfits).toEqual([2]);
  });

  // spec: add-wardrobe › Earned outfit flow › наряд за загадки × a clear of the memory after the reveal
  it('keeps a counted answer through a clear of the memory: the grant goes out, the words are gone', async () => {
    h.net().contract.addPet('7', OWNER);
    await riddle(DAY);
    await answered('7', DAY, true);
    await finishReveal(env, DAY, at(0, 1, 0, DAY + 1), null);
    expect(await grantRows()).toHaveLength(1);
    expect((await api('/api/pets/7/memory/clear', { token: await owner(), body: {} })).status).toBe(200);
    expect(await answerRow('7', DAY)).toBeNull();
    expect(await grantRows()).toHaveLength(1);

    await outfits(env, Date.now());
    expect(chainPet().outfits).toEqual([2]);
    expect(earned('riddle')).toHaveLength(1);
  });

  // spec: add-wardrobe › Earned outfit flow › наряд за загадки × a reveal after the end of the next day
  it('counts a right answer revealed after its text went, from the verdict it kept', async () => {
    h.net().contract.addPet('7', OWNER);
    await riddle(DAY);
    await answered('7', DAY, true);
    // the end of the next day has passed and the riddle is still not revealed
    const late = at(10, 0, 0, DAY + 2);
    await clean(env, late);
    expect(await answerRow('7', DAY)).toEqual({ text: '', correct: 1 });
    expect((await env.DB.prepare('SELECT revealed_at FROM riddles WHERE day = ?').bind(DAY).first<any>()).revealed_at).toBeNull();
    expect(await grantRows()).toEqual([]);

    await finishReveal(env, DAY, late, null);
    expect(await grantRows()).toHaveLength(1);
    await outfits(env, late);
    expect(chainPet().outfits).toEqual([2]);
    expect(earned('riddle')).toHaveLength(1);
    // once revealed, the row goes at the next cleaning, as every revealed riddle's does
    await clean(env, late);
    expect(await answerRow('7', DAY)).toBeNull();
  });

  // spec: add-wardrobe › Earned outfit flow › наряд за загадки × a riddle never revealed
  it('gives nothing for a riddle that is never revealed, and keeps its verdict meanwhile', async () => {
    h.net().contract.addPet('7', OWNER);
    await riddle(DAY);
    await answered('7', DAY, true);
    await clean(env, at(10, 0, 0, DAY + 6));
    await outfits(env, Date.now());
    expect(await answerRow('7', DAY)).toEqual({ text: '', correct: 1 });
    expect(await grantRows()).toEqual([]);
    expect(grantSends()).toEqual([]);
    expect(earned('riddle')).toEqual([]);
  });

  // spec: add-wardrobe › Earned outfit flow › наряд за загадки × the pet given away before the reveal
  it('writes the item to the pet, whoever owns it by then: the new owner gets the item and the notice', async () => {
    h.net().contract.addPet('7', OWNER);
    await riddle(DAY);
    await answered('7', DAY, true);
    chainPet().owner_id = OTHER;
    await finishReveal(env, DAY, at(0, 1, 0, DAY + 1), null);
    await outfits(env, Date.now());
    expect(h.net().contract.grants).toEqual([{ token_id: '7' }]);
    expect((await api('/api/pets/7', { token: await token('did:privy:other', OTHER) })).body).toMatchObject({ outfits: ['thinking-cap'], notices: ['thinking-cap'] });
    // the old owner is a guest: the model's worn item and nothing of the wardrobe
    expect((await api('/api/pets/7', { token: await owner() })).body.notices).toBeUndefined();
  });
});

describe('Earned outfit flow: a grant written later', () => {
  async function waiting() {
    h.net().contract.addPet('7', OWNER);
    await riddle(DAY);
    await answered('7', DAY, true);
    await finishReveal(env, DAY, at(0, 1, 0, DAY + 1), null);
  }

  // spec: add-wardrobe › Earned outfit flow › выдача записана позже × the gas pause
  it('waits for the gas pause to lift and is sent after it; the pause of NEAR AI does not stop it', async () => {
    await waiting();
    await setPause(env.DB, 'gas', Date.now());
    expect(await writeDueGrant(env, '7')).toBe('paused');
    expect(grantSends()).toEqual([]);
    expect(await grantRows()).toHaveLength(1);

    await clearPause(env.DB);
    await setPause(env.DB, 'ai', Date.now());
    expect(await writeDueGrant(env, '7')).toBe('written');
    expect(chainPet().outfits).toEqual([2]);
    expect(earned('riddle')).toHaveLength(1);
  });

  // spec: add-wardrobe › Earned outfit flow › выдача записана позже × a send that failed
  it('sends again after a send that failed, and fires the event when it lands', async () => {
    await waiting();
    h.net().contract.grantFails = 'outfit_too_early';
    expect(await writeDueGrant(env, '7')).toBe('failed');
    expect(h.logs()).toContain('outfit_grant_failed:outfit_too_early');
    expect(await grantRows()).toMatchObject([{ token_id: '7', sending_at: null, tried: 1 }]);
    expect(earned('riddle')).toEqual([]);
    expect(chainPet().outfits).toEqual([]);

    h.net().contract.grantFails = null;
    expect(await writeDueGrant(env, '7')).toBe('written');
    expect(grantSends()).toHaveLength(2);
    expect(await grantRows()).toEqual([]);
    expect(earned('riddle')).toHaveLength(1);
    expect(chainPet().outfits).toEqual([2]);
  });

  // spec: add-wardrobe › Earned outfit flow › выдача записана позже × the outcome lost, then found
  it('finds an item whose answer was lost on the chain, sends no second time and fires the event once', async () => {
    await waiting();
    h.net().contract.mode = 'executed-but-silent';
    expect(await writeDueGrant(env, '7')).toBe('failed');
    expect(h.logs()).toContain('outfit_grant_unknown');
    h.net().contract.mode = 'normal';
    expect(chainPet().outfits).toEqual([2]);
    expect(earned('riddle')).toEqual([]);
    expect(await grantRows()).toMatchObject([{ tried: 1, sending_at: null }]);

    expect(await writeDueGrant(env, '7')).toBe('found');
    expect(grantSends()).toHaveLength(1);
    expect(await grantRows()).toEqual([]);
    expect(earned('riddle')).toHaveLength(1);
    expect(await writeDueGrant(env, '7')).toBe('idle');
    expect(earned('riddle')).toHaveLength(1);
  });

  // spec: add-wardrobe › Earned outfit flow › выдача записана позже × the outcome lost, then found
  it('leaves the row when the chain cannot be read, and takes a claim of another writer as busy', async () => {
    await waiting();
    h.net().contract.down = true;
    expect(await writeDueGrant(env, '7')).toBe('unreadable');
    h.net().contract.down = false;
    expect(await grantRows()).toMatchObject([{ tried: 0, sending_at: null }]);
    await env.DB.prepare('UPDATE outfit_grants SET sending_at = ?').bind(Date.now() - 1_000).run();
    expect(await writeDueGrant(env, '7')).toBe('busy');
    expect(grantSends()).toEqual([]);
    // a claim older than a minute belongs to a writer that is gone
    await env.DB.prepare('UPDATE outfit_grants SET sending_at = ?').bind(Date.now() - 61_000).run();
    expect(await writeDueGrant(env, '7')).toBe('written');
  });
});

// ---------------------------------------------------------------------------------------------
// The streak items: the contract writes them with the mark; the writer fires the event.

async function markPet(chain: { streak?: number; freezes?: number; last?: number | null; outfits?: number[] }) {
  h.net().contract.addPet('1', OWNER, { streak: chain.streak ?? 0, freezes: chain.freezes ?? 1, last_streak_day: chain.last ?? null, outfits: chain.outfits ?? [] });
  await env.DB.prepare('INSERT INTO pets (token_id, hatched_by, born_at, birth_tx) VALUES (?, ?, ?, ?)').bind('1', OWNER, 1, '').run();
  await env.DB.prepare('INSERT OR IGNORE INTO ritual_clock (id, closed_day) VALUES (1, ?)').bind(DAY - 1).run();
}
const ended = (day: number) => env.DB.prepare('INSERT INTO ritual_days (token_id, day, completed_at, excused) VALUES (?, ?, ?, 0)').bind('1', day, day * DAY_MS + 3_600_000).run();

describe('Earned outfit flow: the streak\'s item', () => {
  // spec: add-wardrobe › Earned outfit flow › наряд за серию
  it('fires outfit_earned via streak once when the mark brings the first day, and again at the third', async () => {
    await markPet({});
    await ended(DAY);
    at(10, 0);
    expect(await writeDueMark(env, '1')).toBe('written');
    expect(h.net().contract.pets.get('1')!.outfits).toEqual([0]);
    expect(earned('streak')).toEqual([{ name: 'outfit_earned', props: { via: 'streak' } }]);

    // the second day: no item; the third: the scarf
    for (const day of [DAY + 1, DAY + 2]) {
      at(10, 0, 0, day);
      await env.DB.prepare('UPDATE ritual_clock SET closed_day = ? WHERE id = 1').bind(day - 1).run();
      await ended(day);
      expect(await writeDueMark(env, '1')).toBe('written');
    }
    expect(h.net().contract.pets.get('1')!.streak).toBe(3);
    expect(h.net().contract.pets.get('1')!.outfits).toEqual([0, 1]);
    expect(earned('streak')).toHaveLength(2);
  });

  // spec: add-wardrobe › Earned outfit flow › наряд за серию × the outcome lost, then found
  it('fires the event once when a mark whose answer was lost is found on the chain', async () => {
    await markPet({});
    await ended(DAY);
    at(10, 0);
    h.net().contract.mode = 'executed-but-silent';
    expect(await writeDueMark(env, '1')).toBe('failed');
    h.net().contract.mode = 'normal';
    expect(h.net().contract.pets.get('1')!.outfits).toEqual([0]);
    expect(earned('streak')).toEqual([]);

    expect(await writeDueMark(env, '1')).toBe('found');
    expect(earned('streak')).toHaveLength(1);
    expect(h.net().contract.sends.filter((s) => s.method === 'streak_mark')).toHaveLength(1);
    expect(await writeDueMark(env, '1')).toBe('idle');
    expect(earned('streak')).toHaveLength(1);
  });

  // spec: add-wardrobe › Earned outfit flow › наряд за серию
  it('fires nothing when the threshold is passed again: the streak starts over and the crown is there', async () => {
    await markPet({ streak: 5, freezes: 0, last: DAY - 4, outfits: [0, 1] });
    await ended(DAY);
    at(10, 0);
    expect(await writeDueMark(env, '1')).toBe('written');
    expect(h.net().contract.pets.get('1')!.streak).toBe(1);
    expect(earned('streak')).toEqual([]);
    expect(h.events().some((e) => e.name === 'streak_reset')).toBe(true);
    expect(h.net().contract.pets.get('1')!.outfits).toEqual([0, 1]);
  });
});
