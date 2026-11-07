import { describe, expect, it } from 'vitest';
import { blockerOf } from './useAdvice';
import { adviceRefusedLine, autoPaidLine, autoRefusedLine, hireRefusedLine, likedOfferLine, noFeeAnswerLine, pairAdviceLine } from './lines';
import { lineOf } from '../screens/pet/usePetScreen';
import type { AdviceRead, ConversationLine } from '../seams/worker-types';

const price = { yocto: '747000000000000000000', cents: 0.34 };
const read: AdviceRead = { price, discounted: true, skilled: false, workerAsleep: false, resting: null,
  screeningAvailable: true, screeningResetAt: null,
  payer: { tokenId: '9', name: 'Pixel', state: 'ok', until: null }, dropsAt: null, pending: null, last: null, paused: false };

describe('society on existing work surfaces', () => {
  // spec: add-pet-society › Society hire flow › player advice quote
  it('shows the current discounted advice quote before asking', () => {
    expect(pairAdviceLine('Pixel', 'Biscuit', read.price.cents)).toBe('Pixel and Biscuit get along. Ask · 0.34¢');
  });

  // spec: add-pet-society › Society hire flow › manual quote
  it('names the liked worker and effective Manual price', () => {
    expect(likedOfferLine('Pixel', 'Biscuit', price.cents)).toBe('Pixel likes Biscuit. Ask Biscuit · 0.34¢');
  });

  // spec: add-pet-society › Society hire flow › player advice refused
  it('blocks advice through the relationship window without losing its question', () => {
    expect(blockerOf({ workerAsleep: false, read: { ...read, refusalUntil: '2099-01-01T16:00:00.000Z' } })).toBe('relationship');
    expect(adviceRefusedLine('Mochi', 'Pixel', '18:00')).toBe('Mochi needs a break from Pixel until 18:00. No food was spent.');
  });

  // spec: add-pet-society › Society hire flow › refusal expired
  it('restores the ordinary ask after the refusal time', () => {
    expect(blockerOf({ workerAsleep: false, read: { ...read, refusalUntil: '2020-01-01T16:00:00.000Z' } })).toBeNull();
  });

  // spec: add-pet-society › Society hire flow › manual hire refused
  it('shows the uncharged Manual refusal', () => {
    expect(hireRefusedLine('Mochi', '18:00')).toBe('Mochi needs a break until 18:00. No hire fee was paid.');
    const event: ConversationLine = { id: 'e', who: 'event', code: 'society_refused', hireMode: 'manual', worker: { tokenId: '1', name: 'Mochi' }, refusalUntil: '2099-01-01T16:00:00.000Z', at: 1 };
    expect(lineOf(event, 'Pixel', false)[0]?.who).toBe('event');
  });

  // spec: add-pet-society › Society hire flow › auto hire refused
  it('lets the pet say it will answer an Auto refusal itself', () => {
    expect(autoRefusedLine('Mochi')).toBe("Mochi needs a break today. I'll answer you myself.");
    const event: ConversationLine = { id: 'e', who: 'event', code: 'society_refused', hireMode: 'auto', worker: { tokenId: '1', name: 'Mochi' }, at: 1 };
    expect(lineOf(event, 'Pixel', false)[0]).toMatchObject({ who: 'pet', text: autoRefusedLine('Mochi') });
  });

  // spec: add-pet-society › Society hire flow › auto paid
  it('names the amount an Auto liked hire actually paid', () => {
    expect(autoPaidLine('Biscuit', price.cents)).toBe('I asked Biscuit. It cost 0.34¢.');
    const answer: ConversationLine = { id: 'r', who: 'pet', text: 'I found an answer.', at: 1, hire: { worker: 'Biscuit', price: price.yocto, priceCents: price.cents, mode: 'auto' } };
    expect(lineOf(answer, 'Pixel', false)[0]?.text).toBe('I found an answer. I asked Biscuit. It cost 0.34¢.');
  });

  // spec: add-pet-society › Society hire price contract › post-answer hire rejection
  it('names the answer cost separately from the rejected hire fee', () => {
    expect(noFeeAnswerLine('Nori', 0.21)).toBe("No hire fee was paid. Nori's answer cost 0.21¢.");
    const worker: ConversationLine = { id: 'w', who: 'worker', text: 'Try this.', at: 1, worker: { tokenId: '5', name: 'Nori' }, hire: { worker: 'Nori', noFee: true, answerPriceCents: 0.21 } };
    expect(lineOf(worker, 'Pixel', false)[0]).toMatchObject({ meta: 'Pixel asked Nori · no fee', foot: "No hire fee was paid. Nori's answer cost 0.21¢." });
  });
});
