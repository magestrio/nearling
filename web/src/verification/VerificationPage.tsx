import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccountControl } from '../account/AccountControl';
import { config } from '../config';
import { Banner, Block, Button, Center, Cluster, CopyField, Growth, Header, Heading, Live, Mark, Mono, Note, Only, Page,
  Receipt, ReceiptCall, ReceiptList, ReceiptRow, Record, RecordItem, Seal, Shell, Skeleton, Split,
  Stack, Text, TextLink, Sheet, Toast } from '../ds';
import type { Accent } from '../ds';
import { formatCents } from '../lib/price';
import { PetFigure } from '../pet/PetFigure';
import { makePet } from '../pet/proto/generator.js';
import { petPath, verifyPath } from '../route';
import { useAuth } from '../seams/auth';
import { nearRpc } from '../seams/rpc';
import { workerApi, WorkerError, type PetView, type SharedReceipt, type VerificationIndex, type VerificationThought } from '../seams/worker';
import { useSignIn } from '../signin/signIn';
import { centsAtRate, pointerDifferences, verifyPointer, type CheckState } from './checkMachine';
import { errandCallTitle, errandForm, errandTime, reportCall, stoppedSearch } from './errand';
import { hardwareHref } from './hardware';
import { loadRecord, type PetRecordModel } from './record';

type ListedThought = VerificationIndex['thoughts'][number];
type Ready = { kind: 'ready'; record: PetRecordModel; pet: PetView; index: VerificationIndex;
  thoughts: ListedThought[]; selected: VerificationThought | null; selectedMissing: boolean;
  payerName: string | null; proof: CheckState | null;
  /** NEAR could not be read for the record: the head, the Seal withheld, and the receipts the Worker lists. */
  unread?: boolean };
type State = { kind: 'loading'; pet?: PetView } | { kind: 'missing' | 'unavailable' } | Ready;
type DownloadPart = 'request' | 'reply';
type DownloadMark = 'match' | 'mismatch';

const UNREACHABLE = "We couldn't reach NEAR to check this just now. Try again.";
const TOO_OLD = 'Too old to check here. This page can only read about a day back on NEAR — the explorer has the whole history.';
const hardwareLine = "This page checks the signature, not whose key it is. NEAR AI's page checks the key against the model's secure hardware — but only keys in use right now.";

function date(at: number, year = false): string {
  const value = new Date(at);
  const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(value);
  const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(value);
  return `${day}${year ? ' · ' : ', '}${time}`;
}

function priceOf(thought: Pick<VerificationThought, 'priceYocto' | 'nearUsdRate'>, chainPrice = thought.priceYocto): string | null {
  const hundredths = centsAtRate(chainPrice, thought.nearUsdRate);
  if (hundredths === null) return null;
  // Already rounded to 0.01¢: two significant digits would print «0.080¢» for 8 hundredths, the frame says «0.08¢».
  return hundredths >= 1 && hundredths <= 9 ? `0.0${hundredths}¢` : formatCents(hundredths / 100);
}

const modelLabel = (model: string): string => model.split('/').at(-1) ?? model;
const shortHash = (hash: string): string => hash.length > 12 ? `${hash.slice(0, 4)}…${hash.slice(-4)}` : hash;

function replyFromBytes(bytes: Uint8Array): string | null {
  try {
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof body !== 'object' || body === null || !('choices' in body) || !Array.isArray(body.choices)) return null;
    const choice: unknown = body.choices[0];
    if (typeof choice !== 'object' || choice === null || !('message' in choice)) return null;
    const message: unknown = choice.message;
    return typeof message === 'object' && message !== null && 'content' in message && typeof message.content === 'string'
      ? message.content : null;
  } catch { return null; }
}

function requestMessages(thought: VerificationThought, n = 0): Array<{ role: string; content: string }> | null {
  if (thought.viewer !== 'owner' || thought.erased || thought.skilled || thought.adapterUsed) return null;
  const raw = thought.privateCalls?.find((call) => call.n === n)?.requestBase64;
  if (!raw) return null;
  try {
    const bytes = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof body !== 'object' || body === null || !('messages' in body) || !Array.isArray(body.messages)) return null;
    const messages = body.messages.map((entry: unknown) => typeof entry === 'object' && entry !== null
      && 'role' in entry && typeof entry.role === 'string' && 'content' in entry && typeof entry.content === 'string'
      ? { role: entry.role, content: entry.content } : null);
    return messages.every((message: { role: string; content: string } | null) => message !== null)
      ? messages as Array<{ role: string; content: string }> : null;
  } catch { return null; }
}

function nearOf(yocto: string): string {
  const value = BigInt(yocto);
  const fraction = (value % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
  return `${value / 10n ** 24n}${fraction ? `.${fraction}` : ''} NEAR`;
}

function txHref(hash: string): string {
  return `https://${config.nearNetwork === 'testnet' ? 'testnet.' : ''}nearblocks.io/txns/${encodeURIComponent(hash)}`;
}

function contractHref(): string {
  return `https://${config.nearNetwork === 'testnet' ? 'testnet.' : ''}nearblocks.io/address/${encodeURIComponent(config.contractId)}`;
}

function proofAnnouncement(thought: VerificationThought | null, proof: CheckState | null, record: PetRecordModel): string {
  if (proof?.kind === 'checking') return 'Checking…';
  if (proof?.kind !== 'checked' && proof?.kind !== 'mismatch') return '';
  const marks = proof.marks;
  const character = record.items.find((item) => item.kind === 'character')?.text;
  const report = thought?.calls.find((call) => reportCall(thought, call));
  const holdsCharacter = character && thought && report ? requestMessages(thought, report.n)?.some((message) => message.role === 'system' && message.content.includes(character)) : false;
  const failed = [
    ...(marks.calls.some((call) => call.request === 'mismatch') ? ["Request doesn't match the receipt on NEAR"] : []),
    ...(marks.calls.some((call) => call.reply === 'mismatch') ? ["Reply doesn't match the receipt on NEAR"] : []),
    ...(marks.calls.some((call) => call.tokens === 'mismatch') ? ["This receipt's token counts don't match the signed reply."] : []),
    ...(marks.calls.some((call) => call.signature === 'mismatch') ? ["Signature doesn't match the signed reply"] : []),
    ...(marks.price === 'mismatch' ? ["Price doesn't match the receipt on NEAR"] : []),
    ...(marks.hireFee === 'mismatch' ? ["Hire fee doesn't match the receipt on NEAR"] : []),
    ...(marks.skill === 'mismatch' ? ["Skill mark doesn't match the receipt on NEAR"] : []),
    ...thought && marks.receipt ? pointerDifferences(thought, marks.receipt)
      .filter((field) => field !== 'Price').map((field) => `${field} doesn't match the receipt on NEAR`) : [],
  ];
  if (failed.length > 0) return failed.join('. ');
  const lines = [
    ...(record.character === 'checked' ? ['Character sealed at hatch'] : []),
    ...(thought?.viewer === 'owner' && !thought.erased && !thought.skilled && !thought.adapterUsed && report
      && marks.calls[report.n]?.request === 'match' && holdsCharacter ? ["This receipt's request holds that character"] : []),
    ...(thought?.viewer === 'owner' && !thought.erased && (report
      ? marks.calls[report.n]?.reply === 'match' : marks.calls.some((call) => call.reply === 'match'))
      ? [report && !thought.skilled && !thought.adapterUsed && marks.calls[report.n]?.request === 'match'
        ? 'Request and reply match the receipt on NEAR' : 'Reply matches the receipt on NEAR'] : []),
    ...(thought?.viewer === 'owner' && !thought.erased && thought.calls.every((call) => stoppedSearch(call)
      || marks.calls[call.n]?.tokens === 'match')
      ? ['Token counts and cut-off match the signed reply'] : []),
    ...thought?.calls.flatMap((call) => marks.calls[call.n]?.signature === 'match' && marks.receipt?.calls[call.n]
      ? [`Signed by key ${marks.receipt.calls[call.n]!.signer}`] : []) ?? [],
  ];
  return lines.join('. ');
}

function RecordPanel({ tokenId, ready, onRetry }: { tokenId: string; ready: Ready; onRetry: () => void }) {
  const { record, pet } = ready;
  const checked = record.character !== 'mismatch' && !ready.unread;
  return <Stack gap={4}>
    <Stack gap={3}>
      <PetFigure tokenId={tokenId} name={record.name} stage={pet.stage} state={pet.fullness.state}
        outfit={pet.worn ?? undefined} size="md" decorative still />
      <Cluster gap={3} align="center"><Heading level={1} variant="title-2">{record.name}</Heading>
        {checked ? <Seal hash={record.characterHash} size="sm" /> : null}</Cluster>
      {ready.unread
        ? <Cluster gap={3} justify="space-between"><Note tone="error" silent>{`We can't check ${record.name}'s character on NEAR just now. Try again.`}</Note>
          <Button variant="secondary" size="compact" onClick={onRetry}>Try again</Button></Cluster>
        : record.character === 'mismatch'
        ? <Note tone="error" silent>{record.name}'s character no longer matches the hatch record.</Note>
        : <Text variant="small" tone="secondary">{`This mark identifies ${record.name}'s character hash checked on NEAR. The contract can be upgraded later.`}</Text>}
    </Stack>
    {ready.unread ? null : <>
    {pet.fullness.state === 'asleep' ? <Stack gap={2}>
      <Text>{`${record.name} is asleep — its record on NEAR is all still here. A meal wakes it up.`}</Text>
      <Button variant="secondary" size="compact" href={petPath(tokenId)}>{`Back to ${record.name}`}</Button>
    </Stack> : null}
    <Record>
      {record.items.map((item, i) => item.kind === 'source'
        ? <RecordItem key={`source-${i}`} proof={item.proof}>
          <Mono href={contractHref()}>{config.contractId}</Mono>
          <Text>Source code: <TextLink href={record.source.link} external>{record.source.link.replace(/^https?:\/\//, '')}</TextLink>{`, version ${record.source.version}`}</Text>
        </RecordItem>
        : <RecordItem key={`${item.kind}-${i}`} proof={item.kind === 'character' && record.character === 'mismatch' ? undefined : item.proof}
          tx={item.link === 'ready' && item.txHref && item.txHash ? { href: item.txHref, label: shortHash(item.txHash) } : undefined}>
          {item.kind === 'growth' && item.text.startsWith('Became a teen') ? <Growth stage="adult" /> : null}
          <Text>{item.text}{item.priceNear ? <> · <Mono>{item.priceNear}</Mono></> : null}</Text>
          {item.kind === 'character' && record.character === 'mismatch' && item.proof ? <Note tone="error" silent>{item.proof}</Note> : null}
          {item.link === 'not-ready' ? <Text variant="small" tone="secondary">Link appears shortly</Text> : null}
          {item.link === 'too-old' && item.txHref ? <Stack gap={2}><Text variant="small">{TOO_OLD}</Text>
            <TextLink href={item.txHref} external>See it on the explorer</TextLink></Stack> : null}
        </RecordItem>)}
    </Record></>}
  </Stack>;
}

export function ReceiptPanel({ thought, proof, record, payerName, footer, intro, shared, sharedReply }: { thought: VerificationThought; proof: CheckState | null;
  record: PetRecordModel; payerName: string | null; footer?: ReactNode; intro?: ReactNode;
  shared?: { onDownload: (n: number, part: DownloadPart) => void; marks: Record<string, DownloadMark> };
  sharedReply?: string | null }) {
  const marks = proof?.marks;
  const chain = marks?.receipt;
  const unidentified = proof?.kind === 'mismatch' && !chain;
  const price = unidentified ? null : priceOf(thought, chain?.price);
  const displayCalls: VerificationThought['calls'] = chain
    ? chain.calls.map((call, n) => thought.calls[n] ?? { ...call, n }) : thought.calls;
  const pointerFields = chain ? pointerDifferences(thought, chain).filter((field) => field !== 'Price') : [];
  const stopped = (call: VerificationThought['calls'][number]) => stoppedSearch({ ...call,
    cut: chain?.calls[call.n]?.cut ?? call.cut, signature: chain?.calls[call.n]?.signature ?? call.signature });
  const owner = thought.viewer === 'owner';
  const hasReceipt = (proof?.kind === 'checked' || proof?.kind === 'mismatch') && !!chain;
  // an errand with no Report (two empty searches) shows the job its searches carried
  const report = thought.calls.find((call) => reportCall(thought, call))
    ?? (thought.kind === 'errand' ? thought.calls.find((call) => !stopped(call)) : undefined);
  const checking = proof?.kind === 'checking';
  // the pointer's own tokens and the request are still shown before the check, and when the archive is closed
  const showCalls = hasReceipt || checking || proof?.kind === 'too-old';
  const messages = showCalls && report ? requestMessages(thought, report.n) : null;
  const request = messages?.map((message) => message.content).join(' · ') ?? null;
  const character = record.items.find((item) => item.kind === 'character')?.text;
  const holdsCharacter = character && messages?.some((message) => message.role === 'system' && message.content.includes(character));
  const callMarks = (n: number) => {
    const checked = marks?.calls[n];
    const call = marks?.receipt?.calls[n];
    const pointerCall = thought.calls[n];
    if (!checked || !call || (pointerCall && stopped(pointerCall))) return null;
    const requestVisible = owner && !thought.erased && !thought.skilled && !thought.adapterUsed && checked.request !== 'unavailable';
    const wordsVisible = owner && !thought.erased;
    const hardware = hardwareHref(thought, n, marks?.receipt);
    return <>
      {requestVisible && checked.request === 'mismatch' ? <Mark state="fail">Request doesn't match the receipt on NEAR</Mark> : null}
      {requestVisible && checked.request === 'match' && holdsCharacter && pointerCall && reportCall(thought, pointerCall)
        && (displayCalls.length === 1 || thought.kind === 'errand') ? <Mark>This receipt's request holds that character</Mark> : null}
      {wordsVisible && checked.reply !== 'unavailable' && (checked.reply === 'mismatch' || checked.request === 'match' || !requestVisible) ? <Mark state={checked.reply === 'mismatch' ? 'fail' : 'ok'}>
        {checked.reply === 'mismatch' ? "Reply doesn't match the receipt on NEAR"
          : requestVisible ? 'Request and reply match the receipt on NEAR' : 'Reply matches the receipt on NEAR'}
      </Mark> : null}
      {wordsVisible && checked.tokens !== 'unavailable' ? <Mark state={checked.tokens === 'mismatch' ? 'fail' : 'ok'}>
        {checked.tokens === 'mismatch' ? "This receipt's token counts don't match the signed reply."
          : 'Token counts and cut-off match the signed reply'}
      </Mark> : null}
      {checked.signature !== 'unavailable' ? <Mark state={checked.signature === 'mismatch' ? 'fail' : 'ok'}
        under={checked.signature === 'match' ? call.sig_kind === 'gateway'
          ? <Text variant="small" tone="secondary">Signed by this key — this page doesn't say whose key it is.</Text>
          : <Stack gap={1}>{hardware ? <TextLink href={hardware} external tone="trust">Check the hardware on NEAR AI</TextLink> : null}
            <Text variant="small" tone="secondary">{hardwareLine}</Text></Stack> : null}>
        {checked.signature === 'mismatch' ? "Signature doesn't match the signed reply" : <>Signed by key <span title={call.signer} aria-label={call.signer}><Mono>{shortHash(call.signer)}</Mono></span></>}
      </Mark> : null}
    </>;
  };
  const publicMarks = hasReceipt ? <>
    {record.character === 'checked' ? <Mark>Character sealed at hatch</Mark> : null}
    {marks?.price === 'mismatch' ? <Mark state="fail">Price doesn't match the receipt on NEAR</Mark> : null}
    {marks?.hireFee === 'mismatch' ? <Mark state="fail">Hire fee doesn't match the receipt on NEAR</Mark> : null}
    {marks?.skill === 'mismatch' ? <Mark state="fail">Skill mark doesn't match the receipt on NEAR</Mark> : null}
    {pointerFields.map((field) => <Mark key={field} state="fail">{field} doesn't match the receipt on NEAR</Mark>)}
    {displayCalls.length === 1 ? callMarks(0) : null}
    {/* several calls carry their own checks; the character's mark stays with the receipt */}
    {displayCalls.length > 1 && thought.kind !== 'errand' && holdsCharacter && report && owner && !thought.erased
      && !thought.skilled && !thought.adapterUsed && marks?.calls[report.n]?.request === 'match'
      ? <Mark>This receipt's request holds that character</Mark> : null}
  </> : null;
  const foot = checking ? <Note tone="status" silent>Checking…</Note>
    : proof?.kind === 'too-old' && thought.debitTxHash
    ? <Stack gap={2}><Text>{TOO_OLD}</Text><TextLink href={txHref(thought.debitTxHash)} external>See it on the explorer</TextLink></Stack>
    : proof?.kind === 'project-paid' ? <Text>{`Paid by the game · no receipt. You can check ${record.name}'s pet record, but this thought has no on-chain receipt to check.`}</Text>
      : proof?.kind === 'pending' ? thought.erased ? null
        : <Text>{`Not on NEAR yet. You can check ${record.name}'s pet record now; this thought's receipt can be checked after it lands on NEAR.`}</Text>
        : proof?.kind === 'unavailable' ? <Text>{UNREACHABLE}</Text> : null;
  const cutSearch = thought.calls.some(stopped);
  const errandSkill = thought.kind === 'errand' && thought.skilled;
  const skilledMarksPass = thought.skilled && proof?.kind === 'checked' && report
    && marks?.calls[report.n]?.reply === 'match'
    && thought.calls.every((call) => stopped(call) || (marks?.calls[call.n]?.signature === 'match'
      && marks.calls[call.n]?.tokens === 'match'));
  const detailFoot = hasReceipt && (cutSearch || errandSkill || thought.skilled) ? <Stack gap={2}>
    {cutSearch ? <Text>{`The game stopped this call when ${record.name} began a search it hadn't paid for. A stopped call has no signature or token counts.`}</Text> : null}
    {errandSkill && owner ? <Text>{`${record.name}'s skill shaped this report, so its full request isn't kept — this page checks the reply and its token counts.`}</Text>
      : thought.skilled && owner ? <Text>A private skill shaped this answer, so its full request stays hidden — even from you.</Text>
        : null}
    {skilledMarksPass && owner ? <Text>The signature and the receipt here are real.</Text> : null}
  </Stack> : null;
  const title = thought.kind === 'errand' && errandForm(thought) ? `${errandForm(thought)}${price ? ` · ${price}` : ''}`
    : thought.kind === 'hire_answer' && payerName ? `${record.name} answered for ${payerName}${!unidentified && thought.fee ? ` · fee ${formatCents(thought.fee.fee_usd_micros / 10000)}` : ''}${price ? ` · answer ${price}` : ''}`
    : thought.kind === 'hire_question' && payerName ? `${record.name}'s question for ${payerName}${price ? ` · ${price}` : ''}` : undefined;
  return <Receipt title={title} label={title ? undefined : date(thought.at, true)} marks={publicMarks}
    foot={footer ? <Stack gap={2}>{foot ?? detailFoot}{footer}</Stack> : foot ?? detailFoot}>
    {intro}
    <Text variant={(thought.erased && (proof?.kind === 'pending' || hasReceipt)) || (owner && thought.kind === 'deep' && thought.replyText && !thought.erased) ? 'lead' : undefined}>{thought.erased && proof?.kind === 'pending'
      ? `This receipt is still being recorded on NEAR, and these words were cleared. You can check ${record.name}'s pet record now; after the receipt lands, only its public hashes and signature can be checked.`
      : thought.erased && hasReceipt
      ? 'These words were cleared. You can still check the public receipt and signature on NEAR, but the request and reply can no longer be matched word for word here.'
      : thought.kind === 'errand' && !thought.calls.some((call) => call.label === 'report') && thought.calls.filter((call) => call.label === 'search').length === 2
        ? "Neither call ran a search, so there's no report to show. Both were still paid for, so they have a receipt."
      : thought.withoutReply ? 'No reply to show from this call. It was still paid for, so it has a receipt.'
        : shared && sharedReply !== null && sharedReply !== undefined ? sharedReply
        : owner && thought.replyText && !thought.erased ? thought.replyText
          : thought.skilled ? 'Only the owner of the pet that paid for this thought can see its words. A private skill shaped it, so nobody can check its request in full.'
            : 'Only the owner of the pet that paid for this thought can see its words and check it in full.'}</Text>
    <Cluster gap={3}><Text variant="small"><Mono>{date(thought.at, true)}</Mono><Text as="span" variant="small" tone="secondary">{errandTime(thought) ? ` · ${errandTime(thought)}` : ''} · saved by the game, not on NEAR</Text></Text>
      {!unidentified ? <Text variant="small" tone="secondary">{modelLabel(chain?.model ?? thought.model)}</Text> : null}
      {price && proof?.kind !== 'project-paid' ? <Text variant="small">{thought.kind === 'errand' && displayCalls.length === 2 && !thought.calls.some((call) => reportCall(thought, call)) ? 'Both calls · ' : thought.kind === 'deep' && displayCalls.length > 1 ? 'Both calls · ' : thought.kind === 'deep' ? 'Thought hard · ' : null}<Mono>{price}{/^\d+$/.test(chain?.price ?? thought.priceYocto) ? ` · ${nearOf(chain?.price ?? thought.priceYocto)}` : ''}</Mono></Text> : null}
      {thought.debitTxHash ? <Mono href={txHref(thought.debitTxHash)}>{shortHash(thought.debitTxHash)}</Mono> : null}</Cluster>
    {showCalls ? displayCalls.map((call) => <ReceiptCall key={call.n} level={2}
      title={shared ? `Call ${call.n + 1} · ${call.n === 0 ? 'Thinking — ran out of room' : 'Quick re-ask'}`
        : thought.kind === 'errand' ? errandCallTitle(call) ?? undefined : displayCalls.length > 1 ? call.n === 0 ? 'Thinking — ran out of room' : 'Quick re-ask' : undefined}
      titleId={shared ? `call-${call.n + 1}` : undefined}
      tokens={stopped(call) ? undefined : `${(chain?.calls[call.n]?.tokens_in ?? call.tokens_in).toLocaleString('en-US')} tokens in · ${(chain?.calls[call.n]?.tokens_out ?? call.tokens_out).toLocaleString('en-US')} out${(chain?.calls[call.n]?.tokens_reasoning ?? call.tokens_reasoning) ? ` · ${(chain?.calls[call.n]?.tokens_reasoning ?? call.tokens_reasoning).toLocaleString('en-US')} thinking` : ''}`}
      cut={(chain?.calls[call.n]?.cut ?? Boolean(call.cut)) && !stopped(call) ? 'Cut off at its limit' : undefined}
      marks={thought.calls.length > 1 ? callMarks(call.n) : undefined}>
      {stopped(call) ? <Text variant="small">Stopped by the game</Text> : null}
      {!owner || thought.erased || thought.calls.length > 1 || thought.kind === 'errand' ? <Cluster gap={3}><Mono>{shortHash(chain?.calls[call.n]?.req_sha256 ?? call.req_sha256)}</Mono><Mono>{shortHash(chain?.calls[call.n]?.res_sha256 ?? call.res_sha256)}</Mono></Cluster> : null}
      {shared ? <Stack gap={2}><Cluster gap={2}>
        <Button variant="secondary" size="compact" icon="download" nameWith={`call-${call.n + 1}`} onClick={() => shared.onDownload(call.n, 'request')}>Download request bytes</Button>
        <Button variant="secondary" size="compact" icon="download" nameWith={`call-${call.n + 1}`} onClick={() => shared.onDownload(call.n, 'reply')}>Download reply bytes</Button>
      </Cluster><ul className="ds-receipt__marks">
        {shared.marks[`${call.n}:request`] === 'mismatch' ? <Mark state="fail">Request doesn't match the receipt on NEAR</Mark> : null}
        {shared.marks[`${call.n}:reply`] === 'mismatch' ? <Mark state="fail">Reply doesn't match the receipt on NEAR</Mark> : null}
        {shared.marks[`${call.n}:request`] === 'match' && shared.marks[`${call.n}:reply`] === 'match'
          ? <Mark>Request and reply match the receipt on NEAR</Mark> : null}
      </ul></Stack> : null}
    </ReceiptCall>) : null}
    {request ? <Text variant="small" tone="secondary">{request}</Text> : null}
  </Receipt>;
}

function ReceiptLinkPage({ code }: { code: string }) {
  const [link, setLink] = useState<SharedReceipt | 'loading' | 'unknown' | 'unavailable'>('loading');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setLink('loading');
    void workerApi.sharedReceipt(code).then((answer) => { if (live) setLink(answer); }).catch((error: unknown) => {
      if (live) setLink(error instanceof WorkerError && error.status === 404 ? 'unknown' : 'unavailable');
    });
    return () => { live = false; };
  }, [code, revision]);
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) setRevision((n) => n + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  if (typeof link === 'object' && 'status' in link && link.status === 'live') return <VerificationPage tokenId={link.thought.tokenId}
    thoughtId={link.thought.id} shared={{ code, refresh: () => setRevision((n) => n + 1) }} />;
  const revoked = typeof link === 'object' && 'code' in link && link.code === 'revoked';
  const message = revoked ? 'This receipt link no longer shares its words. The on-chain receipt is still public.'
    : link === 'unknown' ? "This receipt link doesn't exist. Check the address and try again." : UNREACHABLE;
  if (link === 'loading') return <><Live /><Shell><Page><Skeleton /></Page></Shell></>;
  return <><Live>{message}</Live><Shell fill><Page fill width="narrow"><Center>
    <Heading level={1} variant="title-2" align="center">{message}</Heading>
    {revoked ? <Button href={verifyPath(link.tokenId, link.thoughtId)}>View public receipt</Button>
      : link === 'unknown' ? <Button href="/">Go home</Button> : <Button onClick={() => setRevision((n) => n + 1)}>Try again</Button>}
  </Center></Page></Shell></>;
}

export function VerificationPage({ tokenId, thoughtId, code, shared }: { tokenId?: string; thoughtId?: string | null;
  code?: string; shared?: { code: string; refresh: () => void } }) {
  const auth = useAuth();
  const signIn = useSignIn();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<{ operationId: string; status: 'ready' | 'publishing' | 'error' | 'published'; path?: string } | null>(null);
  const [downloadMarks, setDownloadMarks] = useState<Record<string, DownloadMark>>({});
  const [downloadError, setDownloadError] = useState<{ n: number; part: DownloadPart; chain: boolean } | null>(null);
  const [sharedReply, setSharedReply] = useState<string | null>(null);
  const [sharedReplyHash, setSharedReplyHash] = useState<{ n: number; hash: string } | null>(null);
  const [copyOutcome, setCopyOutcome] = useState<'success' | 'failure' | null>(null);
  const copyInput = useRef<HTMLTextAreaElement>(null);
  const downloadGeneration = useRef(0);
  const retry = () => setRevision((n) => n + 1);
  useEffect(() => {
    setDialog(null); setDownloadMarks({}); setDownloadError(null); setSharedReply(null); setSharedReplyHash(null); setCopyOutcome(null);
    return () => { downloadGeneration.current += 1; };
  }, [tokenId, thoughtId, auth.authenticated, revision]);
  const publish = async () => {
    if (!dialog || !tokenId || !thoughtId) return;
    const operationId = dialog.operationId;
    if (!auth.needSession()) { auth.endSession(false, true); setDialog(null); setState({ kind: 'loading' }); return; }
    setDialog({ operationId, status: 'publishing' });
    try {
      const token = await auth.getIdentityToken();
      if (!token) throw new WorkerError(401, 'signed_out');
      const result = await workerApi.publishReceipt(token, tokenId, thoughtId, operationId);
      setDialog({ operationId, status: 'published', path: result.path });
    } catch (error) {
      if (error instanceof WorkerError && error.status === 401) {
        auth.endSession(false, true);
        setDialog(null);
        setState({ kind: 'loading' });
      } else setDialog({ operationId, status: 'error' });
    }
  };
  useEffect(() => {
    if (!shared || !tokenId || !thoughtId) return;
    let live = true;
    const selected = state.kind === 'ready' ? state.selected : null;
    const last = selected?.calls.at(-1);
    if (!last) return;
    void workerApi.receiptBytes(shared.code, last.n, 'reply').then(async (bytes) => {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
        (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (live) { setSharedReply(replyFromBytes(bytes)); setSharedReplyHash({ n: last.n, hash }); }
    }).catch((error: unknown) => {
      if (!live) return;
      if (error instanceof WorkerError && error.status === 410) shared.refresh();
      else setDownloadError({ n: last.n, part: 'reply', chain: error instanceof WorkerError
        && (error.code === 'chain_unreachable' || error.code === 'receipt_unavailable') });
    });
    return () => { live = false; };
  }, [shared?.code, tokenId, thoughtId, state.kind === 'ready' ? state.selected : null]);
  useEffect(() => {
    if (!sharedReplyHash || state.kind !== 'ready') return;
    const expected = state.proof?.marks?.receipt?.calls[sharedReplyHash.n]?.res_sha256;
    if (expected) setDownloadMarks((old) => ({ ...old, [`${sharedReplyHash.n}:reply`]:
      sharedReplyHash.hash === expected ? 'match' : 'mismatch' }));
  }, [sharedReplyHash, state.kind === 'ready' ? state.proof : null]);
  const download = async (n: number, part: DownloadPart) => {
    if (!shared || state.kind !== 'ready' || !state.selected) return;
    const generation = downloadGeneration.current;
    setDownloadError(null);
    try {
      const bytes = await workerApi.receiptBytes(shared.code, n, part);
      if (generation !== downloadGeneration.current) return;
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
        (byte) => byte.toString(16).padStart(2, '0')).join('');
      const expected = state.proof?.marks?.receipt?.calls[n]?.[part === 'request' ? 'req_sha256' : 'res_sha256'];
      if (expected) setDownloadMarks((old) => ({ ...old, [`${n}:${part}`]: hash === expected ? 'match' : 'mismatch' }));
      const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'application/octet-stream' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `call-${n}-${part}.bin`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      if (generation !== downloadGeneration.current) return;
      if (error instanceof WorkerError && error.status === 410) { shared.refresh(); return; }
      setDownloadError({ n, part, chain: error instanceof WorkerError
        && (error.code === 'chain_unreachable' || error.code === 'receipt_unavailable') });
    }
  };
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) retry(); };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) retry(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('pageshow', onPageShow); };
  }, []);
  useEffect(() => {
    if (!tokenId || !auth.ready || !auth.authenticated) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      setState({ kind: 'loading' });
      retry();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [tokenId, auth.ready, auth.authenticated]);
  useEffect(() => {
    if (state.kind !== 'ready' || !state.selected || state.selected.status === 'billed'
      || state.selected.status === 'project') return;
    const now = Date.now();
    const untilMidnight = 86_400_000 - (now % 86_400_000);
    const timer = window.setTimeout(() => { setState({ kind: 'loading' }); retry(); }, untilMidnight);
    return () => window.clearTimeout(timer);
  }, [state.kind === 'ready' ? state.selected?.status : null, tokenId, thoughtId, revision]);
  useEffect(() => {
    if (!tokenId || !auth.ready) return;
    let live = true;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const token = auth.authenticated ? await auth.getIdentityToken() : null;
        if (auth.authenticated && token === null) { auth.endSession(false); return; }
        // the pet's name and account control are in the header as soon as the Worker has them, before NEAR is read
        const petRead = workerApi.pet(token, tokenId).catch((error: unknown) => {
          if (error instanceof WorkerError && error.status === 404) return null;
          throw error;
        });
        void petRead.then((found) => { if (live && found) setState((now) => now.kind === 'loading' ? { kind: 'loading', pet: found } : now); }, () => {});
        const [index, pet] = await Promise.all([workerApi.verificationIndex(tokenId), petRead]);
        let unread = false;
        // NEAR unread (not a pet missing there): the pet still has its head and the Worker's receipts, only the Seal waits
        const record = await loadRecord(nearRpc, tokenId, index, config.contractId, config.serverAccountId, config.nearNetwork)
          .catch((error: unknown): PetRecordModel => {
            if (!pet) throw error;
            unread = true;
            return { name: pet.name, characterHash: '', character: 'unavailable', items: [], source: { version: '', link: '' } };
          });
        if (!record) { if (live) setState({ kind: 'missing' }); return; }
        if (!pet) { if (live) setState({ kind: 'unavailable' }); return; }
        const thoughts = index.thoughts;
        let selected: VerificationThought | null = null;
        let selectedMissing = false;
        if (thoughtId && !selected) {
          try { selected = await workerApi.verificationThought(token, tokenId, thoughtId); }
          catch (error) { if (error instanceof WorkerError && error.status === 404) selectedMissing = true; else throw error; }
        }
        const otherPetId = selected?.kind === 'hire_question' ? selected.workerTokenId
          : selected?.payingTokenId !== tokenId ? selected?.payingTokenId : null;
        const payerName = otherPetId ? (await workerApi.pet(null, otherPetId).catch(() => null))?.name ?? null : null;
        const checking: CheckState | null = selected ? { kind: 'checking', marks: null } : null;
        if (live) setState({ kind: 'ready', record, pet, index, thoughts, selected, selectedMissing, payerName, proof: checking, unread });
        const proof = selected ? await verifyPointer(nearRpc, selected, config.contractId, config.serverAccountId) : null;
        if (live) setState({ kind: 'ready', record, pet, index, thoughts, selected, selectedMissing, payerName, proof, unread });
      } catch (error) {
        if (!live) return;
        if (error instanceof WorkerError && error.status === 401) auth.endSession(false);
        else setState({ kind: 'unavailable' });
      }
    })();
    return () => { live = false; };
  }, [tokenId, thoughtId, auth.ready, auth.authenticated, revision]);

  if (code) return <ReceiptLinkPage code={code} />;
  if (!tokenId) return null;
  if (state.kind === 'missing') return <><Live /><Shell fill><Page fill width="narrow"><Center>
    <Heading level={1} variant="title-2" align="center">We couldn't find this pet on NEAR. The link may be broken.</Heading>
    <Button href="/">Go home</Button>
  </Center></Page></Shell></>;
  if (state.kind === 'loading') return <><Live /><Shell accent="none" header={<Header start={<Button variant="ghost" size="compact" icon="back" href={petPath(tokenId)}>{state.pet ? `Back to ${state.pet.name}` : 'Back to pet'}</Button>}
    end={<AccountControl tokenId={tokenId} name={state.pet?.name} viewer={state.pet?.viewer} />} />}><Page><Split ratio="end"
      start={<Stack gap={4}><Skeleton shape="name" /><Skeleton /><Skeleton /><Note tone="status">Reading this pet's record on NEAR…</Note></Stack>}
      end={<Stack gap={3}><Skeleton /><Skeleton /><Skeleton shape="short" /></Stack>} /></Page></Shell></>;
  if (state.kind === 'unavailable') return <><Live>{UNREACHABLE}</Live><Shell fill><Page fill width="narrow"><Center>
    <Heading level={1} variant="title-2" align="center">{UNREACHABLE}</Heading>
    <Button onClick={retry}>Try again</Button>
  </Center></Page></Shell></>;
  if (state.kind !== 'ready') return null;

  const { record, pet, thoughts, selected, selectedMissing, proof, payerName } = state;
  const name = record.name;
  const selectedReceiptUnknown = proof?.kind === 'mismatch' && !proof.marks.receipt;
  const eligible = selected?.viewer === 'owner' && selected.status === 'billed' && !selected.erased
    && !selected.skilled && !selected.adapterUsed && (proof?.kind === 'checked' || proof?.kind === 'mismatch')
    && !!proof.marks.receipt
    && selected.calls.length > 0 && selected.calls.every((call) => {
      const bytes = selected.privateCalls?.find((entry) => entry.n === call.n);
      return Boolean(bytes?.requestBase64 && bytes.replyBase64);
    });
  const shareFooter = selected?.viewer === 'owner' && !shared && proof?.kind !== 'checking' && proof?.kind !== 'too-old' ? eligible
    ? <Button variant="secondary" size="compact" icon="share" haspopup="dialog"
      onClick={() => setDialog({ operationId: crypto.randomUUID(), status: 'ready' })}>Share exact bytes</Button>
    : <Text variant="small" tone="secondary">Exact bytes can't be shared for this receipt.</Text> : null;
  const intro = shared ? <Stack gap={2}><Text variant="small">{`These bytes were shared by ${name}'s owner. Compare their hashes with the receipt on NEAR.`}</Text>
    {downloadError ? <Cluster gap={3} justify="space-between"><Note tone="error">{downloadError.chain ? UNREACHABLE
      : "The bytes couldn't be downloaded just now. Try again."}</Note>
      <Button variant="secondary" size="compact" onClick={() => download(downloadError.n, downloadError.part)}>Try again</Button></Cluster> : null}</Stack> : null;
  const sharedControls = shared ? { onDownload: download, marks: downloadMarks } : undefined;
  const open = selected ? <ReceiptPanel thought={selected} proof={proof} record={record} payerName={payerName}
    footer={shareFooter} intro={intro} shared={sharedControls} sharedReply={sharedReply} /> : null;
  const signedOut = !auth.authenticated;
  const networkError = proof?.kind === 'unavailable' || record.items.some((item) => item.link === 'unavailable');
  return <><Live>{state.unread ? `We can't check ${name}'s character on NEAR just now. Try again.` : proof?.kind === 'too-old' ? TOO_OLD : networkError ? UNREACHABLE : proofAnnouncement(selected, proof, record)}</Live>
    <Shell accent={makePet(tokenId).hue as Accent} header={<Header start={<Button variant="ghost" size="compact" icon="back" href={petPath(tokenId)}>{`Back to ${name}`}</Button>}
    end={<AccountControl tokenId={tokenId} name={name} viewer={pet.viewer} />} />}>
    <Page><Stack gap={5}>
      {networkError ? <Banner action={<Button variant="secondary" size="compact" onClick={retry}>Try again</Button>}>{UNREACHABLE}</Banner> : null}
      {record.character === 'mismatch' ? <Note tone="error" silent>{`${name}'s character no longer matches the hatch record.`}</Note> : null}
      {signedOut && !shared ? <Block role="trust" icon="verify" quiet><Text>{`Anyone can check ${name}'s record and receipts. Is ${name} yours? Sign in to check its other thoughts word for word.`}</Text>
        <Button variant="secondary" size="compact" onClick={() => signIn.begin('signin')}>Sign in</Button></Block> : null}
      {selectedMissing ? <Note tone="plain">{`We couldn't find that thought. Here's ${name}'s record instead.`}</Note> : null}
      {open ? <Only on="phone">{open}</Only> : null}
      <Split ratio="end" start={<RecordPanel tokenId={tokenId} ready={state} onRetry={retry} />}
        end={<Stack gap={5}>
          {open ? <Only on="desktop">{open}</Only> : null}
          {shared ? null : thoughts.length === 0 ? <Text>{`No thoughts yet. Each of ${name}'s thoughts gets a receipt here.`}</Text>
            : <ReceiptList>{thoughts.map((thought) => <ReceiptRow key={thought.id}
              href={verifyPath(tokenId, thought.id)} current={thought.id === thoughtId}
              time={date(thought.at)} model={thought.status === 'billed' && !(thought.id === thoughtId && selectedReceiptUnknown) ? modelLabel(thought.model) : null}
              price={thought.status === 'billed' && !(thought.id === thoughtId && selectedReceiptUnknown) ? priceOf(thought) : null}
              note={thought.status === 'project' ? 'Paid by the game · no receipt'
                : thought.status !== 'billed' ? 'Not on NEAR yet' : thought.withoutReply ? 'No reply' : null} />)}</ReceiptList>}
          {!shared && thoughts.length > 0 ? <TextLink href={contractHref()} external>See every pet's receipts on the explorer</TextLink> : null}
        </Stack>} />
      {signedOut && shared ? <Cluster gap={3}>
        <Text variant="small" tone="secondary">{`Anyone can check ${name}'s record and receipts. Is ${name} yours? Sign in to check its other thoughts word for word.`}</Text>
        <Button variant="ghost" size="compact" onClick={() => signIn.begin('signin')}>Sign in</Button></Cluster> : null}
    </Stack></Page>
    {dialog ? <Sheet title="Share exact bytes" centered busy={dialog.status === 'publishing'}
      status={copyOutcome === 'success' ? 'Link copied — send it to a friend.'
        : copyOutcome === 'failure' ? "Couldn't copy the link. Select it here to copy it."
          : dialog.status === 'published' ? 'Receipt link published.' : ''} onClose={() => setDialog(null)}>
      {dialog.status === 'published' && dialog.path ? <Stack gap={2}>
        <CopyField label="Receipt link" value={`${location.origin}${dialog.path}`} inputRef={copyInput}
          copyLabel="Copy link" onCopy={() => {
            const value = `${location.origin}${dialog.path}`;
            void (async () => {
              try { await navigator.clipboard.writeText(value); setCopyOutcome('success'); }
              catch {
                setCopyOutcome('failure');
                copyInput.current?.focus();
                copyInput.current?.select();
              }
            })();
          }} />
        <Text>{`Anyone with this link can read and download this thought's words until you give ${name} away or clear its memory.`}</Text>
        {copyOutcome ? <Toast silent onDone={() => setCopyOutcome(null)}>{copyOutcome === 'success'
          ? 'Link copied — send it to a friend.' : "Couldn't copy the link. Select it here to copy it."}</Toast> : null}
        <Button block variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Stack> : dialog.status === 'error' ? <Stack gap={2}>
        <Note tone="error">We couldn't publish this receipt link. Nothing was shared. Try again.</Note>
        <Button block onClick={() => { void publish(); }}>Try again</Button>
        <Button block variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Stack> : <Stack gap={2}>
        <Text>{`Anyone with this link can download the exact request and reply, including your words, ${name}'s memory and text not shown in the chat. Giving ${name} away or clearing its memory ends access, but cannot erase files a visitor already downloaded.`}</Text>
        <Button block pending={dialog.status === 'publishing'} onClick={() => { void publish(); }}>Publish receipt link</Button>
        <Button block variant="secondary" focusOnOpen off={dialog.status === 'publishing'} onClick={() => setDialog(null)}>Cancel</Button>
      </Stack>}
    </Sheet> : null}
  </Shell></>;
}
