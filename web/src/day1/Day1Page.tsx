// Dev builds only (VITE_DEV_ROUTE): the day-1 checks of release.md › Init, done by a person at the
// browser — Privy's Google sign-in, the NEAR account id, one testnet transaction signed and sent.
// These lines are a diagnostic, not player copy; the production build does not contain this file.
import { useEffect, useState } from 'react';
import { config } from '../config';
import { PrivySigner, publicKeyFromImplicitAccount } from '../near/privySigner';
import { nearRpc } from '../seams/rpc';
import { useAuth } from '../seams/auth';
import { workerApi } from '../seams/worker';
import { rememberReturnPlace } from './returnPlace';
import './day1.css';

/** 0.001 NEAR in yoctoNEAR. */
const TRANSFER_YOCTO = 1_000_000_000_000_000_000_000n;

type Line = { label: string; value: string };

function useLines() {
  const [lines, setLines] = useState<Line[]>([]);
  return [lines, (label: string, value: string) => setLines((prev) => [...prev, { label, value }])] as const;
}

export default function Day1Page() {
  const auth = useAuth();
  const [worker, setWorker] = useState('checking');
  const [contract, setContract] = useState('checking');
  const [balance, setBalance] = useState<string | null>(null);
  const [tokenLength, setTokenLength] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, addLog] = useLines();

  useEffect(() => {
    workerApi.health().then((h) => setWorker(`${h.env} ${h.version}`), (e: unknown) => setWorker(`error: ${String(e)}`));
    nearRpc
      .viewFunction<string>(config.contractId, 'version', {})
      .then((v) => setContract(`${config.contractId} version ${v}`), (e: unknown) => setContract(`error: ${String(e)}`));
  }, []);

  useEffect(() => {
    if (!auth.authenticated) {
      setTokenLength(null);
      return;
    }
    auth.getIdentityToken().then((t) => setTokenLength(t ? t.length : 0));
  }, [auth, auth.authenticated]);

  useEffect(() => {
    if (!auth.nearAccountId) {
      setBalance(null);
      return;
    }
    nearRpc.getBalance(auth.nearAccountId).then(
      (b) => setBalance(`${b} yoctoNEAR`),
      () => setBalance('account does not exist yet: fund it first'),
    );
  }, [auth.nearAccountId]);

  const signIn = () => {
    // The place waits in the tab; Privy gets `/` as the return address (ADR-001).
    rememberReturnPlace('/__day1');
    window.history.replaceState(null, '', '/');
    auth.login();
  };

  const createWallet = async () => {
    setBusy(true);
    try {
      addLog('wallet created', await auth.createNearWallet());
    } catch (e) {
      addLog('wallet error', String(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!auth.nearAccountId) return;
    setBusy(true);
    try {
      const signer = new PrivySigner(publicKeyFromImplicitAccount(auth.nearAccountId), auth.signNearHash);
      const result = await nearRpc.transfer({
        accountId: auth.nearAccountId,
        signer,
        receiverId: config.treasuryAccountId,
        amountYocto: TRANSFER_YOCTO,
      });
      addLog(result.ok ? 'transfer sent' : 'transfer failed', result.txHash);
    } catch (e) {
      addLog('transfer error', String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="day1">
      <h1>Day-1 checks ({config.env})</h1>

      <section className="day1__section">
        <div>Worker: <span className="day1__mono" data-testid="worker">{worker}</span></div>
        <div>Contract: <span className="day1__mono" data-testid="contract">{contract}</span></div>
      </section>

      <section className="day1__section">
        <div>Privy ready: {String(auth.ready)} · signed in: {String(auth.authenticated)}</div>
        <div className="day1__row">
          <button className="day1__button" onClick={signIn} disabled={!auth.ready || auth.authenticated}>
            Sign in with Google
          </button>
          <button className="day1__button" onClick={() => void auth.logout()} disabled={!auth.authenticated}>
            Sign out
          </button>
        </div>
        {tokenLength !== null && <div>Identity token: {tokenLength > 0 ? `present, ${tokenLength} characters` : 'absent'}</div>}
      </section>

      <section className="day1__section">
        <div>
          NEAR account: <span className="day1__mono" data-testid="account">{auth.nearAccountId ?? 'none'}</span>
        </div>
        {balance && <div>Balance: <span className="day1__mono">{balance}</span></div>}
        <div className="day1__row">
          <button className="day1__button" onClick={() => void createWallet()} disabled={busy || !auth.authenticated || !!auth.nearAccountId}>
            Create NEAR wallet
          </button>
          <button className="day1__button" onClick={() => void send()} disabled={busy || !auth.nearAccountId}>
            Send 0.001 NEAR to {config.treasuryAccountId}
          </button>
        </div>
      </section>

      {log.length > 0 && (
        <section className="day1__section">
          {log.map((l, i) => (
            <div key={i}>{l.label}: <span className="day1__mono" data-testid="log">{l.value}</span></div>
          ))}
        </section>
      )}
    </main>
  );
}
