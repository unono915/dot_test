// The only origin allowed to render UI or call IPC. Bundled files are served by our own
// protocol handler; nothing is loaded from disk paths, dev servers or the network.
export const APP_SCHEME = 'app';
export const APP_HOST = 'bundle';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isAppBundleUrl(url: string): boolean {
  const parsed = parse(url);
  return (
    parsed !== null &&
    parsed.protocol === `${APP_SCHEME}:` &&
    parsed.host.toLowerCase() === APP_HOST &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

/** Session-level network filter: the renderer may only fetch its own bundle. */
export function isAllowedRequestUrl(url: string): boolean {
  return isAppBundleUrl(url);
}
