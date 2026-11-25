// 数据访问层（repository 模式）。
// 参考实现用 JSON 文件持久化，零依赖即可跑；生产可平滑替换为 PostgreSQL/MySQL——
// 只需重写本文件的查询/写入函数，上层 service 无需改动。
//
// 一致性保障（评审 #3/#4/#8）：
//  - 单进程下 Node 事件循环串行执行，每个请求的"读→改→写"之间无 await，故内存态天然无并发撕裂；
//  - persist() 采用「临时文件 + renameSync」原子写，避免进程崩溃/掉电导致 db.json 半写损坏；
//  - 每次写前将旧文件**滚动备份为 3 份**（db.json.bak.1/2/3，轮转覆盖），提供多级回滚生命线；
//  - 写入经 writeLock 串行化，杜绝多个 persist 交错。
//  限制：JSON 文件存储**仅支持单实例部署**（无法多进程/多容器同时写）。生产多实例请用 SQLite/PostgreSQL。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';

const FILE = path.resolve(process.cwd(), CONFIG.DATA_FILE);
// 3 份滚动备份（评审 #8）：bak.1 最新，bak.3 最旧；每次写入前整体轮转。
const BAKS = [FILE + '.bak.1', FILE + '.bak.2', FILE + '.bak.3'];
const EMPTY = { spots: [], guides: [], votes: [], comments: [], aiReviews: [], users: [], sessions: {} };
let data = structuredClone(EMPTY);
try {
  if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  data = structuredClone(EMPTY);
}
for (const k of Object.keys(EMPTY)) {
  if (k === 'sessions') { if (typeof data[k] !== 'object' || Array.isArray(data[k])) data[k] = {}; }
  else if (!Array.isArray(data[k])) data[k] = [];
}
// 兼容旧数据与缺字段的评论：补齐 rootId / dislikes
for (const c of data.comments) {
  if (c.rootId === undefined) c.rootId = c.parentType === 'comment' ? (c.parentId || c.id) : c.id;
  if (c.dislikes === undefined) c.dislikes = 0;
}
// 兼容旧 spot 缺 likes/dislikes
for (const s of data.spots) { if (s.likes === undefined) s.likes = 0; if (s.dislikes === undefined) s.dislikes = 0; }

// ── 写锁：保证 persist 串行 ──
let writeChain = Promise.resolve();
function withWriteLock(fn) { writeChain = writeChain.then(fn, fn); return writeChain; }

// 滚动备份：bak.2←bak.3, bak.1←bak.2, 当前→bak.1（只保留最近 3 份）
function rotateBackups() {
  try { if (fs.existsSync(BAKS[1])) fs.renameSync(BAKS[1], BAKS[2]); } catch { /* 忽略 */ }
  try { if (fs.existsSync(BAKS[0])) fs.renameSync(BAKS[0], BAKS[1]); } catch { /* 忽略 */ }
  try { if (fs.existsSync(FILE)) fs.copyFileSync(FILE, BAKS[0]); } catch { /* 备份失败不阻断主流程 */ }
}

function persist() {
  rotateBackups();
  const tmp = FILE + '.tmp.' + process.pid;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE); // 原子替换
}

// 对外 persist：经写锁串行化
function persistSafe() { return withWriteLock(persist); }

function nextId(col) {
  const arr = data[col] || [];
  return arr.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
}

export const db = {
  get data() { return data; },
  persist: persistSafe,
  nextId,
  // ── spots ──
  getSpots() { return data.spots; },
  getSpot(id) { return data.spots.find(s => s.id === id); },
  // ── guides ──
  getGuidesBySpot(spotId) { return data.guides.filter(g => g.spotId === spotId); },
  getGuide(id) { return data.guides.find(g => g.id === id); },
  // ── votes ──
  getVotes(targetType, targetId) { return data.votes.filter(v => v.targetType === targetType && v.targetId === targetId); },
  getVote(userId, targetType, targetId) { return data.votes.find(v => v.userId === userId && v.targetType === targetType && v.targetId === targetId); },
  // ── comments ──
  getCommentsByParent(parentType, parentId) { return data.comments.filter(c => c.parentType === parentType && c.parentId === parentId); },
  getCommentsByRoot(rootId) { return data.comments.filter(c => c.rootId === rootId); },
  getComment(id) { return data.comments.find(c => c.id === id); },
  // ── ai_reviews ──
  getAiReview(targetType, targetId) { return data.aiReviews.find(a => a.targetType === targetType && a.targetId === targetId); },
  getPendingReviews() { return data.aiReviews.filter(a => a.status === 'pending'); },
  // ── users（评审 #9：昵称/头像体系）──
  getUser(openid) { return data.users.find(u => u.openid === openid); },
  upsertUser(openid, patch) {
    let u = db.getUser(openid);
    if (!u) { u = { openid, nickname: '', avatar_url: '', createdAt: new Date().toISOString() }; data.users.push(u); }
    if (patch.nickname !== undefined) u.nickname = patch.nickname;
    if (patch.avatar_url !== undefined) u.avatar_url = patch.avatar_url;
    u.updatedAt = new Date().toISOString();
    return u;
  },
  // ── sessions（登录态）──
  getSession(token) { return data.sessions[token]; },
  setSession(token, openid, expiresAt) { data.sessions[token] = { openid, createdAt: Date.now(), expiresAt }; }
};
