// 访问统计：只用随机访客 id（页面存在浏览器本地），不记录 IP、UA 或任何个人信息。
// 一次「访问」= 同一访客 30 分钟内的连续使用；「在线」= 最近 90 秒内有心跳的访客数。
const http = require('http'), fs = require('fs');
const FILE = process.env.STATS_FILE || '/data/stats.json';
const SHARE_FILE = process.env.SHARE_FILE || '/data/shares.json';
const SITE = process.env.SITE_URL || 'https://ainews.omniapexroute.com';
const crypto = require('crypto');
const ONLINE_MS = 90e3, SESSION_MS = 30 * 60e3;
const bjDay = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);   // 按北京时间分天

let data = { total: 0, days: {} };
try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const seen = new Map();   // 访客 id → 最后心跳时间（只在内存里，重启后在线数从 0 重新累计）
let dirty = false;

function today() { const k = bjDay(); if (!data.days[k]) data.days[k] = { v: 0, ids: {} }; return data.days[k]; }
function beat(id) {
  const now = Date.now(), last = seen.get(id);
  if (!last || now - last > SESSION_MS) {
    data.total++; const d = today(); d.v++; d.ids[id] = 1; dirty = true;
  }
  seen.set(id, now);
}
function online() {
  const now = Date.now(); let n = 0;
  for (const [id, last] of seen) { if (now - last > SESSION_MS) seen.delete(id); else if (now - last <= ONLINE_MS) n++; }
  return n;
}
function snapshot() {
  const d = data.days[bjDay()] || { v: 0, ids: {} };
  return { online: online(), today: d.v, todayVisitors: Object.keys(d.ids).length, total: data.total };
}
// 定时落盘；过去日期的访客 id 列表压成数量，文件不会无限长大
setInterval(() => {
  if (!dirty) return; dirty = false;
  const k = bjDay();
  for (const [day, d] of Object.entries(data.days)) if (day !== k && d.ids) { d.u = Object.keys(d.ids).length; delete d.ids; }
  fs.writeFile(FILE + '.tmp', JSON.stringify(data), e => { if (!e) fs.rename(FILE + '.tmp', FILE, () => {}); });
}, 5000);

// ---------- 分享短链 ----------
// 接口没有按 id 取单条资讯的端点，所以分享时把这条资讯的摘要信息存一份，短链打开时再取回来展示。
// 只存页面上本来就公开显示的字段；同一条资讯多次分享复用同一个短码。
let shares = { byCode: {}, byItem: {} };
try { shares = JSON.parse(fs.readFileSync(SHARE_FILE, 'utf8')); } catch {}
let sharesDirty = false;
const FIELDS = ['id', 'title', 'originalTitle', 'summary', 'reason', 'category', 'score', 'publishedAt', 'selected'];
function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[\w-]{6,64}$/.test(raw.id) || typeof raw.title !== 'string') return null;
  const it = {};
  for (const k of FIELDS) if (raw[k] != null) it[k] = typeof raw[k] === 'string' ? raw[k].slice(0, 4000) : (typeof raw[k] === 'number' || typeof raw[k] === 'boolean') ? raw[k] : undefined;
  it.source = { name: String((raw.source && raw.source.name) || '').slice(0, 200) };
  const orig = raw.links && typeof raw.links.original === 'string' && /^https?:\/\//.test(raw.links.original) ? raw.links.original.slice(0, 2000) : null;
  it.links = orig ? { original: orig } : {};
  return it;
}
function makeShare(item) {
  const existing = shares.byItem[item.id];
  if (existing && shares.byCode[existing]) return existing;
  let code;
  do { code = crypto.randomBytes(6).toString('base64url').slice(0, 8); } while (shares.byCode[code]);
  shares.byCode[code] = { item, at: Date.now() };
  shares.byItem[item.id] = code;
  // 最多保留 5000 条，超出时淘汰最早的
  const codes = Object.keys(shares.byCode);
  if (codes.length > 5000) {
    codes.sort((a, b) => shares.byCode[a].at - shares.byCode[b].at).slice(0, codes.length - 5000).forEach(c => { delete shares.byItem[shares.byCode[c].item.id]; delete shares.byCode[c]; });
  }
  sharesDirty = true;
  return code;
}
setInterval(() => {
  if (!sharesDirty) return; sharesDirty = false;
  fs.writeFile(SHARE_FILE + '.tmp', JSON.stringify(shares), e => { if (!e) fs.rename(SHARE_FILE + '.tmp', SHARE_FILE, () => {}); });
}, 5000);
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 短链落地页：给微信 / 社交平台的爬虫看标题和摘要，真人访客立刻跳到主页面并自动打开这条资讯
function sharePage(code, item) {
  const title = esc(item.title), desc = esc((item.summary || '').slice(0, 120)), url = `${SITE}/s/${code}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · AI 动态</title>
<meta name="description" content="${desc}">
<meta property="og:type" content="article"><meta property="og:title" content="${title}"><meta property="og:description" content="${desc}"><meta property="og:url" content="${url}"><meta property="og:image" content="${SITE}/icons/icon-512.png"><meta property="og:site_name" content="AI 动态">
<meta http-equiv="refresh" content="0; url=/#s=${code}">
<script>location.replace('/#s=${code}')</script></head>
<body style="font:16px/1.6 -apple-system,sans-serif;padding:24px;color:#1d1c19;background:#f6f5f1"><p><b>${title}</b></p><p>${desc}</p><p><a href="/#s=${code}">正在打开…点此继续</a></p></body></html>`;
}

http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (req.method === 'HEAD') req.method = 'GET';   // 社交平台抓预览常先发 HEAD，按 GET 处理
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && path === '/api/stats/beat') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 300) req.destroy(); });
    req.on('end', () => {
      try { const { id } = JSON.parse(body || '{}'); if (typeof id === 'string' && /^[\w-]{8,64}$/.test(id)) beat(id); } catch {}
      res.end(JSON.stringify(snapshot()));
    });
    return;
  }
  if (req.method === 'GET' && path === '/api/stats') { res.end(JSON.stringify(snapshot())); return; }
  if (req.method === 'POST' && path === '/api/share') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      let item = null;
      try { item = sanitizeItem(JSON.parse(body || '{}')); } catch {}
      if (!item) { res.statusCode = 400; res.end('{"error":"bad item"}'); return; }
      const code = makeShare(item);
      res.end(JSON.stringify({ code, url: `${SITE}/s/${code}` }));
    });
    return;
  }
  let m = /^\/api\/share\/([\w-]{4,16})$/.exec(path);
  if (req.method === 'GET' && m) {
    const rec = shares.byCode[m[1]];
    if (!rec) { res.statusCode = 404; res.end('{"error":"not found"}'); return; }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(JSON.stringify(rec.item)); return;
  }
  m = /^\/s\/([\w-]{4,16})$/.exec(path);
  if (req.method === 'GET' && m) {
    const rec = shares.byCode[m[1]];
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!rec) { res.statusCode = 404; res.end('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">这个分享链接不存在或已过期。<a href="/">打开 AI 动态</a></p>'); return; }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(sharePage(m[1], rec.item)); return;
  }
  res.statusCode = 404; res.end('{}');
}).listen(process.env.PORT || 8080, () => console.log('stats listening, file', FILE));
