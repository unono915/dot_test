// Named, allowlisted IPC commands. Each channel declares how its request payload is validated.
// There is deliberately no generic channel for SQL, file paths, shell or raw IPC.

export const IPC_CHANNELS = {
  getAppInfo: 'app:get-info',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  sqlite: string;
}

export interface IpcRequestMap {
  'app:get-info': Record<string, never>;
}

export interface IpcResponseMap {
  'app:get-info': AppInfo;
}

export type IpcErrorCode = 'FORBIDDEN' | 'UNKNOWN_CHANNEL' | 'INVALID_REQUEST' | 'INTERNAL';

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: IpcErrorCode; message: string; errorId?: string } };

/** Upper bound for any serialized request, checked before schema validation. */
export const MAX_REQUEST_BYTES = 256 * 1024;

type Validator = (payload: unknown) => boolean;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The payload must be a plain object whose key set equals `required` exactly. */
function exactKeys(required: readonly string[]): Validator {
  return (payload) => {
    if (!isPlainObject(payload)) return false;
    const keys = Object.keys(payload);
    return keys.length === required.length && required.every((k) => Object.prototype.hasOwnProperty.call(payload, k));
  };
}

export const REQUEST_VALIDATORS: Record<IpcChannel, Validator> = {
  'app:get-info': exactKeys([]),
};

export function isIpcChannel(channel: string): channel is IpcChannel {
  return Object.prototype.hasOwnProperty.call(REQUEST_VALIDATORS, channel);
}
