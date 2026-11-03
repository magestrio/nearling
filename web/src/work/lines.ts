import { formatCents } from '../lib/price';
import type { HireMeta, HireMode } from '../seams/worker-types';

// Every word of add-pet-work that the Pet screen draws, verbatim from the Scenarios of `Hire mode rule` and `Pet hire flow`
// (and the frames' copy): {name} is the hiring pet, {worker} the pet it asks, {price} cents at the rate of the moment.

export const HIRING_LABEL = 'Hiring';
export const HIRING_OPTIONS: Array<{ value: HireMode; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'manual', label: 'Ask me first' },
];

/** `Hire mode rule` › Auto / Ask me first: the line under the switch. */
export function hiringLine(mode: HireMode, name: string): string {
  return mode === 'auto'
    ? `Hiring: Auto — ${name} asks pets it knows when they can help, then tells you what it cost.`
    : `Hiring: Ask me first — ${name} checks with you before paying another pet.`;
}

/** `Pet hire flow` › спрашивает: «{name} is thinking…» turns into this. */
export const askingLine = (name: string, worker: string) => `${name} is asking ${worker}…`;

/** `Pet hire flow` › вопрос найма в разговоре. */
export const toLine = (worker: string, question: string) => `To ${worker}: ${question}`;

/** `Pet hire flow` › спросил / найм не записан в сети: the small line under the answer. */
export function askedMeta(name: string, hire: HireMeta): string {
  return 'noFee' in hire ? `${name} asked ${hire.worker} · no fee` : `${name} asked ${hire.worker} · ${formatCents(hire.priceCents)}`;
}

/** `Pet hire flow` › найм не состоялся / работник ответил пусто: the game's line before the pet's own answer. */
export const hireFailedLine = (name: string, worker: string) => `${worker} couldn't help just now, so ${name} answered on its own. No fee was paid.`;
export const hireEmptyLine = (name: string, worker: string) =>
  `${worker} came up empty, so ${name} answered on its own. No fee was paid — the try used a little of ${name}'s food.`;

/** `Pet hire flow` › предложение в Manual / price rose on an offer. */
export const offerLine = (name: string, worker: string, cents: number) => `${name} wants to ask ${worker} about this. It costs ${formatCents(cents)}.`;
export const offerRoseLine = (worker: string, cents: number) => `${worker} is busier now — it's ${formatCents(cents)}. Nothing was spent.`;
export const askWorker = (worker: string) => `Ask ${worker}`;
export const NO_THANKS = 'No thanks';

/** `Pet hire flow` › свой ответ не пришёл. */
export const ownLostLine = (name: string, worker: string) =>
  `${name} lost its own reply. ${worker}'s answer is kept and paid for — Try again finishes ${name}'s reply, with no new fee.`;

/** `Worker rule` › answer with a skill: under the answer of a worker a private skill shaped. */
export const SKILLED_LINE = "A private skill shaped this answer. Checking the thought can't show that part.";

/** `Pet hire flow` › hire memory cleared on the way: said in the cleared conversation. */
export const hireClearedLine = (name: string) => `${name}'s memory was cleared, so this answer wasn't kept. It used a little of ${name}'s food.`;

// The guest's advice column (`Advice flow`): {name} is the pet asked, {my_pet} the player's own pet that pays.

export const advicePlaceholder = (name: string) => `Ask ${name} for advice…`;
export const adviceButton = (name: string) => `Ask ${name}`;
export const adviceLabel = (name: string) => `Advice from ${name}`;
export const paysLine = (myPet: string, name: string) => `Your ${myPet} pays from its food. ${name}'s owner won't see your question or the answer.`;
/** `Advice flow` › advice from a pet with a skill: also under the pays line. */
export const skillShapesLine = (name: string) => `${name} has a private skill that shapes its answers. Checking the thought can't show that part.`;
/** `Advice flow` › price rose. */
export const priceRoseLine = (name: string, cents: number) => `${name} is busier now — it's ${formatCents(cents)}. Your question is still here, and nothing was spent.`;
/** `Advice flow` › ответ: under the answer. */
export const savedLine = (myPet: string) => `Saved in your ${myPet}'s chat — only its owner can see it.`;
/** `Advice flow` › пустой ответ работника. */
export const adviceEmptyLine = (name: string, myPet: string) =>
  `${name} lost that answer. No fee was paid, but the try used a little of your ${myPet}'s food. Your question is kept — try again.`;
/** `Advice flow` › свой питомец не может заплатить. */
export const cantPayLine = (name: string, cents: number, myPet: string) => `Asking ${name} costs ${formatCents(cents)}. Your ${myPet} needs a meal before it can pay.`;
export const priceDropsLine = (name: string, time: string) => `${name}'s price drops back at ${time}.`;
export const feedMine = (myPet: string) => `Feed your ${myPet}`;
/** `Advice flow` › работник уснул. */
export const workerAsleepLine = (name: string) => `${name} is asleep — food from you would wake ${name} up.`;
export const couldntHelpLine = (name: string) => `${name} couldn't help just now. Nothing was spent — your question is kept.`;
/** `Advice flow` › свой питомец устал. */
export const myPetTiredLine = (myPet: string, time: string) => `Your ${myPet} is tired for today. You can ask again at ${time}.`;
/** `add-pet-life` › `Energy rule` › совет питомцу на нуле. */
export const workerRestingLine = (name: string, time: string) => `${name} is resting until ${time}. Nothing was spent — ask again after that.`;
// Skill sheet (`Skill sheet screen`, `Skill writing flow`): {name} is the pet that is taught.

export const skillTitle = (name: string, written: boolean) => (written ? `${name}'s skill` : `Teach ${name} a skill`);
export const skillLabelField = (name: string) => `What is ${name} good at?`;
export const SKILL_LABEL_HINT = 'Anyone can see this — e.g. plot twists';
export const skillInstructionField = (name: string) => `How should ${name} do it?`;
export const SKILL_INSTRUCTION_HINT = 'Only you can read this.';
export const SKILL_SAVE = 'Save skill';
export const SKILL_FORGET = 'Forget this skill';
/** `Skill sheet screen` › what the sheet says. */
export const skillSaysLines = (name: string, time: string): string[] => [
  `${name} uses this only when it answers for others or runs your errands, never in your chats. Other players can't read it, but we send it to NEAR AI with each job, and a clever question could coax out the gist — so leave out anything secret.`,
  `The game sets what others pay in food: it climbs with each job today and resets at ${time}.`,
];
/** `Skill sheet screen` › error. */
export const skillOpenFailedLine = (name: string) => `We couldn't open ${name}'s skill right now. Try again in a moment.`;
/** `Skill writing flow`. */
export const skillSavedLine = (name: string) => `Saved. ${name} will use this from its next job.`;
export const SKILL_LABEL_REJECTED = "Let's pick different words.";
export const skillForgottenLine = (name: string) => `${name} forgot this skill. Changed your mind? Save it again before you close this.`;
export const SKILL_SAVE_FAILED = "We couldn't save that. Nothing's lost — try again.";

/** `Advice flow` › memory cleared on the way. */
export const adviceClearedLine = (myPet: string) => `${myPet}'s memory was cleared, so this answer wasn't kept. It used a little of your ${myPet}'s food.`;
