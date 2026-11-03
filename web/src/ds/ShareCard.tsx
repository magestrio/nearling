import type { ReactNode } from 'react';
import { Icon } from './Icon';

// DS 0.29 · design/ds/components.js › ShareCard.

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
}: {
  pet: ReactNode;
  name: string;
  form: string;
  claim: string;
  verdict?: 'True' | 'False';
  verdictLine?: string;
  meta: string;
  limit: string;
  link: string;
}) {
  return (
    <figure className="ds-share-card">
      <div className="ds-share-card__who">
        <span className="ds-share-card__name">
          <span className="type-title-3">{name}</span>
          <span className="type-caption ds-share-card__form">{form}</span>
        </span>
      </div>
      <blockquote className="ds-share-card__claim type-lead">{`“${claim}”`}</blockquote>
      <div className="ds-share-card__moment">
        {verdictLine ? (
          <p className="type-title-3 ds-share-card__line">{verdictLine}</p>
        ) : (
          <span className="ds-message__stamp ds-share-card__stamp type-title-1">
            <Icon name={verdict === 'True' ? 'check' : 'close'} size="lg" />
            {verdict}
          </span>
        )}
        {pet}
      </div>
      <figcaption className="ds-share-card__foot">
        <span className="type-small">{meta}</span>
        <span className="type-small ds-share-card__limit">{limit}</span>
        <span className="type-mono ds-share-card__link">{link}</span>
      </figcaption>
    </figure>
  );
}
