/**
 * 主工作台：左分类树 + 顶栏（导入/筛选/进度/视图/排序/导出/设置）+ 视图区 + 预览层 + 多选浮动栏
 * 全局快捷键：1/2/3 切视图（9.2），4 看大图（与双击小图同一个弹窗），Del 移废弃库，Ctrl+A 全选，Esc 关闭
 */
import { useEffect, useState } from 'react'
import { useStore } from './store'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import ImageView, { BusyOverlay } from './components/ImageView'
import PreviewModal from './components/PreviewModal'
import { TagManagerModal } from './components/TagEditor'
import ReviewPanel from './components/ReviewPanel'
import SelectionBar from './components/SelectionBar'
import ExportDialog from './components/ExportDialog'
import SettingsDialog from './components/SettingsDialog'
import DropZone from './components/DropZone'
import LoginDialog from './components/LoginDialog'
import MemberCenterDialog from './components/MemberCenterDialog'
import ContactServiceDialog from './components/ContactServiceDialog'
import UpdateDialog from './components/UpdateDialog'
import FailedImagesDialog from './components/FailedImagesDialog'
import AiReviewConsent from './components/AiReviewConsent'
import AiReviewModal from './components/AiReviewModal'
import StaleBanner from './components/StaleBanner'
import OnboardingGuide from './components/OnboardingGuide'

export default function App(): JSX.Element {
  const ready = useStore((s) => s.ready)
  const bootstrap = useStore((s) => s.bootstrap)
  const previewId = useStore((s) => s.previewId)
  const showExport = useStore((s) => s.showExport)
  const showSettings = useStore((s) => s.showSettings)
  const showLogin = useStore((s) => s.showLogin)
  const showMember = useStore((s) => s.showMember)
  const showContactQr = useStore((s) => s.showContactQr)
  const showUpdate = useStore((s) => s.showUpdate)
  const showFailedImages = useStore((s) => s.showFailedImages)
  const showOnboarding = useStore((s) => s.showOnboarding)
  const onboardingPaused = useStore((s) => s.onboardingPaused)
  const tagManagerIds = useStore((s) => s.tagManagerIds)
  const closeTagManager = useStore((s) => s.closeTagManager)
  const reviewPanelIds = useStore((s) => s.reviewPanelIds)
  const tagBusy = useStore((s) => s.tagBusy)
  const toast = useStore((s) => s.toast)
  const dismissToast = useStore((s) => s.dismissToast)
  const setViewMode = useStore((s) => s.setViewMode)
  const stepPreview = useStore((s) => s.stepPreview)
  const closePreview = useStore((s) => s.closePreview)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  // 自动档界面缩放：窗口拖动/最大化/进全屏后按新宽度重选档（防抖 300ms，拖窗口过程中不反复缩）。
  // 手动钉死档（80%~100%）时不插手，尊重用户在设置里的选择。
  useEffect(() => {
    let timer: number | undefined
    const onResize = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const st = useStore.getState()
        if (!st.settings.uiScale || st.settings.uiScale === 'auto') st.applyUiScale()
      }, 300)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', onResize)
    }
  }, [])

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
      // 新手指导亮着时不响应快捷键（别一边看带路一边把页面切走）；但“暂停、我自己试试”时不屏蔽
      const dialogOpen = showExport || showSettings || showLogin || showMember || showContactQr || showUpdate || showFailedImages || (showOnboarding && !onboardingPaused)
      if (!previewId && !dialogOpen) {
        if (e.key === '1') void setViewMode('grid')
        if (e.key === '2') void setViewMode('list')
        if (e.key === '3') void setViewMode('masonry')
        // 4 = 看大图：不再是第四种布局，直接开与双击小图同一个放大弹窗
        if (e.key === '4') useStore.getState().openLargePreview()
        if (e.key === 'Delete') {
          const s = useStore.getState()
          if (s.selection.size) {
            if (s.activeCategory === 'trash') void s.restoreFromTrash()
            // 单选直接移入废弃库；多选（≥2）走 SelectionBar 的确认框（与按钮行为一致）
            else s.askTrash()
          }
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
          e.preventDefault()
          useStore.getState().selectAll()
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewId, showExport, showSettings, showLogin, showMember, showContactQr, showUpdate, showFailedImages, showOnboarding, onboardingPaused, tagManagerIds, closeTagManager, setViewMode, stepPreview, closePreview])

  // toast 自动消失：移动类即时反馈 1 秒自收（调用方传 duration），其余默认 6 秒供读完错误信息
  useEffect(() => {
    if (toast) {
      const t = setTimeout(dismissToast, toast.duration ?? 6000)
      return () => clearTimeout(t)
    }
  }, [toast, dismissToast])

  // 全局拖拽导入：拖到窗口上显示提示层，松手导入。
  // 收尾必须“怎么都能关”（用户 2026-10-15 实测：误碰拖入后整屏被半透明层压住，再也关不掉）。
  // 旧代码只在 dragleave 的目标恰好是根容器时才清，而拖拽掠过的都是子元素，那个条件几乎永不成立；
  // 拖到窗口外松手、按 ESC 取消、拖拽被系统接管这些路径全部没人接手。现在四路兜底：
  // 拖出窗口（dragleave 时两个信号都说人不在了）、拖拽结束（dragend）、按 ESC、以及页面里任意一下鼠标松开；
  // 真正在拖时浏览器不会发 mouseup（它发 dragover/drop），所以这两条不会把正常拖图时的提示误弄没。
  useEffect(() => {
    const prevent = (e: DragEvent): void => {
      e.preventDefault()
    }
    const clear = (): void => setDragOver(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDragOver(false)
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    window.addEventListener('dragend', clear)
    window.addEventListener('mouseup', clear)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
      window.removeEventListener('dragend', clear)
      window.removeEventListener('mouseup', clear)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  return (
    <div className="h-full flex flex-col bg-canvas" onDragOver={(e) => {
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault()
        setDragOver(true)
      }
    }} onDragLeave={(e) => {
      // 只有一种情况该收：拖拽彻底离开窗口（拖到外面松手）。在子元素之间穿行不收，
      // 收了下一帧又点亮就是频闪（侧栏当年踩过）。两个信号都不在窗口内才判“走了”：
      // relatedTarget（要去的那个元素）在个别引擎上不可靠，拿光标坐标兜底。
      const next = e.relatedTarget as Node | null
      const goingIn = next !== null && e.currentTarget.contains(next)
      const at = document.elementFromPoint(e.clientX, e.clientY)
      const stillIn = at !== null && e.currentTarget.contains(at)
      if (!goingIn && !stillIn) setDragOver(false)
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
        <div className="fixed inset-0 z-50 bg-black/60 flex flex-col items-center justify-center gap-4 pointer-events-none">
          <div className="text-2xl text-brand border-2 border-dashed border-brand rounded-2xl px-16 py-12 bg-panel/80">
            松开鼠标导入照片 / 文件夹
          </div>
          {/* 误碰拖入时给自己一条看得见的退路（整层仍是 pointer-events-none，不拦住侧栏拖放命中，只这颗按钮可点） */}
          <button
            className="pointer-events-auto text-xs text-fg3 hover:text-fg2 underline decoration-dotted underline-offset-4 cursor-pointer"
            onClick={() => setDragOver(false)}
            title="没打算导入？点这里关掉提示（按 ESC 或点屏幕任意位置也一样）"
          >
            不想导入？关掉提示（或按 ESC）
          </button>
        </div>
      )}
      {!ready ? (
        <div className="h-full flex items-center justify-center text-gray-500">正在初始化…</div>
      ) : (
        <>
          <TopBar />
          <StaleBanner />
          <div className="flex-1 flex min-h-0">
            <Sidebar />
            <main className="flex-1 min-w-0 relative" data-tour="grid">
              <ImageView />
              <DropZone />
              {/* 导入/缩略图生成期间盖住内容区，吸收点击（开始筛选按钮在 TopBar 同步禁用） */}
              <BusyOverlay />
              {/* AI 复审内容区三态（进度/小结/对比）：移进 main 是为了让「复审中」遮罩只盖当前分类内容区、不挡侧栏与顶栏 */}
              <AiReviewModal />
            </main>
          </div>
          <SelectionBar />
          {previewId != null && <PreviewModal />}
          {tagManagerIds != null && <TagManagerModal />}
          {reviewPanelIds != null && <ReviewPanel />}
          {showExport && <ExportDialog />}
          {showSettings && <SettingsDialog />}
          {showLogin && <LoginDialog />}
          {showMember && <MemberCenterDialog />}
          {/* 联系客服开通（二维码）：组件自管开关，叠在会员中心之上，所以不写 showMember 那样的条件 */}
          <ContactServiceDialog />
          {showUpdate && <UpdateDialog />}
          {showFailedImages && <FailedImagesDialog />}
          {/* AI 复审首次授权弹窗（组件自管开关，未开启时返回 null） */}
          <AiReviewConsent />
          {/* 新手指导（首启分步引导）：组件自管开关与“有更新弹窗先让它走完”，不写条件 */}
          <OnboardingGuide />
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
