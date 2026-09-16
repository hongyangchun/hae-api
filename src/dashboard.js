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
.box{background:#161b22;border:1px solid #21262d;border-radius:12px;padding:28px;width:min(320px,88vw);text-align:center}
h1{font-size:18px;margin:0 0 6px}p{color:#8b949e;font-size:12px;margin:0 0 18px}
input{width:100%;box-sizing:border-box;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:10px}
button{width:100%;background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:10px;font-size:14px;cursor:pointer}
.err{color:#f85149;font-size:12px;margin-top:10px}
</style></head><body><div class="box"><h1>🏃 健康 · HAE</h1><p>私有数据，请验证后访问</p>
<form method="post" action="/dashboard"><input type="password" name="pass" placeholder="访问口令" autofocus><button>进入</button></form>
${msg ? `<div class="err">${msg}</div>` : ''}</div></body></html>`;
}

export function dashboardHTML(readKey) {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>健康 · HAE</title>
<script src="https://registry.npmmirror.com/echarts/5.5.1/files/dist/echarts.min.js"></script>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;padding:16px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#8b949e;font-size:12px;margin-bottom:14px}
.range{display:inline-flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.range button{background:#161b22;color:#8b949e;border:1px solid #30363d;border-radius:16px;padding:4px 14px;cursor:pointer;font-size:13px}
.range button.on{color:#fff;border-color:#2f81f7;background:#1f3a5f}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.card{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:12px 14px}
.card .k{color:#8b949e;font-size:12px}
.card .v{font-size:24px;font-weight:600;margin-top:2px}
.card .d{color:#8b949e;font-size:11px;margin-top:2px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(440px,100%),1fr));gap:12px}
.panel{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:10px}
.panel h3{margin:2px 6px 0;font-size:13px;color:#c9d1d9;font-weight:500}
.chart{height:240px}
.wide{grid-column:1/-1}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:#8b949e;text-align:left;font-weight:500;padding:6px 8px;border-bottom:1px solid #21262d}
td{padding:6px 8px;border-bottom:1px solid #21262d}
.err{color:#f85149;font-size:12px;padding:8px}
</style></head><body>
<h1>🏃 健康 · HAE</h1>
<div class="sub">Apple Watch → Cloudflare · 数据每日自动更新</div>
<div class="range" id="range"></div>
<div class="cards" id="cards"></div>
<div class="grid" id="grid"></div>
<script>
var KEY='__READKEY__';var RANGE=90;var CH={};
function dstr(d){return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2)}
function from(){var d=new Date();d.setDate(d.getDate()-RANGE+1);return dstr(d)}
function to(){var d=new Date();d.setDate(d.getDate()+1);return dstr(d)}
function get(u){return fetch(u,{headers:{'api-key':KEY}}).then(function(r){return r.json()})}
function load(n,e){return get('/api/query?name='+n+(e||'')+'&from='+from()+'&to='+to()).then(function(j){return j.points||[]}).catch(function(){return []})}
function fmt(n,d){if(n==null||isNaN(n))return '--';return Number(n).toFixed(d==null?1:d)}
function last(pts,k){for(var i=pts.length-1;i>=0;i--){var v=k?pts[i][k]:pts[i].qty;if(v!=null&&v!==0)return{v:v,d:pts[i].date}}return{v:null,d:''}}
// 单值指标统一取标量：优先 qty，兼容历史数据里被误写成 avg 的槽
function scalarize(pts){return pts.map(function(p){return{date:p.date,qty:(p.qty!=null?p.qty:p.avg)}})}
// 未分类睡眠：Apple 的 asleepUnspecified。老数据没有该槽，用「总时长-已分类」推导
function unclass(p){if(p.unclassified!=null)return p.unclassified;var s=(p.deep||0)+(p.rem||0)+(p.core||0);return p.total!=null?Math.max(0,Math.round((p.total-s)*1000)/1000):null}
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
function chart(id){var el=document.getElementById(id);if(!el)return null;if(!CH[id]&&window.echarts)CH[id]=echarts.init(el);return CH[id]}
function draw(id,title,pts,series,opts){
 var box=document.getElementById(id);if(!box)return;
 if(!pts.length){box.innerHTML='<div class="err">暂无数据</div>';return}
 var c=chart(id);if(!c)return;
 var sub=(opts&&opts.sub)||'';
 var ttl={text:title,left:6,top:4,textStyle:{fontSize:13,color:'#c9d1d9'}};
 if(sub){ttl.subtext=sub;ttl.subtextStyle={fontSize:10,color:'#8b949e'};ttl.itemGap=3}
 var o={backgroundColor:'transparent',title:ttl,
  tooltip:{trigger:'axis'},legend:{show:series.length>1,bottom:0,textStyle:{color:'#8b949e',fontSize:11}},
  grid:{left:44,right:14,top:sub?50:34,bottom:series.length>1?38:24},
  xAxis:{type:'category',data:pts.map(function(p){return p.date.slice(5)}),axisLabel:{color:'#8b949e',fontSize:10}},
  yAxis:Object.assign({type:'value',axisLabel:{color:'#8b949e',fontSize:10},splitLine:{lineStyle:{color:'#21262d'}}},(opts&&opts.y)||{}),
  series:series.map(function(s){return Object.assign({type:s.type||'line',name:s.name,data:s.data,smooth:true,barMaxWidth:18,symbolSize:4,lineStyle:{width:2},itemStyle:{color:s.color}},s.extra||{})})};
 c.setOption(o,true);}
function addPanel(id,title,wide){var g=document.getElementById('grid');var d=document.createElement('div');d.className='panel'+(wide?' wide':'');d.innerHTML='<h3>'+title+'</h3><div class="chart" id="'+id+'"></div>';g.appendChild(d)}
function addCard(k,v,unit,d){var c=document.getElementById('cards');var e=document.createElement('div');e.className='card';e.innerHTML='<div class="k">'+k+'</div><div class="v">'+v+'<span style="font-size:12px;color:#8b949e;white-space:nowrap"> '+(unit||'')+'</span></div><div class="d">'+(d||'')+'</div>';c.appendChild(e)}
function render(){
 Object.keys(CH).forEach(function(k){try{CH[k].dispose()}catch(e){}});CH={};
 document.getElementById('cards').innerHTML='';document.getElementById('grid').innerHTML='';
 addPanel('c1','步数');addPanel('c2','活动热量 (kcal)');addPanel('c3','睡眠结构 (小时)');addPanel('c4','心率 min/avg/max');
 addPanel('c5','静息心率 (bpm)');addPanel('c6','HRV (ms)');addPanel('c7','体重 (kg)');addPanel('c8','血氧 (%)');
 addPanel('c9','步行+跑步距离 (km)');addPanel('c10','心肺耐力 VO2max · 估算 (mL/kg/min)');
 var P={};
 var jobs=[
  load('step_count').then(function(p){P.step=p;return load('active_energy','&convert=kcal')}).then(function(p){P.ae=p}),
  load('sleep_analysis').then(function(p){P.sleep=p.filter(function(x){return x.total>1})}),
  load('heart_rate').then(function(p){P.hr=p;return load('resting_heart_rate')}).then(function(p){P.rhr=scalarize(p)}),
  load('heart_rate_variability').then(function(p){P.hrv=scalarize(p);return load('weight_body_mass')}).then(function(p){P.wt=p}),
  load('blood_oxygen_saturation').then(function(p){P.spo2=p;return load('walking_running_distance')}).then(function(p){P.dist=p}),
  load('apple_exercise_time').then(function(p){P.ex=p}),
  // 心肺耐力是服务端派生指标，需要读回 hrmax_ref 等元信息来解释这个数，故取整个响应体
  get('/api/query?name=vo2_max_est&from='+from()+'&to='+to()).then(function(j){P.vo2=j.points||[];P.vmeta=j}).catch(function(){P.vo2=[];P.vmeta={}}),
  get('/api/workouts?from='+from()+'&to='+to()).then(function(j){P.wk=j.workouts||[]}).catch(function(){P.wk=[]})
 ];
 Promise.all(jobs).then(function(){
  // 睡眠点没有 qty 槽（值是 total/deep/rem/core 分槽的），所以不能走 last() 的默认 qty 分支，
  // 必须显式取 total。曾经把 last(P.sleep,'total') 整个对象丢给 fmt()，Number(对象) 是 NaN，
  // 于是睡眠卡片永远显示「--」——数据其实在，是显示逻辑错了。
  var sl=last(P.sleep).v!=null?last(P.sleep):last(P.sleep,'total');
  var cs=[['步数',fmt(last(P.step).v,0),'步',last(P.step).d],
   ['活动热量',fmt(last(P.ae).v,0),'kcal',last(P.ae).d],
   ['睡眠',fmt(sl.v,1),'小时',sl.d],
   ['静息心率',fmt(last(P.rhr).v,0),'bpm',last(P.rhr).d],
   ['锻炼环',fmt(last(P.ex).v,0),'分钟',last(P.ex).d],
   ['体重',fmt(last(P.wt).v,1),'kg',last(P.wt).d]];
  cs.forEach(function(c){addCard(c[0],c[1],c[2],c[3])});
  // VO2max 卡片：值班 + 同龄段等级（等级只是参考带，看趋势比看等级有意义）
  var vp=P.vo2.length?P.vo2[P.vo2.length-1]:null;var vb=bandOf(vp?vp.qty:null);
  addCard('VO2max · 估算',fmt(vp?vp.qty:null,1),'ml/kg/min',
   vp?((vb?vb.label+' · ':'')+bandDesc()+' · '+vp.date.slice(5)):'无法估算');
  draw('c1','步数',P.step,[{name:'步数',type:'bar',data:P.step.map(function(p){return p.qty}),color:'#58a6ff'}]);
  draw('c2','活动热量 (kcal)',P.ae,[{name:'kcal',data:P.ae.map(function(p){return p.qty}),color:'#f0883e'}]);
  draw('c3','睡眠结构 (小时)',P.sleep,[
   {name:'深睡',type:'bar',data:P.sleep.map(function(p){return p.deep}),color:'#8957e5',extra:{stack:'s'}},
   {name:'REM',type:'bar',data:P.sleep.map(function(p){return p.rem}),color:'#bc8cff',extra:{stack:'s'}},
   {name:'核心',type:'bar',data:P.sleep.map(function(p){return p.core}),color:'#58a6ff',extra:{stack:'s'}},
   {name:'未分类',type:'bar',data:P.sleep.map(unclass),color:'#4d5566',extra:{stack:'s'}},
   {name:'清醒',type:'bar',data:P.sleep.map(function(p){return p.awake}),color:'#6e7681',extra:{stack:'s'}}]);
  draw('c4','心率 min/avg/max',P.hr,[
   {name:'min',data:P.hr.map(function(p){return p.min}),color:'#3fb950'},
   {name:'avg',data:P.hr.map(function(p){return p.avg}),color:'#e3b341'},
   {name:'max',data:P.hr.map(function(p){return p.max}),color:'#f85149'}]);
  draw('c5','静息心率 (bpm)',P.rhr,[{name:'bpm',data:P.rhr.map(function(p){return p.qty}),color:'#f85149'}]);
  draw('c6','HRV (ms)',P.hrv,[{name:'ms',data:P.hrv.map(function(p){return p.qty}),color:'#39d2c0'}]);
  draw('c7','体重 (kg)',P.wt,[{name:'kg',data:P.wt.map(function(p){return p.qty}),color:'#d29922',extra:{symbolSize:6}}]);
  draw('c8','血氧 (%)',P.spo2,[{name:'%',data:P.spo2.map(function(p){return p.qty}),color:'#58a6ff'}],{y:{min:85,max:100}});
  draw('c9','步行+跑步距离 (km)',P.dist,[{name:'km',type:'bar',data:P.dist.map(function(p){return p.qty}),color:'#7ee787'}]);
  drawVo2(P);
  renderWk(P.wk);
 });
}
// 心肺耐力估算图：一条趋势线 + 落在数据区间内的「参考等级分界」虚线
function drawVo2(P){
 var box=document.getElementById('c10');if(!box)return;
 if(!P.vo2.length){box.innerHTML='<div class="err">无法估算：'+esc1((P.vmeta&&P.vmeta.reason)||'数据不足')+'</div>';return}
 var vb=bandOf(P.vo2[P.vo2.length-1].qty);
 var vs=P.vo2.map(function(p){return p.qty});
 var lo=Math.min.apply(null,vs),hi=Math.max.apply(null,vs);var ml=[];
 if(vb)(vb.bands||[]).forEach(function(t,i){
  if(t>=lo-1&&t<=hi+1)ml.push({yAxis:t,label:{formatter:BAND_LABELS[i+1]+' '+t,position:'insideEndTop'}})});
 var extra={symbolSize:5};
 if(ml.length)extra.markLine={silent:true,symbol:'none',lineStyle:{color:'#d29922',type:'dashed',width:1},
  label:{fontSize:10,color:'#d29922'},data:ml};
 var hr=(P.vmeta&&P.vmeta.hrmax_ref)||'--';
 draw('c10','心肺耐力 VO2max · 估算 (mL/kg/min)',P.vo2,
  [{name:'估算',data:vs,color:'#39d2c0',extra:extra}],
  {sub:'Uth 公式：15 × HRmax '+hr+' ÷ 静息心率7日均值 · 个体误差约 ±10~15%，只看趋势'});
}
function esc1(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function renderWk(wk){
 var g=document.getElementById('grid');var d=document.createElement('div');d.className='panel wide';
 if(!wk.length){d.innerHTML='<h3>锻炼记录</h3><div class="err">范围内暂无锻炼</div>';g.appendChild(d);return}
 var rows=wk.slice().reverse().slice(0,30).map(function(w){
  return '<tr><td>'+(w.day||'')+'</td><td>'+(w.name||'')+'</td><td>'+Math.round(w.duration_min||0)+' min</td><td>'+Math.round(w.kcal||0)+' kcal</td><td>'+(w.avg_hr?Math.round(w.avg_hr):'--')+' / '+(w.max_hr?Math.round(w.max_hr):'--')+' bpm</td></tr>'}).join('');
 d.innerHTML='<h3>锻炼记录（最近 '+Math.min(30,wk.length)+' 条）</h3><table><tr><th>日期</th><th>类型</th><th>时长</th><th>热量</th><th>心率 均/高</th></tr>'+rows+'</table>';
 g.appendChild(d);
}
function setRange(n){RANGE=n;var r=document.getElementById('range');r.innerHTML='';
 [7,30,90,365].forEach(function(x){var b=document.createElement('button');b.textContent=x+' 天';if(x===n)b.className='on';b.onclick=function(){setRange(x)};r.appendChild(b)});
 render()}
setRange(90);
window.addEventListener('resize',function(){Object.values(CH).forEach(function(c){c.resize()})});
</script></body></html>`
    .replace('__READKEY__', readKey);
}
