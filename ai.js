// AI 服务：冷启动默认攻略 + 评论短评评价。
// MVP 全部走 template 规则兜底（零 key、可跑）；预留 LLM 接口，后续按 CONFIG.AI_MODEL 切换。
//
// ── Template 规则（评审 #12 · 必须文档化，保证可维护/可复现） ──
// 评论短评的判定完全由下面这组关键词/ heuristics 决定，任何开发者照此实现结果一致：
//   触发词「人多/排队/拥挤/避峰/错峰/人少/限流」 → 错峰建议类话术, score 0.90
//   触发词「岁/宝宝/婴儿/娃/幼儿/亲子/推车/哺乳」 → 带娃装备类话术, score 0.85
//   触发词「推荐/不错/值得/好评/喜欢/必去」     → 正面体验类话术, score 0.70
//   触发词「坑/避雷/差/失望/贵/劝退」           → 风险提醒类话术, score 0.60
//   默认（无命中）                              → 中性记录类话术, score 0.50
//   长度 > 30 字 → score 再 +0.05（信息密度加分，封顶 0.95）
// 注意：helpfulScore 仅用于「有用优先」排序，绝不向用户展示该数值。
import { db } from './db.js';

// ① 冷启动：为每个景点生成初始默认攻略（系统种子）
export function generateGuideTemplate(spot) {
  const parts = [];
  parts.push(`【${spot.name}】带娃游玩建议`);
  if (spot.desc) parts.push(spot.desc);
  if (spot.highlights) parts.push(`亮点：${spot.highlights}`);
  if (spot.feeLabel) parts.push(`费用：${spot.feeLabel}`);
  if (spot.shopHours) parts.push(`营业：${spot.shopHours}`);
  parts.push('适合亲子家庭，建议预留半天时间，备好饮水与替换衣物。');
  return parts.join('\n');
}

// ② 评论 AI 评价：给用户评论自动生成一条【短评文字】（决策：仅短评，不做标签/多维分）
export function generateCommentReview(content) {
  const text = content || '';
  let summary = '一条真实体验记录，供其他家长参考。';
  let score = 0.5;
  if (/人多|排队|拥挤|避峰|错峰|人少|限流/.test(text)) {
    summary = '提到人流与排队情况，给出错峰建议，参考价值高。';
    score = 0.9;
  } else if (/岁|宝宝|婴儿|娃|幼儿|亲子|推车|哺乳/.test(text)) {
    summary = '结合带娃年龄/装备给出具体提示，很实用。';
    score = 0.85;
  } else if (/推荐|不错|值得|好评|喜欢|必去/.test(text)) {
    summary = '正面体验分享，可作出行决策参考。';
    score = 0.7;
  } else if (/坑|避雷|差|失望|贵|劝退/.test(text)) {
    summary = '提示了体验短板，帮助规避风险。';
    score = 0.6;
  }
  if (text.length > 30) score = Math.min(0.95, score + 0.05);
  return { summary, helpfulScore: Number(score.toFixed(2)) };
}
