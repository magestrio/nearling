// The results of an errand's searches and the report made from them (`Find out flow`, `Is it true flow`, `Errand
// request data`): NEAR AI's tool results become numbered, bounded data; the report's `[n]` markers and `VERDICT:`
// line are read here and stripped before anything is stored or shown; its sources are the results it cites.
import type { Message, SearchRan } from '../nearai';

/** The one fixed line the search call carries beside the job's text (`Errand request data` › «a search errand»): the
 * same for every pet, so the provider that searches gets queries built from this and the job only. */
export const SEARCH_INSTRUCTION = 'Search the web for the question or claim the user gives you, then answer in one short sentence.';

/** The search call's messages: the fixed instruction as the system message, the job's text as the user's. */
export const searchCallMessages = (job: string): Message[] => [
  { role: 'system', content: SEARCH_INSTRUCTION },
  { role: 'user', content: job },
];

/** The results the report reads, in characters (`Errand request data`: ≤ 12,000), shared equally between the
 * searches that ran. */
export const RESULTS_LIMIT_CHARS = 12_000;
/** The sources a report lists (`Errand flow` › «report»: at most 5). */
export const MAX_SOURCES = 5;

export interface ResultItem {
  /** The number the report cites, from 1 across all the searches. */
  n: number;
  title: string;
  /** The host without `www.`. */
  host: string;
  url: string;
  text: string;
}

export interface Source {
  label: string;
  url: string;
}

export type Verdict = 'true' | 'false' | 'unclear';

/** The host of a link without `www.`, or null for a link that is none. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** One search's output (`[1] title\nurl\ntext…\n\n[2] …`) as results. A header is a `[n] title` line followed by a
 * line holding an address, so a `[1]` inside a page's text is no header. */
function parse(output: string): { title: string; url: string; text: string }[] {
  const header = /(?:^|\n)\[\d+\] ([^\n]*)\n(https?:\/\/\S+)[ \t]*(?:\n|$)/g;
  const found: { title: string; url: string; start: number; end: number }[] = [];
  for (let m = header.exec(output); m !== null; m = header.exec(output)) {
    found.push({ title: m[1]!.trim(), url: m[2]!, start: m.index, end: m.index + m[0].length });
  }
  return found.map((f, i) => ({ title: f.title, url: f.url, text: output.slice(f.end, found[i + 1]?.start ?? output.length).trim() }));
}

/** The searches' outputs as numbered results of at most `limit` characters in all: the limit shared equally between
 * the searches, each search's share between its results; a result is its title, host and text cut to its share. */
export function numberResults(searches: SearchRan[], limit: number = RESULTS_LIMIT_CHARS): ResultItem[] {
  const ran = searches.filter((s) => s.output !== null);
  const items: ResultItem[] = [];
  for (const search of ran) {
    const parsed = parse(search.output!);
    if (parsed.length === 0) continue;
    const share = Math.floor(limit / ran.length / parsed.length);
    for (const result of parsed) {
      const host = hostOf(result.url);
      if (host === null) continue;
      const title = result.title.slice(0, Math.floor(share / 2));
      const room = Math.max(0, share - title.length - host.length);
      items.push({ n: items.length + 1, title, host, url: result.url, text: result.text.slice(0, room) });
    }
  }
  return items;
}

/** What a report is once its markers are read and removed. */
export interface Report {
  text: string;
  /** The verdict of «Is it true?»; `null` for «Find out». A missing or unreadable one is «unclear». */
  verdict: Verdict | null;
  sources: Source[];
}

const VERDICT_LINE = /^[ \t]*\**VERDICT\**[ \t]*:[ \t]*\**[ \t]*([A-Za-z]+)[^\n]*(?:\n|$)/gim;
const MARKER = /[ \t]?\[\d+(?:[ \t]*[,;–-][ \t]*\d+)*\]/g;

/** Reads the reply of a search errand: the numbers it cites become `sources` (the first five distinct hosts, in the
 * order cited), the `[n]` markers and the `VERDICT:` line leave the text. A report that cites no source settles no
 * claim: its verdict is always «unclear». */
export function readReport(reply: string, items: ResultItem[], form: 'find' | 'check'): Report {
  let said: Verdict | null = null;
  const withoutVerdict = reply.replace(VERDICT_LINE, (_line, word: string) => {
    const w = word.toLowerCase();
    if (said === null && (w === 'true' || w === 'false' || w === 'unclear')) said = w;
    return '';
  });
  const cited: number[] = [];
  for (const marker of withoutVerdict.match(MARKER) ?? []) {
    for (const digits of marker.match(/\d+/g) ?? []) cited.push(Number(digits));
  }
  const sources: Source[] = [];
  for (const n of cited) {
    const item = items.find((i) => i.n === n);
    if (item === undefined || sources.some((s) => s.label === item.host)) continue;
    if (sources.length < MAX_SOURCES) sources.push({ label: item.host, url: item.url });
  }
  const text = withoutVerdict.replace(MARKER, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, verdict: form === 'check' ? (sources.length === 0 ? 'unclear' : (said ?? 'unclear')) : null, sources };
}
