import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, harness } from './helpers/api';
import { addPet, dreamsPage, errand, foodForSearches, noEnergy, owner, OWNER, PAGE_URL, PET, richPet, thoughtsOf } from './helpers/errands';
import { costUsd12 } from '../src/pricing';
import { claimWatch } from '../src/watch/day';
import { runWatch } from '../src/watch/run';
import { utcDay } from '../src/http';
import { vi } from 'vitest';

const h = harness();
const JOB = 'When is the Leonids meteor shower?';
const named = (name: string) => h.events().filter((e) => e.name === name);
/** No event carries the job, the page, the report or the verdict. */
const clean = (words: string[]) => {
  const all = JSON.stringify(h.events());
  for (const word of words) expect(all).not.toContain(word);
};

describe('Errand events data', () => {
  // spec: add-pet-errands › Errand events data › daily watch check
  it('logs only outcome and costs for a paused and a paid quiet check', async () => {
    richPet(h);
    const tk = await owner();
    const target = 'https://science.example.com/meteor';
    await api(`/api/pets/${PET}/watch`, { token: tk, method: 'PUT', body: { target } });
    await noEnergy();
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('skipped');
    expect(named('watch_checked')[0]!.props).toEqual({ outcome: 'paused', cost_usd: 0, price_usd: 0 });
    vi.setSystemTime(new Date(Date.now() + 86_400_000));
    h.net().web.page(target, { body: '<main><p>The peak is in November.</p></main>' });
    h.net().ai.push({ stream: { searches: 1 } }, { content: 'The peak is in November.' });
    expect((await claimWatch(env, PET, Date.now())).kind).toBe('started');
    await runWatch(env, PET, { kind: 'watch', day: utcDay(Date.now()), revision: 1 }, 0);
    expect(named('watch_checked')[1]!.props).toMatchObject({ outcome: 'unchanged', cost_usd: expect.any(Number), price_usd: expect.any(Number) });
    expect(named('watch_checked')[1]!.props.cost_usd as number).toBeGreaterThan(0);
    expect(named('watch_checked')[1]!.props.price_usd as number).toBeGreaterThan(0);
    clean([target, 'The peak is in November']);
  });
  // spec: add-pet-errands › Errand events data › shared job link sent
  // spec: add-pet-errands › Errand events data › shared job link opened
  it('records only form and device dimensions when the browser shares and opens a live link', async () => {
    addPet(h);
    const tk = await owner();
    const made = await api(`/api/pets/${PET}/shared-errands`, { token: tk, body: { form: 'find', job: JOB } });
    expect(made.status).toBe(201);
    const path = `/api/pets/${PET}/errand/${made.body.code}/events`;
    expect((await api(path, { token: tk, body: { kind: 'shared' } })).status).toBe(204);
    expect((await api(path, { body: { kind: 'opened', device: 'phone', inApp: 'telegram' } })).status).toBe(204);
    expect(named('errand_link_shared')).toEqual([{ name: 'errand_link_shared', props: { form: 'find' } }]);
    expect(named('errand_link_opened')).toEqual([{ name: 'errand_link_opened', props: { device: 'phone', in_app: 'telegram' } }]);
    clean([JOB, made.body.code, made.body.url, OWNER]);
    for (const line of h.logs()) {
      for (const privateValue of [JOB, made.body.code, made.body.url, OWNER]) expect(line).not.toContain(privateValue);
    }
  });

  // spec: add-pet-errands › Errand events data › errand sent
  it('logs errand_given with the form of each errand', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 1 } }, { content: 'Found [1].' });
    await errand(tk, 'check', 'Octopuses have three hearts.');
    expect(named('errand_given')).toEqual([{ name: 'errand_given', props: { form: 'check' } }]);
  });

  // spec: add-pet-errands › Errand events data › errand reported
  it('logs the report with the searches, the sources and the time, and the thought with what the pet paid', async () => {
    richPet(h);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 2 }, tokensIn: 13_000, tokensOut: 60 }, { content: 'The peak is in November [1][4].', tokensIn: 900, tokensOut: 140 });
    await errand(tk, 'find', JOB);
    const [reported] = named('errand_reported');
    expect(reported!.props).toEqual({ form: 'find', searches: 2, sources: 2, latency_ms: expect.any(Number), cut: false, project_usd: 0 });
    expect(reported!.props.latency_ms as number).toBeGreaterThanOrEqual(0);
    const [thought] = (await thoughtsOf()).filter((t) => t.kind === 'errand');
    // the searches are in what the pet paid: price_usd is the price, cost_usd the project's cost of tokens and fees
    const [delivered] = named('thought_delivered');
    expect(delivered!.props).toMatchObject({ model: 'cheap', for: 'errand' });
    expect(delivered!.props.price_usd).toBeCloseTo(thought!.price_usd_micros / 1e6, 9);
    const tokens = Number(costUsd12(env, 13_000, 60) + costUsd12(env, 900, 140)) / 1e12;
    expect(delivered!.props.cost_usd).toBeCloseTo(tokens + 2 * Number(env.SEARCH_USD_PER_CALL), 9);
    expect(delivered!.props.cost_usd as number).toBeGreaterThan(0.01);
    clean([JOB, 'The peak is in November', 'Title 1.1']);
  });

  // spec: add-pet-errands › Errand events data › errand reported
  it('reports a read with no search and the one source it read', async () => {
    addPet(h);
    const tk = await owner();
    dreamsPage(h);
    h.net().ai.push({ content: 'Cats dream about birds.' });
    await errand(tk, 'read', PAGE_URL);
    expect(named('errand_reported')[0]!.props).toMatchObject({ form: 'read', searches: 0, sources: 1, cut: false, project_usd: 0 });
    clean([PAGE_URL, 'Cats dream']);
  });

  // spec: add-pet-errands › Errand events data › errand failed
  it('logs why an errand came back without a report, with what the pet paid and no word of the job or the report', async () => {
    richPet(h);
    const tk = await owner();
    // a report that did not come after two searches: the pet paid them
    h.net().ai.push({ stream: { searches: 2 }, tokensIn: 13_000, tokensOut: 60 }, { content: '' });
    await errand(tk, 'find', JOB);
    const [empty] = named('errand_failed');
    expect(empty!.props).toMatchObject({ form: 'find', reason: 'empty', searches: 2, cut: false, project_usd: 0 });
    expect(empty!.props.price_usd as number).toBeGreaterThan(0.012);
    expect(empty!.props.cost_usd as number).toBeCloseTo(Number(costUsd12(env, 13_000, 60)) / 1e12 + 2 * Number(env.SEARCH_USD_PER_CALL), 9);
    // web search down: both causes, nothing paid
    h.events().length = 0;
    h.net().ai.push({ status: 503 });
    await errand(tk, 'find', JOB);
    h.net().ai.push({ stream: { searches: 0 } }, { stream: { searches: 0 } });
    await errand(tk, 'check', JOB);
    const down = named('errand_failed').map((e) => e.props);
    expect(down[0]).toEqual({ form: 'find', reason: 'search_down', cause: 'unreachable', searches: 0, price_usd: 0, cost_usd: 0, cut: false, project_usd: 0 });
    expect(down[1]).toMatchObject({ form: 'check', reason: 'search_down', cause: 'no_search', searches: 0, price_usd: 0, cost_usd: 0, cut: false });
    expect(down[1]!.project_usd as number).toBeGreaterThan(0);
    clean([JOB, 'Title 1.1']);
  });

  // spec: add-pet-errands › Errand events data › errand failed
  it('logs the unreadable end of a read as it is', async () => {
    addPet(h);
    const tk = await owner();
    h.net().web.page(PAGE_URL, { status: 404 });
    await errand(tk, 'read', PAGE_URL);
    expect(named('errand_failed')).toEqual([
      { name: 'errand_failed', props: { form: 'read', reason: 'unreadable', searches: 0, price_usd: 0, cost_usd: 0, cut: false, project_usd: 0 } },
    ]);
  });

  // spec: add-pet-errands › Errand events data › errand reported
  it('says a search was cut, with the project\'s upper bound on it, in the report and never in the pet\'s cost', async () => {
    foodForSearches(h, 1);
    const tk = await owner();
    h.net().ai.push({ stream: { searches: 2 } }, { content: 'One says so [1].', tokensIn: 700, tokensOut: 80 });
    await errand(tk, 'find', JOB);
    const [reported] = named('errand_reported');
    expect(reported!.props).toMatchObject({ searches: 1, cut: true });
    expect(reported!.props.project_usd as number).toBeGreaterThanOrEqual(Number(env.SEARCH_USD_PER_CALL));
    const [delivered] = named('thought_delivered');
    // one search fee and the report's tokens: not the cut call's bound
    expect(delivered!.props.cost_usd as number).toBeLessThan(Number(env.SEARCH_USD_PER_CALL) + 0.001);
  });
});
