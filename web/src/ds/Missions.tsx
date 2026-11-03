import { useId } from 'react';
import { Icon, type IconName } from './Icon';
import { cx } from './util';

// DS 0.29 · design/ds/components.js › Missions.

export interface MissionOption<V extends string> {
  value: V;
  label: string;
  icon: IconName;
}

/** Errand sheet's three forms as radio cards: each its icon in the mind's hue and its name, the picked one ringed with a check;
 *  the radio covers its card, so the card is the target. Tab enters the group on the picked card, arrows move the pick, Tab leaves
 *  (native radios of one `name`). `label` — the group's name; `value` — the picked one. */
export function Missions<V extends string>({ label, value, options, onChange }: { label: string; value: V; options: MissionOption<V>[]; onChange: (value: V) => void }) {
  const name = useId();
  return (
    <div className="ds-missions" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <label key={o.value} className={cx('ds-mission', on && 'ds-mission--on')}>
            <input className="ds-mission__input" type="radio" name={name} value={o.value} checked={on} onChange={() => onChange(o.value)} />
            <span className="ds-mission__icon" data-role="mind">
              <Icon name={o.icon} size="lg" />
            </span>
            <span className="ds-mission__name type-label">{o.label}</span>
            {on ? (
              <span className="ds-mission__check">
                <Icon name="check" size="sm" />
              </span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}
