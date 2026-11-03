import { Button, Cluster, Note, Sheet, SkillBadge, Stack, Text, TextField } from '../ds';
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

// Skill sheet (`Skill sheet screen`, `Skill writing flow`), drawn from design/bundle/screens/skill.js: the pet's ability card over the
// owner's conversation column (a bottom sheet on the phone). Top to bottom: the outcome line, the label field with the badge it makes
// beside its label, the private instruction with its lock, the two lines of «what the sheet says», «Forget this skill» (quiet, left)
// and «Save skill» (right). The sockets of the frames' lower part belong to `add-pet-errands` and are not drawn here (design.md ›
// `### Отклонения от кадров`).

export function SkillSheet({ name, skill, hasLabel, onClose }: { name: string; skill: ReturnType<typeof useSkill>; hasLabel: boolean; onClose: () => void }) {
  const { phase, label, instruction, written, top, labelError, busy } = skill;
  // a session that ended meets the line of `Session expiry flow`: «Sign in» brings the sheet back with both fields as typed
  const [session] = useSignInLines({ text: JSON.stringify({ label, instruction }), action: 'skill' });
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

  return (
    <Sheet title={title} column status={status} busy={busy} onClose={onClose}>
      <Stack gap={5}>
        {outcome?.node ?? null}
        <TextField
          label={skillLabelField(name)}
          value={label}
          onChange={skill.setLabel}
          maxLength={40}
          count
          hint={SKILL_LABEL_HINT}
          error={labelError ? SKILL_LABEL_REJECTED : undefined}
          aside={badge}
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
}
