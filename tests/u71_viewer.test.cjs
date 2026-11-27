const fs = require('fs'), vm = require('vm'), assert = require('assert');
const js = fs.readFileSync('assets/js/predictions.js','utf8');
function cut(start,end){return js.slice(js.indexOf(start),js.indexOf(end,js.indexOf(start)));}
const source = [
 'const num = v => (v === "" || v == null || isNaN(+v)) ? null : +v;',
 'const esc = s => String(s ?? "");',
 'const location = {pathname:"/viewer/"};',
 'const CALC_KINDS={"単勝":[1,true],"複勝":[1,true],"馬連":[2,false],"3連単":[3,true]};',
 cut('function calibrationInfo(rows) {','// 騎手名: 予想 CSV'),
 cut('function activeRows(rows) {','function hits(kind, t,'),
 cut('function raceFactors(rows) {','// 勝率 p から、1〜5着の確率'),
 cut('function finishDist(p, n = 4000', 'const honmei ='),
 cut('function comboProbs(raceRows) {', 'function renderCombos(rid) {'),
 'globalThis.tests={calibrationInfo,horseRating,jockeyRating,jockeyRatingTitle,ratingCell,harville,favRows,finishDist,comboProbs,raceFactors,probabilityReady,canFavorite,placeCount,ticketExclusion,ticketEligible};'
].join('\n');
const ctx = vm.createContext({}); vm.runInContext(source,ctx); const t=ctx.tests;
const rows = [.4,.3,.2,.1].map((p,i)=>({umaban:String(i+1),'平均_勝率':p,'着順の補正_2着':.8,'着順の補正_3着':.6}));
const tri=t.harville(rows); assert.strictEqual(tri.length,24); assert.ok(Math.abs(tri.reduce((a,x)=>a+x[3],0)-1)<1e-10);
const expected=.4 * (.3**.8)/(.3**.8+.2**.8+.1**.8) * (.2**.6)/(.2**.6+.1**.6);
assert.ok(Math.abs(tri.find(x=>x[0]==='1'&&x[1]==='2'&&x[2]==='3')[3]-expected)<1e-10);
const old=rows.map(({umaban,...r})=>({umaban,'平均_勝率':r['平均_勝率']}));
assert.ok(Math.abs(t.harville(old).find(x=>x[0]==='1'&&x[1]==='2'&&x[2]==='3')[3]-(.4*.3/.6*.2/.3))<1e-10);
const fav=[{'m_勝率':.8,'m_順位':1,'平均の温度':2},{'m_勝率':.2,'m_順位':2,'平均の温度':2}];
assert.ok(Math.abs(t.favRows(fav,['m'])[0]['平均_勝率']-16/17)<1e-10);
assert.ok(t.ratingCell({'馬レーティング':3},'馬レーティング').includes('125.0'));
assert.ok(t.ratingCell({'騎手レーティング':.02456,'騎手レーティング対象数':100},'騎手レーティング').includes('52.5'));
assert.ok(t.jockeyRatingTitle({'騎手レーティング':.02456,'騎手レーティング対象数':100}).includes('52.456'));
assert.ok(t.calibrationInfo([{'平均の温度':1.2,'着順の補正_2着':.8,'着順の補正_3着':.6}]).includes('平均 1.200'));
assert.strictEqual(t.calibrationInfo([{}]),'');
const a=t.finishDist([.6,.3,.1],10000,[1,1]);
const b=t.finishDist([.6,.3,.1],10000,[.3,.3]);
assert.ok(Math.abs(a.pos[1][1]-b.pos[1][1])>.03, '着順の補正が反映されていません');
const exactSecond = tri.filter(x=>x[1]==='1').reduce((sum,x)=>sum+x[3],0);
const sampledSecond = t.finishDist([.4,.3,.2,.1],40000,[.8,.6]).pos[1][0];
assert.ok(Math.abs(exactSecond-sampledSecond)<.01, '抽選と組み合わせで補正が不一致');
const two=t.comboProbs(rows.slice(0,2));
assert.strictEqual(two['3連単'].size,0); assert.strictEqual(two['3連複'].size,0);
assert.strictEqual(two['馬単'].size,2);
assert.strictEqual(t.harville(rows.map(r=>({...r,'平均_勝率':null}))).length,0);
assert.strictEqual(t.probabilityReady(rows.map(r=>({...r,'平均_勝率':null}))),false);
assert.strictEqual(t.probabilityReady(rows.map((r,i)=>({...r,'着順の補正_2着':i===0?null:.8}))),false);
assert.strictEqual(t.probabilityReady(rows.map((r,i)=>({...r,'着順の補正_2着':i===0?.7:.8}))),false);
assert.strictEqual(t.placeCount(Array.from({length:8},()=>({'複勝着払キー':2}))),2);
assert.strictEqual(t.placeCount(Array.from({length:8},()=>({}))),3);
const cancelled = [{umaban:'1','m_勝率':.55,'m_順位':1,'オッズで取消':1},{umaban:'2','m_勝率':.3,'m_順位':2},{umaban:'3','m_勝率':.15,'m_順位':3}];
const favCancelled=t.favRows(cancelled,['m']);
assert.strictEqual(favCancelled[0]['平均_勝率'],null);
assert.ok(Math.abs(favCancelled[1]['平均_勝率']-2/3)<1e-10);
assert.ok(Math.abs(favCancelled[2]['平均_勝率']-1/3)<1e-10);
assert.strictEqual(t.canFavorite([{umaban:'1','m_勝率':null}],['m']),false);
const noPlace=rows.map((r,i)=>({...r,'複勝着払キー':0,'オッズで取消':i===0?1:0}));
assert.strictEqual(t.ticketExclusion(noPlace,{kind:'単勝',t:['1']}),'取消扱い');
assert.strictEqual(t.ticketExclusion(noPlace,{kind:'複勝',t:['2']}),'複勝発売無し');
assert.strictEqual(t.ticketEligible(noPlace,{kind:'馬連',t:['2','3']}),true);
assert.strictEqual(t.ticketEligible(noPlace,{kind:'馬連',t:['1','3']}),false);
assert.strictEqual(t.ticketEligible(noPlace,{kind:'単勝',t:['99']}),false);
const missingProb=noPlace.map((r,i)=>({...r,'平均_勝率':i===3?null:r['平均_勝率']}));
assert.strictEqual(t.probabilityReady(missingProb),false);
assert.strictEqual(t.ticketEligible(missingProb,{kind:'単勝',t:['2']}),true, '実績集計は予想値の欠損に依存しない');
assert.strictEqual(t.probabilityReady(rows.map(r=>({...r,'着順の補正_2着':'bad'}))),false);
assert.ok(t.calibrationInfo(rows.map(r=>({...r,'着順の補正_2着':'bad'}))).includes('不一致'));
assert.strictEqual(t.probabilityReady(rows.map(r=>({...r,'平均_勝率':2}))),false);
const basketSource = source + `
const state={races:new Map(),basketSort:{},oddsKind:new Map()};
const sample=[{kind:'単勝',t:['1'],amount:300},{kind:'複勝',t:['2'],amount:400},{kind:'単勝',t:['2'],amount:200}];
const basketOf=()=>sample, boughtOf=()=>[], nkBetSentTag=()=>'', nkBetItemsOf=()=>({}), nkBetCell=()=>'', hitPayout=()=>1000;
const ticketKey=(k,t)=>k+'|'+t.join('-');
const tSortCmp=()=>null,tSortHead=()=>'',kpi=(v,l)=>v+' '+l, pct=v=>String(v),fix=v=>String(v),evCell=()=>'',manualOdds=()=>false,getOdds=()=>null;
${cut('function hits(kind, t,','function allocWeights(')}
${cut('function renderBasket(rid, tri, places, odds, raceRows) {','function comboFor(rid) {')}
globalThis.renderTest=(rows)=>renderBasket('202611280501',harville(rows),placeCount(rows),new Map(),rows);`;
const basketCtx=vm.createContext({}); vm.runInContext(basketSource,basketCtx);
const basketHtml=basketCtx.renderTest(noPlace);
assert.ok(basketHtml.includes('取消扱い') && basketHtml.includes('複勝発売無し'));
assert.ok(basketHtml.includes('1点・200円'));
assert.ok(!basketHtml.includes('3点・900円'));
console.log('候補係数・旧形式・表示の合成検査: 成功');
