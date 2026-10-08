import type { RendererApi } from '../shared/ipc'

declare global {
  interface Window {
    api: RendererApi
    /** Electron webUtils.getPathForFile 桥（拖拽取真实路径，双平台） */
    getPathForFile: (file: File) => string
  }
}

export {}
