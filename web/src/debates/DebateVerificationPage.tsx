import { useEffect, useState } from 'react';
import { Button, Header, Heading, Live, Mark, Mono, Note, Page, Receipt, Shell, Stack, Text } from '../ds';
import { debatePath } from '../route';
import { WorkerError, type DebateLineBytes } from '../seams/worker';
import { readShared } from './share';
import { verifyDebateLine, type DebateProof } from './proof';

type View = { kind: 'loading' | 'error' | 'deleted' } | { kind: 'ready'; proof: DebateProof; speaker: string };

export function DebateVerificationPage({ code, order }: { code: string; order: number }) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setView({ kind: 'loading' });
    void (async () => {
      try {
        const read = await readShared(code);
        const line = read.lines?.find((entry) => entry.order === order && entry.status === 'settled');
        if (!line || !line.requestBytes || !line.responseBytes || !line.signedCall || !line.receiptTxHash || !line.priceYocto) {
          if (live) setView({ kind: 'error' }); return;
        }
        const bytes: DebateLineBytes = { id: read.id, order, request_bytes: line.requestBytes,
          response_bytes: line.responseBytes, signed_call: line.signedCall, receipt_tx_hash: line.receiptTxHash,
          price_yocto: line.priceYocto };
        const proof = await verifyDebateLine(bytes, line.speakerPet);
        await readShared(code); // A memory clear may have revoked the code while NEAR answered.
        const speaker = line.speakerPet === read.firstPet?.tokenId ? read.firstPet?.name : read.secondPet?.name;
        if (live) setView({ kind: 'ready', proof, speaker: speaker ?? line.speakerPet });
      } catch (error) {
        if (live) setView({ kind: error instanceof WorkerError && error.status === 404 ? 'deleted' : 'error' });
      }
    })();
    return () => { live = false; };
  }, [code, order, revision]);
  const retry = () => setRevision((n) => n + 1);
  useEffect(() => {
    const visible = () => { if (!document.hidden) retry(); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) retry(); };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pageshow', restored);
    return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('pageshow', restored); };
  }, []);
  return <Shell header={<Header start={<Button variant="ghost" size="compact" icon="back" href={debatePath(code)}>Back to debate</Button>} />}>
    <Page width="narrow"><Stack gap={4}><Heading level={1} variant="title-2">Check this line</Heading>
      <Live>{view.kind === 'loading' ? 'Checking…' : view.kind === 'deleted' ? 'This debate is no longer available.' : ''}</Live>
      {view.kind === 'loading' ? <Note tone="status">Checking…</Note> : null}
      {view.kind === 'deleted' ? <><Note tone="error">This debate is no longer available.</Note><Button href="/">Go home</Button></> : null}
      {view.kind === 'error' ? <><Note tone="error">Could not load this debate. Try again.</Note><Button onClick={retry}>Try again</Button></> : null}
      {view.kind === 'ready' ? <Receipt title={`${view.speaker} · line ${order}`} marks={view.proof.kind === 'checked' || view.proof.kind === 'mismatch'
        ? <>
          <Mark state={view.proof.call.request === 'match' && view.proof.call.reply === 'match' ? 'ok' : 'fail'}>
            {view.proof.call.request === 'match' && view.proof.call.reply === 'match'
              ? 'Request and reply match the receipt on NEAR' : "Request or reply doesn't match the receipt on NEAR"}</Mark>
          <Mark state={view.proof.call.signature === 'match' ? 'ok' : 'fail'} under={view.proof.call.signature === 'match'
            ? view.proof.signatureKind === 'gateway'
              ? <Text variant="small" tone="secondary">Signed by this key — this page doesn't say whose key it is.</Text>
              : <Text variant="small" tone="secondary">This page checks the signature, not whose key it is. NEAR AI's page checks the key against the model's secure hardware — but only keys in use right now.</Text>
            : null}>{view.proof.call.signature === 'match' ? <>Signed by key <Mono>{view.proof.signer.length > 12
              ? `${view.proof.signer.slice(0, 4)}…${view.proof.signer.slice(-4)}` : view.proof.signer}</Mono></> : "Signature doesn't match the signed reply"}</Mark>
          <Mark state={view.proof.call.tokens === 'match' ? 'ok' : 'fail'}>
            {view.proof.call.tokens === 'match' ? 'Token counts and cut-off match the signed reply'
              : "This receipt's token counts don't match the signed reply."}</Mark>
        </> : undefined}>
        {view.proof.kind === 'too-old' ? <Note>Too old to check here. This page can only read about a day back on NEAR — the explorer has the whole history.</Note>
          : view.proof.kind === 'unavailable' ? <Note tone="error">We couldn't reach NEAR to check this just now. Try again.</Note>
            : <Text>{view.proof.kind === 'checked' ? 'The signature and the receipt here are real.' : "This line doesn't match the receipt on NEAR."}</Text>}
      </Receipt> : null}
    </Stack></Page></Shell>;
}
