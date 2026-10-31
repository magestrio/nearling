// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Energy, Growth, Trait, type TraitName } from './PetParts';

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

describe('Energy', () => {
  // spec: add-pet-life › Pet life display rule › владелец
  it('is a meter of ten steps named by its label, the lit ones as many as the value', async () => {
    await show(<Energy value={7} label="Energy" />);
    const meter = host.querySelector('[role="meter"]')!;
    expect(meter.getAttribute('aria-label')).toBe('Energy');
    expect(meter.getAttribute('aria-valuemin')).toBe('0');
    expect(meter.getAttribute('aria-valuemax')).toBe('10');
    expect(meter.getAttribute('aria-valuenow')).toBe('7');
    expect(meter.hasAttribute('data-illustration')).toBe(false);
    expect(host.querySelectorAll('.ds-energy__bar')).toHaveLength(10);
    expect(host.querySelectorAll('.ds-energy__bar--on')).toHaveLength(7);
    expect(host.querySelector('.ds-energy__label')!.textContent).toBe('Energy');
    expect(host.querySelector('.ds-energy__bars')!.getAttribute('aria-hidden')).toBe('true');
  });

  // spec: add-pet-life › Energy rule › энергия на нуле
  it('at zero lights no step', async () => {
    await show(<Energy value={0} label="Energy" />);
    expect(host.querySelector('[role="meter"]')!.getAttribute('aria-valuenow')).toBe('0');
    expect(host.querySelectorAll('.ds-energy__bar--on')).toHaveLength(0);
  });

  // spec: add-pet-life › Pet life display rule › владелец
  it('without a label is a drawing, not a named meter', async () => {
    await show(<Energy value={3} />);
    const meter = host.querySelector('[role="meter"]')!;
    expect(meter.hasAttribute('data-illustration')).toBe(true);
    expect(meter.hasAttribute('aria-label')).toBe(false);
    expect(host.querySelector('.ds-energy__label')).toBeNull();
  });
});

describe('Growth', () => {
  // spec: add-pet-life › Pet life display rule › владелец
  it.each([
    ['baby', 'Baby', 1],
    ['teen', 'Teen', 2],
    ['adult', 'Grown-up', 3],
  ] as const)('shows the word «%s» as «%s» and %i filled steps, the steps hidden from readers', async (stage, word, filled) => {
    await show(<Growth stage={stage} />);
    expect(host.querySelector('.ds-growth')!.textContent).toBe(word);
    expect(host.querySelectorAll('.ds-growth__dot')).toHaveLength(3);
    expect(host.querySelectorAll('.ds-growth__dot--on')).toHaveLength(filled);
    expect(host.querySelectorAll('.ds-growth__link--on')).toHaveLength(filled - 1);
    expect(host.querySelector('.ds-growth__steps')!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Trait', () => {
  // spec: add-pet-life › Pet life display rule › владелец
  it.each([
    ['clever', 'mind'],
    ['thoughtful', 'mind'],
    ['sociable', 'food'],
    ['hard-working', 'trust'],
    ['cozy', null],
  ] as const)('«%s» is a tile in the hue %s and its word', async (name: TraitName, role) => {
    await show(<Trait name={name} />);
    const tile = host.querySelector('.ds-trait__tile')!;
    expect(tile.getAttribute('data-role')).toBe(role);
    expect(tile.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('.ds-trait')!.textContent).toBe(name);
  });
});
