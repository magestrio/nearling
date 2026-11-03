// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Segmented } from './Segmented';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
const picked: string[] = [];

const OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'manual', label: 'Ask me first' },
];

function Hiring() {
  const [mode, setMode] = useState('auto');
  return (
    <Segmented
      label="Hiring"
      role="trust"
      value={mode}
      options={OPTIONS}
      onChange={(v) => {
        picked.push(v);
        setMode(v);
      }}
    />
  );
}

async function show() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Hiring />));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  picked.length = 0;
});

const options = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
const press = (key: string) => act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));

describe('Segmented', () => {
  // spec: add-pet-work › Hire mode rule › Auto
  it('is a radio group with the selected option the only one in the tab order', async () => {
    await show();
    const group = host.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute('aria-label')).toBe('Hiring');
    expect(group.getAttribute('data-role')).toBe('trust');
    expect(options().map((o) => [o.textContent, o.getAttribute('aria-checked'), o.tabIndex])).toEqual([
      ['Auto', 'true', 0],
      ['Ask me first', 'false', -1],
    ]);
  });

  // spec: add-pet-work › Hire mode rule › Ask me first
  it('picks an option on a tap and moves the roving tab stop with it', async () => {
    await show();
    await act(async () => options()[1]!.click());
    expect(picked).toEqual(['manual']);
    expect(options().map((o) => [o.getAttribute('aria-checked'), o.tabIndex])).toEqual([
      ['false', -1],
      ['true', 0],
    ]);
  });

  // spec: add-pet-work › Hire mode rule › Ask me first
  it('moves and picks with the arrow keys, wrapping, and keeps the focus on the picked option', async () => {
    await show();
    options()[0]!.focus();
    await press('ArrowRight');
    expect(picked).toEqual(['manual']);
    expect(document.activeElement).toBe(options()[1]);
    await press('ArrowRight');
    expect(picked).toEqual(['manual', 'auto']);
    expect(document.activeElement).toBe(options()[0]);
    await press('ArrowLeft');
    expect(picked).toEqual(['manual', 'auto', 'manual']);
    expect(document.activeElement).toBe(options()[1]);
  });

  // spec: add-pet-work › Hire mode rule › Auto
  it('picks with Space (a button click) and ignores the other keys', async () => {
    await show();
    options()[0]!.focus();
    await press('a');
    expect(picked).toEqual([]);
    await act(async () => options()[1]!.click());
    expect(picked).toEqual(['manual']);
  });
});
