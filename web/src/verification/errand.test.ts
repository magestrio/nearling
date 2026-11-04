import { describe, expect, it } from 'vitest';
import type { PointerCall, ThoughtPointer } from './checkMachine';
import { errandCallTitle, errandForm, errandTime, reportCall, stoppedSearch } from './errand';

const thought = { kind: 'errand', form: 'find', searches: 2 } as ThoughtPointer;
const call = { n: 0, label: 'search', signature: 'signed', cut: false } as PointerCall;

describe('errand receipt labels', () => {
  // spec: add-verification › Verification flow › errand report
  it('uses the public form and search count; Read this has no count', () => {
    expect(errandForm(thought)).toBe('Find out');
    expect(errandTime(thought)).toBe('Find out · 2 searches');
    expect(errandTime({ ...thought, form: 'read', searches: 0 })).toBe('Read this');
    expect(['search', 'data', 'report', 'reask'].map((label) => errandCallTitle({ ...call, label })))
      .toEqual(['Web search', 'Looking up data', 'Report', 'Quick re-ask']);
    expect(reportCall(thought, call)).toBe(false);
    expect(reportCall(thought, { ...call, label: 'report' })).toBe(true);
  });

  // spec: add-verification › Verification flow › errand report with a cut search
  it('distinguishes an unsigned game stop from a signed cut-off', () => {
    expect(stoppedSearch({ ...call, signature: '', cut: true })).toBe(true);
    expect(stoppedSearch({ ...call, cut: true })).toBe(false);
    expect(stoppedSearch({ ...call, label: 'report', signature: '', cut: true })).toBe(false);
  });
});
