import { useSyncExternalStore } from 'react';
import type { AuthApi } from '../seams/auth-context';
import { WorkerError, workerApi, type FeedOutcome, type FeedSheetAnswer, type FeedSource, type PortionNear } from '../seams/worker';
import { announceFed } from './feedRequest';
import { checkFeedTx, sha256Hex, toBase64 } from './feedTx';
import { nearRpc } from '../seams/rpc';
import { config } from '../config';

// The meal on its way (`Feeding outcome rule`, `Feeding transaction data` › «outcome with the sheet closed»). It belongs to the tab,
// not to the sheet: a record started at the tap, before anything is sent, and the whole chain runs in it — build, check, sign, the
// first `/send` — so closing the sheet aborts nothing, in the first 10 seconds or after. `unknown`, or no answer at all, repeats
// `/send` every 5 s with the same signed bytes for as long as the tab lives: never a new signature, so nothing is paid twice. A snack
// and a flight learned after a reload have no signed bytes and ask `/feed/outcome` instead. Closing the sheet drops its listener and
// not the flight: no message follows (`closed on its way`); the page reads the pet at the outcome.

/** «Feeding {name}…» becomes «Still checking…» this long after the tap, whatever the request is doing. */
export const CHECKING_MS = 10_000;
/** A repeat of `/send` or of the outcome question. */
export const REPEAT_MS = 5_000;
/** Answers of `unknown` with no row left on the server (`settled`) a watch takes before it reads the page instead: a slow node may still answer. */
export const SETTLED_ASKS = 3;

/** What the flight needs from the sign-in: the identity token, Privy's signature, the player's own account, the ended session. */
export interface FlightHost {
  account: string | null;
  token(): Promise<string | null>;
  sign(hashHex: string): Promise<Uint8Array>;
  endSession(held?: boolean, line?: boolean): void;
}

/** The host of the sign-in at this moment. A flight started from a sheet keeps the functions it was given. */
export const hostOf = (auth: Pick<AuthApi, 'nearAccountId' | 'getIdentityToken' | 'signNearHash' | 'endSession'>): FlightHost => ({
  account: auth.nearAccountId,
  token: () => auth.getIdentityToken(),
  sign: (hashHex) => auth.signNearHash(hashHex),
  endSession: (held, line) => auth.endSession(held, line),
});

export interface Flight {
  readonly tokenId: string;
  /** what the server holds for it; a flight learned from `409 pending` takes the row's */
  source: FeedSource;
  /** the pet slept when it was tapped: a confirmed meal then closes the sheet by itself */
  readonly wasAsleep: boolean;
  readonly startedAt: number;
  /** «Still checking…» is on */
  checking: boolean;
  /** the id the server knows it by: a portion's hash after the first answer, a snack's from `myFeed` */
  id: string | null;
  /** the signed bytes, the tab's memory only */
  signed: { tx: string; signature: string } | null;
  sharedCode?: string;
}

export type FlightEnd =
  | { status: 'ok'; friend?: string; hatched: boolean }
  | { status: 'funding_closed' }
  | { status: 'failed' }
  /** the network said the sheet is not what was tapped (`409 short`, `409 snack_gone`, `503`): it is drawn from this answer */
  | { status: 'redraw'; sheet: FeedSheetAnswer }
  /** the outcome is not known to this tab: the sheet reads again */
  | { status: 'reread' }
  /** the session ended under the tap itself, before anything was signed: the sheet closes and the line stands on the page */
  | { status: 'session' };

export type FlightEvent = { kind: 'checking'; flight: Flight } | { kind: 'ended'; flight: Flight; end: FlightEnd };

let current: Flight | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** wakes the sleep between two repeats, so a finished flight does not wait the rest of it out */
let wake: (() => void) | null = null;
const watchers = new Set<() => void>();
const listeners = new Set<(event: FlightEvent) => void>();
/** which flight the version of the snapshot belongs to: `useSyncExternalStore` needs a value that changes when the flight does */
let version = 0;

function changed(): void {
  version += 1;
  for (const w of watchers) w();
}

export const currentFlight = (): Flight | null => current;

/** The flight of this tab as a snapshot that changes with it (`checking` turns on, it ends). */
export function useFlight(): { flight: Flight | null; checking: boolean } {
  useSyncExternalStore(
    (onChange) => {
      watchers.add(onChange);
      return () => watchers.delete(onChange);
    },
    () => version,
    () => 0,
  );
  return { flight: current, checking: current?.checking ?? false };
}

/** Listens to the flight of this tab: «Still checking…» turning on, and its end. Returns the way to stop. */
export function onFlight(listener: (event: FlightEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: FlightEvent): void {
  for (const l of Array.from(listeners)) l(event);
}

function begin(tokenId: string, source: FeedSource, wasAsleep: boolean, id: string | null, checking: boolean): Flight {
  const flight: Flight = { tokenId, source, wasAsleep, startedAt: Date.now(), checking, id, signed: null };
  current = flight;
  if (!checking) {
    timer = setTimeout(() => {
      if (current !== flight || flight.checking) return;
      flight.checking = true;
      changed();
      emit({ kind: 'checking', flight });
    }, CHECKING_MS);
  }
  changed();
  return flight;
}

function clear(flight: Flight): boolean {
  if (current !== flight) return false;
  current = null;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  wake?.();
  return true;
}

function finish(flight: Flight, end: FlightEnd): void {
  if (!clear(flight)) return;
  changed();
  emit({ kind: 'ended', flight, end });
  // a confirmed meal reaches the page whether the sheet is open or not; a flight whose outcome this tab never learned asks the page
  // to look at the pet too
  if (end.status === 'ok' || end.status === 'reread') announceFed({ kind: 'fed', tokenId: flight.tokenId, source: flight.source });
}

/** The session ended while the flight was on its way: it stops asking, no message follows, the row is the cron's. */
function stopped(host: FlightHost, flight: Flight): void {
  if (!clear(flight)) return;
  host.endSession(true);
  changed();
}

/** The session ended under the tap itself, before anything was signed or sent: the sheet closes and the line stands on the page
 *  (`Session expiry flow` › «сессия кончилась при открытом экране»). */
function endedAtTap(host: FlightHost, flight: Flight): void {
  if (!clear(flight)) return;
  host.endSession(true, true);
  changed();
  emit({ kind: 'ended', flight, end: { status: 'session' } });
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t);
      wake = null;
      resolve();
    };
    const t = setTimeout(done, ms);
    wake = done;
  });

const status = (e: unknown): number => (e instanceof WorkerError ? e.status : 0);
const codeOf = (e: unknown): string => (e instanceof WorkerError ? e.code : '');
const sheetOf = (e: unknown): FeedSheetAnswer | null => {
  const body = e instanceof WorkerError && typeof e.body === 'object' && e.body !== null ? (e.body as { sheet?: unknown }).sheet : undefined;
  return typeof body === 'object' && body !== null && 'chain' in body ? (body as FeedSheetAnswer) : null;
};

const confirmed = (o: FeedOutcome): FlightEnd => ({ status: 'ok', hatched: o.hatched, ...(o.friend !== undefined ? { friend: o.friend } : {}) });

/** The answer of the server in the flight's end, or null while the network has none (`unknown`). */
function endOf(o: FeedOutcome): FlightEnd | null {
  if (o.status === 'ok') return confirmed(o);
  if (o.status === 'failed') return { status: 'failed' };
  return null;
}

/** Asks the outcome until the network has an answer: for a snack, a reloaded tab and a portion another tab's request holds. */
async function watch(host: FlightHost, flight: Flight): Promise<void> {
  let settledAsks = 0;
  for (;;) {
    if (current !== flight) return;
    try {
      const token = await host.token();
      if (token === null) return stopped(host, flight);
      const o = await workerApi.feedOutcome(token, flight.tokenId, { id: flight.id!, source: flight.source });
      const end = endOf(o);
      if (end !== null) return finish(flight, end);
      // Another flow settled the row and the network keeps silent about the hash: nothing will end this watch but the page's own read.
      settledAsks = o.settled === true ? settledAsks + 1 : 0;
      if (settledAsks >= SETTLED_ASKS) return finish(flight, { status: 'reread' });
    } catch (e) {
      if (status(e) === 401) return stopped(host, flight);
      if (status(e) === 400 || status(e) === 404) return finish(flight, { status: 'reread' });
      // no answer, or the network behind the server is out of reach: ask again
    }
    await pause(REPEAT_MS);
  }
}

/** The id of a flight that has none: the server's row of the player for this pet, which the pet's own read carries. */
async function learnId(host: FlightHost, flight: Flight): Promise<boolean> {
  try {
    const token = await host.token();
    if (token === null) return false;
    const view = await workerApi.pet(token, flight.tokenId);
    const mine = 'myFeed' in view ? view.myFeed : null;
    if (mine === null || mine === undefined) return false;
    flight.id = mine.id;
    flight.source = mine.source;
    return true;
  } catch {
    return false;
  }
}

/** A flight whose first request gave no answer or said `unknown`: the id is learned, then the outcome is asked until it is known.
 *  `now`: another request of the player's holds the meal, which is as good as a reopened sheet: «Still checking…» without the 10 s. */
async function followUp(host: FlightHost, flight: Flight, now = false): Promise<void> {
  if (now && !flight.checking) {
    flight.checking = true;
    changed();
    emit({ kind: 'checking', flight });
  }
  if (flight.id === null && !(await learnId(host, flight))) {
    // no row of ours: it was never written, or it was settled before we looked
    return finish(flight, { status: 'reread' });
  }
  return watch(host, flight);
}

/** The identity token at the tap. Privy out of reach is a failure with nothing signed and nothing sent, not a flight that never ends. */
async function tokenAtTap(host: FlightHost): Promise<string | null | undefined> {
  try {
    return await host.token();
  } catch {
    return undefined;
  }
}

async function runMeal(host: FlightHost, flight: Flight, portion: PortionNear): Promise<void> {
  const token = await tokenAtTap(host);
  if (token === undefined) return finish(flight, { status: 'failed' });
  if (token === null) return endedAtTap(host, flight);
  let built: { tx: string };
  try {
    built = flight.sharedCode
      ? await workerApi.buildFeed(token, flight.tokenId, portion, flight.sharedCode)
      : await workerApi.buildFeed(token, flight.tokenId, portion);
  } catch (e) {
    const s = status(e);
    if (s === 401) return endedAtTap(host, flight);
    const sheet = sheetOf(e);
    if (s === 409 && codeOf(e) === 'short' && sheet !== null) return finish(flight, { status: 'redraw', sheet });
    if (s === 409 && codeOf(e) === 'shared_funding_closed') return finish(flight, { status: 'funding_closed' });
    // another request of ours holds a meal (a second tab): it is the one being waited for
    if (s === 409 && codeOf(e) === 'pending') return followUp(host, flight, true);
    if (s === 503 && codeOf(e) === 'chain_unreachable') return finish(flight, { status: 'redraw', sheet: { chain: false } });
    // nothing was signed: «не прошло», the NEAR is still in the wallet
    return finish(flight, { status: 'failed' });
  }
  // the browser signs only the one portion that was tapped (`Feeding transaction data` › «прислана не та порция»)
  let jobHash: string | undefined;
  if (flight.sharedCode) {
    try {
      const pet = await nearRpc.viewFunction<{ shared_job?: { hash?: string } | null } | null>(config.contractId, 'pet_view', { token_id: flight.tokenId });
      jobHash = pet?.shared_job?.hash;
      if (!jobHash) return finish(flight, { status: 'failed' });
    } catch { return finish(flight, { status: 'failed' }); }
  }
  const checked = checkFeedTx(built.tx, { account: host.account ?? '', tokenId: flight.tokenId, portion, linked: flight.sharedCode !== undefined, jobHash });
  if (!checked.ok) return finish(flight, { status: 'failed' });
  let signature: Uint8Array;
  try {
    signature = await host.sign(await sha256Hex(checked.bytes));
  } catch {
    return finish(flight, { status: 'failed' });
  }
  flight.signed = { tx: built.tx, signature: toBase64(signature) };
  for (;;) {
    if (current !== flight) return;
    try {
      const t = await host.token();
      if (t === null) return stopped(host, flight);
      const o = await workerApi.sendFeed(t, flight.tokenId, { ...flight.signed, ...(flight.sharedCode ? { code: flight.sharedCode } : {}) });
      if (o.hash) flight.id = o.hash;
      const end = endOf(o);
      if (end !== null) return finish(flight, end);
    } catch (e) {
      const s = status(e);
      if (s === 401) return stopped(host, flight);
      if (s === 409 && codeOf(e) === 'shared_funding_closed') return finish(flight, { status: 'funding_closed' });
      if (s === 400) return finish(flight, { status: 'failed' });
      if (s === 409 && codeOf(e) === 'pending') return followUp(host, flight, true);
      // no answer, or 503: the same bytes go again
    }
    await pause(REPEAT_MS);
  }
}

async function runSnack(host: FlightHost, flight: Flight): Promise<void> {
  const token = await tokenAtTap(host);
  if (token === undefined) return finish(flight, { status: 'failed' });
  if (token === null) return endedAtTap(host, flight);
  try {
    const o = flight.sharedCode
      ? await workerApi.snack(token, flight.tokenId, flight.sharedCode)
      : await workerApi.snack(token, flight.tokenId);
    const end = endOf(o);
    if (end !== null) return finish(flight, end);
    return followUp(host, flight);
  } catch (e) {
    const s = status(e);
    if (s === 401) return endedAtTap(host, flight);
    if (s === 409 && codeOf(e) === 'shared_funding_closed') return finish(flight, { status: 'funding_closed' });
    const sheet = sheetOf(e);
    // `snack_gone` redraws with the sheet as it stands now (the snack was taken, the pool ran dry, the pet woke)
    if (s === 409 && codeOf(e) === 'snack_gone' && sheet !== null) return finish(flight, { status: 'redraw', sheet });
    if (s === 409 && codeOf(e) === 'pending') return followUp(host, flight);
    if (s === 503 && codeOf(e) === 'chain_unreachable') return finish(flight, { status: 'redraw', sheet: { chain: false } });
    if (s === 404) return finish(flight, { status: 'failed' });
    // no answer: the server may have sent it
    return followUp(host, flight);
  }
}

/** A tap on a portion. False when a flight stands: a second portion is never sent. */
export function startMeal(host: FlightHost, input: { tokenId: string; portion: PortionNear; wasAsleep: boolean; sharedCode?: string }): boolean {
  if (current !== null) return false;
  const flight = begin(input.tokenId, 'near', input.wasAsleep, null, false);
  flight.sharedCode = input.sharedCode;
  void runMeal(host, flight, input.portion);
  return true;
}

/** A tap on the free snack. */
export function startSnack(host: FlightHost, input: { tokenId: string; wasAsleep: boolean; sharedCode?: string }): boolean {
  if (current !== null) return false;
  const flight = begin(input.tokenId, 'snack', input.wasAsleep, null, false);
  flight.sharedCode = input.sharedCode;
  void runSnack(host, flight);
  return true;
}

/** A flight the server knows of and this tab does not (a reload: `myFeed`): watched from the outcome route, «Still checking…» at once.
 *  `wasAsleep`: the pet is asleep on the page, so a confirmed meal wakes it and closes the sheet. */
export function watchFlight(host: FlightHost, input: { tokenId: string; id: string; source: FeedSource; wasAsleep: boolean }): boolean {
  if (current !== null) return false;
  const flight = begin(input.tokenId, input.source, input.wasAsleep, input.id, true);
  void watch(host, flight);
  return true;
}

/** Tests only: no flight, no listeners. */
export function resetFlight(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  current = null;
  wake?.();
  listeners.clear();
  version += 1;
}
