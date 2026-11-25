// kids-trip 后端服务（零依赖 Node，node server.js 即跑）。
// 分层：http 路由 / 业务聚合 / 数据访问(db) / AI 服务 / 微信登录 / 排序 / 审核 / 限流。
//
// v4 修订覆盖（评审 v4 #1-#13）：
//  #1 comment 表补齐 dislikes（与 vote 同构同步）
//  #2 spot 表冗余 likes/dislikes
//  #3 GET /comments 仅返回 approved（mine=1 返回自己全部）
//  #4 UGC 删除/编辑（攻略/评论）+ 级联清理 + 默认重算
//  #5 登录不返回 openid；新增 /auth/me 脱敏
//  #6 综合排序权重随投票数动态衰减（方案 A）
//  #7 审核通过后才触发 AI 评价
//  #8 3 份滚动备份（见 db.js）
//  #9 user 表（昵称/头像）
//  #10 评论根评论分页（page/size）
//  #11 攻略列表返回 snippet，详情/单条返回全文
//  #12 删除时级联清理 ai_review（孤儿数据）
//  #13 UGC 内容入库前 HTML 实体转义
import http from 'node:http';
import fs from 'node:fs';
import nodePath from 'node:path';
import crypto from 'node:crypto';
import { CONFIG } from './config.js';
import { db } from './db.js';
import { loginWithCode, verifyToken, imgSecCheck } from './wechat.js';
import { compositeScore, netApproval, recomputeDefaultGuide, withDistance } from './sort.js';
import { generateCommentReview } from './ai.js';
import { moderate, escapeHtml } from './moderate.js';
import { seedIfEmpty } from './seed.js';
// 阶段 2：按 Accept-Language 返回景点/系统攻略译文（用户 UGC 不翻译）
import { localeOf, localizeSpot, guideContent, DEFAULT_LOCALE, translationCount, liveTranslationCount, watchTranslations } from './i18n.js';

seedIfEmpty();

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
function auth(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? verifyToken(m[1]) : null;
}

// ── 工具 ──
function maskUserId(openid) {
  if (!openid) return '';
  const n = openid.length;
  return openid.slice(0, 4) + '****' + (n > 6 ? openid.slice(-2) : '');
}
function truncate(s, n) {
  const t = s || '';
  return t.length > n ? t.slice(0, n) + '…' : t;
}
// 用户视图（脱敏，评审 #5/#9）：绝不带 openid
function userView(openid) {
  const u = openid ? db.getUser(openid) : null;
  return { user_id: maskUserId(openid), nickname: u?.nickname || '', avatar_url: u?.avatar_url || '' };
}

// ── 限流（评审 #7 · 内存滑动窗，单实例有效）──
const rlBuckets = new Map();
function isRateLimited(key, limit, windowMs) {
  const now = Date.now();
  const arr = (rlBuckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { rlBuckets.set(key, arr); return true; }
  arr.push(now);
  rlBuckets.set(key, arr);
  return false;
}
const DAY = 86400000, HOUR = 3600000;

// ── 异步 AI 评价流水线（评审 #5 · 递归 setTimeout + 批量 + 重试 + 重启自恢复）──
// 仅"审核通过"的评论入队(pending)（评审 #7）；Worker 每 AI_WORKER_INTERVAL_MS 拉一批(<=BATCH)回填 done；
// 失败自增 retry_count，达上限转 failed；重启后扫描 pending 自动续跑。
function enqueueReview(targetType, targetId) {
  const existing = db.getAiReview(targetType, targetId);
  if (existing) { existing.status = 'pending'; existing.updatedAt = new Date().toISOString(); db.persist(); return; }
  const id = db.nextId('aiReviews');
  db.data.aiReviews.push({
    id, targetType, targetId, summary: '', helpfulScore: 0,
    status: 'pending', model: CONFIG.AI_MODEL, retry_count: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  db.persist();
}
async function runAiWorkerOnce() {
  // 四轮 #7：自动续跑 failed（限 retry_count < 上限），适合临时网络抖动；顽固失败仍留待人工排查/GET /admin/ai-review-failed
  if (CONFIG.AI_REVIEW_AUTO_RETRY_FAILED) {
    let revived = 0;
    for (const r of db.data.aiReviews) {
      if (r.status === 'failed' && (r.retry_count || 0) < CONFIG.AI_REVIEW_MAX_RETRY) {
        r.status = 'pending'; r.updatedAt = new Date().toISOString(); revived++;
      }
    }
    if (revived) db.persist();
  }
  const pending = db.getPendingReviews();
  if (!pending.length) return;
  const batch = pending.slice(0, CONFIG.AI_WORKER_BATCH);
  for (const r of batch) {
    let content = '';
    if (r.targetType === 'comment') {
      const c = db.getComment(r.targetId);
      if (!c || c.status !== 'approved') { // 已删除或审核未通过，丢弃该评价任务（评审 #7/#12）
        r.status = 'failed'; r.summary = '目标评论不可评价'; r.updatedAt = new Date().toISOString(); continue;
      }
      content = c.content;
    }
    try {
      const { summary, helpfulScore } = CONFIG.AI_MODEL === 'template'
        ? generateCommentReview(content)
        : await generateCommentReview(content); // TODO: 接入文心/通义时替换为真实调用
      r.summary = summary; r.helpfulScore = helpfulScore; r.status = 'done';
    } catch (e) {
      r.retry_count = (r.retry_count || 0) + 1;
      r.status = r.retry_count >= CONFIG.AI_REVIEW_MAX_RETRY ? 'failed' : 'pending';
    }
    r.updatedAt = new Date().toISOString();
  }
  db.persist();
}
function startAiWorker() {
  const tick = async () => {
    try { await runAiWorkerOnce(); } catch (e) { console.error('[ai-worker]', e); }
    setTimeout(tick, CONFIG.AI_WORKER_INTERVAL_MS);
  };
  tick();
}
startAiWorker();

// ── 视图组装 ──
// locale 缺省为简体，此时全链路零额外开销（localizeSpot/guideContent 直接短路返回原值）。
// 攻略封面解析：优先显式 cover_url，否则取 photos[0]
function guideCover(g) {
  if (g.cover_url) return g.cover_url;
  if (Array.isArray(g.photos) && g.photos.length) return g.photos[0];
  return null;
}
// 校验并清洗照片 URL 数组：仅接受本服务下发的 /uploads/ 链接（杜绝外链/SSRF/存储型 XSS）
function sanitizePhotoUrls(arr) {
  if (arr == null) return [];
  if (!Array.isArray(arr)) return [];
  const prefix = CONFIG.PUBLIC_BASE + '/uploads/';
  const out = [];
  for (const u of arr) {
    if (typeof u === 'string' && u.length <= 500 && u.indexOf(prefix) === 0) out.push(u);
    if (out.length >= CONFIG.PHOTO_MAX_PER_GUIDE) break;
  }
  return out;
}
function sanitizeCoverUrl(u) {
  const prefix = CONFIG.PUBLIC_BASE + '/uploads/';
  return (typeof u === 'string' && u.length <= 500 && u.indexOf(prefix) === 0) ? u : null;
}
function guidePhotoView(g) {
  return { photos: Array.isArray(g.photos) ? g.photos : [], cover_url: guideCover(g) };
}
function buildSpotView(spot, openid, locale = DEFAULT_LOCALE) {
  const c = compositeScore(spot);
  const guides = db.getGuidesBySpot(spot.id);
  const def = guides.find(g => g.isDefault);
  const myVote = openid ? (db.getVote(openid, 'spot', spot.id)?.value || 0) : 0;
  // 译文覆盖：name/desc/highlights/feeLabel/categoryCn/city（缺译自动回退简体）
  const s = localizeSpot(spot, locale);
  return {
    id: spot.id, name: s.name, city: s.city, cityKey: spot.city, category: spot.category, categoryCn: s.categoryCn,
    desc: s.desc, highlights: s.highlights, address: spot.address, feeLabel: s.feeLabel,
    lat: spot.lat, lng: spot.lng,
    photos: Array.isArray(spot.photos) ? spot.photos : [],
    composite_score: c.composite, net_approval: c.netApproval, vote_count: c.voteCount,
    likes: c.likes, dislikes: c.dislikes,
    guide_count: guides.length,
    default_guide: def
      ? { id: def.id, snippet: guideContent(def, spot, locale).slice(0, 50), source: def.source, author: userView(def.userId), ...guidePhotoView(def) }
      : null,
    my_vote: myVote
  };
}

// comment 视图；includeAllStatus=true 时递归子评论不受 approved 过滤（用于 mine/owner 查看）
function buildCommentView(c, openid, includeAllStatus, recursive) {
  const isDeleted = c.status === 'deleted';
  const ai = isDeleted ? null : db.getAiReview('comment', c.id);
  const view = {
    id: c.id, userId: isDeleted ? null : c.userId, author: userView(isDeleted ? null : c.userId),
    content: isDeleted ? null : c.content, deleted: isDeleted, created_at: c.createdAt,
    likes: c.likes, dislikes: c.dislikes || 0,
    my_vote: openid ? (db.getVote(openid, 'comment', c.id)?.value || 0) : 0,
    root_id: c.rootId,
    // 五轮 #2：reply_to 改为与 author 对称的对象（含昵称），同时避免直接暴露 openid（旧 reply_to_user 曾泄漏原始 openid）
    reply_to: c.replyToUserId
      ? { user_id: maskUserId(c.replyToUserId), nickname: db.getUser(c.replyToUserId)?.nickname || '微信用户' }
      : null,
    status: c.status,
    // 八轮 #4：拒绝原因仅对作者本人（mine/owner 视图，includeAllStatus=true）返回；公开列表恒为 null，杜绝泄露
    rejection_reason: includeAllStatus ? (c.rejectionReason || null) : null,
    // 六轮 #9：children 恒为数组；L2/load-more（recursive=false）返回 []，前端可安全忽略
    children: [],
    ai_review: ai ? { summary: ai.summary, helpfulScore: ai.helpfulScore, status: ai.status } : null
  };
  if (recursive) {
    let kids = db.getCommentsByParent('comment', c.id)
      .filter(k => includeAllStatus ? (k.userId === openid) : (k.status === 'approved'))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map(k => buildCommentView(k, openid, includeAllStatus, false));
    // 第三轮评审 #9：每个根评论下子评论上限保护，超出截断并标记 children_truncated
    if (kids.length > CONFIG.COMMENT_MAX_CHILDREN) {
      kids = kids.slice(0, CONFIG.COMMENT_MAX_CHILDREN);
      view.children_truncated = true;
    }
    view.children = kids;
  }
  return view;
}

// 评论列表（评审 #3 status 过滤 + #10 根评论分页）
function getCommentsList(parentType, parentId, sort, openid, mine, page, size) {
  let roots = db.getCommentsByParent(parentType, parentId);
  if (mine) {
    if (!openid) return { comments: [], total: 0, page, size, sort };
    roots = roots.filter(c => c.userId === openid);
  } else {
    roots = roots.filter(c => c.status === 'approved' || c.status === 'deleted'); // 软删的根评论保留占位，使其子评论仍可展示（四轮 #2）
  }
  if (sort === 'ai_helpful') {
    roots.sort((a, b) => {
      const sa = a.ai_review && a.ai_review.status === 'done' ? a.ai_review.helpfulScore : 0;
      const sb = b.ai_review && b.ai_review.status === 'done' ? b.ai_review.helpfulScore : 0;
      if (sb !== sa) return sb - sa;
      return new Date(b.createdAt) - new Date(a.createdAt); // pending 视为 0，新者靠前（评审 #11）
    });
  } else {
    roots.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }
  const total = roots.length;
  const start = (page - 1) * size;
  const items = roots.slice(start, start + size).map(r => buildCommentView(r, openid, mine, true));
  return { comments: items, total, page, size, sort };
}

// 八轮 #3：mine=1 且不带父节点时，返回用户「作为作者参与的所有评论线程」。
// 原六轮 #2 仅列用户自己的「根评论」，导致用户发出的 L2 回复在「我的评论」页完全不可见（产品功能缺口）。
// 现收集该用户全部评论（根或 L2）的 root_id 去重，返回这些根评论及其子树：
//   - 用户发起的讨论（自己作为根）自然包含；
//   - 用户回复过的讨论（L2 挂在他人根下）也包含，L2 回复以子树形式出现在对应根评论的 children 中；
// 根评论过滤：approved 或本人所发（避免泄露他人未通过的讨论），子树仅展示作者本人内容（buildCommentView recursive + includeAllStatus）。
function getMyParticipatedThreads(sort, openid, page, size) {
  const myComments = db.data.comments.filter(c => c.userId === openid);
  const rootIds = new Set();
  for (const c of myComments) rootIds.add(c.rootId || c.id);
  let roots = db.data.comments.filter(c => rootIds.has(c.id) && (c.status === 'approved' || c.userId === openid));
  if (sort === 'ai_helpful') {
    roots.sort((a, b) => {
      const sa = a.ai_review && a.ai_review.status === 'done' ? a.ai_review.helpfulScore : 0;
      const sb = b.ai_review && b.ai_review.status === 'done' ? b.ai_review.helpfulScore : 0;
      if (sb !== sa) return sb - sa;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  } else {
    roots.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }
  const total = roots.length;
  const start = (page - 1) * size;
  const items = roots.slice(start, start + size).map(r => buildCommentView(r, openid, true, true));
  return { comments: items, total, page, size, sort };
}

// ── 路由 ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;
  const openid = auth(req);
  // 阶段 2：请求语言（zh-CN / zh-HK / en），解析失败或不支持时回退简体
  const locale = localeOf(req);

  // 健康检查（部署/pm2/nginx 探活用，无副作用，不依赖任何外部资源）
  if (path === '/healthz' && method === 'GET') {
    // i18n_spots：活景点中被译文覆盖的数量（比总键数更有意义——排除 dedup 孤儿死键）
    return send(res, 200, { ok: true, ts: Date.now(), uptime: Math.round(process.uptime()), i18n_spots: liveTranslationCount(db.data.spots) });
  }

  // 头像静态托管（公开，无需鉴权；路径白名单天然防穿越）
  {
    const am = path.match(/^\/avatars\/([a-zA-Z0-9_-]+\.(?:png|jpe?g|webp|gif))$/);
    if (am && method === 'GET') {
      const file = nodePath.join(CONFIG.AVATAR_DIR, am[1]);
      // 双重保险：确保解析结果仍落在头像目录内
      if (file !== nodePath.join(CONFIG.AVATAR_DIR, am[1]) || !fs.existsSync(file)) {
        return send(res, 404, { error: 'not found' });
      }
      const ext = am[1].toLowerCase();
      const ctype = ext.endsWith('.png') ? 'image/png'
        : ext.endsWith('.gif') ? 'image/gif'
        : ext.endsWith('.webp') ? 'image/webp'
        : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(fs.readFileSync(file));
    }
  }

  // 攻略/景点照片静态托管（机制同头像；URL 由 /upload 接口下发，公开可读）
  {
    const um = path.match(/^\/uploads\/([a-zA-Z0-9_-]+\.(?:png|jpe?g|webp|gif))$/);
    if (um && method === 'GET') {
      const file = nodePath.join(CONFIG.UPLOAD_DIR, um[1]);
      if (file !== nodePath.join(CONFIG.UPLOAD_DIR, um[1]) || !fs.existsSync(file)) {
        return send(res, 404, { error: 'not found' });
      }
      const ext = um[1].toLowerCase();
      const ctype = ext.endsWith('.png') ? 'image/png'
        : ext.endsWith('.gif') ? 'image/gif'
        : ext.endsWith('.webp') ? 'image/webp'
        : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': ctype, 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(fs.readFileSync(file));
    }
  }

  try {
    // 登录（评审 #5：仅返回 token，不返回 openid；可选昵称/头像写入 user 表）
    if (path === '/auth/login' && method === 'POST') {
      const body = await readBody(req);
      const r = await loginWithCode(body.code);
      if ((body.nickname || body.avatar_url) && r.openid) {
        db.upsertUser(r.openid, { nickname: body.nickname, avatar_url: body.avatar_url });
        db.persist();
      }
      return send(res, 200, { token: r.token, expires_in: r.expires_in, dev: r.dev || false });
    }

    // 当前用户（脱敏，评审 #5/#9）
    if (path === '/auth/me' && method === 'GET') {
      if (!openid) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, userView(openid));
    }

    // 更新用户资料（四轮 #3：登录后补充昵称/头像，不必等 token 过期再登录）
    if (path === '/auth/me' && method === 'PATCH') {
      if (!openid) return send(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const patch = {};
      if (body.nickname !== undefined) patch.nickname = String(body.nickname).slice(0, 30);
      if (body.avatar_url !== undefined) patch.avatar_url = String(body.avatar_url).slice(0, 500);
      if (!Object.keys(patch).length) return send(res, 400, { error: '缺少 nickname 或 avatar_url' });
      db.upsertUser(openid, patch);
      db.persist();
      return send(res, 200, userView(openid));
    }

    // 头像上传（从微信 chooseAvatar 得到的临时文件 → 前端读 base64 → 此处落盘 → 返回公开 URL）
    if (path === '/upload/avatar' && method === 'POST') {
      if (!openid) return send(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const m = typeof body.data === 'string' && body.data.match(/^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/i);
      if (!m) return send(res, 400, { error: 'INVALID_AVATAR', message: '需 data:image/*;base64,...' });
      let buf;
      try { buf = Buffer.from(m[3], 'base64'); } catch { return send(res, 400, { error: 'INVALID_AVATAR' }); }
      if (buf.length < 64) return send(res, 400, { error: 'AVATAR_TOO_SMALL' });
      if (buf.length > CONFIG.AVATAR_MAX_BYTES) return send(res, 413, { error: 'AVATAR_TOO_LARGE', max: CONFIG.AVATAR_MAX_BYTES });
      const ext = ({ png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp', gif: 'gif' })[m[2].toLowerCase()] || 'png';
      const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
      try {
        fs.mkdirSync(CONFIG.AVATAR_DIR, { recursive: true });
        // 清理旧头像（仅当托管在本服务时），避免磁盘膨胀
        const old = db.getUser(openid)?.avatar_url || '';
        if (old.indexOf(CONFIG.PUBLIC_BASE + '/avatars/') === 0) {
          try { fs.unlinkSync(nodePath.join(CONFIG.AVATAR_DIR, old.split('/').pop())); } catch { /* 忽略 */ }
        }
        fs.writeFileSync(nodePath.join(CONFIG.AVATAR_DIR, name), buf);
      } catch (e) {
        console.error('[upload/avatar] save failed', e);
        return send(res, 500, { error: 'SAVE_FAILED' });
      }
      return send(res, 200, { url: CONFIG.PUBLIC_BASE + '/avatars/' + name });
    }

    // 攻略/景点照片上传（机制同头像：base64 落盘 → 返回公开 URL；体积更大且过微信 imgSecCheck 内容安全）
    if (path === '/upload' && method === 'POST') {
      if (!openid) return send(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const m = typeof body.data === 'string' && body.data.match(/^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/i);
      if (!m) return send(res, 400, { error: 'INVALID_IMAGE', message: '需 data:image/*;base64,...' });
      let buf;
      try { buf = Buffer.from(m[3], 'base64'); } catch { return send(res, 400, { error: 'INVALID_IMAGE' }); }
      if (buf.length < 64) return send(res, 400, { error: 'IMAGE_TOO_SMALL' });
      if (buf.length > CONFIG.UPLOAD_MAX_BYTES) return send(res, 413, { error: 'IMAGE_TOO_LARGE', max: CONFIG.UPLOAD_MAX_BYTES });
      // 内容安全：生产环境（非 DEV_MODE）走微信 imgSecCheck；任何失败（含校验服务异常）一律拒绝，确保内容可控
      if (CONFIG.IMG_SEC_CHECK && !CONFIG.DEV_MODE) {
        const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[m[2].toLowerCase()] || 'image/jpeg';
        try {
          const r = await imgSecCheck(buf, mime);
          if (!r.ok) return send(res, 422, { error: 'IMAGE_REJECTED', message: '图片未通过内容安全审核' });
        } catch (e) {
          console.error('[upload] imgSecCheck failed', e);
          return send(res, 502, { error: 'SEC_CHECK_UNAVAILABLE', message: '内容安全校验暂不可用，请稍后再试' });
        }
      }
      const ext = ({ png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp', gif: 'gif' })[m[2].toLowerCase()] || 'png';
      const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
      try {
        fs.mkdirSync(CONFIG.UPLOAD_DIR, { recursive: true });
        fs.writeFileSync(nodePath.join(CONFIG.UPLOAD_DIR, name), buf);
      } catch (e) {
        console.error('[upload] save failed', e);
        return send(res, 500, { error: 'SAVE_FAILED' });
      }
      return send(res, 200, { url: CONFIG.PUBLIC_BASE + '/uploads/' + name });
    }

    // 内部诊断（四轮 #7）：列出 failed 的 AI 评价，供运营排查/人工补跑；仅 DEV_MODE 暴露
    if (path === '/admin/ai-review-failed' && method === 'GET') {
      if (!CONFIG.DEV_MODE) return send(res, 404, { error: 'not found' });
      const items = db.data.aiReviews.filter(a => a.status === 'failed');
      return send(res, 200, { count: items.length, items });
    }

    // 景点列表（综合排序 / 距离优先 + 分页）
    if (path === '/spots' && method === 'GET') {
      const lat = url.searchParams.get('lat') ? parseFloat(url.searchParams.get('lat')) : null;
      const lng = url.searchParams.get('lng') ? parseFloat(url.searchParams.get('lng')) : null;
      const sort = url.searchParams.get('sort') || 'composite';
      // 五轮 #8：城市/分类过滤（精确匹配，可单独或组合，与 sort 互不影响）
      const city = url.searchParams.get('city');
      const category = url.searchParams.get('category');
      let spots = db.getSpots();
      if (city) spots = spots.filter(s => s.city === city);
      if (category) spots = spots.filter(s => s.category === category);
      let list = spots.map(s => withDistance(buildSpotView(s, openid, locale), lat, lng));
      // 五轮 #9：distance 排序要求 lat/lng 必填，缺失返回 400 MISSING_COORDS（前端应回退 composite）
      if (sort === 'distance') {
        if (lat == null || lng == null) return send(res, 400, { error: 'MISSING_COORDS', message: '距离排序需要提供 lat 和 lng' });
        list.sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
      } else {
        list.sort((a, b) => b.composite_score - a.composite_score);
      }
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
      const size = Math.min(CONFIG.PAGE.MAX_SIZE, Math.max(1, parseInt(url.searchParams.get('size') || String(CONFIG.PAGE.DEFAULT_SIZE), 10)));
      const start = (page - 1) * size;
      return send(res, 200, { items: list.slice(start, start + size), total: list.length, page, size, sort });
    }

    // 景点详情 + 默认攻略（全文）
    let m = path.match(/^\/spots\/(\d+)$/);
    if (m && method === 'GET') {
      const spot = db.getSpot(parseInt(m[1], 10));
      if (!spot) return send(res, 404, { error: 'spot not found' });
      const guides = db.getGuidesBySpot(spot.id);
      const def = guides.find(g => g.isDefault);
      return send(res, 200, {
        detail: {
          ...buildSpotView(spot, openid, locale),
          // 八轮 #1：详情接口与列表项同构，显式带 my_vote（buildSpotView 已含，此处再显式声明以固化契约，避免前端初始化点赞态缺失）
          my_vote: openid ? (db.getVote(openid, 'spot', spot.id)?.value || 0) : 0,
          default_guide: def ? {
            // 系统攻略按语言用模板重生成；用户 UGC 原样返回
            id: def.id, content: guideContent(def, spot, locale), source: def.source,
            likes: def.likes, dislikes: def.dislikes, author: userView(def.userId),
            ...guidePhotoView(def)
          } : null
        }
      });
    }

    // 某景点全部攻略（列表返回 snippet，评审 #11）
    // 四轮 #4：公开列表仅返回 status='approved'；mine=1 返回本人全部状态（含待审/被拒，供「我的攻略」）
    // 七轮 #2：排序按**净赞率 likes-dislikes 降序**（好内容浮上来），同分按 createdAt 降序（新优先），与默认攻略进化逻辑一致。
    m = path.match(/^\/spots\/(\d+)\/guides$/);
    if (m && method === 'GET') {
      const spotId = parseInt(m[1], 10);
      const mine = url.searchParams.get('mine') === '1';
      const spotOfGuides = db.getSpot(spotId); // 系统攻略按语言重生成时需要
      let guides = db.getGuidesBySpot(spotId);
      if (mine) {
        if (!openid) return send(res, 401, { error: 'unauthorized' });
        guides = guides.filter(g => g.userId === openid);
      } else {
        guides = guides.filter(g => (g.status || 'approved') === 'approved');
      }
      const list = guides
        .map(g => ({
          id: g.id, snippet: truncate(guideContent(g, spotOfGuides, locale), 120), likes: g.likes, dislikes: g.dislikes,
          isDefault: g.isDefault, source: g.source, status: g.status || 'approved',
          author: userView(g.userId), createdAt: g.createdAt,
          my_vote: openid ? (db.getVote(openid, 'guide', g.id)?.value || 0) : 0,
          rejection_reason: g.rejectionReason || null,
          ...guidePhotoView(g)
        }))
        .sort((a, b) => {
          const d = (b.likes - b.dislikes) - (a.likes - a.dislikes);
          return d !== 0 ? d : (new Date(b.createdAt) - new Date(a.createdAt));
        });
      return send(res, 200, { guides: list });
    }

    // 单条攻略全文（评审 #11）
    // 七轮 #1：可选鉴权 + 状态过滤——公开仅返回 status='approved'，否则 404（防遍历 id 泄露 rejected 全文）；
    //   作者本人（有效 token 且 userId 匹配）返回任意状态（含 rejected/pending），满足查看/编辑自己被拒攻略的需求。
    m = path.match(/^\/guides\/(\d+)$/);
    if (m && method === 'GET') {
      const g = db.getGuide(parseInt(m[1], 10));
      if (!g) return send(res, 404, { error: 'guide not found' });
      const isOwner = !!openid && openid === g.userId;
      if (!isOwner && (g.status || 'approved') !== 'approved') {
        return send(res, 404, { error: 'guide not found' });
      }
      return send(res, 200, {
        guide: {
          id: g.id, spotId: g.spotId, content: guideContent(g, db.getSpot(g.spotId), locale), likes: g.likes, dislikes: g.dislikes,
          isDefault: g.isDefault, source: g.source, status: g.status || 'approved',
          author: userView(g.userId), createdAt: g.createdAt,
          my_vote: openid ? (db.getVote(openid, 'guide', g.id)?.value || 0) : 0,
          rejection_reason: g.rejectionReason || null,
          ...guidePhotoView(g)
        }
      });
    }

    // 七轮 #4：跨景点查看本人全部攻略（个人中心「我的攻略」）。仅支持 mine=1，必须登录。
    // 按 createdAt 降序；列表同时返回 snippet 与 content 全文（本人内容无需截断隐藏）。
    if (path === '/guides' && method === 'GET') {
      const mine = url.searchParams.get('mine') === '1';
      if (!mine) return send(res, 400, { error: 'MINE_REQUIRED', message: '该接口仅支持 mine=1 查询本人攻略' });
      if (!openid) return send(res, 401, { error: 'unauthorized' });
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
      const size = Math.min(CONFIG.PAGE.MAX_SIZE, Math.max(1, parseInt(url.searchParams.get('size') || String(CONFIG.PAGE.DEFAULT_SIZE), 10)));
      let guides = db.data.guides.filter(g => g.userId === openid)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const total = guides.length;
      const start = (page - 1) * size;
      const items = guides.slice(start, start + size).map(g => ({
        id: g.id, spotId: g.spotId, snippet: truncate(g.content, 120), content: g.content,
        likes: g.likes, dislikes: g.dislikes, isDefault: g.isDefault, source: g.source,
        status: g.status || 'approved', author: userView(g.userId), createdAt: g.createdAt,
        my_vote: db.getVote(openid, 'guide', g.id)?.value || 0,
        rejection_reason: g.rejectionReason || null,
        ...guidePhotoView(g)
      }));
      return send(res, 200, { guides: items, total, page, size });
    }

    // 上传攻略（评审 #6 审核 + #13 XSS 转义；MVP 本地审核通过即 approved）
    if (path === '/guides' && method === 'POST') {
      if (!openid) return send(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const spot = db.getSpot(parseInt(body.spot_id, 10));
      if (!spot) return send(res, 404, { error: 'spot not found' });
      // 五轮 #5：非空 + 最小长度校验（前置，先于限流/审核，避免无效内容占用限流额度）
      if (!body.content || !body.content.trim()) return send(res, 400, { error: 'CONTENT_EMPTY', message: '内容不能为空' });
      if (body.content.trim().length < CONFIG.CONTENT_MIN_LEN) return send(res, 400, { error: 'CONTENT_TOO_SHORT', message: `内容至少 ${CONFIG.CONTENT_MIN_LEN} 个字` });
      // 六轮 #1：最大长度校验（顺序：非空→最小→最大→限流→审核）
      if (body.content.length > CONFIG.GUIDE_MAX_LEN) return send(res, 400, { error: 'CONTENT_TOO_LONG', message: `攻略最多 ${CONFIG.GUIDE_MAX_LEN} 字` });
      if (isRateLimited(`${openid}:guide:${spot.id}`, CONFIG.RATE_LIMIT.guidePerSpotPerDay, DAY)) {
        return send(res, 429, { error: '该景点今日攻略已达上限（1 条/天）' });
      }
      const content = escapeHtml(body.content.trim());
      const mod = moderate(content);
      if (!mod.ok) return send(res, 422, { error: 'CONTENT_REJECTED', message: mod.reason });
      const photos = sanitizePhotoUrls(body.photos);
      const cover_url = sanitizeCoverUrl(body.cover_url);
      const id = db.nextId('guides');
      const g = {
        id, spotId: spot.id, userId: openid, content,
        photos, cover_url,
        likes: 0, dislikes: 0, isDefault: false, source: 'user',
        status: 'approved', rejectionReason: null,
        createdAt: new Date().toISOString()
      };
      db.data.guides.push(g);
      db.persist();
      return send(res, 200, { guide: { id, snippet: truncate(content, 120), author: userView(openid), photos, cover_url } });
    }

    // 编辑攻略（仅本人；重新过审核，评审 #4/#7）
    m = path.match(/^\/guides\/(\d+)$/);
    if (m && method === 'PATCH') {
      if (!openid) return send(res, 401, { error: 'unauthorized' });
      const g = db.getGuide(parseInt(m[1], 10));
      if (!g) return send(res, 404, { error: 'guide not found' });
    if (g.userId !== openid) return send(res, 403, { error: '只能编辑自己的攻略' });
    const body = await readBody(req);
    if (body.content === undefined) return send(res, 400, { error: '缺少 content' });
    // 照片可单独更新（即使不改文字也可改图）：仅当显式传入才覆盖（undefined 表示不改）
    let photos = g.photos, cover_url = g.cover_url;
    if (body.photos !== undefined) photos = sanitizePhotoUrls(body.photos);
    if (body.cover_url !== undefined) cover_url = sanitizeCoverUrl(body.cover_url);
    // 五轮 #5：编辑也校验非空 + 最小长度
    if (!body.content || !body.content.trim()) return send(res, 400, { error: 'CONTENT_EMPTY', message: '内容不能为空' });
      if (body.content.trim().length < CONFIG.CONTENT_MIN_LEN) return send(res, 400, { error: 'CONTENT_TOO_SHORT', message: `内容至少 ${CONFIG.CONTENT_MIN_LEN} 个字` });
      // 六轮 #1：编辑也校验最大长度
      if (body.content.length > CONFIG.GUIDE_MAX_LEN) return send(res, 400, { error: 'CONTENT_TOO_LONG', message: `攻略最多 ${CONFIG.GUIDE_MAX_LEN} 字` });
      const content = escapeHtml(body.content.trim());
      const mod = moderate(content);
      if (!mod.ok) {
        // 审核未过：标记 rejected（保持公开列表不可见），写入拒绝原因（八轮 #4），不重置内容、不重新入队 AI（评审 #7/#12）
        const wasDefault = g.isDefault;
        g.status = 'rejected'; g.rejectionReason = mod.reason; g.updatedAt = new Date().toISOString();
        let isDefaultChanged = false;
        // 八轮 #2：若被拒攻略当前正是默认攻略，必须取消其默认位并强制重算，否则默认位会落入违规内容
        if (wasDefault) { g.isDefault = false; isDefaultChanged = recomputeDefaultGuide(g.spotId).changed; }
        db.persist();
        return send(res, 422, { error: 'CONTENT_REJECTED', message: mod.reason, is_default_changed: isDefaultChanged });
      }
      const prevStatus = g.status || 'approved';
      g.content = content; g.status = 'approved'; g.rejectionReason = null; g.updatedAt = new Date().toISOString();
      g.photos = photos; g.cover_url = cover_url;
      // 六轮 #4：编辑后审核通过，且由非 approved → approved（如 rejected 复审通过），强制触发默认攻略重算（同投票后进化逻辑）
      const rec = (g.source === 'user' && prevStatus !== 'approved') ? recomputeDefaultGuide(g.spotId) : { changed: false };
      db.persist();
      return send(res, 200, { ok: true, snippet: truncate(content, 120), is_default_changed: rec.changed });
    }

    // 删除攻略（仅本人；若为默认则重算，评审 #4/#12）
    // 四轮 #1：不级联删除其下评论——评论是独立 UGC 资产，攻略作者无权处置他人内容。
    // 评论的 parentType='guide' 保留，前端可在「我的评论」查看；攻略页已不存在时展示「原攻略已删除」占位。
    m = path.match(/^\/guides\/(\d+)$/);
    if (m && method === 'DELETE') {
      if (!openid) return send(res, 401, { error: 'unauthorized' });
      const g = db.getGuide(parseInt(m[1], 10));
      if (!g) return send(res, 404, { error: 'guide not found' });
      if (g.userId !== openid) return send(res, 403, { error: '只能删除自己的攻略' });
      const wasDefault = g.isDefault;
      const spotId = g.spotId;
      // 五轮 #1：将攻略下的直接子评论（parentType='guide'）迁移为景点评论，避免删除攻略后这些 UGC 沦为公开孤儿
      // （仅挂载点上移一级；投票/AI 评价/子树展示全部延续，语义由「回复攻略」转为「回复景点」）
      for (const c of db.data.comments) {
        if (c.parentType === 'guide' && c.parentId === g.id) {
          c.parentType = 'spot';
          c.parentId = spotId;
        }
      }
      db.data.guides = db.data.guides.filter(x => x.id !== g.id);
      // 六轮 #3：物理删除攻略时同步清理其关联 vote 孤儿记录（避免 vote 表无限膨胀）
      db.data.votes = db.data.votes.filter(v => !(v.targetType === 'guide' && v.targetId === g.id));
      if (wasDefault) recomputeDefaultGuide(spotId);
      db.persist();
      return send(res, 200, { ok: true });
    }

    // 投票（赞/不赞/撤回；target_type 支持 spot/guide/comment；comment 同步 dislikes，评审 #1）
    if (path === '/vote' && method === 'POST') {
      if (!openid) return send(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const { target_type, target_id, value } = body;
      if (!['spot', 'guide', 'comment'].includes(target_type)) return send(res, 400, { error: 'bad target_type' });
      const tid = parseInt(target_id, 10);
      // 五轮 #3 + 七轮 #5：目标不存在（物理删除）统一 404 TARGET_NOT_FOUND；
      //   软删评论（记录仍存在，status='deleted'）走 400 TARGET_DELETED（五轮 #3）。
      if (target_type === 'comment') {
        const tc = db.getComment(tid);
        if (!tc) return send(res, 404, { error: 'TARGET_NOT_FOUND', message: '目标不存在或已被删除' });
        if (tc.status === 'deleted') return send(res, 400, { error: 'TARGET_DELETED', message: '该评论已删除，无法操作' });
      } else if (target_type === 'guide') {
        if (!db.getGuide(tid)) return send(res, 404, { error: 'TARGET_NOT_FOUND', message: '目标不存在或已被删除' });
      } else if (target_type === 'spot') {
        if (!db.getSpot(tid)) return send(res, 404, { error: 'TARGET_NOT_FOUND', message: '目标不存在或已被删除' });
      }
      let v = db.getVote(openid, target_type, tid);
      if (value === 0) {
        if (v) { db.data.votes = db.data.votes.filter(x => x !== v); db.persist(); }
      } else {
        if (v) {
          if (v.value === value) {
            // 六轮 #6：重复相同投票幂等——直接返回当前状态，不报错、不修改计数（仅改票 value 不同才重写）
            const na = netApproval(target_type, tid);
            return send(res, 200, { likes: na.likes, dislikes: na.dislikes, my_vote: value, is_default_changed: false });
          }
          v.value = value; v.createdAt = new Date().toISOString();
        } else { v = { id: db.nextId('votes'), userId: openid, targetType: target_type, targetId: tid, value, createdAt: new Date().toISOString() }; db.data.votes.push(v); }
        db.persist();
      }
      const na = netApproval(target_type, tid);
      if (target_type === 'guide') { const g = db.getGuide(tid); if (g) { g.likes = na.likes; g.dislikes = na.dislikes; } }
      if (target_type === 'spot') { const s = db.getSpot(tid); if (s) { s.likes = na.likes; s.dislikes = na.dislikes; } }
      if (target_type === 'comment') { const c = db.getComment(tid); if (c) { c.likes = na.likes; c.dislikes = na.dislikes; } }
      let isDefaultChanged = false;
      if (target_type === 'guide') { const g = db.getGuide(tid); if (g) isDefaultChanged = recomputeDefaultGuide(g.spotId).changed; }
      db.persist();
      const myVoteVal = db.getVote(openid, target_type, tid)?.value || 0; // 撤回后行已删除，须重新查，避免读到被删的旧对象（第三轮 #1 修正）
      return send(res, 200, { likes: na.likes, dislikes: na.dislikes, my_vote: myVoteVal, is_default_changed: isDefaultChanged });
    }

    // 评论列表（评审 #3 + #10）
    // 评论列表（评审 #3 + #10；六轮 #2 扩展 mine=1 父节点可选）
    if (path === '/comments' && method === 'GET') {
      const parentType = url.searchParams.get('parent_type');
      const rawParentId = url.searchParams.get('parent_id');
      const parentId = parseInt(rawParentId || '0', 10);
      const sort = url.searchParams.get('sort') || 'time';
      const mine = url.searchParams.get('mine') === '1';
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
      const size = Math.min(CONFIG.PAGE.MAX_SIZE, Math.max(1, parseInt(url.searchParams.get('size') || String(CONFIG.PAGE.DEFAULT_SIZE), 10)));
      if (mine) {
        if (!openid) return send(res, 401, { error: 'unauthorized' });
        const bothAbsent = !parentType && !rawParentId;
        const bothPresent = !!parentType && !!rawParentId;
        // 六轮 #2：mine=1 时 parent_type/parent_id 可选
        //   二者皆缺 → 返回当前用户全部根评论（跨景点/攻略），排序 + 根评论分页
        //   二者皆传 → 与现有行为一致，返回该父节点下用户的评论
        //   只传其一 → 视为参数不完整
        if (bothAbsent) return send(res, 200, getMyParticipatedThreads(sort, openid, page, size));
        if (!bothPresent) return send(res, 400, { error: 'MISSING_PARENT', message: 'mine=1 若指定父节点需同时传 parent_type 和 parent_id' });
        if (!['spot', 'guide', 'comment'].includes(parentType)) return send(res, 400, { error: 'bad parent_type' });
        return send(res, 200, getCommentsList(parentType, parentId, sort, openid, true, page, size));
      }
      // mine=0（默认）：parent_type + parent_id 必填，否则 400 MISSING_PARENT
      if (!['spot', 'guide', 'comment'].includes(parentType) || !parentId) {
        return send(res, 400, { error: 'MISSING_PARENT', message: '公开评论列表需指定 parent_type 和 parent_id' });
      }
      return send(res, 200, getCommentsList(parentType, parentId, sort, openid, false, page, size));
    }

    // 发评论（深度上限 2 层 + root_id 保留上下文；评审 #2；#6 审核 + #13 转义；审核通过才入队 AI，评审 #7）
    if (path === '/comments' && method === 'POST') {
      if (!openid) return send(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      let { parent_type, parent_id, content } = body;
      if (!['spot', 'guide', 'comment'].includes(parent_type)) return send(res, 400, { error: 'bad parent_type' });
      // 五轮 #5：非空 + 最小长度校验（前置，先于限流/审核）
      if (!content || !content.trim()) return send(res, 400, { error: 'CONTENT_EMPTY', message: '内容不能为空' });
      if (content.trim().length < CONFIG.CONTENT_MIN_LEN) return send(res, 400, { error: 'CONTENT_TOO_SHORT', message: `内容至少 ${CONFIG.CONTENT_MIN_LEN} 个字` });
      // 六轮 #1：最大长度校验（顺序：非空→最小→最大→限流→审核）
      if (content.length > CONFIG.CONTENT_MAX_LEN) return send(res, 400, { error: 'CONTENT_TOO_LONG', message: `评论最多 ${CONFIG.CONTENT_MAX_LEN} 字` });
      if (isRateLimited(`${openid}:comment`, CONFIG.RATE_LIMIT.commentPerHour, HOUR)) {
        return send(res, 429, { error: '评论过于频繁，请稍后再试' });
      }
      const safe = escapeHtml(content.trim());
      const mod = moderate(safe);
      if (!mod.ok) return send(res, 422, { error: 'CONTENT_REJECTED', message: mod.reason }); // 审核未过不入队 AI（评审 #7）

      let pType = parent_type, pId = parseInt(parent_id, 10);
      let rootId = null, replyToUserId = null;
      if (pType === 'comment') {
        const parent = db.getComment(pId);
        if (!parent) return send(res, 404, { error: 'parent comment not found' });
        // 五轮 #3：软删父评论不可再被回复（物理删除的父评论→404；rejected 父评论允许追加，仅 mine=1 可见）
        if (parent.status === 'deleted') return send(res, 400, { error: 'TARGET_DELETED', message: '父评论已删除，无法回复' });
        if (parent.parentType === 'comment') {
          pId = parent.rootId;
          replyToUserId = parent.userId;
          rootId = parent.rootId;
        } else {
          rootId = parent.id;
          replyToUserId = parent.userId;
        }
      }
      const id = db.nextId('comments');
      if (pType !== 'comment') rootId = id;
      const c = {
        id,
        spotId: pType === 'spot' ? pId : (db.getComment(pId)?.spotId ?? db.getGuide(pId)?.spotId ?? null),
        parentType: pType, parentId: pId, userId: openid, content: safe,
        likes: 0, dislikes: 0, rootId, replyToUserId, rejectionReason: null,
        status: 'approved', createdAt: new Date().toISOString()
      };
      db.data.comments.push(c);
      enqueueReview('comment', id); // 已通过审核，入队 AI 评价
      db.persist();
      return send(res, 200, { comment: { id: c.id, root_id: c.rootId, reply_to: c.replyToUserId ? { user_id: maskUserId(c.replyToUserId), nickname: db.getUser(c.replyToUserId)?.nickname || '微信用户' } : null, ai_review: null } });
    }

    // 编辑评论（仅本人；重新过审核；审核通过则重排 AI 评价，评审 #4/#7）
    m = path.match(/^\/comments\/(\d+)$/);
    if (m && method === 'PATCH') {
      if (!openid) return send(res, 401, { error: 'unauthorized' });
      const c = db.getComment(parseInt(m[1], 10));
      if (!c) return send(res, 404, { error: 'comment not found' });
      if (c.status === 'deleted') return send(res, 400, { error: 'TARGET_DELETED', message: '该评论已删除，无法编辑' });
      if (c.userId !== openid) return send(res, 403, { error: '只能编辑自己的评论' });
      const body = await readBody(req);
      if (body.content === undefined) return send(res, 400, { error: '缺少 content' });
      // 五轮 #5：编辑也校验非空 + 最小长度
      if (!body.content || !body.content.trim()) return send(res, 400, { error: 'CONTENT_EMPTY', message: '内容不能为空' });
      if (body.content.trim().length < CONFIG.CONTENT_MIN_LEN) return send(res, 400, { error: 'CONTENT_TOO_SHORT', message: `内容至少 ${CONFIG.CONTENT_MIN_LEN} 个字` });
      // 六轮 #1：编辑也校验最大长度
      if (body.content.length > CONFIG.CONTENT_MAX_LEN) return send(res, 400, { error: 'CONTENT_TOO_LONG', message: `评论最多 ${CONFIG.CONTENT_MAX_LEN} 字` });
      const safe = escapeHtml(body.content.trim());
      const mod = moderate(safe);
      if (!mod.ok) {
        c.status = 'rejected'; c.rejectionReason = mod.reason; c.updatedAt = new Date().toISOString();
        // 审核被拒：移除其 AI 评价任务，避免浪费资源（评审 #7/#12）
        db.data.aiReviews = db.data.aiReviews.filter(a => !(a.targetType === 'comment' && a.targetId === c.id));
        db.persist();
        return send(res, 422, { error: 'CONTENT_REJECTED', message: mod.reason });
      }
      c.content = safe; c.status = 'approved'; c.rejectionReason = null; c.updatedAt = new Date().toISOString();
      enqueueReview('comment', c.id); // 重新触发 AI 短评
      db.persist();
      return send(res, 200, { ok: true });
    }

    // 删除评论（仅本人）
    // 四轮 #2：有子评论的节点软删除（保留占位，子评论继续展示），避免误删他人内容；
    // 叶子节点直接物理删除。仅清理自身 AI 评价（子评论的 AI 评价不受影响）。
    m = path.match(/^\/comments\/(\d+)$/);
    if (m && method === 'DELETE') {
      if (!openid) return send(res, 401, { error: 'unauthorized' });
      const target = db.getComment(parseInt(m[1], 10));
      if (!target) return send(res, 404, { error: 'comment not found' });
      if (target.status === 'deleted') return send(res, 400, { error: 'TARGET_DELETED', message: '该评论已删除' });
      if (target.userId !== openid) return send(res, 403, { error: '只能删除自己的评论' });
      const children = db.getCommentsByParent('comment', target.id);
      db.data.aiReviews = db.data.aiReviews.filter(a => !(a.targetType === 'comment' && a.targetId === target.id));
      let soft = false;
      if (children.length) {
        // 软删除：保留节点作占位，子评论继续挂在其下展示
        target.content = null; target.userId = null; target.status = 'deleted';
        target.deletedAt = new Date().toISOString();
        soft = true;
      } else {
        // 叶子节点物理删除
        db.data.comments = db.data.comments.filter(c => c.id !== target.id);
        // 六轮 #3：叶子物理删除评论时同步清理其关联 vote 孤儿记录（软删不清理，记录仍保留以正确展示子树）
        db.data.votes = db.data.votes.filter(v => !(v.targetType === 'comment' && v.targetId === target.id));
      }
      db.persist();
      return send(res, 200, { ok: true, soft_deleted: soft });
    }

    return send(res, 404, { error: 'not found', path });
  } catch (e) {
    return send(res, 500, { error: String(e && e.message || e) });
  }
});

// 阶段 2：监听译文文件变化热重载（无需重启即有新译文生效）
watchTranslations();

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`kids-trip-server listening on ${CONFIG.HOST}:${CONFIG.PORT} (DEV_MODE=${CONFIG.DEV_MODE}, AI_MODEL=${CONFIG.AI_MODEL})`);
});
