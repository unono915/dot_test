import type { Session, WebContents } from 'electron';
import { isAllowedRequestUrl, isAppBundleUrl } from './origin.js';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Every webContents (including ones we did not expect) may only show the local bundle. */
export function hardenWebContents(contents: WebContents): void {
  // No WebRTC UDP outside a proxy (CSP and webRequest do not cover STUN/ICE).
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  const blockForeign = (event: { url: string; preventDefault(): void }) => {
    if (!isAppBundleUrl(event.url)) event.preventDefault();
  };
  contents.on('will-navigate', blockForeign);
  contents.on('will-frame-navigate', blockForeign);
  contents.on('will-redirect', blockForeign);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

const hardenedSessions = new WeakSet<Session>();

/** Denies permissions, downloads and every request that is not for the local bundle. */
export function hardenSession(ses: Session): void {
  if (hardenedSessions.has(ses)) return;
  hardenedSessions.add(ses);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  ses.on('will-download', (event) => event.preventDefault());
  // Chromium fetches Hunspell dictionaries from a Google CDN outside webRequest; keep it off.
  ses.setSpellCheckerEnabled(false);
  ses.setSpellCheckerLanguages([]);
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequestUrl(details.url) && !details.url.startsWith('devtools://') });
  });
}
