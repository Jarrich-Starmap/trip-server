// 运行配置：所有敏感值必须通过环境变量注入，仓库中不含真实凭证。
// 部署前请设置 WECHAT_APPID / WECHAT_SECRET / TOKEN_SECRET / PUBLIC_BASE。
import path from 'node:path';
export const CONFIG = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  // 监听地址：默认仅环回 127.0.0.1（安全基线，公网不可达）。
  // 部署前置 nginx 反代到 127.0.0.1:PORT 即可；本机外访问（如局域网调试）设 HOST=0.0.0.0。
  HOST: process.env.HOST || '127.0.0.1',
  WECHAT_APPID: process.env.WECHAT_APPID || 'YOUR_WECHAT_APPID',
  WECHAT_SECRET: process.env.WECHAT_SECRET || 'YOUR_WECHAT_SECRET',
  // 开发兜底：当无法访问微信接口（如本地无外网）时，用伪 openid 保证服务可跑。
  // 生产部署设 DEV_MODE=false 即关闭兜底，强制走真实 code2session。
  DEV_MODE: process.env.DEV_MODE !== 'false',
  TOKEN_SECRET: process.env.TOKEN_SECRET || 'YOUR_TOKEN_SECRET',
  // Token 有效期（天）。过期后 verifyToken 返回 null → 前端收 401 重新 wx.login 换 token（见 BLUEPRINT §6）。
  TOKEN_TTL_DAYS: parseInt(process.env.TOKEN_TTL_DAYS || '7', 10),
  DATA_FILE: process.env.DATA_FILE || './data/db.json',
  // 综合排序（§4.1 · 评审 v4 #6 方案 A）。
  // 权重随投票数 N 动态衰减：w_system = K/(N+K)，w_user = N/(N+K)。
  //   - N=0 时纯系统分（冷启动保护）；N→∞ 时纯用户分（群体智慧完全主导）。
  //   - 不再使用固定 0.5/0.5，避免"系统分永远占 50%"的算法天花板。
  // K = 先验强度：K 越大，用户票需要更多才能压过系统分。
  SORT: { K: 10 },
  // 分页默认（评审 #10）
  PAGE: { DEFAULT_SIZE: 20, MAX_SIZE: 50 },
  // 评论树子评论上限（第三轮评审 #9）：每个根评论下最多返回 50 条子评论，超出标记 children_truncated:true。
  // 八轮 #8：下限保护——未配置默认 50；配置为 0 或负数时自动提升到 1（NaN 安全，避免 0 被 || 误判为未配置而跳到 50），杜绝子评论逻辑异常。
  COMMENT_MAX_CHILDREN: (() => { const v = parseInt(process.env.COMMENT_MAX_CHILDREN, 10); return Math.max(Number.isNaN(v) ? 50 : v, 1); })(),
  // AI 评价模型：template(规则兜底，零成本) | qianfan | tongyi（预留）
  AI_MODEL: process.env.AI_MODEL || 'template',
  // 异步 AI 评价 Worker（§7.2 / 评审 #5）
  AI_WORKER_INTERVAL_MS: parseInt(process.env.AI_WORKER_INTERVAL_MS || '1000', 10),
  AI_WORKER_BATCH: parseInt(process.env.AI_WORKER_BATCH || '10', 10),
  AI_REVIEW_MAX_RETRY: parseInt(process.env.AI_REVIEW_MAX_RETRY || '3', 10),
  // 四轮 #7：AI 评价失败的自动续跑（仅限 retry_count < 上限 的 failed 记录）。适合网络抖动导致的临时失败；顽固失败仍留待人工排查。
  AI_REVIEW_AUTO_RETRY_FAILED: process.env.AI_REVIEW_AUTO_RETRY_FAILED === 'true',
  // 限流（评审 #7）：内存滑动窗，单实例有效；多实例需换 Redis。
  RATE_LIMIT: {
    guidePerSpotPerDay: parseInt(process.env.RL_GUIDE_PER_SPOT_DAY || '1', 10),
    commentPerHour: parseInt(process.env.RL_COMMENT_PER_HOUR || '10', 10)
  },
  // 五轮 #5：UGC 内容最小长度（trim 后字符数），低于则拒 CONTENT_TOO_SHORT（攻略/评论 POST，编辑同构）
  CONTENT_MIN_LEN: parseInt(process.env.CONTENT_MIN_LEN || '5', 10),
  // 六轮 #1：UGC 内容最大长度，超过则拒 CONTENT_TOO_LONG（防止 JSON 文件膨胀 / 前端渲染卡顿 / AI Worker 超时）
  CONTENT_MAX_LEN: parseInt(process.env.CONTENT_MAX_LEN || '2000', 10),   // 评论上限，默认 2000 字
  GUIDE_MAX_LEN: parseInt(process.env.GUIDE_MAX_LEN || '10000', 10),      // 攻略上限，默认 10000 字
  // UGC 内容审核（评审 #6）：MVP 本地正则+敏感词；enable=false 时关闭（仅限测试）。
  MODERATION: { enable: process.env.MODERATION !== 'false' },
  // 头像上传（从微信 chooseAvatar 获取临时文件 → base64 上传 → 持久化静态文件）
  PUBLIC_BASE: process.env.PUBLIC_BASE || 'https://your-api.example.com',
  // 头像存储目录：默认跟 DATA_FILE 同目录下的 avatars/；可由 AVATAR_DIR 覆盖
  AVATAR_DIR: process.env.AVATAR_DIR || (() => {
    const f = process.env.DATA_FILE || './data/db.json';
    return path.join(path.dirname(path.resolve(process.cwd(), f)), 'avatars');
  })(),
  AVATAR_MAX_BYTES: parseInt(process.env.AVATAR_MAX_BYTES || '2097152', 10), // 2MB
  // 攻略/景点照片上传（与头像机制一致：base64 → 落盘 → 返回公开 URL → /uploads/ 静态服务）
  // 目录默认跟 DATA_FILE 同目录下的 uploads/；可由 UPLOAD_DIR 覆盖
  UPLOAD_DIR: process.env.UPLOAD_DIR || (() => {
    const f = process.env.DATA_FILE || './data/db.json';
    return path.join(path.dirname(path.resolve(process.cwd(), f)), 'uploads');
  })(),
  UPLOAD_MAX_BYTES: parseInt(process.env.UPLOAD_MAX_BYTES || '10485760', 10), // 10MB
  // 单篇攻略最多照片数（防 JSON 膨胀 / 前端渲染压力）
  PHOTO_MAX_PER_GUIDE: parseInt(process.env.PHOTO_MAX_PER_GUIDE || '9', 10),
  // 微信图片内容安全校验 imgSecCheck（生产默认开启；DEV_MODE 下自动跳过以便本地联调）
  IMG_SEC_CHECK: process.env.IMG_SEC_CHECK !== 'false'
};
