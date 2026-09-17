/* ---------- 内置仪表盘页（/dashboard，Cookie 记住登录一年） ---------- */

export async function dashSig(env) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(env.DASH_TOKEN || ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('dash-cookie-v1'));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function loginHTML(msg) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>健康 · 登录</title><style>
body{background:#0d1117;color:#e6edf3;font:15px/1.6 -apple-system,'PingFang SC',sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0}
.box{background:#161b22;border:1px solid #21262d;border-radius:12px;padding:24px;width:min(320px,88vw);text-align:center}
h1{font-size:18px;margin:0 0 8px}p{color:#8b949e;font-size:12px;margin:0 0 16px}
input{width:100%;box-sizing:border-box;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:12px}
button{width:100%;background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:10px;font-size:14px;cursor:pointer}
input:focus-visible,button:focus-visible{outline:2px solid #2f81f7;outline-offset:2px}
.err{color:#f85149;font-size:12px;margin-top:12px}
</style></head><body><div class="box"><h1><span aria-hidden="true">🏃</span> 健康 · HAE</h1><p>私有数据，请验证后访问</p>
<form method="post" action="/dashboard"><input type="password" name="pass" placeholder="访问口令" autofocus><button>进入</button></form>
${msg ? `<div class="err">${msg}</div>` : ''}</div></body></html>`;
}

/* 三层信息架构：L1 结论（状态条）→ L2 关键量（带基准的卡片）→ L3 明细（分组图表 + 记录）。
 * 宽度决定包含哪几层，不改变结构 —— 插件端只取 L1（菜单栏）或 L1+L2+L3 的裁剪版，
 * 层级定义与文案口径三端共用（见 hae-pulse 的 collector.py / render.py）。
 *
 * 排版约定（改样式前先读）：
 *   - 字号刻度：24 卡片数值 / 15 次强调 / 13 标题 / 12 正文 / 11 辅助
 *   - 间距只用 4 / 8 / 12 / 16 / 24
 *   - 图表标题放真实 DOM（h3）而不是 ECharts 的 title —— 一是避免与面板标题重复，
 *     二是 canvas 里的文字读屏软件读不到，放 DOM 才能被无障碍工具拿到。
 *   - 颜色语义：绿=对我有利、琥珀=偏离基准、红=仅用于越界/异常。
 *     静息心率下降是好事，所以它不再是红色（曾经与「心率 max」同色，语义反了）。
 */
export function dashboardHTML(readKey) {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>健康 · HAE</title>
<script src="https://registry.npmmirror.com/echarts/5.5.1/files/dist/echarts.min.js"></script>
<style>
:root{color-scheme:dark;
 --bg:#0d1117;--bg2:#161b22;--line:#21262d;--line2:#30363d;
 --fg:#e6edf3;--fg2:#c9d1d9;--dim:#8b949e;--accent:#2f81f7;
 --ok:#3fb950;--warn:#d29922;--bad:#f85149;
 --sans:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;
 --mono:'SF Mono',Menlo,ui-monospace,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 var(--sans);padding:16px}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:13px;font-weight:500;color:var(--fg2);margin:0 0 8px;letter-spacing:.02em}
h3{font-size:13px;font-weight:500;color:var(--fg2);margin:2px 6px 0}
.sub{color:var(--dim);font-size:12px;margin-bottom:12px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.range{display:inline-flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.range button{background:var(--bg2);color:var(--dim);border:1px solid var(--line2);border-radius:16px;padding:4px 14px;cursor:pointer;font-size:13px;font-family:inherit}
.range button:hover{color:var(--fg)}
.range button.on{color:#fff;border-color:var(--accent);background:#1f3a5f;font-weight:600}
/* ---- L1 状态条 ---- */
.status{display:flex;flex-wrap:wrap;gap:16px;align-items:center;background:var(--bg2);border:1px solid var(--line);border-left:3px solid var(--dim);border-radius:12px;padding:14px 16px;margin-bottom:16px}
.status.ok{border-left-color:var(--ok)}
.status.warn{border-left-color:var(--warn)}
.status.bad{border-left-color:var(--bad)}
.lead{flex:1;min-width:220px}
.lead .vt{font-size:18px;font-weight:600}
.status.ok .vt{color:var(--ok)}
.status.warn .vt{color:var(--warn)}
.status.bad .vt{color:var(--bad)}
.lead .vh{color:var(--dim);font-size:12px;margin-top:2px}
.kpis{display:flex;gap:16px;flex-wrap:wrap}
.kpi{min-width:92px}
.kpi .kk{color:var(--dim);font-size:11px}
.kpi .kv{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.kpi .kd{font-size:11px;color:var(--dim)}
/* ---- L2 卡片 ---- */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(164px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card .k{color:var(--dim);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card .vrow{display:flex;align-items:flex-end;gap:6px;margin-top:2px}
.card .v{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.15}
.card .u{font-size:12px;color:var(--dim);padding-bottom:3px;white-space:nowrap}
.card .mini{margin-left:auto;flex:none}
.card .d{color:var(--dim);font-size:11px;margin-top:4px;min-height:15px}
.delta{font-weight:600}
.delta.good{color:var(--ok)}
.delta.bad{color:var(--warn)}
.delta.flat{color:var(--dim)}
/* ---- 锚点 ---- */
.anchors{position:sticky;top:0;z-index:5;display:flex;gap:8px;flex-wrap:wrap;padding:8px 0;margin-bottom:8px;background:var(--bg)}
.anchors a{font-size:12px;color:var(--dim);text-decoration:none;border:1px solid var(--line2);border-radius:12px;padding:2px 12px}
.anchors a:hover{color:var(--fg);border-color:var(--dim)}
/* ---- L3 分组与图表 ---- */
.group{margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(440px,100%),1fr));gap:12px}
.panel{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:10px}
.psub{font-size:11px;color:var(--dim);margin:2px 6px 0}
.chart{height:240px}
/* ---- 三态：加载 / 空 / 失败（失败必须与空态在视觉上分明） ---- */
.state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;color:var(--dim);font-size:12px;text-align:center;padding:0 12px}
.state button{background:var(--bg);color:var(--fg2);border:1px solid var(--line2);border-radius:8px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit}
.state button:hover{color:var(--fg);border-color:var(--dim)}
.skel{width:100%;height:100%;border-radius:8px;background:linear-gradient(90deg,#161b22 25%,#1d2733 50%,#161b22 75%);background-size:200% 100%;animation:sk 1.4s linear infinite}
@keyframes sk{0%{background-position:200% 0}100%{background-position:-200% 0}}
/* ---- 表格（窄屏改卡片式，一行一次锻炼） ---- */
table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}
th{color:var(--dim);text-align:left;font-weight:500;padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:8px 10px;border-bottom:1px solid var(--line);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
@media (max-width:575px){
 .cards{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}
 table,thead,tbody,tr,td,th{display:block}
 thead{display:none}
 tr{border-bottom:1px solid var(--line);padding:4px 0}
 tr:last-child{border-bottom:0}
 td{border:0;padding:4px 10px;display:flex;justify-content:space-between;gap:12px;white-space:normal}
 td::before{content:attr(data-l);color:var(--dim);flex:none}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<h1><span aria-hidden="true">🏃</span> 健康 · HAE</h1>
<div class="sub">Apple Watch → Cloudflare · 数据每日自动同步</div>
<div class="range" id="range" role="group" aria-label="时间范围"></div>
<div class="status" id="status" aria-live="polite"></div>
<div class="cards" id="cards"></div>
<div class="anchors" id="anchors" aria-label="图表分组导航"></div>
<div id="groups"></div>
<script>
var KEY='__READKEY__';var RANGE=90;
var CH={},DATA={},FAIL={},P={},BUILT=false;
function dstr(d){return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2)}
function from(){var d=new Date();d.setDate(d.getDate()-RANGE+1);return dstr(d)}
function to(){var d=new Date();d.setDate(d.getDate()+1);return dstr(d)}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function num(n,d){if(n==null||isNaN(n))return '--';return Number(n).toFixed(d==null?1:d)}
// sep=1 时加千分位（步数/热量这类大数不加分隔读不出量级）
function fmt(n,d,sep){var s=num(n,d);if(s==='--'||!sep)return s;var p=s.split('.');p[0]=p[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g,',');return p.join('.')}
function mean(a){if(!a||!a.length)return null;var s=0;for(var i=0;i<a.length;i++)s+=a[i];return s/a.length}
function scalarize(pts){return (pts||[]).map(function(p){return{date:p.date,qty:(p.qty!=null?p.qty:p.avg)}})}
function ptsAxis(pts){return (pts||[]).map(function(p){return String(p.date).slice(5)})}
// 未分期睡眠：Apple 的 asleepUnspecified。老数据没有该槽，用「总时长-已分类」推导
function unclass(p){if(p.unclassified!=null)return p.unclassified;var s=(p.deep||0)+(p.rem||0)+(p.core||0);return p.total!=null?Math.max(0,Math.round((p.total-s)*1000)/1000):null}
// 三态请求。旧版把失败 catch 成空数组，于是 401/网络/CORS 全渲染成「暂无数据」——
// 健康面板最不能容忍静默失败，所以这里返回 null 并把错误留在 FAIL 里。
function load(n,extra,raw){
 var url='/api/query?name='+n+(extra||'')+'&from='+from()+'&to='+to();
 return fetch(url,{headers:{'api-key':KEY}}).then(function(r){
  if(!r.ok)throw new Error('HTTP '+r.status);
  return r.json();
 }).then(function(j){
  DATA[n]=j.points||[];if(raw)DATA[n+'_meta']=j;delete FAIL[n];return DATA[n];
 }).catch(function(e){FAIL[n]=String((e&&e.message)||e);return null});
}
function loadWorkouts(){
 return fetch('/api/workouts?from='+from()+'&to='+to(),{headers:{'api-key':KEY}}).then(function(r){
  if(!r.ok)throw new Error('HTTP '+r.status);
  return r.json();
 }).then(function(j){DATA.workouts=j.workouts||[];delete FAIL.workouts;return DATA.workouts})
  .catch(function(e){FAIL.workouts=String((e&&e.message)||e);return null});
}
// 最后一个非空值。注意 v!==0 的老判断会把「真是 0 步」的一天跳过去，改成只判 null
function last(pts,k){if(!pts||!pts.length)return{v:null,d:''};for(var i=pts.length-1;i>=0;i--){var v=k?pts[i][k]:pts[i].qty;if(v!=null)return{v:v,d:pts[i].date}}return{v:null,d:''}}
/* ---- 状态语义 ----
 * verdict 的三段阈值与 hae-pulse 的 collector.py 共用同一套口径（今日 HRV 对比前 7 日均值：
 * >=-5% 可以练 / >=-15% 悠着点 / 更低该休息）。两处实现、一处定义 —— 改阈值要同时改。
 */
var VD={
 ready:{t:'可以练',h:'恢复到位，按计划训练',c:'ok'},
 watch:{t:'悠着点',h:'恢复偏慢，建议降强度',c:'warn'},
 rest:{t:'该休息',h:'恢复不足，今天以休息为主',c:'bad'},
 none:{t:'数据不足',h:'还没有足够的基准数据',c:'dim'}
};
function verdictOf(){var d=P.hrvDelta;if(d==null)return 'none';return d>=-5?'ready':d>=-15?'watch':'rest'}
/* ---- 心肺耐力(VO2max)参考带 ----
 * 数值来自 Cooper Institute 的 ACLS 队列，即 ACSM《运动测试与运动处方指南》第 11 版
 * Table 4.7 的男性百分位带。四个阈值依次是「较差|及格」「及格|一般」「一般|良好」
 * 「良好|优秀」的分界，取的是**各档起始值**（上一档以 x.y 结束、下一档从 x.y+0.1 起）。
 *   ACSM 原表是 Poor/Fair/Average/Good/Excellent/Superior 六档，这里把最顶上的
 *   Superior（40-49 岁为 ≥55.6）并进了「优秀」—— 那是竞技运动员区间，日常到不了。
 *   成人一般人群基线，含大量久坐者 —— 「一般」= 和全部同龄人比处于中段，
 *   不等于「不健康」。看自己这条线的走向比看等级更有意义：估算本身有 ±10~15% 误差，
 *   恰好压在分界上时（如 40-49 岁的 47.4）等级会来回跳，那是噪声不是变化。
 * 只用于画参考线和标等级，不参与任何计算。年龄改 PROF.age 即可（按十位取整归档）。
 */
var PROF={sex:'male',age:44};
var BANDS={20:[37.4,44.8,50.9,57.4],30:[34.0,39.8,45.1,51.6],40:[30.2,35.4,40.7,47.4],50:[25.7,30.4,35.4,41.7],60:[22.4,26.4,30.7,36.4],70:[19.3,22.8,26.8,32.5]};
var BAND_LABELS=['较差','及格','一般','良好','优秀'];
function bandOf(v){
 if(v==null||isNaN(v))return null;
 var dec=Math.floor(PROF.age/10)*10;var t=BANDS[dec]||BANDS[40];
 for(var i=0;i<4;i++)if(v<t[i])return{v:v,i:i,label:BAND_LABELS[i],lo:i?t[i-1]:null,hi:t[i],bands:t};
 return{v:v,i:4,label:BAND_LABELS[4],lo:t[3],hi:null,bands:t};
}
function bandDesc(){var dec=Math.floor(PROF.age/10)*10;return '男 '+dec+'-'+(dec+9)}
/* ---- 值 + 7 日基准 ----
 * better 指出「哪个方向对我有利」：HRV 越高越好(up)，静息心率越低越好(down)。
 * 方向决定 Δ 的颜色，所以同一个 ▲ 在不同卡片上可能是绿也可能是琥珀 —— 这是有意的。
 */
function stat(pts,key,better){
 var vs=[];for(var i=0;i<pts.length;i++){var v=key?pts[i][key]:pts[i].qty;if(v!=null)vs.push(v)}
 if(!vs.length)return null;
 var cur=vs[vs.length-1],base=mean(vs.slice(-8,-1));
 var dp=(base)?Math.round((cur-base)/base*1000)/10:null;
 var dir=(dp!=null&&Math.abs(dp)>=1)?(dp>0?'up':'down'):null;
 var good='flat';
 if(dir!=null&&better!=='none')good=(dir===better)?'good':'bad';
 return{cur:cur,base:base,dp:dp,dir:dir,good:good,trend:vs.slice(-14)};
}
function deltaHTML(s){
 if(!s||s.dp==null)return '<span class="delta flat">基准不足</span>';
 var ar=s.dir==='up'?'\\u25B2':s.dir==='down'?'\\u25BC':'\\u2014';
 return '<span class="delta '+s.good+'">'+ar+' '+Math.abs(s.dp).toFixed(1)+'%</span> vs 7日均 '+num(s.base,1);
}
// 迷你趋势：内联 SVG，不引第三方库，也不占 ECharts 实例
function spark(vals,color){
 var vs=(vals||[]).filter(function(v){return v!=null});
 if(vs.length<3)return '';
 var W=52,H=22,lo=Math.min.apply(null,vs),hi=Math.max.apply(null,vs);
 if(hi-lo<1e-9)hi=lo+1;
 var pts=[],n=vs.length;
 for(var i=0;i<n;i++)pts.push((1+i*(W-2)/(n-1)).toFixed(1)+','+(H-1-((vs[i]-lo)/(hi-lo))*(H-2)).toFixed(1));
 return '<svg class="mini" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" aria-hidden="true">'+
  '<polyline fill="none" stroke="'+color+'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="'+pts.join(' ')+'"/></svg>';
}
/* ---- 图表骨架（只建一次，切范围时不再重建 DOM，避免整页闪烁） ---- */
var GROUPS=[
 {id:'g-rest',t:'恢复',panels:[
  ['c4','心率 min / avg / max','心率的最小/平均/最大值'],
  ['c5','静息心率 (bpm)','静息心率趋势'],
  ['c6','HRV (ms)','心率变异性趋势'],
  ['c3','睡眠结构 (小时)','睡眠分期堆叠，柱高即睡眠时长（不含清醒）']]},
 {id:'g-act',t:'活动',panels:[
  ['c1','步数','每日步数'],
  ['c2','活动热量 (kcal)','每日活动热量'],
  ['c9','步行+跑步距离 (km)','每日步行与跑步距离']]},
 {id:'g-body',t:'身体',panels:[
  ['c7','体重 (kg)','体重趋势'],
  ['c8','血氧 (%)','血氧饱和度趋势']]},
 {id:'g-eval',t:'评估',panels:[
  ['c10','心肺耐力 VO2max · 估算 (mL/kg/min)','心肺耐力估算趋势']]}
];
function buildDOM(){
 var g=document.getElementById('groups');var h='';var a='';
 GROUPS.forEach(function(gr){
  a+='<a href="#'+gr.id+'">'+esc(gr.t)+'</a>';
  h+='<section class="group" id="'+gr.id+'"><h2>'+esc(gr.t)+'</h2><div class="grid">';
  gr.panels.forEach(function(p){
   h+='<div class="panel"><h3>'+esc(p[1])+'</h3><div class="psub" id="'+p[0]+'s"></div>'+
      '<div class="chart" id="'+p[0]+'" role="img" aria-label="'+esc(p[2])+'"></div></div>';
  });
  h+='</div></section>';
 });
 h+='<section class="group" id="g-log"><h2>锻炼记录</h2><div class="panel" id="wk"></div></section>';
 a+='<a href="#g-log">锻炼记录</a>';
 document.getElementById('anchors').innerHTML=a;
 g.innerHTML=h;
}
function chartOf(id){
 var box=document.getElementById(id);if(!box)return null;
 if(!CH[id]){box.innerHTML='';if(window.echarts)CH[id]=echarts.init(box)}
 return CH[id]||null;
}
// 三态渲染：state = ok | load | empty | fail
function draw(id,series,opts){
 opts=opts||{};
 var box=document.getElementById(id);if(!box)return;
 if(opts.state&&opts.state!=='ok'){
  if(CH[id]){try{CH[id].dispose()}catch(e){};delete CH[id]}
  if(opts.state==='load')box.innerHTML='<div class="state"><div class="skel"></div></div>';
  else if(opts.state==='fail')box.innerHTML='<div class="state"><div>取数失败：'+esc(opts.err||'未知错误')+'</div>'+
   '<button type="button" onclick="retryAll()">重试</button></div>';
  else box.innerHTML='<div class="state">'+esc(opts.text||'这段时间没有数据')+'</div>';
  return;
 }
 var c=chartOf(id);
 if(!c){box.innerHTML='<div class="state">图表库未加载</div>';return}
 var o={backgroundColor:'transparent',
  tooltip:{trigger:'axis'},
  legend:{show:series.length>1,bottom:0,textStyle:{color:'#8b949e',fontSize:11},itemWidth:12,itemHeight:8},
  grid:{left:44,right:14,top:12,bottom:series.length>1?34:22},
  xAxis:{type:'category',data:opts.axis||[],axisLabel:{color:'#8b949e',fontSize:11,hideOverlap:true}},
  yAxis:Object.assign({type:'value',axisLabel:{color:'#8b949e',fontSize:11},splitLine:{lineStyle:{color:'#21262d'}}},opts.y||{}),
  series:series.map(function(s){return Object.assign({type:s.type||'line',name:s.name,data:s.data,smooth:true,barMaxWidth:18,symbolSize:4,lineStyle:{width:2},itemStyle:{color:s.color}},s.extra||{})})};
 c.setOption(o,true);
}
function sub(id,text){var e=document.getElementById(id+'s');if(e)e.textContent=text||''}
function setAll(id,state,err){draw(id,null,{state:state,err:err})}
/* ---- 数据汇总 ---- */
function computeAll(){
 P.hrv=stat(scalarize(DATA.heart_rate_variability||[]),null,'up');
 P.rhr=stat(scalarize(DATA.resting_heart_rate||[]),null,'down');
 P.wt=stat(DATA.weight_body_mass||[],null,'none');
 P.step=stat(DATA.step_count||[],null,'up');
 P.ae=stat(DATA.active_energy||[],null,'up');
 P.ex=stat(DATA.apple_exercise_time||[],null,'up');
 P.spo2=stat(scalarize(DATA.blood_oxygen_saturation||[]),null,'none');
 P.dist=stat(DATA.walking_running_distance||[],null,'up');
 var sl=(DATA.sleep_analysis||[]).filter(function(x){return (x.total||0)>1});
 P.sleepPts=sl;
 P.sleep=stat(sl,'total','up');
 var vo=DATA.vo2_max_est||[];
 P.vo2Pts=vo;
 P.vo2=stat(vo,'qty','up');
 P.vmeta=DATA.vo2_max_est_meta||{};
 P.hrvDelta=P.hrv?P.hrv.dp:null;
}
/* ---- L1 状态条 ---- */
function renderStatus(){
 var el=document.getElementById('status');
 var v=verdictOf(),vd=VD[v];
 el.className='status '+(vd.c==='dim'?'':vd.c);
 var fresh='';
 if(P.step||P.sleep){
  var days=[P.step&&P.step.trend.length?DATA.step_count[DATA.step_count.length-1].date:'',P.sleepPts.length?P.sleepPts[P.sleepPts.length-1].date:''].filter(Boolean);
  if(days.length){
   var newest=days.sort()[days.length-1];
   var dd=new Date(newest+'T00:00:00'),today=new Date();today.setHours(0,0,0,0);
   var gap=Math.round((today-dd)/86400000);
   fresh=' · 最新数据 '+newest.slice(5)+(gap>1?'（'+gap+' 天前，可能未同步）':'');
  }
 }
 function kpi(k,label,unit){
  var s=k==='sleep'?P.sleep:P[k];
  if(!s)return '<div class="kpi"><div class="kk">'+label+'</div><div class="kv">--</div><div class="kd"></div></div>';
  var d=s.dp==null?'':(s.dp>0?'+':'')+s.dp.toFixed(1)+'%';
  var cls=(k==='rhr')?(s.dp<=0?'good':'bad'):(s.dp>=0?'good':'bad');
  return '<div class="kpi"><div class="kk">'+label+'</div><div class="kv">'+num(s.cur,k==='sleep'?1:0)+
   '<span style="font-size:11px;color:var(--dim);font-weight:400"> '+unit+'</span></div>'+
   '<div class="kd">'+(d?'<span class="delta '+(Math.abs(s.dp)>=1?cls:'flat')+'">'+d+'</span> 对比 7 日均':'基准不足')+'</div></div>';
 }
 el.innerHTML='<div class="lead"><div class="vt">'+esc(vd.t)+'</div>'+
  '<div class="vh">'+esc(vd.h)+(P.hrv&&P.hrv.dp!=null?' · HRV '+((P.hrv.dp>=0?'+':'')+P.hrv.dp.toFixed(1))+'% vs 7 日基准':'')+esc(fresh)+'</div></div>'+
  '<div class="kpis">'+kpi('hrv','HRV','ms')+kpi('rhr','静息心率','bpm')+kpi('sleep','睡眠','小时')+'</div>';
}
/* ---- L2 卡片 ---- */
var CARDS=[
 {k:'hrv',label:'HRV',unit:'ms',d:1,color:'#39d2c0'},
 {k:'rhr',label:'静息心率',unit:'bpm',d:0,color:'#3fb950'},
 {k:'vo2',label:'心肺耐力 · 估算',unit:'ml/kg/min',d:1,color:'#39d2c0'},
 {k:'sleep',label:'睡眠',unit:'小时',d:1,color:'#58a6ff'},
 {k:'wt',label:'体重',unit:'kg',d:1,color:'#d29922'},
 {k:'step',label:'步数',unit:'步',d:0,color:'#58a6ff',sep:1},
 {k:'ae',label:'活动热量',unit:'kcal',d:0,color:'#f0883e',sep:1},
 {k:'ex',label:'锻炼',unit:'分钟',d:0,color:'#7ee787'}
];
function renderCards(){
 var html='';
 CARDS.forEach(function(cd){
  var s=cd.k==='sleep'?P.sleep:P[cd.k];
  var v=s?fmt(s.cur,cd.d,cd.sep):'--';
  var d;
  if(cd.k==='vo2'){
   // 心肺耐力把基准位让给同龄段等级 —— 绝对值要有个可比的参照系才有意义
   var vb=bandOf(s?s.cur:null);
   var dpp=(s&&s.dp!=null)?' · '+(s.dp>=0?'+':'')+s.dp.toFixed(1)+'%':'';
   d=s?(esc(vb?vb.label:'')+' · '+esc(bandDesc())+esc(dpp)):'无法估算';
  }else{
   d=deltaHTML(s);
  }
  html+='<div class="card"><div class="k">'+esc(cd.label)+'</div>'+
   '<div class="vrow"><span class="v">'+v+'</span><span class="u">'+esc(cd.unit)+'</span>'+
   (s?spark(s.trend,cd.color):'')+'</div><div class="d">'+d+'</div></div>';
 });
 document.getElementById('cards').innerHTML=html;
}
/* ---- L3 图表 ---- */
function renderChartsCore(){
 // 睡眠：色相阶梯（有序分类不该用几个互不相干的色相）+ 未分期用斜线纹理。
 // 纹理同时解决三件事：对比度（旧 #4d5566 只有 2.31:1，不达 3:1）、
 // 「未知/待定」的通用视觉语汇、以及少一个色相造成的拼盘感。
 var sl=P.sleepPts;
 if(FAIL.sleep_analysis)setAll('c3','fail',FAIL.sleep_analysis);
 else if(!sl.length)setAll('c3','empty');
 else draw('c3',[
  {name:'深睡',type:'bar',data:sl.map(function(p){return p.deep}),color:'#1f6feb',extra:{stack:'s'}},
  {name:'REM',type:'bar',data:sl.map(function(p){return p.rem}),color:'#388bfd',extra:{stack:'s'}},
  {name:'核心',type:'bar',data:sl.map(function(p){return p.core}),color:'#58a6ff',extra:{stack:'s'}},
  {name:'未分期',type:'bar',data:sl.map(unclass),extra:{stack:'s',itemStyle:{color:'#6e7681',decal:{symbol:'rect',symbolSize:1,dashArrayX:[1,0],dashArrayY:[3,3],rotation:Math.PI/4,color:'rgba(230,237,243,.55)'}}}}],
  {axis:ptsAxis(sl)});
 sub('c3','柱高 = 睡眠时长，与上方卡片同口径（清醒不计入）');
 var st=DATA.step_count||[];
 if(FAIL.step_count)setAll('c1','fail',FAIL.step_count);
 else if(!st.length)setAll('c1','empty');
 else draw('c1',[{name:'步数',type:'bar',data:st.map(function(p){return p.qty}),color:'#58a6ff'}],{axis:ptsAxis(st)});
 var ae=DATA.active_energy||[];
 if(!ae.length)setAll('c2',FAIL.active_energy?'fail':'empty',FAIL.active_energy);
 else draw('c2',[{name:'kcal',data:ae.map(function(p){return p.qty}),color:'#f0883e'}],{axis:ptsAxis(ae)});
 var wt=DATA.weight_body_mass||[];
 if(FAIL.weight_body_mass)setAll('c7','fail',FAIL.weight_body_mass);
 else if(!wt.length)setAll('c7','empty');
 else draw('c7',[{name:'kg',data:wt.map(function(p){return p.qty}),color:'#d29922',extra:{symbolSize:6}}],{axis:ptsAxis(wt)});
 drawVo2();
}
function renderChartsExtra(){
 var hr=DATA.heart_rate||[];
 if(FAIL.heart_rate)setAll('c4','fail',FAIL.heart_rate);
 else if(!hr.length)setAll('c4','empty');
 else draw('c4',[
  {name:'min',data:hr.map(function(p){return p.min}),color:'#3fb950'},
  {name:'avg',data:hr.map(function(p){return p.avg}),color:'#e3b341'},
  {name:'max',data:hr.map(function(p){return p.max}),color:'#f85149'}],{axis:ptsAxis(hr)});
 var rhr=DATA.resting_heart_rate||[];
 // 静息心率不再是「危险红」：它下降是好事，红只留给越界/异常
 if(FAIL.resting_heart_rate)setAll('c5','fail',FAIL.resting_heart_rate);
 else if(!rhr.length)setAll('c5','empty');
 else draw('c5',[{name:'bpm',data:rhr.map(function(p){return p.qty!=null?p.qty:p.avg}),color:'#3fb950'}],{axis:ptsAxis(rhr)});
 var hrv=DATA.heart_rate_variability||[];
 if(FAIL.heart_rate_variability)setAll('c6','fail',FAIL.heart_rate_variability);
 else if(!hrv.length)setAll('c6','empty');
 else draw('c6',[{name:'ms',data:hrv.map(function(p){return p.qty!=null?p.qty:p.avg}),color:'#39d2c0'}],{axis:ptsAxis(hrv)});
 var sp=DATA.blood_oxygen_saturation||[];
 // 血氧换掉蓝色：原先步数/血氧/睡眠核心三处同色，跨指标同色会让人误以为相关
 if(FAIL.blood_oxygen_saturation)setAll('c8','fail',FAIL.blood_oxygen_saturation);
 else if(!sp.length)setAll('c8','empty');
 else draw('c8',[{name:'%',data:sp.map(function(p){return p.qty}),color:'#bc8cff'}],{axis:ptsAxis(sp),y:{min:85,max:100}});
 var ds=DATA.walking_running_distance||[];
 if(FAIL.walking_running_distance)setAll('c9','fail',FAIL.walking_running_distance);
 else if(!ds.length)setAll('c9','empty');
 else draw('c9',[{name:'km',type:'bar',data:ds.map(function(p){return p.qty}),color:'#7ee787'}],{axis:ptsAxis(ds)});
}
function drawVo2(){
 var box=document.getElementById('c10');if(!box)return;
 if(FAIL.vo2_max_est){setAll('c10','fail',FAIL.vo2_max_est);sub('c10','');return}
 var vo=P.vo2Pts;
 if(!vo.length){setAll('c10','empty','无法估算：'+((P.vmeta&&P.vmeta.reason)||'数据不足'));sub('c10','');return}
 var vb=bandOf(vo[vo.length-1].qty);
 var vs=vo.map(function(p){return p.qty});
 var lo=Math.min.apply(null,vs),hi=Math.max.apply(null,vs);var ml=[];
 if(vb)(vb.bands||[]).forEach(function(t,i){
  if(t>=lo-1&&t<=hi+1)ml.push({yAxis:t,label:{formatter:BAND_LABELS[i+1]+' '+t,position:'insideEndTop'}})});
 var extra={symbolSize:5};
 if(ml.length)extra.markLine={silent:true,symbol:'none',lineStyle:{color:'#d29922',type:'dashed',width:1},
  label:{fontSize:11,color:'#d29922'},data:ml};
 var hr=(P.vmeta&&P.vmeta.hrmax_ref)||'--';
 draw('c10',[{name:'估算',data:vs,color:'#39d2c0',extra:extra}],{axis:ptsAxis(vo)});
 sub('c10','Uth 公式：15 × HRmax '+hr+' ÷ 静息心率7日均值 · 个体误差 ±10~15%，只看趋势');
}
function renderWk(){
 var box=document.getElementById('wk');if(!box)return;
 if(FAIL.workouts){
  box.innerHTML='<div class="state" style="height:120px"><div>取数失败：'+esc(FAIL.workouts)+'</div>'+
   '<button type="button" onclick="retryAll()">重试</button></div>';
  return;
 }
 var wk=DATA.workouts||[];
 if(!wk.length){box.innerHTML='<div class="state" style="height:120px">范围内暂无锻炼</div>';return}
 var rows=wk.slice().reverse().slice(0,30).map(function(w){
  return '<tr><td data-l="日期">'+esc(w.day||'')+'</td><td data-l="类型">'+esc(w.name||'')+'</td>'+
   '<td data-l="时长">'+Math.round(w.duration_min||0)+' 分钟</td>'+
   '<td data-l="热量">'+fmt(w.kcal,0,1)+' kcal</td>'+
   '<td data-l="心率">'+(w.avg_hr?Math.round(w.avg_hr):'--')+' / '+(w.max_hr?Math.round(w.max_hr):'--')+' bpm</td></tr>';
 }).join('');
 box.innerHTML='<table><thead><tr><th scope="col">日期</th><th scope="col">类型</th><th scope="col">时长</th>'+
  '<th scope="col">热量</th><th scope="col">心率 均/高</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
function setAllLoading(){
 ['c1','c2','c3','c4','c5','c6','c7','c8','c9','c10'].forEach(function(id){setAll(id,'load')});
}
function refresh(){
 if(!BUILT){buildDOM();BUILT=true}
 setAllLoading();
 document.getElementById('wk').innerHTML='<div class="state" style="height:120px">读取中…</div>';
 var core=[['heart_rate_variability'],['resting_heart_rate'],['sleep_analysis'],['weight_body_mass'],['step_count'],['apple_exercise_time'],['active_energy','&convert=kcal'],['vo2_max_est',null,1]];
 var extra=[['heart_rate'],['blood_oxygen_saturation'],['walking_running_distance']];
 var jobs=core.map(function(c){return load(c[0],c[1],c[2])});
 jobs.push(loadWorkouts());
 Promise.all(jobs).then(function(){
  computeAll();renderStatus();renderCards();renderChartsCore();renderWk();
  return Promise.all(extra.map(function(c){return load(c[0],c[1])}));
 }).then(function(){
  renderChartsExtra();
 });
}
function retryAll(){refresh()}
function setRange(n){
 RANGE=n;var r=document.getElementById('range');r.innerHTML='';
 [7,30,90,365].forEach(function(x){
  var b=document.createElement('button');b.type='button';b.textContent=x+' 天';
  b.setAttribute('aria-pressed',x===n?'true':'false');
  if(x===n)b.className='on';
  b.onclick=function(){setRange(x)};r.appendChild(b);
 });
 refresh();
}
setRange(90);
window.addEventListener('resize',function(){Object.keys(CH).forEach(function(k){try{CH[k].resize()}catch(e){}})});
</script></body></html>`
    .replace('__READKEY__', readKey);
}
