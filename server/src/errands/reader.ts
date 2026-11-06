// The link reader of «Read this» (`Link reader data`, `Read this flow`): the server fetches the page, never the
// browser, from a public address only — before the first request and before each of ≤ 3 redirects — with no cookie,
// no referrer and no player id, ≤ 10 s, ≤ 5 MB, text or HTML only, read as text. Defence in depth: the fetch resolves
// the host again itself (a rebinding the check cannot see), and Cloudflare's egress reaches no private network of ours.
import { READ_LIMIT_TOKENS } from './price';

export type ReadResult = { kind: 'ok'; text: string } | { kind: 'unreadable' } | { kind: 'too_long' } | { kind: 'blocked' };

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const enc = new TextEncoder();

/** The page's tokens at a token per four bytes of UTF-8, rounded up (`Read this flow`: ≈ 8,000 tokens). */
export const tokensOf = (text: string): number => Math.ceil(enc.encode(text).length / 4);

/** What counts as a link the server fetches: the trimmed field is one `http://` or `https://` URL with no whitespace.
 * Anything else, a bare `example.com` included, is text read as is (`Read this flow`). */
export function linkOf(field: string): string | null {
  const trimmed = field.trim();
  return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null;
}

// ---------------------------------------------------------------------------------------------
// Addresses.

function ipv4Bytes(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (m === null) return null;
  const bytes = m.slice(1).map(Number);
  return bytes.every((b) => b <= 255) ? bytes : null;
}

/** An IPv6 address as 16 bytes, or null. Handles `::`, an embedded dotted IPv4 and the hex form of the WHATWG URL. */
function ipv6Bytes(text: string): number[] | null {
  let rest = text.toLowerCase();
  const zone = rest.indexOf('%');
  if (zone !== -1) rest = rest.slice(0, zone);
  let tail: number[] = [];
  const dot = rest.lastIndexOf(':');
  const v4 = dot === -1 ? null : ipv4Bytes(rest.slice(dot + 1));
  if (v4 !== null) {
    tail = v4;
    rest = `${rest.slice(0, dot + 1)}0:0`;
  }
  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const n = parseInt(group, 16);
      out.push(n >> 8, n & 255);
    }
    return out;
  };
  const head = parse(halves[0]!);
  const back = halves.length === 2 ? parse(halves[1]!) : [];
  if (head === null || back === null) return null;
  let bytes: number[];
  if (halves.length === 2) {
    const fill = 16 - head.length - back.length;
    if (fill < 0) return null;
    bytes = [...head, ...new Array<number>(fill).fill(0), ...back];
  } else {
    bytes = head;
  }
  if (bytes.length !== 16) return null;
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

function privateV4(b: number[]): boolean {
  const [a, c] = [b[0]!, b[1]!];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && c >= 64 && c <= 127) ||
    (a === 169 && c === 254) ||
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 168) ||
    a >= 224
  );
}

/** Whether an address text (IPv4 or IPv6 literal) is not a public one. An address that does
 * not parse is treated as private: nothing unknown is fetched. */
export function isPrivateAddress(text: string): boolean {
  const v4 = ipv4Bytes(text);
  if (v4 !== null) return privateV4(v4);
  const b = ipv6Bytes(text.replace(/^\[|\]$/g, ''));
  if (b === null) return true;
  if (b.every((x) => x === 0)) return true; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10
  if (b[0] === 0xff) return true; // multicast
  // ::ffff:a.b.c.d and the older ::a.b.c.d carry an IPv4 address; so does the NAT64 prefix 64:ff9b::/96
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return privateV4(b.slice(12));
  if (b.slice(0, 12).every((x) => x === 0)) return privateV4(b.slice(12));
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return privateV4(b.slice(12));
  return false;
}

const METADATA_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal']);

/** Whether `host` is one the server may fetch: a public literal or a name outside the blocked host families.
 * The fetch resolves names; no separate DNS request sends the owner's host to a resolver. */
export async function publicHost(host: string, _signal?: AbortSignal): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (METADATA_HOSTS.has(bare) || bare.endsWith('.localhost') || bare.endsWith('.internal') || bare.endsWith('.local')) return false;
  if (ipv4Bytes(bare) !== null || bare.includes(':')) return !isPrivateAddress(bare);
  return true;
}

// ---------------------------------------------------------------------------------------------
// The page.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const SKIPPED = 'script, style, noscript, svg, template, head';
const BLOCKS = 'p, div, li, ul, ol, tr, table, h1, h2, h3, h4, h5, h6, section, article, header, footer, nav, main, aside, blockquote, pre, form, dt, dd';

/** An HTML document as text: scripts, styles and the like dropped, block elements as line breaks, whitespace
 * collapsed (design.md › «The link reader»). */
export async function htmlToText(html: string): Promise<string> {
  let out = '';
  let skip = 0;
  const lineBreak = () => {
    if (skip === 0 && !out.endsWith('\n')) out += '\n';
  };
  await new HTMLRewriter()
    .on(SKIPPED, {
      element(el) {
        skip += 1;
        try {
          el.onEndTag(() => { skip -= 1; });
        } catch {
          // A self-closing SVG has no end tag. Its contents cannot add text, so undo the skip.
          skip -= 1;
        }
      },
    })
    .on('br, hr', { element: lineBreak })
    .on(BLOCKS, {
      element(el) {
        lineBreak();
        el.onEndTag(lineBreak);
      },
    })
    .onDocument({
      text(chunk) {
        if (skip === 0) out += chunk.text;
      },
    })
    .transform(new Response(html))
    .arrayBuffer();
  return tidy(decodeEntities(out));
}

function tidy(text: string): string {
  return text
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

async function bodyText(res: Response): Promise<string | 'too_long'> {
  const reader = res.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return 'too_long';
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(all);
}

/** Fetches `url` by the rules above and gives its text. For a watch, `blocked` distinguishes a
 * private address or forbidden scheme from an unreadable page; the ordinary errand still uses
 * `unreadable` for both. `too_long`: more than the pet reads in one go. */
export async function readPage(url: string, mainOnly = false): Promise<ReadResult> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let target = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const parsed = new URL(target);
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '') return { kind: mainOnly ? 'blocked' : 'unreadable' };
      if (!(await publicHost(parsed.hostname, signal))) return { kind: mainOnly ? 'blocked' : 'unreadable' };
      // No cookie, referrer or player id: the code sets none of them, and Workers' fetch adds none.
      const res = await fetch(parsed.href, { method: 'GET', redirect: 'manual', headers: { accept: 'text/html, text/plain;q=0.9' }, signal });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        await res.body?.cancel();
        if (next === null) return { kind: 'unreadable' };
        target = new URL(next, parsed).href;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { kind: 'unreadable' };
      }
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!type.startsWith('text/') && type !== 'application/xhtml+xml') {
        await res.body?.cancel();
        return { kind: 'unreadable' };
      }
      const raw = await bodyText(res);
      if (raw === 'too_long') return { kind: 'too_long' };
      const selected = mainOnly ? (raw.match(/<main\b[^>]*>[\s\S]*?<\/main\s*>/i)?.[0]
        ?? raw.match(/<article\b[^>]*>[\s\S]*?<\/article\s*>/i)?.[0]
        ?? raw) : raw;
      const content = mainOnly ? selected.replace(/<(?:header|footer|nav|aside|time)\b[^>]*>[\s\S]*?<\/(?:header|footer|nav|aside|time)\s*>/gi, '') : selected;
      const text = type === 'text/html' || type === 'application/xhtml+xml' ? await htmlToText(content) : tidy(raw);
      if (text === '') return { kind: 'unreadable' };
      return tokensOf(text) > READ_LIMIT_TOKENS ? { kind: 'too_long' } : { kind: 'ok', text };
    }
    return { kind: 'unreadable' };
  } catch {
    // an abort, a dropped connection, a URL that does not parse
    return { kind: 'unreadable' };
  }
}
