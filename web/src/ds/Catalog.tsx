import type { ReactNode } from 'react';

// DS 0.29 · design/ds/components.js › CatalogList, CatalogEntry.

/** The Adapter catalog's entries: one column of raised cards. */
export function CatalogList({ label, children }: { label?: string; children?: ReactNode }) {
  return (
    <ul className="ds-catalog" aria-label={label}>
      {children}
    </ul>
  );
}

/** One entry: its name (an h2, `nameId` for the action named with it), «from {pet}» with that pet's still (`pet`; the dot without
 *  one, in the pet's light `hue`), the address in mono, the tools' names and descriptions whole, and `action` at the card's foot. */
export function CatalogEntry({
  name,
  nameId,
  from,
  hue,
  pet,
  address,
  tools,
  action,
}: {
  name: string;
  nameId?: string;
  from: string;
  hue?: string;
  pet?: ReactNode;
  address: string;
  tools: Array<[string, string]>;
  action?: ReactNode;
}) {
  return (
    <li className="ds-catalog__entry">
      <div className="ds-catalog__head">
        <h2 className="type-title-3 ds-catalog__name" id={nameId}>
          {name}
        </h2>
        <span className="ds-catalog__from type-small" data-accent={hue}>
          {pet ?? <span className="ds-message__dot" aria-hidden="true" />}
          {`from ${from}`}
        </span>
      </div>
      <span className="type-mono ds-catalog__address">{address}</span>
      <ul className="ds-catalog__tools">
        {tools.map(([toolName, description], i) => (
          <li key={i} className="type-small">
            <span className="type-mono">{toolName}</span>
            {` — ${description}`}
          </li>
        ))}
      </ul>
      {action ? <div className="ds-catalog__action">{action}</div> : null}
    </li>
  );
}
