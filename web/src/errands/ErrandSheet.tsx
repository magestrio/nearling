import { useEffect } from 'react';
import { Button, Cluster, Missions, Note, Sheet, Stack, Text, TextField } from '../ds';
import { offlineLine } from '../screens/pet/lines';
import { useSignInLines } from '../signin/SignInOutcome';
import { focusLost, sheetTitled } from './focus';
import { useMarkErrandSurface } from './surfaces';
import type { ErrandForm } from '../seams/worker-types';
import {
  blockLine,
  errandErrorLine,
  errandTitle,
  fieldLabel,
  FORM_ICON,
  FORM_WORD,
  FORMS,
  LIMIT,
  MISSIONS_LABEL,
  searchOnlyLine,
  SEND,
  shortLine,
  throughLine,
} from './lines';
import type { useErrand } from './useErrand';

// Errand sheet (`Errand sheet screen`, `Errand flow`) drawn from design/bundle/screens/errand.js › SHEET: the pet's errand over the
// conversation column (a bottom sheet on the phone). Top to bottom: the outcome line (the ended session, the quote that did not
// come), the three forms as mission cards, the field of the picked form with its lines, and, pinned to the sheet's foot, «Send · …»
// — or in its place the first block that holds (`several blocks at once`), with «Feed {name}» when the food is the block.

const OPTIONS = FORMS.map((value) => ({ value, label: FORM_WORD[value], icon: FORM_ICON[value] }));

export function ErrandSheet({ name, errand, onFeed }: { name: string; errand: ReturnType<typeof useErrand>; onFeed: () => void }) {
  const { open, form, job, quote, error, sending, session: ended, block, price } = errand;
  // a session that ended meets the line of `Session expiry flow`: «Sign in» brings the sheet back with the form and the text
  const [line] = useSignInLines({ text: JSON.stringify({ form, job }), action: 'errand' });
  useMarkErrandSurface(open);
  // A block in «Send»'s place keeps the focus in the field (DS › Sheet › Focus): the one the server answered at the tap, and one a
  // fresh quote brought while «Send» had the focus
  const blocked = open && block !== null;
  const focusField = () => sheetTitled(errandTitle(name))?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  useEffect(() => {
    if (blocked && focusLost()) focusField();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked]);
  useEffect(() => {
    if (errand.blockedAtSend > 0) focusField();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errand.blockedAtSend]);
  if (!open) return null;

  const search = form !== 'read';
  const hints = search ? [searchOnlyLine(name), ...(quote && quote.labels.length > 0 ? [throughLine(name, quote.labels)] : [])] : undefined;
  const blockText = block ? blockLine(block, name) : null;
  const short = search && quote?.search.short === true && block === null;

  // the outcome line at the body's top
  const top = ended ? (
    <Cluster gap={3} justify="space-between">
      <Note tone="error" silent>
        {line?.text}
      </Note>
      {line?.action ? (
        <Button variant="secondary" size="compact" onClick={line.action.onClick}>
          {line.action.label}
        </Button>
      ) : null}
    </Cluster>
  ) : error ? (
    <Stack gap={2}>
      <Note tone="error">{errandErrorLine(name)}</Note>
      <Cluster justify="flex-end">
        <Button variant="secondary" size="compact" onClick={errand.refresh}>
          Try again
        </Button>
      </Cluster>
    </Stack>
  ) : null;

  // «Send», or the block in its place
  const foot = blockText ? (
    <Stack gap={3}>
      <Note tone="plain" silent>
        {blockText}
      </Note>
      {block?.reason === 'food' || block?.reason === 'asleep' ? (
        <Cluster justify="flex-end">
          <Button icon="feed" haspopup="dialog" onClick={onFeed}>
            {`Feed ${name}`}
          </Button>
        </Cluster>
      ) : null}
    </Stack>
  ) : (
    <Stack gap={2}>
      {short ? (
        <Text id="errand-short" variant="small" tone="secondary">
          {shortLine(name)}
        </Text>
      ) : null}
      <Cluster justify="flex-end">
        <Button iconEnd="send" price={error ? undefined : price} off={!errand.canSend && !sending} busy={sending} describedBy={short ? 'errand-short' : undefined} onClick={() => void errand.send()}>
          {SEND}
        </Button>
      </Cluster>
    </Stack>
  );

  return (
    <Sheet title={errandTitle(name)} column foot={foot} status={ended ? (line?.text ?? '') : errand.sendFailed ? offlineLine(name) : (blockText ?? '')} onClose={errand.close}>
      <Stack gap={5}>
        {top}
        <Missions<ErrandForm> label={MISSIONS_LABEL} value={form} options={OPTIONS} onChange={errand.pick} />
        <TextField
          label={fieldLabel(form, name)}
          value={job}
          onChange={errand.setJob}
          multiline
          rows={search ? 3 : 5}
          maxLength={LIMIT[form]}
          count
          hint={hints}
        />
      </Stack>
    </Sheet>
  );
}
