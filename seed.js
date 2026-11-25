// 种子数据：景点 + 系统默认攻略（冷启动）。仅在库为空时写入。
import { db } from './db.js';
import { generateGuideTemplate } from './ai.js';

export function seedIfEmpty() {
  // 五轮 #7：确保「官方推荐」系统账号存在（openid='system' 仅作占位，永不用于登录），
  // 使 system 种子攻略的 author 带官方背书而非匿名。
  db.upsertUser('system', { nickname: '官方推荐', avatar_url: '' });
  if (db.getSpots().length > 0) { db.persist(); return; }
  const spots = [
    { name: '深圳湾公园', city: '深圳', category: 'park', categoryCn: '公园', desc: '滨海步道，可观候鸟、放风筝，平坦好推车。', highlights: '沿海栈道/草坪/自行车道', address: '南山区滨海大道', phone: '', feeLabel: '免费', feeClass: 'free', isPlaces: true, shopHours: '全天', lat: 22.482, lng: 113.935, systemScore: 88 },
    { name: '欢乐海岸', city: '深圳', category: 'mall', categoryCn: '综合体', desc: '购物中心+水秀剧场，室内外结合，适合半日游。', highlights: '水秀/海洋奇梦馆/餐饮', address: '南山区白石路', phone: '', feeLabel: '免费入园', feeClass: 'free', isPlaces: false, shopHours: '10:00-22:00', lat: 22.532, lng: 113.937, systemScore: 80 },
    { name: '深圳野生动物园', city: '深圳', category: 'zoo', categoryCn: '动物园', desc: '乘车游览+步行区，动物种类多，亲子热门。', highlights: '海洋天地/小火车', address: '南山区西丽', phone: '', feeLabel: '¥240', feeClass: 'paid', isPlaces: true, shopHours: '09:30-18:00', lat: 22.596, lng: 113.973, systemScore: 85 },
    { name: '宝安欢乐港湾', city: '深圳', category: 'park', categoryCn: '公园', desc: '海滨文化公园+摩天轮，夜景漂亮。', highlights: '摩天轮/草坪/喷泉', address: '宝安区', phone: '', feeLabel: '免费', feeClass: 'free', isPlaces: true, shopHours: '全天', lat: 22.557, lng: 113.883, systemScore: 82 }
  ];
  for (const s of spots) {
    const id = db.nextId('spots');
    const spot = { id, ...s, likes: 0, dislikes: 0 };
    db.data.spots.push(spot);
    const gid = db.nextId('guides');
    db.data.guides.push({
      id: gid, spotId: id, userId: 'system', content: generateGuideTemplate(spot),
      likes: 0, dislikes: 0, isDefault: true, source: 'system', createdAt: new Date().toISOString()
    });
  }
  db.persist();
  console.log('[seed] 已写入', spots.length, '个景点及系统默认攻略');
}
