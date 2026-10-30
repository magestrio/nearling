import { Button, Sheet, Stack, Text } from '../ds';
import { monthOf } from './gate';

// Sign-in closed sheet screen (add-account) built from design/bundle/screens/account.js › closedSheet: the spec gives the
// words and no title, so the first sentence names the dialog and the rest stands under it, word for word. Closed for new
// players: «Played here before? Sign in» beside «Keep looking»; closed for everyone: «Keep looking» alone, primary.
export const closedWords = (all: boolean, until: string) =>
  all
    ? `Sign-in is closed for everyone until ${monthOf(until)} 1. You can still look around, and any pet you have is safe.`
    : `We're full for new players this month. Sign-ups open again on ${monthOf(until)} 1 — until then, you can still look around.`;

export function ClosedSheet({
  all,
  until,
  onClose,
  onReturning,
  returnFocusTo,
}: {
  all: boolean;
  until: string;
  onClose: () => void;
  onReturning: () => void;
  returnFocusTo: () => HTMLElement | null;
}) {
  const words = closedWords(all, until);
  const cut = words.indexOf('. ') + 1;
  return (
    <Sheet title={words.slice(0, cut)} centered onClose={onClose} returnFocusTo={returnFocusTo}>
      <Text>{` ${words.slice(cut + 1)}`}</Text>
      <Stack gap={2}>
        {all ? null : (
          <Button block onClick={onReturning}>
            Played here before? Sign in
          </Button>
        )}
        <Button block variant={all ? undefined : 'secondary'} onClick={onClose}>
          Keep looking
        </Button>
      </Stack>
    </Sheet>
  );
}
