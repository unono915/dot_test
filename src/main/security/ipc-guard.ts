import { isAppBundleUrl } from './origin.js';

// Structural subsets of Electron's IpcMainInvokeEvent so the guard is testable without Electron.
export interface FrameLike {
  readonly url: string;
  readonly processId: number;
  readonly routingId: number;
  readonly parent: unknown;
}

export interface IpcEventLike {
  readonly sender: { readonly id: number; readonly mainFrame: FrameLike };
  readonly senderFrame: FrameLike | null;
}

export type SenderCheck =
  | { ok: true }
  | { ok: false; reason: 'unregistered-sender' | 'missing-frame' | 'not-main-frame' | 'untrusted-origin' };

/** webContents IDs of windows the main process created for the app UI. */
export class TrustedSenders {
  readonly #ids = new Set<number>();

  register(id: number): void {
    this.#ids.add(id);
  }

  unregister(id: number): void {
    this.#ids.delete(id);
  }

  has(id: number): boolean {
    return this.#ids.has(id);
  }
}

export function checkSender(event: IpcEventLike, trusted: TrustedSenders): SenderCheck {
  if (!trusted.has(event.sender.id)) return { ok: false, reason: 'unregistered-sender' };
  const frame = event.senderFrame;
  if (!frame) return { ok: false, reason: 'missing-frame' };
  const main = event.sender.mainFrame;
  if (frame.parent !== null || frame.processId !== main.processId || frame.routingId !== main.routingId) {
    return { ok: false, reason: 'not-main-frame' };
  }
  if (!isAppBundleUrl(frame.url)) return { ok: false, reason: 'untrusted-origin' };
  return { ok: true };
}
