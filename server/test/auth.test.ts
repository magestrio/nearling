import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { identify } from '../src/auth';
import { api, harness } from './helpers/api';
import { NEAR_ACCOUNT, token } from './helpers/network';

const h = harness();
const OWNER = NEAR_ACCOUNT(1);
const request = (t: string) => new Request('https://game.test/api/me', { headers: { 'privy-id-token': t } });
/** A key set url of its own: jose keeps a fetched set per url for the isolate. */
const coldEnv = (n: number) => ({ PRIVY_APP_ID: env.PRIVY_APP_ID, PRIVY_JWKS_URL: `${env.PRIVY_JWKS_URL}?cold=${n}` }) as unknown as Pick<Env, 'PRIVY_APP_ID' | 'PRIVY_JWKS_URL'>;

describe('Connection rule', () => {
  // spec: add-pet › Connection rule › сервер недоступен
  it('tells a key set that cannot be had from a bad token: the first is no end of a session', async () => {
    const tk = await token('did:privy:owner', OWNER);
    h.net().jwks.status = 200;
    expect((await identify(request(tk), env)).kind).toBe('session');
    expect((await identify(request('not-a-token'), env)).kind).toBe('invalid');
    expect((await identify(request(await token('did:privy:owner', OWNER, { expiresIn: '-1m' })), env)).kind).toBe('invalid');
    expect((await identify(request(await token('did:privy:owner', OWNER, { audience: 'another-app' })), env)).kind).toBe('invalid');
    // the set is there and has no such key
    expect((await identify(request(await token('did:privy:owner', OWNER, { kid: 'nobody' })), env)).kind).toBe('invalid');
  });

  // spec: add-pet › Connection rule › сервер недоступен
  it('answers 503 with a connection code, not 401, when Privy\'s key set fails', async () => {
    h.net().contract.addPet('5', OWNER);
    for (const status of [500, 0]) {
      h.net().jwks.status = status;
      // a key the isolate's cached set does not hold makes jose fetch the set again
      const res = await api('/api/pets/5', { token: await token('did:privy:owner', OWNER, { kid: `rotated-${status}` }) });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ code: 'auth_unavailable' });
    }
  });

  // spec: add-pet › Connection rule › сервер недоступен
  it('does the same on a cold isolate', async () => {
    h.net().jwks.status = 502;
    const out = await identify(request(await token('did:privy:owner', OWNER)), coldEnv(1));
    expect(out.kind).toBe('unavailable');
  });
});

// Dev only: a Privy test account (the dev build's scripted sign-in) has no Google name; `DEV_TEST_NAME` names it.
describe('the name of a Privy test account on dev', () => {
  const nameFor = async (opts: Parameters<typeof token>[2], devTestName: string | undefined) => {
    const out = await identify(request(await token('did:privy:test', OWNER, opts)), { ...env, DEV_TEST_NAME: devTestName });
    return out.kind === 'session' ? out.session.name : `no session: ${out.kind}`;
  };

  it('names the test email and the test phone by the dev var', async () => {
    expect(await nameFor({ name: null, accounts: [{ type: 'email', address: 'test-4821@privy.io' }] }, 'Maya')).toBe('Maya');
    expect(await nameFor({ name: null, accounts: [{ type: 'phone', phone_number: '+1 555 555 4821' }] }, 'Maya')).toBe('Maya');
    expect(await nameFor({ name: null, accounts: [{ type: 'phone', number: '+15555554821' }] }, 'Maya')).toBe('Maya');
  });

  it('gives no name without the var, as in prod', async () => {
    expect(await nameFor({ name: null, accounts: [{ type: 'email', address: 'test-4821@privy.io' }] }, undefined)).toBeNull();
  });

  it('keeps a Google name and names no ordinary email or phone', async () => {
    expect(await nameFor({ name: 'Sam', accounts: [{ type: 'email', address: 'test-4821@privy.io' }] }, 'Maya')).toBe('Sam');
    expect(await nameFor({ name: null, accounts: [{ type: 'email', address: 'test-4821@gmail.com' }] }, 'Maya')).toBeNull();
    expect(await nameFor({ name: null, accounts: [{ type: 'phone', phone_number: '+1 555 123 4821' }] }, 'Maya')).toBeNull();
  });
});
