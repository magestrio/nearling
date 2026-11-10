// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  skill: vi.fn(),
  saveSkill: vi.fn(),
  forgetSkill: vi.fn(),
  auth: { authenticated: true, sessionEnded: false, sessionLine: false, endSession: vi.fn(), needSession: () => true },
}));
vi.mock('../seams/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('../seams/worker', async () => ({
  ...(await import('../seams/worker-types')),
  WorkerError: class WorkerError extends Error {
    constructor(
      public status: number,
      public code: string,
    ) {
      super(code);
    }
  },
  workerApi: { skill: mocks.skill, saveSkill: mocks.saveSkill, forgetSkill: mocks.forgetSkill },
  toastHeld: () => false,
}));
vi.mock('../signin/SignInOutcome', () => ({ useSignInLines: () => [] }));

import { WorkerError } from '../seams/worker';
import { SkillSheet } from './SkillSheet';
import { useSkill } from './useSkill';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
const onSaved = vi.fn();

function Harness() {
  const skill = useSkill('9', { tokenOf: async () => 'token', refused: vi.fn() }, onSaved);
  useEffect(() => void skill.open(), []);
  return <><button className="ds-hud__nameplate">Pixel's card</button><SkillSheet name="Pixel" skill={skill} hasLabel={false} onClose={skill.close} /></>;
}

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Harness />));
}
const field = (label: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[id="${[...document.querySelectorAll('label')].find((l) => l.textContent?.includes(label))?.getAttribute('for')}"]`)!;
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(name))!;
const click = (el: Element) => act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

beforeEach(() => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  for (const m of [mocks.skill, mocks.saveSkill, mocks.forgetSkill, onSaved]) m.mockReset();
  mocks.skill.mockResolvedValue({ skill: null });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
});

describe('Skill sheet', () => {
  // spec: add-game-layout › Pet card screen › success (Work) × Close Skill sheet
  it('returns focus to the persistent nameplate after opening Skill from the card', async () => {
    await mount();
    await click(host.querySelector('.ds-sheet__head button')!);
    expect(document.activeElement).toBe(host.querySelector('.ds-hud__nameplate'));
  });

  // spec: add-pet-work › Skill sheet screen › success × fields
  it('holds what is typed in both fields and takes no more than 40 and 1,000 characters', async () => {
    await mount();
    expect(document.body.textContent).toContain('Teach Pixel a skill');
    const label = field('What is Pixel good at?');
    const instruction = field('How should Pixel do it?');
    expect(label.maxLength).toBe(40);
    expect(instruction.maxLength).toBe(1000);
    await type(label, 'opening lines');
    await type(instruction, 'Give one surprising opening line.');
    expect(label.value).toBe('opening lines');
    expect(instruction.value).toBe('Give one surprising opening line.');
    // the badge the label makes, beside it
    expect(document.body.textContent).toContain('Good at opening lines');
  });

  // spec: add-pet-work › Skill sheet screen › success × Save skill
  it('keeps «Save skill» inactive until both fields have text, then saves exactly what was typed', async () => {
    mocks.saveSkill.mockResolvedValue({ skill: { label: 'opening lines' } });
    await mount();
    expect(button('Save skill').disabled).toBe(true);
    await type(field('What is Pixel good at?'), 'opening lines');
    expect(button('Save skill').disabled).toBe(true);
    await type(field('How should Pixel do it?'), 'Give one surprising opening line.');
    expect(button('Save skill').disabled).toBe(false);
    await click(button('Save skill'));
    expect(mocks.saveSkill).toHaveBeenCalledWith('token', '9', { label: 'opening lines', instruction: 'Give one surprising opening line.' });
    expect(onSaved).toHaveBeenCalledWith('opening lines', true);
    // the sheet closed on the save
    expect(document.body.textContent).not.toContain('What is Pixel good at?');
  });

  // spec: add-pet-work › Skill sheet screen › success × fields
  it('shows each field\'s limit before it is hit: from 30 of 40 and from 900 of 1,000', async () => {
    await mount();
    const label = field('What is Pixel good at?');
    const instruction = field('How should Pixel do it?');
    await type(label, 'a'.repeat(29));
    await type(instruction, 'b'.repeat(899));
    expect(document.querySelectorAll('.ds-field__count')).toHaveLength(0);
    await type(label, 'a'.repeat(30));
    await type(instruction, 'b'.repeat(900));
    const counts = [...document.querySelectorAll('.ds-field__count')].map((c) => c.textContent);
    expect(counts).toEqual(['30 / 40', '900 / 1000']);
  });

  // spec: add-pet-work › Skill sheet screen › skill already written
  it('draws the saved label as the solid badge, hidden from a screen reader, and the preview only once the label differs', async () => {
    mocks.skill.mockResolvedValue({ skill: { label: 'opening lines', instruction: 'Give one surprising opening line.' } });
    await mount();
    const badge = () => document.querySelector('.ds-skill-badge')!;
    expect(badge().textContent).toBe('Good at opening lines');
    expect(badge().classList.contains('ds-skill-badge--preview')).toBe(false);
    expect(badge().closest('[aria-hidden="true"]')).not.toBeNull();
    await type(field('What is Pixel good at?'), 'plot twists');
    expect(badge().textContent).toBe('Good at plot twists');
    expect(badge().classList.contains('ds-skill-badge--preview')).toBe(true);
    // the saved label typed back: solid again
    await type(field('What is Pixel good at?'), 'opening lines ');
    expect(badge().classList.contains('ds-skill-badge--preview')).toBe(false);
  });

  // spec: add-pet-work › Skill writing flow › skill forgotten
  it('turns the badge to the preview once the skill is forgotten, the label still in the field', async () => {
    mocks.skill.mockResolvedValue({ skill: { label: 'opening lines', instruction: 'Give one surprising opening line.' } });
    mocks.forgetSkill.mockResolvedValue(undefined);
    await mount();
    await click(button('Forget this skill'));
    expect(field('What is Pixel good at?').value).toBe('opening lines');
    expect(document.querySelector('.ds-skill-badge')!.classList.contains('ds-skill-badge--preview')).toBe(true);
  });

  // spec: add-pet-work › Skill sheet screen › error
  it('sets «Try again» in a cluster under the line, so it takes its own width, not the sheet\'s', async () => {
    mocks.skill.mockRejectedValue(new WorkerError(0, 'unreachable'));
    await mount();
    expect(document.body.textContent).toContain("We couldn't open Pixel's skill right now. Try again in a moment.");
    expect(button('Try again').parentElement!.classList.contains('ds-cluster')).toBe(true);
  });

  // spec: add-pet-work › Skill sheet screen › success × Save skill
  it('puts «Let\'s pick different words.» under the label and keeps both fields when the label is not accepted', async () => {
    mocks.saveSkill.mockRejectedValue(new WorkerError(400, 'bad_label'));
    await mount();
    await type(field('What is Pixel good at?'), 'x');
    await type(field('How should Pixel do it?'), 'y');
    await click(button('Save skill'));
    expect(document.body.textContent).toContain("Let's pick different words.");
    expect(field('What is Pixel good at?').value).toBe('x');
    expect(onSaved).not.toHaveBeenCalled();
  });

  // spec: add-pet-work › Skill sheet screen › error × focus
  it('focuses Try again when the skill read fails', async () => {
    mocks.skill.mockRejectedValue(new WorkerError(0, 'unreachable'));
    await mount();
    expect(document.activeElement).toBe(button('Try again'));
  });

  // spec: add-pet-work › Skill writing flow › label not accepted × focus
  it('focuses the invalid label after a rejected save', async () => {
    mocks.saveSkill.mockRejectedValue(new WorkerError(400, 'bad_label'));
    await mount();
    await type(field('What is Pixel good at?'), '   ');
    await type(field('How should Pixel do it?'), 'A short instruction');
    await click(button('Save skill'));
    expect(document.activeElement).toBe(field('What is Pixel good at?'));
  });

  // spec: add-pet-work › Skill writing flow › save failed × focus
  it('focuses Try again after the save failed while keeping the typed fields', async () => {
    mocks.saveSkill.mockRejectedValue(new WorkerError(0, 'unreachable'));
    await mount();
    await type(field('What is Pixel good at?'), 'opening lines');
    await type(field('How should Pixel do it?'), 'A short instruction');
    await click(button('Save skill'));
    expect(document.activeElement).toBe(button('Try again'));
    expect(field('What is Pixel good at?').value).toBe('opening lines');
  });
});
