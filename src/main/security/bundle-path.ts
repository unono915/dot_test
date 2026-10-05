import path from 'node:path';
import { isAppBundleUrl } from './origin.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Windows reserved device names are rejected regardless of extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

export function contentTypeFor(fileName: string): string | null {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? null;
}

/**
 * Maps an app://bundle URL to a file strictly inside `bundleRoot`.
 * Only plain relative segments are accepted; anything that could escape the root,
 * name a device/stream, or be normalised differently by Windows yields null.
 */
export function resolveBundlePath(bundleRoot: string, requestUrl: string): string | null {
  if (!isAppBundleUrl(requestUrl) || requestUrl !== requestUrl.trim()) return null;
  // Reject traversal spellings before the URL parser silently normalises them away.
  if (/\/\.|%2e|%5c|%2f|%00|\\/i.test(requestUrl)) return null;
  const rawPath = new URL(requestUrl).pathname;
  if (rawPath.includes('%') || rawPath.includes('\\') || rawPath.includes('//')) return null;
  const relative = rawPath === '/' ? 'index.html' : rawPath.slice(1);
  const segments = relative.split('/');
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment.endsWith('.') || RESERVED.test(segment)) return null;
  }
  if (contentTypeFor(segments[segments.length - 1]!) === null) return null;
  const root = path.resolve(bundleRoot);
  const resolved = path.resolve(root, ...segments);
  if (path.relative(root, resolved).startsWith('..') || !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}
