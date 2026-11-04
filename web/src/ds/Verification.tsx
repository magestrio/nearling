import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { cx } from './util';

/** design/ds/components.js › Seal; the hash is the chain-read character's SHA-256 in hex. */
export function Seal({ hash, size }: { hash: string; size?: 'sm' }) {
  const bits = Number.parseInt(hash.slice(0, 4), 16) || 0;
  return (
    <span className={cx('ds-seal', size === 'sm' && 'ds-seal--sm')} role="img" aria-label="Seal of character">
      {Array.from({ length: 25 }, (_, n) => {
        const row = Math.floor(n / 5);
        const column = n % 5;
        const mirrored = column < 3 ? column : 4 - column;
        return <span key={n} className={cx('ds-seal__cell', (bits >> (row * 3 + mirrored)) & 1 ? 'ds-seal__cell--on' : '')} />;
      })}
    </span>
  );
}

export function Mono({ href, children }: { href?: string; children: ReactNode }) {
  const inner = <span className="ds-mono type-mono">{children}</span>;
  return href ? <a className="ds-link ds-link--quiet ds-mono-link" href={href} target="_blank" rel="noopener noreferrer">{inner}<Icon name="external" size="sm" /></a> : inner;
}

export function Mark({ state = 'ok', why, under, children }: { state?: 'ok' | 'fail'; why?: string; under?: ReactNode; children: ReactNode }) {
  const fail = state === 'fail';
  return <li className={cx('ds-mark', fail && 'ds-mark--fail')}>
    <span className="ds-mark__sign" aria-hidden="true"><Icon name={fail ? 'close' : 'check'} /></span>
    <div className="ds-mark__body">
      <span className={fail ? 'type-body-strong' : 'type-body'}>{children}</span>
      {fail && why ? <span className="ds-mark__why type-body">{why}</span> : null}
      {under ?? null}
    </div>
  </li>;
}

export function Record({ label, children }: { label?: string; children: ReactNode }) {
  return <ul className="ds-record" aria-label={label}>{children}</ul>;
}

export function RecordItem({ proof, tx, children }: {
  proof?: string; tx?: { href: string; label: string }; children: ReactNode;
}) {
  return <li className="ds-record-item">
    {children}
    {proof ? <p className="ds-record-item__proof type-small">{proof}</p> : null}
    {tx ? <Mono href={tx.href}>{tx.label}</Mono> : null}
  </li>;
}

/** design/ds/components.js 0.42 › Receipt: paid facts above the tear, proof below it. */
export function Receipt({ title, label, marks, foot, children }: {
  title?: string; label?: string; marks?: ReactNode; foot?: ReactNode; children: ReactNode;
}) {
  return <article className="ds-receipt" aria-label={title ? undefined : label}>
    {title ? <h2 className="ds-receipt__title type-title-3">{title}</h2> : null}
    <div className="ds-receipt__paid">{children}</div>
    <hr className="ds-receipt__tear" />
    {marks ? <ul className="ds-receipt__marks">{marks}</ul> : null}
    {foot ? <div className="ds-receipt__foot">{foot}</div> : null}
  </article>;
}

export function ReceiptCall({ title, titleId, level = 3, tokens, cut, marks, children }: {
  title?: string; titleId?: string; level?: 2 | 3; tokens?: string | null;
  cut?: string; marks?: ReactNode; children?: ReactNode;
}) {
  const heading = title ? level === 2
    ? <h2 className="ds-receipt-call__title type-body-strong" id={titleId}>{title}</h2>
    : <h3 className="ds-receipt-call__title type-body-strong" id={titleId}>{title}</h3> : null;
  return <section className="ds-receipt-call" aria-label={title}>
    {heading}
    {tokens ? <span className="ds-mono type-mono">{tokens}</span> : null}
    {cut ? <span className="type-small ds-receipt-call__cut">{cut}</span> : null}
    {children}
    {marks ? <ul className="ds-receipt__marks ds-receipt-call__marks">{marks}</ul> : null}
  </section>;
}

/** Native links keep Tab/Enter order; aria-current and focus remain separate DS outlines. */
export function ReceiptList({ label, children }: { label?: string; children: ReactNode }) {
  return <ol className="ds-receipt-list" aria-label={label}>{children}</ol>;
}

export function ReceiptRow({ href, time, model, price, note, current }: {
  href: string; time: string; model?: string | null; price?: string | null;
  note?: string | null; current?: boolean;
}) {
  return <li><a className="ds-receipt-row" href={href} aria-current={current ? 'page' : undefined}>
    <span className="ds-receipt-row__text">
      <Mono>{time}</Mono>
      {model ? <span className="type-small ds-receipt-row__model">{model}</span> : null}
      {note ? <span className="type-small ds-receipt-row__note">{note}</span> : null}
    </span>
    {price ? <span className="ds-receipt-row__price"><Mono>{price}</Mono></span> : null}
    <Icon name="chevron" size="sm" />
  </a></li>;
}
