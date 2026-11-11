import { useEffect, useRef, useState } from 'react';
import { Button, ChainAddressRow, CopyField, Note, Sheet, Stack, TextField, TextLink } from '../ds';
import { FullnessHead } from '../feeding/FullnessHead';
import { go } from '../route';
import { workerApi } from '../seams/worker';
import { WorkerError } from '../seams/worker-types';
import { track as trackEvent } from '../track';
import { chainCopy } from './copy';
import type { PayRequest } from './request';
import type { AddressAnswer, TrackedDeposit } from './types';

const addressError = 'Address or rate unavailable. Check again before sending.';
const statusWords = { waiting_for_owner: 'Waiting for owner', converting: 'Converting',
  became_food: 'Became food', refunded: 'Refunded' } as const;

function wait(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export function AddressSheet({ request, onClose, onBack, column }: {
  request: PayRequest; onClose: () => void; onBack: () => void; column?: boolean;
}) {
  const [answer, setAnswer] = useState<AddressAnswer | null>(null);
  const [issue, setIssue] = useState<'error' | 'unknown' | null>(null);
  const [tracking, setTracking] = useState(false);
  const [hash, setHash] = useState('');
  const [tracked, setTracked] = useState<TrackedDeposit | null>(null);
  const [trackingIssue, setTrackingIssue] = useState(false);
  const [pending, setPending] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);

  const refresh = async () => {
    const current = ++generation.current;
    setAnswer(null); setIssue(null); setPending(true);
    try {
      const next = await workerApi.anyChainAddresses(request.tokenId);
      if (!alive.current || current !== generation.current) return;
      if (next.tokenId !== request.tokenId || next.addresses.length !== 2 ||
        next.addresses.some((item) => item.path !== `${item.chain}:${request.tokenId}` || !item.address ||
          !item.asset || !item.contractAddress || !Number.isFinite(item.waitSeconds) || item.waitSeconds < 0 ||
          !/^\d+\.\d{2}$/.test(item.amountUsdc)) ||
        !next.addresses.some((item) => item.chain === 'base') ||
        !next.addresses.some((item) => item.chain === 'solana')) throw new Error('bad_address_answer');
      setAnswer(next);
      return next;
    } catch (error) {
      if (alive.current && current === generation.current) setIssue(error instanceof WorkerError && error.code === 'no_pet' ? 'unknown' : 'error');
      return null;
    } finally { if (alive.current && current === generation.current) setPending(false); }
  };
  useEffect(() => {
    alive.current = true;
    void refresh();
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive.current = false; generation.current++; document.removeEventListener('visibilitychange', visible); };
    // A sheet is keyed by token_id in FeedLayer; a new mount is a new offer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.tokenId]);

  const copy = async (value: string): Promise<boolean> => {
    try { await navigator.clipboard.writeText(value); if (alive.current) setCopyFailed(false); return true; }
    catch { if (alive.current) setCopyFailed(true); }
    return false;
  };
  const copyAddress = async (chain: 'base' | 'solana', shown: string) => {
    const current = await refresh();
    if (current?.addresses.find((item) => item.chain === chain)?.address === shown && await copy(shown))
      trackEvent('pet_address_copied', { chain });
  };
  const track = async () => {
    const value = hash.trim();
    const chain = /^0x[0-9a-fA-F]{64}$/.test(value) ? 'base' : 'solana';
    setTrackingIssue(false); setTracked(null); setPending(true);
    try {
      const result = await workerApi.anyChainTrack({ tokenId: request.tokenId, chain, hash: value });
      if (result.url !== `/pet/${encodeURIComponent(request.tokenId)}/feed/status/${result.id}` ||
        !/^[0-9a-f]{32}$/.test(result.id)) throw new Error('bad_status_link');
      if (alive.current) setTracked(result);
    } catch { if (alive.current) setTrackingIssue(true); }
    finally { if (alive.current) setPending(false); }
  };
  const petPath = `/pet/${encodeURIComponent(request.tokenId)}`;
  const link = tracked ? new URL(tracked.url, window.location.origin).href : '';
  return <Sheet title={tracking ? 'Track this deposit' : `Send USDC to ${request.name}'s address`}
    onClose={onClose} onBack={tracking ? () => { setTracking(false); setTracked(null); setTrackingIssue(false); } : onBack}
    column={column} status={pending ? 'Checking this payment…' : issue === 'error' ? addressError : ''}
    head={request.fullness ? <FullnessHead fullness={request.fullness} elsewhere={Boolean(request.elsewhere)} tokenId={request.tokenId} /> : undefined}
    foot={issue === 'error' ? <Button block onClick={() => void refresh()}>Try again</Button> : undefined}>
    {tracking ? <Stack gap={3}>
      <TextField label={chainCopy.transferId} value={hash} mono onChange={(value) => {
        setHash(value); setTracked(null); setTrackingIssue(false);
      }} />
      <Button block pending={pending} onClick={() => void track()}>Track this deposit</Button>
      {trackingIssue ? <Note tone="error">No payment found here.</Note> : null}
      {tracked ? <>
        <Note tone="status">{statusWords[tracked.status.state]}</Note>
        <CopyField label={chainCopy.statusLink} value={link} onCopy={() => void copy(link)} />
        <Button block variant="secondary" onClick={() => { onClose(); go(tracked.url); }}>View payment status</Button>
      </> : null}
      {copyFailed ? <Note tone="error">Select and copy the details by hand.</Note> : null}
    </Stack> : issue === 'unknown' ? <Note tone="error">Pet not found.</Note>
      : issue === 'error' ? <Note tone="error" silent>{addressError}</Note>
      : answer ? <Stack gap={3}>
        <Note tone="plain">{chainCopy.warning}</Note>
        {answer.addresses.map((item) => <ChainAddressRow key={item.chain}
          network={item.chain === 'base' ? 'Base' : 'Solana'} contractLabel={chainCopy.contract}
          contract={item.contractAddress}
          minimumLabel={chainCopy.minimum} minimum={`${item.amountUsdc} USDC`}
          waitLabel={chainCopy.wait} wait={wait(item.waitSeconds)} address={item.address}
          copyLabel={`Copy ${item.chain === 'base' ? 'Base' : 'Solana'} address`}
          onCopy={() => void copyAddress(item.chain, item.address)} />)}
        <TextLink href={petPath} hit>{new URL(petPath, window.location.origin).href}</TextLink>
        <TextLink href="#track" hit onClick={() => setTracking(true)}>Track this deposit</TextLink>
        {copyFailed ? <Note tone="error">Select and copy the details by hand.</Note> : null}
      </Stack> : null}
  </Sheet>;
}
