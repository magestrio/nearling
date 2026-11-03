import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Dots } from './Dots';
import { Hidden } from './Text';
import { Icon } from './Icon';
import { Note } from './Note';
import { TextLink } from './TextLink';
import { cx } from './util';
import type { Accent } from './layout';

/** The conversation as a log (`role="log"`): one scroll area, newest at the bottom, opening on the newest line; it
 *  stays on the newest line while its box or its list changes, until the player scrolls up. Focusable, so arrows and
 *  Page Up/Down scroll it. The frame draws the focus ring (the fade's mask would cut one on the log itself).
 *  `intro` — a card before the first line; `introOn` — the viewport it stands on. */
export function Conversation({ label, intro, introOn, children }: { label?: string; intro?: ReactNode; introOn?: 'phone' | 'desktop'; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  // the scrollTop where the log last rested on its newest line: only a move UP of more than a few pixels away from
  // it is the player's own scroll — the browser nudging the scroll by 2–4 px while a line rises in, or the page
  // laying out again, must not make the log let go of its newest line
  const endTop = useRef(0);
  // the list's and the box's heights as the log last saw them: a scroll that comes with a change of either is the browser's
  // (clamping, scroll anchoring), not the player's — on a loaded machine it reaches the log before the ResizeObserver does
  const seen = useRef({ list: 0, box: 0 });
  // A report taller than the log (Message `reveal`) lands showing its top at the log's top edge, under the fade, until the player
  // scrolls, wheels, touches or keys in the log. A new report starts it again.
  const revealing = useRef(true);
  const revealed = useRef<Element | null>(null);
  const settle = (el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    const report = el.querySelector('[data-reveal]');
    if (report !== revealed.current) {
      revealed.current = report;
      revealing.current = true;
    }
    if (!report || !revealing.current) return;
    const pad = parseFloat(getComputedStyle(el).scrollPaddingBlockStart) || 0;
    // where the card stands once it has risen in: its rise (a translateY while `fresh`) is not its place — measured mid-rise, on a
    // slow device, the log would settle the rise's shift below the card's top
    const shift = new DOMMatrixReadOnly(getComputedStyle(report).transform).m42;
    const top = el.scrollTop + report.getBoundingClientRect().top - shift - el.getBoundingClientRect().top - pad;
    if (top < el.scrollTop) {
      el.scrollTop = top;
      atEnd.current = false;
    }
  };
  const stopReveal = () => {
    revealing.current = false;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    settle(el);
    seen.current = { list: el.scrollHeight, box: el.clientHeight };
    if (!window.ResizeObserver) return undefined;
    const ro = new ResizeObserver(() => {
      if (revealing.current && el.querySelector('[data-reveal]')) settle(el);
      else if (atEnd.current) el.scrollTop = el.scrollHeight;
      seen.current = { list: el.scrollHeight, box: el.clientHeight };
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="ds-convo-frame">
      <div
        className="ds-convo"
        role="log"
        aria-label={label}
        tabIndex={0}
        ref={ref}
        onWheel={stopReveal}
        onTouchStart={stopReveal}
        onKeyDown={stopReveal}
        onScroll={(e) => {
          const el = e.currentTarget;
          const resized = el.scrollHeight !== seen.current.list || el.clientHeight !== seen.current.box;
          seen.current = { list: el.scrollHeight, box: el.clientHeight };
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 2) {
            atEnd.current = true;
            endTop.current = el.scrollTop;
          } else if (resized && atEnd.current) el.scrollTop = el.scrollHeight;
          else if (endTop.current - el.scrollTop > 8) atEnd.current = false;
        }}
      >
        <ol className="ds-convo__list">
          {intro ? <li className={cx('ds-convo__intro', introOn && `ds-only--${introOn}`)}>{intro}</li> : null}
          {children}
        </ol>
      </div>
    </div>
  );
}

/** from: pet | player | worker | event | offer | error | report. `latest` — the pet's newest line, in its voice. `fresh` — the
 *  line arrived while the screen is open: it rises in; the history on open stands still. `speaker` — who said it, for
 *  a screen reader. `verify` — the entry to the thought's receipt. `meta` — the small line under it (or lines, one under another).
 *  An errand (`add-pet-errands`): `kicker` — the form above the words, on the job under «You» and on the report; `report` — the
 *  find card (raised, a hairline); `verdict` — «True» / «False» as a stamp at the report's top (words and a mark, never a hue);
 *  `sources` — the report's links under «Sources», each opening a new tab (`href: null` — «Your text» — stands as words);
 *  `reveal` — a report that lands taller than the log: the log shows its top under its fade until the player scrolls.
 *  DS 0.29 · design/ds/components.js › Message. */
export function Message({
  from = 'pet',
  latest,
  fresh,
  speaker,
  hue,
  verify,
  meta,
  actions,
  kicker,
  verdict,
  sources,
  reveal,
  children,
}: {
  from?: 'pet' | 'player' | 'worker' | 'event' | 'offer' | 'error' | 'report';
  latest?: boolean;
  fresh?: boolean;
  speaker?: string;
  hue?: Accent;
  verify?: { href: string; label: string };
  meta?: ReactNode | ReactNode[];
  actions?: ReactNode;
  kicker?: string;
  verdict?: 'True' | 'False';
  sources?: Array<{ label: string; href?: string | null }>;
  reveal?: boolean;
  children?: ReactNode;
}) {
  const who =
    from === 'worker' ? (
      <span className="ds-message__speaker type-caption">
        <span className="ds-message__dot" aria-hidden="true" />
        {speaker}
      </span>
    ) : speaker ? (
      <Hidden>{speaker}: </Hidden>
    ) : null;
  const bubbleType = from === 'event' ? 'type-small' : latest ? 'type-lead' : 'type-body';
  const foot =
    verify || meta ? (
      <div className="ds-message__foot">
        {verify ? (
          <a className="ds-message__verify" href={verify.href} aria-label={verify.label}>
            <Icon name="verify" size="sm" />
          </a>
        ) : null}
        {meta ? (
          <span className="ds-message__meta type-small">
            {([] as ReactNode[]).concat(meta).map((m, i) => (
              <span key={i}>{m}</span>
            ))}
          </span>
        ) : null}
      </div>
    ) : null;
  const head = [
    kicker ? (
      <span key="k" className="ds-message__kicker type-caption">
        {kicker}
      </span>
    ) : null,
    verdict ? (
      <span key="v" className="ds-message__stamp type-title-3">
        <Icon name={verdict === 'True' ? 'check' : 'close'} />
        {verdict}
      </span>
    ) : null,
  ];
  const list = sources ? (
    <div className="ds-message__sources">
      <span className="type-body-strong">Sources</span>
      <ul className="ds-message__source-list">
        {sources.map((src, i) => (
          <li key={i}>
            {src.href === null || src.href === undefined ? (
              <span className="type-body">{src.label}</span>
            ) : (
              <TextLink href={src.href} external>
                {src.label}
              </TextLink>
            )}
          </li>
        ))}
      </ul>
    </div>
  ) : null;
  return (
    <li
      className={cx('ds-message', `ds-message--${from}`, latest && 'ds-message--latest', fresh && 'ds-message--fresh')}
      data-accent={hue}
      data-reveal={reveal ? '' : undefined}
    >
      {who}
      <div className={cx('ds-message__bubble', bubbleType)}>
        {head}
        {from === 'error' ? <Note tone="error">{children}</Note> : children}
        {list}
      </div>
      {actions ? <div className="ds-message__actions">{actions}</div> : null}
      {foot}
    </li>
  );
}

/** «{name} is thinking…» — the pet's three dots, announced once (`role="status"`). `wait` — the line that joins it
 *  after 10 s without a reply, said by the same status region. */
export function Thinking({ wait, id, children }: { wait?: ReactNode; id?: string; children?: ReactNode }) {
  return (
    <li className="ds-message ds-message--thinking ds-message--fresh type-small" role="status">
      <span className="ds-message__thinking">
        <Dots accent />
        <span id={id}>{children}</span>
      </span>
      {wait ? <span className="ds-message__wait">{wait}</span> : null}
    </li>
  );
}
