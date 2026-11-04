import { useEffect, useId, useRef } from 'react';
import { Button, Cluster, Divider, Note, Sheet, SkillBadge, Socket, Sockets, Stack, Text, TextField } from '../ds';
import { codeSocket, FOURTH_SOURCE, goneNote, NO_SKILL_YET, SOCKET_CODE, SOCKET_DATA } from '../adapters/lines';
import type { SourceView } from '../seams/worker-types';
import { resetTime } from '../lib/time';
import { useSignInLines } from '../signin/SignInOutcome';
import {
  SKILL_FORGET,
  SKILL_INSTRUCTION_HINT,
  SKILL_LABEL_HINT,
  SKILL_LABEL_REJECTED,
  SKILL_SAVE,
  SKILL_SAVE_FAILED,
  skillForgottenLine,
  skillInstructionField,
  skillLabelField,
  skillOpenFailedLine,
  skillSaysLines,
  skillTitle,
} from './lines';
import type { useSkill } from './useSkill';

// Skill sheet (`Skill sheet screen`, `Skill writing flow`, and the sockets of `Adapter connect flow`), drawn from design/bundle/screens/skill.js:
// the pet's ability card over the owner's conversation column (a bottom sheet on the phone). Top to bottom: the outcome line, the card's
// head — the badge the label makes and the four sockets in one row (three for data sources, one for code; off, with their line, until
// a skill is saved) —, a hairline, the label field, the private instruction with its lock, the two lines of «what the sheet says»,
// «Forget this skill» (quiet, left) and «Save skill» (right).

export interface SkillSockets {
  /** the Adapter sheet of a new source («Add data») */
  onConnect: () => void;
  /** the Adapter sheet of a connected source */
  onSource: (source: SourceView) => void;
  /** the Skill code sheet («Add code», «{name}'s code») */
  onCode: () => void;
}

export function SkillSheet({
  name,
  skill,
  hasLabel,
  onClose,
  sockets,
  hidden,
}: {
  name: string;
  skill: ReturnType<typeof useSkill>;
  hasLabel: boolean;
  onClose: () => void;
  sockets?: SkillSockets;
  /** a step of the sheet (Adapter sheet, Skill code sheet) stands in its place: its state stays */
  hidden?: boolean;
}) {
  const { phase, label, instruction, written, top, labelError, busy } = skill;
  // a session that ended meets the line of `Session expiry flow`: «Sign in» brings the sheet back with both fields as typed
  const [session] = useSignInLines({ text: JSON.stringify({ label, instruction }), action: 'skill' });
  // A step's outcome — a source or code saved or removed — lands on the sheet's outcome line at the body's top (DS › Sheet › Focus)
  const lineId = useId();
  useEffect(() => {
    if (top?.kind === 'line' && !hidden) document.getElementById(lineId)?.focus();
    // a new line, not the sheet coming back from a step's «Back» with the old one
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top]);
  // «Save skill» and «Forget this skill» sit at the body's end, their outcome line at its top: on a phone it would stay out of sight
  const outcomeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (top !== null && !hidden) outcomeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [top, hidden]);
  if (phase === 'closed' || phase === 'loading') return null;

  if (phase === 'error') {
    const line = skillOpenFailedLine(name);
    return (
      <Sheet title={skillTitle(name, hasLabel)} column status={line} onClose={onClose}>
        <Stack gap={3}>
          <Note tone="error" silent>
            {line}
          </Note>
          <Cluster>
            <Button variant="secondary" size="compact" onClick={() => void skill.open()}>
              Try again
            </Button>
          </Cluster>
        </Stack>
      </Sheet>
    );
  }

  const title = skillTitle(name, skill.openedWritten);
  const outcome = (() => {
    if (top === null) return null;
    if (top.kind === 'forgotten') {
      const line = skillForgottenLine(name);
      return { line, node: <Note tone="plain" icon="check" silent>{line}</Note> };
    }
    if (top.kind === 'line') {
      return {
        line: top.text,
        node: (
          <Note tone="plain" icon="check" silent id={lineId} tabIndex={-1}>
            {top.text}
          </Note>
        ),
      };
    }
    if (top.kind === 'failed') {
      return {
        line: SKILL_SAVE_FAILED,
        node: (
          <Cluster gap={3} justify="space-between">
            <Note tone="error" silent>
              {SKILL_SAVE_FAILED}
            </Note>
            <Button variant="secondary" size="compact" onClick={skill.again}>
              Try again
            </Button>
          </Cluster>
        ),
      };
    }
    return {
      line: session?.text ?? '',
      node: (
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
      ),
    };
  })();
  const status = labelError ? SKILL_LABEL_REJECTED : (outcome?.line ?? '');
  // the badge the label makes: solid while the field holds the saved label, the dashed preview for one typed and not saved;
  // hidden from a screen reader either way, the field already says it
  const shown = label.trim();
  const badge = !shown ? undefined : shown === skill.savedLabel ? (
    <div aria-hidden="true">
      <SkillBadge name={name} label={shown} />
    </div>
  ) : (
    <SkillBadge name={name} label={shown} preview />
  );
  // the sockets: three for data, one for code; off until a skill is saved, with their line (all three filled: the fourth source's line)
  const saved = skill.written;
  const sources = skill.sources;
  const socketNote = !saved ? NO_SKILL_YET : sources.length >= 3 ? FOURTH_SOURCE : undefined;
  const dataSockets = [0, 1, 2].map((i) => {
    const source = sources[i];
    return (
      <Socket
        key={`d${i}`}
        kind="data"
        label={source?.label}
        note={source?.catalogGone ? goneNote(name) : undefined}
        empty={SOCKET_DATA}
        disabled={!saved}
        onClick={source ? () => sockets?.onSource(source) : () => sockets?.onConnect()}
      />
    );
  });

  const sheet = (
    <Sheet title={title} column status={status} busy={busy} onClose={onClose}>
      <Stack gap={5}>
        {outcome ? <div ref={outcomeRef}>{outcome.node}</div> : null}
        <Stack gap={4}>
          {badge ? <div>{badge}</div> : null}
          <Sockets note={socketNote}>
            {dataSockets}
            <Socket kind="code" label={skill.hasCode ? codeSocket(name) : undefined} empty={SOCKET_CODE} disabled={!saved} onClick={() => sockets?.onCode()} />
          </Sockets>
        </Stack>
        <Divider />
        <TextField
          label={skillLabelField(name)}
          value={label}
          onChange={skill.setLabel}
          maxLength={40}
          count
          hint={SKILL_LABEL_HINT}
          error={labelError ? SKILL_LABEL_REJECTED : undefined}
        />
        <TextField
          label={skillInstructionField(name)}
          labelIcon="lock"
          value={instruction}
          onChange={skill.setInstruction}
          multiline
          rows={4}
          maxLength={1000}
          count
          hint={SKILL_INSTRUCTION_HINT}
        />
        <Stack gap={2}>
          {skillSaysLines(name, resetTime()).map((line, i) => (
            <Text key={i} variant="small" tone="secondary">
              {line}
            </Text>
          ))}
        </Stack>
        <Cluster justify={written ? 'space-between' : 'flex-end'}>
          {written ? (
            <Button variant="ghost" size="compact" off={busy} onClick={() => void skill.forget()}>
              {SKILL_FORGET}
            </Button>
          ) : null}
          <Button size="compact" disabled={label === '' || instruction === ''} busy={busy} onClick={() => void skill.save()}>
            {SKILL_SAVE}
          </Button>
        </Cluster>
      </Stack>
    </Sheet>
  );
  // hidden, not gone, while a step stands: the step's opener (a socket) stays in the page, so «Back» returns the focus to it
  return <div hidden={hidden || undefined}>{sheet}</div>;
}
