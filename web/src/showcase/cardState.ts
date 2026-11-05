import type { CardKind, CardSource } from '../seams/worker-types';

/** One Pet page's tab-only card draft. The owner and the retained source are checked again by the Worker before delivery. */
export type CardDraft =
  | { phase: 'closed' }
  | { phase: 'selecting'; kind: CardKind; thoughtId: string | null; note?: string }
  | { phase: 'drawing'; kind: CardKind; source: CardSource; thoughtId: string | null }
  | { phase: 'ready'; kind: CardKind; source: CardSource; thoughtId: string | null; image: Blob }
  | { phase: 'error'; kind: CardKind; source: CardSource; thoughtId: string | null };

export type CardAction =
  | { type: 'open'; kind: CardKind; thoughtId?: string }
  | { type: 'choose'; thoughtId: string }
  | { type: 'source'; source: CardSource }
  | { type: 'drawn'; image: Blob }
  | { type: 'draw_failed' }
  | { type: 'retry' }
  | { type: 'erased' }
  | { type: 'reset' };

export const emptyCard: CardDraft = { phase: 'closed' };

export function cardState(state: CardDraft, action: CardAction): CardDraft {
  switch (action.type) {
    case 'reset': return emptyCard;
    case 'open': return { phase: 'selecting', kind: action.kind, thoughtId: action.thoughtId ?? null };
    case 'choose': return state.phase === 'selecting' && state.kind === 'thought' ? { ...state, thoughtId: action.thoughtId, note: undefined } : state;
    case 'source': return state.phase === 'selecting' && state.kind === action.source.kind
      ? { phase: 'drawing', kind: state.kind, source: action.source, thoughtId: state.thoughtId } : state;
    case 'drawn': return state.phase === 'drawing' ? { ...state, phase: 'ready', image: action.image } : state;
    case 'draw_failed': return state.phase === 'drawing' ? { ...state, phase: 'error' } : state;
    case 'retry': return state.phase === 'error' ? { ...state, phase: 'drawing' } : state;
    case 'erased': return state.phase === 'closed' ? state : { phase: 'selecting', kind: 'thought', thoughtId: null, note: 'That thought is no longer here. Choose another one.' };
  }
}
