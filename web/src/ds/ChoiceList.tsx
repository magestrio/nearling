import { useId, type ChangeEvent } from 'react';
import { Icon } from './Icon';

// DS 0.46 · design/ds/components.js › ChoiceList; `quote` (DS 0.50, the debate opener shows pet names without quotes).
export function ChoiceList({ label, options, value, note, disabled, quote = true, onChange, onSelect }: {
  label: string;
  /** `false` shows the option text as it is, without the typographic quotes */
  quote?: boolean;
  options: Array<{ value: string; text: string; meta?: string }>;
  value: string;
  note?: string;
  disabled?: boolean;
  onChange: (value: string, event: ChangeEvent<HTMLInputElement>) => void;
  onSelect?: (value: string) => void;
}) {
  const name = useId();
  return <div className="ds-choice-list" role="radiogroup" aria-label={label}>
    {note ? <p className="ds-choice-list__note type-small" role="status">{note}</p> : null}
    <div className="ds-choice-list__options">{options.map((option) =>
      <label key={option.value} className="ds-choice-list__row">
        <input className="ds-choice-list__input" type="radio" name={name} value={option.value} checked={option.value === value} disabled={disabled}
          onChange={(event) => onChange(option.value, event)} onClick={() => { if (option.value === value) onSelect?.(option.value); }} />
        <span className="ds-choice-list__copy">
          <span className="ds-choice-list__text type-body">{quote ? `“${option.text}”` : option.text}</span>
          {option.meta ? <span className="ds-choice-list__meta type-caption">{option.meta}</span> : null}
        </span>
        <span className="ds-choice-list__mark" aria-hidden="true"><Icon name="check" size="sm" /></span>
      </label>)}</div>
  </div>;
}
