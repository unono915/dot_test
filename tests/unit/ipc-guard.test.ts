import { describe, expect, it, vi } from 'vitest';
import { TrustedSenders, checkSender, type IpcEventLike } from '../../src/main/security/ipc-guard';
import { createIpcRouter } from '../../src/main/ipc/router';
import { IPC_CHANNELS } from '../../src/main/ipc/contract';

function frame(url: string, opts: { processId?: number; routingId?: number; top?: boolean } = {}) {
  const f: { url: string; processId: number; routingId: number; parent: unknown } = {
    url,
    processId: opts.processId ?? 7,
    routingId: opts.routingId ?? 1,
    parent: null,
  };
  if (opts.top === false) f.parent = { url: 'app://bundle/index.html' };
  return f;
}

function event(id: number, senderFrame: ReturnType<typeof frame> | null, mainFrame = frame('app://bundle/index.html')): IpcEventLike {
  return { sender: { id, mainFrame }, senderFrame };
}

describe('checkSender', () => {
  const trusted = new TrustedSenders();
  trusted.register(1);

  it('accepts the registered main frame on the bundle origin', () => {
    expect(checkSender(event(1, frame('app://bundle/index.html')), trusted)).toEqual({ ok: true });
  });

  it('rejects an unregistered webContents', () => {
    expect(checkSender(event(2, frame('app://bundle/index.html')), trusted)).toMatchObject({ ok: false, reason: 'unregistered-sender' });
  });

  it('rejects a destroyed or missing frame', () => {
    expect(checkSender(event(1, null), trusted)).toMatchObject({ ok: false, reason: 'missing-frame' });
  });

  it('rejects subframes even on the bundle origin', () => {
    const sub = frame('app://bundle/index.html', { routingId: 9, top: false });
    expect(checkSender(event(1, sub), trusted)).toMatchObject({ ok: false, reason: 'not-main-frame' });
  });

  it('rejects a main frame that is not the sender main frame', () => {
    const other = frame('app://bundle/index.html', { routingId: 2 });
    expect(checkSender(event(1, other), trusted)).toMatchObject({ ok: false, reason: 'not-main-frame' });
  });

  it.each(['https://example.com/', 'file:///C:/x.html', 'data:text/html,x', 'app://other/index.html', 'about:blank'])(
    'rejects foreign origin %s',
    (url) => {
      const f = frame(url);
      expect(checkSender(event(1, f, f), trusted)).toMatchObject({ ok: false, reason: 'untrusted-origin' });
    },
  );

  it('forgets unregistered senders', () => {
    const t = new TrustedSenders();
    t.register(5);
    t.unregister(5);
    expect(checkSender(event(5, frame('app://bundle/index.html')), t)).toMatchObject({ ok: false });
  });
});

describe('IPC router', () => {
  const trusted = new TrustedSenders();
  trusted.register(1);
  const okEvent = () => event(1, frame('app://bundle/index.html'));

  const info = { name: '학교 정보자산 관리', version: '0.1.0', electron: '44.5.1', sqlite: '3.53.4' };

  function router(handler: () => Promise<typeof info> = vi.fn(async () => info)) {
    return { handler, route: createIpcRouter({ trusted, handlers: { [IPC_CHANNELS.getAppInfo]: handler } }) };
  }

  it('exposes only the narrow allowlisted channel set', () => {
    expect(Object.values(IPC_CHANNELS)).toEqual(['app:get-info']);
  });

  it('dispatches a valid request from a trusted sender', async () => {
    const { route, handler } = router();
    await expect(route(IPC_CHANNELS.getAppInfo, okEvent(), {})).resolves.toEqual({ ok: true, data: info });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('never runs the handler for an untrusted sender', async () => {
    const { route, handler } = router();
    const res = await route(IPC_CHANNELS.getAppInfo, event(2, frame('app://bundle/index.html')), {});
    expect(res).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: '허용되지 않은 요청입니다.' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown channel', 'db:exec', {}],
    ['shell channel', 'shell:open', { path: 'C:\\Windows\\System32\\cmd.exe' }],
  ])('rejects %s', async (_label, channel, payload) => {
    const { route, handler } = router();
    const res = await route(channel, okEvent(), payload);
    expect(res).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['extra key (raw SQL)', { sql: 'DROP TABLE asset' }],
    ['extra key (path)', { path: '..\\..\\secret' }],
    ['null', null],
    ['array', []],
    ['string', 'SELECT 1'],
    ['undefined', undefined],
    ['number', 1],
  ])('rejects malformed payload: %s', async (_label, payload) => {
    const { route, handler } = router();
    const res = await route(IPC_CHANNELS.getAppInfo, okEvent(), payload);
    expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects oversized payloads before validation', async () => {
    const { route, handler } = router();
    const res = await route(IPC_CHANNELS.getAppInfo, okEvent(), { x: 'a'.repeat(300_000) });
    expect(res).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('hides internal error details (SQL, paths, stacks)', async () => {
    const failing = vi.fn(async (): Promise<typeof info> => {
      throw new Error('SQLITE_ERROR near "DROP": C:\\Users\\someone\\data.sqlite');
    });
    const { route } = router(failing);
    const res = await route(IPC_CHANNELS.getAppInfo, okEvent(), {});
    expect(res.ok).toBe(false);
    const text = JSON.stringify(res);
    expect(text).not.toMatch(/SQLITE|DROP|Users|\\\\|stack|at /);
    expect(res).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  });
});
