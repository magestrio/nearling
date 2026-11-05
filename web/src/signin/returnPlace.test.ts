// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearReturnPlace,
  eraseLeftBehind,
  fromOf,
  holdReturnSheet,
  holdReturnText,
  peekReturnPlace,
  rememberReturnPlace,
  takeReturnPlace,
  takeReturnSheet,
  takeReturnText,
} from './returnPlace';

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

describe('the record of a sign-in', () => {
  beforeEach(() => sessionStorage.clear());

  // spec: add-account › Sign-in return data › вход со ссылки подарка
  it('keeps the place, the action and the typed text, and the mark of a cancel', () => {
    rememberReturnPlace({ path: '/gift/abc', action: 'signin', text: 'And if they ask why?' });
    expect(takeReturnPlace()).toEqual({ path: '/gift/abc', action: 'signin', text: 'And if they ask why?' });
    rememberReturnPlace({ path: '/pet/2', action: 'feed', cancelled: true });
    expect(takeReturnPlace()).toEqual({ path: '/pet/2', action: 'feed', cancelled: true });
  });

  it('stores and takes a shared errand URL and Feed action in this tab', () => {
    rememberReturnPlace({ path: '/pet/9/errand/abc123', action: 'feed' });
    expect(peekReturnPlace()).toEqual({ path: '/pet/9/errand/abc123', action: 'feed' });
    expect(takeReturnPlace()).toEqual({ path: '/pet/9/errand/abc123', action: 'feed' });
    expect(peekReturnPlace()).toBeNull();
  });

  // spec: add-account › Sign-in return data › вход со ссылки подарка × перезагрузка на главной
  it('is taken once: a reload at `/` after the return finds nothing', () => {
    rememberReturnPlace({ path: '/pet/2', action: 'signin' });
    expect(peekReturnPlace()).toEqual({ path: '/pet/2', action: 'signin' });
    expect(takeReturnPlace()).toEqual({ path: '/pet/2', action: 'signin' });
    expect(peekReturnPlace()).toBeNull();
    expect(takeReturnPlace()).toBeNull();
  });

  // spec: add-account › Session expiry flow › typed text after sign-in
  it('gives the text back once, to the screen at the path it was held for', () => {
    holdReturnText('/pet/9', 'And if they ask why the chart matters?');
    expect(takeReturnText('/pet/9')).toBe('And if they ask why the chart matters?');
    expect(takeReturnText('/pet/9')).toBeNull();
  });

  // spec: add-account › Session expiry flow › typed text after sign-in × нет такого поля на экране
  it('does not give it to another path, and a new record drops what was held', () => {
    holdReturnText('/pet/9', 'draft');
    expect(takeReturnText('/pet/2')).toBeNull();
    expect(takeReturnText('/pet/9')).toBe('draft');
    holdReturnText('/pet/9', 'draft');
    rememberReturnPlace('/pet/2');
    expect(takeReturnText('/pet/9')).toBeNull();
  });

  // spec: add-account › Session expiry flow › typed text after sign-in × запись без возврата
  it('erases a record a sign-in left behind, with its text, at the next start on another address', () => {
    rememberReturnPlace({ path: '/pet/9', action: 'signin', text: 'draft' });
    eraseLeftBehind('/pet/2');
    expect(peekReturnPlace()).toBeNull();
    // the same address, no cancel: it came back by no sign-in either
    rememberReturnPlace({ path: '/pet/9', action: 'signin', text: 'draft' });
    eraseLeftBehind('/pet/9');
    expect(peekReturnPlace()).toBeNull();
  });

  // spec: add-account › Sign-in flow › отменил вход
  it('keeps the record of a cancel for its own address, which a Back from Google needs', () => {
    rememberReturnPlace({ path: '/pet/9', action: 'feed', cancelled: true });
    eraseLeftBehind('/pet/9');
    expect(peekReturnPlace()).toEqual({ path: '/pet/9', action: 'feed', cancelled: true });
    eraseLeftBehind('/pet/2');
    expect(peekReturnPlace()).toBeNull();
  });

  // spec: add-account › Sign-out flow › вышел × стирает текст во вкладке
  it('is cleared with its text and with the text held in memory', () => {
    rememberReturnPlace({ path: '/pet/9', action: 'signin', text: 'draft' });
    holdReturnText('/pet/9', 'draft');
    clearReturnPlace();
    expect(peekReturnPlace()).toBeNull();
    expect(takeReturnText('/pet/9')).toBeNull();
  });

  // spec: add-account › Sign-in flow › вход начат
  it.each([
    ['/pet/2', 'link'],
    ['/pet/2?from=9', 'link'],
    ['/gift/abc', 'link'],
    ['/hatch', 'home'],
    ['/', 'home'],
  ] as const)('says %s is from a %s', (path, from) => {
    expect(fromOf(path)).toBe(from);
  });
});

describe('the fields of the sheets of the errands', () => {
  beforeEach(() => sessionStorage.clear());

  // spec: add-pet-errands › Errand sheet screen › success × the return place
  it('keeps the action of an Errand, Adapter and Skill code sheet in the record, and hands their fields back once to the path', () => {
    for (const [action, fields] of [
      ['errand', { form: 'find', job: 'When do the Leonids peak?' }],
      ['adapter', { label: 'Daybook', address: 'https://mcp.example.com/daybook' }],
      ['adapter', { label: 'Daybook', address: '', sid: 'a1b2c3d4e5f60718293a4b5c' }],
      ['code', { code: 'export const x = 1;', fn: 'openerFor', values: '11, 3' }],
    ] as const) {
      const text = JSON.stringify(fields);
      rememberReturnPlace({ path: '/pet/9', action, text });
      const place = takeReturnPlace();
      expect(place).toEqual({ path: '/pet/9', action, text });
      holdReturnSheet(action, '/pet/9', place!.text!);
      expect(takeReturnSheet(action, '/pet/2')).toBeNull();
      expect(takeReturnSheet(action, '/pet/9')).toEqual(fields);
      expect(takeReturnSheet(action, '/pet/9')).toBeNull();
    }
  });

  // spec: add-pet-errands › Errand sheet screen › success × the return place
  it('drops a record whose text is not that sheet\'s fields, and a cancel keeps the action but not the text', () => {
    holdReturnSheet('errand', '/pet/9', JSON.stringify({ form: 'poem', job: 'x' }));
    holdReturnSheet('errand', '/pet/9', 'not json');
    expect(takeReturnSheet('errand', '/pet/9')).toBeNull();
    holdReturnSheet('code', '/pet/9', JSON.stringify({ code: 'x' }));
    expect(takeReturnSheet('code', '/pet/9')).toBeNull();
    rememberReturnPlace({ path: '/pet/9', action: 'errand', cancelled: true });
    expect(takeReturnPlace()).toEqual({ path: '/pet/9', action: 'errand', cancelled: true });
  });

  // spec: add-pet-errands › Errand sheet screen › success × the return place
  it('is cleared with the fields held in memory: a new record, a sign-out', () => {
    holdReturnSheet('errand', '/pet/9', JSON.stringify({ form: 'read', job: 'https://example.com/dreams' }));
    rememberReturnPlace('/pet/2');
    expect(takeReturnSheet('errand', '/pet/9')).toBeNull();
    holdReturnSheet('adapter', '/pet/9', JSON.stringify({ label: 'A', address: 'b' }));
    clearReturnPlace();
    expect(takeReturnSheet('adapter', '/pet/9')).toBeNull();
  });
});
