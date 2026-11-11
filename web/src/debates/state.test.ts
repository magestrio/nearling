import { expect, it } from 'vitest';
import { WorkerError } from '../seams/worker-types';
import { checkFrom, checkLine, visibleStatus } from './state';

// spec: add-debates › Debate invitation flow › unknown pair
// spec: add-debates › Debate invitation flow › same owner
// spec: add-debates › Debate outcome rule › daily slot used
it('keeps eligibility refusals distinct from a connection error', () => {
  expect(checkLine(checkFrom(new WorkerError(409, 'unknown_pair')), 'Pixel')).toBe('These pets need to meet before debating.');
  expect(checkLine(checkFrom(new WorkerError(409, 'same_owner')), 'Pixel')).toBe('Choose a pet owned by someone else.');
  expect(checkLine(checkFrom(new WorkerError(409, 'daily_slot_used')), 'Pixel')).toBe('Pixel has debated today. Try again tomorrow.');
  expect(checkLine(checkFrom(new WorkerError(503, 'chain_unreachable')), 'Pixel')).toBe('Could not check this debate. Try again.');
});

// spec: add-debates › Debate invitation screen › asleep
it('uses the sleeping pet name supplied by the owner checked Worker response', () => {
  expect(checkLine(checkFrom(new WorkerError(409, 'asleep')), 'Nori')).toBe('Nori is asleep. Feed Nori before debating.');
});

// spec: add-debates › Debate invitation flow › invited
it('shows the coded open-pair refusal as waiting for the other owner', () => {
  expect(checkLine(checkFrom(new WorkerError(409, 'open_pair_invitation')), 'Nori'))
    .toBe("Waiting for Nori's owner to answer your last invitation.");
});

// spec: add-debates › Debate invitation flow › accepted
// spec: add-debates › Debate invitation flow › declined
// spec: add-debates › Debate invitation flow › expired
it('keeps a settled consent status when a later turn has started', () => {
  expect(visibleStatus('running')).toBe('accepted');
  expect(visibleStatus('completed')).toBe('accepted');
  expect(visibleStatus('declined')).toBe('declined');
  expect(visibleStatus('expired')).toBe('expired');
});
