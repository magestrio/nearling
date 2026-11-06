// One bounded search, then a named public observation. A prior observation never leaves D1.
import { publicAccountState } from '../chain';
import { numberResults, searchCallMessages } from '../errands/search';
import { publicHost, readPage } from '../errands/reader';
import { SEARCH_OUT_BOUND } from '../errands/price';
import { streamCall, type StreamResult } from '../nearai';
import type { WatchKind } from './target';

export interface NamedObservation { namedContent: string; sourceUrls: string[] }
export type SourceRead =
  | { kind: 'ok'; observation: NamedObservation; search: StreamResult }
  | { kind: 'blocked' | 'unreadable' | 'search_failed'; search?: StreamResult };

function releaseRepo(target: string): { owner: string; repo: string } | null {
  const match = /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/releases(?:\/tag\/[\w.-]+)?)?\/?(?:\?.*)?$/i.exec(target)
    ?? /^([\w.-]+)\/([\w.-]+) releases$/i.exec(target);
  return match === null ? null : { owner: match[1]!, repo: match[2]! };
}

function normalized(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

const common = new Set(['about', 'after', 'before', 'from', 'have', 'into', 'with', 'this', 'that', 'they', 'their', 'there', 'when', 'what', 'will', 'your', 'more', 'news', 'latest', 'page']);
function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((word) => !common.has(word)));
}

/** Page sentences tied to the named topic or the search result's sourced excerpt. */
function topicFacts(pageText: string, target: string, excerpt: string): string[] {
  const named = terms(target);
  const cited = terms(excerpt);
  return pageText.split(/\n+|(?<=[.!?])\s+(?=[\p{Lu}\p{N}])/u)
    .map(normalized).filter((line) => line !== '' && !/^(?:ad(?:vertisement)?|sponsored|clock|updated|published|subscribe|sign up)\b/i.test(line))
    .filter((line) => {
      const words = terms(line);
      const namedHits = [...named].filter((word) => words.has(word)).length;
      const citedHits = [...cited].filter((word) => words.has(word)).length;
      return namedHits >= 1 || citedHits >= 2;
    });
}

/** Only content tied to the named source is compared; result order and incidental page chrome are omitted. */
export function sameObservation(a: NamedObservation, b: NamedObservation): boolean {
  // Topic observations carry a source URL above each attributable fact. A different search
  // ranking may cite another page with the same fact; a URL alone is not a named change.
  const facts = (value: string) => value.replace(/^https?:\/\/[^\n]+\n/gm, '').trim();
  return facts(a.namedContent) === facts(b.namedContent);
}

async function fromGithub(target: string, items: ReturnType<typeof numberResults>): Promise<NamedObservation | null> {
  const repo = releaseRepo(target) ?? items.map((item) => releaseRepo(item.url)).find((found) => found !== null) ?? null;
  if (repo === null) return null;
  // GitHub's /latest excludes prereleases and orders by commit creation time. A watch follows
  // published release objects, so use the bounded public list and pick its newest publication.
  const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/releases?per_page=10`;
  try {
    const response = await fetch(url, { redirect: 'manual', headers: { accept: 'application/vnd.github+json', 'user-agent': 'Nearling' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok || (response.headers.get('content-length') !== null && Number(response.headers.get('content-length')) > 1_000_000)) return null;
    if (response.body === null) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1_000_000) { await reader.cancel(); return null; }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const raw = new TextDecoder().decode(bytes);
    const releases = JSON.parse(raw) as unknown;
    if (!Array.isArray(releases)) return null;
    const release = releases.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && item.draft === false && typeof item.published_at === 'string')
      .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0];
    if (release === undefined) return null;
    if (typeof release.id !== 'number' || typeof release.tag_name !== 'string' || typeof release.name !== 'string' || typeof release.body !== 'string' || !Array.isArray(release.assets)) return null;
    const assets = release.assets.map((asset) => typeof asset === 'object' && asset !== null && 'id' in asset ? asset.id : null).filter((id): id is number => typeof id === 'number').sort((a, b) => a - b);
    return { namedContent: JSON.stringify({ id: release.id, tag: release.tag_name, name: release.name, body: release.body.slice(0, 30_000), assets }), sourceUrls: [url] };
  } catch { return null; }
}

async function fromAccount(env: Env, target: string): Promise<NamedObservation | null> {
  try {
    const state = await publicAccountState(env, target);
    return { namedContent: JSON.stringify({ amount: String(state.amount), locked: String(state.locked), code_hash: String(state.code_hash), storage_usage: state.storage_usage }), sourceUrls: [] };
  } catch { return null; }
}

async function fromPage(target: string): Promise<NamedObservation | 'blocked' | null> {
  try {
    const url = new URL(target);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !(await publicHost(url.hostname))) return 'blocked';
    const page = await readPage(target, true);
    return page.kind === 'ok' ? { namedContent: normalized(page.text), sourceUrls: [target] } : page.kind === 'blocked' ? 'blocked' : null;
  } catch { return 'blocked'; }
}

async function fromTopic(target: string, items: ReturnType<typeof numberResults>): Promise<NamedObservation | null> {
  const facts: string[] = [];
  const urls: string[] = [];
  for (const item of items.slice(0, 5)) {
    const page = await readPage(item.url, true);
    if (page.kind !== 'ok') continue;
    const attributable = topicFacts(page.text, target, `${item.title} ${item.text}`);
    if (attributable.length === 0) continue;
    // A source URL identifies its facts. The output order of search results does not.
    facts.push(`${item.url}\n${attributable.join('\n').slice(0, 12_000)}`);
    urls.push(item.url);
  }
  if (facts.length === 0) return null;
  return { namedContent: facts.sort().join('\n'), sourceUrls: urls.sort() };
}

export async function observeWatch(env: Env, kind: WatchKind, target: string, suppliedSearch?: StreamResult): Promise<SourceRead> {
  // A blocked address must never reach a network call, including the search provider.
  if (kind === 'page') {
    try {
      const url = new URL(target);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !(await publicHost(url.hostname))) return { kind: 'blocked' };
    } catch { return { kind: 'blocked' }; }
  }
  const search = suppliedSearch ?? await streamCall(env, { messages: searchCallMessages(target), maxTokens: SEARCH_OUT_BOUND, timeoutMs: 60_000, allowance: 1 });
  if (search.kind !== 'finished' || search.searches.length === 0) return { kind: 'search_failed', search };
  let observation: NamedObservation | 'blocked' | null;
  if (kind === 'release') observation = await fromGithub(target, numberResults(search.searches));
  else if (kind === 'account') observation = await fromAccount(env, target);
  else if (kind === 'page') observation = await fromPage(target);
  else observation = await fromTopic(target, numberResults(search.searches));
  if (observation === 'blocked') return { kind: 'blocked', search };
  return observation === null ? { kind: 'unreadable', search } : { kind: 'ok', observation, search };
}
