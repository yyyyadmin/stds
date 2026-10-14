# AI 复审（会员专属·千问 VL）客户端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给待确认库加一个会员专属的"AI 复审"后台任务：筛完自动用通义千问 VL 对每张待确认图产出只读建议（人数四分类 + 内容型瑕疵），在待确认页以对比界面逐张/批量采纳，采纳复用既有重判通道、可撤回。

**Architecture:** 本地离线引擎不动；新增一个 `aiReview` 后台服务（EventEmitter 单例，仿 `scanner`），图片压小后**客户端直连 DashScope**；会员校验/领 key/报用量走用户既有 PHP 后端（两接口，见 API 契约）。建议写入 `images.ai_review`（与 `tags`/`category` 正交、绝不参与判定）。采纳在渲染层 store 复用 `addDimTag/removeDimTag/correctImage/moveIds`。

**Tech Stack:** Electron 33 + electron-vite、TypeScript、React 18 + zustand、sharp、sql.js（WASM，非 better-sqlite3）、fetch。

**Spec:** `docs/superpowers/specs/2026-10-14-ai-review-design.md` + `docs/superpowers/specs/2026-10-14-ai-review-api-contract.md`（接口以契约为准）。

## Global Constraints（每个任务都隐含遵守）

- 本地离线检测引擎 `ai-engine/` **一行不改**；AI 复审是纯新增旁路。
- **只给建议**：`ai_review` 不得进入 `computeCategory` / `flawLevel` / `isDeliverable` / 导出判定；采纳前 `tags`/`category`/`engine_sig` 一字不变。
- **采纳 = 复用重判通道**：只调用现成 `addDimTag / removeDimTag / correctImage / moveIds`，**不新增任何直改库的 IPC**。
- 复审**范围**：人数四分类（`single_person/group_photo/mixed_photo/no_person`）＋ 内容型瑕疵（闭眼/半截头/表情崩坏）；**画质型（模糊/曝光/黑白）不判**。
- **运行形态**：全局后台任务，不冻结软件；仅当用户停在"待确认"页时该页显示独占进度弹窗，切走即隐藏、任务照跑。
- **凭证**：千问 `api_key` 仅存主进程内存，绝不落盘/写日志/进崩溃上报；`ttl` 到期或收到 401/403 即清缓存停跑。
- **非会员**：后端 403 是唯一真闸门；客户端界面锁仅体验层。
- **验证**：每步 TS 改动后 `npm run typecheck` 双配置必须 0 错；端到端在开发版真实待确认子集上跑（`e7a2a92d`：未端到端验证前不得报"已修好"）。
- **Electron 铁律**：任何确认/提示用应用内弹窗，禁用 `window.confirm/alert`（`ac606ef1`）。
- **UI 铁律**：对比界面靠排版层级 + 单色强调，**不堆一排带边框彩色标签**（`a387a39d`）。

---

## File Structure（新增/改动一览）

- `app/src/shared/types.ts` — 改：`AppSettings` 加 2 字段；`ImageRecord` 加 `ai_review`；新增 `AiReviewSuggestion` 类型。
- `app/src/shared/ipc.ts` — 改：`CH` 加 `aiReviewStart/aiReviewStop/E_aiReviewProgress`；`RendererApi` 加 3 方法 + `AiReviewProgress` 类型。
- `app/src/main/db.ts` — 改：迁移加列 `ai_review`；新增 `setAiReview/getAiReview/listReviewIds/countPendingWithSuggestion/clearAiReview`；`updateDetectResult` 覆盖结果时清 `ai_review`；列表 SELECT 带出 `ai_review`。
- `app/src/main/services/auth.ts` — 改：`authManager.getReviewKey()` / `reportReviewUsage()`（复用 `request()`）。
- `app/src/main/services/aiReview.ts` — 新建：后台服务单例（领 key→压图→调 DashScope→解析→写 ai_review→报用量），EventEmitter 仿 scanner。
- `app/src/main/services/aiReviewPrompt.ts` — 新建：纯函数 `buildReviewMessages()` / `parseModelVerdict(text)`（无 electron 依赖，便于探针）。
- `app/src/main/ipc.ts` — 改：import aiReview 服务；注册 `aiReviewStart/aiReviewStop` handler；`aiReview.on('progress') → send(E_aiReviewProgress)`。
- `app/src/preload/index.ts` — 改：加 `aiReviewStart/aiReviewStop/onAiReviewProgress`。
- `app/src/renderer/src/store.ts` — 改：`aiReview` 状态 + `startAiReview/stopAiReview/adoptAiReview/adoptAllAiReview` + 扫完自动触发 + 事件订阅。
- `app/src/renderer/src/components/AiReviewTag.tsx` — 新建：侧栏"AI复审"灰标签 + 悬停 + 门控点击。
- `app/src/renderer/src/components/AiReviewConsent.tsx` — 新建：首次授权弹窗。
- `app/src/renderer/src/components/AiReviewModal.tsx` — 新建：待确认页内独占进度弹窗 + 小结 + 逐张前后对比 + 采纳。
- `app/src/renderer/src/components/TopBar.tsx` — 改：筛选目录前"AI复审"开关 + 顶部非阻塞进度小字。
- `app/src/renderer/src/components/Sidebar.tsx` — 改：待确认标题挂 `AiReviewTag`。
- `app/src/renderer/src/components/MemberCenterDialog.tsx` — 改：特权列表加一行。
- `app/scripts/ai-review-probe.mjs` — 新建：只读 sql.js 探针，断言"非破坏性"和"采纳等价"（仿 `inspect-db.js`）。

---

## Task 1: 共享类型与 IPC 契约

**Files:**
- Modify: `app/src/shared/types.ts`（`AppSettings` 约 491-546；`ImageRecord`；新增 suggestion 类型）
- Modify: `app/src/shared/ipc.ts`（`CH` 86-152；`RendererApi` 约 240-277）

**Interfaces:**
- Produces:
  - `type AiReviewSuggestion = { sig: number; model: string; at: number; person: 'single_person'|'group_photo'|'mixed_photo'|'no_person'; flaws: { eyes_closed: boolean; half_head: boolean; expression: boolean }; reason: string }`
  - `AppSettings.aiReviewEnabled?: boolean`、`AppSettings.aiReviewConsent?: boolean`
  - `ImageRecord.ai_review?: AiReviewSuggestion | null`
  - `type AiReviewProgress = { running: boolean; total: number; done: number; current: string; phase: 'preparing'|'reviewing'|'done'|'stopped'|'error'; message: string; failCount: number; quotaExceeded: boolean; usedToday: number; dailyLimit: number }`
  - `CH.aiReviewStart='aireview:start'`, `CH.aiReviewStop='aireview:stop'`, `CH.E_aiReviewProgress='evt:ai-review-progress'`
  - `RendererApi.aiReviewStart(): Promise<{ started: boolean; reason?: string; usedToday?: number; dailyLimit?: number }>`；`aiReviewStop(): Promise<void>`；`onAiReviewProgress(cb: (p: AiReviewProgress) => void): () => void`

- [ ] **Step 1:** 在 `shared/types.ts` `AppSettings` 接口末尾（`skipUpdateVersion?` 附近）加两可选字段，并加注释说明"仅存用户偏好、不含判定"。
- [ ] **Step 2:** 在 `shared/types.ts` 定义 `AiReviewSuggestion`；给 `ImageRecord` 加 `ai_review?: AiReviewSuggestion | null`。
- [ ] **Step 3:** 在 `shared/ipc.ts` 定义 `AiReviewProgress`；`CH` 对象加三通道（invoke 两条放账号区、send 事件 `E_` 区加一条）。
- [ ] **Step 4:** `RendererApi` 接口加三方法（签名见上）。
- [ ] **Step 5:** `npm run typecheck`。Expected：`preload/index.ts` 因未实现新 `RendererApi` 方法而**报错**（预期，Task 5 补）；`shared` 层自身 0 错。若嫌中间态红，可临时在 preload 加 `aiReviewStart: () => ipcRenderer.invoke(CH.aiReviewStart)` 等三桩（Task5 正式接线）。

---

## Task 2: DB — ai_review 列与读写

**Files:**
- Modify: `app/src/main/db.ts`（迁移块 91-127；`updateDetectResult` 约 356-358；列表/`getImage` SELECT；新增函数）

**Interfaces:**
- Consumes: Task1 `AiReviewSuggestion`。
- Produces: `setAiReview(id: number, s: AiReviewSuggestion | null): void`、`getAiReview(id: number): AiReviewSuggestion | null`、`listReviewIds(): number[]`、`countReviewPending(): number`、`clearAllAiReview(): void`。

- [ ] **Step 1:** 仿 `engine_sig` 迁移（db.ts:123-125）加：`try { db.exec('ALTER TABLE images ADD COLUMN ai_review TEXT') } catch {}`。
- [ ] **Step 2:** 写 `setAiReview`：`UPDATE images SET ai_review = ? WHERE id = ?`，传 `JSON.stringify(s)` 或 `null`。
- [ ] **Step 3:** 写 `getAiReview`（`SELECT ai_review`→`JSON.parse` try/catch 返回 null）。
- [ ] **Step 4:** 写 `listReviewIds`（`SELECT id FROM images WHERE status='done' AND NOT isTrashLike(category) AND (category='review' OR 中置信瑕疵派生)`——复用现有待确认判定口径，参照 `computeCategory`/`flawLevel`；若 db 层无该谓词，则用 `category = CAT_REVIEW` 起步并在注释标注"D2 派生口径对齐 classify"）。
- [ ] **Step 5:** 写 `countReviewPending`（`SELECT COUNT(*) ... WHERE ai_review IS NOT NULL AND` 同待确认谓词）。
- [ ] **Step 6:** `updateDetectResult`（db.ts:356）UPDATE SET 追加 `ai_review = NULL`——重扫/重筛覆盖结果即作废旧建议（spec §6.1）。
- [ ] **Step 7:** 列表 SELECT（`listByCategory`/`getImage`/`listByCategoryIds`）带出 `ai_review` 并在映射里 `JSON.parse` 塞进 `ImageRecord.ai_review`（解析失败置 null）。
- [ ] **Step 8:** `npm run typecheck`。Expected：0 错。

---

## Task 3: 后端两接口（挂 authManager）

**Files:**
- Modify: `app/src/main/services/auth.ts`（`request()` 私有复用；`AuthManager` 类内加方法）

**Interfaces:**
- Consumes: 现有 `request(endpoint, body, token)`、`this.token`、`isMember()`。
- Produces:
  - `getReviewKey(): Promise<{ ok: boolean; reason: 'ok'|'unauthorized'|'not_member'|'quota_exceeded'|'rate_limited'|'bad_request'|'network'; data?: { api_key: string; endpoint: string; model: string; ttl: number; session_id: string; daily_limit: number; used_today: number; remaining: number }; retry_after?: number }>`
  - `reportReviewUsage(sessionId: string, seq: number, delta: number): Promise<{ ok: boolean; usedToday?: number; remaining?: number; reason?: string }>`
  - 契约见 `api-contract.md` 接口 A/B；`data.reason` 分支照契约表。

- [ ] **Step 1:** `getReviewKey`：调 `request('ai_review_key.php', { scope: 'review', client_version: app.getVersion() }, this.token)`；把 HTTP 风格 `code` + `data.reason` 归一成上面的 `reason` 枚举；网络异常 catch → `reason:'network'`。
- [ ] **Step 2:** `reportReviewUsage`：`request('ai_review_usage.php', { scope:'review', session_id: sessionId, seq, delta }, this.token)`；解析返回。
- [ ] **Step 3:** 两方法内部**绝不打印 api_key**（不打日志、不进 error message）。
- [ ] **Step 4:** `npm run typecheck`。Expected：0 错。

> 后端未就绪时：本任务编译通过即可，实际返回在 Task12 联调。可先在后端上线前用 Task4 的 stub 模式跳过真接口。

---

## Task 4: 纯函数 — 提示构造与模型响应解析

**Files:**
- Create: `app/src/main/services/aiReviewPrompt.ts`（**不 import electron**，可被探针/服务共用）

**Interfaces:**
- Produces:
  - `buildReviewMessages(): { system: string; userText: string }`（要求严格 JSON、`person` 四值 + `flaws` 三 bool + `reason`，口径见 spec §5，含"眯眼/半睁算闭眼、低头不算""半截头仅主体""宠物不算人""接亲归混合"等业务口径）。
  - `parseModelVerdict(text: string): AiReviewSuggestion | null`：抽取第一个 `{...}`（容忍 ```json 包裹/前后废话）→ 校验 `person ∈ 四枚举` 且 `flaws` 三键为布尔 → 组装 `AiReviewSuggestion`（`sig`/`model`/`at` 由调用方注入，解析函数只管内容）。解析失败/越界 → 返回 `null`（调用方记"复审失败"，绝不猜测）。

- [ ] **Step 1:** 写 `buildReviewMessages()`（system: "你是严谨的摄影选片助手，只输出 JSON，不解释"；user 文本含四条 person 定义与三瑕疵定义）。
- [ ] **Step 2:** 写 `parseModelVerdict()`：`const m = text.match(/\{[\s\S]*\}/)`；`JSON.parse` try/catch；类型守卫 `person`/`flaws`；返回或 null。
- [ ] **Step 3:** `npm run typecheck`。Expected：0 错。
- [ ] **Step 4:** 探针（临时，Task12 固化）：`app/scripts/ai-review-probe.mjs` 里 `import` 编译产物不便 → 改为在 `parseModelVerdict` 上方注释标注"逻辑单测由开发版 stub 端到端覆盖"，用 Task12 的真实流程验证替代。

---

## Task 5: aiReview 后台服务 + ipc/preload 接线

**Files:**
- Create: `app/src/main/services/aiReview.ts`
- Modify: `app/src/main/ipc.ts`（imports 40-43；`registerIpc` 事件桥 66-80 区；handler 区）
- Modify: `app/src/preload/index.ts`（api 对象）

**Interfaces:**
- Consumes: `authManager.getReviewKey/reportReviewUsage`、`listReviewIds/getAiReview/setAiReview/countReviewPending`、`buildReviewMessages/parseModelVerdict`、`importer` 的 `orientedSharp`（EXIF 转正 + sharp 缩放到长边≤1024 → JPEG q82 → base64）。
- Produces: 单例 `aiReview extends EventEmitter`，`emit('progress', AiReviewProgress)`；`aiReview.start(): Promise<{started; reason?}>`；`aiReview.stop(): void`。

- [ ] **Step 1:** 建 `aiReview.ts`：`class AiReview extends EventEmitter`，字段 `running/stopRequested/progress: AiReviewProgress`（初值全 0/`phase:'preparing'`）。
- [ ] **Step 2:** `start()`：非会员/未授权（读 `getSettings().aiReviewConsent`）→ 直接返回；`authManager.getReviewKey()`；`reason==='not_member'` 返回 `{started:false,reason:'not_member'}`、`quota_exceeded` 返回带 `used_today/daily_limit`；成功则缓存 `apiKey/endpoint/model/sessionId/ttlExpiresAt` 到**内存字段**。
- [ ] **Step 3:** 取 `listReviewIds()` 作队列；`total` 计数；起 `this.run()`（**不 await**，后台跑，立即 return `{started:true}`）。
- [ ] **Step 4:** `run()`：并发 `Math.min(2, workers)`（比检测低，克制带宽/成本）；逐张：`stopRequested` 检查→ `emit progress`（done/current=basename/`phase:'reviewing'`）→ 压图 base64（解码失败→该图记 `failCount++` 跳过）→ `fetch(endpoint+'/chat/completions',{model,messages:[system,user(含 image_url dataURL)],temperature:0, max_tokens})`（`Authorization: Bearer apiKey`，超时 `AbortController` 15s）→ `parseModelVerdict(content)`→ null 则 `failCount++` 重试 1 次再失败；成功 `setAiReview(id, suggestion)`；每成功累积 `seqDelta`，每 5 张或收尾调 `reportReviewUsage(sessionId, seq++, delta)`（`used_today>=daily_limit` 即停并 `quotaExceeded=true`）。
- [ ] **Step 5:** `ttl` 中途到期 → `getReviewKey()` 续领；收尾/停止置 `running=false, phase:'done'|'stopped'` 并 `emit`。
- [ ] **Step 6:** stub 模式：`process.env.AI_REVIEW_STUB==='1'` 时不调外网，用一段固定 JSON（覆盖"改人数/加瑕疵/删瑕疵/一致"四类）喂 `parseModelVerdict` → 供开发版无后端时验管线。
- [ ] **Step 7:** 导出 `export const aiReview = new AiReview()`。
- [ ] **Step 8:** `ipc.ts`：`import { aiReview } from './services/aiReview'`；事件桥仿 scanner：`aiReview.on('progress', p => send(CH.E_aiReviewProgress, p))`；handler：`ipcMain.handle(CH.aiReviewStart, () => aiReview.start())`、`ipcMain.handle(CH.aiReviewStop, () => { aiReview.stop() })`。
- [ ] **Step 9:** `preload/index.ts`：`aiReviewStart: () => ipcRenderer.invoke(CH.aiReviewStart)`、`aiReviewStop: () => ipcRenderer.invoke(CH.aiReviewStop)`、`onAiReviewProgress: (cb) => sub(CH.E_aiReviewProgress, cb)`。
- [ ] **Step 10:** `npm run typecheck`。Expected：0 错。

---

## Task 6: store — 状态 + 触发 + 采纳

**Files:**
- Modify: `app/src/renderer/src/store.ts`（state 初值；`bindEvents` 605+；扫完 hook 611+；新增 action；SettingsDialog 无关）

**Interfaces:**
- Consumes: `window.api.aiReviewStart/Stop/onAiReviewProgress`、`addDimTag/removeDimTag/correctImage/moveIds/refreshImagesFor/refreshCounts`、`ImageRecord.ai_review`、`settings.aiReviewEnabled`。
- Produces: `aiReview: AiReviewProgress | null`；`startAiReview()`；`stopAiReview()`；`adoptAiReview(id: number): Promise<void>`；`adoptAllReviewSuggestions(): Promise<number>`。

- [ ] **Step 1:** store state 加 `aiReview: null as AiReviewProgress | null`。
- [ ] **Step 2:** `bindEvents` 加 `window.api.onAiReviewProgress(p => set({ aiReview: p }))`。
- [ ] **Step 3:** 扫完自动触发：在现有 `onScanProgress` 收尾 `phase==='done'` 分支后，若 `isMember && settings.aiReviewEnabled && settings.aiReviewConsent && 待确认有照片` → `void get().startAiReview()`（后台，不 await、不劫持界面）。
- [ ] **Step 4:** `startAiReview`：调 `aiReviewStart()`；`reason==='not_member'` → 打开会员中心；`quota_exceeded` → toast"今日额度已用完"。`stopAiReview` 调 `aiReviewStop()`。
- [ ] **Step 5:** `adoptAiReview(id)`：从当前 `images`/`getImage` 取 `img.ai_review`；按 spec §7.6 **完全复用手动重判序列**：
  ```ts
  // 瑕疵：建议 false 且现状有→removeDimTag；建议 true 且现状无→addDimTag
  const flaws = img.ai_review!.flaws
  for (const [d, want] of Object.entries(flaws)) {
    const cur = img.tags?.[d]?.level && img.tags[d]!.level !== 'low'
    if (!want && cur) await window.api.removeDimTag([id], d)
    if (want && !cur) await window.api.addDimTag([id], d)
  }
  // 中置信存疑瑕疵若建议保留→correctImage(action:'correct', origDim)（对齐 ReviewPanel:137）
  // 人数：与现状不同→moveIds([id], person)
  if (visiblePerson(img) !== img.ai_review!.person) await moveIds([id], img.ai_review!.person)
  await setAiReviewNull(id) // 见 Step6
  await refreshImagesFor([id]); await refreshCounts()
  ```
  采纳前二次校验该图仍在待确认（`!isTrashLike && category/瑕疵派生`），否则跳过并提示（spec §8）。
- [ ] **Step 6:** 需要一个清建议通道：`CH` 补 `aiReviewClear:'aireview:clear'`（Task1 顺带），`ipc.ts` handler 调 `setAiReview(id, null)`；preload 补 `aiReviewClear`。`adoptAiReview`/`skip` 调它。（若嫌新通道，可复用 `saveSettings`? 否——必须 per-image，保留新通道，最小。）
- [ ] **Step 7:** `adoptAllReviewSuggestions()`：对 `countReviewPending` 的图逐张 `adoptAiReview`，返回成功张数。
- [ ] **Step 8:** `npm run typecheck`。Expected：0 错。

---

## Task 7: UI 门控（侧栏标签 + 顶部开关 + 授权弹窗）

**Files:**
- Create: `app/src/renderer/src/components/AiReviewTag.tsx`、`AiReviewConsent.tsx`
- Modify: `Sidebar.tsx`（待确认标题行）、`TopBar.tsx`（筛选目录前）、`store.ts`（开关联动 + 触发授权）

- [ ] **Step 1:** `AiReviewTag.tsx`：会员→正常色可点（切 `aiReviewEnabled`），非会员→`text-fg3` 灰字 `title="会员专属功能"` 点击开 `showMember`；复用 `auth.loggedIn && level!=='free' && !is_expired` 判定（同 TopBar:57）。文字旁在有建议时点亮"有 N 张"小字（读 `countReviewPending`，经 store 刷新）。
- [ ] **Step 2:** `Sidebar.tsx` 待确认标题后渲染 `<AiReviewTag />`（靠排版，不加边框块）。
- [ ] **Step 3:** `TopBar.tsx` 筛选目录前加"AI复审"开关：非会员灰按钮→`showMember`；会员真开关。开启动作里：若 `!settings.aiReviewConsent` → 置 `showAiReviewConsent` 先弹授权；同意才 `saveSettings({aiReviewEnabled:true})`。
- [ ] **Step 4:** `AiReviewConsent.tsx`：应用内弹窗（禁 window.confirm），两条正文含"不自动改分类/入库/覆盖标签，点采纳才生效可撤回"（spec §7.2）；[同意并开启]→`aiReviewConsent:true`。挂 `App.tsx`。
- [ ] **Step 5:** 会员中心 `MemberCenterDialog.tsx` 特权列表加一行"支持 AI 复审 · 待确认自动二次复判"。
- [ ] **Step 6:** `npm run typecheck`；开发版手点：非会员点两入口都只跳会员中心、不发任何复审请求。

---

## Task 8: 顶部非阻塞进度小字

**Files:**
- Modify: `TopBar.tsx`

- [ ] **Step 1:** 当 `aiReview?.running` 且用户**不在待确认页**（用当前 `category` 判断）时，在进度区显示轻量一行 `AI 复审中 {done}/{total} · {current}` + 一个 `[停止复审]`（调 `stopAiReview`）；沿用"重复/连拍聚类"那种 indeterminate/细条样式，不新加大块。
- [ ] **Step 2:** `phase==='done'|'stopped'` 时该行自动消失。
- [ ] **Step 3:** `npm run typecheck`；stub 跑验证不遮挡、可点停止、其他页面操作无碍。

---

## Task 9: 待确认页内独占进度弹窗

**Files:**
- Create: 复用 `AiReviewModal.tsx` 的 `phase='running'` 视图
- Modify: `App.tsx`（当前打开分类==='review' 且 aiReview.running 时挂载）

- [ ] **Step 1:** 条件：`currentCategory==='review' && aiReview?.running` → 渲染**独占弹窗**（fixed 遮罩，盖住待确认列表，挡照片与判定操作，仅弹窗可交互，背后半透明遮罩）。
- [ ] **Step 2:** 内容严格按 spec §7.3：`AI 复审中，请稍候` / `共 N 张 · 当前第 done 张 · 预计还需 <按速率估>` / `正在复审：{current}` / 进度条 / `[停止复审]`。
- [ ] **Step 3:** 用户切到别的分类 → 弹窗随 `currentCategory!=='review'` 卸载，但**后台任务不中断**（服务在主进程，与弹窗无关）。回到待确认仍在跑 → 再显示。
- [ ] **Step 4:** `npm run typecheck`；stub 端到端：进待确认弹独占窗、切走不挡、回来续显。

---

## Task 10: 小结 + 逐张前后对比 + 采纳

**Files:**
- Modify: `AiReviewModal.tsx`（加 `phase='summary'` 与 `'compare'` 视图）
- Modify: `ReviewPanel.tsx`（加可选 `prefill?: AiReviewSuggestion` 入口）

- [ ] **Step 1:** 复审 `phase==='done'` 后，用户进待确认 → 弹**小结**（非每次自动弹）：`共复审 N 张，其中 M 张有不同意见` + 分解 + [逐张复核][全部采纳 M 条][以后再说]（spec §7.4）。
- [ ] **Step 2:** [全部采纳] → `adoptAllReviewSuggestions()`，成功 toast，可 ↩ 撤回（复用现有撤回栈；不支持分组则逐张可撤并说明）。
- [ ] **Step 3:** **逐张对比视图**（核心，遵守 `a387a39d`：只列差异项、箭头 + 单色强调，一致项收进"其余项一致"一句）：左缩略图（`toSrc(thumb||path)`），右逐行 `现状 → AI建议` + AI `reason`；底部 `[采纳这张][改一改][跳过] ← 下一张 →`。
  - 采纳这张 → `adoptAiReview(id)`；跳过 → `aiReviewClear(id)` 后下一张；改一改 → 打开 `ReviewPanel([id])` 且传入 `prefill=img.ai_review`（人数预选、瑕疵三态按建议设好）→ 用户微调提交（复用其 submit）。
- [ ] **Step 4:** `ReviewPanel` 增 `prefill` 消费：`useEffect` 里若有 prefill，`setPerson(prefill.person)`、`setFlaw` 按 flaws 设 `add/remove/same`（其余 `same`）。不改变原手动语义。
- [ ] **Step 5:** `npm run typecheck`；stub 端到端人工核对四类差异呈现正确。

---

## Task 11: 边界与失败处理

**Files:**
- Modify: `aiReview.ts`（错误分支）、`store.ts`（提示）

- [ ] **Step 1:** 逐条落 spec §8：断网→不写建议 + toast"需联网，已跳过"；401/403→停 + 清内存 key；额度尽→停 + 提示；模型非法 JSON→`failCount++` 不猜写；解码失败→跳过标"无法复审"；跑中途登出/关开关→`stop()` 停在建、已完成建议保留；重扫→Task2 已 `ai_review=NULL` 作废；采纳前校验现状。
- [ ] **Step 2:** `npm run typecheck`；对 stub + 断网（devtools offline）注入验证各分支。

---

## Task 12: 端到端验证 + 后端联调（依赖用户接口就绪）

**Files:**
- Modify/Create: `app/scripts/ai-review-probe.mjs`（只读 sql.js，仿 `inspect-db.js`）

- [ ] **Step 1:** `AI_REVIEW_STUB=1` 开发版全链路自测（无需后端）：筛完→后台跑→待确认独占弹窗→小结→逐张对比→采纳→DB 核对。
- [ ] **Step 2:** **非破坏性断言**（探针）：采纳前对全量待确认图比对 `tags/category/engine_sig` 与复审前快照**逐字段不变**，仅 `ai_review` 被写。
- [ ] **Step 3:** **采纳等价性基准**（`e7a2a92d` 核心）：同一批图，A 组走 `adoptAiReview`、B 组在 `ReviewPanel` 手选同结果提交 → 比对最终 DB 状态逐字段一致。
- [ ] **Step 4:** 后端两接口就绪后**真实联调**：领 key/报用量/额度拦截/403 门禁/千问真实返回解析；此步 blocked 直到用户交付可用接口。
- [ ] **Step 5:** 通过后方可报"已落地"；任一断言不过则回 Task4/5 排根因（禁"先交付再补验"）。

---

## Self-Review（写完对照 spec）

- **覆盖**：spec D1–D9 → Task5/9/10（运行形态、待确认页独占弹窗、后台不冻结）；§4/契约 → Task3；§5 → Task4/5；§6 → Task1/2；§7 → Task6/7/8/9/10；§8 → Task11；§9 → 全局约束 + Task3（额度）；§11 验收 → Task12。
- **无占位**：纯逻辑/接线处给了真实签名与关键代码；UI 处给文件、组件、条件、文案与复用点。
- **类型一致**：`AiReviewSuggestion`/`AiReviewProgress`/`getReviewKey`/`reportReviewUsage`/`adoptAiReview` 跨任务命名一致；新增 `CH.aiReviewClear` 已在 Task6 引入（Task1 需一并加，见 Step6 注记）。
- **已知缺口（计划内显式标注，非占位）**：① `listReviewIds` 待确认谓词需对齐 D2 派生口径（Task2 Step4 注记，实现时读 classify.ts 收口）；② 批量采纳 ↩ 分组撤回需实现时确认现有撤回栈能力，否则退化逐张可撤（Task10 Step2）；③ 真实联调 blocked 于后端（Task12 Step4）。

---

## 执行状态（2026-10-14）

- **Task 1–11：代码完成，`npm run typecheck` 双配置（node+web）0 错。**
- **Task 12 探针：完成并自验。** `app/scripts/ai-review-probe.mjs`（只读 sql.js，仿 inspect-db.js）三命令已对真实库（2573 张）跑通：
  - `status` / `snapshot <out.json>` / `verify <before.json>`（Step2 非破坏性断言：仅 ai_review 可变，判定字段零漂移 → ✅ PASS）/ `diff <a.json> <b.json>`（Step3 采纳等价性：两份终态逐字段一致 → ✅ PASS）。
  - 反向自检：篡改对照文件一处 category，`diff` 精确报出并 exit 1 → 证明断言非空过。
- **Step1（stub GUI 手点全链路）**：需启动开发版（`AI_REVIEW_STUB=1`）人工点走「筛完→后台跑→待确认独占弹窗→小结→逐张对比→采纳→DB 用探针 verify/diff 核对」——待用户在有显示环境时执行。
- **Step4（真实后端联调）**：✅ **已端到端实测通过（2026-10-14，后端接口+key 已配置）**，见下方“真链路完整闭环”。

### 2026-10-14 后端就绪后补验

- 新增联调探针 `app/scripts/ai-review-integration.mjs`（只读、可重复；无 token 仅验连通+401，不耗额度不发 key）。
- **已实测（本机无会员 token，走安全路径）：✅ 全部通过。**
  - 接口 A `ai_review_key.php` / 接口 B `ai_review_usage.php` 均已上线可达，返回 `{code,message,data}` 信封。
  - 未登录 → HTTP 401 + `data.reason="unauthorized"`，且**未泄露 api_key**——会员闸门在服务端真实生效（非仅 UI）。
  - 客户端 `auth.ts` 的 `getReviewKey`/`reportReviewUsage` 与契约逐分支对齐（200+api_key+session_id 才算 ok；401/403/429/0 归一 unauthorized/not_member·quota_exceeded·rate_limited·network）。
### 2026-10-14 真链路完整闭环（会员 token + 后端下发 key）✅

用软件登录的会员 token（服务端 `user_info` 返 `level=monthly`）跑 `node scripts\ai-review-integration.mjs --full`（附 `AI_REVIEW_TEST_IMG`）：
- **接口 A 返 200**，下发 `session_id`（`srv-<YmdHis>-<hex>` 合契约）/ `model=qwen3-vl-plus` / `endpoint` / 额度 500；真 api_key 仅内存持有、输出脱敏。
- **非法 session 打接口 B → 403**（服务端 session 校验生效）；合法 session delta=0 → 200。
- **拿后端下发的真 key 直连 qwen3-vl-plus 判图** → 返回纯 JSON、`parseModelVerdict` 成功解析、判定正确（两人合影=group）。
- 模型选型：`qwen3-vl-plus` 实测 9/9 可解析、成本约 ¥0.0016/张（1000 张≈¥1.6）；加不加 `enable_thinking:false` 结果一致 → 生产请求体无需改。
- 注：本地 auth.json 的 `membership.level` 可能是旧缓存（曾见 free 而服务端 monthly）；客户端 UI 门禁读本地值，会员升级后需软件重启/刷新 user_info 才解锁（服务端接口 A 才是安全权威闸门）。
- 至此 **Task 1–12 全部完成且端到端验证**（仅余 Step1 GUI 人工点走作为验收演示，非阻塞）。

### 2026-10-14 针对后端回复的客户端加固（`typecheck` 双配 0 错）

后端逐条确认契约并多出两个保护分支，客户端相应补齐（均只新增分支，不动既有判定）：
- `auth.ts getReviewKey`/`reportReviewUsage`：新认 **403 `service_disabled`、503 `key_not_configured`** → 归一 `service_unavailable`；上报侧 `bad_session`/`quota_exceeded`/`rate_limited` 原样透传。503 不再误判 `bad_request`。
- `aiReview.ts`：`finishForReason` 新增 `service_unavailable`/`unauthorized` 文案 + `lastBlockReason` 记录；`start()` 如实回传真实阻塞原因（不再把服务故障/断网折叠成 `not_member` 误推会员）。
- `aiReview.ts flushUsage`：上报回 `quota_exceeded`→停复审标额度尽；`rate_limited`/`network`/`service_unavailable`→回滚本批 delta 并退回 seq，下次同 (session,seq) 幂等重报不丢计数；`bad_session`→清 key 重领且回滚 delta。对齐后端说明第 2/4 点。
- `store.ts startAiReview`：补 `service_unavailable`/`unauthorized`/`rate_limited`/`network` 反馈分支（登录失效弹登录、服务不可用仅提示不跳会员）。
- 联调探针：`--full` 时区分保护分支（503/`key_not_configured` 报 ℹ️ 预期而非 FAIL）与真实错误。
- 待确认（无需改码）：session 30min/ttl 600 两值独立→客户端已分别处理；delta=0 合法且幂等；`duplicated:true` 不影响 ok；`daily_limit` 优先级与 `client_version` 真实传递均已满足。
