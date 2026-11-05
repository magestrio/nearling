import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { cx } from './util';

// DS 0.46 · design/ds/components.js › ShareCard.

/** The «Is it true?» result card the browser draws and saves as an image: the pet's name and the form, the claim in quotes, the
 *  moment — the verdict as a stamp (words and a mark, never a hue) or its «Unclear — …» line, beside the pet's still —, then
 *  «{n} sources · {date}», the limit line and the pet's page link. A picture of a moment, not a control. */
export function ShareCard({
  pet,
  name,
  form,
  claim,
  verdict,
  verdictLine,
  meta,
  limit,
  link,
  kind = 'verdict',
  line,
  stage,
  growth,
  outfit,
}: {
  pet: ReactNode;
  name: string;
  form?: string;
  claim?: string;
  verdict?: 'True' | 'False';
  verdictLine?: string;
  meta?: string;
  limit?: string;
  link: string;
  kind?: 'verdict' | 'thought' | 'growth' | 'outfit';
  line?: string;
  stage?: string;
  growth?: ReactNode;
  outfit?: string;
}) {
  return (
    <figure className={cx('ds-share-card', `ds-share-card--${kind}`)}>
      <div className="ds-share-card__who">
        <span className="ds-share-card__name">
          <span className="type-title-3">{name}</span>
          {form ? <span className="type-caption ds-share-card__form">{form}</span> : null}
        </span>
      </div>
      {kind === 'verdict' || kind === 'thought' ? <blockquote className="ds-share-card__claim type-lead">{`“${kind === 'thought' ? line : claim}”`}</blockquote> : null}
      <div className="ds-share-card__moment">
        {kind === 'growth' || kind === 'outfit' ? pet : null}
        {kind === 'growth' || kind === 'outfit' ? (
          <div className="ds-share-card__detail">
            <p className="type-title-3 ds-share-card__line">{kind === 'growth' ? stage : outfit}</p>
            {kind === 'growth' ? growth : null}
          </div>
        ) : kind === 'verdict' && verdictLine ? (
          <p className="type-title-3 ds-share-card__line">{verdictLine}</p>
        ) : kind === 'verdict' ? (
          <span className="ds-message__stamp ds-share-card__stamp type-title-1">
            <Icon name={verdict === 'True' ? 'check' : 'close'} size="lg" />
            {verdict}
          </span>
        ) : null}
        {kind === 'growth' || kind === 'outfit' ? null : pet}
      </div>
      <figcaption className="ds-share-card__foot">
        {meta ? <span className="type-small">{meta}</span> : null}
        {kind === 'verdict' ? <span className="type-small ds-share-card__limit">{limit}</span> : null}
        <span className="type-mono ds-share-card__link">{link}</span>
      </figcaption>
    </figure>
  );
}
