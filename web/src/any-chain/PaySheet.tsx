import { useEffect, useRef, useState } from 'react';
import { Button, ChoiceList, CopyField, Facts, Note, Sheet, Stack, Text, TextField } from '../ds';
import { FullnessHead } from '../feeding/FullnessHead';
import { go } from '../route';
import { workerApi } from '../seams/worker';
import type { OriginToken, QuoteAnswer } from './types';
import { payCopy } from './copy';
import { addressExpired, decimalUnits, formatUnits, quoteIssue, supportedToken, type PayIssue, type PayPhase } from './quoteMachine';
import type { PayRequest } from './request';

const issueLine: Record<PayIssue, string> = {
  error: 'No payable quote right now. Choose another amount or asset.',
  unsupported: 'This chain or asset is not available now.',
  below: 'Too little food after fees. Try a larger amount.',
  above: 'This is above the meal limit. Try a smaller amount.',
  changed: 'This quote expired. Get a new quote before sending.',
  paused: 'New cross-chain payments are paused. Deposits already sent can still arrive.',
  capacity: 'Cross-chain payment is busy. Try again later.',
  stake: 'Cross-chain payment is unavailable while NEAR delivery is set up.',
  receiver: 'Cross-chain payment is unavailable while NEAR delivery is set up.',
};

const when = (value: string | undefined): string => value ? new Date(value).toLocaleString('en-GB', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
}) : '—';

function QuoteFacts({ answer, refundTo, name, selected }: { answer: QuoteAnswer; refundTo: string; name: string; selected: OriginToken | null }) {
  const quote = answer.quote;
  const seconds = Math.max(0, Math.round(quote.timeEstimate));
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const usd = Number(quote.amountOutUsd);
  const feesUsd = Number(quote.amountInUsd) - usd;
  return <Stack gap={2}>
    <Text variant="small" tone="secondary">{payCopy.expectedFood(name)}</Text>
    <Text variant="title-1" tabular>{formatUnits(quote.amountOut, 24)} NEAR</Text>
    <Facts size="small" items={[
      { label: payCopy.minimumFood, value: `${formatUnits(quote.minAmountOut, 24)} NEAR` },
      { label: payCopy.usdEstimate, value: Number.isFinite(usd) ? `$${usd.toFixed(2)}` : '—' },
      { label: payCopy.swapFees, value: Number.isFinite(feesUsd) && feesUsd >= 0 ? `$${feesUsd.toFixed(2)}` : '—' },
      { label: payCopy.refundFee, value: `${formatUnits(quote.refundFee, selected?.decimals ?? 6)} ${selected?.symbol ?? 'USDC'}` },
      { label: payCopy.networkFee, value: payCopy.sourceGas },
      { label: payCopy.refundAddress, value: refundTo },
      { label: payCopy.arrival, value: `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` },
    ]} />
  </Stack>;
}

export function PaySheet({ request, onClose, onBack, column }: { request: PayRequest; onClose: () => void; onBack: () => void; column?: boolean }) {
  const [tokens, setTokens] = useState<OriginToken[]>([]);
  const [chain, setChain] = useState('base');
  const [assetId, setAssetId] = useState('');
  const [amount, setAmount] = useState('0.25');
  const [refundTo, setRefundTo] = useState('');
  const [phase, setPhase] = useState<PayPhase>({ kind: 'draft' });
  const [copyFailed, setCopyFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const acceptedAt = useRef(0);
  const generation = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void workerApi.anyChainTokens().then((reply) => { if (alive.current) {
      setTokens(reply.tokens);
      if (!reply.tokens.some((token) => token.blockchain === chain)) setChain(reply.tokens[0]?.blockchain ?? 'base');
    } })
      .catch(() => { if (alive.current) setPhase({ kind: 'issue', issue: 'error' }); });
    return () => { alive.current = false; generation.current++; };
  }, []);
  useEffect(() => {
    const refresh = () => setTick((value) => value + 1);
    const timer = window.setInterval(refresh, 1000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  useEffect(() => {
    if (phase.kind !== 'accepted') return;
    const inactive = Date.parse(phase.answer.quote.timeWhenInactive ?? '');
    const deadline = Date.parse(phase.answer.quote.deadline ?? '');
    const server = Date.parse(phase.answer.serverTime ?? '');
    if (![inactive, deadline, server].every(Number.isFinite)) return;
    const remaining = Math.min(inactive, deadline) - server - 1000 - (performance.now() - acceptedAt.current);
    const timer = window.setTimeout(() => setTick((value) => value + 1), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [phase]);

  const change = () => { generation.current++; setCopyFailed(false); setPhase({ kind: 'draft' }); };
  const quote = async () => {
    const current = ++generation.current;
    setPhase({ kind: 'quoting' });
    try {
      const currentTokens = tokens.length ? tokens : (await workerApi.anyChainTokens()).tokens;
      if (alive.current && current === generation.current) setTokens(currentTokens);
      const selected = supportedToken(currentTokens, chain, assetId || undefined);
      if (!selected) { if (alive.current && current === generation.current) setPhase({ kind: 'issue', issue: 'unsupported' }); return; }
      if (decimalUnits(amount, selected.decimals) === null || refundTo.trim() === '') {
        if (alive.current && current === generation.current) setPhase({ kind: 'issue', issue: 'error' });
        return;
      }
      const answer = await workerApi.anyChainQuote({ tokenId: request.tokenId, originAsset: selected.assetId, amount, refundTo: refundTo.trim() });
      if (alive.current && current === generation.current) setPhase({ kind: 'quoted', answer, origin: { ...selected } });
    } catch (error) {
      if (alive.current && current === generation.current) setPhase({ kind: 'issue', issue: quoteIssue(error) });
    }
  };
  const accept = async (answer: QuoteAnswer, origin: OriginToken) => {
    const current = ++generation.current;
    acceptedAt.current = performance.now();
    setPhase({ kind: 'accepting', answer, origin });
    try {
      const accepted = await workerApi.anyChainAccept(answer.id);
      if (alive.current && current === generation.current) {
        if (!accepted.quote.depositAddress || !accepted.quote.deadline || !accepted.quote.timeWhenInactive) {
          setPhase({ kind: 'issue', issue: 'error' });
        } else { setPhase({ kind: 'accepted', answer: accepted, origin }); }
      }
    } catch (error) {
      if (alive.current && current === generation.current) setPhase({ kind: 'issue', issue: quoteIssue(error) });
    }
  };
  const accepted = phase.kind === 'accepted' ? phase.answer : null;
  void tick;
  const serverTime = Date.parse(accepted?.serverTime ?? '');
  const destinationExpired = accepted ? !Number.isFinite(serverTime) ||
    addressExpired(accepted, serverTime + 1000 + performance.now() - acceptedAt.current) : false;
  const shown = phase.kind === 'quoted' || phase.kind === 'accepting' ? phase.answer : null;
  const issue = phase.kind === 'issue' ? phase.issue : null;
  const selected = supportedToken(tokens, chain, assetId || undefined);
  const quotedOrigin = phase.kind === 'quoted' || phase.kind === 'accepting' ? phase.origin : null;
  const acceptedOrigin = phase.kind === 'accepted' ? phase.origin : null;
  const chainLabel = (value: string) => value === 'sol' || value === 'solana' ? 'Solana'
    : value === 'base' ? 'Base' : value;
  const chains = [...new Set(tokens.map((token) => token.blockchain))];
  const assets = tokens.filter((token) => token.blockchain === chain && supportedToken(tokens, chain, token.assetId));
  const amountToSend = accepted && acceptedOrigin ? `${formatUnits(accepted.quote.amountIn, acceptedOrigin.decimals, acceptedOrigin.decimals)} ${acceptedOrigin.symbol}` : '';
  const details = accepted ? [`${payCopy.sourceChain}: ${chainLabel(acceptedOrigin?.blockchain ?? '')}`, `${payCopy.sourceAsset}: ${acceptedOrigin?.symbol ?? ''}`,
    `${payCopy.sourceAmount}: ${amountToSend}`, `${payCopy.depositAddress}: ${accepted.quote.depositAddress}`,
    accepted.quote.depositMemo ? `${payCopy.memo}: ${accepted.quote.depositMemo}` : '',
    `${payCopy.inactiveTime}: ${when(accepted.quote.timeWhenInactive)}`, `${payCopy.deadline}: ${when(accepted.quote.deadline)}`,
    `${payCopy.refundAddress}: ${accepted.refundTo ?? refundTo}`].filter(Boolean).join('\n') : '';
  const copy = async (value: string) => {
    if (accepted && (!Number.isFinite(serverTime) || addressExpired(accepted,
      serverTime + 1000 + performance.now() - acceptedAt.current))) { setTick((item) => item + 1); return; }
    try { await navigator.clipboard.writeText(value); if (alive.current) setCopyFailed(false); }
    catch { if (alive.current) setCopyFailed(true); }
  };
  const statusPath = accepted ? `/pet/${encodeURIComponent(request.tokenId)}/feed/status/${encodeURIComponent(accepted.id)}` : '';
  return <Sheet title="Pay from another chain" onClose={onClose} onBack={onBack} column={column}
    status={issue ? issueLine[issue] : phase.kind === 'quoting' || phase.kind === 'accepting' ? 'Checking this payment…' : ''}
    head={request.fullness ? <FullnessHead fullness={request.fullness} elsewhere={Boolean(request.elsewhere)} tokenId={request.tokenId} /> : undefined}
    foot={accepted ? <Stack gap={2}>{destinationExpired ? <Button block onClick={() => change()}>Get a new quote</Button> : null}
      <Button block onClick={() => { onClose(); go(statusPath); }}>View payment status</Button></Stack>
      : issue && (issue === 'capacity' || issue === 'stake' || issue === 'receiver' || issue === 'paused' || issue === 'below' || issue === 'above') ? undefined
      : <Stack gap={2}>
        {/* the notice stands above the action it belongs to, pinned with it, so a phone never scrolls it out of sight */}
        {shown ? <Note tone="plain">{payCopy.publicNotice}</Note> : null}
        <Button block pending={phase.kind === 'quoting' || phase.kind === 'accepting'}
          onClick={() => { if (shown && quotedOrigin) void accept(shown, quotedOrigin); else if (issue === 'unsupported') setPhase({ kind: 'draft' }); else void quote(); }}>
          {shown ? 'Get payment address' : issue === 'changed' ? 'Get a new quote' : issue === 'unsupported' ? 'Choose another'
            : issue === 'error' ? 'Try another quote' : payCopy.quoteAction}
        </Button>
      </Stack>}>
    <Stack gap={3}>
      {accepted ? <>
        <Facts items={[{ label: payCopy.sourceChain, value: chainLabel(acceptedOrigin?.blockchain ?? '') },
          { label: payCopy.sourceAsset, value: acceptedOrigin?.symbol ?? '—' },
          { label: payCopy.sourceAmount, value: amountToSend }]} />
        {destinationExpired ? <Note tone="error" silent>{issueLine.changed}</Note> : <>
          <CopyField mono label={payCopy.depositAddress} copyLabel={payCopy.copyDepositAddress} value={accepted.quote.depositAddress!} onCopy={() => void copy(accepted.quote.depositAddress!)} />
          {accepted.quote.depositMemo ? <CopyField label={payCopy.memo} copyLabel={payCopy.copyMemo} value={accepted.quote.depositMemo} onCopy={() => void copy(accepted.quote.depositMemo!)} /> : null}
        </>}
        <Facts items={[{ label: payCopy.inactiveTime, value: when(accepted.quote.timeWhenInactive) },
          { label: payCopy.deadline, value: when(accepted.quote.deadline) }, { label: payCopy.refundAddress, value: accepted.refundTo ?? refundTo }]} />
        <Note tone="plain">{payCopy.publicNotice}</Note>
        <Note tone="plain">{payCopy.walletNotice}</Note>
        {!destinationExpired ? <Button variant="secondary" block icon="copy" onClick={() => void copy(details)}>Copy payment details</Button> : null}
        {copyFailed ? <Note tone="error">{payCopy.copyFailed}</Note> : null}
      </> : <>
        <ChoiceList label={payCopy.sourceChain} quote={false} options={chains.map((value) => ({ value, text: chainLabel(value) }))}
          value={chain} onChange={(value) => { setChain(value); setAssetId(''); change(); }} />
        <ChoiceList label={payCopy.sourceAsset} quote={false} options={assets.map((token) => ({ value: token.assetId, text: token.symbol,
          meta: `$${Number(token.price).toLocaleString('en-US', { maximumSignificantDigits: 6 })}` }))}
          value={selected?.assetId ?? ''} onChange={(value) => { setAssetId(value); change(); }} />
        <TextField label={payCopy.sourceAmount} value={amount} onChange={(value) => { setAmount(value); change(); }}
          error={issue === 'below' || issue === 'above' ? issueLine[issue] : undefined} />
        <TextField label={payCopy.refundInput} value={refundTo}
          onChange={(value) => { setRefundTo(value); change(); }} mono />
        {issue && issue !== 'below' && issue !== 'above' ? <Note tone="error" silent>{issueLine[issue]}</Note> : null}
        {shown ? <QuoteFacts answer={shown} refundTo={refundTo} name={request.name} selected={quotedOrigin} /> : null}
      </>}
    </Stack>
  </Sheet>;
}
