import { useEffect, useState } from 'react';
import { Button, Message, Text, TextLink } from '../ds';
import type { Line } from '../screens/pet/usePetScreen';
import { experiencePath } from '../route';
import { workerApi } from '../seams/worker';
import { CHECK_THOUGHT, codeMissedLine, FORM_WORD, missedLine, SHARE_CARD } from './lines';
import { openVerdict } from './verdictRequest';

// The pet's report of an errand (`Errand flow` › «report», `Find out flow`, `Is it true flow`), drawn the way design/bundle/screens/errand.js
// has it: the find card under the pet's name — the form as its kicker, the verdict as a stamp at the top (or «Unclear — …» /
// «… found nothing solid» as its first line), the pet's words, the data source that did not answer as a grey line, «Sources» as links in
// new tabs, the exact price beside «Check this thought», and for «Is it true?» «Share card» under it.

export function ReportMessage({ line, name, tokenId, reveal, tokenOf }: { line: Line; name: string; tokenId: string; reveal: boolean; tokenOf: () => Promise<string | null> }) {
  const r = line.report!;
  const [hasNote, setHasNote] = useState<boolean | null>(null);
  const [poolEmpty, setPoolEmpty] = useState(false);
  useEffect(() => {
    let live = true;
    let terminal = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setHasNote(null);
    setPoolEmpty(false);
    const refresh = async () => {
      try {
        const token = await tokenOf();
        if (!token || !live || terminal) return;
        const thought = await workerApi.verificationThought(token, tokenId, line.id);
        if (!live || terminal) return;
        if (thought.billing === 'refused') {
          terminal = true;
          setPoolEmpty(thought.code === 'pool_empty');
          setHasNote(null);
          return;
        }
        if (thought.viewer !== 'owner') return;
        if (thought.status === 'billed') {
          terminal = true;
          setHasNote(thought.paidWork === true && thought.containsWorkNote === true);
          return;
        }
      } catch { /* A pending or unreachable receipt is checked again. */ }
      if (live && !terminal) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    const visible = () => { if (!terminal && document.visibilityState === 'visible') { clearTimeout(timer); void refresh(); } };
    document.addEventListener('visibilitychange', visible);
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [line.id, tokenId, tokenOf]);
  return (
    <Message
      from="report"
      speaker={name}
      fresh={line.fresh}
      kicker={FORM_WORD[r.form]}
      verdict={r.verdict ?? undefined}
      sources={r.sources.length > 0 ? r.sources : undefined}
      reveal={reveal}
      verify={{ href: `/pet/${tokenId}/verify/${line.id}`, label: CHECK_THOUGHT }}
      meta={poolEmpty ? 'Work is paused. Nothing was spent.' : r.meta}
      foot={poolEmpty || hasNote === null ? undefined : hasNote ? <>New work note · <TextLink href={experiencePath(tokenId)} tone="quiet" iconEnd="chevron">Review experience</TextLink></> : 'No work note this time'}
      actions={
        r.card ? (
          <Button variant="secondary" size="compact" icon="share" haspopup="dialog" onClick={() => openVerdict({ lineId: line.id, ...r.card! })}>
            {SHARE_CARD}
          </Button>
        ) : undefined
      }
    >
      {r.top ? <Text variant="body-strong">{r.top}</Text> : null}
      <Text>{line.text}</Text>
      {r.missed.map((missed) => (
        <Text key={typeof missed === 'string' ? missed : 'code'} variant="small" tone="secondary">
          {typeof missed === 'string' ? missedLine(missed, name) : codeMissedLine(name)}
        </Text>
      ))}
    </Message>
  );
}
