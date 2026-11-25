// 后端多语言层（阶段 2）：按 Accept-Language 返回景点与系统攻略的译文。
//
// 设计要点：
// 1. 译文与业务数据**物理分离** —— 存 data/spot_i18n.json，不写进 db.json。
//    db.json 含用户 UGC（攻略/评论/投票），部署时绝不能被译文覆盖；分离后两者各自演进。
// 2. 缺译回退 —— 任何缺失的 city+name 键 / 字段都自动落回简体原文，接口永不返回 undefined 或空串。
// 3. zh-CN 零开销 —— 简体请求直接返回原对象，不做任何拷贝与查表。
// 4. 系统攻略按模板**重新生成**而非翻译存量文本 —— 系统攻略本就是
//    generateGuideTemplate(spot) 拼出来的，用译文重拼即可保证三语结构一致。
//    用户 UGC 攻略/评论**不翻译**（原文即作者本意，机器翻译反而失真）。
import fs from 'node:fs';
import path from 'node:path';

export const LOCALES = ['zh-CN', 'zh-HK', 'en'];
export const DEFAULT_LOCALE = 'zh-CN';

const FILE = path.resolve(process.cwd(), process.env.I18N_FILE || './data/spot_i18n.json');

let TRANS = {};
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    TRANS = raw && typeof raw === 'object' ? raw : {};
  } catch {
    TRANS = {}; // 文件缺失不致命：全部回退简体，服务照常可用
  }
}
load();

export function reloadTranslations() { load(); return Object.keys(TRANS).length; }
export function translationCount() { return Object.keys(TRANS).length; }
/** 活景点中被译文覆盖的数量（city+name 能在 spot_i18n 命中），比总键数更有意义（排除 dedup 孤儿死键） */
export function liveTranslationCount(spots) {
  let n = 0;
  for (const s of spots || []) if (TRANS[`${s.city} ${s.name}`]) n++;
  return n;
}

let watcher = null;
/**
 * 监听 spot_i18n.json 变化并热重载译文（部署/修正译文后无需重启服务）。
 * 幂等：重复调用返回同一 watcher。fs.watch 不可用时静默降级为“需手动重启”。
 */
export function watchTranslations() {
  if (watcher) return watcher;
  try {
    watcher = fs.watch(FILE, () => {
      const n = reloadTranslations();
      console.log(`[i18n] spot_i18n.json changed → reloaded ${n} entries`);
    });
    watcher.on('error', e => console.error('[i18n] watch error:', e && e.message));
    console.log(`[i18n] watching ${FILE} for hot reload`);
  } catch (e) {
    console.warn('[i18n] fs.watch unavailable, hot reload disabled:', e && e.message);
  }
  return watcher;
}

/**
 * 解析 Accept-Language，返回受支持的 locale。
 * 遵循 RFC 7231：按 q 值降序取第一个可识别的语言标签。
 * 港澳台繁体（zh-HK/zh-TW/zh-MO/zh-Hant）统一归到 zh-HK。
 */
export function parseLocale(header) {
  const raw = String(header || '').trim();
  if (!raw) return DEFAULT_LOCALE;
  const tags = raw.split(',')
    .map(part => {
      const seg = part.trim().split(';');
      const tag = (seg[0] || '').trim().toLowerCase();
      let q = 1;
      for (let i = 1; i < seg.length; i++) {
        const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(seg[i]);
        if (m) {
          const v = parseFloat(m[1]);
          if (!Number.isNaN(v)) q = v;
        }
      }
      return { tag, q };
    })
    .filter(x => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of tags) {
    if (tag === '*') continue;
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
    if (tag === 'zh' || tag.startsWith('zh-') || tag.startsWith('zh_')) {
      return /hant|hk|tw|mo/.test(tag) ? 'zh-HK' : 'zh-CN';
    }
  }
  return DEFAULT_LOCALE;
}

/** 从请求对象直接取 locale */
export function localeOf(req) {
  return parseLocale(req && req.headers && req.headers['accept-language']);
}

/**
 * 覆盖景点的可翻译字段（name/desc/highlights/feeLabel/categoryCn/city）。
 * 译文文件只存"与原文不同"的字段，故直接展开即可实现按字段回退。
 * 键用稳定的「城市+名称」(与 import-places 的 canonical 去重键一致)，不依赖 spot.id，
 * 避免重导入/去重重排 id 导致译文整体错位。
 * 不修改入参，返回浅拷贝。
 */
export function localizeSpot(spot, locale) {
  if (!spot) return spot;
  // 始终附带规范城市键 cityKey（中文原值），与展示用的本地化 city 分开，
  // 前端做城市筛选必须按规范键，不能用本地化后的 city（否则非简体下筛选失效）。
  const base = { cityKey: spot.city };
  if (locale === DEFAULT_LOCALE) return Object.assign({}, spot, base);
  const key = spot.city + ' ' + spot.name;
  const entry = TRANS[key];
  const over = entry && entry[locale];
  if (!over) return Object.assign({}, spot, base);
  // 过滤空串/null：缺译或空译文回退到原文，绝不留空白（API_CONTRACT 第 4 节要求）
  const clean = {};
  for (const [k, v] of Object.entries(over)) {
    if (v != null && v !== '') clean[k] = v;
  }
  if (Object.keys(clean).length === 0) return Object.assign({}, spot, base);
  return Object.assign({}, spot, base, clean);
}

// ── 系统攻略模板（与 ai.js generateGuideTemplate 结构一一对应）──
const GUIDE_TPL = {
  'zh-HK': {
    title: n => `【${n}】親子遊玩建議`,
    sep: '：', // 中文用全角冒号
    hl: '亮點', fee: '費用', hours: '營業',
    tail: '啱晒一家大細，建議預留半日時間，記得帶定飲用水同替換衫。'
  },
  'en': {
    title: n => `[${n}] Family Visit Tips`,
    sep: ': ', // 英文用半角冒号 + 空格
    hl: 'Highlights', fee: 'Admission', hours: 'Hours',
    tail: 'Great for families with children. Allow about half a day, and bring drinking water and a change of clothes.'
  }
};

// 营业时间里的中文短语（纯时间区间如 10:00-22:00 原样保留）
const HOURS_MAP = {
  'zh-HK': { '全天': '全日開放', '全天开放': '全日開放', '全年无休': '全年無休', '暂停开放': '暫停開放' },
  'en': { '全天': 'Open 24 hours', '全天开放': 'Open 24 hours', '全年无休': 'Open year-round', '暂停开放': 'Temporarily closed' }
};

function localizeHours(h, locale) {
  if (!h) return h;
  const m = HOURS_MAP[locale];
  return (m && m[h]) || h;
}

/**
 * 生成指定语言的系统攻略正文。
 * locale 为 zh-CN 或无译文时返回 null，调用方沿用数据库中的原文。
 */
export function systemGuideContent(spot, locale) {
  if (!spot || locale === DEFAULT_LOCALE) return null;
  const tpl = GUIDE_TPL[locale];
  if (!tpl) return null;
  const s = localizeSpot(spot, locale);
  const parts = [tpl.title(s.name)];
  if (s.desc) parts.push(s.desc);
  if (s.highlights) parts.push(`${tpl.hl}${tpl.sep}${s.highlights}`);
  if (s.feeLabel) parts.push(`${tpl.fee}${tpl.sep}${s.feeLabel}`);
  if (s.shopHours) parts.push(`${tpl.hours}${tpl.sep}${localizeHours(s.shopHours, locale)}`);
  parts.push(tpl.tail);
  return parts.join('\n');
}

/**
 * 攻略正文按语言取值：系统攻略走模板重生成，用户 UGC 原样返回。
 * @param {object} guide 攻略记录
 * @param {object} spot  所属景点（用于重生成模板）
 */
export function guideContent(guide, spot, locale) {
  if (!guide) return '';
  if (locale === DEFAULT_LOCALE || guide.source !== 'system') return guide.content;
  return systemGuideContent(spot, locale) || guide.content;
}
