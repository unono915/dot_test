import { randomUUID } from 'node:crypto';
import { checkSender, type IpcEventLike, type TrustedSenders } from '../security/ipc-guard.js';
import {
  MAX_REQUEST_BYTES,
  REQUEST_VALIDATORS,
  isIpcChannel,
  type IpcChannel,
  type IpcRequestMap,
  type IpcResponseMap,
  type IpcResult,
} from './contract.js';

export type IpcHandlers = {
  [C in IpcChannel]: (request: IpcRequestMap[C]) => Promise<IpcResponseMap[C]>;
};

export interface RouterOptions {
  trusted: TrustedSenders;
  handlers: IpcHandlers;
  /** Receives full internal errors for the local diagnostic log; never sent to the renderer. */
  onInternalError?: (errorId: string, channel: IpcChannel, error: unknown) => void;
}

const FORBIDDEN = { ok: false, error: { code: 'FORBIDDEN', message: '허용되지 않은 요청입니다.' } } as const;

function serializedSize(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function createIpcRouter(options: RouterOptions) {
  return async function route(channel: string, event: IpcEventLike, payload: unknown): Promise<IpcResult<unknown>> {
    if (!checkSender(event, options.trusted).ok) return FORBIDDEN;
    if (!isIpcChannel(channel)) {
      return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: '지원하지 않는 요청입니다.' } };
    }
    if (serializedSize(payload) > MAX_REQUEST_BYTES || !REQUEST_VALIDATORS[channel](payload)) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: '요청 형식이 올바르지 않습니다.' } };
    }
    try {
      const handler = options.handlers[channel] as (request: unknown) => Promise<unknown>;
      return { ok: true, data: await handler(payload) };
    } catch (error) {
      const errorId = randomUUID();
      options.onInternalError?.(errorId, channel, error);
      return {
        ok: false,
        error: { code: 'INTERNAL', message: '작업을 완료하지 못했습니다. 작업 ID를 확인한 뒤 다시 시도해 주세요.', errorId },
      };
    }
  };
}
