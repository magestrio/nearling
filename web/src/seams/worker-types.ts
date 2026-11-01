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

/** `near`: a portion of NEAR (the id is its transaction's hash); `snack`: a free snack (a random id, no hash). */
export type FeedSource = 'near' | 'snack';

/** The face of the day (`add-pet-life` › `Mood rule`), the same for every viewer; `null` while the pet sleeps. */
export type Mood = 'happy' | 'calm' | 'sleepy';

/** The seven items of the wardrobe (`Outfit catalogue rule`), by the slug the Worker and the pictures use. */
export type OutfitSlug = 'daisy-crown' | 'cozy-scarf' | 'thinking-cap' | 'smart-glasses' | 'bow-tie' | 'headphones' | 'party-hat';

export interface PetBase {
  tokenId: string;
  name: string;
  stage: Stage;
  fullness: Fullness;
  mood: Mood | null;
  /** the item the pet wears, for every viewer (`Outfit rule`); null: none */
  worn: OutfitSlug | null;
}
/** With a session only: the player's own meal or snack on its way for this pet (`Feeding transaction data` ›
 *  «outcome with the sheet closed»), `null` when none; a reloaded tab starts to watch its outcome from it. */
export interface MyFeed {
  myFeed: { id: string; source: FeedSource } | null;
}
/** `GET /api/pets/:id` — `viewer` is the client's switch between the views: `visitor` has no session, `guest` is
 *  signed in and not the owner; the owner fields exist for `owner` only. */
export type PetView =
  | ({ viewer: 'visitor' } & PetBase)
  | ({ viewer: 'guest' } & PetBase & MyFeed)
  | ({
      viewer: 'owner';
      tired: boolean;
      /** the next 00:00 UTC (ISO), while tired or at zero energy */
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
      /** how many times a meal woke the pet: a page sends its number to `/state?wakes=` and is told of a later wake */
      wakes: number;
      /** the traits as words, each once, in the order gained (`Pet life display rule`: the owner's only) */
      traits: string[];
      /** steps of energy left today, 0…10 (`Energy rule`) */
      energy: number;
      /** today's entry is there, unread, and the pet awake: the Pet screen opens the Diary by itself (`Daily ritual flow`) */
      diaryUnread: boolean;
      /** the job on its way (`pendingJob`) is the answer to the question of the day */
      pendingQuestion: boolean;
      ownedCount: number;
      /** the items the pet has on the chain, in the catalogue's order */
      outfits: OutfitSlug[];
      /** the earned items whose notice has not been shown (`New outfit notice screen`), in the catalogue's order */
      notices: OutfitSlug[];
      /** what «Buy · {price}» says: the cents of one bought item, and its price in yocto */
      outfitPrice: { cents: number; yocto: string };
    } & PetBase &
      MyFeed);

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

export type ThoughtCode = 'ai_unavailable' | 'empty_paid' | 'asleep' | 'tired' | 'no_energy' | 'too_hungry' | 'paused' | 'chain_unreachable' | 'memory_cleared';
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
export type PetState = Omit<Extract<PetView, { viewer: 'owner' }>, 'viewer' | 'ownedCount' | 'myFeed'> & {
  /** the poll's answer carries it only when the tab has a flight to learn of */
  myFeed?: MyFeed['myFeed'];
  pending?: boolean;
  /** what the job asked about is */
  jobKind?: JobKind | 'diary';
  thought?: Thought;
  code?: ThoughtCode;
  events: PetEvent[];
  /** with `woke`: the name of the friend whose meal woke the pet — «{friend} fed {name}.»; `'A friend'` for a nameless
   *  feeder. Sent when the wake came from a friend's feeding (`wakes` below the pet's counter). */
  friend?: string;
};
export interface ConversationLine {
  id: string;
  /** `event`: the line of a stage change (`Growth flow`), the game's, not the pet's */
  who: 'player' | 'pet' | 'event';
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

/** The three portions of NEAR the sheet offers (OD-211). The client's own list is `feeding/feedTx.ts` › `PORTIONS`. */
export type PortionNear = '0.01' | '0.05' | '0.2';

export interface SheetPortion {
  near: PortionNear;
  yocto: string;
  /** whole US cents */
  cents: number;
  /** what the player must add to give this portion, NEAR rounded up to two decimals ("0.13"), shown as sent; null when it fits */
  missing: string | null;
}

/** The line that stands in the snack's place (`Snack rule`), computed by the server. */
export type SnackLine =
  | { state: 'ready' }
  | { state: 'none' }
  | { state: 'not_ready'; at: string }
  | { state: 'given' }
  | { state: 'pet_full'; until: string }
  | { state: 'shared_all'; until: string }
  | { state: 'paused' };

/** `GET /api/pets/:id/feed` when the network reads: what Feed sheet shows, whole. */
export interface FeedSheetData {
  chain: true;
  /** who the player is for this pet at this moment: a pet given away turns an owner's sheet into a guest's */
  viewer: 'owner' | 'guest';
  name: string;
  fullness: Fullness;
  portions: SheetPortion[];
  /** `none`: nothing in the wallet but the project's gas, the balance is not shown */
  wallet: { state: 'some'; balance: string } | { state: 'none' };
  snack: SnackLine;
  /** the player has a pet of their own: the thanks says «Get your own pet» when not */
  hatched: boolean;
  /** the feeder's own first name for the thanks, when it passed the server's check */
  friend: string | null;
  /** a meal or snack of the player's on its way, whichever pet it is for */
  pending: { id: string; source: FeedSource; tokenId: string } | null;
}
/** `chain: false` alone when the network does not read (`Feeding connection rule` › «сеть NEAR недоступна»). */
export type FeedSheetAnswer = FeedSheetData | { chain: false };

/** The answer of `/feed/send`, `/feed/outcome` and `/snack`. `friend` only for a friend's confirmed meal with a name. */
export interface FeedOutcome {
  status: 'ok' | 'failed' | 'unknown';
  hash?: string;
  friend?: string;
  hatched: boolean;
  /** `/feed/outcome` only, with `unknown`: no row of the player stands for the id, so nothing will settle it. */
  settled?: true;
}

/** `GET /api/wallet`: the player's game wallet. `funded`: NEAR arrived since the last read. */
export interface WalletInfo {
  address: string;
  balance: string;
  funded: boolean;
}

/** `GET /api/pets/:id/diary` (design.md › Worker): the Diary screen, whole. `day` is the Worker's UTC day, `closedAt` today's 00:00
 *  UTC (when yesterday's riddle closed: the `{time}` of the verdict lines) and `until` the next 00:00 UTC, both ISO. */
export type DiaryEntry =
  /** `lines` are the paragraphs, `question` the last line when it asks (null: no question today); `work` is `add-pet-work`'s
   *  line about the pet's work, null until that change is built */
  | { kind: 'text'; id: string; lines: string[]; question: string | null; work: string | null }
  | { kind: 'first' | 'cleared' | 'writing' | 'asleep' | 'failed' };

export type DiaryRiddle =
  | { kind: 'open'; day: number; text: string }
  /** `answer` is the owner's own text, null after a clear */
  | { kind: 'answered'; day: number; text: string; answer: string | null }
  | { kind: 'held' };

/** Yesterday's riddle: the verdict once revealed (`answer` is the first accepted one, for everyone), `waiting` while sealed and not
 *  revealed, null for a riddle that never opened. */
export type DiaryYesterday = { kind: 'solved' | 'wrong' | 'none'; answer: string } | { kind: 'waiting' } | null;

export type StreakNote = 'forecast' | 'saving' | 'lost';
export interface DiaryStreak {
  /** the forecast's when there is one, else the chain's */
  days: number;
  freezes: number;
  done: boolean;
  line: 'earned' | 'frozen' | 'fresh' | null;
  /** the chain's streak */
  n: number;
  /** the freezes the line speaks of */
  k: number;
  missed: number;
  note: StreakNote[];
}

export type DiaryPart = 'question' | 'riddle';
export interface DiaryView {
  day: number;
  closedAt: string;
  until: string;
  entry: DiaryEntry;
  read: boolean;
  exchange: { answer: string; reply: string } | null;
  riddle: DiaryRiddle;
  yesterday: DiaryYesterday;
  streak: DiaryStreak;
  parts: DiaryPart[];
  complete: boolean;
}

/** `POST …/riddle`: `accepted`, `already` (a stale tab) and `late` come with `200`; `409 asleep` and `409 not_sealed` are refusals. */
export type RiddleStatus = 'accepted' | 'already' | 'late';

/** The identity token of the player, or null for a visitor. */
export type Token = string | null;

/** `GET /api/pets/:id/wardrobe`: what Wardrobe screen draws, whole. `owned` and `worn` are the owner's view's, repeated so that
 *  one answer draws a screen. `buying` is the pet's oldest purchase on its way, `outcome` its newest settled one of the last
 *  minutes (`code` of a `failed` one: `owned`, `short`, `cap`, `error`, or a chain code). */
export interface WardrobeView {
  owned: OutfitSlug[];
  worn: OutfitSlug | null;
  price: { cents: number; yocto: string };
  /** after the price the pet would not stay «Full» (`Outfit purchase flow` › «мало еды») */
  short: boolean;
  /** the gas pause only: a purchase works on the pause of NEAR AI */
  shopPaused: boolean;
  buying: { id: string; item: OutfitSlug } | null;
  outcome: { id: string; item: OutfitSlug; status: 'bought' | 'failed'; code: string | null } | null;
}

export interface WorkerApi {
  health(): Promise<Health>;
  me(token: Token): Promise<Me>;
  /** `look`: the page's own repeat while it stands on a pause (`GET /api/hatch?look=1`). The server counts a closed hatch
   *  only for a load or a tap, never for a look. */
  hatchStatus(token: Token, opts?: { look?: boolean }): Promise<HatchStatus>;
  /** `name` is the raw text as typed; the server cleans it again. Resolves `{ tokenId }`. */
  hatch(token: Token, name: string): Promise<{ tokenId: string }>;
  pet(token: Token, tokenId: string): Promise<PetView>;
  /** `wakes`: how many wakes this page knows of; a later one comes back as `woke` and `friend`. */
  petState(token: Token, tokenId: string, job?: string, wakes?: number): Promise<PetState>;
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
  /** Feed sheet's state, whole. Refusals: `401 signed_out`, `404 no_pet`, `500 rate_missing`. */
  feedSheet(token: Token, tokenId: string): Promise<FeedSheetAnswer>;
  /** The unsigned `pet_feed` as base64, for the browser to check and sign. Refusals: `409 pending`, `409 short` (body holds
   *  `sheet`), `502 feed_not_built`, `503 chain_unreachable`, `404 no_pet`. */
  buildFeed(token: Token, tokenId: string, portion: PortionNear): Promise<{ tx: string }>;
  /** The signed portion (both base64). Holds up to `FEED_SEND_TIMEOUT_MS`. Refusals: `400 bad_tx`, `409 pending`, `503`. */
  sendFeed(token: Token, tokenId: string, body: { tx: string; signature: string }): Promise<FeedOutcome>;
  /** The outcome for a tab that has no signed bytes (a reload, a snack). */
  feedOutcome(token: Token, tokenId: string, body: { id: string; source: FeedSource }): Promise<FeedOutcome>;
  /** The free snack, sent by the server. Refusals: `409 snack_gone` (body holds `sheet`), `409 pending`, `503`. */
  snack(token: Token, tokenId: string): Promise<FeedOutcome>;
  wallet(token: Token): Promise<WalletInfo>;
  /** The Diary screen's data. Marks nothing; also for an asleep pet. Refusals: `401 signed_out`, `403 not_owner`, `404 no_pet`,
   *  `429 rate_limited`, `503 chain_unreachable`. */
  diary(token: Token, tokenId: string): Promise<DiaryView>;
  /** The Diary screen stood (`day` is the diary's): `{ ok: true }`, and nothing written for another day or for a sleeping pet with
   *  no opening today. */
  readDiary(token: Token, tokenId: string, day: number): Promise<{ ok: true }>;
  /** The answer to the question of the day, a reply to the pet: the job. Refusals: `409 paused | late | no_question | already`. */
  answerQuestion(token: Token, tokenId: string, body: { text: string; day: number }): Promise<{ job: string }>;
  /** The answer to the riddle of `day`. Refusals: `409 asleep | not_sealed`, `400 bad_request`. */
  answerRiddle(token: Token, tokenId: string, body: { text: string; day: number }): Promise<{ status: RiddleStatus }>;
  /** The wardrobe of the owner's pet. Refusals: `401 signed_out`, `403 not_owner`, `404 no_pet`, `429 rate_limited`, `503 chain_unreachable`. */
  wardrobe(token: Token, tokenId: string): Promise<WardrobeView>;
  /** «Wear» (an item) and «Take off» (null). Refusals: `409 not_owned`, `400 bad_request`, and the read's. */
  wear(token: Token, tokenId: string, item: OutfitSlug | null): Promise<{ worn: OutfitSlug | null }>;
  /** «Buy · {price}»: the purchase's id (`202`). Refusals: `409 owned | paused`, `400 bad_request`, and the read's. */
  buy(token: Token, tokenId: string, item: OutfitSlug): Promise<{ id: string }>;
  /** A New outfit notice was shown: the item's name, nothing else. */
  seenOutfit(token: Token, tokenId: string, item: OutfitSlug): Promise<{ ok: true }>;
}
