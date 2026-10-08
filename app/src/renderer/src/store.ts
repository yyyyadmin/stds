/**
 * 全局状态（zustand）
 * 覆盖：分类树与计数、当前视图图片、选择集（Shift/Ctrl 多选）、
 * 扫描进度事件流、一键修正、导出/设置对话框、视图模式快捷键 1-4
 */
import { create } from 'zustand'
import type { AppSettings, CategoryKey, ImageRecord } from '../../shared/types'
import { CAT_LIBRARY, CAT_REVIEW, CAT_TRASH, DIMENSION_LABELS, BAD_DIMENSIONS } from '../../shared/types'
import type { AuthState, BootstrapInfo, ConsumeResult, MoveRequest } from '../../shared/ipc'
import type { ScanProgress } from '../../main/services/scanner'
import type { ExportProgress } from '../../main/services/exporter'

export type SortKey = 'default' | 'name' | 'name-desc' | 'conf-asc' | 'conf-desc' | 'time'

interface StoreState {
  ready: boolean
  settings: AppSettings
  counts: Record<string, number>
  customCategories: Array<{ id: number; name: string }>
  activeCategory: CategoryKey | null
  images: ImageRecord[]
  viewMode: 'grid' | 'list' | 'masonry' | 'large'
  sortKey: SortKey
  selection: Set<number>
  anchorIndex: number
  previewId: number | null
  largeIndex: number
  scanProgress: ScanProgress | null
  importProgress: { done: number; total: number; current: string } | null
  exportProgress: ExportProgress | null
  showExport: boolean
  showSettings: boolean
  showLogin: boolean
  showMember: boolean
  auth: AuthState
  toast: { msg: string; kind: 'info' | 'error' | 'success' } | null
  engineBusy: boolean

  bootstrap(): Promise<void>
  setTheme(t: 'light' | 'dark'): Promise<void>
  toggleTheme(): Promise<void>
  openLogin(): void
  closeLogin(): void
  openMember(): void
  closeMember(): void
  doLogin(account: string, password: string): Promise<{ ok: boolean; message: string }>
  doRegister(req: { phone?: string; email?: string; password: string; code: string }): Promise<{ ok: boolean; message: string }>
  sendCaptcha(req: { phone?: string; email?: string; type: 'register' | 'login' | 'reset_password' }): Promise<{ ok: boolean; message: string }>
  doLogout(): Promise<void>
  refreshAuth(): Promise<void>
  openCategory(cat: CategoryKey | null): Promise<void>
  refreshCounts(): Promise<void>
  refreshImages(): Promise<void>
  setSort(k: SortKey): void
  setViewMode(m: 'grid' | 'list' | 'masonry' | 'large'): Promise<void>
  handleClickSelect(index: number, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void
  selectAll(): void
  selectNone(): void
  invertSelection(): void
  selectByCurrentCategoryAll(): void
  moveTo(cat: CategoryKey, physical?: boolean): Promise<void>
  moveToTrash(): Promise<void>
  restoreFromTrash(): Promise<void>
  correct(req: { action: 'correct' | 'wrong'; origDim: string | null; origConfidence: number | null; targetCategory?: CategoryKey }): Promise<void>
  openPreview(id: number): void
  closePreview(): void
  stepPreview(delta: number): void
  setLargeIndex(i: number): void
  stepLarge(delta: number): void
  startScan(): Promise<void>
  stopScan(): Promise<void>
  rescanAll(): Promise<void>
  saveSettings(patch: Partial<AppSettings>, reclassify?: boolean): Promise<void>
  addCustomCategory(name: string): Promise<void>
  removeCustomCategory(id: number): Promise<void>
  importPaths(paths: string[]): Promise<void>
  pickAndImport(): Promise<void>
  runExport(opts: Parameters<typeof window.api.exportRun>[0]): Promise<void>
  cancelExport(): Promise<void>
  dismissToast(): void
  bindEvents(): void
}

/** 排序 key：坏标签最高置信度（用于成品库内优先抽查低置信度） */
function sortConf(img: ImageRecord): number {
  const vals = Object.values(img.tags || {})
  if (!vals.length) return 1
  return Math.max(...vals.map((t) => t?.confidence ?? 0))
}

/** 应用主题到 <html data-theme> */
function applyTheme(t: 'light' | 'dark'): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', t)
    document.documentElement.style.colorScheme = t
  }
}

export const useStore = create<StoreState>((set, get) => ({
  ready: false,
  settings: {
    highThreshold: 0.9,
    midThreshold: 0.7,
    scene: 'default',
    enginePreference: 'auto',
    devicePreference: 'auto',
    autoTune: true,
    tunedThresholds: {},
    theme: 'light',
    viewMode: 'grid',
    lastExportDir: null,
    lastImportDir: null
  },
  counts: {},
  customCategories: [],
  activeCategory: null,
  images: [],
  viewMode: 'grid',
  sortKey: 'default',
  selection: new Set<number>(),
  anchorIndex: -1,
  previewId: null,
  largeIndex: 0,
  scanProgress: null,
  importProgress: null,
  exportProgress: null,
  showExport: false,
  showSettings: false,
  showLogin: false,
  showMember: false,
  auth: { loggedIn: false, token: null, user: null },
  toast: null,
  engineBusy: false,

  async bootstrap() {
    const info: BootstrapInfo = await window.api.bootstrap()
    applyTheme(info.settings.theme)
    set({
      ready: true,
      settings: info.settings,
      counts: info.counts,
      customCategories: info.customCategories,
      scanProgress: info.progress?.total != null || info.progress?.running ? info.progress : info.progress,
      viewMode: info.settings.viewMode,
      toast: info.engine.type === 'node' ? { msg: info.engine.message, kind: 'info' } : null
    })
    // 恢复登录态（不阻塞首屏）
    void window.api.authBootstrap().then((a) => set({ auth: a }))
    await get().openCategory(null)
    get().bindEvents()
  },

  async setTheme(t) {
    applyTheme(t)
    await get().saveSettings({ theme: t })
  },
  async toggleTheme() {
    const next = get().settings.theme === 'dark' ? 'light' : 'dark'
    await get().setTheme(next)
  },
  openLogin() {
    set({ showLogin: true })
  },
  closeLogin() {
    set({ showLogin: false })
  },
  openMember() {
    set({ showMember: true })
  },
  closeMember() {
    set({ showMember: false })
  },
  async doLogin(account, password) {
    const a = await window.api.authLogin(account, password)
    set({ auth: a })
    if (a.loggedIn) {
      set({ showLogin: false })
      return { ok: true, message: '登录成功' }
    }
    return { ok: false, message: '账号或密码错误' }
  },
  async doRegister(req) {
    const r = await window.api.authRegister(req)
    if (r.ok) set({ auth: await window.api.authMe() })
    return r
  },
  async sendCaptcha(req) {
    return window.api.authSendCaptcha(req)
  },
  async doLogout() {
    const a = await window.api.authLogout()
    set({ auth: a, showMember: false })
  },
  async refreshAuth() {
    set({ auth: await window.api.authMe() })
  },

  bindEvents() {
    window.api.onScanProgress((p) => {
      set({ scanProgress: p })
      if (!p.running && (p.phase === 'done' || p.phase === 'stopped')) {
        void get().refreshCounts()
        void get().refreshImages()
      }
    })
    window.api.onScanImage((img) => {
      const { activeCategory, images } = get()
      const next = [...images]
      const idx = next.findIndex((i) => i.id === img.id)
      if (idx >= 0) next[idx] = img
      else if (activeCategory == null || img.category === activeCategory) next.push(img)
      set({ images: next })
      // 节流刷新计数
      void get().refreshCounts()
    })
    window.api.onImportProgress((p) => set({ importProgress: p }))
    // 后台缩略图逐批就绪：节流刷新当前视图
    let thumbTimer: ReturnType<typeof setTimeout> | null = null
    window.api.onThumbsReady(() => {
      if (thumbTimer) return
      thumbTimer = setTimeout(() => {
        thumbTimer = null
        void get().refreshImages()
        void get().refreshCounts()
      }, 900)
    })
    // 登录态 / 积分变化（含筛选后自动扣费的不足提醒）
    window.api.onAuthChanged((state: AuthState, consume?: ConsumeResult) => {
      set({ auth: state })
      if (consume && consume.insufficient) {
        set({
          showMember: true,
          toast: { msg: `积分不足：本次需 ${consume.required ?? '?'} 分，当前 ${consume.balance ?? 0} 分，请充值或开通会员`, kind: 'error' }
        })
      } else if (consume && consume.ok && consume.consumed > 0) {
        set({ toast: { msg: `本次消耗 ${consume.consumed} 积分，剩余 ${consume.remaining ?? 0}`, kind: 'info' } })
      }
    })
    window.api.onExportProgress((p) => {
      set({ exportProgress: p })
      if (!p.running && p.finished) {
        set({
          toast: {
            msg: `成功导出 ${p.finished.success} 张，跳过 ${p.finished.skipped} 张${p.finished.failed ? `，失败 ${p.finished.failed} 张` : ''} → ${p.finished.target}`,
            kind: 'success'
          }
        })
      }
    })
  },

  async openCategory(cat) {
    set({ activeCategory: cat, selection: new Set(), anchorIndex: -1, largeIndex: 0 })
    const images = await window.api.listImages(cat ? { category: cat } : {})
    set({ images })
    await get().refreshCounts()
  },

  async refreshCounts() {
    set({ counts: await window.api.categoryCounts() })
  },

  async refreshImages() {
    const { activeCategory } = get()
    const images = await window.api.listImages(activeCategory ? { category: activeCategory } : {})
    set({ images })
  },

  setSort(k) {
    set({ sortKey: k })
  },

  async setViewMode(m) {
    set({ viewMode: m })
    await window.api.saveSettings({ viewMode: m })
  },

  handleClickSelect(index, e) {
    const { images, selection, anchorIndex } = get()
    const sel = new Set(selection)
    const img = images[index]
    if (!img) return
    if (e.shiftKey && anchorIndex >= 0) {
      const [a, b] = [Math.min(anchorIndex, index), Math.max(anchorIndex, index)]
      for (let i = a; i <= b; i++) sel.add(images[i].id)
    } else if (e.ctrlKey || e.metaKey) {
      if (sel.has(img.id)) sel.delete(img.id)
      else sel.add(img.id)
      set({ anchorIndex: index })
    } else {
      sel.clear()
      sel.add(img.id)
      set({ anchorIndex: index })
    }
    set({ selection: sel })
  },

  selectAll() {
    const sel = new Set(get().images.map((i) => i.id))
    set({ selection: sel })
  },
  selectNone() {
    set({ selection: new Set() })
  },
  invertSelection() {
    const sel = new Set<number>()
    for (const img of get().images) if (!get().selection.has(img.id)) sel.add(img.id)
    set({ selection: sel })
  },
  selectByCurrentCategoryAll() {
    get().selectAll()
  },

  async moveTo(cat, physical = false) {
    const { selection } = get()
    if (!selection.size) return
    const ids = [...selection]
    const req: MoveRequest = {
      ids,
      category: cat,
      physical,
      clearBadTags: cat === CAT_LIBRARY || !BAD_DIMENSIONS.includes(cat as never)
    }
    await window.api.moveImages(req)
    set({ selection: new Set() })
    await get().refreshImages()
    await get().refreshCounts()
    set({ toast: { msg: `已移动 ${ids.length} 张`, kind: 'success' } })
  },

  async moveToTrash() {
    await get().moveTo(CAT_TRASH)
  },

  async restoreFromTrash() {
    // 从垃圾桶移出 = 判定错误修正，回成品库
    const { selection } = get()
    if (!selection.size) return
    await window.api.moveImages({ ids: [...selection], category: CAT_LIBRARY, clearBadTags: true })
    set({ selection: new Set() })
    await get().refreshImages()
    await get().refreshCounts()
  },

  async correct(req) {
    const { previewId, images } = get()
    if (previewId == null) return
    const rec = images.find((i) => i.id === previewId)
    if (!rec) return
    const updated = await window.api.correctImage({
      imageId: rec.id,
      action: req.action,
      origDim: req.origDim,
      origConfidence: req.origConfidence,
      targetCategory: req.targetCategory
    })
    if (updated) {
      const next = [...images]
      const idx = next.findIndex((i) => i.id === updated.id)
      if (idx >= 0) next[idx] = updated
      set({ images: next })
      await get().refreshCounts()
    }
    if (req.action === 'correct') {
      set({ toast: { msg: '已确认判定正确，记录用于阈值微调', kind: 'success' } })
      // 预览层不关闭，自动看下一张（5.2）
      get().stepPreview(1)
    }
  },

  openPreview(id) {
    set({ previewId: id })
  },
  closePreview() {
    set({ previewId: null })
  },
  stepPreview(delta) {
    const { previewId, images } = get()
    if (previewId == null || !images.length) return
    const idx = images.findIndex((i) => i.id === previewId)
    const next = images[Math.min(images.length - 1, Math.max(0, idx + delta))]
    if (next) set({ previewId: next.id })
  },

  setLargeIndex(i) {
    const { images } = get()
    if (!images.length) return
    set({ largeIndex: Math.min(images.length - 1, Math.max(0, i)) })
  },
  stepLarge(delta) {
    const { images, largeIndex } = get()
    if (!images.length) return
    set({ largeIndex: Math.min(images.length - 1, Math.max(0, largeIndex + delta)) })
  },

  async startScan() {
    const { auth } = get()
    if (!auth.loggedIn) {
      set({ showLogin: true, toast: { msg: '请先登录后再开始筛选', kind: 'info' } })
      return
    }
    const isMember = auth.user && auth.user.membership.level !== 'free' && !auth.user.membership.is_expired
    if (!isMember && (auth.user?.points.balance ?? 0) <= 0) {
      set({ showMember: true, toast: { msg: '积分不足，请充值或开通会员后再筛选', kind: 'error' } })
      return
    }
    set({ engineBusy: true })
    const r = await window.api.scanStart()
    set({ engineBusy: false })
    if (!r.started) set({ toast: { msg: r.message, kind: 'info' } })
  },
  async stopScan() {
    await window.api.scanStop()
  },
  async rescanAll() {
    const { auth } = get()
    if (!auth.loggedIn) {
      set({ showLogin: true, toast: { msg: '请先登录后再开始筛选', kind: 'info' } })
      return
    }
    set({ engineBusy: true })
    const r = await window.api.scanRescanAll()
    set({ engineBusy: false })
    if (!r.started) set({ toast: { msg: r.message, kind: 'info' } })
  },

  async saveSettings(patch, reclassify = false) {
    const s = await window.api.saveSettings(patch)
    set({ settings: s })
    if (patch.viewMode) set({ viewMode: patch.viewMode })
    if (reclassify) {
      await window.api.reclassify()
      await get().refreshImages()
      await get().refreshCounts()
    }
  },

  async addCustomCategory(name) {
    const c = await window.api.customAdd(name)
    set({ customCategories: [...get().customCategories, c] })
    await get().refreshCounts()
  },

  async removeCustomCategory(id) {
    await window.api.customRemove(id)
    set({ customCategories: get().customCategories.filter((c) => c.id !== id) })
    const { activeCategory } = get()
    if (activeCategory === `custom:${id}`) await get().openCategory(CAT_LIBRARY)
    await get().refreshCounts()
  },

  async importPaths(paths) {
    const r = await window.api.importPaths(paths)
    set({
      importProgress: null,
      toast: {
        msg: `导入完成：新增 ${r.added} 张${r.existed ? `，已存在 ${r.existed} 张` : ''}${r.skipped ? `，无法解码 ${r.skipped} 张` : ''}`,
        kind: 'info'
      }
    })
    await get().openCategory(null)
  },

  async pickAndImport() {
    const dir = await window.api.pickFolder()
    if (dir) await get().importPaths([dir])
  },

  async runExport(opts) {
    try {
      await window.api.exportRun(opts)
    } catch (e) {
      set({ toast: { msg: '导出失败：' + String(e), kind: 'error' } })
    }
  },
  async cancelExport() {
    await window.api.exportCancel()
  },

  dismissToast() {
    set({ toast: null })
  }
}))

export { CAT_LIBRARY, CAT_REVIEW, CAT_TRASH, DIMENSION_LABELS, sortConf }
