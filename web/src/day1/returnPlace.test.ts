// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { rememberReturnPlace, takeReturnPlace } from './returnPlace';

describe('return place', () => {
  beforeEach(() => sessionStorage.clear());

  it('hands the remembered place back once', () => {
    rememberReturnPlace('/__day1');
    expect(takeReturnPlace()).toBe('/__day1');
    expect(takeReturnPlace()).toBeNull();
  });

  it('is empty when nothing was remembered', () => {
    expect(takeReturnPlace()).toBeNull();
  });
});
