import { useEffect, useRef } from 'react';
import { Actions, Button, Note, Sheet, Stack, Text } from '../ds';
import { PetFigure } from '../pet/PetFigure';
import type { OwnerView } from '../screens/pet/usePetScreen';
import type { OutfitSlug } from '../seams/worker';
import { nameOf, wearProps } from './catalogue';
import { noticeErrorLine, noticeLine, NOTICE_TITLE } from './lines';

// New outfit notice screen (add-wardrobe) built from design/bundle/screens/wardrobe.js › notice: a centred dialog that opened by itself
// over the owner's page, the pet large in the new item and standing still (a moment to read: no idle loop, so no «Pause motion»). The
// spec's first sentence is its title, the rest stands under it word for word. After «Wear it» went unanswered the line takes the text's
// place, the pet is in its former outfit, «Later» is alone and primary, and the focus goes to it.

/** The page's h1, a place for the focus to return to (`Sheet self`): given a tab stop of −1 when the page has none on it. None while
 *  another dialog stands (the notice's own is gone when this runs): the focus goes back to what opened the notice, inside it. */
function pageHeading(): HTMLElement | null {
  if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return null;
  const heading = document.querySelector<HTMLElement>('h1');
  if (heading && !heading.hasAttribute('tabindex')) heading.tabIndex = -1;
  return heading;
}

export function NewOutfitNotice({
  pet,
  slug,
  wearing,
  failed,
  onWear,
  onLater,
}: {
  pet: OwnerView;
  slug: OutfitSlug;
  /** «Wear it» is on its way: the button is pending, Close, Esc and the scrim do nothing */
  wearing: boolean;
  /** «Wear it» went unanswered */
  failed: boolean;
  onWear: () => void;
  onLater: () => void;
}) {
  const item = nameOf(slug) ?? slug;
  const error = noticeErrorLine(pet.name, item);
  const actions = useRef<HTMLDivElement>(null);
  // «Later» is the one action now: the focus was on «Wear it», which is gone
  useEffect(() => {
    if (failed) actions.current?.querySelector('button')?.focus();
  }, [failed]);
  const figure = failed ? wearProps(pet.worn) : { outfit: slug, wearing: item };
  return (
    <Sheet title={NOTICE_TITLE} centered self busy={wearing} status={failed ? error : ''} onClose={onLater} returnFocusTo={pageHeading}>
      <Stack gap={5} align="center">
        <PetFigure
          tokenId={pet.tokenId}
          name={pet.name}
          state={pet.fullness.state}
          stage={pet.stage}
          mood={pet.fullness.state === 'asleep' ? null : pet.mood}
          size="hero"
          still
          {...figure}
        />
        {failed ? (
          <Note tone="error" silent>
            {error}
          </Note>
        ) : (
          <Text align="center">{noticeLine(pet.name, slug)}</Text>
        )}
      </Stack>
      <div className="ds-only" ref={actions}>
        <Actions>
          {failed ? null : (
            <Button pending={wearing} onClick={onWear}>
              Wear it
            </Button>
          )}
          <Button
            variant={failed ? 'primary' : 'secondary'}
            onClick={() => {
              if (!wearing) onLater();
            }}
          >
            Later
          </Button>
        </Actions>
      </div>
    </Sheet>
  );
}
