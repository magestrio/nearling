import type { ReactNode } from 'react';
import { Button, Cluster, Message, type Accent } from '../ds';
import { makePet } from '../pet/proto/generator.js';
import type { Line } from '../screens/pet/usePetScreen';
import { askWorker, lookedUpLine, NO_THANKS, ownLostLine, SKILLED_LINE } from './lines';

// The owner's conversation lines of a hire turn (`Pet hire flow`), drawn the way design/bundle/screens/work.js has them: the
// worker's answer in its own voice, the Manual offer as a card, the lost own reply. (The pet's question and the game's lines are
// the pet screen's own Messages; `usePetScreen` writes their words.)

const accentOf = (tokenId: string): Accent => makePet(tokenId).hue as Accent;

/** The worker's answer under its name and light, with its receipt and, when a private skill shaped it, the line that says so,
 *  then what the hire cost. */
export function WorkerMessage({ line }: { line: Line }) {
  const worker = line.worker!;
  const notes: string[] = [
    ...(line.skilled ? [SKILLED_LINE] : []),
    ...(line.dataLabels && line.dataLabels.length > 0 ? [lookedUpLine(worker.name, line.dataLabels)] : []),
    ...(line.meta ? [line.meta] : []),
  ];
  const meta: ReactNode[] | string | undefined = notes.length > 1 ? notes : notes[0];
  return (
    <Message
      from="worker"
      speaker={worker.name}
      hue={accentOf(worker.tokenId)}
      fresh={line.fresh}
      verify={{ href: `/pet/${worker.tokenId}/verify/${line.id}`, label: 'Check this thought' }}
      meta={meta}
      foot={line.foot}
    >
      {line.text}
    </Message>
  );
}

/** The Manual offer: its words, and — while it stands and nothing answered it — «Ask {worker}» and «No thanks». A price that rose
 *  puts its own words in their place (`price rose on an offer`). */
export function OfferMessage({
  text,
  worker,
  buttons,
}: {
  /** the card's words */
  text: string;
  /** the worker's name, for «Ask {worker}» */
  worker: string;
  /** the buttons, while the offer stands and nothing answers it */
  buttons?: { onAsk: () => void; onDecline: () => void; price?: string };
}) {
  return (
    <Message
      from="offer"
      actions={
        buttons ? (
          <Cluster gap={2}>
            <Button variant="secondary" size="compact" icon="bag" role="trust" price={buttons.price} onClick={buttons.onAsk}>
              {askWorker(worker)}
            </Button>
            <Button variant="ghost" size="compact" onClick={buttons.onDecline}>
              {NO_THANKS}
            </Button>
          </Cluster>
        ) : undefined
      }
    >
      {text}
    </Message>
  );
}

/** The pet's own reply did not come after the worker answered: the worker's answer is kept and paid for. */
export function OwnLostMessage({ name, worker, onTryAgain }: { name: string; worker: string; onTryAgain: () => void }) {
  return (
    <Message
      from="error"
      actions={
        <Button variant="secondary" size="compact" onClick={onTryAgain}>
          Try again
        </Button>
      }
    >
      {ownLostLine(name, worker)}
    </Message>
  );
}
