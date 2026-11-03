import { Button, Message, Text } from '../ds';
import type { Line } from '../screens/pet/usePetScreen';
import { CHECK_THOUGHT, codeMissedLine, FORM_WORD, missedLine, SHARE_CARD } from './lines';
import { openVerdict } from './verdictRequest';

// The pet's report of an errand (`Errand flow` › «report», `Find out flow`, `Is it true flow`), drawn the way design/bundle/screens/errand.js
// has it: the find card under the pet's name — the form as its kicker, the verdict as a stamp at the top (or «Unclear — …» /
// «… found nothing solid» as its first line), the pet's words, the data source that did not answer as a grey line, «Sources» as links in
// new tabs, the exact price beside «Check this thought», and for «Is it true?» «Share card» under it.

export function ReportMessage({ line, name, tokenId, reveal }: { line: Line; name: string; tokenId: string; reveal: boolean }) {
  const r = line.report!;
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
      meta={r.meta}
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
