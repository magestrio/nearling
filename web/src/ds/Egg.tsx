import { cx } from './util';

export function Egg({ cracking }: { cracking?: boolean }) {
  return <div className={cx('ds-egg', cracking && 'ds-egg--cracking')} role="img" aria-label={cracking ? 'Hatching…' : 'Hatch your pet'}>
    <div className="ds-egg__ground" aria-hidden="true" />
    <div className="ds-egg__shell" aria-hidden="true"><span className="ds-egg__core" />
      {cracking ? <><span className="ds-egg__crack" /><span className="ds-egg__crack-light" /></> : null}
    </div>
  </div>;
}
