// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DebatePair } from '../ds/DebatePair';
import { DebateInvitation } from '../ds/DebateInvitation';
import { DebateLine } from '../ds/DebateLine';
import { Button } from '../ds/Button';
import { ChoiceList } from '../ds/ChoiceList';

vi.mock('../pet/PetFigure', () => ({ PetFigure: ({ name }: { name: string }) => <span data-pet={name} /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root | null = null;
const pixel = { tokenId: '9', name: 'Pixel' };
const nori = { tokenId: '5', name: 'Nori' };
const biscuit = { tokenId: '2', name: 'Biscuit' };

async function show(node: ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
});

// spec: add-debates › Debate turn flow › settled line
// spec: add-debates › Debate turn flow › receipt pending
// spec: add-debates › Debate turn flow › debit rejected
it('offers a named Verification link only after a line settles', async () => {
  const onCheck = vi.fn();
  await show(<ol><DebateLine pet={pixel} line="A public line" number={1} cost="0.04¢" costNear="0.00018 NEAR"
    receipt="settled" href="/debate/verify/1#code" onCheck={onCheck} /></ol>);
  const link = host.querySelector<HTMLAnchorElement>('.ds-debate-line a')!;
  expect(link.textContent).toContain('Check this line');
  expect(link.textContent).toContain('1, Pixel');
  expect(host.textContent).toContain('0.00018 NEAR');
  link.addEventListener('click', (event) => event.preventDefault());
  await act(async () => link.click());
  expect(onCheck).toHaveBeenCalledOnce();
  await act(async () => root!.render(<ol><DebateLine pet={nori} line="Another line" number={2} receipt="pending" /></ol>));
  expect(host.textContent).toContain('Receipt pending');
  expect(host.querySelector('.ds-debate-line a')).toBeNull();
  await act(async () => root!.render(<ol><DebateLine pet={nori} line="Another line" number={2} receipt="unavailable"
    unavailableNote="This line wasn't charged." /></ol>));
  expect(host.textContent).toContain("This line wasn't charged.");
});

// spec: add-debates › Debate invitation screen › success
it('keeps speaking order and a native known-pet selector with the DS focus class', async () => {
  const onSelect = vi.fn();
  await show(<DebatePair first={pixel} second={nori} ordered selectablePet="5" options={[nori, biscuit]} onSelectPet={onSelect} />);
  expect(host.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Pixel opener');
  expect(Array.from(host.querySelectorAll('.ds-debate-pair__order')).map((node) => node.textContent)).toEqual(['1', '2']);
  const select = host.querySelector('select')!;
  expect(select.className).toContain('ds-debate-pair__select');
  select.focus();
  expect(document.activeElement).toBe(select);
  await act(async () => {
    select.value = '2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(onSelect).toHaveBeenCalledWith('2');
});

// spec: add-debates › Debate invitation screen › success × known-pet selection
it('selects by token id when two known pets have the same name', async () => {
  const onSelect = vi.fn();
  await show(<DebatePair first={pixel} second={nori} ordered selectablePet="5"
    options={[nori, { tokenId: '2', name: 'Nori' }]} onSelectPet={onSelect} />);
  const select = host.querySelector('select')!;
  expect(select.value).toBe('5');
  await act(async () => { select.value = '2'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(onSelect).toHaveBeenCalledWith('2');
});

// spec: add-debates › Debate invitation card screen › success
it('puts the exact topic and disclosure before the consent controls', async () => {
  const accept = vi.fn();
  const decline = vi.fn();
  await show(<ul><DebateInvitation first={nori} second={pixel} ordered
    topic="Should every rainy day have a parade?" estimate="About 0.30¢ for both pets"
    notice="Each pet can spend up to 0.01 NEAR. Anyone with the link may read the topic and lines."
    actions={<><Button size="compact" onClick={accept}>Accept debate</Button><Button variant="secondary" size="compact" onClick={decline}>Decline</Button></>}
  /></ul>);
  const card = host.querySelector('.ds-debate-invitation')!;
  expect(card.textContent).toContain('Should every rainy day have a parade?');
  expect(card.textContent).toContain('About 0.30¢ for both pets');
  expect(card.textContent).toContain('Each pet can spend up to 0.01 NEAR. Anyone with the link may read the topic and lines.');
  const actions = Array.from(card.querySelectorAll('button'));
  expect(actions.map((node) => node.textContent)).toEqual(['Accept debate', 'Decline']);
  expect(card.querySelector('.ds-actions')).not.toBeNull();
  expect(card.querySelector('.ds-note')!.compareDocumentPosition(actions[0]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  await act(async () => actions[0]!.click());
  await act(async () => actions[1]!.click());
  expect(accept).toHaveBeenCalledOnce();
  expect(decline).toHaveBeenCalledOnce();
});

// spec: add-debates › Debate invitation screen › asleep
it('keeps opener radios visible but inactive while a selected pet sleeps', async () => {
  await show(<ChoiceList label="opener" value="9" disabled onChange={vi.fn()} options={[
    { value: '9', text: 'Pixel' }, { value: '5', text: 'Nori' },
  ]} />);
  expect(Array.from(host.querySelectorAll<HTMLInputElement>('input[type="radio"]')).every((input) => input.disabled)).toBe(true);
});
