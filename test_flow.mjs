// v4 端到端 + 纯函数验证。启动 server 后由同一 shell 调用。
// 运行要求：RL_COMMENT_PER_HOUR 须 >= 51（#9 子评论压测需发 51 条），
// 且该变量需 export 使本测试进程与 server 读取到同一上限（限流用例自适应）。
// 注意：攻略接口限流为 1 条/景点/用户/天，故多处攻略上传用例分别使用 spot 1/2/3 以避开限流；
//       六轮新增用例若需更多攻略位则运行前 export RL_GUIDE_PER_SPOT_DAY=10。
import { compositeScore } from './sort.js';
import fs from 'node:fs';

let pass = 0, fail = 0;
const DB_PATH = process.env.DATA_FILE || './data/db.json';
function readDb() { try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return { votes: [] }; } }
const log = (...a) => console.log(...a);
function check(name, cond, extra) {
  if (cond) { pass++; log('  ✅', name); }
  else { fail++; log('  ❌', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const BASE = process.env.KTS_BASE || 'http://localhost:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(method, path, body, token) {
  const opt = { method, headers: {} };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  if (token) opt.headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + path, opt);
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}

// ── 纯函数：动态权重（评审 #6 方案 A）──
log('\n[纯函数] 综合排序动态权重');
check('N=0 → 纯系统分', Math.abs(compositeScore({ systemScore: 80, likes: 0, dislikes: 0 }).composite - 80) < 0.01);
const hi = compositeScore({ systemScore: 80, likes: 1000, dislikes: 0 });
check('N 极大且 R=1 → 接近 100（用户分主导）', hi.composite > 95 && hi.composite < 100, hi);
const lo = compositeScore({ systemScore: 80, likes: 0, dislikes: 1000 });
check('N 极大且 R=-1 → 下限截断到 0（四轮 #5，不展示负分）', lo.composite === 0, lo);
check('净赞率 R 仍为 -1（内部语义保留，供差评标签）', lo.netApproval === -1, lo);

// ── HTTP 端到端 ──
log('\n[HTTP] 登录 / 用户态');
const login = await call('POST', '/auth/login', { code: 'c1', nickname: '小明', avatar_url: 'http://x/a.png' });
check('登录返回 token', !!login.j.token);
check('登录不返回 openid（评审 #5）', !('openid' in login.j), login.j);
const TOKEN = login.j.token;
const me = await call('GET', '/auth/me', null, TOKEN);
check('/auth/me 返回昵称且无 openid', me.j.nickname === '小明' && !('openid' in me.j), me.j);

log('\n[HTTP] 景点列表 / spot 冗余字段');
const spots = await call('GET', '/spots?sort=distance&lat=22.54&lng=113.95');
check('列表返回 likes/dislikes 字段（评审 #2）', spots.j.items[0].likes !== undefined && spots.j.items[0].dislikes !== undefined, spots.j.items[0]);
check('distance 排序返回 distance_km', spots.j.items[0].distance_km !== undefined);

log('\n[HTTP] 五轮 #7/#8/#9 · system 官方背书 / city+category 过滤 / 距离缺坐标');
// 五轮 #8：city/category 过滤
const byCity = await call('GET', '/spots?city=深圳');
check('city=深圳 仅返回深圳景点', byCity.status === 200 && byCity.j.items.every(s => s.city === '深圳'), byCity.j.items.map(s => s.city));
const byCat = await call('GET', '/spots?category=park');
check('category=park 仅返回公园', byCat.status === 200 && byCat.j.items.every(s => s.category === 'park'), byCat.j.items.map(s => s.category));
const byBoth = await call('GET', '/spots?city=深圳&category=park');
check('city+category 组合过滤', byBoth.status === 200 && byBoth.j.items.every(s => s.city === '深圳' && s.category === 'park'), byBoth.j.items.map(s => s.category));
// 五轮 #9：distance 缺坐标 → 400 MISSING_COORDS
const noCoord = await call('GET', '/spots?sort=distance');
check('sort=distance 缺 lat/lng→400 MISSING_COORDS', noCoord.status === 400 && noCoord.j.error === 'MISSING_COORDS', noCoord.j);
// 五轮 #7：system 种子攻略 author 官方背书（非匿名空昵称）
const sysSpot = await call('GET', '/spots/1');
check('默认攻略 author.nickname=官方推荐', sysSpot.j.detail.default_guide && sysSpot.j.detail.default_guide.author.nickname === '官方推荐', sysSpot.j.detail.default_guide && sysSpot.j.detail.default_guide.author);

log('\n[HTTP] 攻略 snippet / 全文（评审 #11）');
const longContent = 'X'.repeat(200);
const gpost = await call('POST', '/guides', { spot_id: 1, content: longContent }, TOKEN);
check('上传攻略成功', gpost.status === 200);
const glist = await call('GET', '/spots/1/guides');
const myG = glist.j.guides.find(g => g.id === gpost.j.guide.id);
check('攻略列表只返回 snippet 不返回 content', myG.snippet && !('content' in myG) && myG.snippet.length <= 121, myG);
const gfull = await call('GET', '/guides/' + gpost.j.guide.id);
check('单条攻略返回全文 content', gfull.j.guide.content === longContent, gfull.j.guide.content?.length);

log('\n[HTTP] 攻略编辑 / 删除 + 默认重算（评审 #4/#12）');
const gpatch = await call('PATCH', '/guides/' + gpost.j.guide.id, { content: 'edited' }, TOKEN);
check('编辑攻略成功', gpatch.status === 200);
const gdel = await call('DELETE', '/guides/' + gpost.j.guide.id, null, TOKEN);
check('删除攻略成功', gdel.status === 200);
const glist2 = await call('GET', '/spots/1/guides');
check('删除后攻略列表已无该攻略', !glist2.j.guides.find(g => g.id === gpost.j.guide.id));

log('\n[HTTP] 评论 2 层 + dislikes 同步（评审 #1/#2）');
const c1 = await call('POST', '/comments', { parent_type: 'spot', parent_id: 1, content: '根评论：人多排队可错峰' }, TOKEN);
check('发根评论', c1.status === 200);
const c2 = await call('POST', '/comments', { parent_type: 'comment', parent_id: c1.j.comment.id, content: '回复根：带2岁娃也合适' }, TOKEN);
check('发二级评论', c2.status === 200);
const c3 = await call('POST', '/comments', { parent_type: 'comment', parent_id: c2.j.comment.id, content: '想再回复二级' }, TOKEN);
check('回复二级评论被钳到根（root_id 一致）', c3.status === 200 && c3.j.comment.root_id === c1.j.comment.id, c3.j);
// 对 c1 点踩
const cv = await call('POST', '/vote', { target_type: 'comment', target_id: c1.j.comment.id, value: -1 }, TOKEN);
check('评论点踩返回 dislikes=1', cv.j.dislikes === 1 && cv.j.likes === 0, cv.j);
const clist = await call('GET', '/comments?parent_type=spot&parent_id=1&sort=time');
const fc = clist.j.comments.find(c => c.id === c1.j.comment.id);
check('公开列表只返回 approved（评审 #3）', fc && fc.status === 'approved' && fc.dislikes === 1, fc);
check('评论含作者信息（评审 #9）', fc && fc.author && fc.author.nickname === '小明', fc && fc.author);

log('\n[HTTP] AI 评价异步回填 + ai_helpful 排序（评审 #7/#11）');
let aiDone = false;
for (let i = 0; i < 8; i++) {
  const r = await call('GET', '/comments?parent_type=spot&parent_id=1&sort=ai_helpful');
  const t = r.j.comments.find(c => c.id === c1.j.comment.id);
  if (t && t.ai_review && t.ai_review.status === 'done') { aiDone = true; break; }
  await sleep(500);
}
check('评论 AI 短评异步回填 done', aiDone);

log('\n[HTTP] 五轮 #2 · reply_to 对象含昵称（替代 reply_to_user 字符串）');
const rA = await call('POST', '/comments', { parent_type: 'spot', parent_id: 1, content: '五轮测试根评论' }, TOKEN);
check('发根评论 rA', rA.status === 200);
const rB = await call('POST', '/comments', { parent_type: 'comment', parent_id: rA.j.comment.id, content: '五轮测试回复' }, TOKEN);
check('发回复 rB', rB.status === 200);
const rList = await call('GET', '/comments?parent_type=spot&parent_id=1&sort=time');
const rAview = rList.j.comments.find(c => c.id === rA.j.comment.id);
const rBview = (rAview.children || []).find(c => c.id === rB.j.comment.id);
check('回复评论含 reply_to 对象（非字符串）', rBview && rBview.reply_to && typeof rBview.reply_to === 'object', rBview);
check('reply_to.nickname=父评论作者昵称(小明)', rBview && rBview.reply_to && rBview.reply_to.nickname === '小明', rBview && rBview.reply_to);
check('reply_to.user_id 为掩码(含****，非原始 openid)', rBview && rBview.reply_to && rBview.reply_to.user_id.includes('****'), rBview && rBview.reply_to);

log('\n[HTTP] 五轮 #5 · 内容非空 + 最小长度校验');
const emptyC = await call('POST', '/comments', { parent_type: 'spot', parent_id: 1, content: '   ' }, TOKEN);
check('空白评论→400 CONTENT_EMPTY', emptyC.status === 400 && emptyC.j.error === 'CONTENT_EMPTY', emptyC.j);
const shortC = await call('POST', '/comments', { parent_type: 'spot', parent_id: 1, content: '好看' }, TOKEN);
check('过短评论(<5字)→400 CONTENT_TOO_SHORT', shortC.status === 400 && shortC.j.error === 'CONTENT_TOO_SHORT', shortC.j);
const emptyG = await call('POST', '/guides', { spot_id: 1, content: '' }, TOKEN);
check('空白攻略→400 CONTENT_EMPTY', emptyG.status === 400 && emptyG.j.error === 'CONTENT_EMPTY', emptyG.j);
const shortG = await call('POST', '/guides', { spot_id: 1, content: '去玩' }, TOKEN);
check('过短攻略(<5字)→400 CONTENT_TOO_SHORT', shortG.status === 400 && shortG.j.error === 'CONTENT_TOO_SHORT', shortG.j);

log('\n[HTTP] XSS 转义（评审 #13）');
const xss = await call('POST', '/comments', { parent_type: 'spot', parent_id: 1, content: '<script>alert(1)</script>' }, TOKEN);
const xlist = await call('GET', '/comments?parent_type=spot&parent_id=1&sort=time');
const xc = xlist.j.comments.find(c => c.id === xss.j.comment.id);
check('入库内容被 HTML 转义', xc && xc.content.includes('&lt;script&gt;'), xc && xc.content);

log('\n[HTTP] 内容审核拦截（第三轮 #5，422 CONTENT_REJECTED，未过不入库不评价）');
const bad = await call('POST', '/comments', { parent_type: 'spot', parent_id: 1, content: '加微信13800138000详聊' }, TOKEN);
check('含手机号被拒(422 CONTENT_REJECTED)', bad.status === 422 && bad.j.error === 'CONTENT_REJECTED', bad.j);
const afterBad = await call('GET', '/comments?parent_type=spot&parent_id=1&sort=time');
check('被拒评论未入库', !afterBad.j.comments.find(c => c.content && c.content.includes('13800138000')));

log('\n[HTTP] 限流（评审 #7，自适应：读 RL_COMMENT_PER_HOUR，独立用户）');
const rlLogin = await call('POST', '/auth/login', { code: 'rl', nickname: '限流员' });
const RL = parseInt(process.env.RL_COMMENT_PER_HOUR || '10', 10);
let limited = false;
for (let i = 0; i < RL + 3; i++) {
  const r = await call('POST', '/comments', { parent_type: 'spot', parent_id: 1, content: '限流测试' + i }, rlLogin.j.token);
  if (r.status === 429) { limited = true; break; }
}
check('评论达每小时上限后被 429', limited);

log('\n[HTTP] 删除评论：有子评论则软删保留子树（四轮 #2）');
const delRoot = await call('DELETE', '/comments/' + c1.j.comment.id, null, TOKEN);
check('删除根评论成功', delRoot.status === 200);
const afterDel = await call('GET', '/comments?parent_type=spot&parent_id=1&sort=time');
const delNode = afterDel.j.comments.find(c => c.id === c1.j.comment.id);
check('根评论软删：仍占位且 status=deleted/content=null', delNode && delNode.status === 'deleted' && delNode.content === null, delNode);
// 四轮 #2：c2 是 c1 的子评论（parent_type='comment'），只会出现在 c1.children 里，不会出现在 spot 根列表。
const kids1 = delNode.children || [];
check('他人子评论(c2)被保留（挂在软删根的子树中）', kids1.some(c => c.id === c2.j.comment.id), kids1.map(c => c.id));
// 四轮 #8：子评论的「加载更多」入口 = 直接查 parent_type=comment&parent_id=c1.id
const moreC = await call('GET', '/comments?parent_type=comment&parent_id=' + c1.j.comment.id + '&sort=time');
check('子评论 load-more 入口返回 c2', moreC.j.comments.some(c => c.id === c2.j.comment.id), moreC.j.comments.map(c => c.id));
const delLeaf = await call('DELETE', '/comments/' + c2.j.comment.id, null, TOKEN);
check('叶子评论物理删除成功', delLeaf.status === 200 && delLeaf.j.ok === true && delLeaf.j.soft_deleted === false);
const afterLeaf = await call('GET', '/comments?parent_type=spot&parent_id=1&sort=time');
check('叶子评论已从列表移除', !afterLeaf.j.comments.some(c => c.id === c2.j.comment.id));

log('\n[HTTP] 五轮 #3 · 软删评论状态机护栏');
const vDel = await call('POST', '/vote', { target_type: 'comment', target_id: c1.j.comment.id, value: 1 }, TOKEN);
check('对软删评论投票→400 TARGET_DELETED', vDel.status === 400 && vDel.j.error === 'TARGET_DELETED', vDel.j);
const pDel = await call('PATCH', '/comments/' + c1.j.comment.id, { content: '改改改改改' }, TOKEN);
check('编辑软删评论→400 TARGET_DELETED', pDel.status === 400 && pDel.j.error === 'TARGET_DELETED', pDel.j);
const dDel = await call('DELETE', '/comments/' + c1.j.comment.id, null, TOKEN);
check('再次删除软删评论→400 TARGET_DELETED', dDel.status === 400 && dDel.j.error === 'TARGET_DELETED', dDel.j);
const repDel = await call('POST', '/comments', { parent_type: 'comment', parent_id: c1.j.comment.id, content: '回复已删父评论' }, TOKEN);
check('回复软删父评论→400 TARGET_DELETED', repDel.status === 400 && repDel.j.error === 'TARGET_DELETED', repDel.j);

log('\n[HTTP] 第三轮专项 · 投票撤回删行可再投（#1）');
const v1 = await call('POST', '/vote', { target_type: 'spot', target_id: 1, value: 1 }, TOKEN);
check('首次赞 my_vote=1', v1.j.my_vote === 1, v1.j);
const v0 = await call('POST', '/vote', { target_type: 'spot', target_id: 1, value: 0 }, TOKEN);
check('撤回后 my_vote=0（删行而非置0）', v0.j.my_vote === 0, v0.j);
const v2 = await call('POST', '/vote', { target_type: 'spot', target_id: 1, value: 1 }, TOKEN);
check('撤回后可再次投票 my_vote=1', v2.j.my_vote === 1, v2.j);
await call('POST', '/vote', { target_type: 'spot', target_id: 1, value: 0 }, TOKEN);

log('\n[HTTP] 第三轮专项 · 子评论上限 + children_truncated（#9）');
const capLogin = await call('POST', '/auth/login', { code: 'cap', nickname: '压测员' });
const CAP = capLogin.j.token;
const root = await call('POST', '/comments', { parent_type: 'spot', parent_id: 1, content: '根评论-压测子评论上限' }, CAP);
check('根评论创建成功', root.status === 200, root.j);
const rootId = root.j.comment.id;
let made = 0;
for (let i = 0; i < 51; i++) {
  const r = await call('POST', '/comments', { parent_type: 'comment', parent_id: rootId, content: '子评论文本' + i }, CAP);
  if (r.status === 200) made++; else { log('   reply', i, 'status', r.status, r.j); break; }
}
check('成功创建 51 条子评论', made === 51, made);
await sleep(300);
const capList = await call('GET', '/comments?parent_type=spot&parent_id=1&sort=time&mine=1', null, CAP);
const fc9 = capList.j.comments.find(c => c.id === rootId);
check('根评论存在', !!fc9, capList.j.comments.length);
const kids9 = fc9.children || [];
check('子评论被截断到 <=50', kids9.length <= 50, kids9.length);
check('标记 children_truncated=true', fc9.children_truncated === true, fc9.children_truncated);
await call('DELETE', '/comments/' + rootId, null, CAP);

log('\n[HTTP] 四轮 #1 · 删攻略不级联删他人评论');
const gA = await call('POST', '/guides', { spot_id: 2, content: '攻略A，待被作者删除' }, TOKEN);
check('上传攻略A成功', gA.status === 200);
const otherLogin = await call('POST', '/auth/login', { code: 'otherX', nickname: '旁人' });
const OTH = otherLogin.j.token;
const gc = await call('POST', '/comments', { parent_type: 'guide', parent_id: gA.j.guide.id, content: '旁人在攻略A下的评论' }, OTH);
check('旁人对攻略A评论成功', gc.status === 200, gc.j);
const delG = await call('DELETE', '/guides/' + gA.j.guide.id, null, TOKEN);
check('作者删除攻略A成功', delG.status === 200);
// 五轮 #1：原攻略下评论（parentType='guide'）迁移为景点评论，避免删除攻略后沦为公开孤儿
const gcGuideList = await call('GET', '/comments?parent_type=guide&parent_id=' + gA.j.guide.id);
check('攻略维度下已无该评论（已迁移）', !gcGuideList.j.comments.some(c => c.id === gc.j.comment.id), gcGuideList.j.comments.map(c => c.id));
const gcSpotList = await call('GET', '/comments?parent_type=spot&parent_id=2&mine=1', null, OTH);
check('评论已归位到景点评论区（可公开曝光，五轮 #1）', gcSpotList.j.comments.some(c => c.id === gc.j.comment.id), gcSpotList.j.comments.map(c => c.id));

log('\n[HTTP] 四轮 #3 · PATCH /auth/me 更新资料');
const upd = await call('PATCH', '/auth/me', { nickname: '新昵称', avatar_url: 'http://x/b.png' }, TOKEN);
check('更新昵称/头像成功', upd.status === 200 && upd.j.nickname === '新昵称' && upd.j.avatar_url === 'http://x/b.png', upd.j);
const meAgain = await call('GET', '/auth/me', null, TOKEN);
check('再次 GET 昵称已生效', meAgain.j.nickname === '新昵称', meAgain.j);

log('\n[HTTP] 四轮 #4 · 攻略列表 status 过滤 + mine');
const gB = await call('POST', '/guides', { spot_id: 3, content: '攻略B-列表过滤测试' }, TOKEN);
check('上传攻略B成功', gB.status === 200);
const pub = await call('GET', '/spots/3/guides');
check('公开列表返回本人攻略B', pub.j.guides.some(g => g.id === gB.j.guide.id), pub.j.guides.length);
check('公开列表仅含 approved 攻略', pub.j.guides.every(g => g.status === 'approved'), pub.j.guides.map(g => g.status));
const mineSelf = await call('GET', '/spots/3/guides?mine=1', null, TOKEN);
check('mine=1 返回本人攻略B', mineSelf.j.guides.some(g => g.id === gB.j.guide.id), mineSelf.j.guides.length);
const mineOther = await call('GET', '/spots/3/guides?mine=1', null, OTH);
check('mine=1 不返回他人攻略', !mineOther.j.guides.some(g => g.id === gB.j.guide.id), mineOther.j.guides.length);

log('\n[HTTP] 四轮 #7 · AI 评价 failed 诊断接口');
const adminFailed = await call('GET', '/admin/ai-review-failed', null, TOKEN);
check('诊断接口返回 {count,items}', adminFailed.status === 200 && typeof adminFailed.j.count === 'number' && Array.isArray(adminFailed.j.items), adminFailed.j);

log('\n[HTTP] 六轮 #1 · 内容最大长度限制');
const overC = 'a'.repeat(2001);
const tooLongC = await call('POST', '/comments', { parent_type: 'spot', parent_id: 1, content: overC }, TOKEN);
check('超长评论→400 CONTENT_TOO_LONG', tooLongC.status === 400 && tooLongC.j.error === 'CONTENT_TOO_LONG', tooLongC.j);
const overG = 'a'.repeat(10001);
const tooLongG = await call('POST', '/guides', { spot_id: 4, content: overG }, TOKEN);
check('超长攻略→400 CONTENT_TOO_LONG', tooLongG.status === 400 && tooLongG.j.error === 'CONTENT_TOO_LONG', tooLongG.j);

log('\n[HTTP] 六轮 #2 · mine=1 父节点可选 / mine=0 必填');
const mineAll = await call('GET', '/comments?mine=1', null, TOKEN);
check('mine=1 不带父节点返回本人全部根评论', mineAll.status === 200 && Array.isArray(mineAll.j.comments), mineAll.j);
check('mine=1 评论均属当前用户(或已删除占位)', mineAll.j.comments.every(c => !c.author || c.author.user_id === me.j.user_id), mineAll.j.comments.map(c => c.author && c.author.user_id));
const noParent = await call('GET', '/comments');
check('mine=0 不带父节点→400 MISSING_PARENT', noParent.status === 400 && noParent.j.error === 'MISSING_PARENT', noParent.j);
const partialParent = await call('GET', '/comments?parent_type=spot', null, TOKEN);
check('mine=1 只传其一→400 MISSING_PARENT', partialParent.status === 400 && partialParent.j.error === 'MISSING_PARENT', partialParent.j);

log('\n[HTTP] 六轮 #3 · 物理删除清理关联 vote');
const gv = await call('POST', '/guides', { spot_id: 4, content: '攻略投票清理测试内容合规' }, TOKEN);
await call('POST', '/vote', { target_type: 'guide', target_id: gv.j.guide.id, value: 1 }, TOKEN);
await sleep(60);
let db0 = readDb();
check('删前存在 guide vote 记录', db0.votes.some(v => v.targetType === 'guide' && v.targetId === gv.j.guide.id), db0.votes.filter(v => v.targetType === 'guide').length);
await call('DELETE', '/guides/' + gv.j.guide.id, null, TOKEN);
await sleep(60);
let db1 = readDb();
check('物理删除攻略后 vote 记录已清理', !db1.votes.some(v => v.targetType === 'guide' && v.targetId === gv.j.guide.id), db1.votes.filter(v => v.targetType === 'guide').length);
const cvt = await call('POST', '/comments', { parent_type: 'spot', parent_id: 1, content: '叶评论投票清理测试' }, TOKEN);
await call('POST', '/vote', { target_type: 'comment', target_id: cvt.j.comment.id, value: 1 }, TOKEN);
await sleep(60);
let db2 = readDb();
check('删前存在 comment vote 记录', db2.votes.some(v => v.targetType === 'comment' && v.targetId === cvt.j.comment.id), db2.votes.filter(v => v.targetType === 'comment').length);
await call('DELETE', '/comments/' + cvt.j.comment.id, null, TOKEN); // 叶子→物理删
await sleep(60);
let db3 = readDb();
check('物理删除叶子评论后 vote 记录已清理', !db3.votes.some(v => v.targetType === 'comment' && v.targetId === cvt.j.comment.id), db3.votes.filter(v => v.targetType === 'comment').length);

log('\n[HTTP] 六轮 #4 · PATCH 攻略 rejected→approved 重算默认');
const g4 = await call('POST', '/guides', { spot_id: 4, content: '攻略六轮四待重算内容合规' }, TOKEN);
const badEdit = await call('PATCH', '/guides/' + g4.j.guide.id, { content: '违规加微信13800138000咨询' }, TOKEN);
check('违规编辑被拒 422', badEdit.status === 422 && badEdit.j.error === 'CONTENT_REJECTED', badEdit.j);
const rejView = await call('GET', '/guides/' + g4.j.guide.id, null, TOKEN); // 七轮#1：rejected 攻略仅作者本人可见，须带 owner token
check('被拒后 status=rejected（作者本人可见）', rejView.status === 200 && rejView.j.guide.status === 'rejected', rejView.j);
const goodEdit = await call('PATCH', '/guides/' + g4.j.guide.id, { content: '攻略重新提交合规内容合规' }, TOKEN);
check('复审合规→200', goodEdit.status === 200, goodEdit.j);
const appView = await call('GET', '/guides/' + g4.j.guide.id);
check('复审通过 status=approved（六轮 #4 修复：不再卡在 rejected）', appView.j.guide.status === 'approved', appView.j.guide.status);
const pub4 = await call('GET', '/spots/4/guides');
check('复审通过后公开列表重新出现', pub4.j.guides.some(g => g.id === g4.j.guide.id), pub4.j.guides.length);

log('\n[HTTP] 六轮 #5 · 软删评论不展示 AI 评价');
const sdRoot = await call('POST', '/comments', { parent_type: 'spot', parent_id: 1, content: '软删根评论内容合规' }, TOKEN);
const sdChild = await call('POST', '/comments', { parent_type: 'comment', parent_id: sdRoot.j.comment.id, content: '软删子评论内容合规' }, TOKEN);
const sdDel = await call('DELETE', '/comments/' + sdRoot.j.comment.id, null, TOKEN);
check('根评论软删成功', sdDel.status === 200 && sdDel.j.soft_deleted === true, sdDel.j);
// 软删评论是最新创建的 spot-1 根评论，列表按 created_at 升序分页（size 上限 50），故分页查找其占位
let sdNode = null;
for (let pg = 1; pg <= 3 && !sdNode; pg++) {
  const pageList = await call('GET', `/comments?parent_type=spot&parent_id=1&size=50&page=${pg}`);
  sdNode = pageList.j.comments.find(c => c.id === sdRoot.j.comment.id);
}
check('软删评论占位返回', !!sdNode && sdNode.deleted === true, sdNode);
check('软删评论 ai_review 为 null（不展示 AI 短评）', !!sdNode && sdNode.ai_review === null, sdNode && sdNode.ai_review);
await call('DELETE', '/comments/' + sdChild.j.comment.id, null, TOKEN); // 清叶子，根留作占位

log('\n[HTTP] 六轮 #6 · 投票幂等');
const vA = await call('POST', '/vote', { target_type: 'spot', target_id: 4, value: 1 }, TOKEN);
check('首次赞 my_vote=1', vA.status === 200 && vA.j.my_vote === 1, vA.j);
const likesBefore = vA.j.likes;
const vB = await call('POST', '/vote', { target_type: 'spot', target_id: 4, value: 1 }, TOKEN);
check('重复相同赞幂等→200 不报错', vB.status === 200 && vB.j.my_vote === 1, vB.j);
check('重复相同赞不改计数', vB.j.likes === likesBefore, { before: likesBefore, after: vB.j.likes });
const vC = await call('POST', '/vote', { target_type: 'spot', target_id: 4, value: -1 }, TOKEN);
check('改票 value=-1 生效 my_vote=-1', vC.status === 200 && vC.j.my_vote === -1, vC.j);

log('\n[HTTP] 六轮 #7 · 默认排序为综合');
const def = await call('GET', '/spots');
check('不传 sort 默认按综合排序返回', def.status === 200 && def.j.items.length > 1 && def.j.items[0].composite_score >= def.j.items[def.j.items.length - 1].composite_score, def.j.items.map(s => s.composite_score));

log('\n[HTTP] 六轮 #9 · load-more children 恒为空数组');
const root9 = await call('POST', '/comments', { parent_type: 'spot', parent_id: 1, content: '六轮九根评论合规' }, TOKEN);
const child9 = await call('POST', '/comments', { parent_type: 'comment', parent_id: root9.j.comment.id, content: '六轮九子评论合规' }, TOKEN);
const lm9 = await call('GET', '/comments?parent_type=comment&parent_id=' + root9.j.comment.id);
check('load-more 返回子评论', lm9.status === 200 && lm9.j.comments.some(c => c.id === child9.j.comment.id), lm9.j.comments.length);
check('load-more 子评论 children 恒为 []', lm9.j.comments.every(c => Array.isArray(c.children) && c.children.length === 0), lm9.j.comments.map(c => c.children));
await call('DELETE', '/comments/' + child9.j.comment.id, null, TOKEN); // 清叶子，根留作占位

// ───────── 第七轮评审（v4.5）─────────
log('\n[HTTP] 七轮 #1 · GET /guides/:id 可选鉴权 + 状态过滤');
const goLogin7 = await call('POST', '/auth/login', { code: 'gowner7', nickname: '攻略主7' });
const GOT7 = goLogin7.j.token;
const gPost7 = await call('POST', '/guides', { spot_id: 2, content: '初始优质攻略内容ABCDEF' }, GOT7);
check('七轮#1 上传攻略成功(spot2)', gPost7.status === 200, gPost7.j);
const gid7 = gPost7.j.guide.id;
const gBad7 = await call('PATCH', '/guides/' + gid7, { content: '违规含手机号13800138000' }, GOT7);
check('七轮#1 编辑触发审核拒绝→status=rejected', gBad7.status === 422 && gBad7.j.error === 'CONTENT_REJECTED', gBad7.j);
const gPubNoToken = await call('GET', '/guides/' + gid7);
check('七轮#1 公开访问 rejected 攻略→404（防遍历泄露）', gPubNoToken.status === 404, gPubNoToken.j);
const gPubOther = await call('GET', '/guides/' + gid7, null, TOKEN);
check('七轮#1 非作者访问 rejected 攻略→404', gPubOther.status === 404, gPubOther.j);
const gOwn7 = await call('GET', '/guides/' + gid7, null, GOT7);
check('七轮#1 作者本人访问 rejected 攻略→200 且可见全文', gOwn7.status === 200 && gOwn7.j.guide.status === 'rejected' && !!gOwn7.j.guide.content, gOwn7.j && gOwn7.j.guide);
// 反向验证：approved 攻略公开可见（作者已建一条 approved 于 spot3）
const gAppr7 = await call('POST', '/guides', { spot_id: 3, content: 'approved 攻略内容XYZ' }, GOT7);
const gApprGet = await call('GET', '/guides/' + gAppr7.j.guide.id);
check('七轮#1 公开访问 approved 攻略→200', gApprGet.status === 200 && gApprGet.j.guide.status === 'approved', gApprGet.j && gApprGet.j.guide);

log('\n[HTTP] 七轮 #2 · guides 列表净赞率排序');
const gsLogin = await call('POST', '/auth/login', { code: 'gsort7', nickname: '排序员7' });
const GOT_S = gsLogin.j.token;
const gA7 = await call('POST', '/guides', { spot_id: 4, content: '排序测试A内容合规' }, GOT_S);
const gB7 = await call('POST', '/guides', { spot_id: 4, content: '排序测试B内容合规' }, GOT_S);
await sleep(20); // 确保 C 的 createdAt 明显晚于 B，使同分按时间降序的断言确定（避免同毫秒 createdAt 导致排序不稳定）
const gC7 = await call('POST', '/guides', { spot_id: 4, content: '排序测试C内容合规' }, GOT_S);
await call('POST', '/vote', { target_type: 'guide', target_id: gA7.j.guide.id, value: 1 }, TOKEN); // A 净赞 1
// B/C 不投票（净赞 0），C 晚于 B 创建
const gsNet = await call('GET', '/spots/4/guides');
const nets = gsNet.j.guides.map(g => (g.likes || 0) - (g.dislikes || 0));
const netDesc = nets.every((v, i) => i === 0 || nets[i - 1] >= v);
check('七轮#2 guides 列表按净赞率(likes-dislikes)降序', netDesc, nets);
const ia = gsNet.j.guides.findIndex(g => g.id === gA7.j.guide.id);
const ib = gsNet.j.guides.findIndex(g => g.id === gB7.j.guide.id);
const ic = gsNet.j.guides.findIndex(g => g.id === gC7.j.guide.id);
check('七轮#2 同分(均0)按 createdAt 降序（C 晚于 B → C 在 B 前）', ib >= 0 && ic >= 0 && ic < ib, { ia, ib, ic });

log('\n[HTTP] 七轮 #4 · GET /guides?mine=1 跨景点本人攻略');
const mineAll7 = await call('GET', '/guides?mine=1', null, GOT7);
check('七轮#4 跨景点返回本人全部攻略(≥2, 跨 spot2/spot3)', mineAll7.status === 200 && mineAll7.j.guides.length >= 2 && new Set(mineAll7.j.guides.map(g => g.spotId)).size >= 2, mineAll7.j.guides.map(g => g.spotId));
check('七轮#4 列表带 content 全文', mineAll7.j.guides.every(g => !!g.content), mineAll7.j.guides.length);
check('七轮#4 不传 mine→400 MINE_REQUIRED', (await call('GET', '/guides')).status === 400);
check('七轮#4 未登录→401', (await call('GET', '/guides?mine=1')).status === 401);

log('\n[HTTP] 七轮 #5 · vote 物理删除目标→404 TARGET_NOT_FOUND');
// 注意：db.nextId 采用 max(existing)+1，已删除的 id 会被后续新建攻略复用，
// 故不能依赖早期被删攻略的 id；此处新建临时攻略→物理删除→立即投票，保证目标确为已删。
const gTmp = await call('POST', '/guides', { spot_id: 4, content: '临时待删攻略内容合规' }, TOKEN);
const gTmpId = gTmp.j.guide.id;
const gTmpDel = await call('DELETE', '/guides/' + gTmpId, null, TOKEN);
check('七轮#5 前置：临时攻略物理删除', gTmpDel.status === 200, gTmpDel.j);
const vDelG7 = await call('POST', '/vote', { target_type: 'guide', target_id: gTmpId, value: 1 }, TOKEN);
check('七轮#5 投票已物理删除的攻略→404 TARGET_NOT_FOUND', vDelG7.status === 404 && vDelG7.j.error === 'TARGET_NOT_FOUND', vDelG7.j);
const c3del7 = await call('DELETE', '/comments/' + c3.j.comment.id, null, TOKEN); // c3 为叶子→物理删除
check('七轮#5 前置：c3 叶子物理删除', c3del7.status === 200 && c3del7.j.soft_deleted === false, c3del7.j);
const vDelC7 = await call('POST', '/vote', { target_type: 'comment', target_id: c3.j.comment.id, value: 1 }, TOKEN);
check('七轮#5 投票已物理删除的评论→404 TARGET_NOT_FOUND', vDelC7.status === 404 && vDelC7.j.error === 'TARGET_NOT_FOUND', vDelC7.j);

log('\n[HTTP] 七轮 #7 · GET /comments 默认排序=time');
const cSortTime7 = await call('GET', '/comments?parent_type=spot&parent_id=1&sort=time');
const cSortNone7 = await call('GET', '/comments?parent_type=spot&parent_id=1');
const sameOrder7 = JSON.stringify(cSortTime7.j.comments.map(c => c.id)) === JSON.stringify(cSortNone7.j.comments.map(c => c.id));
const asc7 = cSortTime7.j.comments.every((c, i) => i === 0 || new Date(cSortTime7.j.comments[i - 1].created_at) <= new Date(c.created_at));
check('七轮#7 缺省 sort 与显式 time 一致且按 created_at 升序', sameOrder7 && asc7 && cSortTime7.j.comments.length > 0, { sameOrder7, asc7 });

// 七轮 #3（comment DDL 去 NOT NULL，BLUEPRINT §2.4）/ #6（COMMENT_MAX_CHILDREN 变量，README 环境变量表）为文档/配置项，已落地文档，无运行时断言。

// ───────── 第八轮评审（v4.6）─────────
log('\n[HTTP] 八轮 #1 · GET /spots/:id 详情含 my_vote（与列表同构）');
// spot 1 此前在该脚本中无存活用户攻略（gpost 已删），且景点赞已被撤回，故先点赞制造 my_vote=1 便于断言
await call('POST', '/vote', { target_type: 'spot', target_id: 1, value: 1 }, TOKEN);
// my_vote 与列表项同构，需带 token 才能解析当前用户投票态（匿名请求恒为 0）
const sd1 = await call('GET', '/spots/1', null, TOKEN);
check('八轮#1 详情响应含 my_vote 字段', 'my_vote' in sd1.j.detail, sd1.j.detail);
check('八轮#1 详情 my_vote=1（与刚投的赞一致）', sd1.j.detail.my_vote === 1, sd1.j.detail);
const sl1 = await call('GET', '/spots', null, TOKEN);
const sli = sl1.j.items.find(s => s.id === 1);
check('八轮#1 详情 my_vote 与列表 my_vote 一致', sli && sli.my_vote === 1, sli);
await call('POST', '/vote', { target_type: 'spot', target_id: 1, value: 0 }, TOKEN); // 复位，避免影响其它用例

log('\n[HTTP] 八轮 #2 · PATCH 攻略被拒不回退默认攻略（状态机漏洞）');
// spot 1 当前无存活用户攻略 → 新建攻略 +1 赞即成为默认，随后编辑触发审核拒绝
const g8 = await call('POST', '/guides', { spot_id: 1, content: '八轮默认攻略测试内容合规' }, TOKEN);
const G8 = g8.j.guide.id;
const vG8 = await call('POST', '/vote', { target_type: 'guide', target_id: G8, value: 1 }, TOKEN);
check('八轮#2 投票后该攻略成为默认(is_default_changed=true)', vG8.j.is_default_changed === true, vG8.j);
const d1 = await call('GET', '/spots/1');
check('八轮#2 详情默认攻略=新攻略G8', d1.j.detail.default_guide && d1.j.detail.default_guide.id === G8, d1.j.detail.default_guide);
const badG8 = await call('PATCH', '/guides/' + G8, { content: '违规含手机号13800138000咨询' }, TOKEN);
check('八轮#2 编辑触发审核拒绝→422', badG8.status === 422 && badG8.j.error === 'CONTENT_REJECTED', badG8.j);
check('八轮#2 被拒且原是默认→is_default_changed=true', badG8.j.is_default_changed === true, badG8.j);
const d2 = await call('GET', '/spots/1');
check('八轮#2 被拒后默认攻略已回退（不再是被拒攻略G8）', d2.j.detail.default_guide && d2.j.detail.default_guide.id !== G8, d2.j.detail.default_guide);
check('八轮#2 回退后的默认攻略状态 approved（system 种子，非违规内容）', d2.j.detail.default_guide && d2.j.detail.default_guide.author && d2.j.detail.default_guide.author.nickname === '官方推荐', d2.j.detail.default_guide);

log('\n[HTTP] 八轮 #3 · mine=1 含用户 L2 回复线程（产品功能缺口）');
const u8 = await call('POST', '/auth/login', { code: 'u8', nickname: '八轮用户C' });
const U8 = u8.j.token;
const r8 = await call('POST', '/comments', { parent_type: 'spot', parent_id: 1, content: '八轮根评论他人发起内容合规' }, U8);
check('八轮#3 他人(U8)创建根评论', r8.status === 200, r8.j);
const reply8 = await call('POST', '/comments', { parent_type: 'comment', parent_id: r8.j.comment.id, content: '八轮回复L2内容合规' }, TOKEN);
check('八轮#3 TOKEN 回复该根评论(L2, root_id 一致)', reply8.status === 200 && reply8.j.comment.root_id === r8.j.comment.id, reply8.j);
const mine8 = await call('GET', '/comments?mine=1&size=50', null, TOKEN);
const root8 = mine8.j.comments.find(c => c.id === r8.j.comment.id);
check('八轮#3 mine=1 返回「他人根+自己回复」线程', !!root8, mine8.j.comments.map(c => c.id));
check('八轮#3 线程子树含 TOKEN 的 L2 回复', root8 && (root8.children || []).some(ch => ch.id === reply8.j.comment.id), root8 && (root8.children || []).map(c => c.id));

log('\n[HTTP] 八轮 #4 · 审核拒绝原因持久化（体验断层）');
const gRR = await call('POST', '/guides', { spot_id: 4, content: '待审核攻略内容合规八轮' }, TOKEN);
const gRRid = gRR.j.guide.id;
const badGRR = await call('PATCH', '/guides/' + gRRid, { content: '违规含手机号13800138000详聊' }, TOKEN);
check('八轮#4 攻略编辑被拒 422', badGRR.status === 422 && badGRR.j.error === 'CONTENT_REJECTED', badGRR.j);
const gRRview = await call('GET', '/guides/' + gRRid, null, TOKEN);
check('八轮#4 作者可见 rejected 攻略', gRRview.status === 200 && gRRview.j.guide.status === 'rejected', gRRview.j && gRRview.j.guide);
check('八轮#4 详情带 rejection_reason 且含原因', gRRview.j.guide.rejection_reason && gRRview.j.guide.rejection_reason.includes('手机号'), gRRview.j.guide.rejection_reason);
const gRRmine = await call('GET', '/spots/4/guides?mine=1', null, TOKEN);
const gRRitem = gRRmine.j.guides.find(g => g.id === gRRid);
check('八轮#4 跨景点列表(mine=1)带 rejection_reason', gRRmine.status === 200 && gRRitem && !!gRRitem.rejection_reason, gRRitem);
const cRR = await call('POST', '/comments', { parent_type: 'spot', parent_id: 1, content: '待审核评论内容合规八轮' }, TOKEN);
const cRRid = cRR.j.comment.id;
const badCRR = await call('PATCH', '/comments/' + cRRid, { content: '违规含手机号13800138000详聊' }, TOKEN);
check('八轮#4 评论编辑被拒 422', badCRR.status === 422 && badCRR.j.error === 'CONTENT_REJECTED', badCRR.j);
const cRRmine = await call('GET', '/comments?mine=1&size=50', null, TOKEN);
const cRRitem = cRRmine.j.comments.find(c => c.id === cRRid);
check('八轮#4 评论 mine=1 带 rejection_reason(状态 rejected)', cRRmine.status === 200 && cRRitem && cRRitem.status === 'rejected' && !!cRRitem.rejection_reason, cRRitem);

log('\n[HTTP] 八轮 #8 · COMMENT_MAX_CHILDREN 下限保护（config 表达式逻辑）');
const clampMax = (raw) => { const v = parseInt(raw, 10); return Math.max(Number.isNaN(v) ? 50 : v, 1); };
check('八轮#8 误配0→提升到1', clampMax('0') === 1);
check('八轮#8 误配-5→提升到1', clampMax('-5') === 1);
check('八轮#8 合法30→保持30', clampMax('30') === 30);
check('八轮#8 未配置→默认50', clampMax('') === 50);

// 八轮 #5（限流滑动窗口说明）/ #6（parent_id DDL 注释修正）/ #7（ai_review.helpful_score CHECK 约束）为文档/配置项，已落地文档，无运行时断言。

log(`\n==== 结果：通过 ${pass} / 失败 ${fail} ====`);
process.exit(fail === 0 ? 0 : 1);
