import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { forgetStatements } from '../src/pet/forget';
import { claimWatch } from '../src/watch/day';
import { runWatch } from '../src/watch/run';
import { utcDay } from '../src/http';
import { api, harness } from './helpers/api';
import { owner, PET, richPet } from './helpers/errands';

const h = harness();
const target = 'https://science.example.com/meteor';

describe('watch receipt', () => {
  // spec: add-verification › Receipt index data › quiet watch receipt
  // spec: add-verification › Verification flow › watch check receipt
  it('indexes a quiet paid check and keeps its public receipt after Clear memory', async () => {
    richPet(h);
    const tk = await owner();
    expect((await api(`/api/pets/${PET}/watch`, { token: tk, method: 'PUT', body: { target } })).status).toBe(200);
    h.net().web.page(target, { body: '<main><p>The peak is in November.</p></main>' });
    h.net().ai.push({ stream: { searches: 1 } }, { content: 'The peak is in November.' });
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('started');
    const result = await runWatch(env, PET, { kind: 'watch', day: utcDay(Date.now()), revision: 1 }, 0);
    expect('thoughtId' in result).toBe(true);
    if (!('thoughtId' in result)) return;
    const indexed = await api(`/api/verification/pets/${PET}`);
    expect(indexed.body.thoughts[0]).toMatchObject({ id: result.thoughtId, status: 'billed', withoutReply: false });
    const selected = await api(`/api/verification/pets/${PET}/thoughts/${result.thoughtId}`, { token: tk });
    expect(selected.body).toMatchObject({ kind: 'watch', status: 'billed', viewer: 'owner',
      priceYocto: result.price, form: 'find', searches: 1 });
    expect(selected.body.calls.map((call: { label: string }) => call.label)).toEqual(['search', 'report']);
    expect(selected.body.privateCalls).toHaveLength(2);
    await env.DB.prepare("UPDATE watch_checks SET pending_content = 'private observation', pending_sources = '[\"https://example.com\"]', pending_result = 'changed' WHERE token_id = ?")
      .bind(PET).run();
    await env.DB.batch(forgetStatements(env.DB, PET, Date.now()));
    expect((await env.DB.prepare('SELECT pending_content, pending_sources, pending_result FROM watch_checks WHERE token_id = ?').bind(PET).first())).toEqual({ pending_content: null, pending_sources: null, pending_result: null });
    const erased = await api(`/api/verification/pets/${PET}/thoughts/${result.thoughtId}`, { token: tk });
    expect(erased.body).toMatchObject({ status: 'billed', erased: true, viewer: 'owner' });
    expect(erased.body).not.toHaveProperty('playerText');
    expect(erased.body).not.toHaveProperty('replyText');
    expect(erased.body.privateCalls).toBeUndefined();
    expect(erased.body.calls).toHaveLength(2);
    expect((await api(`/api/verification/pets/${PET}`)).body.thoughts[0]).toMatchObject({ id: result.thoughtId, erased: true });
  });
});
