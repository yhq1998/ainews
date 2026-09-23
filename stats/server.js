// 访问统计：只用随机访客 id（页面存在浏览器本地），不记录 IP、UA 或任何个人信息。
// 一次「访问」= 同一访客 30 分钟内的连续使用；「在线」= 最近 90 秒内有心跳的访客数。
const http = require('http'), fs = require('fs');
const FILE = process.env.STATS_FILE || '/data/stats.json';
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

http.createServer((req, res) => {
  const path = req.url.split('?')[0];
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
  res.statusCode = 404; res.end('{}');
}).listen(process.env.PORT || 8080, () => console.log('stats listening, file', FILE));
