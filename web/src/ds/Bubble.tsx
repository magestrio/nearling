import type { ReactNode } from 'react';
import { TextLink } from './TextLink';

export function Bubble({ children, meta, receipt }: { children?: ReactNode; meta?: string; receipt?: { href: string; label: string } }) {
  return <aside className="ds-bubble type-body">
    <div className="ds-bubble__words">{children}</div>
    {meta || receipt ? <div className="ds-bubble__foot">
      {meta ? <span className="type-small">{meta}</span> : null}
      {receipt ? <TextLink href={receipt.href} icon="verify">{receipt.label}</TextLink> : null}
    </div> : null}
  </aside>;
}
