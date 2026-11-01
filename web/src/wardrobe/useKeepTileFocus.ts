import { useEffect, useLayoutEffect, useRef } from 'react';

// The Wardrobe's list is rebuilt when a line comes or goes (the food line splits it in two grids) and when a tile changes group
// (a Buy that turned out owned), and React then replaces the tiles: a focused button is destroyed and the focus falls to the body
// (DS › ItemGrid › After an outcome, DS › Button `off`: «the focus stays»). The hook remembers the item whose button holds the focus
// and gives the focus to that item's button once the list is drawn again, or to the first control of the list when the item has left.
// An item is told by its name, which is unique in the list.
const TILE = '.ds-item';
const NAME = '.ds-item__name';

const tileNameOf = (node: EventTarget | null): string | null => {
  if (!(node instanceof Element)) return null;
  const tile = node.closest(TILE);
  if (!tile || !node.closest('button')) return null;
  return tile.querySelector(NAME)?.textContent ?? null;
};

export function useKeepTileFocus(): void {
  const held = useRef<string | null>(null);

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      held.current = tileNameOf(e.target);
    };
    // a tap or click elsewhere takes the focus to the body or a control on purpose: it is not a loss to repair
    const onPointer = () => {
      held.current = null;
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);

  // after every commit of the page: cheap when the focus stands anywhere
  useLayoutEffect(() => {
    const name = held.current;
    if (name === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const tile = Array.from(document.querySelectorAll(TILE)).find((t) => t.querySelector(NAME)?.textContent === name);
    const target = tile?.querySelector<HTMLButtonElement>('button:not([disabled])') ?? document.querySelector<HTMLButtonElement>(`${TILE} button:not([disabled])`);
    target?.focus({ preventScroll: true });
  });
}
