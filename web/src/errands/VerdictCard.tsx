import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Cluster, Note, Sheet, Stack } from '../ds';
import { ShareCard } from '../ds/ShareCard';
import { PetFigure } from '../pet/PetFigure';
import type { PetStageName, PetState } from '../pet/flat';
import { track } from '../track';
import { wearProps } from '../wardrobe/catalogue';
import { cardError, cardFacts, formatCardDate, printedLink, renderCard, sharedLink, type CardFacts } from './card';
import { focusButton } from './focus';
import { useMarkErrandSurface } from './surfaces';
import { closeVerdict, type VerdictRequest } from './verdictRequest';

// Verdict card (`Verdict card screen`): a centred dialog over the owner's Pet screen with the «Is it true?» report under it. The card is
// the DS `ShareCard` for the eye and a Canvas 2D drawing of the same facts (`card.ts`) for «Save image» and «Share». The drawing is made
// when the dialog opens; a browser that can't make it meets the error line in the card's place, and the report stays as it was. Both
// buttons tell the server `report_shared` (the event, nothing of the card): the image goes where the owner sends it, uploaded nowhere.

export interface CardPet {
  tokenId: string;
  name: string;
  stage: PetStageName;
  state: PetState;
  worn: string | null | undefined;
}

type Drawing = { kind: 'drawing' } | { kind: 'ready'; blob: Blob } | { kind: 'error' };

const SAVE = 'Save image';
const SHARE = 'Share';

const fileName = (name: string) => `${name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'pet'}-verdict.png`;

/** Whether this browser can hand the system share menu a file. */
export function canShareFile(blob: Blob, name: string): boolean {
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  return navigator.canShare({ files: [new File([blob], fileName(name), { type: 'image/png' })] });
}

export function VerdictCard({ request, pet }: { request: VerdictRequest; pet: CardPet }) {
  useMarkErrandSurface(true);
  const [date] = useState(() => formatCardDate());
  const [drawing, setDrawing] = useState<Drawing>({ kind: 'drawing' });
  const [attempt, setAttempt] = useState(0);
  const figure = useRef<HTMLDivElement>(null);
  const facts: CardFacts = cardFacts({ name: pet.name, claim: request.claim, verdict: request.verdict, sources: request.sources, date, link: printedLink(pet.tokenId) });
  const outfit = wearProps(pet.worn).outfit;

  // the drawing is made once per opening (and again at «Try again»): the facts of the card are the request's, the pet's look is the page's now
  useEffect(() => {
    let live = true;
    setDrawing({ kind: 'drawing' });
    const from = figure.current ?? document.documentElement;
    renderCard(
      { name: pet.name, claim: request.claim, verdict: request.verdict, sources: request.sources, date, link: facts.link, pet: { tokenId: pet.tokenId, stage: pet.stage, state: pet.state, outfit } },
      from,
    ).then(
      (blob) => live && setDrawing({ kind: 'ready', blob }),
      () => live && setDrawing({ kind: 'error' }),
    );
    return () => {
      live = false;
    };
    // the card is of this report; a re-draw is the player's «Try again»
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, request.lineId]);

  const blob = drawing.kind === 'ready' ? drawing.blob : null;
  const save = useCallback(() => {
    if (!blob) return;
    track('report_shared');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName(pet.name);
    document.body.append(link);
    link.click();
    link.remove();
    // the download has begun by the time the click returns
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [blob, pet.name]);
  const share = useCallback(async () => {
    if (!blob) return;
    track('report_shared');
    try {
      await navigator.share({ files: [new File([blob], fileName(pet.name), { type: 'image/png' })], text: pet.name, url: sharedLink(pet.tokenId) });
    } catch {
      // the player closed the menu, or this browser refused the file: nothing changes, the card stays
    }
  }, [blob, pet.name, pet.tokenId]);

  const sharable = blob !== null && canShareFile(blob, pet.name);
  const failed = drawing.kind === 'error';

  // «Try again» goes with the card that stands in its place: the focus to «Save image», or to «Try again» once more when the card
  // fails again (DS › Sheet › Focus)
  useEffect(() => {
    if (attempt === 0 || drawing.kind === 'drawing') return;
    focusButton('Share card', failed ? 'Try again' : SAVE);
  }, [attempt, drawing.kind, failed]);

  return (
    <Sheet title="Share card" centered status={failed ? cardError : ''} onClose={closeVerdict}>
      {failed ? (
        <Stack gap={3}>
          <Note tone="error" silent>
            {cardError}
          </Note>
          <Cluster>
            <Button variant="secondary" size="compact" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </Cluster>
        </Stack>
      ) : (
        <Stack gap={4}>
          <div ref={figure}>
            <ShareCard
              pet={<PetFigure tokenId={pet.tokenId} name={pet.name} state={pet.state} stage={pet.stage} size="sm" decorative still {...wearProps(pet.worn)} />}
              name={facts.name}
              form={facts.form}
              claim={facts.claim}
              verdict={facts.stamp ?? undefined}
              verdictLine={facts.line ?? undefined}
              meta={facts.meta}
              limit={facts.limit}
              link={facts.link}
            />
          </div>
          <Cluster gap={2} justify="center">
            <Button icon="download" busy={drawing.kind === 'drawing'} onClick={save}>
              {SAVE}
            </Button>
            {sharable ? (
              <Button variant="secondary" icon="share" onClick={() => void share()}>
                {SHARE}
              </Button>
            ) : null}
          </Cluster>
        </Stack>
      )}
    </Sheet>
  );
}
