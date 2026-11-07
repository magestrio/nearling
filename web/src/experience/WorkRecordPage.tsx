import { useCallback, useEffect, useRef, useState } from 'react';
import { AccountControl } from '../account/AccountControl';
import { Button, Centerpiece, Cluster, Facts, Header, Heading, Live, Note, Page, Shell, Skeleton, Stack, Surface, Text, TextLink } from '../ds';
import { FeedLayer } from '../feeding/FeedLayer';
import { openFeed } from '../feeding/feedRequest';
import { PetFigure } from '../pet/PetFigure';
import { makePet } from '../pet/proto/generator.js';
import { petPath, verifyPath } from '../route';
import { useAuth } from '../seams/auth';
import { nearRpc } from '../seams/rpc';
import { workerApi, WorkerError, type PetView, type WorkRecord } from '../seams/worker';
import { config } from '../config';
import { useSignIn } from '../signin/signIn';
import { countedDate, checkedRecord, type ChainWorkCount } from './recordState';
import { PetNotFound } from '../screens/pet/PetScreen';
import { onClearOutcome } from '../account/clearMemory';

type State = { kind: 'loading' | 'error' | 'unknown' } | { kind: 'ready'; record: WorkRecord; version: string };

/** The public page never asks for a session to read the record. */
export function WorkRecordPage({ pet }: { pet: PetView }) {
  const { tokenId, name } = pet;
  const auth = useAuth();
  const signIn = useSignIn();
  const workVersion = pet.viewer === 'owner' ? `${pet.viewer}:${auth.nearAccountId}:${pet.memoryEpoch}:${pet.lastThought}:${pet.hiresSeen}:${pet.pendingJob}` : `${pet.viewer}:${auth.nearAccountId}`;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const serial = useRef(0);
  const activeReads = useRef(0);
  const opened = useRef<string | null>(null);
  const read = useCallback(async (showLoading = true) => {
    if (!showLoading && activeReads.current > 0) return;
    activeReads.current += 1;
    const turn = ++serial.current;
    if (showLoading) setState({ kind: 'loading' });
    try {
      const [record, chain] = await Promise.all([
        workerApi.workRecord(tokenId),
        nearRpc.viewFunction<ChainWorkCount | null>(config.contractId, 'experience_view', { token_id: tokenId }),
      ]);
      const checked = checkedRecord(record, chain, tokenId);
      if (turn !== serial.current) return;
      setState(checked ? { kind: 'ready', record: checked, version: workVersion } : { kind: chain === null ? 'unknown' : 'error' });
      if (checked && opened.current !== tokenId) {
        opened.current = tokenId;
        void workerApi.experienceRecordOpened({ tabId: crypto.randomUUID(), playerId: crypto.randomUUID(), petId: crypto.randomUUID() }).catch(() => {});
      }
    } catch (error) {
      if (turn !== serial.current) return;
      setState({ kind: error instanceof WorkerError && error.status === 404 ? 'unknown' : 'error' });
    } finally {
      activeReads.current -= 1;
    }
  }, [tokenId, workVersion]);
  useEffect(() => { void read(); }, [read]);
  useEffect(() => onClearOutcome((outcome) => { if (outcome.tokenId === tokenId) void read(); }), [read, tokenId]);
  useEffect(() => {
    if (state.kind !== 'ready') return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void read(false); }, 10_000);
    return () => clearInterval(timer);
  }, [read, state.kind]);
  useEffect(() => () => { ++serial.current; }, []);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') void read(); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [read]);

  if (state.kind === 'unknown') return <PetNotFound />;
  const displayState = state.kind === 'ready' && state.version !== workVersion ? { kind: 'loading' as const } : state;
  const record = displayState.kind === 'ready' ? displayState.record : null;
  const asleep = pet.fullness.state === 'asleep';
  const signedOut = !auth.authenticated || auth.sessionEnded;
  const date = record ? countedDate(record.counts.countedSince) : '';
  const heading = <Cluster gap={3} align="center"><PetFigure tokenId={tokenId} name={name} stage={pet.stage} state={pet.fullness.state} outfit={pet.worn ?? undefined} size="sm" decorative still />
    <Heading level={1} id="work-record-title">{name}</Heading></Cluster>;
  const message = displayState.kind === 'loading' ? `Checking ${name}'s work record…` : displayState.kind === 'error' ? "Work record couldn't be checked. Try again." : '';
  const hasCount = record && (record.counts.paidHires > 0 || record.counts.completedErrands > 0);
  const receiptLink = (thoughtId: string, receiptTokenId: string | null) => verifyPath(receiptTokenId ?? tokenId, thoughtId);
  const report = record?.receipts.find((r) => r.thoughtId === record.field?.sourceReportId);
  const header = <Header start={<Button variant="ghost" size="compact" icon="back" href={petPath(tokenId)}>{`Back to ${name}`}</Button>}
    end={signedOut ? <Button variant="secondary" size="compact" onClick={() => signIn.begin('signin')}>Sign in</Button> : <AccountControl tokenId={tokenId} name={name} viewer={pet.viewer} />} />;
  const recordBody = record ? <Stack gap={4}>
        {hasCount ? <Surface><span className="ds-hidden">{`Paid hires: ${record.counts.paidHires} · Completed errands: ${record.counts.completedErrands} · Counted since ${date}`}</span><Facts size="body-strong" items={[{ label: 'Paid hires:', value: record.counts.paidHires },
          { label: 'Completed errands:', value: record.counts.completedErrands }, { label: 'Counted since', value: date }]} /></Surface>
          : <Stack gap={3}><Note tone="plain">No counted work yet. Earlier receipts may still exist.</Note><Text variant="small" tone="secondary">{`Counted since ${date}`}</Text></Stack>}
        {record.field ? <Surface><Stack gap={2}><Text variant="body-strong">{record.field.wording}</Text>
          {report ? <TextLink href={receiptLink(report.thoughtId, report.tokenId)} tone="quiet" iconEnd="chevron">{`Find out · ${new Date(report.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`}</TextLink> : null}
        </Stack></Surface> : null}
        {record.receipts.length ? <Stack as="ol" gap={3}>{record.receipts.map((r) => <Surface as="li" key={r.thoughtId}><Stack gap={2}>
          <Text>{`${r.kind === 'hire_answer' ? 'Paid hire' : 'Find out'} · ${new Date(r.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`}</Text>
          <Cluster justify="flex-end"><TextLink href={receiptLink(r.thoughtId, r.tokenId)} tone="quiet" iconEnd="chevron">Check receipt</TextLink></Cluster>
        </Stack></Surface>)}</Stack> : null}
      </Stack> : null;
  const actionable = Boolean(record && (signedOut || asleep));
  const line = asleep ? `${name} is asleep. Feed ${name} to wake them.` : '';
  const action = asleep ? <Button block haspopup="dialog" onClick={() => openFeed({ tokenId, name, label: name, elsewhere: false })}>{`Feed ${name}`}</Button>
    : <Button block href={petPath(tokenId)}>{`Ask ${name}`}</Button>;
  return <Shell accent={makePet(tokenId).hue} header={header} fill={actionable}>
    <Page width="default" fill={actionable}>{displayState.kind === 'error'
      ? <Centerpiece compact><Stack gap={4} align="center">{heading}<Note tone="error">{message}</Note><Button variant="secondary" onClick={() => void read()}>Try again</Button></Stack></Centerpiece>
      : actionable
        ? <Centerpiece scroll labelledBy="work-record-title" actions={<Stack gap={3}>{line ? <Note tone="plain">{line}</Note> : null}{action}</Stack>} status={line}>
          <Stack gap={5}>{heading}{recordBody}</Stack></Centerpiece>
        : <Stack gap={5}>
          {heading}
          {displayState.kind === 'loading' ? <Stack gap={3}><Note tone="status">{message}</Note><Skeleton shape="name" /><Skeleton shape="line" /><Skeleton shape="short" /></Stack> : null}
          {recordBody}
          <Live>{message}</Live>
        </Stack>}</Page>
    <FeedLayer pageFullness={pet.fullness} />
  </Shell>;
}
