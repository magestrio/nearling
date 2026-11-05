// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearJudgeCode, JUDGE_EXPIRES_AT, keepJudgeCode, readJudgeCode } from './judgeCode';

beforeEach(() => { sessionStorage.clear(); vi.useRealTimers(); });

describe('same-tab judge bearer', () => {
  // spec: add-showcase › Judge code sheet screen › success × Google redirect/reload/tab hidden
  it('stays in this tab through a reload and a visibility change, without a URL value', () => {
    vi.useFakeTimers();
    vi.setSystemTime(JUDGE_EXPIRES_AT - 1_000);
    keepJudgeCode('sample-private-code');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(readJudgeCode()).toBe('sample-private-code');
    expect(window.location.href).not.toContain('sample-private-code');
  });

  // spec: add-showcase › Judge code sheet screen › success × close/sign-out/session expiry/Google success/refusal/cancel
  it('can be erased on every exit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(JUDGE_EXPIRES_AT - 1_000);
    keepJudgeCode('sample-private-code');
    clearJudgeCode();
    expect(readJudgeCode()).toBeNull();
  });

  // spec: add-showcase › Judge code sheet screen › success × 2026-11-19 expiry
  it('erases an expired code on read and refuses to keep one after expiry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(JUDGE_EXPIRES_AT - 1_000);
    keepJudgeCode('sample-private-code');
    vi.setSystemTime(JUDGE_EXPIRES_AT);
    expect(readJudgeCode()).toBeNull();
    expect(sessionStorage.length).toBe(0);
    keepJudgeCode('another');
    expect(sessionStorage.length).toBe(0);
  });

  // spec: add-showcase › Judge code sheet screen › success × site-data erased
  it('does not reconstruct a bearer after site data is erased', () => {
    vi.useFakeTimers();
    vi.setSystemTime(JUDGE_EXPIRES_AT - 1_000);
    keepJudgeCode('sample-private-code');
    sessionStorage.clear();
    expect(readJudgeCode()).toBeNull();
  });
});
