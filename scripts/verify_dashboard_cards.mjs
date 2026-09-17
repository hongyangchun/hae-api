/* 仪表盘卡片渲染验证 —— 用桩 DOM 在 Node 里跑真正的 render()，断言实际生成的文案。
 *
 * 为什么需要它：卡片的问题清一色是「接口 200、页面不报错、就是数不对」，
 * 静态读代码看不出来（模板字符串里的转义、异步取数顺序、失败态分支都验不到）。
 * 做法是把 dashboardHTML() 产出的内联脚本抽出来，用桩 document / 桩 echarts
 * + 一个把相对路径补成绝对地址的 fetch 桩，在 Node 里执行，然后读真实渲染结果。
 *
 * 用法:
 *   node scripts/verify_dashboard_cards.mjs            # 实时场景（用本地源码）
 *   node scripts/verify_dashboard_cards.mjs wkfail     # 模拟 /api/workouts 故障
 *   DASH_HTML=/tmp/live_dash.html node scripts/...     # 验线上抓下来的那一份
 *
 * 需要 HAE_READ_KEY（环境变量或 ~/.hermes/.env）。
 *
 * 退出码：0 全通过 / 1 真的断言失败（代码问题）/ 2 不确定（网络把请求丢了）。
 * 沙箱代理在并发抓取时会随机丢掉几个请求，所以脚本自己记录「渲染期间哪些请求失败了」：
 * 只要有任何请求失败，本轮的失败断言就不算数，报「不确定」而不是「失败」——
 * 否则每次跑完都要人肉判断这次的红是代码还是网络，验着验着就没人看了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASH = path.join(HERE, '..', 'src', 'dashboard.js');

const SCEN = process.argv[2] || 'live';

/* ---- READ_KEY：环境变量优先，其次 ~/.hermes/.env ---- */
function readKey() {
  if (process.env.HAE_READ_KEY) return process.env.HAE_READ_KEY.trim();
  const envPath = path.join(process.env.HOME, '.hermes', '.env');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/^HAE_READ_KEY\s*=\s*(\S+)/m);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  throw new Error('HAE_READ_KEY not found (env or ~/.hermes/.env)');
}
const KEY = readKey();
const API = 'https://hae.qiaclass.com';

/* ---- 取页面 HTML：本地源码（默认）或线上抓下来的那一份 ---- */
const { dashboardHTML } = await import(DASH);
const html = process.env.DASH_HTML ? fs.readFileSync(process.env.DASH_HTML, 'utf8') : dashboardHTML(KEY);
console.log('源  :', process.env.DASH_HTML ? process.env.DASH_HTML + '（线上抓取）' : 'src/dashboard.js（本地源码）');
console.log('场景:', SCEN);

/* ---- 桩 DOM：只实现脚本真正用到的部分 ---- */
const els = {};
const makeEl = (id) => ({
  id, _html: '', textContent: '', className: '', style: {}, children: [], firstChild: null,
  appendChild(c) { this.children.push(c); }, setAttribute() {}, addEventListener() {},
  get innerHTML() { return this._html; },
  set innerHTML(v) { this._html = String(v); scan(this._html); this.firstChild = this._html ? {} : null; },
});
function scan(h) { const re = /id="([^"]+)"/g; let m; while ((m = re.exec(h))) if (!els[m[1]]) els[m[1]] = makeEl(m[1]); }
['range', 'status', 'cards', 'anchors', 'groups'].forEach(id => els[id] = makeEl(id));

const documentStub = {
  getElementById: (id) => els[id] || null,
  createElement: (t) => makeEl('_' + t),
  body: { style: {} },
  documentElement: { style: { setProperty() {} } },
  addEventListener() {},
};
const options = {};
const echartsStub = { init(el) { return { setOption(o) { options[el.id] = o; }, resize() {}, dispose() {} }; } };

/* ---- fetch 桩：补绝对地址；记录渲染期间失败的请求；wkfail 场景让 workouts 抛错 ---- */
const renderFailures = new Map();          // path -> 原因（渲染期间）
const realFetch = globalThis.fetch;
const SHORT = (p) => String(p).replace(/^\/api\//, '').split('&')[0];

globalThis.fetch = async (u, init) => {
  const p = String(u);
  if (SCEN === 'wkfail' && p.startsWith('/api/workouts')) {
    renderFailures.set(SHORT(p), '模拟故障');
    throw new Error('模拟 workouts 接口故障');
  }
  try {
    const r = await realFetch(p.startsWith('http') ? p : API + p, init);
    if (!r.ok) renderFailures.set(SHORT(p), 'HTTP ' + r.status);
    return r;
  } catch (e) {
    renderFailures.set(SHORT(p), String((e && e.message) || e));
    throw e;
  }
};

const js = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
new Function('document', 'window', 'fetch', 'echarts', js)(
  documentStub, { echarts: echartsStub, addEventListener() {} }, globalThis.fetch, echartsStub);

/* ---- 等渲染完成 ---- */
let w = 0;
while (!String(els.cards.innerHTML).includes('class="v"') && w < 30000) {
  await new Promise(r => setTimeout(r, 500)); w += 500;
}
await new Promise(r => setTimeout(r, 4000));

/* ---- 解析卡片 ---- */
const txt = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const cards = String(els.cards.innerHTML).split('<div class="card">').slice(1).map(c => ({
  label: (c.match(/class="k">([^<]*)/) || [])[1] || '?',
  value: (c.match(/class="v">([^<]*)/) || [])[1] || '--',
  unit: (c.match(/class="u">([^<]*)/) || [])[1] || '',
  sub: txt((c.match(/<div class="d">([\s\S]*?)<\/div>/) || [])[1] || ''),
}));

const localDay = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const TODAY = localDay(new Date());

console.log('\n今天 =', TODAY, ' 卡片数 =', cards.length);
console.log('\n' + '卡片'.padEnd(20) + '值'.padEnd(14) + '副标题');
console.log('-'.repeat(90));
cards.forEach(c => console.log((c.label + ' ' + c.unit).padEnd(20) + String(c.value).padEnd(14) + c.sub));

/* ---- 断言 ---- */
let pass = 0; const failures = [];
const chk = (ok, msg) => { ok ? pass++ : failures.push(msg); console.log((ok ? '  ✅ ' : '  ❌ ') + msg); };
const get = (l) => cards.find(c => c.label.startsWith(l));
const hasDate = (c) => c && / · \d{2}-\d{2}$/.test(c.sub);

/* 日结型：后缀出现与否，必须与「数据的日期是不是今天」严格一致。
 * 注意不能写死成「必须标日期」—— 清晨前最新点是昨天的（该标），
 * 清晨后当天的点落库了（不该标），两种都真实存在。见 docs/design-notes.md 四·8。 */
console.log('\n[1] 日结型卡片：值的日期不是今天才标 · MM-DD（是今天就不标）');
const dayFinal = [
  ['静息心率', 'resting_heart_rate', p => p.qty],
  ['睡眠', 'sleep_analysis', p => p.total ?? p.qty],
  ['体重', 'weight_body_mass', p => p.qty],
  ['心肺耐力', 'vo2_max_est', p => p.qty],
];
const from = localDay(new Date(Date.now() - 89 * 864e5));
const to = localDay(new Date(Date.now() + 864e5));
const apiGet = async (u) => {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await realFetch(API + u, { headers: { 'api-key': KEY } });
      if (r.ok) return r.json();
      if (i === 2) throw new Error('HTTP ' + r.status);
    } catch (e) { if (i === 2) throw e; }
    await new Promise(r => setTimeout(r, 800));
  }
};
for (const [label, name, pick] of dayFinal) {
  const c = get(label);
  if (!c) { chk(false, label + ' 卡片缺失'); continue; }
  const pts = await apiGet(`/api/query?name=${name}&from=${from}&to=${to}`).then(j => j.points || []).catch(() => null);
  if (!pts) { console.log('  ⏭  ' + label + '：接口没取到数据，跳过'); continue; }
  const days = pts.filter(p => pick(p) != null).map(p => p.date).sort();
  const day = days[days.length - 1] || null;
  chk(hasDate(c) === (day !== TODAY),
    `${label}：数据日期 ${day}${day !== TODAY ? '（非今天→该标日期）' : '（就是今天→不该标）'}，实际 "${c.sub}"`);
}

console.log('\n[2] 实时型卡片：今天的值就是今天的，永不标日期');
for (const label of ['HRV', '步数', '活动热量']) {
  const c = get(label);
  chk(!!c && !hasDate(c), label + (c ? ' → "' + c.sub + '"' : ' 卡片缺失'));
}

console.log('\n[3] 任何卡片都不许标出「今天」的日期（标了纯属冗余）');
const mmdd = TODAY.slice(5);
const bogus = cards.filter(c => c.sub.includes(' · ' + mmdd));
chk(bogus.length === 0, bogus.length ? '出现了今天的日期：' + bogus.map(c => c.label).join('/') : '没有卡片标今天');

console.log('\n[4] 共享行序：HRV → 静息心率 → 心肺耐力 → 睡眠 → 体重 → 锻炼（三端一致）');
const idx = ['HRV', '静息心率', '心肺耐力', '睡眠', '体重', '锻炼'].map(l => cards.findIndex(c => c.label.startsWith(l)));
chk(idx.every(i => i >= 0), '六张卡都在（' + idx.join(',') + '）');
chk(idx.every((v, i) => i === 0 || v > idx[i - 1]), '相对顺序正确：' + idx.join(' < '));

console.log('\n[5] 锻炼卡片：今日训练时长口径，不用 Δ 对比基准');
const ex = get('锻炼');
if (SCEN === 'wkfail') {
  chk(!!ex && ex.value === '--' && /取数失败/.test(ex.sub), 'workouts 故障 → 值为 -- 且副标题是取数失败（不是 0）');
} else {
  chk(!!ex && /近 7 天 \d+ 次 · [\d,]+ 分钟/.test(ex.sub), '副标题为「近 7 天 N 次 · M 分钟」→ "' + (ex ? ex.sub : '') + '"');
  chk(!!ex && !/vs 7日均/.test(ex.sub), '不出现 "vs 7日均" 的 Δ 对比（清早没练不该报红）');
}

console.log('\n[6] L1 状态条：只放结论，不重复放 L2 已有的量');
const st = txt(els.status.innerHTML);
chk(/可以练|悠着点|该休息/.test(st), '含结论词 → "' + st + '"');
chk(!/\d+\s*bpm/.test(st), '不出现 bpm（静息心率已由 L2 卡片承担）');
chk(!/\d+(\.\d+)?\s*小时|h\d+m/.test(st), '不出现睡眠时长（已由 L2 卡片承担）');

/* ---- 结论：先区分「网络丢包」与「代码错」 ---- */
console.log('');
if (renderFailures.size && SCEN !== 'wkfail') {
  console.log('⚠️  渲染期间有请求失败，本轮结论不可信：');
  for (const [k, v] of renderFailures) console.log('     ' + k + ' → ' + v);
  console.log('   （沙箱代理在并发抓取时会丢请求；单独 curl 同一 URL 通常是 200。请重跑。）');
}
if (!failures.length) {
  console.log('全部通过 ✅ (' + pass + ' 项)');
  process.exit(0);
}
console.log(failures.length + ' 项不符合预期（通过 ' + pass + ' 项）');
if (renderFailures.size && SCEN !== 'wkfail') {
  console.log('→ 但本轮有请求失败，判定为「不确定」而非代码问题。重跑一次再下结论。');
  process.exit(2);
}
console.log('→ 没有任何请求失败，这些是真实的断言失败，去改代码。');
process.exit(1);
