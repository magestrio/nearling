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

export interface SlotProps {
  tokenId: string;
  name: string;
  viewer: Viewer;
  asleep: boolean;
  life?: Life;
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
let pendingAction: 'feed' | null = null;

export function queueAction(action: 'feed' | undefined): void {
  pendingAction = action ?? null;
}

export function takePendingAction(): 'feed' | null {
  const action = pendingAction;
  pendingAction = null;
  return action;
}
