// UGC 内容审核（评审 #6 · 合规必需）。
// MVP：本地正则 + 敏感词库兜底，命中即拒绝（先审后发，阻断入库）。
// 生产建议：替换为微信 msgSecCheck（免费，小程序标配）做异步机审，
// 此时本模块改为返回 {ok:true, pending:true}，内容先入库 status='pending'，机审通过后再置 'approved'。
import { CONFIG } from './config.js';

// 本地敏感词（示例，生产应外接词库/DFA）。命中视为违规直接拒绝。
const SENSITIVE_WORDS = ['违禁词示例', '涉政示例', '暴力示例'];

// 垃圾/引流正则：手机号、微信号、二维码话术、外部跳转。
const PATTERNS = [
  { name: '手机号', re: /(?:(?:\+?86)?1[3-9]\d{9})/ },
  { name: '微信号', re: /(?:微信|vx|weixin|加我|私聊)[\s:：]*(?:[a-zA-Z][a-zA-Z0-9_-]{5,19})/i },
  { name: '二维码', re: /(?:扫码|扫一扫|二维码|加群|QQ群)/ },
  { name: '外链引流', re: /(?:www\.)?[a-z0-9-]+\.(?:com|cn|net|top|xyz)(?:\/\S*)?/i }
];

export function moderate(text) {
  if (!CONFIG.MODERATION.enable) return { ok: true };
  const t = (text || '').trim();
  if (!t) return { ok: false, reason: '内容为空' };
  for (const w of SENSITIVE_WORDS) {
    if (t.includes(w)) return { ok: false, reason: `命中敏感词「${w}」` };
  }
  for (const p of PATTERNS) {
    if (p.re.test(t)) return { ok: false, reason: `疑似${p.name}，已被拦截` };
  }
  return { ok: true };
}

// HTML 实体转义（评审 #13 · XSS 防护）。
// UGC 内容入库前统一转义，前端 WXML 渲染时按文本显示，杜绝 <script>/畸形标签注入。
export function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
