import { protocol } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { contentTypeFor, resolveBundlePath } from './security/bundle-path.js';
import { CONTENT_SECURITY_POLICY } from './security/harden.js';
import { APP_SCHEME } from './security/origin.js';

/** Must run before app `ready`. */
export function registerBundleScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export function handleBundleProtocol(bundleRoot: string): void {
  const root = path.resolve(bundleRoot);
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const file = resolveBundlePath(root, request.url);
    if (!file) return notFound();
    try {
      // Refuse links/junctions that point outside the bundle.
      const real = await fs.realpath(file);
      const realRoot = await fs.realpath(root);
      if (!real.startsWith(realRoot + path.sep)) return notFound();
      const contentType = contentTypeFor(file);
      if (contentType === null) return notFound();
      const body = await fs.readFile(real);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': contentType,
          'content-security-policy': CONTENT_SECURITY_POLICY,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return notFound();
    }
  });
}
