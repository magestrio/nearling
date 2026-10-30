import type { ElementType, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './util';

/** A role's hue as a block. A notice is always `quiet` (a dark surface, the hue on the icon only); a filled block is
 *  for what the player acts on or gets. role: food | mind | trust. */
export function Block({
  as: Tag = 'div',
  role = 'food',
  icon,
  flush,
  quiet,
  children,
}: {
  as?: ElementType;
  role?: 'food' | 'mind' | 'trust';
  icon?: IconName;
  flush?: boolean;
  quiet?: boolean;
  children?: ReactNode;
}) {
  return (
    <Tag className={cx('ds-block', flush && 'ds-block--flush', quiet && 'ds-block--quiet')} data-role={role}>
      {icon ? (
        <span className="ds-block__tile">
          <Icon name={icon} />
        </span>
      ) : null}
      <div className="ds-block__body">{children}</div>
    </Tag>
  );
}
