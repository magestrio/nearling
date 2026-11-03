import { createElement, type ComponentType, type ReactNode } from 'react';

// The registry of the Pet screen's parts that belong to other changes (design.md › «Швы для следующих изменений»).
// A slot is a piece the screen draws where the frames draw it: the energy, the stage and traits, the hiring mode, the
// guest's advice, the Account button. An action is what a control of this screen does when its purpose is another
// change's surface: «Feed {name}», «Give {name} away», «My pets». The change that owns the part registers it; until it
// does, a slot draws nothing and an action does nothing — the control stays where the frame has it.
export type Viewer = 'owner' | 'guest' | 'visitor';

/** What only the owner sees of the pet's life (add-pet-life › Pet life display rule): given by the owner's page alone, so a
 *  slot that needs it draws nothing for a guest or a visitor. */
export interface Life {
  stage: 'baby' | 'teen' | 'adult';
  traits: string[];
  energy: number;
}

/** How the owner's pet hires and the switch for it (add-pet-work › Hire mode rule): given by the owner's page alone. */
export interface Hiring {
  mode: 'auto' | 'manual';
  set: (mode: 'auto' | 'manual') => void;
}

/** What the guest's advice column needs of the page it stands on (add-pet-work › Advice flow): given by the guest page with a pet of
 *  its own alone. */
export interface Advice {
  /** the player's own pet that pays */
  payer: { tokenId: string; name: string };
  /** a session token (null: signed out) or a `401` thrown when the session ended */
  tokenOf: () => Promise<string | null>;
  /** a failed request of the column: the connection line of the page, a lost session, a dead address */
  report: (e: unknown, retry: () => void) => void;
  /** the payer is not the player's pet any more: the page reads who the player's current pet is again */
  payerChanged: () => void;
  /** the friend's pet is read again (it fell asleep under a question, the price moved) */
  look: () => void;
  /** what the column tells the page it stands on: a question is on its way (the friend's pet thinks, its face too) and the own pet
   *  can't pay («Feed your {my_pet}» is the one filled action, «Feed {name}» steps down) */
  onStatus: (status: { thinking: boolean; cantPay: boolean }) => void;
  /** the Feed sheet or another sheet covers the page: the column is out of reach */
  covered: boolean;
  /** «Check it's really {name}», the card before the first line of the phone's log */
  check: ReactNode;
  /** the page's «Can't reach {name}» line, for a sign-in that could not be read */
  offline: string;
  /** the text a sign-in from the ended-session line brought back, to put in the field once */
  carried: string | null;
  takeCarried: () => void;
}

export interface SlotProps {
  tokenId: string;
  name: string;
  viewer: Viewer;
  asleep: boolean;
  life?: Life;
  hiring?: Hiring;
  advice?: Advice;
  /** the slot stands in a row (under the desktop's input), not stacked (the phone's card) */
  row?: boolean;
}

export type SlotName = 'energy' | 'growth' | 'hiring' | 'advice' | 'account';

const slots = new Map<SlotName, ComponentType<SlotProps>>();

export function registerSlot(name: SlotName, component: ComponentType<SlotProps>): void {
  slots.set(name, component);
}

/** Whether the slot's change is built: a layout that leaves it room waits for it. */
export function hasSlot(name: SlotName): boolean {
  return slots.has(name);
}

/** What the slot draws, or nothing while its change is not built. */
export function Slot({ slot, ...props }: { slot: SlotName } & SlotProps): ReactNode {
  const component = slots.get(slot);
  return component ? createElement(component, props) : null;
}

export type ActionName = 'feed' | 'gift' | 'myPets';

export interface ActionContext {
  tokenId: string;
  name: string;
  viewer: Viewer;
  /** `tokenId` is not the page's pet: the own pet's «Feed your {my_pet}» over a friend's page (add-feeding) */
  elsewhere?: boolean;
}

type Handler = (context: ActionContext) => void;
const actions = new Map<ActionName, Handler>();

export function registerAction(name: ActionName, handler: Handler): void {
  actions.set(name, handler);
}

/** Runs the owning change's handler; false when there is none yet. */
export function runAction(name: ActionName, context: ActionContext): boolean {
  const handler = actions.get(name);
  if (!handler) return false;
  handler(context);
  return true;
}

// «Feed {name}» tapped without a session: the place and the action wait in the tab through the sign-in, and the
// screen the player returns to runs the action once (add-pet › Pet screen › «signed-out»).
// The line of an ended session on Skill sheet, Errand sheet, Adapter sheet or Skill code sheet does the same with `skill`, `errand`,
// `adapter` or `code`: the owner's page (or the catalog page for `adapter`) opens that sheet again.
export type PendingAction = 'feed' | 'skill' | 'errand' | 'adapter' | 'code';
let pendingAction: PendingAction | null = null;

export function queueAction(action: PendingAction | undefined): void {
  pendingAction = action ?? null;
}

export function peekPendingAction(): PendingAction | null {
  return pendingAction;
}

export function takePendingAction(): PendingAction | null {
  const action = pendingAction;
  pendingAction = null;
  return action;
}
