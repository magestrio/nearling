import { useId, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/** A button that opens its content in place, under itself («Pay with NEAR»): a secondary block button with a chevron,
 *  `aria-expanded`, `aria-controls`. `open` — drawn open at the start; the state is its own, so a re-render with new
 *  children keeps it. `onToggle` (the build's, not in the prototype's markup): tells the owner of a surface that unmounts
 *  the disclosure and draws it again (Feed sheet's Add NEAR step) what the player left, to hand it back as `open`. */
export function Disclosure({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children?: ReactNode;
}) {
  const [shown, setShown] = useState(Boolean(open));
  const id = useId();
  const toggle = () => {
    setShown(!shown);
    onToggle?.(!shown);
  };
  return (
    <div className="ds-disclosure">
      <button
        type="button"
        className="ds-button ds-button--secondary ds-button--block type-label ds-disclosure__toggle"
        aria-expanded={shown ? 'true' : 'false'}
        aria-controls={id}
        onClick={toggle}
      >
        <span className="ds-button__label">{label}</span>
        <span className="ds-disclosure__chevron">
          <Icon name="chevron" />
        </span>
      </button>
      {shown ? (
        <div id={id} className="ds-disclosure__panel">
          {children}
        </div>
      ) : null}
    </div>
  );
}
