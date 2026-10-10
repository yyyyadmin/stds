/**
 * 主工作台：左分类树 + 顶栏（导入/筛选/进度/视图/排序/导出/设置）+ 视图区 + 预览层 + 多选浮动栏
 * 全局快捷键：1/2/3/4 切换视图（9.2），空格开预览，Del 移垃圾桶，Ctrl+A 全选，Esc 关闭
 */
import { useEffect, useState } from 'react'
import { useStore } from './store'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import ImageView, { BusyOverlay } from './components/ImageView'
import PreviewModal from './components/PreviewModal'
import { TagManagerModal } from './components/TagEditor'
import SelectionBar from './components/SelectionBar'
import ExportDialog from './components/ExportDialog'
import SettingsDialog from './components/SettingsDialog'
import DropZone from './components/DropZone'
import LoginDialog from './components/LoginDialog'
import MemberCenterDialog from './components/MemberCenterDialog'
import UpdateDialog from './components/UpdateDialog'

export default function App(): JSX.Element {
  const ready = useStore((s) => s.ready)
  const bootstrap = useStore((s) => s.bootstrap)
  const previewId = useStore((s) => s.previewId)
  const showExport = useStore((s) => s.showExport)
  const showSettings = useStore((s) => s.showSettings)
  const showLogin = useStore((s) => s.showLogin)
  const showMember = useStore((s) => s.showMember)
  const showUpdate = useStore((s) => s.showUpdate)
  const tagManagerIds = useStore((s) => s.tagManagerIds)
  const closeTagManager = useStore((s) => s.closeTagManager)
  const tagBusy = useStore((s) => s.tagBusy)
  const viewMode = useStore((s) => s.viewMode)
  const toast = useStore((s) => s.toast)
  const dismissToast = useStore((s) => s.dismissToast)
  const setViewMode = useStore((s) => s.setViewMode)
  const stepPreview = useStore((s) => s.stepPreview)
  const stepLarge = useStore((s) => s.stepLarge)
  const closePreview = useStore((s) => s.closePreview)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  // 全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      // 标签管理器浮层优先：Esc 只关浮层，不改动底下的选中/视图
      if (tagManagerIds != null) {
        if (e.key === 'Escape') {
          e.stopPropagation()
          closeTagManager()
        }
        return
      }
      const dialogOpen = showExport || showSettings || showLogin || showMember || showUpdate
      if (!previewId && !dialogOpen) {
        if (e.key === '1') void setViewMode('grid')
        if (e.key === '2') void setViewMode('list')
        if (e.key === '3') void setViewMode('masonry')
        if (e.key === '4') void setViewMode('large')
        if (e.key === 'Delete') {
          const s = useStore.getState()
          if (s.selection.size) {
            if (s.activeCategory === 'trash') void s.restoreFromTrash()
            else if (s.viewMode === 'large' || s.previewId != null) {
              // 大图/弹窗下 SelectionBar 不渲染，确认框无处显示，保持直接移动
              void s.moveToTrash()
            } else {
              // 单选直接移入垃圾桶；多选（≥2）走 SelectionBar 的确认框（与按钮行为一致）
              s.askTrash()
            }
          }
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
          e.preventDefault()
          useStore.getState().selectAll()
        }
        // 大图模式：← → ↑ ↓ 切换上/下一张
        if (viewMode === 'large') {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault()
            stepLarge(-1)
          }
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault()
            stepLarge(1)
          }
        }
      }
      if (previewId) {
        if (e.key === 'Escape') closePreview()
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault()
          stepPreview(-1)
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault()
          stepPreview(1)
        }
        if (e.key === '1') void setViewMode('grid')
        if (e.key === '2') void setViewMode('list')
        if (e.key === '3') void setViewMode('masonry')
        if (e.key === '4') void setViewMode('large')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewId, showExport, showSettings, showLogin, showMember, showUpdate, tagManagerIds, closeTagManager, viewMode, setViewMode, stepPreview, stepLarge, closePreview])

  // toast 自动消失：移动类即时反馈 1 秒自收（调用方传 duration），其余默认 6 秒供读完错误信息
  useEffect(() => {
    if (toast) {
      const t = setTimeout(dismissToast, toast.duration ?? 6000)
      return () => clearTimeout(t)
    }
  }, [toast, dismissToast])

  // 全局拖拽导入
  useEffect(() => {
    const prevent = (e: DragEvent): void => {
      e.preventDefault()
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  return (
    <div className="h-full flex flex-col bg-base" onDragOver={(e) => {
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault()
        setDragOver(true)
      }
    }} onDragLeave={(e) => {
      if (e.currentTarget === e.target) setDragOver(false)
    }} onDrop={(e) => {
      e.preventDefault()
      setDragOver(false)
      const paths: string[] = []
      for (const f of Array.from(e.dataTransfer.files)) {
        const p = window.getPathForFile(f)
        if (p) paths.push(p)
      }
      if (paths.length) void useStore.getState().importPaths(paths)
    }}>
      {dragOver && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center pointer-events-none">
          <div className="text-2xl text-brand border-2 border-dashed border-brand rounded-2xl px-16 py-12 bg-panel/80">
            松开鼠标导入照片 / 文件夹
          </div>
        </div>
      )}
      {!ready ? (
        <div className="h-full flex items-center justify-center text-gray-500">正在初始化…</div>
      ) : (
        <>
          <TopBar />
          <div className="flex-1 flex min-h-0">
            <Sidebar />
            <main className="flex-1 min-w-0 relative">
              <ImageView />
              <DropZone />
              {/* 导入/缩略图生成期间盖住内容区，吸收点击（开始筛选按钮在 TopBar 同步禁用） */}
              <BusyOverlay />
            </main>
          </div>
          <SelectionBar />
          {previewId != null && <PreviewModal />}
          {tagManagerIds != null && <TagManagerModal />}
          {showExport && <ExportDialog />}
          {showSettings && <SettingsDialog />}
          {showLogin && <LoginDialog />}
          {showMember && <MemberCenterDialog />}
          {showUpdate && <UpdateDialog />}
          {/* 标签写入中：不阻断操作的进度胶囊（乐观更新已先改好界面，这里只说明“正在喂 AI”） */}
          {tagBusy && (
            <div className="fixed inset-x-0 bottom-0 z-[60] flex justify-center pointer-events-none pb-3">
              <div className="pointer-events-auto flex items-center gap-2.5 px-4 py-2.5 rounded-lg bg-panel border border-brand/60 text-sm text-fg shadow-2xl">
                <span className="inline-block w-4 h-4 rounded-full border-2 border-brand border-t-transparent animate-spin shrink-0" />
                {tagBusy}
              </div>
            </div>
          )}
          {toast && (
            <div className="fixed inset-x-0 bottom-0 z-50 pl-56 pb-16 flex justify-center pointer-events-none">
              <div
                className={
                  'pointer-events-auto px-4 py-2 rounded-lg shadow-lg text-sm fade-in cursor-pointer max-w-[80%] ' +
                  (toast.kind === 'error' ? 'bg-red-900/90 text-red-100' : toast.kind === 'success' ? 'bg-emerald-900/90 text-emerald-100' : 'bg-panel2 border border-line')
                }
                onClick={dismissToast}
                title="点击关闭"
              >
                {toast.msg}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
