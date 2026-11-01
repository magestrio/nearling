// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useKeepTileFocus } from './useKeepTileFocus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const Tile = ({ name, action }: { name: string; action: string }) => (
  <li className="ds-item">
    <span className="ds-item__name">{name}</span>
    <button type="button">{`${action} ${name}`}</button>
  </li>
);

let flip: (on: boolean) => void;
let move: (on: boolean) => void;
// the list changes element type when the food line comes, as the Wardrobe's does
function Page() {
  const [line, setLine] = useState(false);
  const [owned, setOwned] = useState(false);
  flip = setLine;
  move = setOwned;
  useKeepTileFocus();
  const mine = [<Tile key="daisy" name="Daisy crown" action="Wear" />, ...(owned ? [<Tile key="glasses" name="Smart glasses" action="Wear" />] : [])];
  const toBuy = owned ? [] : [<Tile key="glasses" name="Smart glasses" action="Buy" />];
  return line ? (
    <div>
      <ul>{mine}</ul>
      <p>Pixel needs a little more food before buying this.</p>
      <ul>{toBuy}</ul>
    </div>
  ) : (
    <ul>
      {mine}
      {toBuy}
    </ul>
  );
}

let root: Root | null = null;
let host: HTMLElement;
async function show() {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<Page />);
  });
}
const button = (name: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === name)!;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('the focus on a tile when the list is drawn again', () => {
  // spec: add-wardrobe › Wardrobe screen › проснулся при открытом экране × still short of food
  it('stays on the same item when the food line splits the list', async () => {
    await show();
    button('Wear Daisy crown').focus();
    expect(document.activeElement).toBe(button('Wear Daisy crown'));
    await act(async () => flip(true));
    expect(document.activeElement).toBe(button('Wear Daisy crown'));
    await act(async () => flip(false));
    expect(document.activeElement).toBe(button('Wear Daisy crown'));
  });

  // spec: add-wardrobe › Outfit purchase flow › вещь уже куплена
  it('follows an item that moves from the Buy items to the own ones', async () => {
    await show();
    button('Buy Smart glasses').focus();
    await act(async () => move(true));
    expect(document.activeElement).toBe(button('Wear Smart glasses'));
  });

  // spec: add-wardrobe › Wardrobe screen › success
  it('does not take the focus back after a tap elsewhere, and leaves a focus that stands alone', async () => {
    await show();
    button('Wear Daisy crown').focus();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    (document.activeElement as HTMLElement).blur();
    await act(async () => flip(true));
    expect(document.activeElement).toBe(document.body);
  });
});
