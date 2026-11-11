import { useEffect, useState } from 'react';
import { Message, TextLink } from '../ds';
import { workerApi } from '../seams/worker';
import { WorkerError } from '../seams/worker-types';
import { useAuth } from '../seams/auth';
import type { OwnerDeposit, OwnerQuoteCredit } from './types';
import { depositCopy } from './copy';

// spec: add-any-chain-feed › Pet address deposit flow › supported deposit seen
// spec: add-any-chain-feed › Pet address deposit flow › gift before settlement
export function DepositEntries({ tokenId, name, tokenOf }: {
  tokenId: string; name: string; tokenOf: () => Promise<string | null>;
}) {
  const auth = useAuth();
  const [deposits, setDeposits] = useState<OwnerDeposit[]>([]);
  const [credits, setCredits] = useState<OwnerQuoteCredit[]>([]);
  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const token = await tokenOf();
        if (!token) return;
        const response = await workerApi.anyChainOwnerDeposits(token, tokenId);
        if (active) { setDeposits(response.deposits); setCredits(response.credits ?? []); }
      } catch (error) {
        if (active) { setDeposits([]); setCredits([]); }
        if (active && error instanceof WorkerError && error.status === 401) auth.endSession(true);
      }
    };
    void read();
    const timer = window.setInterval(() => { if (!document.hidden) void read(); }, 5000);
    const visible = () => { if (!document.hidden) void read(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [tokenId, tokenOf, auth.endSession]);
  return <>{credits.filter((credit) => !credit.wasAsleep && credit.route === 'quote').map((credit) =>
    <Message key={`credit-${credit.creditId}`} from="event">From another chain</Message>)}
    {deposits.map((deposit) => <Message key={deposit.id} from="event"
    actions={<TextLink href={`/pet/${encodeURIComponent(tokenId)}/feed/status/${deposit.id}`}>
      {depositCopy.statusEntry}</TextLink>}>
    {deposit.state === 'waiting' ? `USDC arrived for ${name}. Waiting for conversion.` :
      deposit.state === 'unsupported' ? 'This deposit cannot become food automatically. Keep the transaction link for recovery.' :
        deposit.state === 'below_minimum' ? `Too small to convert now. It stays at ${name}'s address.` :
          deposit.state === 'converting' ? 'USDC sent for conversion. Still on its way.' :
            deposit.state === 'food' ? 'From another chain' :
              `Refunded to ${name}'s ${deposit.chain === 'base' ? 'Base' : 'Solana'} address. Check the deposit before trying again.`}
  </Message>)}</>;
}
