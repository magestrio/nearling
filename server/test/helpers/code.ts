// What the tests of a skill's code share (`add-pet-errands` › group 8): a module that declares functions the way
// `Skill code data` › «functions declared» says, the routes, and a version id that never repeats (the loader keeps an
// isolate by its id, so two tests with one id would run the first test's code).
import { env } from 'cloudflare:workers';
import { api } from './api';
import { PET } from './sources';

export const CODE = `
export const functions = {
  add: { description: "Adds two numbers", params: { a: "number", b: "number" } },
  whole: { description: "Counts", params: { n: "integer" } },
  signFor: { description: "A sign", params: { sign: ["Aries", "Leo"], who: "symbol", on: "boolean" } },
  rawFeed: { description: "Whatever the archive has", params: { query: "text" } },
};
export function add(a, b) { return { sum: a + b }; }
export function whole(n) { return { n, kind: typeof n }; }
export function signFor(sign, who, on) { return { sign, who, on }; }
export function rawFeed(query) { return { query }; }
export function ghost() { return "never declared"; }
export function boom() { throw new Error("the stars fell"); }
`;

let counter = 0;
export const versionId = () => `v${(counter += 1)}:${Date.now()}`;

export const testRun = (tk: string, body: { code?: unknown; fn?: unknown; values?: unknown }, id = PET) => api(`/api/pets/${id}/code/test`, { token: tk, body });
export const saveCode = (tk: string, body: { code?: unknown; ticks?: unknown }, id = PET) => api(`/api/pets/${id}/code`, { method: 'PUT', token: tk, body });
export const getCode = (tk?: string, id = PET) => api(`/api/pets/${id}/code`, { token: tk });
export const removeCode = (tk?: string, id = PET) => api(`/api/pets/${id}/code`, { method: 'DELETE', token: tk });

export const testsToday = async (id = PET) =>
  (await env.DB.prepare('SELECT runs, passed_hash FROM code_tests WHERE token_id = ? ORDER BY day DESC').bind(id).first<{ runs: number; passed_hash: string | null }>()) ?? { runs: 0, passed_hash: null };
export const versionRows = async () => (await env.DB.prepare('SELECT * FROM code_versions ORDER BY day, version').all<{ day: number; version: string }>()).results;
export const spendRows = async (kind: string) => (await env.DB.prepare('SELECT * FROM project_spend WHERE kind = ?').bind(kind).all<{ usd_micros: number }>()).results;
export const codeRow = async (id = PET) => env.DB.prepare('SELECT * FROM skill_code WHERE token_id = ?').bind(id).first<any>();

export async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
