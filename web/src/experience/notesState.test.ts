import { describe, expect, it } from 'vitest';
import { acceptsNotes, publishableNotes } from './notesState';
import type { ExperienceNotes } from '../seams/worker-types';

const view: ExperienceNotes = { tokenId: '9', generation: 3, field: null, notes: [
  { id: 'a', text: 'A', proposedField: 'Worked on trains', sourceReportId: 'a', at: 1, approved: true },
  { id: 'b', text: 'B', proposedField: 'Worked on fares', sourceReportId: 'b', at: 2, approved: false },
] };

describe('owner note state', () => {
  // spec: add-pet-experience › Experience notes screen › loading × fresh read completes
  it('discards a late response for another pet or transfer generation', () => {
    expect(acceptsNotes(view, '9', 3)).toBe(true);
    expect(acceptsNotes(view, '9', 4)).toBe(false);
    expect(acceptsNotes(view, '10', null)).toBe(false);
  });

  // spec: add-pet-experience › Experience notes screen › success
  it('offers publication only for retained approved notes', () => {
    expect(publishableNotes(view).map((note) => note.id)).toEqual(['a']);
    expect(publishableNotes({ ...view, notes: view.notes.map((note) => ({ ...note, approved: false })) })).toEqual([]);
    expect(publishableNotes(null)).toEqual([]);
  });
});
