import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Cluster, Console, Divider, Inert, Note, Sheet, Stack, Text, TextField, ToolList, ToolRow } from '../ds';
import { useReveal } from '../ds/reveal';
import { useMarkErrandSurface } from '../errands/surfaces';
import { resetTime } from '../lib/time';
import { useSignInLines } from '../signin/SignInOutcome';
import {
  ADAPTER_ERROR,
  CODE_ERROR_LINE,
  CODE_FIELD,
  CODE_LIMIT_LINE,
  CODE_PRIVATE,
  changingFunctionsLine,
  CODE_REACH,
  codeFieldLabel,
  codeSocket,
  freeTextNote,
  FN_FIELD,
  FUNCTIONS_LABEL,
  gameCapLine,
  KEEP_CODE,
  notDeclaredLine,
  REMOVE_CODE,
  REMOVE_CODE_WARNING,
  removeCodeTitle,
  SAMPLE_FIELD,
  SAMPLE_HINT,
  SAVE_CODE,
  STALE_TEST_LINE,
  TEST_RUN,
  testCapLine,
} from './lines';
import { toolDescription } from './params';
import type { CodeOutcome, useCode } from './useCode';

// Skill code sheet (`Skill code sheet screen`, `Skill code flow`) drawn from design/bundle/screens/code.js: a wide centred dialog on the
// desktop (the code needs the width), a full-height bottom sheet on the phone. Top to bottom: the outcome line; the code field (mono,
// growing with its code); the two lines under it; «Function to test» and «Sample values» with «Test run» beside it; the console (the
// output, the error, the limit and the cap lines); the functions with ticks; in the foot «Remove code» (quiet, left) and «Save code»
// (right, off until a test of this code passes).

const CONSOLE_ID = 'code-console';
const CAP_ID = 'code-cap-reason';
const SAVE_NOTE_ID = 'code-save-note';

/** The console's words for an outcome: its title line, its tone, and the text under it (the output, the error's text). */
function consoleOf(outcome: CodeOutcome): { title?: string; tone?: 'error'; out?: string } {
  switch (outcome.kind) {
    case 'ok':
      return { out: outcome.output };
    case 'limit':
      return { tone: 'error', title: CODE_LIMIT_LINE };
    case 'error':
      return { tone: 'error', title: CODE_ERROR_LINE, out: outcome.text };
    case 'undeclared':
      return { tone: 'error', title: notDeclaredLine(outcome.fn) };
    case 'cap':
      return { title: testCapLine(resetTime()) };
    case 'game_cap':
      return { title: gameCapLine(resetTime()) };
  }
}

export function CodeSheet({ name, sheet, onClose }: { name: string; sheet: ReturnType<typeof useCode>; onClose: () => void }) {
  const { open, loaded, outcome, top, busy, functions } = sheet;
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => { if (!open) setConfirmRemove(false); }, [open]);
  const topRef = useRef<HTMLDivElement>(null);
  const capRef = useRef<HTMLDivElement>(null);
  useReveal(capRef, sheet.testsLeft === 0 && sheet.fresh && outcome?.kind !== 'cap');
  useLayoutEffect(() => {
    if (!top || !topRef.current) return;
    const body = topRef.current.closest('.ds-sheet__body');
    if (body) body.scrollTop = 0;
    topRef.current.querySelector<HTMLButtonElement>('button')?.focus();
  }, [top]);
  // a session that ended meets the line of `Session expiry flow`: «Sign in» brings the sheet back with the code, the function and the values as typed
  const [session] = useSignInLines({ text: JSON.stringify({ code: sheet.code, fn: sheet.fn, values: sheet.values }), action: 'code' });
  useMarkErrandSurface(open);
  if (!open) return null;

  const shown = outcome ? consoleOf(outcome) : null;
  const capped = sheet.testsLeft === 0;
  const capReason = capped ? testCapLine(resetTime()) : null;
  const status = top?.kind === 'failed' ? ADAPTER_ERROR : top?.kind === 'session' ? session?.text : capReason ?? (shown?.title ?? shown?.out);
  // the functions a passing run found, or the saved code's: the usable ones ticked
  const rows = functions.map((f) => (
    <ToolRow
      key={f.name}
      name={f.name}
      description={toolDescription(f)}
      checked={f.tickable && sheet.ticks.includes(f.name)}
      disabled={!f.tickable}
      note={f.tickable ? undefined : freeTextNote(name)}
      onChange={(on) => sheet.tick(f.name, on)}
    />
  ));
  // the functions of the code as saved, or of the run that passed; a run that did not pass leaves nothing sure to show
  const listed = functions.length > 0 && (outcome === null || outcome.kind === 'ok');

  const topLine =
    top?.kind === 'failed' ? (
      <Stack gap={2}>
        <Note tone="error" silent>
          {ADAPTER_ERROR}
        </Note>
        <Cluster justify="flex-end">
          <Button variant="secondary" size="compact" onClick={sheet.again}>
            Try again
          </Button>
        </Cluster>
      </Stack>
    ) : top?.kind === 'session' ? (
      <Cluster gap={3} justify="space-between">
        <Note tone="error" silent>
          {session?.text}
        </Note>
        {session?.action ? (
          <Button variant="secondary" size="compact" onClick={session.action.onClick}>
            {session.action.label}
          </Button>
        ) : null}
      </Cluster>
    ) : null;

  // under a saved code «Save code» waits for one test of the day; a save the server refused for a test of an earlier day says that instead.
  // Once a run has put its result in the console (error, limit, cap) the console says what is wrong: the frames leave the reminder out.
  const saveNote = sheet.stale ? STALE_TEST_LINE : sheet.written && !sheet.canSave && !shown ? changingFunctionsLine(name) : null;
  const foot = (
    <Stack gap={3}>
      {saveNote ? (
        <Text variant="small" tone="secondary" id={SAVE_NOTE_ID}>
          {saveNote}
        </Text>
      ) : null}
      <Cluster gap={3} justify={sheet.written ? 'space-between' : 'flex-end'}>
        {sheet.written ? (
          <Button variant="ghost" size="compact" busy={busy === 'remove'} off={busy !== null && busy !== 'remove'} onClick={() => setConfirmRemove(true)}>
            {REMOVE_CODE}
          </Button>
        ) : null}
        <Button size="compact" disabled={!sheet.canSave} busy={busy === 'save'} describedBy={saveNote ? SAVE_NOTE_ID : undefined} onClick={() => void sheet.save()}>
          {SAVE_CODE}
        </Button>
      </Cluster>
    </Stack>
  );

  return (
    <>
    <Inert on={confirmRemove}>
    <Sheet title={codeSocket(name)} centered wide status={status ?? ''} busy={busy === 'save' || busy === 'remove'} foot={foot} onClose={onClose}>
      <Stack gap={5}>
        {topLine ? <div ref={topRef}>{topLine}</div> : null}
        <TextField label={codeFieldLabel(name)} error={sheet.tooLong ? `${CODE_FIELD}.` : undefined} value={sheet.code} onChange={sheet.setCode} multiline grow mono rows={6} readOnly={!loaded} />
        <Stack gap={2}>
          <Text variant="small" tone="secondary">
            {CODE_REACH}
          </Text>
          <Text variant="small" tone="secondary">
            {CODE_PRIVATE}
          </Text>
        </Stack>
        <Divider />
        <TextField label={FN_FIELD} value={sheet.fn} onChange={sheet.setFn} mono />
        <TextField
          label={SAMPLE_FIELD}
          value={sheet.values}
          onChange={sheet.setValues}
          hint={SAMPLE_HINT}
          action={
            <Button
              variant="secondary"
              size="compact"
              icon="play"
              disabled={!sheet.canTest && !capped}
              off={capped}
              busy={busy === 'test'}
              describedBy={capped ? outcome?.kind === 'cap' ? CONSOLE_ID : CAP_ID : undefined}
              onClick={() => void sheet.test()}
            >
              {TEST_RUN}
            </Button>
          }
        />
        {shown ? (
          <Stack gap={2}>
            <Console title={shown.title} titleId={CONSOLE_ID} tone={shown.tone} reveal={sheet.fresh && !listed && !capped}>
              {shown.out}
            </Console>
            {capped && outcome?.kind !== 'cap' ? <div ref={capRef}><Note id={CAP_ID} silent>{capReason}</Note></div> : null}
          </Stack>
        ) : null}
        {listed ? <ToolList label={FUNCTIONS_LABEL} reveal={sheet.fresh && outcome?.kind === 'ok' && !capped}>{rows}</ToolList> : null}
      </Stack>
    </Sheet>
    </Inert>
    {confirmRemove ? <Sheet title={removeCodeTitle(name)} centered alert busy={busy === 'remove'} onClose={() => setConfirmRemove(false)} status={top?.kind === 'failed' ? ADAPTER_ERROR : top?.kind === 'session' ? session?.text : ''}>
      <Stack gap={4}>
        <Text>{REMOVE_CODE_WARNING}</Text>
        {top?.kind === 'failed' ? <Stack gap={2}><Note tone="error">{ADAPTER_ERROR}</Note><Button variant="secondary" size="compact" onClick={sheet.again}>Try again</Button></Stack> : null}
        {top?.kind === 'session' ? <Stack gap={2}><Note tone="error">{session?.text}</Note>{session?.action ? <Button variant="secondary" size="compact" onClick={session.action.onClick}>{session.action.label}</Button> : null}</Stack> : null}
        <Stack gap={2}>
          <Button block focusOnOpen off={busy === 'remove'} onClick={() => setConfirmRemove(false)}>{KEEP_CODE}</Button>
          <Button block variant="danger" busy={busy === 'remove'} onClick={() => void sheet.remove()}>{REMOVE_CODE}</Button>
        </Stack>
      </Stack>
    </Sheet> : null}
    </>
  );
}
