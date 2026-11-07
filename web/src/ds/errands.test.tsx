// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Away } from './Away';
import { Button } from './Button';
import { Console } from './Console';
import { Message } from './Conversation';
import { Missions } from './Missions';
import { RailItem } from './Rail';
import { Sheet } from './Sheet';
import { Socket, Sockets } from './Sockets';
import { ToolList, ToolRow } from './ToolList';

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
  host?.remove();
  root = null;
});

// The DS parts of add-pet-errands (design/ds/README.md, DS 0.29): what a person reaches by keyboard and what a screen reader is told.
describe('the DS parts of the errands', () => {
  // spec: add-pet-experience › Experience capture flow › eligible report
  it('keeps the report outcome in the DS foot beside the report price', async () => {
    await show(<Message from="report" meta="3 searches · 1.4¢" foot="New work note" verify={{ href: '/verify', label: 'Check this thought' }}>Report</Message>);
    expect(host.querySelector('.ds-message--has-foot .ds-message__foot--with-extra .ds-message__extra')?.textContent).toBe('New work note');
    expect(host.querySelector('.ds-message__meta')?.textContent).toBe('3 searches · 1.4¢');
  });
  // spec: add-pet-errands › Errand flow › sent × the rail's errand item while away
  it('keeps the focus on an off rail item and does nothing on Enter or a click', async () => {
    const onClick = vi.fn();
    await show(<RailItem icon="pack" label="Send Pixel on an errand" haspopup="dialog" off describedBy="why" onClick={onClick} />);
    const item = host.querySelector('button')!;
    item.focus();
    expect(document.activeElement).toBe(item);
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('aria-describedby')).toBe('why');
    expect(item.className).toContain('ds-rail__item--off');
    await act(async () => item.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  // spec: add-pet-errands › Errand sheet screen › a search form × switch the form
  it('draws the missions as one radio group: the picked form is checked, a pick reports its value', async () => {
    const picked: string[] = [];
    function Host() {
      const [value, setValue] = useState<'read' | 'find' | 'check'>('read');
      return (
        <Missions
          label="Errand"
          value={value}
          options={[
            { value: 'read', label: 'Read this', icon: 'page' },
            { value: 'find', label: 'Find out', icon: 'compass' },
            { value: 'check', label: 'Is it true?', icon: 'scales' },
          ]}
          onChange={(v) => {
            picked.push(v);
            setValue(v);
          }}
        />
      );
    }
    await show(<Host />);
    expect(host.querySelector('[role=radiogroup]')?.getAttribute('aria-label')).toBe('Errand');
    const radios = Array.from(host.querySelectorAll<HTMLInputElement>('input[type=radio]'));
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    await act(async () => radios[2]!.click());
    expect(picked).toEqual(['check']);
    expect(Array.from(host.querySelectorAll<HTMLInputElement>('input[type=radio]')).map((r) => r.checked)).toEqual([false, false, true]);
  });

  // spec: add-pet-errands › Errand sheet screen › a search form
  it('puts the sheet\'s foot after its body, outside the scroll, and marks a wide sheet', async () => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    await show(
      <Sheet title="Send Pixel on an errand" onClose={() => undefined} foot={<button type="button">Send</button>} wide>
        <p>body</p>
      </Sheet>,
    );
    const section = host.querySelector('section')!;
    const body = section.querySelector('.ds-sheet__body')!;
    const foot = section.querySelector('.ds-sheet__foot')!;
    expect(body.contains(foot)).toBe(false);
    expect(body.nextElementSibling).toBe(foot);
    expect(host.querySelector('.ds-sheet-layer--wide')).not.toBeNull();
  });

  // spec: add-pet-errands › Adapter connect flow › a fourth source
  it('names the note of the off sockets in each disabled socket\'s description', async () => {
    await show(
      <Sockets note="A skill holds up to 3 data sources. Remove one to add another.">
        <Socket label="Daybook" />
        <Socket kind="code" empty="Add code" disabled />
      </Sockets>,
    );
    const note = host.querySelector('.ds-sockets > p')!;
    const off = host.querySelector<HTMLButtonElement>('button:disabled')!;
    expect(off.getAttribute('aria-describedby')).toBe(note.id);
    expect(off.querySelector('.ds-socket__label')?.textContent).toBe('Add code');
    expect(host.querySelector('.ds-socket--empty')).toBe(off);
  });

  // spec: add-pet-errands › Adapter connect flow › a tool takes free text
  it('skips an off tool row in the tab order and ties the note to the box', async () => {
    await show(
      <ToolList label="Tools">
        <ToolRow name="events_on" description="Notable events." checked onChange={() => undefined} />
        <ToolRow name="search_events" description="Searches." note="Takes free text — Pixel can only send short values." disabled />
      </ToolList>,
    );
    const boxes = Array.from(host.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [true, false],
      [false, true],
    ]);
    const described = document.getElementById(boxes[1]!.getAttribute('aria-describedby')!)!;
    expect(described.textContent).toContain('Takes free text');
    expect(host.querySelector(`label[for="${boxes[1]!.id}"]`)?.textContent).toBe('search_events');
  });

  // spec: add-pet-errands › Errand flow › report
  it('opens a report\'s sources in a new tab and sets a source with no page as words', async () => {
    await show(
      <ul>
        <Message
          from="report"
          speaker="Pixel"
          kicker="Is it true?"
          verdict="True"
          sources={[{ label: 'Smithsonian Ocean', href: 'https://example.com/a' }, { label: 'Your text', href: null }]}
          meta="2 searches · 1.06¢"
          reveal
        >
          Two hearts pump blood through the gills.
        </Message>
      </ul>,
    );
    const links = Array.from(host.querySelectorAll<HTMLAnchorElement>('.ds-message__source-list a'));
    expect(links.map((a) => [a.textContent, a.target, a.rel])).toEqual([['Smithsonian Ocean', '_blank', 'noopener noreferrer']]);
    expect(host.querySelector('.ds-message__source-list li:nth-child(2) a')).toBeNull();
    expect(host.querySelector('.ds-message__kicker')?.textContent).toBe('Is it true?');
    expect(host.querySelector('.ds-message__stamp')?.textContent).toBe('True');
    expect(host.querySelector('li.ds-message')?.hasAttribute('data-reveal')).toBe(true);
  });

  // spec: add-pet-errands › Errand flow › sent
  it('hides the away stage from a screen reader and stops its walker under «Pause motion»', async () => {
    await show(<Away paused />);
    expect(host.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector<HTMLElement>('.ds-away__walker')?.style.animationPlayState).toBe('paused');
  });

  // spec: add-pet-errands › Skill code flow › code error
  it('gives the console an error mark and the title the id of the control it explains', async () => {
    await show(
      <Console title="Your code stopped with an error:" titleId="why" tone="error">
        TypeError: x is not a function
      </Console>,
    );
    expect(host.querySelector('.ds-console--error')).not.toBeNull();
    expect(host.querySelector('#why')?.textContent).toBe('Your code stopped with an error:');
    expect(host.querySelector('.ds-console__out')?.textContent).toContain('TypeError');
  });

  // spec: add-pet-errands › Errand sheet screen › shared job funding amount
  it('keeps the label of a nowrap button on one line and the button at its width', async () => {
    await show(
      <>
        <Button nowrap>Send</Button>
        <Button>Share</Button>
      </>,
    );
    const [nowrap, plain] = [...host.querySelectorAll('button')].map((b) => b.className);
    expect(nowrap).toContain('ds-button--nowrap');
    expect(plain).not.toContain('ds-button--nowrap');
  });
});
