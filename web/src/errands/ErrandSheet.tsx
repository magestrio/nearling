import { useEffect } from 'react';
import { Actions, Button, Cluster, Missions, Note, Only, Sheet, Stack, Text, TextField } from '../ds';
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
import { formatCents } from '../lib/price';

// Errand sheet (`Errand sheet screen`, `Errand flow`) drawn from design/bundle/screens/errand.js › SHEET: the pet's errand over the
// conversation column (a bottom sheet on the phone). Top to bottom: the outcome line (the ended session, the quote that did not
// come), the three forms as mission cards, the field of the picked form with its lines, and, pinned to the sheet's foot, «Send · …»
// — or in its place the first block that holds (`several blocks at once`), with «Feed {name}» when the food is the block.

const OPTIONS = FORMS.map((value) => ({ value, label: FORM_WORD[value], icon: FORM_ICON[value] }));

export function ErrandSheet({ name, errand, onFeed, asleep = false, inert = false }: { name: string; errand: ReturnType<typeof useErrand>; onFeed: () => void; asleep?: boolean; inert?: boolean }) {
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

  // DS 0.46 Sheet foot: the two actions stand as peers on desktop and stack on the phone; the funding amount stays
  // below Share, where its label belongs. The asleep explanation is above the forms, as in the frame.
  const blockAction = blockText && !errand.shareOnly ? (
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
  ) : null;
  const sendAction = <Button iconEnd="send" nowrap price={asleep || error ? undefined : price} off={asleep || (!errand.canSend && !sending)} busy={sending} describedBy={short ? 'errand-short' : undefined} onClick={() => void errand.send()}>{SEND}</Button>;
  const shareAction = (phone: boolean) => <Stack gap={1} grow={!phone}>
    <Button block={phone} nowrap={phone} variant={asleep && !phone ? 'primary' : 'secondary'} off={!job.trim() || errand.preparing || !quote || error} busy={errand.preparing} onClick={() => void errand.prepareShared()}>Share a job for friends to fund</Button>
    {job.trim() && quote && !error ? <Text variant="small" tone="secondary">{`Friends need ${quote.sharedNeeded.cents === 2 ? '2¢' : formatCents(quote.sharedNeeded.cents)} of food for this job`}</Text> : null}
  </Stack>;
  // The energy and cap blocks (frames `errand-energy-out`, `errand-tired`) keep Share and the line side by side on the
  // phone too; the food and asleep blocks, which carry «Feed {name}», stack there.
  const sideBySide = block?.reason !== 'food' && block?.reason !== 'asleep';
  const foot = <Stack gap={2}>
    {short ? <Text id="errand-short" variant="small" tone="secondary">{shortLine(name)}</Text> : null}
    {search && !error && blockAction && sideBySide ? (
      <Cluster gap={2} nowrap align="flex-start" justify="space-between">{shareAction(false)}<Stack align="flex-end">{blockAction}</Stack></Cluster>
    ) : search && !error ? <>
      <Only on="desktop"><Cluster gap={2} nowrap align="flex-start" justify="space-between">{shareAction(false)}<Stack align="flex-end">{blockAction ?? sendAction}</Stack></Cluster></Only>
      <Only on="phone">{blockAction ? <Stack gap={2}><Actions stackPhone>{shareAction(true)}</Actions>{blockAction}</Stack> : <Actions stackPhone>{shareAction(true)}{sendAction}</Actions>}</Only>
    </> : <Cluster gap={2} nowrap align="flex-start" justify="flex-end">{blockAction ?? sendAction}</Cluster>}
  </Stack>;

  return (
    <Sheet title={errandTitle(name)} column inert={inert} foot={foot} status={ended ? (line?.text ?? '') : errand.sendFailed ? offlineLine(name) : (blockText ?? '')} onClose={errand.close}>
      <Stack gap={5}>
        {asleep ? <Note tone="plain">{`${name} is asleep. Share one Find out or Is it true? job for friends to fund.`}</Note> : null}
        {top}
        {errand.sharedLink ? <Stack gap={2}><Note tone="plain">{`${name} has a shared errand in progress. Open that link before sharing another.`}</Note><Button href={errand.sharedLink}>Open shared errand</Button></Stack> : null}
        {errand.shareError ? <Note tone="error">{`We couldn't get ${name} ready for an errand right now. Try again in a moment.`}</Note> : null}
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
