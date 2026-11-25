// 微信登录：用 code 换 openid + 签发 token。
import crypto from 'node:crypto';
import { CONFIG } from './config.js';
import { db } from './db.js';

// ── access_token 缓存（imgSecCheck 等需要；client_credential 调用频率极低，内存缓存足够）──
let _accessToken = null; // { token, exp }
export async function getAccessToken() {
  const now = Date.now();
  if (_accessToken && _accessToken.exp > now + 5 * 60000) return _accessToken.token;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${CONFIG.WECHAT_APPID}&secret=${CONFIG.WECHAT_SECRET}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.access_token) throw new Error('wx token failed: ' + (j.errmsg || JSON.stringify(j)));
  _accessToken = { token: j.access_token, exp: now + (j.expires_in || 7200) * 1000 };
  return _accessToken.token;
}

// 图片内容安全校验（同步 img_sec_check）。
// 入参 buf=图片二进制、mime=image/png 等；返回 { ok, errcode, errmsg }。
// errcode=0 通过；87014=内容违规；其他视为「校验服务异常」由调用方决定是否放行。
export async function imgSecCheck(buf, mime) {
  const token = await getAccessToken();
  const boundary = '----kts' + crypto.randomBytes(16).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="check.bin"\r\nContent-Type: ${mime}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buf, tail]);
  const r = await fetch(`https://api.weixin.qq.com/wxa/img_sec_check?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  });
  const j = await r.json().catch(() => ({}));
  return { ok: j.errcode === 0, errcode: j.errcode, errmsg: j.errmsg };
}

function makeToken(openid) {
  const sig = crypto.createHmac('sha256', CONFIG.TOKEN_SECRET).update(openid).digest('hex');
  return Buffer.from(openid).toString('base64url') + '.' + sig;
}

// 校验请求里的 Bearer token，返回 openid 或 null（过期/无效均返回 null → 上层判 401）
export function verifyToken(token) {
  if (!token) return null;
  const s = db.getSession(token);
  if (!s) return null;
  if (s.expiresAt && s.expiresAt < Date.now()) {
    delete db.data.sessions[token]; // 过期即清，下次请求走重新登录
    db.persist();
    return null;
  }
  return s.openid;
}

// 用 wx.login 返回的 code 换取 openid（真实 code2session）
export async function loginWithCode(code) {
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${CONFIG.WECHAT_APPID}` +
    `&secret=${CONFIG.WECHAT_SECRET}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const expiresAt = Date.now() + CONFIG.TOKEN_TTL_DAYS * 24 * 3600 * 1000;
  try {
    const r = await fetch(url);
    const j = await r.json();
    if (j && j.openid) {
      const token = makeToken(j.openid);
      db.setSession(token, j.openid, expiresAt);
      db.persist();
      return { openid: j.openid, token, expires_in: CONFIG.TOKEN_TTL_DAYS * 86400 };
    }
    throw new Error(j.errmsg || 'wx login failed');
  } catch (e) {
    // 本地无外网 / 联调时，DEV_MODE 兜底：用伪 openid 让服务可跑
    if (CONFIG.DEV_MODE) {
      const openid = 'dev_' + crypto.createHash('sha256').update(code || 'anon').digest('hex').slice(0, 12);
      const token = makeToken(openid);
      db.setSession(token, openid, expiresAt);
      db.persist();
      return { openid, token, expires_in: CONFIG.TOKEN_TTL_DAYS * 86400, dev: true };
    }
    throw e;
  }
}
