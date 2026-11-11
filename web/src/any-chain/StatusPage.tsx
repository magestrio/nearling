import { useCallback, useEffect, useState } from 'react';
import { Button, Facts, Header, Heading, Live, Note, Page, Shell, Stack, Text, TextLink } from '../ds';
import { config } from '../config';
import { go, petPath } from '../route';
import { useAuth } from '../seams/auth';
import { workerApi, WorkerError, type PetView } from '../seams/worker';
import { useSignIn } from '../signin/signIn';
import { openFeed } from '../feeding/feedRequest';
import { statusCopy } from './copy';
import { PetFigure } from '../pet/PetFigure';
import { formatUnits } from './quoteMachine';
import { heldReturn, nearProof, paymentLine, type PaymentRead } from './statusModel';
import type { HeldStatus, QuoteStatus } from './types';
import { DepositOwner } from './DepositOwner';

type Screen = { kind: 'loading' | 'empty' | 'error' } | { kind: 'ready'; read: PaymentRead };
const nearHref = (hash: string) => `https://${config.nearNetwork === 'testnet' ? 'testnet.' : ''}nearblocks.io/txns/${encodeURIComponent(hash)}`;
const evmExplorers: Record<string, string> = {
  base: 'basescan.org', eth: 'etherscan.io', ethereum: 'etherscan.io',
  arb: 'arbiscan.io', arbitrum: 'arbiscan.io', polygon: 'polygonscan.com',
  optimism: 'optimistic.etherscan.io', op: 'optimistic.etherscan.io',
  bsc: 'bscscan.com', avalanche: 'snowtrace.io',
};
const sourceHref = (hash: string, chain: string | null | undefined) => {
  const explorer = chain ? evmExplorers[chain] : undefined;
  if (explorer && /^0x[0-9a-fA-F]{64}$/.test(hash)) return `https://${explorer}/tx/${encodeURIComponent(hash)}`;
  if (chain === 'aptos' && /^0x[0-9a-fA-F]{64}$/.test(hash))
    return `https://explorer.aptoslabs.com/txn/${encodeURIComponent(hash)}?network=mainnet`;
  return (chain === 'solana' || chain === 'sol') && /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(hash)
    ? `https://solscan.io/tx/${encodeURIComponent(hash)}` : null;
};
const chainLabel = (chain: string) => chain === 'base' ? 'Base' : chain === 'solana' || chain === 'sol' ? 'Solana'
  : chain === 'eth' || chain === 'ethereum' ? 'Ethereum' : chain === 'arb' || chain === 'arbitrum' ? 'Arbitrum'
    : chain === 'aptos' ? 'Aptos' : chain;

// spec: add-any-chain-feed › Cross-chain payment status screen › loading
export function StatusPage({ tokenId, paymentId }: { tokenId: string; paymentId: string }) {
  const auth = useAuth();
  const signIn = useSignIn();
  const [pet, setPet] = useState<PetView | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [ownerShown, setOwnerShown] = useState(false);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let alive = true;
    void workerApi.pet(null, tokenId).then((value) => { if (alive) setPet(value); }).catch(() => undefined);
    return () => { alive = false; };
  }, [tokenId, revision]);
  useEffect(() => {
    let alive = true;
    setChecking(true);
    setCheckError(false);
    void (async () => {
      try {
        let read: PaymentRead | null = null;
        let quote: QuoteStatus | null = null;
        try {
          quote = await workerApi.anyChainStatus(paymentId);
        } catch (error) {
          if (!(error instanceof WorkerError) || error.status !== 404) throw error;
        }
        if (quote) {
          if (quote.tokenId !== tokenId) { if (alive) setScreen({ kind: 'empty' }); return; }
          let held: HeldStatus | null = null;
          const heldDelivery = quote.deliveries.find((item) => item.kind === 'held' && item.heldId !== null);
          if (heldDelivery?.heldId !== null && heldDelivery?.heldId !== undefined) {
            try {
              const token = auth.authenticated && !auth.sessionEnded ? await auth.getIdentityToken() : null;
              held = await workerApi.anyChainHeldStatus(heldDelivery.heldId, paymentId, token);
            } catch { if (alive) setCheckError(true); }
          }
          read = { kind: 'quote', value: quote, held };
        } else {
          const deposit = await workerApi.anyChainDepositStatus(paymentId);
          if (deposit.tokenId !== tokenId) { if (alive) setScreen({ kind: 'empty' }); return; }
          read = { kind: 'deposit', value: deposit };
        }
        if (alive && read) setScreen({ kind: 'ready', read });
      } catch (error) {
        if (alive) {
          setCheckError(true);
          setScreen((previous) => error instanceof WorkerError && error.status === 404
            ? { kind: 'empty' } : previous.kind === 'ready' ? previous : { kind: 'error' });
        }
      } finally { if (alive) setChecking(false); }
    })();
    return () => { alive = false; };
  }, [tokenId, paymentId, revision, auth.authenticated, auth.sessionEnded]);
  useEffect(() => {
    const visible = () => { if (!document.hidden) refresh(); };
    const timer = window.setInterval(() => { if (!document.hidden) refresh(); }, 10_000);
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);

  const name = pet?.name ?? '';
  const read = screen.kind === 'ready' ? screen.read : null;
  const quote = read?.kind === 'quote' ? read.value : null;
  const held = read?.kind === 'quote' ? read.held : null;
  const proof = quote ? nearProof(quote) : null;
  // The frames mark these outcomes as failures (an error mark and an assertive announcement); the others stay plain.
  const failed = Boolean(quote && (quote.reason ? !['retry_failed_route', 'wrong_caller', 'expired_approval', 'missing_quote_destination'].includes(quote.reason)
    : ['provider_failed', 'wrong_asset', 'unwrap_failed', 'transfer_late'].includes(quote.state))) ||
    Boolean(held && ['below_return_minimum', 'reverse_exchange_failed', 'settlement_transfer_failed'].includes(held.state));
  const line = read ? paymentLine(read, name) : screen.kind === 'empty' ? 'No payment found here.'
    : screen.kind === 'error' ? 'Payment status is unavailable. Your transfer may still be on its way.' : 'Checking this payment…';
  const source = quote?.sourceTxHash ?? held?.sourceTxHash ?? (read?.kind === 'deposit' ? read.value.source : null);
  const sourceLink = source ? (source.startsWith('https://') ? source : sourceHref(source,
    quote?.sourceChain ?? (read?.kind === 'deposit' ? source.includes('basescan.org') ? 'base' : 'solana' : null))) : null;
  const sourceChain = source ? source.includes('basescan.org') ? 'Base' : source.includes('solscan.io') ? 'Solana'
    : chainLabel(quote?.sourceChain ?? '') : '';
  const feed = () => { if (pet) { openFeed({ tokenId, name: pet.name, label: pet.name, elsewhere: false }); go(petPath(tokenId)); } };
  return <Shell header={<Header start={<Button variant="ghost" size="compact" icon="back" href={petPath(tokenId)}>
    {name ? statusCopy.back(name) : statusCopy.title}</Button>} />}>
    <Page width="narrow"><Stack gap={4}>
      <Heading level={1}>{name || statusCopy.title}</Heading>
      {pet ? <PetFigure tokenId={tokenId} name={pet.name} stage={pet.stage}
        state={pet.fullness.state} size="sm" decorative /> : null}
      <Live alert={screen.kind === 'error' || checkError || failed}>{checking ? 'Checking this payment…' : checkError && read
        ? 'Payment status is unavailable. Your transfer may still be on its way.' : line}</Live>
      {checking && read ? <Note tone="status">Checking this payment…</Note> : null}
      {checkError && read ? <Note tone="error">Payment status is unavailable. Your transfer may still be on its way.</Note> : null}
      {ownerShown && read?.kind === 'deposit' ? null
        : <Note tone={screen.kind === 'error' || failed ? 'error' : checking || quote?.state === 'source_transfer_pending' ? 'status' : 'plain'} silent>{line}</Note>}
      {quote && !proof && quote.state === 'source_transfer_pending' ?
        <Note tone="plain">{statusCopy.sourceStage}</Note> : null}
      {quote && !proof && quote.state === 'delivery_unverified' ?
        <Note tone="plain">{statusCopy.swapStage}</Note> : null}
      {pet?.fullness.state === 'asleep' && !proof && read &&
        (read.kind === 'quote' || read.value.state !== 'became_food') ?
        <Note tone="plain">{`${name} is asleep. Food will wake them after the NEAR credit confirms.`}</Note> : null}
      {held ? <HeldDetails status={held} payer={Boolean(held.recipient)} originChain={quote?.sourceChain} /> :
        quote?.state === 'held' ? <HeldEvidence status={quote} /> : null}
      {quote?.state === 'food_excess_refunded' && quote.providerRefundTxHash ?
        <Note tone="plain">{`Extra input was refunded to ${quote.refundTo}. Check your wallet.`}</Note> : null}
      {proof ? <Stack gap={2}><Text variant="lead" tabular>{proof.amount}</Text>
        <TextLink href={nearHref(proof.hash)} external>View NEAR credit</TextLink></Stack> : null}
      {quote?.sourceAmount && quote.sourceChain ? <Facts items={[
        ...(quote.sourceDecimals !== undefined || quote.sourceAsset === 'USDC' ? [{ label: statusCopy.amount,
          value: `${formatUnits(quote.sourceAmount, quote.sourceDecimals ?? 6, 6)} ${quote.sourceAsset ?? 'USDC'}` }] : []),
        { label: statusCopy.route, value: `${chainLabel(quote.sourceChain)} → NEAR` },
      ]} /> : null}
      {read?.kind === 'deposit' && read.value.nearCredit ? <TextLink href={read.value.nearCredit} external>View NEAR credit</TextLink> : null}
      {read?.kind === 'deposit' && !ownerShown && read.value.remainingUnits ? <><Note tone="plain">Waiting for owner</Note>
        <Facts items={[{ label: 'Became food', value: `${formatUnits(read.value.settledUnits ?? '0', 6, 6)} USDC` },
          { label: 'Waiting for owner', value: `${formatUnits(read.value.remainingUnits, 6, 6)} USDC` }]} /></> : null}
      {read?.kind === 'deposit' && read.value.refund ? <TextLink href={read.value.refund} external>{statusCopy.refundProof}</TextLink> : null}
      {sourceLink ? <TextLink href={sourceLink} external>{statusCopy.source(sourceChain)}</TextLink> : null}
      {source && !sourceLink ? <Text variant="small">{`${statusCopy.original}: ${source}`}</Text> : null}
      {quote?.providerStatusUrl ? <TextLink href={quote.providerStatusUrl} external>{statusCopy.provider}</TextLink>
        : quote?.providerReference ? <Text variant="small">{`${statusCopy.provider}: ${quote.providerReference}`}</Text> : null}
      {read?.kind === 'deposit' && auth.authenticated && !auth.sessionEnded ?
        <DepositOwner depositId={paymentId} tokenId={tokenId} name={name} onShown={setOwnerShown} /> : null}
      {screen.kind === 'error' || checkError ? <Button onClick={refresh}>Try again</Button> : null}
      {read?.kind === 'deposit' && (!auth.authenticated || auth.sessionEnded) ? <Button variant="secondary" onClick={() => signIn.begin('signin')}>
        Sign in to see this deposit</Button> : null}
      {pet && (screen.kind === 'empty' || (!auth.authenticated || auth.sessionEnded) && read ||
        pet.fullness.state === 'asleep' && read && !proof &&
        (read.kind === 'quote' || read.value.state !== 'became_food')) ? <Button onClick={feed}>{`Feed ${name}`}</Button> : null}
    </Stack></Page>
  </Shell>;
}

function HeldEvidence({ status }: { status: QuoteStatus }) {
  const item = status.deliveries.find((delivery) => delivery.kind === 'held');
  return item ? <Stack gap={2}><Text variant="title-1" tabular>{`${formatUnits(item.amount, 24)} wNEAR`}</Text>
    {item.reason && item.reason in statusCopy.heldReasons ?
      <Text>{statusCopy.heldReasons[item.reason as keyof typeof statusCopy.heldReasons]}</Text> : null}
    <TextLink href={nearHref(item.nearTxHash)} external>{statusCopy.nearEvidence}</TextLink></Stack> : null;
}

function HeldDetails({ status, payer, originChain }: { status: HeldStatus; payer: boolean; originChain?: string | null }) {
  const quote = status.quote;
  const back = heldReturn(status);
  return <Stack gap={2}>
    {status.state === 'refund_confirmed' && back.amount
      ? <Text variant="lead" tabular>{`${formatUnits(back.amount, back.decimals, back.decimals)} ${back.symbol}`}</Text>
      : <Text variant="title-1" tabular>{`${formatUnits(status.amount, 24)} wNEAR`}</Text>}
    {status.reason in statusCopy.heldReasons ?
      <Text>{statusCopy.heldReasons[status.reason as keyof typeof statusCopy.heldReasons]}</Text> : null}
    <TextLink href={nearHref(status.nearTxHash)} external>{statusCopy.nearEvidence}</TextLink>
    <Text>{status.sourceVerified ? statusCopy.sourceVerified : statusCopy.sourceUnverified}</Text>
    {payer && status.recipient ? <Facts items={[{ label: statusCopy.returnAddress.replace('USDC', back.symbol), value: status.recipient }]} /> : null}
    {payer && quote ? <Facts items={[
      { label: statusCopy.returnFee, value: `${formatUnits(quote.refundFee, back.decimals, back.decimals)} ${back.symbol}` },
      { label: statusCopy.transferFee, value: `${formatUnits(quote.withdrawFee, back.decimals, back.decimals)} ${back.symbol}` },
    ]} /> : null}
    {status.releaseTxHash ? <TextLink href={nearHref(status.releaseTxHash)} external>{statusCopy.nearRelease}</TextLink> : null}
    {status.refundTxHash && sourceHref(status.refundTxHash, originChain)
      ? <TextLink href={sourceHref(status.refundTxHash, originChain)!} external>{statusCopy.refundProof}</TextLink> : null}
    {status.state !== 'refund_confirmed' ? <Note tone="plain">{statusCopy.returnWait}</Note> : null}
  </Stack>;
}
