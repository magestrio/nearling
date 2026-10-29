import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('GET /health', () => {
  it('answers ok with the version of the Worker that served it', async () => {
    const res = await SELF.fetch('https://example.com/health');
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; version: string; env: string }>();
    expect(body.ok).toBe(true);
    expect(body.version).toBe(env.CF_VERSION_METADATA.id);
    expect(body.env).toBe('dev');
  });
});
