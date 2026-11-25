# kids-trip-server

「哪里值得玩」亲子版 **全新后端**（不复用旧 `your-server.example.com` 项目，独立部署在该域名下即可）。
零依赖 Node 实现，UGC 投票飞轮 + 每条评论自动 AI 短评评价。

> 本文件随架构评审同步修订。当前版本：**v4.6**——已覆盖首轮 15 条 + 次轮 13 条 + 第三轮 9 条 + 第四轮 9 条 + 第五轮 9 条 + 第六轮 9 条 + 第七轮 7 条 + **第八轮 8 条**（接口一致性+状态机、体验+文档、边界+细节：GET /spots/:id 详情补 my_vote、PATCH 攻略被拒不回退默认攻略、mine=1 评论含 L2 回复线程、审核拒绝原因 rejection_reason 持久化、限流明确滑动窗口、comment.parent_id DDL 注释修正、ai_review.helpful_score 加 CHECK、COMMENT_MAX_CHILDREN 下限保护）。共 **79 项评审修订**，通过 **136 项端到端用例**验证。

## 运行

```bash
cd kids-trip-server
node server.js          # 默认 :3000，首次启动自动写入种子数据
```

> 本地无外网也能跑：微信登录走 `DEV_MODE` 兜底（伪 openid）。生产设 `DEV_MODE=false` 强制真实 `code2session`。

环境变量：涉及凭证的变量**必须**通过环境变量注入，仓库中均为占位符。

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | 3000 | 监听端口 |
| `WECHAT_APPID` / `WECHAT_SECRET` | 占位符 | 小程序凭证，仅后端使用，部署时必填 |
| `TOKEN_SECRET` | 占位符 | token 签名密钥，生产用 `openssl rand -hex 32` 生成 |
| `DEV_MODE` | true | false 时关闭登录兜底 |
| `AI_MODEL` | template | template / qianfan / tongyi（预留 LLM） |
| `DATA_FILE` | ./data/db.json | JSON 持久化文件（运行时生成；示例种子见 `data/db.example.json`） |
| `HOST` | 127.0.0.1 | 监听地址，**默认仅环回**（安全基线，公网不可达）；本机外访问设 `0.0.0.0`。部署由 nginx 反代到 `127.0.0.1:PORT` |
| `TOKEN_TTL_DAYS` | 7 | token 有效期（天），过期前端重新登录 |
| `AI_WORKER_INTERVAL_MS` / `AI_WORKER_BATCH` | 1000 / 10 | AI 评价 Worker 轮询间隔 / 每批条数 |
| `AI_REVIEW_MAX_RETRY` | 3 | AI 评价失败最大重试次数 |
| `AI_REVIEW_AUTO_RETRY_FAILED` | false | true 时 Worker 自动复活 `failed 且 retry_count<上限` 的 AI 评价记录为 pending（四轮 #7） |
| `RL_GUIDE_PER_SPOT_DAY` / `RL_COMMENT_PER_HOUR` | 1 / 10 | 每景点每日攻略上限 / 每用户每小时评论上限 |
| `CONTENT_MIN_LEN` | 5 | UGC 内容最小长度（trim 后字符数），低于则拒 `CONTENT_TOO_SHORT`（五轮 #5） |
| `CONTENT_MAX_LEN` | 2000 | 评论最大长度（字符数），超过则拒 `CONTENT_TOO_LONG`（六轮 #1） |
| `GUIDE_MAX_LEN` | 10000 | 攻略最大长度（字符数），超过则拒 `CONTENT_TOO_LONG`（六轮 #1） |
| `COMMENT_MAX_CHILDREN` | 50 | 根评论下单次子评论返回上限，超出标记 `children_truncated`（第三轮 #9；七轮 #6 补登此变量）。**八轮 #8：最小有效值为 1**，配置为 0/负数时自动提升到 1（NaN 安全钳制），避免子评论逻辑异常 |
| `MODERATION` | true | false 关闭内容审核（仅测试用） |

## 数据模型（6 类）

- `spot` 景点（含 `systemScore` 0~100，**冗余 `likes/dislikes`** 用于列表零聚合，评审 #2）
- `guide` 攻略（`isDefault` 标记当前默认；`source` 区分 system/user；`status` 审核状态；多实例前瞻：每 spot 至多 1 条 `isDefault=TRUE`，关系型可用 `CREATE UNIQUE INDEX ... WHERE is_default`，JSON 实现置默认前断言，第三轮 #8）
- `vote` 赞/不赞（`user_id+target` 唯一，防刷；`target_type` 支持 spot/guide/comment）
- `comment` 嵌套评论（深度上限 **2 层**；`parentType` 可为 spot/guide/comment；`rootId` 指向根、`replyToUserId` 记录「回复 @某人」；**含 `dislikes`**，评审 #1；根评论下子评论上限 `COMMENT_MAX_CHILDREN`（默认 50，config 可配），超出标记 `children_truncated`，第三轮 #9）
- `ai_review` 评论 AI 评价（`retry_count` 重试计数；`status` pending/done/failed）
- `user` 用户昵称/头像表（评审 #9）

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/auth/login` | `{code, nickname?, avatar_url?}` → `{token, expires_in}`（**不返回 openid**，评审 #5） |
| GET | `/auth/me` | 当前用户脱敏信息 `{user_id, nickname, avatar_url}`（评审 #5/#9） |
| PATCH | `/auth/me` | 修改昵称/头像 `{nickname?, avatar_url?}` → `{user_id, nickname, avatar_url}`（四轮 #3，免等 token 过期） |
| DELETE | `/auth/me` | **预留（MVP 不实现）**：账号注销/删除，未来删除 `user` 及关联 UGC（需污点化而非物理删，保留他人引用完整性）。六轮 #8 仅文档标注，接口暂未开放。 |
| GET | `/healthz` | 健康检查（部署 / pm2 / nginx 探活用），返回 `{ok:true, ts, uptime}`，无副作用、不依赖外部资源 |
| GET | `/spots?lat=&lng=&sort=composite\|distance&page=&size=&city=&category=` | 景点列表，综合排序或距离优先，分页；**缺省 `sort=composite`**（六轮 #7）；`city`/`category` 精确过滤（五轮 #8）；`sort=distance` 缺 `lat/lng` 返回 `400 MISSING_COORDS`（五轮 #9） |
| GET | `/spots/:id` | 详情 + 默认攻略（全文，system 种子 `author.nickname='官方推荐'`，五轮 #7）；**八轮 #1：响应携带 `my_vote`（与列表项同构，依赖登录态），前端可初始化点赞按钮状态** |
| GET | `/spots/:id/guides` | 该景点攻略（列表返回 `snippet`，评审 #11）；**公开仅返回 approved**，`?mine=1` 返回本人全部状态（四轮 #4）；**排序按净赞率 `likes-dislikes` 降序、同分按 `createdAt` 降序**（七轮 #2）；**八轮 #4：列表项与单条均带 `rejection_reason`（作者本人可见被拒原因）** |
| GET | `/guides/:id` | 单条攻略全文（评审 #11）；**可选鉴权**：无 token / 非作者仅当 `status='approved'` 返回，否则 `404`（防遍历 id 泄露 rejected 全文，七轮 #1）；有 token 且为作者本人则返回任意状态（含 rejected/pending，供编辑，七轮 #1）；**八轮 #4：响应带 `rejection_reason`** |
| GET | `/guides?mine=1&page=&size=` | **七轮 #4**：跨景点查看本人全部攻略（个人中心「我的攻略」），必须登录；按 `createdAt` 降序分页；列表同时返回 `snippet` 与 `content` 全文（本人内容无需截断）；**八轮 #4：带 `rejection_reason`** |
| POST | `/guides` | 上传攻略（需登录；受审核 + 限流；非空 + 最小长度校验 `CONTENT_EMPTY`/`CONTENT_TOO_SHORT`，五轮 #5；超过 `GUIDE_MAX_LEN` 拒 `CONTENT_TOO_LONG`，六轮 #1） |
| PATCH | `/guides/:id` | 编辑自己的攻略（重新审核；同样非空 + 最小长度校验，五轮 #5；超过 `GUIDE_MAX_LEN` 拒 `CONTENT_TOO_LONG`，六轮 #1；由 rejected 复审通过→approved 时强制触发默认攻略重算，六轮 #4）；**八轮 #2：重新审核被拒且该攻略当前 `is_default=TRUE` 时，取消默认位并强制 `recomputeDefaultGuide`，确保默认攻略恒为 approved，响应 `is_default_changed`**；**八轮 #4：被拒写入 `rejection_reason`、复审通过清空** |
| DELETE | `/guides/:id` | 删除自己的攻略（**仅删攻略本身**；其下直接子评论迁移挂载点到景点 `spot`，避免公开孤儿，五轮 #1；若为默认则重算；物理删除时同步清理其关联 `vote` 孤儿记录，六轮 #3） |
| POST | `/vote` | 赞/不赞/撤回（`target_type`: spot/guide/**comment**）；目标评论已软删→`400 TARGET_DELETED`（五轮 #3）；**目标已被物理删除（guide/spot/comment）→`404 TARGET_NOT_FOUND`**（七轮 #5）；`is_default_changed` 仅 `target_type='guide'` 时可能 true（五轮 #4）；**重复相同投票幂等**——`value` 相同直接返回当前状态、不改计数（六轮 #6） |
| GET | `/comments?parent_type=&parent_id=&sort=time\|ai_helpful&mine=1&page=&size=` | 评论树（**仅返回 approved**，评审 #3；`mine=1` 返回自己全部；根评论分页，评审 #10；子评论 load-more 见下）；**`sort` 缺省默认 `time`（按 `created_at` 升序）**（七轮 #7）；**`mine=1` 且 `parent_type`/`parent_id` 皆缺省则返回用户作为作者参与的所有评论线程**（收集其全部评论 `root_id` 去重，返回根评论+子树，故本人发起与回复过的讨论均可见，八轮 #3）；`mine=1` 若只传其一→`400 MISSING_PARENT`；`mine=0`（默认）二者必填否则 `400 MISSING_PARENT`（六轮 #2）；响应中 `children` 恒为数组（L2/load-more 场景为 `[]`，六轮 #9）；已软删评论的 `ai_review` 一律为 `null`（六轮 #5）；**八轮 #4：mine=1 视图的评论带 `rejection_reason`** |
| GET | `/comments?parent_type=comment&parent_id=<根评论id>&sort=time` | 子评论 load-more 入口（当根评论 `children_truncated=true`，四轮 #8）；**返回的子评论 `children` 恒为 `[]`**，前端可安全忽略（六轮 #9） |
| POST | `/comments` | 发评论（**审核通过后才入队 AI 评价**，评审 #7；XSS 转义，评审 #13；受审核 + 限流；非空 + 最小长度校验 `CONTENT_EMPTY`/`CONTENT_TOO_SHORT`，五轮 #5；超过 `CONTENT_MAX_LEN` 拒 `CONTENT_TOO_LONG`，六轮 #1；父评论已软删→`400 TARGET_DELETED`，五轮 #3；响应 `reply_to` 为 `{user_id(掩码),nickname}` 对象，五轮 #2） |
| PATCH | `/comments/:id` | 编辑自己的评论（重新审核；被拒则移除其 AI 评价；重新入队期间旧 AI 短评保留，前端灰显勿清空，四轮 #9；已软删→`400 TARGET_DELETED`，五轮 #3；非空 + 最小长度校验，五轮 #5；超过 `CONTENT_MAX_LEN` 拒 `CONTENT_TOO_LONG`，六轮 #1）；**八轮 #4：被拒写入 `rejection_reason`、复审通过清空** |
| DELETE | `/comments/:id` | 删除自己的评论（**有子节点则软删占位 status=deleted 保留子树**；叶子物理删并清 AI 评价，四轮 #2；已软删→`400 TARGET_DELETED`，五轮 #3；**叶子物理删除时同步清理其关联 `vote` 孤儿记录**，六轮 #3） |
| GET | `/admin/ai-review-failed` | 诊断 AI 评价 `failed` 清单 `{count, items}`（仅 DEV_MODE，四轮 #7） |

写操作需在 Header 带 `Authorization: Bearer <token>`。

## 关键设计（含评审修订）

- **综合排序（动态权重，评审 #6 方案 A）**：`w_system = K/(N+K)`、`w_user = N/(N+K)`，`composite = max(0, 100*(w_system*S + w_user*R))`。
  - `N=0`（无投票）→ 纯系统分（冷启动保护）；
  - `N→∞` → 纯用户分（群体智慧完全主导，系统分退场）。
  - 四轮 #5：`composite` 下限截断到 0（R∈[-1,1] 在 N 极大且全差评时可能为负，亲子场景不展示负分；内部 `R` 仍保留真实符号供「差评」标签）。
  - 解决了"固定 50% 系统分"的算法天花板。`S`=系统分/100，`R`=用户净赞率（`N=0` 时 `R=0`），`K=10` 置信度衰减。AI 不参与景点排名。
- **默认攻略进化（评审 #1）**：**system 种子不参与净赞比较**；仅用户攻略间竞争默认位，净赞最高者置默认；所有用户攻略净赞 ≤0（或无用户攻略）时，**强制回退 system 种子**。
- **评论 2 层 + root_id（评审 #2）**：回复评论时 `parent_id` 指向直接父、`rootId` 指向根、`replyToUserId` 记被回复者；回复 L2 自动挂根并展示「回复 @某人」，视觉恒 ≤2 层且语义不丢。评论含 `dislikes`（评审 #1）。
- **评论 AI 评价（评审 #5/#7/#12/#13）**：**仅"审核通过"的评论才入队**；`setTimeout` 递归 Worker 每批 10 条异步回填；失败自增 `retry_count`，上限 3 次转 `failed`；重启扫描 pending 续跑；template 规则已文档化于 `ai.js`。
  - 四轮 #7（failed 兜底）：`GET /admin/ai-review-failed`（DEV_MODE）查 failed 清单；`AI_REVIEW_AUTO_RETRY_FAILED=true` 时 Worker 每轮将 `failed 且 retry_count<上限` 复活为 pending 重新入队（生产默认关闭，由运维按需开启）。
- **ai_helpful 排序（评审 #11）**：pending 评论 `helpful_score` 视为 0，并以 `created_at` 倒序兜底，新评论不被沉底。
- **内容审核（评审 #6/#13）**：`/guides`、`/comments` 入库前过 `moderate.js`（本地敏感词 + 手机/微信/外链正则 + **HTML 实体转义**），命中即拒；被拒不入队 AI；预留微信 `msgSecCheck`。**拒绝统一返回 HTTP 422 + `{error:"CONTENT_REJECTED", message:"<原因>"}`**（第三轮 #5，攻略/评论 POST/PATCH 一致）。
- **UGC 增删改（评审 #4/#12 + 四轮 #1/#2 + 五轮 #1/#2/#3/#5）**：攻略/评论支持 PATCH/DELETE，仅本人。
  - **删攻略（五轮 #1）**：仅删攻略本身；其下**直接子评论（`parentType='guide'`）迁移挂载点到景点**（`parentType='spot'`，`parentId=`所属 `spotId`），语义由「回复攻略」转「回复景点」，投票/AI/子树延续，避免公开孤儿；被删攻略为默认则触发重算。
  - **删评论（四轮 #2）**：有子节点则**软删**（`content=null, userId=null, status='deleted'`，占位保留子树与其 AI 评价）；叶子评论物理删除并清 `ai_review`；返回 `{ok, soft_deleted}`。子评论是他人 UGC，数据所有权独立，不再级联删除。
  - **软删状态机护栏（五轮 #3）**：对已软删评论的 `/vote`、`PATCH`、`DELETE` 一律返回 `400 TARGET_DELETED`；`POST /comments` 父评论已软删→`400 TARGET_DELETED`（物理删除→404；rejected 父评论允许追加，仅 mine=1 可见）。
  - **内容质量（五轮 #5）**：攻略/评论 POST/PATCH 前置校验非空（`CONTENT_EMPTY`）+ 最小长度（`CONTENT_TOO_SHORT`，`CONTENT_MIN_LEN` 默认 5），先于限流/审核，避免空白卡或无效内容入库。
- **reply_to 昵称对象（五轮 #2）**：评论响应中 `reply_to` 为与 `author` 对称的对象 `{user_id(掩码), nickname}`，供「回复 @某人」展示昵称；后端组装时由 `user` 表解析。旧 `reply_to_user`(字符串) 已废弃——它曾直接暴露原始 openid（PII 泄露），现一并修复。
- **system 官方账号（五轮 #7）**：`seed.js` 写入 `user` 表 `openid='system'`（`nickname:'官方推荐'`），使 system 种子攻略的 `author` 带官方背书而非匿名。
- **spots 过滤（五轮 #8）**：`GET /spots` 支持 `city`/`category` 精确匹配（可单独或组合），与 `sort` 互不影响。
- **距离排序缺坐标（五轮 #9）**：`sort=distance` 需 `lat`/`lng` 必填，缺失返回 `400 MISSING_COORDS`；前端未授权定位应回退 `sort=composite`。
- **投票语义（五轮 #4）**：`POST /vote` 响应 `is_default_changed` 仅当 `target_type='guide'` 时可能为 `true`（触发默认重算），spot/comment 恒 `false`，前端可忽略。
- **前端防抖（五轮 #6）**：所有投票按钮前端防抖 300ms 内禁止重复提交，降低竞态；后端唯一索引兜底。
- **UGC 最大长度（六轮 #1）**：评论/攻略 POST/PATCH 在「非空 → 最小长度 → 最大长度 → 限流 → 审核」顺序中校验最大长度，超过 `CONTENT_MAX_LEN`(2000)/`GUIDE_MAX_LEN`(10000) 返回 `400 CONTENT_TOO_LONG`，防止 JSON 文件膨胀、前端渲染卡顿与 AI Worker 超时。
- **mine=1 父节点可选（六轮 #2）**：`GET /comments?mine=1` 若不传 `parent_type`/`parent_id`（二者皆缺），返回当前用户**全部根评论**（跨景点/攻略），按 sort 排序并根评论分页；若只传其一返回 `400 MISSING_PARENT`；`mine=0`（默认公开列表）二者必填否则 `400 MISSING_PARENT`。
- **物理删除清理 vote 孤儿（六轮 #3）**：删除攻略或叶子评论（物理删除）时同步清理 `vote` 表中 `target_type` 同构且 `target_id` 匹配的记录，避免投票表无限膨胀；软删评论**不清理**（其记录仍保留以正确展示子树占位）。
- **rejected 攻略复审触发默认进化（六轮 #4）**：`PATCH /guides/:id` 重新审核通过、且状态由非 approved（如 rejected）转 approved 时，强制触发 `recomputeDefaultGuide`，与该攻略被投票后的默认重算逻辑一致。
- **软删评论 AI 评价不展示（六轮 #5）**：`buildCommentView` 对 `status='deleted'` 的评论强制 `ai_review=null`，前端不再显示已软删评论的 AI 短评。
- **重复投票幂等（六轮 #6）**：`POST /vote` 当已存在同 `value` 投票时直接返回当前状态、不报错误、不改计数；仅当 `value` 不同（改票）才重写。
- **spots 默认排序 composite（六轮 #7）**：`GET /spots` 缺省 `sort=composite`，前端不传 sort 即按综合排序返回，无需显式指定。
- **账号注销预留（六轮 #8）**：`DELETE /auth/me` 仅文档标注（MVP 不实现），未来做账号删除——以污点化（标记删除）而非物理删为宜，保留他人对 UGC 的引用完整性。
- **load-more children 恒为数组（六轮 #9）**：子评论 load-more（及任意 L2 视图）响应中 `children` 恒为 `[]`，前端可安全忽略该字段，统一渲染逻辑。
- **攻略详情可选鉴权 + 状态过滤（七轮 #1）**：`GET /guides/:id` 公开时仅返回 `status='approved'`，其余（含 rejected/pending）一律 `404`，杜绝遍历 id 泄露被拒攻略全文；携带有效 token 且为作者本人则返回任意状态，满足查看/编辑自己被拒攻略的需求。
- **guides 列表净赞率排序（七轮 #2）**：`GET /spots/:id/guides` 按 `likes-dislikes` 降序（好内容浮上来），同分按 `createdAt` 降序（新优先），与默认攻略进化「净赞最高置默认」逻辑一致。
- **comment 软删与关系型约束兼容（七轮 #3）**：软删将 `user_id`/`content` 置 NULL，故 BLUEPRINT DDL 已移除二者 `NOT NULL`，关系型迁移须同步放宽，否则软删触发非空冲突。
- **跨景点本人攻略（七轮 #4）**：新增 `GET /guides?mine=1`，必须登录，返回当前用户跨全部景点的攻略，按 `createdAt` 降序分页，列表同时带 `snippet` 与 `content` 全文（本人内容无需截断）。
- **vote 物理删除目标（七轮 #5）**：`POST /vote` 的 `target_id` 指向物理删除的 guide/spot/comment → `404 TARGET_NOT_FOUND`；软删评论（记录仍在）→ `400 TARGET_DELETED`（五轮 #3）。两者分明。
- **GET /comments 默认排序（七轮 #7）**：`sort` 缺省默认为 `time`（按 `created_at` 升序），契约显式；`ai_helpful` 仍按 AI 有用度优先。
- **详情 my_vote（八轮 #1）**：`GET /spots/:id` 详情响应携带 `my_vote`（与列表项同构，依赖登录态解析当前用户投票），前端进入详情页即可正确初始化点赞按钮状态，无需重新投票探状态。
- **PATCH 攻略被拒不回退默认（八轮 #2）**：编辑攻略重新审核**被拒**且该攻略当前为默认时，取消其默认位并强制 `recomputeDefaultGuide`，确保默认攻略恒为 approved；`recomputeDefaultGuide` 同步改为仅考虑 approved 用户攻略（拒绝内容即便净赞>0 也不会成为默认）。
- **mine=1 含 L2 回复线程（八轮 #3）**：`GET /comments?mine=1` 缺父节点时返回用户**作为作者参与的所有评论线程**（收集其全部评论 `root_id` 去重，返回根评论+子树）；「我的评论」页既能看自己发起的讨论，也能看自己**回复过的讨论**（L2 以子树形式出现，凭 `root_id` 关联）。
- **审核拒绝原因持久化（八轮 #4）**：`guide`/`comment` 表新增 `rejection_reason`；审核被拒时写入，作者本人（mine/owner 视图）可见，前端提示「审核未通过：<原因>」，便于针对性修改；复审通过清空。公开视图恒为 `null`，不泄露。
- **限流滑动窗口（八轮 #5）**：评论/攻略限流为**滑动窗口**（统计「最近 60 分钟内」计数），非固定整点窗口，避免 23:59→00:00 边界被瞬间刷量（整点重置限额）的漏洞。
- **comment.parent_id ≤2 树（八轮 #6）**：DDL 注释修正——L1/L2 回复的 `parent_id` 均指向根评论 id（经 `reply_to_user` 记录实际被回复者），从而保证评论树深度恒 ≤2，与树实现一致。
- **ai_review.helpful_score 约束（八轮 #7）**：DDL 改为 `NUMERIC(3,2) CHECK (helpful_score BETWEEN 0 AND 1)`，显式约束业务 0~1，防止关系型迁移时越界写入。
- **COMMENT_MAX_CHILDREN 下限保护（八轮 #8）**：config 读取时 NaN 安全钳制 `Math.max(Number.isNaN(v) ? 50 : v, 1)`，未配置默认 50、0/负数自动提升到 1，避免子评论逻辑异常。
- **登录安全（评审 #5）**：`/auth/login` 仅返 `{token, expires_in}`，不泄露 `openid`；`/auth/me` 返回脱敏 `user_id`（掩码）+ 昵称/头像。
- **限流（评审 #7）**：每景点每用户每日 1 条攻略、每用户每小时 10 条评论（内存滑动窗，单实例）。⚠️ 内存计数**重启即清零**（第三轮 #6，MVP 妥协）；生产多实例/高可用须改外部共享计数（如 Redis），否则重启后限流失效、多实例会漏限。
- **spot 删除级联清理（第三轮 #7）**：`comment`/`guide` 借 `REFERENCES spot(id) ON DELETE CASCADE` 级联；但 `vote`/`ai_review` 仅以 `target_id` 间接关联、**不会**随外键清理。删 spot 须显式清孤儿（见 BLUEPRINT §2.1）；当前无 `DELETE /spots` 接口。
- **Token（评审 #14）**：签发 7 天有效期，过期 `verifyToken` 返回 null → 前端收 401 重新 `wx.login`。
- **持久化与一致性（评审 #3/#4/#8）**：`db.js` 采用「临时文件 + rename」原子写 + 写锁串行；**每次写前滚动备份 3 份**（`db.json.bak.1/2/3`）。**JSON 存储仅支持单实例部署**；多实例请用 SQLite/PostgreSQL（repository 层可平滑替换）。
- **进程管理与部署（pm2）**：生产用 **pm2** 托管（`ecosystem.config.cjs`，`instances:1` 单实例，`uid/gid=kts` 降权运行，`autorestart` 兜底崩溃，监听仅 `127.0.0.1` 由 nginx 反代）；`/healthz` 供 pm2/nginx 探活。独立子域名 **`your-api.example.com`** 部署（新增 nginx 站点文件，不触碰现有 `your-server.example.com`），详见 `deploy/` 目录与 `kids_trip_deploy_plan.md`。
- **距离优先（评审 #10）**：`/spots?sort=distance&lat=&lng=` 按 Haversine 距离升序。
  - 四轮 #6（分页漂移）：距离排序基于坐标快照，用户移动/刷新会导致 offset 分页错位。短期限制距离模式 ≤3 页；长期改**游标分页**（cursor=上一页最远景点距离阈值+id）。
- **评论分页（评审 #10）**：`/comments` 仅对**根评论**分页（`page/size`），子评论随根一并返回；被 `children_truncated` 截断时可经 `GET /comments?parent_type=comment&parent_id=<根评论id>` 拉取剩余子评论（四轮 #8）。
