import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentTypeFor, resolveBundlePath } from '../../src/main/security/bundle-path';

const root = path.resolve('/synthetic/app/dist/renderer');

describe('resolveBundlePath', () => {
  it('maps the root and nested files inside the bundle', () => {
    expect(resolveBundlePath(root, 'app://bundle/')).toBe(path.join(root, 'index.html'));
    expect(resolveBundlePath(root, 'app://bundle/index.html')).toBe(path.join(root, 'index.html'));
    expect(resolveBundlePath(root, 'app://bundle/assets/main-1.js?v=1#x')).toBe(
      path.join(root, 'assets', 'main-1.js'),
    );
  });

  it.each([
    'app://bundle/../package.json',
    'app://bundle/%2e%2e/package.json',
    'app://bundle/%2E%2E%2Fpackage.json',
    'app://bundle/assets/..%2f..%2fpackage.json',
    'app://bundle/..%5c..%5cpackage.json',
    'app://bundle/assets%5c..%5c..%5cpackage.json',
    'app://bundle/C:/Windows/win.ini',
    'app://bundle/C:%5cWindows%5cwin.ini',
    'app://bundle/%5c%5cserver%5cshare%5cx.js',
    'app://bundle//server/share/x.js',
    'app://bundle/index.html%00.js',
    'app://bundle/CON',
    'app://bundle/assets/nul.js',
    'app://bundle/assets/com1.txt',
    'app://bundle/index.html:stream',
    'app://bundle/index.html.',
    'app://bundle/index.html ',
    'app://bundle/%',
    'app://other/index.html',
    'https://bundle/index.html',
    'file:///C:/Windows/win.ini',
  ])('rejects %s', (url) => {
    expect(resolveBundlePath(root, url)).toBeNull();
  });

  it('serves only an allowlisted set of static types', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('a.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('a.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('a.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('a.woff2')).toBe('font/woff2');
    expect(contentTypeFor('a.exe')).toBeNull();
    expect(contentTypeFor('a.node')).toBeNull();
    expect(contentTypeFor('noext')).toBeNull();
  });
});
