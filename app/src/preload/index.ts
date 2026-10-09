/**
 * Preload：以 contextBridge 暴露类型安全的 RendererApi
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { CH, type RendererApi, type CorrectRequest, type MoveRequest, type AuthState, type ConsumeResult } from '../shared/ipc'
import type { AppSettings, ImageRecord } from '../shared/types'
import type { ExportOptions } from '../main/services/exporter'

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: RendererApi = {
  bootstrap: () => ipcRenderer.invoke(CH.appBootstrap),
  pickFolder: () => ipcRenderer.invoke(CH.pickFolder),
  pickImages: () => ipcRenderer.invoke(CH.pickImages),
  importPaths: (paths: string[]) => ipcRenderer.invoke(CH.importPaths, paths),
  importCancel: () => ipcRenderer.invoke(CH.importCancel),
  listImages: (filter) => ipcRenderer.invoke(CH.listImages, filter),
  getImage: (id: number) => ipcRenderer.invoke(CH.imageGet, id),
  categoryCounts: () => ipcRenderer.invoke(CH.categoryCounts),
  moveImages: (req: MoveRequest) => ipcRenderer.invoke(CH.moveImages, req),
  restoreImages: (snapshots: ImageRecord[]) => ipcRenderer.invoke(CH.restoreImages, snapshots),
  reorderImages: (ids: number[]) => ipcRenderer.invoke(CH.reorderImages, ids),
  deleteImages: (ids: number[]) => ipcRenderer.invoke(CH.deleteImages, ids),
  correctImage: (req: CorrectRequest) => ipcRenderer.invoke(CH.correctImage, req),
  customList: () => ipcRenderer.invoke(CH.customList),
  customAdd: (name: string) => ipcRenderer.invoke(CH.customAdd, name),
  customRemove: (id: number) => ipcRenderer.invoke(CH.customRemove, id),
  getSettings: () => ipcRenderer.invoke(CH.settingsGet),
  saveSettings: (s: Partial<AppSettings>) => ipcRenderer.invoke(CH.settingsSave, s),
  scanStart: () => ipcRenderer.invoke(CH.scanStart),
  scanStop: () => ipcRenderer.invoke(CH.scanStop),
  scanRescanAll: () => ipcRenderer.invoke(CH.scanRescanAll),
  reclassify: () => ipcRenderer.invoke(CH.reclassify),
  exportPreview: (opts: ExportOptions) => ipcRenderer.invoke(CH.exportPreview, opts),
  exportRun: (opts: ExportOptions) => ipcRenderer.invoke(CH.exportRun, opts),
  exportCancel: () => ipcRenderer.invoke(CH.exportCancel),
  engineStatus: () => ipcRenderer.invoke(CH.engineStatus),
  tuneNow: () => ipcRenderer.invoke(CH.tuneNow),
  tuneReset: () => ipcRenderer.invoke(CH.tuneReset),
  tuneStats: () => ipcRenderer.invoke(CH.tuneStats),
  fileUrl: (p: string) => Promise.resolve('localfile://x/' + encodeURIComponent(p)),
  revealInFolder: (p: string) => ipcRenderer.invoke(CH.revealInFolder, p),
  authBootstrap: () => ipcRenderer.invoke(CH.authBootstrap),
  authSendCaptcha: (req) => ipcRenderer.invoke(CH.authSendCaptcha, req),
  authRegister: (req) => ipcRenderer.invoke(CH.authRegister, req),
  authLogin: (account: string, password: string) => ipcRenderer.invoke(CH.authLogin, account, password),
  authLogout: () => ipcRenderer.invoke(CH.authLogout),
  authMe: () => ipcRenderer.invoke(CH.authMe),
  plansList: () => ipcRenderer.invoke(CH.plansList),
  orderCreate: (t: string, id: string) => ipcRenderer.invoke(CH.orderCreate, t, id),
  sysConfig: () => ipcRenderer.invoke(CH.sysConfig),
  consumePoints: (count: number) => ipcRenderer.invoke(CH.consumePoints, count),
  checkUpdate: () => ipcRenderer.invoke(CH.checkUpdate),
  openExternal: (url: string) => ipcRenderer.invoke(CH.openExternal, url),
  libraryClear: () => ipcRenderer.invoke(CH.libraryClear),
  cacheClear: () => ipcRenderer.invoke(CH.cacheClear),
  bigPreview: (id: number) => ipcRenderer.invoke(CH.bigPreview, id),
  onScanProgress: (cb) => sub(CH.E_scanProgress, cb),
  onThumbsProgress: (cb) => sub<{ done: number; total: number } | null>(CH.E_thumbsProgress, cb),
  onScanImage: (cb) => sub(CH.E_scanImage, cb),
  onImportProgress: (cb) => sub(CH.E_importProgress, cb),
  onExportProgress: (cb) => sub(CH.E_exportProgress, cb),
  onThumbsReady: (cb) => sub<number>(CH.E_thumbsReady, cb),
  onAuthChanged: (cb) => {
    const listener = (_e: IpcRendererEvent, state: AuthState, consume?: ConsumeResult) => cb(state, consume)
    ipcRenderer.on(CH.E_authChanged, listener)
    return () => ipcRenderer.removeListener(CH.E_authChanged, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

// 拖拽文件 -> 真实路径（Electron 32+ 移除 File.path，用 webUtils）
contextBridge.exposeInMainWorld('getPathForFile', (file: File) => {
  try {
    return webUtils.getPathForFile(file)
  } catch {
    return ''
  }
})
