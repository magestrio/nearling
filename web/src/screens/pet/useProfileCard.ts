import { useCallback, useEffect, useRef, useState } from 'react';
import type { PetView } from '../../seams/worker';

type CardState = { phase: 'closed' | 'loading' | 'error' | 'ready'; pet: PetView | null };

/** A card owns only tab memory. Every open/retry gets a fresh ownership-checked Pet read. */
export function useProfileCard(read: () => Promise<PetView>, expected: 'owner' | 'public',
  onMismatch: (pet: PetView) => void, active: boolean, currentPet: PetView) {
  const [state, setState] = useState<CardState>({ phase: 'closed', pet: null });
  const order = useRef(0);
  const latestPet = useRef(currentPet);
  const openedAgainst = useRef<PetView | null>(null);
  latestPet.current = currentPet;
  const close = useCallback(() => {
    order.current += 1;
    openedAgainst.current = null;
    setState({ phase: 'closed', pet: null });
  }, []);
  const open = useCallback(async () => {
    const current = ++order.current;
    openedAgainst.current = latestPet.current;
    setState({ phase: 'loading', pet: null });
    try {
      const pet = await read();
      if (current !== order.current) return;
      if ((expected === 'owner') !== (pet.viewer === 'owner')) {
        close();
        onMismatch(pet);
        return;
      }
      setState({ phase: 'ready', pet });
    } catch {
      if (current === order.current) setState({ phase: 'error', pet: null });
    }
  }, [read, expected, onMismatch, close]);
  useEffect(() => {
    if (state.phase !== 'ready' || currentPet === openedAgainst.current) return;
    openedAgainst.current = currentPet;
    if ((expected === 'owner') !== (currentPet.viewer === 'owner')) {
      close();
      onMismatch(currentPet);
      return;
    }
    setState({ phase: 'ready', pet: currentPet });
  }, [state.phase, currentPet, expected, onMismatch, close]);
  useEffect(() => {
    if (!active) close();
  }, [active, close]);
  useEffect(() => close, [close]);
  return { ...state, open, close };
}
