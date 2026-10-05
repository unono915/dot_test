// Sandboxed preload: may only require 'electron'. Exposes a frozen, named command set;
// never ipcRenderer itself, raw channels, Node APIs, SQL, paths or shell access.
import { contextBridge, ipcRenderer } from 'electron';

const api = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke('app:get-info', {}),
});

contextBridge.exposeInMainWorld('schoolAsset', api);
