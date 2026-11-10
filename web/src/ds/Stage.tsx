import type { ReactNode } from 'react';
import { cx } from './util';

/** DS 0.48 game ground. The pet remains the screen's single canvas. */
export function Stage({ pet, motion, bubble, edge, chat, hotbar, asleep }: {
  pet?: ReactNode; motion?: ReactNode; bubble?: ReactNode; edge?: ReactNode;
  chat?: ReactNode; hotbar?: ReactNode; asleep?: boolean;
}) {
  return <div className={cx('ds-stage', 'ds-stage--game', asleep && 'ds-stage--asleep')}>
    <div className="ds-stage__world">
      <div className="ds-stage__horizon" aria-hidden="true" />
      <div className="ds-stage__floor" aria-hidden="true" />
      <div className="ds-stage__pet">{pet}</div>
      {motion ? <div className="ds-stage__motion">{motion}</div> : null}
      {bubble ? <div className="ds-stage__bubble">{bubble}</div> : null}
      {edge ? <div className="ds-stage__edge">{edge}</div> : null}
    </div>
    {chat ? <div className="ds-stage__chat">{chat}</div> : null}
    {hotbar ? <div className="ds-stage__hotbar">{hotbar}</div> : null}
  </div>;
}
