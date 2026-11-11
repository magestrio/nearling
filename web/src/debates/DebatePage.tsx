import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Centerpiece, DebateLine, DebatePair, Header, Heading, IconButton, Live, Note, Page, Shell, Stack } from '../ds';
import { debateVerifyPath, petPath } from '../route';
import { useAuth } from '../seams/auth';
import { workerApi, WorkerError, type DebateRead } from '../seams/worker';
import { useSignIn } from '../signin/signIn';
import { debateCopy as copy } from './copy';
import { debateOpen, readShared } from './share';
import { exactNear, lineCents, lineReceipt, orderedLines, transcriptStatus } from './transcript';

type Load = { kind: 'loading' | 'error' | 'deleted' } | { kind: 'ready'; read: DebateRead; owner: boolean };

export function DebatePage({ code }: { code: string }) {
  const auth = useAuth();
  const signIn = useSignIn();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [revision, setRevision] = useState(0);
  const [stopping, setStopping] = useState(false);
  const opened = useRef(false);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    setState((old) => old.kind === 'ready' ? old : { kind: 'loading' });
    void (async () => {
      try {
        const read = await readShared(code);
        if (!live) return;
        if (!opened.current) { debateOpen(read, 'debate_link_opened'); opened.current = true; }
        let owner = false;
        if (auth.authenticated && !auth.sessionEnded) {
          const token = await auth.getIdentityToken();
          if (token) {
            try { await workerApi.debateRead(token, read.id); owner = true; }
            catch (error) {
              if (error instanceof WorkerError && error.status === 401) auth.endSession(false);
              if (error instanceof WorkerError && error.status === 404) throw error;
            }
          }
        }
        if (live) setState({ kind: 'ready', read, owner });
      } catch (error) {
        if (error instanceof WorkerError && error.status === 404 && auth.authenticated && !auth.sessionEnded) {
          let token: string | null;
          try { token = await auth.getIdentityToken(); }
          catch { if (live) setState({ kind: 'error' }); return; }
          if (token) {
            try {
              const cleared = await workerApi.debateCleared(token, code);
              if (live) setState({ kind: 'ready', read: cleared, owner: true });
              return;
            } catch (lookupError) {
              if (lookupError instanceof WorkerError && lookupError.status === 401) auth.endSession(false);
              else if (!(lookupError instanceof WorkerError && lookupError.status === 404)) {
                if (live) setState({ kind: 'error' });
                return;
              }
            }
          }
        }
        if (live) setState({ kind: error instanceof WorkerError && error.status === 404 || error instanceof Error && error.message === 'invalid_share_code' ? 'deleted' : 'error' });
      }
    })();
    return () => { live = false; };
  }, [code, revision, auth.authenticated, auth.sessionEnded]);
  useEffect(() => {
    const visible = () => { if (!document.hidden) refresh(); };
    const shown = (event: PageTransitionEvent) => { if (event.persisted) refresh(); };
    const timer = window.setInterval(() => { if (!document.hidden) refresh(); }, 10_000);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pageshow', shown);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('pageshow', shown); };
  }, [refresh]);
  const read = state.kind === 'ready' ? state.read : null;
  const first = read?.firstPet;
  const second = read?.secondPet;
  const opener = read?.openerPet === second?.tokenId ? second : first;
  const other = opener === first ? second : first;
  const lines = read ? orderedLines(read) : [];
  const status = read ? transcriptStatus(read) : state.kind === 'loading' ? copy.transcriptLoading
    : state.kind === 'deleted' ? copy.transcriptDeleted : copy.transcriptError;
  const mayStop = state.kind === 'ready' && state.owner && (read?.status === 'accepted' || read?.status === 'running')
    && !read.lines?.some((line) => line.status === 'pending' || line.status === 'receipt_pending');
  const stop = async () => {
    if (!read || stopping || !mayStop || !auth.needSession()) return;
    setStopping(true);
    try {
      const token = await auth.getIdentityToken();
      if (!token) { auth.endSession(false, true); return; }
      await workerApi.debateStop(token, read.id);
    } catch (error) { if (error instanceof WorkerError && error.status === 401) auth.endSession(false, true); }
    finally { setStopping(false); refresh(); }
  };
  const sparse = state.kind === 'deleted' || state.kind === 'error';
  return <Shell fill={sparse} header={<Header start={first
      ? <Button variant="ghost" size="compact" icon="back" href={petPath(first.tokenId)}>{copy.transcriptBack(first.name)}</Button>
      : <IconButton icon="back" label="Go home" href="/" />}
    end={read && state.kind === 'ready' && !state.owner && auth.ready && !auth.authenticated ? <Button variant="secondary" size="compact" onClick={() => signIn.begin('signin')}>Sign in</Button> : null} />}>
    <Page width="narrow" fill={sparse}><Live alert={sparse}>{status}</Live>
      {state.kind === 'deleted' ? <Centerpiece actions={<Button href="/" block>Go home</Button>}>
          <Note tone="error" silent>{status}</Note></Centerpiece>
        : state.kind === 'error' ? <Centerpiece actions={<Button onClick={refresh} block>Try again</Button>}>
          <Stack gap={4}>{first && second ? <DebatePair first={first} second={second} ordered /> : null}
            {read?.topic ? <Heading level={1} variant="title-2">{read.topic}</Heading> : null}
            <Note tone="error" silent>{status}</Note></Stack></Centerpiece>
          : state.kind === 'loading' ? <Note tone="status" silent>{status}</Note>
            : <Stack gap={4}>
              {opener && other ? <DebatePair first={opener} second={other} ordered /> : null}
              {read?.topic ? <Heading level={1} variant="title-2">{read.topic}</Heading> : null}
              <Note tone={read?.status === 'running' || read?.status === 'accepted' ? 'status' : 'plain'} silent>{status}</Note>
              {lines.length ? <ol className="ds-stack" aria-label="Debate lines" style={{ gap: 'var(--space-4)', listStyle: 'none', margin: 'var(--space-0)', padding: 'var(--space-0)' }}>
                {lines.map((line, index) => {
                  const pet = line.speakerPet === first?.tokenId ? first : second;
                  if (!pet || !line.text) return null;
                  return <Fragment key={line.order}><DebateLine pet={pet} line={line.text} number={line.order}
                    cost={lineCents(line)}
                    costNear={line.status === 'settled' ? exactNear(line.priceYocto) : null}
                    unavailableNote={line.status === 'unavailable' ? copy.debitRejectedLine : undefined}
                    receipt={lineReceipt(line)} current={index === lines.length - 1}
                    href={debateVerifyPath(code, line.order)} onCheck={() => { if (read) debateOpen(read, 'debate_receipt_opened'); }} />
                    {mayStop && index === lines.length - 1 ? <li><Button variant="secondary" size="compact" busy={stopping}
                      onClick={() => void stop()}>Stop debate</Button></li> : null}</Fragment>;
                })}</ol> : null}
              {read && lines.length > 0 && (read.status === 'stopped' || read.status === 'gift' || read.status === 'refused' || read.status === 'unavailable' || read.status === 'cleared')
                ? <Note tone={read.endReason === 'debit_rejected' ? 'error' : 'plain'} silent>{status}</Note> : null}
            </Stack>}
    </Page></Shell>;
}
