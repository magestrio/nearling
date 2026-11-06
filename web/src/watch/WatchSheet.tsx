import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Cluster, Note, Sheet, Stack, Text, TextField, TextLink } from '../ds';
import { useAuth } from '../seams/auth';
import { WorkerError, workerApi, type WatchRead } from '../seams/worker';
import { openFeed } from '../feeding/feedRequest';
import { useSignInLines } from '../signin/SignInOutcome';
import { localCheckTime, nextCheckDate, pauseLine, replacedLine, resultLine, stoppedLine } from './view';

const BLANK = 'Name a topic, release, account or page to watch.';
const LONG = 'Keep the watch target under 500 characters.';

export function WatchSheet({ tokenId, name, open, draft, onDraft, onClose, tokenOf, onOwnerLost, onChanged }: {
  tokenId: string;
  name: string;
  open: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onClose: () => void;
  tokenOf: () => Promise<string | null>;
  onOwnerLost: () => void;
  onChanged: () => void;
}) {
  const auth = useAuth();
  const [read, setRead] = useState<WatchRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // what the owner's last save or stop did, said until the next edit or action
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const typed = useRef(false);
  const callbacks = useRef({ onDraft, onClose, onOwnerLost, auth });
  callbacks.current = { onDraft, onClose, onOwnerLost, auth };
  const [signInLine] = useSignInLines({ text: JSON.stringify({ target: draft }), action: 'watch' });
  useEffect(() => { if (open && draft && read === null) typed.current = true; }, [open, draft, read]);
  const load = useCallback(async () => {
    const seq = ++generation.current;
    try {
      const token = await tokenOf();
      if (!token) throw new WorkerError(401, 'signed_out');
      const next = await workerApi.watch(token, tokenId);
      if (seq !== generation.current) return;
      let withRate = next;
      if (next.latestReceiptId && next.latestPriceYocto) {
        const pointer = await workerApi.verificationThought(token, tokenId, next.latestReceiptId);
        if (seq !== generation.current) return;
        withRate = { ...next, latestNearUsdRate: pointer.nearUsdRate, latestChange: pointer.replyText };
      }
      setRead(withRate);
      setError(null);
      if (!typed.current) callbacks.current.onDraft(next.target ?? '');
    } catch (e) {
      if (seq !== generation.current) return;
      if (e instanceof WorkerError && e.status === 403) { setRead(null); callbacks.current.onDraft(''); callbacks.current.onClose(); callbacks.current.onOwnerLost(); return; }
      if (e instanceof WorkerError && e.status === 401) callbacks.current.auth.endSession(true, true);
      setError(`We couldn't load ${name}'s watch right now. Try again.`);
    }
  }, [tokenId, tokenOf, name]);

  useEffect(() => {
    if (!open) { generation.current++; return; }
    void load();
    const visible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', visible);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    return () => { generation.current++; document.removeEventListener('visibilitychange', visible); window.clearInterval(timer); };
  }, [open, load]);

  const change = (value: string) => { typed.current = true; onDraft(value); setFieldError(null); setNotice(null); };
  const closeSheet = () => {
    generation.current++;
    typed.current = false;
    onDraft('');
    setRead(null);
    setError(null);
    setFieldError(null);
    setNotice(null);
    onClose();
  };
  const act = async (kind: 'save' | 'resume' | 'stop') => {
    if (!auth.needSession()) return;
    if (kind === 'save') {
      if ([...draft].length > 500) { setFieldError(LONG); return; }
      if (!draft.trim()) { setFieldError(BLANK); return; }
    }
    setBusy(true);
    setNotice(null);
    generation.current++;
    const previous = read;
    try {
      const token = await tokenOf();
      if (!token) throw new WorkerError(401, 'signed_out');
      const next = kind === 'save' ? await workerApi.saveWatch(token, tokenId, draft)
        : kind === 'resume' ? await workerApi.resumeWatch(token, tokenId) : await workerApi.stopWatch(token, tokenId);
      generation.current++;
      if (kind === 'stop') { setRead(null); onDraft(''); typed.current = false; setNotice(stoppedLine(name)); }
      else {
        setRead(next as WatchRead); onDraft((next as WatchRead).target ?? ''); typed.current = false;
        if (kind === 'save') setNotice(replacedLine(previous, (next as WatchRead).target ?? draft.trim()));
      }
      onChanged();
      if (kind !== 'stop') void load();
      setError(null);
      setFieldError(null);
    } catch (e) {
      if (e instanceof WorkerError && e.status === 403) { setRead(null); onDraft(''); onClose(); onOwnerLost(); return; }
      if (e instanceof WorkerError && e.status === 401) auth.endSession(true, true);
      else if (e instanceof WorkerError && e.code === 'watch_blank') setFieldError(BLANK);
      else if (e instanceof WorkerError && e.code === 'watch_too_long') setFieldError(LONG);
      else setError(`We couldn't load ${name}'s watch right now. Try again.`);
    } finally { setBusy(false); }
  };
  if (!open) return null;
  const latest = !error && read ? resultLine(name, read) : null;
  const pause = !error && read?.pause && !read.paused ? pauseLine(name, read.pause) : null;
  const foot = error ? null : <Stack gap={3}>
    <Text variant="small" tone="secondary">{`Your target is public on ${name}'s page. Checks send it to NEAR AI, web search and the source site.`}</Text>
    <Cluster justify="space-between">
      {read?.target ? <Button variant="secondary" off={busy} onClick={() => void act('stop')}>Stop watch</Button> : null}
      {read?.paused ? <Button off={busy} onClick={() => void act('resume')}>Resume watch</Button>
        : <Button off={busy} onClick={() => void act('save')}>Save watch</Button>}
    </Cluster>
  </Stack>;
  return <Sheet title="Watch something" column foot={foot} status={fieldError ?? error ?? notice ?? pause?.text ?? latest ?? ''} onClose={closeSheet} busy={busy}>
    <Stack gap={4}>
      {error ? <Stack gap={2}><Note tone="error" silent>{error}</Note><Cluster justify="flex-end"><Button variant="secondary" size="compact" onClick={() => void load()}>Try again</Button></Cluster></Stack> : null}
      {auth.sessionLine && signInLine?.action ? <Stack gap={2}><Note tone="plain">{signInLine.text}</Note><Button variant="secondary" onClick={signInLine.action.onClick}>{signInLine.action.label}</Button></Stack> : null}
      <TextField label={`What should ${name} watch?`} value={draft} onChange={change} hint="Up to 500 characters." error={fieldError ?? undefined} multiline rows={3} />
      <Text>{read?.paused ? 'About 0.85¢ per completed check; up to about 1.1¢ with a second try' : 'About 0.85¢ per check; up to 1.1¢ with a second try. Each check uses 10% energy and food.'}</Text>
      {!error && read?.paused ? <Text>Watch paused after the gift</Text> : null}
      {!error && read?.savedHourUtc !== undefined ? <Text variant="small" tone="secondary">{`Checks daily at ${localCheckTime(read.savedHourUtc, read.nextCheck ? new Date(read.nextCheck) : undefined)}`}</Text> : null}
      {!error && read?.nextCheck ? <Text variant="small" tone="secondary">{`Next check: ${nextCheckDate(read.nextCheck)}`}</Text> : null}
      {notice ? <Note tone="status">{notice}</Note> : null}
      {pause ? <Stack gap={2}><Text>{pause.text}</Text>{pause.feed ? <Cluster justify="flex-end"><Button icon="feed" haspopup="dialog" onClick={() => openFeed({ tokenId, name, label: name, elsewhere: false })}>{`Feed ${name}`}</Button></Cluster> : null}</Stack> : null}
      {latest ? <Text>{latest}</Text> : null}
      {!error && read?.latestReceiptId ? <TextLink href={`/pet/${tokenId}/verify/${read.latestReceiptId}`} icon="verify">Check this thought</TextLink> : null}
    </Stack>
  </Sheet>;
}
