import { expect, it } from 'vitest';
import { sampleDiary } from '../seams/diary.sample';
import { entryDraw, partLines, riddleDraw, streakDraw } from './diaryView';
import { withoutSocial } from './useDiary';

// spec: add-pet-society › Society diary flow › named social line
it('puts bounded pet-authored relationship lines after the question', () => {
  const diary = sampleDiary();
  if (diary.entry.kind !== 'text') throw new Error('sample entry');
  const entry = entryDraw({ ...diary.entry, socialLines: ['I think Biscuit and I are getting closer.', 'Sage and I had a rough day.', 'Third.', 'Fourth.'] }, 'Pixel', diary.until);
  expect(entry.kind === 'text' && entry.social).toEqual(['I think Biscuit and I are getting closer.', 'Sage and I had a rough day.', 'Third.']);
  expect(partLines(streakDraw(diary), entry, riddleDraw(diary), null, null)).not.toContain('Fourth.');
});

// spec: add-pet-society › Society diary flow › settled gossip
it('shows a settled gossip line without adding an empty society section', () => {
  const diary = sampleDiary();
  if (diary.entry.kind !== 'text') throw new Error('sample entry');
  expect(entryDraw({ ...diary.entry, socialLines: ['I have a story about helping Nori yesterday.'] }, 'Pixel', diary.until)).toMatchObject({ social: ['I have a story about helping Nori yesterday.'] });
  expect(entryDraw({ ...diary.entry, socialLines: [] }, 'Pixel', diary.until)).not.toHaveProperty('social');
});

// spec: add-pet-society › Society ownership flow › gift confirmed × visibility return
it('removes private social words from the retained view before a fresh owner read', () => {
  const diary = sampleDiary();
  if (diary.entry.kind !== 'text') throw new Error('sample entry');
  const ready = { kind: 'ready' as const, diary: { ...diary, entry: { ...diary.entry, socialLines: ['Only this owner'] } } };
  expect(withoutSocial(ready)).toMatchObject({ diary: { entry: { socialLines: [] } } });
  expect(ready.diary.entry.socialLines).toEqual(['Only this owner']);
});
