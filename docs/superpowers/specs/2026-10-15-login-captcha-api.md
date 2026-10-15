# 验证码登录 · 后端对接单（交付后端实现）

> 客户端已按本文契约做完，**后端上线即自动生效，客户端不需要再改**。
> 配套现状：`app/src/main/services/auth.ts`（login / register / sendCaptcha 三个方法）。
> 沿用现有约定：Base `https://st.uxuuu.cn/api/client`，统一返回 `{ code, message, data }`。

## 一、实测结论（2026-10-15，客户端直连你线上接口跑的）

| 请求 | 后端实际返回 | 判定 |
| --- | --- | --- |
| `POST send_captcha.php {"phone":"10000000000","type":"register"}` | 400 「手机号格式不正确」 | 基线 |
| `POST send_captcha.php {"phone":"10000000000","type":"login"}` | 400 「手机号格式不正确」 | ✅ **`login` 类型已支持**（它先校验 type，再校验手机号，说明 type 这关过了） |
| `POST send_captcha.php {"phone":"10000000000","type":"definitely_not_a_real_type"}` | 400 「验证码类型不正确」 | 对照组，证明上一行不是蒙的 |
| `POST login.php {"phone":"10000000000","code":"000000"}` | 400 「**账号和密码不能为空**」 | ❌ **不认验证码**，只认 password |
| `POST login.php {"email":"nobody@example.invalid","code":"000000"}` | 400 「账号和密码不能为空」 | ❌ 同上 |
| `POST login.php {"phone":"10000000000","password":"wrongpass123"}` | 400 「账号不存在或已被禁用」 | 密码这条路正常 |

**所以要改的只有一处：`login.php` 增加"验证码登录"这条分支。** 发验证码那侧（`send_captcha.php` 的 `type=login`）已经能用，不用动。

## 二、要实现的接口

**接口不变，还是 `login.php`**（客户端已经朝它发，换名字要改两端，没必要）。请在现有"账号+密码"分支之外，增加一条"账号+验证码"分支。

### 请求（客户端实际会发的两种 JSON）

手机号验证码登录：

```json
{ "phone": "13800138000", "code": "482913" }
```

邮箱验证码登录：

```json
{ "email": "user@example.com", "code": "482913" }
```

规则要求：

1. **判分支的依据是"有没有 password"**：带了 `code` 且没带 `password` → 走验证码分支；带了 `password` → 走现在的密码分支，一行都别动（老版本客户端还在发密码登录，不能断）。
2. **账号字段两个都要认**：`phone` 和 `email` 谁有值用谁。注意你们现在密码登录是"邮箱也塞进 `phone` 字段"传的（客户端沿用这个设计，且已验证可用），所以验证码登录也请顺手支持 `{ "phone": "user@example.com", "code": "..." }` 这种把邮箱塞 phone 的写法，别只按手机号正则卡。
3. 验证码校验用 `send_captcha.php` 里 `type=login` 发出去的那一份，**存储 / 有效期 / 试错次数与 `type=register` 用同一套逻辑**，不要为 login 单开一张表。
4. **一次性**：验证通过后立即作废该验证码（与注册一致）。

### 成功返回

**必须和现在的密码登录返回结构完全一致**，客户端复用同一套解析，字段名不能改：

```json
{
  "code": 200,
  "message": "登录成功",
  "data": {
    "token": "<与密码登录同格式的 token>",
    "user": { "id": 123, "phone": "...", "email": "...", "nickname": "...", "membership_level": "monthly", "membership_expire_at": "..." }
  }
}
```

- 签发的 token 与密码登录签发的**等价**：同一个 `user_info.php`、同一个 `Authorization: Bearer`、同样的有效期、同样能扣积分和领 AI 复审 key。验证码登录不是"低权限会话"。
- 会员未登录态字段缺省即可，客户端按现有归一化逻辑处理。

### 失败返回

`code` 用 400/401，`message` 是给人看的中文，客户端会**原样显示在登录框里**，所以请写清楚：

| 情况 | 建议 code | 建议 message |
| --- | --- | --- |
| 验证码错 / 过期 | 400 | `验证码错误或已过期` |
| 账号不存在 | 400 | `该手机号/邮箱尚未注册` |
| 账号被禁用 | 403 | `账号已被禁用` |
| 缺参数（既无 password 又无 code） | 400 | `请填写密码或验证码` |

**防账号枚举**：如果你们对注册接口做过"不透露账号是否存在"的处理，这条也照办——账号不存在时同样回 `验证码错误或已过期`，别用不同文案把"这个号注册过"这件事说出去。若注册接口本身就回"账号不存在"，那这里保持一致即可，我不额外要求。

### 频控与防爆破

- 发码侧（`send_captcha.php`）：同一手机号/邮箱 60 秒一次、每日上限（你们现有实现若已覆盖 `type=login` 就不用新增，只需确认覆盖到了）。
- 登录侧（`login.php` 验证码分支）：同一账号连续错 5 次锁 10 分钟，锁定期内回 `错误次数过多，请稍后再试`。验证码是 6 位数字、且登录免密码，不限速等于给爆破开了后门。

## 三、验收方法（后端自测）

```powershell
# 期望：200，data.token 非空
Invoke-RestMethod -Uri https://st.uxuuu.cn/api/client/login.php -Method Post `
  -ContentType 'application/json' `
  -Body '{"phone":"<你测试号>","code":"<刚收到的码>"}'

# 期望：400 「验证码错误或已过期」，且不能签发 token
Invoke-RestMethod -Uri https://st.uxuuu.cn/api/client/login.php -Method Post `
  -ContentType 'application/json' `
  -Body '{"phone":"<你测试号>","code":"000000"}'
```

第二条现在线上跑出来的是「账号和密码不能为空」——**它变成「验证码错误或已过期」，就说明改到位了。** 客户端会在拿到非 200 时把 message 直接显示给用户。

## 四、顺带告知两件事（不用后端动手，只是别按旧逻辑理解客户端）

1. **会员付款改成人工客服收款**：客户端不再调 `create_order.php`（点「开通」直接弹客服微信二维码，用户扫码报套餐名付款）。接口和订单表请保留，别删——旧版本客户端还在调它，而且以后要接在线支付也得靠它。
2. **积分扣费、AI 复审额度、更新检查这些接口都没变**，本次改动只涉及登录这一条路。
