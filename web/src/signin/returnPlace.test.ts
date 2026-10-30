// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { rememberReturnPlace, takeReturnPlace } from './returnPlace';

describe('return place', () => {
  beforeEach(() => sessionStorage.clear());

  it('hands the remembered place back once', () => {
    rememberReturnPlace('/__day1');
    expect(takeReturnPlace()).toEqual({ path: '/__day1' });
    expect(takeReturnPlace()).toBeNull();
  });

  it('is empty when nothing was remembered', () => {
    expect(takeReturnPlace()).toBeNull();
  });

  // spec: add-pet › Birth flow › пришёл по ссылке друга × вход на Hatch screen с адресом друга
  it('keeps the query of the place and the action that began the sign-in', () => {
    rememberReturnPlace({ path: '/hatch?from=2', action: 'signin' });
    expect(takeReturnPlace()).toEqual({ path: '/hatch?from=2', action: 'signin' });
    rememberReturnPlace({ path: '/pet/2', action: 'feed' });
    expect(takeReturnPlace()).toEqual({ path: '/pet/2', action: 'feed' });
  });

  it('ignores a record that is not a place of this app', () => {
    sessionStorage.setItem('nearling.returnPlace', JSON.stringify({ path: 'https://evil.example' }));
    expect(takeReturnPlace()).toBeNull();
    sessionStorage.setItem('nearling.returnPlace', 'not json');
    expect(takeReturnPlace()).toBeNull();
  });
});
