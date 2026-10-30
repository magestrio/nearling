// The only module that talks to the game's Worker. Every request with a player carries Privy's identity token in
// `privy-id-token` (design.md › Worker); without one it goes as a visitor. A failure is a WorkerError: `status` 0
// means the Worker never answered, any other is its HTTP status with the `code` of its body (`signed_out`,
// `rate_limited`, `chain_unreachable`, `not_owner`, `no_pet`, …).
export interface Health {
  ok: boolean;
  version: string;
  env: string;
}

export class WorkerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** the parsed body of the refusal, for the few that carry more than a code (`sign_in_refused`) */
    readonly body: unknown = null,
  ) {
    super(`worker ${status} ${code}`);
  }
}

export type Stage = 'baby' | 'teen' | 'adult';
export type JobKind = 'reply' | 'greeting' | 'wake';
export interface Fullness {
  state: 'full' | 'hungry' | 'asleep';
  /** 0–1, the food's share of the scale's 12 thoughts */
  level: number;
}

export interface PetBase {
  tokenId: string;
  name: string;
  stage: Stage;
  fullness: Fullness;
}
/** `GET /api/pets/:id` — `viewer` is the client's switch between the views: `visitor` has no session, `guest` is
 *  signed in and not the owner; the owner fields exist for `owner` only. */
export type PetView =
  | ({ viewer: 'visitor' | 'guest' } & PetBase)
  | ({
      viewer: 'owner';
      tired: boolean;
      /** the next 00:00 UTC (ISO), while tired */
      until?: string;
      paused: boolean;
      deepPrice: { cents: number; yocto: string };
      /** no player line yet: «Say hi to {name}…» */
      hello: boolean;
      pendingJob: string | null;
      /** the mode of that job: a reloaded page shows «is thinking…» or «is thinking hard…» */
      pendingMode: 'chat' | 'deep' | null;
      /** what that job is: «Try again» of a failed one depends on it */
      pendingKind: JobKind | null;
      /** the owner's own line of a reply on its way, for a reloaded page or another tab */
      pendingText: string | null;
      /** the newest thought with a reply: a page without it reads the conversation again */
      lastThought: string | null;
      /** how many times the memory was cleared: a tab with an older number reads the conversation again */
      memoryEpoch: number;
      ownedCount: number;
    } & PetBase);

export type ClosedReason = 'service' | 'budget' | 'pool' | 'daily';
/** `GET /api/hatch` */
export interface HatchStatus {
  open: boolean;
  reason?: ClosedReason;
  /** ISO time, only for `daily` alone */
  until?: string;
  /** a signed-in player who hatched a pet they still own */
  already?: { tokenId: string; name: string };
  /** a closed answer to a session whose player has no pet of their own now (`add-pet` › Hatch screen › `no exit`): no way
   *  out is offered; absent for a visitor and for a player with a pet */
  noPets?: true;
}

export interface Me {
  accountId: string;
  hatched: { tokenId: string; name: string } | null;
  currentPet: { tokenId: string; name: string } | null;
  ownedCount: number;
}

export type ThoughtCode = 'ai_unavailable' | 'empty_paid' | 'asleep' | 'tired' | 'too_hungry' | 'paused' | 'chain_unreachable' | 'memory_cleared';
export type PetEvent = 'fell_asleep' | 'daily_cap_reached' | 'woke';
export interface Thought {
  id: string;
  text: string;
  cut: 'fuse' | 'food' | 'cap' | null;
  /** the exact price in yocto, «Think hard» only */
  price?: string;
  /** the same price in US cents, at the rate it was made at: what «Thought hard · {price}» shows */
  priceCents?: number;
  reasked?: boolean;
}
/** `GET /api/pets/:id/state` — the owner's view plus the outcome of the job asked for. */
export type PetState = Omit<Extract<PetView, { viewer: 'owner' }>, 'viewer' | 'ownedCount'> & {
  pending?: boolean;
  /** what the job asked about is */
  jobKind?: JobKind | 'diary';
  thought?: Thought;
  code?: ThoughtCode;
  events: PetEvent[];
  /** with `woke`: the name of the friend whose meal woke the pet — «{friend} fed {name}.». The server of this change
   *  never wakes by a friend's meal (that is `add-feeding`'s call of `wakeIfFed`), so it sends none yet. */
  friend?: string;
};
export interface ConversationLine {
  id: string;
  who: 'player' | 'pet';
  text: string;
  at: number;
  cut?: Thought['cut'];
  price?: string;
  priceCents?: number;
}
export interface Conversation {
  lines: ConversationLine[];
  more: boolean;
  before: number | null;
}

/** `GET /api/sign-in` (Sign-in data): what a browser with no session may do before Google. Nothing about players. */
export type SignInGate = { state: 'open' } | { state: 'closed_new' | 'closed_all'; until: string };

/** Why the server did not open a session after Google (`POST /api/session`, `403 sign_in_refused`): `mau` — closed to new
 *  players, `ceiling` — closed to everyone. `until` is 00:00 UTC of the 1st, ISO. */
export interface SignInRefusal {
  reason: 'mau' | 'ceiling';
  until: string;
}

/** `POST /api/session`: the session is open, or the server refused to open it. Any other answer is a `WorkerError`:
 *  `401 signed_out` (the token is no session), `503 auth_unavailable`, status 0 (no answer). */
export type SessionResult = { ok: true } | { refused: SignInRefusal };

/** `POST /api/pets/:id/memory/clear` — `resolve` is `200`. Refusals (`WorkerError`): `401 signed_out`, `403 not_owner`,
 *  `404 no_pet`, `429 rate_limited`, `503 chain_unreachable` / `auth_unavailable`, `500 clear_failed` (the server says
 *  nothing was erased); status 0 or another 5xx — the outcome is unknown. */
export type ClearMemoryCode = 'signed_out' | 'not_owner' | 'no_pet' | 'rate_limited' | 'chain_unreachable' | 'auth_unavailable' | 'clear_failed';

/** The identity token of the player, or null for a visitor. */
export type Token = string | null;

export interface WorkerApi {
  health(): Promise<Health>;
  me(token: Token): Promise<Me>;
  /** `look`: the page's own repeat while it stands on a pause (`GET /api/hatch?look=1`). The server counts a closed hatch
   *  only for a load or a tap, never for a look. */
  hatchStatus(token: Token, opts?: { look?: boolean }): Promise<HatchStatus>;
  /** `name` is the raw text as typed; the server cleans it again. Resolves `{ tokenId }`. */
  hatch(token: Token, name: string): Promise<{ tokenId: string }>;
  pet(token: Token, tokenId: string): Promise<PetView>;
  petState(token: Token, tokenId: string, job?: string): Promise<PetState>;
  conversation(token: Token, tokenId: string, before?: number): Promise<Conversation>;
  /** Resolves the job id (null when the greeting is already there). */
  say(token: Token, tokenId: string, text: string, mode: 'chat' | 'deep'): Promise<{ job: string }>;
  // a pause refuses it at once: `WorkerError(409, 'paused')`
  greeting(token: Token, tokenId: string): Promise<{ job: string | null }>;
  /** «Try again» under a wake thought that did not come: the job, null with nothing to retry. */
  retryWake(token: Token, tokenId: string): Promise<{ job: string | null }>;
  /** The exchange after Google, once per page load with a Privy session. `fresh`: this load came back from Google; `from`:
   *  where the sign-in began (a page, or Home). Outside the request limit. */
  session(token: Token, body: { fresh: boolean; from?: 'link' | 'home' }): Promise<SessionResult>;
  /** «Sign out» on the server (ADR-022); `204`. Takes at most `END_SESSION_TIMEOUT_MS`. */
  endSession(token: Token): Promise<void>;
  /** The state of the sign-in, read before Google. Sent with no token: a stale one would be a `401`. */
  signInState(): Promise<SignInGate>;
  /** The owner erases the pet's memory. */
  clearMemory(token: Token, tokenId: string): Promise<{ ok: true }>;
}
