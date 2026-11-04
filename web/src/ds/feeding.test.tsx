// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionRow } from './ActionRow';
import { CopyField } from './CopyField';
import { Disclosure } from './Disclosure';

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

describe('ActionRow', () => {
  it('shows the label with its price and the note, and acts on a tap', async () => {
    const onClick = vi.fn();
    await show(
      <ActionRow price="5¢" aside="0.01 NEAR" onClick={onClick}>
        Feed
      </ActionRow>,
    );
    const row = host.querySelector('button')!;
    expect(row.textContent).toBe('Feed · 5¢0.01 NEAR');
    await act(async () => row.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // spec: add-feeding › Feeding outcome rule › отправлено × repeat tap
  it('pending keeps the focus, is not disabled, ignores a tap and shows its pending label', async () => {
    const onClick = vi.fn();
    await show(
      <ActionRow pending pendingLabel="Feeding Pixel…" aside="0.01 NEAR" onClick={onClick}>
        Feed
      </ActionRow>,
    );
    const row = host.querySelector('button')!;
    row.focus();
    await act(async () => row.click());
    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(row);
    expect(row.disabled).toBe(false);
    expect(row.getAttribute('aria-busy')).toBe('true');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toBe('Feeding Pixel…');
  });

  it('is off (disabled, so Tab skips it) and carries the failed mark', async () => {
    await show(
      <>
        <ActionRow disabled>Feed</ActionRow>
        <ActionRow failed describedBy="why">
          Feed
        </ActionRow>
      </>,
    );
    const [off, failed] = [...host.querySelectorAll('button')];
    expect(off!.disabled).toBe(true);
    expect(failed!.querySelector('svg')).not.toBeNull();
    expect(failed!.getAttribute('aria-describedby')).toBe('why');
  });
});

describe('Disclosure', () => {
  // spec: add-feeding › Feed sheet screen › без NEAR × the sheet refreshed with «Pay with NEAR» open
  it('opens and closes in place with aria-expanded tied to its panel, and keeps its state across a re-render', async () => {
    await show(<Disclosure label="Pay with NEAR">one</Disclosure>);
    const toggle = host.querySelector<HTMLButtonElement>('.ds-disclosure__toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('.ds-disclosure__panel')).toBeNull();
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(host.querySelector('.ds-disclosure__panel')!.id);
    await act(async () => root!.render(<Disclosure label="Pay with NEAR">two</Disclosure>));
    expect(host.querySelector('.ds-disclosure__panel')!.textContent).toBe('two');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('is drawn open when asked', async () => {
    await show(
      <Disclosure label="Pay with NEAR" open>
        in
      </Disclosure>,
    );
    expect(host.querySelector('.ds-disclosure__toggle')!.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('CopyField', () => {
  it('shows the value whole and calls onCopy from its Copy button', async () => {
    const onCopy = vi.fn();
    await show(<CopyField value="a1b2c3" mono onCopy={onCopy} />);
    expect(host.querySelector<HTMLTextAreaElement>('.ds-copy__value')!.value).toBe('a1b2c3');
    expect(host.querySelector<HTMLTextAreaElement>('.ds-copy__value')!.readOnly).toBe(true);
    expect(host.querySelector('.ds-copy__value')!.className).toContain('type-mono');
    const button = host.querySelector('button')!;
    expect(button.textContent).toBe('Copy');
    await act(async () => button.click());
    expect(onCopy).toHaveBeenCalledTimes(1);
  });
});
