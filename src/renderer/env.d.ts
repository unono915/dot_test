import type { AppInfo, IpcResult } from '../main/ipc/contract';

declare global {
  interface Window {
    readonly schoolAsset: {
      getAppInfo(): Promise<IpcResult<AppInfo>>;
    };
  }
}

export {};
