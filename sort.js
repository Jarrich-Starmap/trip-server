// 排序与默认攻略进化（§4）。
import { CONFIG } from './config.js';
import { db } from './db.js';

// 统计某目标的赞/不赞
export function netApproval(targetType, targetId) {
  const vs = db.getVotes(targetType, targetId);
  let likes = 0, dislikes = 0;
  for (const v of vs) { if (v.value === 1) likes++; else if (v.value === -1) dislikes++; }
  return { likes, dislikes, count: vs.length };
}

// 综合排序（仅由系统分 + 用户净赞率决定，AI 不参与）
// R = (likes-dislikes)/N。当 N=0（无任何投票）时 R 定义为 0，避免除零（评审 #8）。
// 权重随投票数 N 动态衰减（评审 v4 #6 方案 A）：
//   w_system = K/(N+K)，w_user = N/(N+K)
//   - N=0 → 纯系统分（冷启动保护，用户尚无投票话语权）
//   - N→∞ → 纯用户分（群体智慧完全主导，系统分退场）
// 这解决了"固定 50% 系统分"的算法天花板：系统分只是冷启动保底，不是长期排名依据。
// 读取：优先用 spot 上冗余缓存的 likes/dislikes（评审 v4 #2，零聚合开销），缺失时回退实时聚合。
export function compositeScore(spot) {
  const S = (spot.systemScore || 0) / 100;
  let likes = spot.likes, dislikes = spot.dislikes;
  if (likes == null || dislikes == null) {
    const na = netApproval('spot', spot.id);
    likes = na.likes; dislikes = na.dislikes;
  }
  const N = likes + dislikes;
  const R = N > 0 ? (likes - dislikes) / N : 0;
  const K = CONFIG.SORT.K;
  const wSystem = K / (N + K);
  const wUser = N / (N + K);
  // 四轮 #5：展示下限截断到 0。亲子场景不展示负分（内部 R 仍可为负，供 net_approval 标签说明"差评较多"）
  const composite = Math.max(0, 100 * (wSystem * S + wUser * R));
  return {
    composite: Number(composite.toFixed(2)),
    netApproval: Number(R.toFixed(2)),
    voteCount: N,
    likes, dislikes
  };
}

// 默认攻略自动进化（评审 #1 · 关键歧义修复）
// 规则：
//   - system 种子【不参与】净赞比较；仅用户攻略(source='user')之间竞争默认位；
//   - 净赞最高的用户攻略 → 置为默认；
//   - 若所有用户攻略净赞 ≤ 0（或无用户攻略）→ 强制将 system 种子置为默认，
//     无论 system 种子自身 likes/dislikes 如何（保证每个景点恒有默认攻略）。
export function recomputeDefaultGuide(spotId) {
  const guides = db.getGuidesBySpot(spotId);
  if (!guides.length) return { changed: false };

  // 八轮 #2 修：仅已审核通过的用户攻略参与默认竞争，确保「默认攻略永远是 approved 状态」
  // （被拒 rejected 的用户攻略即便净赞>0 也不能成为默认，避免默认位落入违规内容）。
  const userGuides = guides.filter(g => g.source === 'user' && (g.status || 'approved') === 'approved');
  const sys = guides.find(g => g.source === 'system');
  const current = guides.find(g => g.isDefault);

  let best = null, bestNet = -Infinity;
  for (const g of userGuides) {
    const net = g.likes - g.dislikes;
    if (net > bestNet) { bestNet = net; best = g; }
  }

  if (best && bestNet > 0) {
    if (!current || current.id !== best.id) {
      guides.forEach(g => { g.isDefault = false; });
      best.isDefault = true;
      db.persist();
      return { changed: true, defaultId: best.id, source: 'user' };
    }
    return { changed: false };
  }

  // 无用户攻略或用户攻略净赞均 ≤0 → 回退 system 种子
  if (sys && (!current || current.id !== sys.id)) {
    guides.forEach(g => { g.isDefault = false; });
    sys.isDefault = true;
    db.persist();
    return { changed: true, defaultId: sys.id, source: 'system' };
  }
  return { changed: false };
}

// 球面距离（Haversine，单位 km）—— 用于 sort=distance（评审 #10）
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 给 spot 视图附加距离字段（当请求带了经纬度）
export function withDistance(spotView, lat, lng) {
  if (lat != null && lng != null && spotView.lat != null && spotView.lng != null) {
    spotView.distance_km = Number(haversineKm(lat, lng, spotView.lat, spotView.lng).toFixed(1));
  }
  return spotView;
}
