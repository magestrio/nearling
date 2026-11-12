import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { onClearOutcome } from '../account/clearMemory';
import { Actions, Button, ChoiceList, Cluster, DebateInvitation, DebatePair, Heading, Message, Note, Sheet, Stack, Surface, Text, TextField, TextLink } from '../ds';
import { openFeed } from '../feeding/feedRequest';
import { useAuth } from '../seams/auth';
import { workerApi, WorkerError, type DebateRead, type PetView } from '../seams/worker';
import { useSignIn } from '../signin/signIn';
import { debateCopy as copy } from './copy';
import './debates.css';
import { eraseDraft, needsEligibilityRecheck, readDraft, saveDraft, utcDay, type DebateDraft } from './draft';
import { checkFrom, checkLine, visibleStatus, type Check, type VisibleStatus } from './state';

type Partner = { tokenId: string; name: string };
type Card = { id: string; read: DebateRead };

/** A draft nobody touched leaves nothing in the tab's storage. */
const persist = (draft: DebateDraft) => {
  if (draft.open || draft.topic !== '' || draft.selectedPet !== '') saveDraft(draft); else eraseDraft();
};

const defaultDraft =(tokenId: string, accountId: string, epoch: number): DebateDraft => ({ accountId, tokenId, epoch, selectedPet: '', topic: '', openerPet: tokenId, open: false });

/** The Pet stage owns the sheet and private cards. Re-reading never trusts an old owner response. */
export function useInvitationExperience({ pet, tokenOf, preselect, onOwnerLost }: {
  pet: Extract<PetView, { viewer: 'owner' }>;
  tokenOf: () => Promise<string | null>;
  preselect?: string | null;
  onOwnerLost: () => void;
}) {
  const { tokenId, name } = pet;
  const auth = useAuth();
  const accountId = auth.nearAccountId ?? '';
  const signIn = useSignIn();
  const [draft, setDraft] = useState<DebateDraft>(() => {
    return accountId ? readDraft(tokenId, accountId, sessionStorage, pet.memoryEpoch) ?? defaultDraft(tokenId, accountId, pet.memoryEpoch)
      : defaultDraft(tokenId, accountId, pet.memoryEpoch);
  });
  const [partners, setPartners] = useState<Partner[]>([]);
  const [partnerLoad, setPartnerLoad] = useState<'loading' | 'ready' | 'error'>('loading');
  const [check, setCheck] = useState<Check>('idle');
  const [estimatePerPetCents, setEstimatePerPetCents] = useState<number | null>(null);
  const [sleepName, setSleepName] = useState(name);
  const [sleepPetId, setSleepPetId] = useState(tokenId);
  const [refusalName, setRefusalName] = useState(name);
  const [checkedAt, setCheckedAt] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [sending, setSending] = useState(false);
  const [topicError, setTopicError] = useState(false);
  const [cards, setCards] = useState<Card[]>([]);
  const [cardLoading, setCardLoading] = useState(true);
  const [cardError, setCardError] = useState(false);
  const [cardBusy, setCardBusy] = useState<string | null>(null);
  const [cardDismissed, setCardDismissed] = useState(false);
  const [status, setStatus] = useState<{ id: string; kind: VisibleStatus; code?: string; retained?: boolean } | null>(null);
  const [pastDebateCode, setPastDebateCode] = useState<string | null>(null);
  const readSequence = useRef(0);
  // The pet whose incoming debates were read once: the 10-second refresh after that keeps what it shows, since a
  // «Checking invitation…» card for the length of every read made the conversation jump.
  const cardsReadFor = useRef<string | null>(null);
  const localOutcomeSequence = useRef(0);
  const dismissedCardIds = useRef(new Set<string>());
  const signedIn = auth.authenticated && !auth.sessionEnded;
  const selected = partners.find((row) => row.tokenId === draft.selectedPet) ?? null;

  useEffect(() => { if (accountId && draft.accountId === accountId) persist(draft); }, [draft, accountId]);
  useEffect(() => {
    if (!accountId || draft.accountId === accountId) return;
    setDraft(readDraft(tokenId, accountId, sessionStorage, pet.memoryEpoch) ?? defaultDraft(tokenId, accountId, pet.memoryEpoch));
    setCards([]);
    dismissedCardIds.current.clear();
    setCardDismissed(false);
    setStatus(null);
    setPastDebateCode(null);
  }, [accountId, draft.accountId, tokenId, pet.memoryEpoch]);
  useEffect(() => {
    if (draft.epoch === pet.memoryEpoch) return;
    eraseDraft();
    setDraft(defaultDraft(tokenId, accountId, pet.memoryEpoch));
    setCards([]);
    setPastDebateCode(null);
  }, [draft.epoch, pet.memoryEpoch, tokenId, accountId]);
  useEffect(() => {
    if (!preselect || preselect === tokenId) return;
    setDraft((now) => ({ ...now, selectedPet: preselect, openerPet: now.openerPet === now.selectedPet ? preselect : now.openerPet, open: true }));
  }, [preselect, tokenId]);
  // only an invitation the clear ended is told about: a clear with no sheet, draft, card or sent invitation says nothing here
  const hadInvitation = useRef(false);
  hadInvitation.current = draft.open || draft.topic !== '' || cards.length > 0 || status?.kind === 'invited';
  useEffect(() => onClearOutcome((outcome) => {
    if (outcome.tokenId !== tokenId) return;
    const had = hadInvitation.current;
    eraseDraft();
    setDraft(defaultDraft(tokenId, accountId, pet.memoryEpoch));
    setCards([]);
    setPastDebateCode(null);
    if (had) setStatus({ id: '', kind: 'cleared' });
  }), [tokenId, pet.memoryEpoch, accountId]);

  const lost = useCallback(() => {
    eraseDraft();
    setDraft(defaultDraft(tokenId, accountId, pet.memoryEpoch));
    setCards([]);
    setPastDebateCode(null);
    onOwnerLost();
  }, [tokenId, pet.memoryEpoch, accountId, onOwnerLost]);

  useEffect(() => {
    if (!draft.open || !signedIn) return;
    let live = true;
    setPartnerLoad('loading');
    void (async () => {
      try {
        const token = await tokenOf();
        if (!token || !live) return;
        const summary = await workerApi.debatePartners(token, tokenId);
        let next = summary.partners;
        if (draft.selectedPet && !next.some((row) => row.tokenId === draft.selectedPet)) {
          const other = await workerApi.pet(null, draft.selectedPet);
          next = [...next, { tokenId: other.tokenId, name: other.name }];
        }
        if (!live) return;
        setPartners(next);
        setDraft((now) => now.selectedPet || !next[0] ? now : { ...now, selectedPet: next[0].tokenId });
        setPartnerLoad('ready');
      } catch (error) {
        if (!live) return;
        if (error instanceof WorkerError && error.code === 'not_owner') lost();
        else setPartnerLoad('error');
      }
    })();
    return () => { live = false; };
  }, [draft.open, draft.selectedPet, signedIn, tokenId, tokenOf, refresh, lost]);

  useEffect(() => {
    if (!draft.open || signedIn || !draft.selectedPet || partners.some((row) => row.tokenId === draft.selectedPet)) return;
    let live = true;
    void workerApi.pet(null, draft.selectedPet).then((publicPet) => {
      if (!live) return;
      setPartners([{ tokenId: publicPet.tokenId, name: publicPet.name }]);
      setPartnerLoad('ready');
    }).catch(() => { if (live) setPartnerLoad('error'); });
    return () => { live = false; };
  }, [draft.open, draft.selectedPet, signedIn, partners]);

  useEffect(() => {
    if (!draft.open || !signedIn || !selected || partnerLoad !== 'ready') return;
    let live = true;
    setCheck('loading');
    setEstimatePerPetCents(null);
    void (async () => {
      try {
        const token = await tokenOf();
        if (!token || !live) return;
        const eligibility = await workerApi.debateEligibility(token, tokenId, selected.tokenId);
        if (live) { setEstimatePerPetCents(eligibility.estimatePerPetCents); setCheck('ready'); setCheckedAt(Date.now()); }
      } catch (error) {
        if (!live) return;
        if (error instanceof WorkerError && error.code === 'not_owner') lost();
        else {
          if (error instanceof WorkerError && error.code === 'asleep' && error.body && typeof error.body === 'object') {
            if ('name' in error.body && typeof error.body.name === 'string') setSleepName(error.body.name);
            if ('petId' in error.body && typeof error.body.petId === 'string') setSleepPetId(error.body.petId);
          }
          if (error instanceof WorkerError && error.code === 'society_refusal' && error.body && typeof error.body === 'object' &&
            'petId' in error.body && typeof error.body.petId === 'string')
            setRefusalName(error.body.petId === selected.tokenId ? selected.name : name);
          setCheck(checkFrom(error));
        }
      }
    })();
    return () => { live = false; };
  }, [draft.open, draft.selectedPet, signedIn, selected?.tokenId, partnerLoad, tokenId, tokenOf, refresh, lost]);

  const loadCards = useCallback(async () => {
    const sequence = ++readSequence.current;
    if (!signedIn) { setCards([]); setCardLoading(false); cardsReadFor.current = null; return; }
    if (cardsReadFor.current !== tokenId) setCardLoading(true);
    try {
      const token = await tokenOf();
      if (!token || sequence !== readSequence.current) return;
      const [found, history] = await Promise.all([workerApi.debateIncoming(token, tokenId), workerApi.debateRecords(token, tokenId)]);
      const reads = await Promise.all(found.ids.map(async (id) => ({ id, read: await workerApi.debateRead(token, id) })));
      if (sequence !== readSequence.current) return;
      const currentCards = reads.filter(({ id, read }) => !dismissedCardIds.current.has(id) && read.status === 'invited' && !!read.firstPet && !!read.secondPet);
      setCards(currentCards);
      if (currentCards.length) setCardDismissed(false);
      const newest = history.records.find((record) => record.side === 'proposer' || record.status !== 'invited');
      if (newest) {
        let read: DebateRead | null = null;
        if (newest.status !== 'invited') {
          try { read = await workerApi.debateRead(token, newest.id); }
          catch (error) { if (!(error instanceof WorkerError && error.status === 404)) throw error; }
        }
        const kind = visibleStatus(newest.status);
        if (sequence === readSequence.current) setStatus((before) => before && localOutcomeSequence.current > sequence ? before
          : { id: newest.id, kind, retained: newest.retained, ...(read?.code ? { code: read.code } : {}) });
      }
      const retained = history.records.find((record) => record.retained);
      if (retained) {
        let code: string | null = null;
        try { code = (await workerApi.debateRead(token, retained.id)).code ?? null; }
        catch (error) { if (!(error instanceof WorkerError && error.status === 404)) throw error; }
        if (sequence === readSequence.current) setPastDebateCode(code);
      } else if (sequence === readSequence.current) setPastDebateCode(null);
      setCardError(false);
      cardsReadFor.current = tokenId;
    } catch (error) {
      if (sequence !== readSequence.current) return;
      setCards([]);
      if (error instanceof WorkerError && error.code === 'not_owner') lost();
      else setCardError(true);
    } finally { if (sequence === readSequence.current) setCardLoading(false); }
  }, [signedIn, tokenId, tokenOf, lost]);
  useEffect(() => { void loadCards(); return () => { readSequence.current += 1; }; }, [loadCards]);
  useEffect(() => {
    const visible = () => {
      if (document.hidden) return;
      if (draft.open) setRefresh((n) => n + 1);
      void loadCards();
    };
    const tick = () => {
      if (document.hidden) return;
      if (draft.open && checkedAt && needsEligibilityRecheck(checkedAt, Date.now())) setRefresh((n) => n + 1);
      void loadCards();
    };
    document.addEventListener('visibilitychange', visible);
    const timer = window.setInterval(tick, 10_000);
    const reset = window.setTimeout(() => { if (draft.open) setRefresh((n) => n + 1); void loadCards(); },
      (utcDay(Date.now()) + 1) * 86_400_000 - Date.now());
    return () => { document.removeEventListener('visibilitychange', visible); window.clearInterval(timer); window.clearTimeout(reset); };
  }, [draft.open, checkedAt, loadCards]);

  const open = () => { setDraft((now) => ({ ...now, open: true })); setRefresh((n) => n + 1); };
  // stored at once: a link that leaves for this same page must not find the sheet still open
  const close = () => { const next = { ...draft, open: false }; persist(next); setDraft(next); };
  const send = async () => {
    if (!selected || sending || check !== 'ready' || !signedIn) return;
    if (!draft.topic.trim() || [...draft.topic].length > 140) { setTopicError(true); return; }
    setSending(true);
    try {
      const token = await tokenOf();
      if (!token) return;
      const sent = await workerApi.debateInvite(token, { firstPet: tokenId, secondPet: selected.tokenId,
        openerPet: draft.openerPet === selected.tokenId ? selected.tokenId : tokenId, topic: draft.topic });
      eraseDraft();
      setDraft(defaultDraft(tokenId, accountId, pet.memoryEpoch));
      localOutcomeSequence.current = readSequence.current + 1;
      setStatus({ id: sent.id, kind: 'invited' });
    } catch (error) {
      if (error instanceof WorkerError && error.code === 'not_owner') lost();
      else if (error instanceof WorkerError && error.code === 'topic_rejected') setTopicError(true);
      else {
        if (error instanceof WorkerError && error.code === 'society_refusal' && error.body && typeof error.body === 'object' &&
          'petId' in error.body && typeof error.body.petId === 'string')
          setRefusalName(error.body.petId === selected.tokenId ? selected.name : name);
        setCheck(checkFrom(error));
      }
    } finally { setSending(false); }
  };
  const decide = async (card: Card, decision: 'accept' | 'decline') => {
    if (!signedIn || cardBusy) return;
    setCardBusy(card.id);
    try {
      const token = await tokenOf();
      if (!token) return;
      const answer = await workerApi.debateDecision(token, card.id, decision);
      setCards((now) => now.filter((item) => item.id !== card.id));
      localOutcomeSequence.current = readSequence.current + 1;
      setStatus({ id: card.id, kind: answer.status, ...(answer.code ? { code: answer.code } : {}) });
    } catch (error) {
      if (error instanceof WorkerError && error.code === 'not_owner') lost();
      else if (error instanceof WorkerError && ['gift', 'expired'].includes(error.code)) {
        setCards((now) => now.filter((item) => item.id !== card.id));
        localOutcomeSequence.current = readSequence.current + 1;
        setStatus({ id: card.id, kind: error.code as 'gift' | 'expired' });
      } else setCardError(true);
    } finally { setCardBusy(null); }
  };

  const other = selected ?? { tokenId, name };
  const dismissCard = (id: string) => { dismissedCardIds.current.add(id); setCards((now) => now.filter((card) => card.id !== id)); };
  const first = draft.openerPet === other.tokenId ? other : { tokenId, name };
  const second = first.tokenId === tokenId ? other : { tokenId, name };
  const sheetLine = !signedIn ? copy.signedOut : partnerLoad === 'loading' ? copy.loading
    : partnerLoad === 'error' ? copy.error : !partners.length ? copy.empty
      : checkLine(check, check === 'asleep' ? sleepName : check === 'open_pair_invitation' ? other.name : check === 'society_refusal' ? refusalName : name);
  // a pair error stands under the pair it is about (the frames), where choosing another known pet rechecks it
  const pairError = signedIn && partnerLoad === 'ready' && partners.length > 0 && (check === 'unknown_pair' || check === 'same_owner');
  const invalidTopic =!draft.topic.trim() || [...draft.topic].length > 140;
  const canSend = signedIn && partnerLoad === 'ready' && check === 'ready' && !!selected && !topicError && !invalidTopic && !sending;
  const sheet = draft.open ? <Sheet title={copy.title} closeLabel={copy.close} closeText column onClose={close} status={sheetLine} foot={
    !signedIn ? <Button block onClick={() => signIn.begin('signin')}>Sign in</Button>
      : partnerLoad === 'error' || check === 'error' ? <Button block onClick={() => setRefresh((n) => n + 1)}>Try again</Button>
        : !partners.length && partnerLoad === 'ready' ? <Button block onClick={close}>{`Back to ${name}`}</Button>
          : check === 'asleep' ? <Button block onClick={() => { close(); openFeed({ tokenId: sleepPetId,
              name: sleepName, label: sleepName, elsewhere: sleepPetId !== tokenId }); }}>{`Feed ${sleepName}`}</Button>
            : <Button block disabled={!canSend} busy={sending} onClick={() => void send()}>Send invitation</Button>}
  >
    <Stack gap={4}>
      {partnerLoad === 'ready' && partners.length ? <>
        <Stack gap={2}>
          <Text variant="body-strong">{copy.pairLabel}</Text>
          <DebatePair first={first} second={second} ordered selectablePet={other.tokenId} options={partners}
            selectLabel={copy.pairLabel} disabled={check === 'asleep'} onSelectPet={(otherTokenId) => {
              const next = partners.find((row) => row.tokenId === otherTokenId);
              if (!next) return;
              setDraft((now) => ({ ...now, selectedPet: next.tokenId, openerPet: now.openerPet === now.selectedPet ? next.tokenId : now.openerPet }));
              setCheck('loading');
            }} />
        </Stack>
        {pairError ? <Note tone="error">{sheetLine}</Note> : null}
        <TextField label={copy.topicLabel} placeholder={copy.topicPlaceholder} value={draft.topic} maxLength={140} count
          onChange={(topic) => { setDraft((now) => ({ ...now, topic })); setTopicError(false); }}
          error={topicError || (check === 'ready' && invalidTopic) ? copy.topicRejected : undefined} disabled={check === 'asleep'} />
        <Stack gap={2}>
          <Text variant="body-strong">{copy.openerLabel}</Text>
          <ChoiceList label={copy.openerLabel} value={draft.openerPet} disabled={check === 'asleep'} quote={false}
            onChange={(value) => setDraft((now) => ({ ...now, openerPet: value }))}
            options={[{ value: tokenId, text: name }, { value: other.tokenId, text: other.name }]} />
        </Stack>
        {estimatePerPetCents !== null ? <Text variant="small" tabular>{copy.estimate(estimatePerPetCents)}</Text> : null}
        {(check === 'ready' || !signedIn) ? <Note tone="plain">{copy.notice}</Note> : null}
      </> : null}
      {sheetLine && !pairError ? <Note tone={partnerLoad === 'error' || check === 'error' ? 'error' : partnerLoad === 'loading' || check === 'loading' ? 'status' : 'plain'}>{sheetLine}</Note> : null}
    </Stack>
  </Sheet> : null;

  // before the pair and topic are known the card is the same surface with the status and the standing notice (the frames' loading and error)
  const holding = (line: string, tone: 'status' | 'error', action: ReactNode) => <li className="ds-debate-invitation"><Surface><Stack gap={3}>
    <Cluster gap={2} align="center" justify="space-between"><Heading level={2} variant="title-3">{copy.cardTitle}</Heading>
      <Button icon="close" variant="ghost" size="compact" onClick={() => setCardDismissed(true)}>{copy.close}</Button></Cluster>
    <Note>{copy.cardNotice}</Note>
    <Note tone={tone}>{line}</Note>
    <Actions>{action}</Actions>
  </Stack></Surface></li>;
  const cardNodes = cardDismissed ? null : !signedIn ? <li><Stack gap={2}><Note>{copy.cardSignedOut}</Note>
      <Button size="compact" onClick={() => signIn.begin('signin')}>Sign in</Button></Stack></li>
    : cardLoading ? holding(copy.cardLoading, 'status', <Button size="compact" disabled>Accept debate</Button>)
      : cardError ? holding(copy.cardError, 'error', <Button variant="secondary" size="compact" onClick={() => void loadCards()}>Try again</Button>)
        : cards.length ? <li><ul aria-label={copy.cardTitle} className="ds-stack" style={{ gap: 'var(--space-3)', listStyle: 'none', margin: 'var(--space-0)', padding: 'var(--space-0)' }}>
          {cards.map((card) => {
            const read = card.read;
            if (!read.firstPet || !read.secondPet || !read.topic) return null;
            const ordered = read.openerPet === read.secondPet.tokenId ? [read.secondPet, read.firstPet] : [read.firstPet, read.secondPet];
            const sleep = pet.fullness.state === 'asleep';
            return <DebateInvitation key={card.id} first={ordered[0]!} second={ordered[1]!} ordered title={copy.cardTitle} topic={read.topic}
              estimate={read.estimatePerPetCents == null ? '' : copy.cardEstimate(read.estimatePerPetCents)} notice={copy.cardNotice}
              status={sleep ? `${name} is asleep. Feed ${name} before accepting.` : undefined}
              tone={sleep ? 'plain' : undefined}
              onClose={() => dismissCard(card.id)}
              actions={sleep ? <Button size="compact" onClick={() => openFeed({ tokenId, name, label: name, elsewhere: false })}>{`Feed ${name}`}</Button>
                : <><Button size="compact" busy={cardBusy === card.id} onClick={() => void decide(card, 'accept')}>Accept debate</Button>
                  <Button size="compact" variant="secondary" busy={cardBusy === card.id} onClick={() => void decide(card, 'decline')}>Decline</Button></>} />;
          })}
        </ul></li> : null;
  const statusNode = status ? <Message from="event" actions={status.code
    ? <TextLink href={`/debate#${status.code}`} hit>{status.retained ? copy.pastDebates : 'View debate'}</TextLink> : undefined}>{copy[status.kind]}</Message> : null;
  return { open, close, sheet, cards: cardNodes, status: statusNode, pastDebateCode, shown: draft.open, clear: lost };
}
