# AI 复审 · 后端接口契约（交付后端实现）

> 配套设计：`2026-10-14-ai-review-design.md`。本文只定义**你后端要实现/确认**的接口，客户端据此对接。
> 沿用现有约定：Base `https://st.uxuuu.cn/api/client`，`Authorization: Bearer <token>`，统一返回 `{ code, message, data }`（与 `login.php` / `consume_points.php` / `points_history.php` 同风格）。

## 为什么是两个接口（先讲清）

功能选型是"**客户端直连千问、图片不经过你的服务器**"（省时省带宽、隐私也少一层中转）。副作用：**服务端看不到每张复审**，于是"会员每日上限 `used_today`""成本核算"都没法自动得到。故拆两个接口闭环：

1. **领 key**：校验会员 → 下发千问 API-KEY + 模型/端点 + 当日额度 + 一个服务端签发的 `session_id`。
2. **上报用量**：客户端每成功复审若干张，带 `session_id` 回来**增量上报**，服务端累加 `used_today`、做限额拦截与成本统计。

`session_id` 把"这张 key 发给了谁、这次会话上报的张数"绑到一起，**防止有人绕过领 key 直接乱报用量刷额度**。

---

## 接口 A：领取复审 Key

**`POST /api/client/ai_review_key.php`**

**请求头**
- `Authorization: Bearer <token>`（复用现有登录 token）
- `Content-Type: application/json`

**请求体**
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| scope | string | 是 | 固定 `"review"`（预留：将来不同功能发不同 key） |
| client_version | string | 否 | 客户端版本，便于排查 |

**成功返回 `code:200`**
```jsonc
{
  "code": 200,
  "message": "ok",
  "data": {
    "api_key": "sk-================",        // 千问 DashScope API-KEY（客户端仅内存持有）
    "endpoint": "https://dashscope.aliyuncs.com/compatible-mode/v1", // OpenAI 兼容端点
    "model": "qwen-vl-max",                  // 可由后端调整，客户端不硬编码
    "ttl": 600,                              // 建议客户端缓存秒数（非 key 真实有效期）
    "session_id": "srv-2026xxxx-abcdef",     // ★服务端签发的本次会话令牌，接口 B 必须回传
    "daily_limit": 500,                      // 该会员今日复审张数上限（服务端权威）
    "used_today": 132,                        // 今日已用（服务端统计）
    "remaining": 368                          // = max(0, daily_limit - used_today)
  }
}
```

**失败/拒绝**（`data.reason` 是机器可判字段，客户端据此分支；`message` 是给用户的中文）
| code | 场景 | data.reason | data 额外字段 | 客户端行为 |
|---|---|---|---|---|
| 401 | 未登录 / token 失效 | `unauthorized` | — | 清缓存、引导重新登录 |
| 403 | 非会员 / 会员过期 | `not_member` | — | 打开会员中心 |
| 403 | 今日额度用尽 | `quota_exceeded` | `used_today`,`daily_limit` | 提示"今日额度已用完，明天再来"，停止复审 |
| 429 | 领 key 过于频繁（限频） | `rate_limited` | `retry_after`(秒) | 稍后重试，不无限重试 |
| 400 | 请求方法/参数错误 | `bad_request` | — | 视为客户端 bug |

> 拒绝时也请返回 `used_today`/`daily_limit`，方便前端展示真实剩余。

**服务端实现要点（务必）**
1. **会员闸门在这里**：校验 token 有效 + `membership.level!='free' && !is_expired`，否则 403 `not_member`。这是"非会员怎么都无法复审"的**真正防线**，客户端界面锁只是体验层，不可信。
2. **签发 `session_id`**：每次成功下发生成一个随机、不可猜测的串（可用 `user_id + 时间 + 随机数` 服务端存映射），用于校验接口 B 的上报来自合法领 key 会话。
3. **限频**：对"领 key"按 `user_id` + `IP` 限频（如每分钟 ≤ 6 次），命中返回 429 `rate_limited`。
4. **记录下发日志**：谁 / 何时 / 发了哪个 key（不记 key 明文，记 key 的哈希或后端内部 id 即可），供成本与滥用排查。
5. **支持后台随时换 / 吊销 `api_key`**：客户端只透传下发值，**后端不内置到客户端包里的任何默认 key**。
6. `model` / `endpoint` / `daily_limit` 做成**后端可配置**，换模型、调限额不用发客户端新版。

---

## 接口 B：上报复审用量

**`POST /api/client/ai_review_usage.php`**

**请求头**
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**请求体**
| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| scope | string | 是 | 固定 `"review"` |
| session_id | string | 是 | 接口 A 下发的会话令牌（原样回传） |
| seq | int | 是 | 本会话内批次序号，从 1 递增；**服务端按 (session_id, seq) 幂等去重** |
| delta | int | 是 | 本批次**成功产出 ai_review 的张数**（≥0，单批上限服务端可设，如 ≤200） |

> 客户端上报时机：每成功复审一批（建议每 5～10 张、或每次"停止复审/会话结束"时）上报一次 `delta`。**只报成功出建议的图**——解码失败、模型返回非法 JSON、网络失败的都不计入（不虚增成本）。

**成功返回 `code:200`**
```jsonc
{
  "code": 200,
  "message": "ok",
  "data": {
    "used_today": 141,        // 累加后的今日已用
    "daily_limit": 500,
    "remaining": 359
  }
}
```

**失败/拒绝**
| code | 场景 | data.reason | 客户端行为 |
|---|---|---|---|
| 401 | 未登录 / token 失效 | `unauthorized` | 停止复审 |
| 403 | 非会员 / 过期 | `not_member` | 停止复审、引导开通 |
| 403 | session_id 非法/过期/不属本用户 | `bad_session` | 丢弃本次上报、重新走接口 A |
| 429 | 上报过于频繁 | `rate_limited` | 合并批次、退避重试 |
| 400 | 参数错误（如 delta 越界） | `bad_request` | 视为客户端 bug |

**服务端实现要点**
1. **校验 session_id**：必须是本 token 用户经接口 A 合法领取、且未过期（如 30 分钟）；否则 403 `bad_session`。
2. **幂等**：以 `(session_id, seq)` 去重——同一 seq 重复上报只累加一次（防网络重试重复计数）。
3. **累加 used_today**：按自然日（服务器时区）聚合，写库供接口 A 读取 `used_today`/`remaining`。
4. **合理性护栏**：`delta` 为非负整数、单批设上限、单会话累计上限（≈ daily_limit），超限拒绝，防伪造刷量。
5. **成本统计**：与接口 A 下发日志关联，得到"会员 → 今日复审张数"，便于对账 qwen-vl-max 的实际 token 费用。

---

## 客户端侧对后端的两点约定（你无需实现，但需知道，便于联调）

1. 客户端会**先调接口 A** 拿 key + `session_id` + 额度；`remaining<=0` 直接不开始复审。
2. 复审过程中**分批调接口 B** 回写用量；`ttl` 到期或收到 401/403 即**清内存 key**、停止在途。
3. 拿到的 `api_key` **仅存内存**，绝不落盘、不写日志、不进崩溃上报。

## 联调前请后端确认/回复

- [ ] 两个接口路径/字段能否按上表落地？
- [ ] `session_id` 由后端签发、有效期定多长（建议 30 分钟）？
- [ ] 领 key / 上报的限频阈值（默认：领 key ≤6 次/分/用户+IP；上报合并后 ≤12 次/分）？
- [ ] `daily_limit` 默认 500 是否作为初始值（后台可调）？
- [ ] qwen-vl 若支持临时凭证/子账号限额，是否改用短时效 key（会更安全；不支持则维持"长期 key + 后台换"）？
