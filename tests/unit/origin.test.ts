import { describe, expect, it } from 'vitest';
import { APP_ORIGIN, isAppBundleUrl, isAllowedRequestUrl } from '../../src/main/security/origin';

describe('app://bundle origin', () => {
  it('is the only trusted origin', () => {
    expect(APP_ORIGIN).toBe('app://bundle');
  });

  it.each([
    'app://bundle/index.html',
    'app://bundle/assets/index-abc.js',
    'APP://BUNDLE/index.html',
  ])('accepts %s', (url) => {
    expect(isAppBundleUrl(url)).toBe(true);
  });

  it.each([
    'app://bundle.evil/index.html',
    'app://other/index.html',
    'app://user@bundle/index.html',
    'app://bundle:8080/index.html',
    'https://bundle/index.html',
    'file:///C:/Windows/System32/cmd.exe',
    'data:text/html,<p>x</p>',
    'blob:app://bundle/1234',
    'about:blank',
    'javascript:alert(1)',
    'devtools://devtools/bundled/inspector.html',
    'http://127.0.0.1:3000/',
    '',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isAppBundleUrl(url)).toBe(false);
  });

  it('allows only bundle requests through the network filter', () => {
    expect(isAllowedRequestUrl('app://bundle/index.html')).toBe(true);
    expect(isAllowedRequestUrl('https://example.com/')).toBe(false);
    expect(isAllowedRequestUrl('http://localhost:5173/')).toBe(false);
    expect(isAllowedRequestUrl('ws://127.0.0.1:9/')).toBe(false);
    expect(isAllowedRequestUrl('file:///C:/data.sqlite')).toBe(false);
    expect(isAllowedRequestUrl('ftp://example.com/')).toBe(false);
  });
});
