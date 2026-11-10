import type { ThoughtPointer } from '../verification/types';

// The only module that talks to the game's Worker. Every request with a player carries Privy's identity token in
// `privy-id-token` (design.md › Worker); without one it goes as a visitor. A failure is a WorkerError: `status` 0
// means the Worker never answered, any other is its HTTP status with the `code` of its body (`signed_out`,
// `rate_limited`, `chain_unreachable`, `not_owner`, `no_pet`, …).
export interface Health {
  ok: boolean;
  version: string;
  env: string;
}

/** Public Hire board snapshot. Search words never leave the browser. */
export interface HireBoard {
  pets: Array<{ tokenId: string; opaqueId: string; name: string; label: string; price: Price;
    status: 'available' | 'asleep' | 'resting' | 'paused'; until?: string; yours: boolean;
    experience?: { field: string | null; paidHires: number; completedErrands: number; countedSince: number } }>;
  visits: Array<{ tokenId: string; name: string; stage: Stage; fullness: Fullness['state']; worn: OutfitSlug | null }>;
}

/** Public Home copy; a null `numbers` means no live meadow is available. */
export interface ShowcaseCopy {
  pets: Array<{ tokenId: string; name: string; stage: Stage; fullness: Fullness['state']; worn: OutfitSlug | null }>;
  numbers: { pets_hatched: number; thoughts_paid: number; spent: string; hires_completed: number; friend_snacks: number; counted_since: number } | null;
}

export type CardKind = 'thought' | 'growth' | 'outfit';
export type CardSource =
  | { tokenId: string; name: string; kind: 'thought'; thoughtId: string; line: string }
  | { tokenId: string; name: string; kind: 'growth'; stage: Exclude<Stage, 'baby'> }
  | { tokenId: string; name: string; kind: 'outfit'; worn: OutfitSlug };

/** Public record pointers; each transaction is read by the browser from NEAR. */
export interface VerificationIndex {
  tokenId: string;
  worn: OutfitSlug | null;
  transactions: Array<{ kind: string; ref: string; txHash: string; at: number }>;
  thoughts: Array<{ id: string; tokenId: string; at: number; status: string; erased: boolean; withoutReply: boolean;
    model: string; priceYocto: string; nearUsdRate: string | null }>;
}

export type SharedReceipt = { status: 'live'; thought: { id: string; tokenId: string; payingTokenId: string | null;
  calls: Array<{ n: number; reqSha256: string; resSha256: string; request: string; reply: string }> } }
  | { code: 'revoked'; tokenId: string; thoughtId: string };

/** GET /api/verification/pets/:id/thoughts/:thought: public pointer, plus words only for the current owner. */
export interface VerificationThought extends ThoughtPointer {
  viewer: 'visitor' | 'guest' | 'owner';
  kind: string;
  withoutReply: boolean;
  paidWork?: boolean;
  containsWorkNote?: boolean;
  billing?: 'refused';
  code?: string;
  publicationWarning?: string | null;
  playerText?: string | null;
  replyText?: string | null;
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
/** What a job of the state poll is: also the owner's taps on a hire (`hire`, `decline`, `finish`) and an advice. */
export type StateJobKind = JobKind | 'hire' | 'decline' | 'finish' | 'advice' | 'diary';
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
  /** the public label of the pet's skill, for every viewer (`Skill rule` › «label on the pet's page»); null: none */
  skill: { label: string } | null;
  /** Public target only; observations and receipts remain owner-only. */
  watch?: { target: string; kind: 'topic' | 'release' | 'account' | 'page' } | null;
}

/** Owner-only GET /api/pets/:id/watch and the save/resume responses. */
export interface WatchRead {
  target: string | null;
  kind?: 'topic' | 'release' | 'account' | 'page';
  savedHourUtc?: number;
  paused?: boolean;
  /** Why today's scheduled check was skipped for this target (`Daily watch flow` › the pauses), or null. */
  pause?: 'sleeping' | 'energy' | 'food' | 'cap' | 'services' | null;
  nextCheck?: string | null;
  lastStartedDay?: number | null;
  latestResult?: 'first' | 'changed' | 'unchanged' | 'unreadable' | 'no_search' | 'failed' | null;
  latestPriceYocto?: string | null;
  latestReceiptId?: string | null;
  /** Added in the client from the receipt pointer's saved rate, never from a fresh quote. */
  latestNearUsdRate?: string | null;
  /** Added from the owner-only receipt pointer for a changed check. */
  latestChange?: string | null;
  upTo: Price;
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
      /** Private wish is returned only after a fresh chain ownership check. */
      wish: WishTarget | null;
      /** Public chain reserve, carried only in the owner response. */
      wishReserveYocto: string;
      wishActive: boolean;
      willActivity?: Array<{ at: number; code: string }>;
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
      /** A word-free reserve after a cleared shared job crossed a gift. Owner only. */
      oldSharedReserve: { jobHash: string; amountYocto: string } | null;
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
      /** how the pet hires: Auto, or Manual, «Ask me first» (`Hire mode rule`) */
      hireMode: HireMode;
      /** the Manual offer standing, with the worker's name and the price named (`Pet hire flow` › «предложение в Manual»);
       *  null for a pet that sleeps */
      offer: HireOffer | null;
      /** the hire turn on its way: «{name} is asking {worker}…» (a reloaded page learns it here) */
      pendingProgress: { asking: string } | null;
      /** how many of the pet's hires the batch settled (recorded or dropped): a change makes the page read the conversation again */
      hiresSeen: number;
      /** the errand the pet is off on, or the one that came back without a report and is kept for «Try again»; null with none
       *  (`Errand flow`). Only `GET …/state` carries it: the page reads the state once on load and keeps it from the polls. */
      errand?: ErrandState | null;
    } & PetBase &
      MyFeed);

export type HireMode = 'auto' | 'manual';
export interface WishTarget {
  item: OutfitSlug;
  reason: string;
  status: 'active' | 'paused' | 'buying' | 'waiting_day';
  reserveYocto: string;
}
export interface WishRead {
  wish: WishTarget | null;
  reserveYocto: string;
  active: boolean;
  /** Fresh owner read of the latest release operation. An uncertain chain outcome stays unknown. */
  releaseStatus: null | 'unknown' | 'confirmed' | 'failed';
}
export interface WorkInvitation {
  id: string; workerId: string; name: string; label: string | null; price: Price;
  createdAt: number; expiresAt: number;
}
export interface RefusalEvidence {
  id: string; reason: string; at: number; signedEvidenceBase64: string; onChainReceipt: false;
}
/** A price as the server names it: the exact yocto and the cents at the rate of the moment (two significant digits). */
export interface Price {
  yocto: string;
  cents: number;
}
export interface HireOffer {
  worker: string;
  question: string;
  price: Price;
  discounted?: boolean;
}

export type ClosedReason = 'service' | 'budget' | 'pool' | 'daily';
/** `GET /api/hatch` */
export interface HatchStatus {
  open: boolean;
  /** HTTP Date of this Worker response; added by the client seam, not part of the JSON body. */
  serverTime?: string;
  /** The original signed birth is still being checked; no new birth may be sent. */
  pending?: true;
  /** Its transaction was confirmed unsuccessful and no pet was born. */
  failed?: true;
  /** A token proved by the original pending mint transaction, never the historical birth pointer. */
  tokenId?: string;
  reason?: ClosedReason;
  /** ISO time, only for `daily` alone */
  until?: string;
  /** The current owned pet, including one received as a gift. */
  already?: { tokenId: string; name: string };
  ownedCount?: number;
  latestBirth?: { tokenId: string; name: string } | null;
  currentPet?: { tokenId: string; name: string } | null;
  knownPets?: Array<{ tokenId: string; name: string; asleep: boolean }>;
  /** Legacy fields retained for older mock fixtures until their owning changes are rebuilt. */
  noPets?: true;
  lastGifted?: { tokenId: string; name: string };
}

export interface Me {
  accountId: string;
  /** HTTP Date of this Worker response; added by the client seam, not part of the JSON body. */
  serverTime?: string;
  hatched: { tokenId: string; name: string } | null;
  currentPet: { tokenId: string; name: string } | null;
  ownedCount: number;
  lastGifted?: { tokenId: string; name: string };
  /** Private links returned only after the signed-in player's fresh ownership read. */
  knownPets?: Array<{ tokenId: string; name: string; asleep: boolean }>;
  birth?: { open: boolean; reason?: ClosedReason; until?: string };
}

export interface MyPets {
  pets: Array<{ tokenId: string; name: string; born: boolean }>;
  currentPet: { tokenId: string; name: string } | null;
}

export interface GiftLink {
  status: 'none' | 'waiting' | 'accepted' | 'cancelled' | 'transferred';
  code?: string;
  acceptedName?: string | null;
  acceptedAccount?: string | null;
  version?: number;
}

/** Public code read: no giver account or first name leaves the Worker. */
export interface PublicGift {
  tokenId: string;
  name: string;
  fullness: Fullness;
  status: 'waiting' | 'accepted' | 'transferred';
  viewer: 'giver' | 'receiver' | 'visitor';
  errand: { running: true; maxCents: number } | null;
}

export type GiftOutcome =
  | { status: 'ready'; tx: string; receiver: string; acceptedName: string | null }
  | { status: 'pending' | 'unknown' | 'ok' | 'failed'; hash?: string }
  | { status: 'gas_rejected' | 'no_near'; hash?: string; missingYocto: string }
  | { status: 'paused' | 'unavailable'; hash?: string };

export type ThoughtCode =
  | 'ai_unavailable'
  | 'empty_paid'
  | 'asleep'
  | 'tired'
  | 'no_energy'
  | 'too_hungry'
  | 'paused'
  | 'chain_unreachable'
  | 'memory_cleared'
  /** a Manual turn ended on an offer (the offer itself is in the owner view) */
  | 'offer'
  /** the worker's price rose past the one shown: nothing was spent; `PetState.price` is the price now */
  | 'price_rose'
  /** the worker's answer is kept and paid for, the pet's own reply did not come (`ownLost`) */
  | 'own_lost'
  /** advice only: the friend's pet, or the paying pet, cannot answer just now (`Advice flow`) */
  | 'short'
  | 'worker_asleep'
  | 'worker_resting'
  | 'society_refused'
  | 'character_refused'
  | 'screening_failed'
  | 'screening_exhausted'
  | 'screening_capacity'
  /** advice only: the paying pet or the friend's pet is not there any more, or they now share an owner */
  | 'no_pet'
  /** a worker's data source or code did not answer (`Adapter call rule`); on an advice `paid` says whether the paying pet's food paid */
  | 'data_failed'
  /** an errand's job: it ended with no report (the page reads `PetState.errand`), or after the 3 minutes */
  | 'errand_failed'
  | 'late';
/** `society_refused:<ISO time>`: the job's hire was refused before any call for the pair's break (`Society hire flow`) */
export type PetEvent = 'fell_asleep' | 'daily_cap_reached' | 'woke' | `society_refused:${string}`;
export interface Thought {
  id: string;
  text: string;
  cut: 'fuse' | 'food' | 'cap' | null;
  /** the exact price in yocto, «Think hard» only */
  price?: string;
  /** the same price in US cents, at the rate it was made at: what «Thought hard · {price}» shows */
  priceCents?: number;
  reasked?: boolean;
  /** an advice: the friend's pet's answer in its own voice (`Advice flow`); `price` is the fee the paying pet's fullness fell by */
  kind?: 'advice';
  worker?: WorkerRef;
  skilled?: boolean;
  /** an advice that read the worker's data sources: their names, once each (`Adapter call rule` › «advice line») */
  dataLabels?: string[];
  noHireFee?: boolean;
  answerPrice?: string;
  answerPriceCents?: number;
}
/** The pet whose answer a worker line is: its token id (the receipt is `/pet/<token_id>/verify/<id>`) and its name. */
export interface WorkerRef {
  tokenId: string;
  name: string;
}
/** `GET /api/pets/:id/state` — the owner's view plus the outcome of the job asked for. */
export type ErrandForm = 'read' | 'find' | 'check';
export type ErrandFailure = 'unreadable' | 'too_long' | 'search_down' | 'empty' | 'timeout' | 'blocked';
/** `PetState.errand` (`GET /api/pets/:id/state`): the owner's only. `job` is null once the memory was cleared. `done` comes once,
 *  to the first read after an errand whose report a clear took on the way (`Errand flow` › «memory cleared on the way»). */
export type ErrandState =
  | { state: 'away'; form: ErrandForm; job: string | null; sentAt: number }
  | { state: 'done'; cleared: true; priceCents: number }
  | { state: 'failed'; form: ErrandForm; job: string | null; reason: ErrandFailure; cause?: 'unreachable' | 'no_search'; priceCents?: number };
export type PetState = Omit<Extract<PetView, { viewer: 'owner' }>, 'viewer' | 'ownedCount' | 'myFeed' | 'wishReserveYocto' | 'wishActive' | 'willActivity'> & {
  /** the poll's answer carries it only when the tab has a flight to learn of */
  myFeed?: MyFeed['myFeed'];
  pending?: boolean;
  /** what the job asked about is */
  jobKind?: StateJobKind;
  thought?: Thought;
  code?: ThoughtCode;
  /** with `own_lost`, the outcome of the tab's own job only: the turn «Try again» finishes. A reload does not carry it. */
  ownLost?: { turn: string };
  /** with `data_failed` of an advice: whether the paying pet's food paid for the data call (past three) */
  paid?: boolean;
  /** with `price_rose`: the worker's price now */
  price?: Price;
  refusalUntil?: string;
  events: PetEvent[];
  characterRefusal?: { id: string; reason: string };
  /** the giver's open gift link (`GET …/state`): waiting for a friend or accepted, or null; the poll is how an open page learns of an acceptance */
  gift: { code: string; status: 'waiting' | 'accepted'; acceptedName: string | null; acceptedAccount: string | null; version: number } | null;
  /** with `woke`: the name of the friend whose meal woke the pet — «{friend} fed {name}.»; `'A friend'` for a nameless
   *  feeder. Sent when the wake came from a friend's feeding (`wakes` below the pet's counter). */
  friend?: string;
};
/** What a hire cost, under the line it belongs to: the fee in yocto and in cents at the rate it was made, or `noFee` when the
 *  contract did not take the hire's record (`Pet hire flow` › «найм не записан в сети»). `worker` is the worker's name. */
export type HireMeta = { worker: string; price: string; priceCents: number; mode?: HireMode } | { worker: string; noFee: true; answerPrice?: string | null; answerPriceCents?: number | null };
/** What an errand's report holds (`GET …/conversation`, a `pet` line with a `report`): `sources` are the results it cites, at most 5,
 *  `{ label: host, url }` (a read of pasted text: `{ label: 'Your text' }`); `verdict` only for «Is it true?»; `missed` — the data
 *  sources that did not answer, and `{ code: true }` for the skill's code that did not (`Adapter call rule` › «data failed in an errand, code»). */
export interface ErrandReport {
  form: ErrandForm;
  sources: Array<{ label: string; url?: string }>;
  verdict: 'true' | 'false' | 'unclear' | null;
  searches: number;
  priceCents: number;
  missed: Array<string | { code: true }>;
}
export interface ConversationLine {
  id: string;
  /** `event`: the line of a stage change (`Growth flow`) or a hire that did not happen (`code`), the game's, not the pet's.
   *  `worker`: the words of another pet, in its voice. `error`: an errand that came back with nothing (`code` `errand_empty`). */
  who: 'player' | 'pet' | 'event' | 'worker' | 'error';
  /** absent from an event that carries a `code` */
  text?: string;
  /** the errand's form above the job under «You» */
  kicker?: ErrandForm;
  /** a `pet` line that is an errand's report */
  report?: ErrandReport;
  /** the data sources a worker's answer read, once each */
  dataLabels?: string[];
  at: number;
  cut?: Thought['cut'];
  price?: string;
  priceCents?: number;
  /** the pet's own question to a worker: the client writes «To {worker}: {question}» */
  hireTo?: string;
  /** `worker`, and an event with a `code`: whose answer, or which hire */
  worker?: { tokenId: string | null; name: string | null };
  skilled?: boolean;
  /** `event`: `hire_failed` — {worker} couldn't help just now; `hire_empty` — {worker} came up empty; `hire_data_failed` — its data
   *  didn't answer (`…_paid`: and the pet's food paid for the try). `error`: `errand_empty` (`priceCents` is what the errand cost) */
  code?: 'hire_failed' | 'hire_empty' | 'hire_data_failed' | 'hire_data_failed_paid' | 'society_refused' | 'character_refused' | 'errand_empty' | 'gift';
  refusalUntil?: string;
  /** Private payer-only refusal joined after a fresh owner check; absent for a previous owner's turn. */
  refusal?: { id: string; reason: string };
  /** A refusal's mode when it happened, independent of the owner's current switch. */
  hireMode?: HireMode;
  previousOwner?: boolean;
  name?: string;
  hire?: HireMeta;
}
export interface Conversation {
  lines: ConversationLine[];
  more: boolean;
  before: number | null;
}

/** `GET /api/sign-in` (Sign-in data): what a browser with no session may do before Google. Nothing about players. */
export type SignInGate = { state: 'open' } | { state: 'closed_new' | 'closed_all'; until: string };

/** Why the server did not open a session after Google. `mau` and `ceiling` have `until` (next UTC month); judge code
 *  refusals use their own response code and keep the public page readable. */
export interface SignInRefusal {
  reason: 'mau' | 'ceiling' | 'judge_invalid' | 'judge_exhausted' | 'judge_expired';
  until?: string;
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
   *  the pet's work of the day before as data — who hired it and the cents of food it earned — the client writes the line
   *  (`Work diary rule`); null when nobody hired it */
  | { kind: 'text'; id: string; lines: string[]; socialLines?: string[]; willLine?: string; question: string | null; work: DiaryWork | null; previousOwner?: boolean }
  | { kind: 'first' | 'cleared' | 'writing' | 'asleep' | 'failed' };

export interface DiaryWork {
  hirers: string[];
  /** the food it earned, in US cents (two significant digits) */
  cents: number;
}

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
  watch?: Array<{ target: string; change: string; sources: string[]; priceYocto: string; receiptId: string }>;
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

/** The owner's current-generation, bounded notes. The Worker has already checked chain ownership. */
export interface ExperienceNotes {
  tokenId: string;
  generation: number;
  notes: Array<{ id: string; text: string; proposedField: string; sourceReportId: string; sourceForm?: ErrandForm; at: number; approved: boolean }>;
  field: { noteId: string; wording: string; sourceReportId: string | null } | null;
}

/** Public Worker facts; the client independently reads the count from the NEAR RPC seam. */
export interface WorkRecord {
  tokenId: string;
  counts: { paidHires: number; completedErrands: number; countedSince: number };
  field: { wording: string; sourceReportId: string } | null;
  receipts: Array<{ thoughtId: string; tokenId: string | null; debitTxHash: string; at: number; kind: string }>;
}

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
  outcome: { id: string; item: OutfitSlug; status: 'bought' | 'failed'; code: string | null; source?: 'owner' | 'pet_wish' } | null;
}

/** `GET /api/pets/:id/advice?payer=` (`Advice flow`): what the friend's page needs to draw the column, whole. The price is the
 *  hire's fee now; `payer.state` is how the paying pet stands (`short`: after the price it could not stay awake; `tired`: its
 *  day's limit). `pending` is the payer's advice to this worker on its way, `last` its newest one that still holds its words. */
export interface AdviceRead {
  price: Price;
  discounted?: boolean;
  refusalUntil?: string;
  /** The worker's current UTC screening capacity and, when exhausted, the Worker's next UTC midnight. */
  screeningAvailable: boolean;
  screeningResetAt: string | null;
  skilled: boolean;
  workerAsleep: boolean;
  /** the friend's pet has no energy left today (or ten answers): when it is back, ISO */
  resting: { until: string } | null;
  payer: { tokenId: string; name: string; state: 'ok' | 'asleep' | 'short' | 'tired'; until: string | null };
  /** a skilled worker above its starting price: when the price falls back, ISO */
  dropsAt: string | null;
  pending: { job: string; question: string } | null;
  last: { id: string; question: string; text: string; skilled: boolean; price?: string; priceCents?: number; noHireFee?: boolean; answerPrice?: string; answerPriceCents?: number; dataLabels?: string[] } | null;
  /** the services are on a pause: «several at once» draws its line first, and the page reads again until it lifts */
  paused: boolean;
  /** the names of the worker's data sources with a tool ticked: «Whoever runs {labels} sees what {name} looks up there…» */
  labels?: string[];
}

/** `GET /api/pets/:id/skill` (the owner's only): the skill as written, decrypted in memory for this answer. */
export interface SkillText {
  label: string;
  instruction: string;
}

/** A parameter of a tool as the sheet words it («Takes: month (number), day (number).»). */
export interface ToolParam {
  name: string;
  type: 'number' | 'integer' | 'boolean' | 'pick' | 'text';
  /** a `pick`: the values the tool accepts */
  options?: string[];
  /** a `text`: the longest value the tool takes, when its schema says */
  maxLength?: number;
  required: boolean;
}

/** A tool of a data source, or a function of the skill's code, as tested. `tickable: false` takes free text — never called. */
export interface ToolView {
  name: string;
  description: string;
  params: ToolParam[];
  tickable: boolean;
  reason?: 'free_text';
  ticked?: boolean;
}

/** A data source of the skill as the owner sees it: never its address (`publicAddress` only for a copy from the catalog). */
export interface SourceView {
  id: string;
  label: string;
  tools: ToolView[];
  publicAddress?: string;
  /** its entry stands in the catalog */
  published: boolean;
  /** a copy whose entry has left the catalog */
  catalogGone: boolean;
  /** it came with a gift: the new owner cannot publish it */
  gift: boolean;
}

/** `GET /api/pets/:id/skill`: the skill, its data sources and the functions its code declares. */
export interface SkillRead {
  skill: SkillText | null;
  sources: SourceView[];
  code: { functions: ToolView[] } | null;
}

/** `GET /api/adapters`: one entry of the catalog, newest first. */
export interface CatalogEntryView {
  id: string;
  name: string;
  address: string;
  tools: Array<{ name: string; description: string; params: ToolParam[]; tickable: boolean; reason?: 'free_text' }>;
  petId: string;
  petName: string;
  publishedAt: number;
}

/** `GET /api/pets/:id/code` (the owner's only): the code, the functions it declares, the test runs left today. */
export interface CodeRead {
  code: string | null;
  functions: ToolView[];
  testsLeft: number;
}

/** `POST /api/pets/:id/code/test`: `undeclared` — the function is not one the code declares (no run was used). */
export type CodeTestResult =
  | { outcome: 'ok'; output: string; functions: ToolView[] }
  | { outcome: 'limit' }
  | { outcome: 'error'; error: string }
  | { outcome: 'undeclared'; fn: string };

/** What stops an errand at «Send» (`Errand flow`): the first that holds, in the order of «several blocks at once». */
export interface ErrandBlock {
  reason: 'paused' | 'food' | 'asleep' | 'energy' | 'cap';
  /** the price a start needs (`food`, `asleep`): «This errand needs up to {price} of food» */
  need?: Price;
  /** the next 00:00 UTC, ISO (`energy`, `cap`) */
  until?: string;
}

/** `GET /api/pets/:id/errand?form=`: what Errand sheet shows before «Send». `read.base` and `read.perToken` are yocto: the client
 *  prices a pasted text with no request per keystroke. */
export interface ErrandQuote {
  form: ErrandForm;
  paused: boolean;
  read: { typical: Price; base: string; perToken: string };
  search: { upTo: Price; full: boolean; short: boolean; searches: 1 | 2 | 3; allowance: 1 | 2 | 3 };
  block: ErrandBlock | null;
  /** the names of the skill's data sources */
  labels: string[];
  sharedNeeded: Price;
}

/** The public link read. The Worker includes report fields only for the owner or a confirmed contributor. */
export type SharedErrand = { tokenId: string; name: string; state: 'empty' } | {
  tokenId: string;
  name: string;
  state: 'opening' | 'funding' | 'running' | 'reported' | 'failed' | 'closed';
  form: 'find' | 'check';
  job: string;
  viewer: 'owner' | 'sponsor' | 'signed-out' | 'visitor';
  funded: string;
  needed: string;
  chainState: 'Funding' | 'Running' | 'Transferred' | 'Settled' | 'Closed';
  fullness: Fullness;
  report?: string | null;
  sources?: Array<{ label: string; url?: string }> | null;
  receiptId?: string | null;
};

/** Owner-only GET /api/pets/:id/relationships; no private row survives outside the open screen. */
export interface RelationshipSummary {
  tokenId: string;
  name: string;
  relationships: Array<{ tokenId: string; name: string; stance: 'neutral' | 'liked' | 'strained'; breakUntil: number | null }>;
}

export interface WorkerApi {
  wish(token: Token, tokenId: string): Promise<WishRead>;
  cancelWish(token: Token, tokenId: string): Promise<{ status: 'released' | 'pending' }>;
  continueWish(token: Token, tokenId: string): Promise<{ status: 'active' | 'pending' } | { code: 'wish_pending' }>;
  invitations(token: Token, tokenId: string): Promise<{ invitations: WorkInvitation[] }>;
  acceptInvitation(token: Token, tokenId: string, invitationId: string): Promise<{ workerId: string; name: string; label: string | null; price: Price; question: '' }>;
  dismissInvitation(token: Token, tokenId: string, invitationId: string): Promise<{ status: 'dismissed' }>;
  refusalEvidence(token: Token, tokenId: string, refusalId: string): Promise<RefusalEvidence>;
  relationships(token: Token, tokenId: string): Promise<RelationshipSummary>;
  workRecord(tokenId: string): Promise<WorkRecord>;
  experienceRecordOpened(ids: { tabId: string; playerId: string; petId: string }): Promise<void>;
  societyDiarySeen(token: Token, tokenId: string, ids: { eventId: string; tabId: string; playerId: string; petId: string }): Promise<void>;
  experience(token: Token, tokenId: string): Promise<ExperienceNotes>;
  approveExperience(token: Token, tokenId: string, noteId: string, approved: boolean, generation: number): Promise<{ noteId: string; approved: boolean; generation: number }>;
  publishExperienceField(token: Token, tokenId: string, noteId: string, generation: number): Promise<{ noteId: string; published: true }>;
  health(): Promise<Health>;
  showcase(): Promise<ShowcaseCopy>;
  hireBoard(token: Token): Promise<HireBoard>;
  me(token: Token): Promise<Me>;
  myPets(token: Token): Promise<MyPets>;
  publicGift(token: Token, code: string): Promise<PublicGift>;
  acceptGift(token: Token, code: string): Promise<{ status: 'accepted'; tokenId: string }>;
  giftLink(token: Token, tokenId: string): Promise<GiftLink>;
  createGift(token: Token, tokenId: string): Promise<GiftLink>;
  cancelGift(token: Token, tokenId: string): Promise<GiftLink>;
  prepareGift(token: Token, tokenId: string): Promise<GiftOutcome>;
  sendGift(token: Token, tokenId: string, body: { tx: string; signature: string }): Promise<GiftOutcome>;
  giftOutcome(token: Token, tokenId: string): Promise<GiftOutcome>;
  /** `look`: the page's own repeat while it stands on a pause (`GET /api/hatch?look=1`). The server counts a closed hatch
   *  only for a load or a tap, never for a look. */
  hatchStatus(token: Token, opts?: { look?: boolean }): Promise<HatchStatus>;
  /** `name` is the raw text as typed; the server cleans it again. Resolves `{ tokenId }`. */
  hatch(token: Token, name: string): Promise<{ tokenId: string } | { pending: true }>;
  pet(token: Token, tokenId: string): Promise<PetView>;
  cardLines(token: Token, tokenId: string): Promise<{ lines: Array<{ id: string; text: string }> }>;
  cardSource(token: Token, tokenId: string, body: { kind: CardKind; thoughtId?: string }): Promise<CardSource>;
  cardShared(token: Token, body: { at: number; kind: CardKind; delivery: 'save' | 'share'; tabId: string; playerId: string; petId: string }): Promise<void>;
  verificationIndex(tokenId: string): Promise<VerificationIndex>;
  verificationThought(token: Token, tokenId: string, thoughtId: string): Promise<VerificationThought>;
  publishReceipt(token: Token, tokenId: string, thoughtId: string, operationId: string): Promise<{ code: string; path: string }>;
  sharedReceipt(code: string): Promise<SharedReceipt>;
  receiptBytes(code: string, n: number, part: 'request' | 'reply'): Promise<Uint8Array>;
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
  session(token: Token, body: { fresh: boolean; from?: 'link' | 'home'; judgeCode?: string }): Promise<SessionResult>;
  /** Public, body-only check. No place is reserved. */
  judgeCheck(code: string): Promise<{ ok: true }>;
  /** «Sign out» on the server (ADR-022); `204`. Takes at most `END_SESSION_TIMEOUT_MS`. */
  endSession(token: Token): Promise<void>;
  /** The state of the sign-in, read before Google. Sent with no token: a stale one would be a `401`. */
  signInState(): Promise<SignInGate>;
  /** The owner erases the pet's memory. */
  clearMemory(token: Token, tokenId: string, approval?: { public_key: string; signature: string }): Promise<{ ok: true } | { code: 'close_retry' }>;
  /** Feed sheet's state, whole. Refusals: `401 signed_out`, `404 no_pet`, `500 rate_missing`. */
  feedSheet(token: Token, tokenId: string): Promise<FeedSheetAnswer>;
  /** The unsigned `pet_feed` as base64, for the browser to check and sign. Refusals: `409 pending`, `409 short` (body holds
   *  `sheet`), `502 feed_not_built`, `503 chain_unreachable`, `404 no_pet`. */
  buildFeed(token: Token, tokenId: string, portion: PortionNear, code?: string): Promise<{ tx: string }>;
  /** The signed portion (both base64). Holds up to `FEED_SEND_TIMEOUT_MS`. Refusals: `400 bad_tx`, `409 pending`, `503`. */
  sendFeed(token: Token, tokenId: string, body: { tx: string; signature: string; code?: string }): Promise<FeedOutcome>;
  /** The outcome for a tab that has no signed bytes (a reload, a snack). */
  feedOutcome(token: Token, tokenId: string, body: { id: string; source: FeedSource }): Promise<FeedOutcome>;
  /** The free snack, sent by the server. Refusals: `409 snack_gone` (body holds `sheet`), `409 pending`, `503`. */
  snack(token: Token, tokenId: string, code?: string): Promise<FeedOutcome>;
  wallet(token: Token): Promise<WalletInfo>;
  /** The Diary screen's data. Marks nothing; also for an asleep pet. Refusals: `401 signed_out`, `403 not_owner`, `404 no_pet`,
   *  `429 rate_limited`, `503 chain_unreachable`. */
  diary(token: Token, tokenId: string): Promise<DiaryView>;
  watch(token: Token, tokenId: string): Promise<WatchRead>;
  saveWatch(token: Token, tokenId: string, target: string): Promise<WatchRead>;
  resumeWatch(token: Token, tokenId: string): Promise<WatchRead>;
  stopWatch(token: Token, tokenId: string): Promise<{ target: null }>;
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
  /** The owner switches how the pet hires. Refusals: `409 asleep`, `403 not_owner`, `404 no_pet`, `400 bad_request`, `503 chain_unreachable`. */
  setHireMode(token: Token, tokenId: string, mode: HireMode): Promise<{ mode: HireMode }>;
  /** «Ask {worker}» on a Manual offer, with the price the card named (yocto): the job. Refusals: `409 paused | no_offer`, `400 bad_request`. */
  askOffer(token: Token, tokenId: string, price: string): Promise<{ job: string }>;
  /** «No thanks»: the job (the pet answers on its own). Refusals: `409 paused | no_offer`. */
  declineOffer(token: Token, tokenId: string): Promise<{ job: string }>;
  /** «Try again» under a lost own reply: the job. Refusals: `409 paused | no_hire`. */
  finishHire(token: Token, tokenId: string): Promise<{ job: string }>;
  /** The advice column of a friend's page, for the guest's pet `payer`. Refusals: `403 not_payer`, `404 no_pet`, `409 same_owner`,
   *  `400 bad_request`, `401 signed_out`, `503 chain_unreachable`. */
  advice(token: Token, tokenId: string, payer: string): Promise<AdviceRead>;
  /** The question, at the price the button showed (yocto, a ceiling): the payer's job. Refusals: `409 paused | pending | same_owner`,
   *  `403 not_payer`, `400 bad_request`. */
  askAdvice(token: Token, tokenId: string, body: { payer: string; text: string; price: string }): Promise<{ job: string }>;
  /** The owner's skill, as written; `skill: null` with none, with its data sources and the functions of its code. Refusals: `403
   *  not_owner`, `500 skill_unreadable`, `503 chain_unreachable`. */
  skill(token: Token, tokenId: string): Promise<SkillRead>;
  /** Saves it (the label cleaned). Refusals: `400 bad_label | bad_request`, `500 skill_unreadable`, `403 not_owner`, `503`. */
  saveSkill(token: Token, tokenId: string, body: SkillText): Promise<{ skill: { label: string } }>;
  /** «Forget this skill». */
  forgetSkill(token: Token, tokenId: string): Promise<{ skill: null }>;

  // — add-pet-errands —
  /** The quote of Errand sheet for `form`. Refusals: `403 not_owner`, `404 no_pet`, `400 bad_request`, `401`, `503 chain_unreachable`. */
  errand(token: Token, tokenId: string, form: ErrandForm): Promise<ErrandQuote>;
  prepareSharedErrand(token: Token, tokenId: string, body: { form: 'find' | 'check'; job: string }): Promise<{ url: string; code: string; needed: Price; form: 'find' | 'check'; job: string }>;
  sharedErrand(token: Token, tokenId: string, code: string): Promise<SharedErrand>;
  sharedErrandEvent(token: Token, tokenId: string, code: string, body: { kind: 'shared' } | { kind: 'opened'; device: 'desktop' | 'phone'; inApp: 'x' | 'telegram' | 'none' }): Promise<void>;
  closeSharedErrand(token: Token, tokenId: string, code: string, approval: { public_key: string; signature: string }): Promise<{ ok: true }>;
  releaseSharedReserve(token: Token, tokenId: string, approval: { public_key: string; signature: string }): Promise<{ ok: true } | { code: 'close_retry' }>;
  /** «Send»: the desk's job (`202`). Refusals: `409 blocked` (the body's `block`), `409 away`, `400 bad_request`. */
  sendErrand(token: Token, tokenId: string, body: { form: ErrandForm; job: string }): Promise<{ job: string }>;
  /** The catalog of adapters, anyone's. */
  adapters(token: Token): Promise<{ entries: CatalogEntryView[] }>;
  /** «Check address»: the test call, nothing stored. Refusals: `422 address_failed`, `400 bad_request`. */
  checkSource(token: Token, tokenId: string, address: string): Promise<{ tools: ToolView[] }>;
  /** Connect: an own `address` or a catalog `entry`, the ticks. Refusals: `422 address_failed`, `409 no_skill | full`, `404 no_entry`,
   *  `400 bad_label | bad_request`. */
  saveSource(token: Token, tokenId: string, body: { label: string; address?: string; entry?: string; ticks: string[] }): Promise<{ source: SourceView }>;
  /** Edit a connected source: its name and ticks. Refusals: `422 address_failed`, `404 no_source`, `400 bad_label | bad_request`. */
  editSource(token: Token, tokenId: string, sid: string, body: { label: string; ticks: string[] }): Promise<{ source: SourceView }>;
  removeSource(token: Token, tokenId: string, sid: string): Promise<{ removed: true }>;
  /** Publish to the catalog. Refusals: `409 copy | gift | insult`, `404 no_source`. */
  publishSource(token: Token, tokenId: string, sid: string): Promise<{ source: SourceView }>;
  unpublishSource(token: Token, tokenId: string, sid: string): Promise<{ source: SourceView }>;
  /** The skill's code, as written. Refusals: `403 not_owner`, `500 skill_unreadable`. */
  code(token: Token, tokenId: string): Promise<CodeRead>;
  /** «Test run». Refusals: `429 tests_used_up | game_capped`, `409 no_skill`, `400 bad_request`. */
  testCode(token: Token, tokenId: string, body: { code: string; fn: string; values: string }): Promise<CodeTestResult>;
  /** «Save code»: only the code that passed a test run today. Refusals: `409 not_tested | no_skill`, `400 bad_request`. */
  saveCode(token: Token, tokenId: string, body: { code: string; ticks: string[] }): Promise<{ code: { functions: ToolView[] } }>;
  removeCode(token: Token, tokenId: string): Promise<{ removed: true }>;
}
