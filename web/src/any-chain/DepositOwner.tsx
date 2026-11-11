import { useCallback, useEffect, useState } from 'react';
import { Button, Facts, Live, Note, Stack, Text, TextLink } from '../ds';
import { useAuth } from '../seams/auth';
import { workerApi, WorkerError } from '../seams/worker';
import { config } from '../config';
import { formatUnits } from './quoteMachine';
import { depositView, ownerDepositLine, sweepPortion, sweepRemaining, type DepositView } from './depositModel';
import { depositCopy } from './copy';
import type { OwnerDepositRead, SweepQuote, SweepRead } from './types';

/** A hash or reference as the frames abbreviate it: «0xa84…e4d7». */
const shortRef = (value: string) => value.length > 12 ? `${value.slice(0, 5)}…${value.slice(-4)}` : value;
function hex(bytes: Uint8Array): string { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''); }
function usdFee(quote: SweepRead['quote']['quote']): string {
  const input = Number(quote.amountInUsd);
  const output = Number(quote.amountOutUsd);
  return Number.isFinite(input - output) ? `$${Math.max(0, input - output).toFixed(2)}` : '';
}
function localSweep(quote: SweepQuote): SweepRead {
  return { routeId: quote.routeId, amountUnits: quote.amountUnits, destination: quote.destination,
    refundTo: quote.refundTo, quote: { quote: quote.quote }, approvalHash: quote.approvalHash,
    expiryMs: quote.expiryMs, state: 'quoted', nearTxHash: null, sourceTxHash: null,
    windowEndsAt: Date.now() + 3_600_000 };
}

// spec: add-any-chain-feed › Pet address deposit flow › owner authorization pending
// spec: add-any-chain-feed › Pet address data › owner approval leaves browser
export function DepositOwner({ depositId, tokenId, name, onShown }: {
  depositId: string; tokenId: string; name: string;
  /** Whether the owner's own detail is drawn, so the page can leave out the public lines it repeats. */
  onShown?: (shown: boolean) => void;
}) {
  const auth = useAuth();
  const [read, setRead] = useState<OwnerDepositRead | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [localState, setLocalState] = useState<DepositView | null>(null);
  const [busy, setBusy] = useState(false);
  const [lost, setLost] = useState(false);
  const [retryQuote, setRetryQuote] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const shown = read !== null && !lost;
  useEffect(() => { onShown?.(shown); return () => onShown?.(false); }, [shown, onShown]);

  useEffect(() => {
    if (!auth.authenticated || auth.sessionEnded) { setRead(null); return; }
    let active = true;
    void (async () => {
      try {
        const token = await auth.getIdentityToken();
        if (!token || !active) return;
        const result = await workerApi.anyChainOwnerDeposit(token, depositId);
        if (!active) return;
        if (result.deposit.token_id !== tokenId) throw new Error('route mismatch');
        setLost(false);
        setRead(result);
        setLocalState(null);
        setIssue(null);
        const sweep = result.sweep;
        const needsQuote = !sweep || sweep.state === 'quoted' && sweep.expiryMs <= Date.now() ||
          sweep.state === 'food' && sweep.windowEndsAt <= Date.now() ||
          retryQuote && (sweep.state === 'sign_failed' || sweep.state === 'quoted');
        if (result.deposit.asset !== 'usdc' || result.deposit.state === 'unsupported' ||
          result.deposit.state === 'refunded' || !needsQuote ||
          result.deposit.state === 'food' && BigInt(result.convertedUnits) >= BigInt(result.deposit.amount_units)) return;
        try {
          const quote = await workerApi.anyChainSweepQuote(token, depositId);
          if (!active) return;
          if (quote.chain !== result.deposit.chain || quote.refundTo !== result.deposit.address ||
            !/^[0-9a-f]{64}$/.test(quote.approvalHash) || quote.expiryMs <= Date.now()) throw new Error('quote mismatch');
          setRead({ ...result, sweep: localSweep(quote) });
          setRetryQuote(false);
        } catch (error) {
          if (!active) return;
          if (error instanceof WorkerError && error.status === 401) { setRead(null); auth.endSession(true, true); }
          else if (error instanceof WorkerError && error.status === 403) setLost(true);
          else if (error instanceof WorkerError) setIssue(error.code);
          else setIssue('quote_unavailable');
        }
      } catch (error) {
        if (!active) return;
        if (error instanceof WorkerError && error.status === 403) setLost(true);
        else if (error instanceof WorkerError && error.status === 401) { setRead(null); auth.endSession(true, true); }
        else setIssue('status_unavailable');
      }
    })();
    return () => { active = false; };
  }, [auth.authenticated, auth.sessionEnded, depositId, tokenId, revision, auth.getIdentityToken, auth.endSession, retryQuote]);

  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) refresh(); }, 10_000);
    const visible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);

  const approve = async () => {
    const sweep = read?.sweep;
    const deposit = read?.deposit;
    if (!sweep || !deposit || sweep.state !== 'quoted' || sweep.expiryMs <= Date.now() ||
      sweep.refundTo !== deposit.address || !auth.needSession()) return;
    setBusy(true); setIssue(null);
    try {
      const signature = await auth.signNearHash(sweep.approvalHash);
      if (signature.length !== 64) throw new Error('signature length');
      const token = await auth.getIdentityToken();
      if (!token) { auth.endSession(true, true); return; }
      const outcome = await workerApi.anyChainSweepApprove(token, sweep.routeId, hex(signature));
      setLocalState(outcome.state === 'sign_unknown' ? 'sign_unknown' : outcome.state === 'sign_failed' ? 'sign_failed' :
        outcome.state === 'awaiting_gas' ? 'awaiting_gas' : outcome.state === 'sent' ? 'sent' : 'submitted');
      refresh();
    } catch (error) {
      if (error instanceof WorkerError && error.status === 403) setLost(true);
      else if (error instanceof WorkerError && error.status === 401) auth.endSession(true, true);
      else if (error instanceof WorkerError) setIssue(error.code);
      else if (error instanceof Error && /(?:user|wallet).*(?:reject|declin|cancel)|(?:reject|declin|cancel).*(?:user|wallet)/i.test(error.message))
        setLocalState('rejected');
      else setLocalState('sign_failed');
    } finally { setBusy(false); }
  };

  if (lost) return <Note tone="plain">{`This deposit belongs to ${name}'s current owner.`}</Note>;
  if (!read) return issue ? <Note tone="error">Payment status is unavailable. Your transfer may still be on its way.</Note> : null;
  const { deposit, sweep } = read;
  const view = localState ?? (issue === 'sweep_gas_cap' ? 'awaiting_gas' : issue === 'below_minimum' ? 'below_minimum' :
    issue === 'signer_unavailable' ? 'unsupported' : depositView(read));
  const line = issue === 'sweep_gas_cap' ? `Conversion is waiting for cheaper network gas. USDC stays at ${name}'s address.` :
    issue === 'signer_unavailable' ? 'Conversion is unavailable for this address. Keep the deposit link for recovery.' :
      ownerDepositLine(view, name, deposit.chain);
  const remaining = sweepRemaining(read);
  const pendingApproval = (view === 'quoted' || view === 'oversized') && sweep?.state === 'quoted' && sweep.expiryMs > Date.now();
  const quote = sweep?.quote.quote;
  // once the conversion has left the approval step, the page names 1-Click's reference for it (the frames' «1-Click · 4Vx…b8E»)
  const reference = sweep && sweep.state !== 'quoted' ? sweep.quote.correlationId : undefined;
  const depositAddress = quote?.depositAddress;
  return <Stack gap={3}>
    <Live alert={['unsupported', 'sign_failed', 'failed'].includes(view)}>{line}</Live>
    <Note tone={['unsupported', 'sign_failed', 'failed'].includes(view) ? 'error' : 'plain'} silent>{line}</Note>
    <Text tabular>{`${formatUnits(deposit.amount_units, 6, 6)} USDC`}</Text>
    {view === 'remainder' ? <Text>{'Waiting for owner'}</Text> : null}
    {sweep && ['oversized', 'remainder'].includes(view) ? <Facts items={[
      { label: view === 'remainder' ? 'Became food' : depositCopy.eligibleAmount, value: `${sweepPortion(sweep)} USDC` },
      { label: view === 'remainder' ? 'Waiting for owner' : depositCopy.balanceRemaining, value: `${remaining} USDC` },
      { label: depositCopy.window, value: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC', timeZoneName: 'short' }).format(sweep.windowEndsAt) },
    ]} /> : null}
    {pendingApproval && quote ? <Facts items={[
      { label: depositCopy.destination, value: sweep.destination },
      { label: depositCopy.refundRecipient, value: sweep.refundTo },
      { label: depositCopy.fees, value: usdFee(quote) },
      { label: depositCopy.minimumFood, value: `${formatUnits(quote.minAmountOut, 24, 6)} NEAR` },
    ]} /> : null}
    {sweep?.nearTxHash ? <TextLink href={`https://${config.nearNetwork === 'testnet' ? 'testnet.' : ''}nearblocks.io/txns/${encodeURIComponent(sweep.nearTxHash)}`} external>{`${sweep.nearTxHash.slice(0, 8)}…${sweep.nearTxHash.slice(-6)}`}</TextLink> : null}
    {sweep?.sourceTxHash ? <TextLink href={deposit.chain === 'base'
      ? `https://basescan.org/tx/${encodeURIComponent(sweep.sourceTxHash)}`
      : `https://solscan.io/tx/${encodeURIComponent(sweep.sourceTxHash)}`} external>{`${deposit.chain === 'base' ? 'Base' : 'Solana'} · ${shortRef(sweep.sourceTxHash)}`}</TextLink> : null}
    {reference ? depositAddress ? <TextLink href={`https://1click.chaindefuser.com/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`} external>{`1-Click · ${shortRef(reference)}`}</TextLink>
      : <Text variant="small">{`1-Click · ${shortRef(reference)}`}</Text> : null}
    {pendingApproval ? <Button block pending={busy} onClick={() => void approve()}>Approve conversion</Button> : null}
    {view === 'sign_failed' ? <Button block onClick={() => { setRetryQuote(true); refresh(); }}>Try again</Button> : null}
  </Stack>;
}
