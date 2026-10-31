// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Surface } from './layout';
import { Streak } from './Streak';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;

async function show(node: ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
});

const kinds = () => Array.from(host.querySelectorAll('.ds-streak__cell')).map((c) => /ds-streak__cell--(\w+)/.exec(c.className)![1]);

describe('Streak', () => {
  // spec: add-daily-ritual › Streak rule › заморозка спасла серию
  it('says «Streak: {n} days · Freezes: {k}» in a yellow block with the number largest', async () => {
    await show(<Streak days={2} freezes={1} />);
    const block = host.querySelector('.ds-block')!;
    expect(block.getAttribute('data-role')).toBe('food');
    expect(host.querySelector('.ds-streak__line')!.textContent).toBe('Streak: 2 days · Freezes: 1');
    expect(host.querySelector('.ds-streak__n')!.className).toContain('type-hero');
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию
  it('draws the days counted lit and today an outline until the ritual is done, a missed day not at all', async () => {
    await show(<Streak days={2} freezes={1} />);
    expect(kinds()).toEqual(['none', 'none', 'none', 'none', 'lit', 'lit', 'today']);
    await act(async () => root!.render(<Streak days={2} freezes={1} done />));
    expect(kinds()).toEqual(['none', 'none', 'none', 'none', 'none', 'lit', 'lit']);
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию
  it('takes the seven kinds it is given, a frozen day among them, and hides the cells from a screen reader', async () => {
    await show(<Streak days={2} freezes={0} cells={['none', 'none', 'none', 'lit', 'lit', 'frozen', 'today']} />);
    expect(kinds()).toEqual(['none', 'none', 'none', 'lit', 'lit', 'frozen', 'today']);
    expect(host.querySelector('.ds-streak__cells')!.getAttribute('aria-hidden')).toBe('true');
  });

  // spec: add-daily-ritual › Streak rule › заморозка спасла серию
  it('puts the streak\'s own line above the note, and neither when it has none', async () => {
    await show(<Streak days={2} freezes={0} line="A streak freeze kept your 2-day streak safe." note="Saved once today's ritual is done." />);
    const texts = Array.from(host.querySelectorAll('.ds-block__body > p')).map((p) => p.textContent);
    expect(texts).toEqual(['Streak: 2 days · Freezes: 0', 'A streak freeze kept your 2-day streak safe.', "Saved once today's ritual is done."]);
    await act(async () => root!.render(<Streak days={2} freezes={1} />));
    expect(host.querySelectorAll('.ds-block__body > p')).toHaveLength(1);
  });
});

describe('Surface', () => {
  // spec: add-daily-ritual › Diary screen › success
  it('is a raised area, a step lighter with tone raised-2', async () => {
    await show(<Surface>entry</Surface>);
    expect(host.querySelector('.ds-surface')!.className).toBe('ds-surface');
    await act(async () => root!.render(<Surface tone="raised-2">entry</Surface>));
    expect(host.querySelector('.ds-surface')!.className).toBe('ds-surface ds-surface--raised-2');
  });
});
