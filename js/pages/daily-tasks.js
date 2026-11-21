import {el,escapeHtml} from '../core/ui.js';
import {LOADS} from '../core/daily-plan.js';
import {getDailyPlan,setDailyLoad} from '../services/daily-tasks.js';
import {readRecheckSession} from '../services/recheck-session.js';
import {recheckCap} from '../core/recheck-session.js';
import {loadWords} from '../services/vocab.js';
import {getUser,getAuthGeneration} from '../services/auth.js';
import {on} from '../core/eventbus.js';
import {routeGuard} from '../core/router.js';
import {startPractice} from './practice.js';
import {startTaskReview,stopTaskReview} from './review.js';
import { proGateStatus } from '../services/pro-gate.js';
import { proStatus } from '../services/pro-api.js';
import { mountProGateCard } from '../services/pro-gate-dom.js';

let controller=null,unsubscribe=null,epoch=0;
export function onLeave(){epoch++;controller?.abort();controller=null;unsubscribe?.();unsubscribe=null;stopTaskReview();}
export async function renderDailyTasks(main) {
  onLeave();const generation=epoch;controller=new AbortController();
  const stillOn=routeGuard(),authGeneration=getAuthGeneration();
  const alive=()=>generation===epoch && getAuthGeneration()===authGeneration && stillOn();
  // 6.3.0 Pro 閘：每日任務屬 8 項 Pro；無有效 Pro →「正在開發中」。
  const gate = await proGateStatus('daily_tasks', proStatus);
  if(!alive())return;
  if (gate.state !== 'available') {
    mountProGateCard(main, 'daily_tasks', () => renderDailyTasks(main), '每日任務屬 Pro 功能；無 Pro 時不客制化，此頁顯示「正在開發中」。');
    return;
  }
  main.replaceChildren(el('<section class="card"><h2>每日任務</h2><p role="status">正在確認診斷結果與今日計畫…</p></section>'));
  unsubscribe=on('auth:changed',()=>{
    const wasCurrent=stillOn();onLeave();
    if(wasCurrent){
      main.replaceChildren(el('<section class="card"><p>帳戶已變更，請重新開啟每日任務。</p><button type="button" class="btn">重新開啟</button></section>'));
      main.querySelector('button').onclick=()=>renderDailyTasks(main);
    }
  });
  try {
    const data=await getDailyPlan({signal:controller.signal});if(!alive())return;
    paint(data);
  } catch(err) {
    if(!alive())return;
    const needsLogin=/UNAUTHENTICATED/.test(err.message),needsDiagnosis=/NOT_COMPLETED/.test(err.message);
    main.replaceChildren(el(`<section class="card"><h2>每日任務</h2><p role="status">${needsLogin?'登入後完成一次詞彙診斷，即可安排每日任務。':needsDiagnosis?'請先完成詞彙診斷，讓計畫依你的程度安排。':'暫時無法讀取計畫：'+escapeHtml(err.message)}</p><a class="btn primary" href="${needsLogin?'#/auth?tab=login':needsDiagnosis?'#/diagnostic':'#/daily-tasks'}">${needsLogin?'登入':needsDiagnosis?'開始／繼續診斷':'重試'}</a><p class="muted">其他獨立練習仍可使用。</p></section>`));
    if(!needsLogin && !needsDiagnosis){
      const retry=el('<button type="button" class="btn primary">重試</button>');
      retry.onclick=()=>renderDailyTasks(main);main.querySelector('a').replaceWith(retry);
    }
  }
  function paint({attempt,plan}) {
    if(!alive())return;
    const done=new Set((plan.completedIds||[]).map(String)),doneIn=id=>done.has(String(id));
    const review=plan.reviewIds.filter(id=>!doneIn(id)),fresh=plan.newIds.filter(id=>!doneIn(id));
    const reinforce=Array.isArray(plan.reinforcementIds)?plan.reinforcementIds:[];
    const reinforcePending=reinforce.filter(id=>!doneIn(id));
    // 分母含補強（去重）；補強字已排除新字與到期複習，故僅在重複時自動去重、不重複計數。
    const doneCount=new Set([...plan.reviewIds,...plan.newIds,...reinforce].filter(doneIn).map(String)).size;
    const total=new Set([...plan.reviewIds,...plan.newIds,...reinforce].map(String)).size;
    main.replaceChildren(el(`<section class="card diagnostic-result"><p class="muted">${escapeHtml(plan.localDate)} · 個人化學習計畫</p><h2>每日任務</h2><div class="diagnostic-loads" aria-label="每日份量">${Object.entries(LOADS).map(([id,v])=>`<button class="btn ${plan.load===id?'primary':''}" data-load="${id}" aria-pressed="${plan.load===id}">${v.label}<small>新字最多 ${v.newLimit} · 共 ${v.totalLimit} 字</small></button>`).join('')}</div><p role="status" id="daily-message"></p><p>已完成 <strong>${doneCount}</strong>／${total} 字</p><progress max="${Math.max(1,total)}" value="${doneCount}"></progress><div class="diagnostic-task-grid"><article><h3>到期複習</h3><p>${review.length} 字待完成</p><button class="btn primary" id="daily-review" ${review.length?'':'disabled'}>開始複習</button></article><article><h3>學習新字</h3><p>${fresh.length} 字待完成</p><button class="btn primary" id="daily-new" ${fresh.length?'':'disabled'}>開始學習</button></article>${reinforce.length?`<article><h3>補強弱字</h3><p>${reinforcePending.length} 字待完成（已完成 ${reinforce.length-reinforcePending.length}／${reinforce.length}）</p><button class="btn primary" id="daily-reinforce" ${reinforcePending.length?'':'disabled'}>開始補強</button></article>`:''}</div>${plan.reinforcementIds && plan.reinforcementIds.length?`<p class="muted">今日另安排 <strong>${plan.reinforcementIds.length}</strong> 個「補強」字（已學過的弱字，不佔新字上限、不增加每日字數）。</p>`:''}<article class="daily-recheck"><h3>短複測</h3><p class="muted small">從當日任務字取最多 ${recheckCap(plan.load)} 字，中文→英文回想，答不出可轉辨認。不改動複習與每日字數。</p><p class="muted small" id="daily-recheck-status">正在讀取短複測狀態…</p><a class="btn" href="#/recheck" id="daily-recheck-start">開始短複測</a></article><p class="muted">主攻 ${attempt.planSeed.focusLevels.map(l=>'Lv'+l).join('、')}；未測級別只作探索，不視為已確認弱項。低級實測弱字優先。</p>${plan.overflowDueIds.length?`<p>另有 ${plan.overflowDueIds.length} 字到期，保留為待處理；到期日不變。</p>`:''}${plan.overflowMustIds && plan.overflowMustIds.length?`<p>另有 ${plan.overflowMustIds.length} 個診斷弱字保留，明日優先安排。</p>`:''}<p class="muted">完成紀錄先保存在此裝置，連網後會同步至同一帳戶。</p><a href="#/diagnostic">查看診斷結果與弱點</a></section>`));
    const controls=[...main.querySelectorAll('button')];
    const message=main.querySelector('#daily-message');
    const busy=value=>controls.forEach(b=>{if(value)b.disabled=true;});
    main.querySelectorAll('[data-load]').forEach(button=>button.addEventListener('click',async()=>{
      busy(true);message.textContent='正在保存份量與重排未完成項目…';
      try{const changed=await setDailyLoad(button.dataset.load,{signal:controller.signal});if(alive())paint(changed);}
      catch(err){if(alive()){paint({attempt,plan});main.querySelector('#daily-message').textContent='未能完整更新計畫，請重試：'+err.message;}}
    }));
    async function start(ids,kind) {
      busy(true);
      try {
        const words=await loadWords();if(!alive() || getUser()?.id!==plan.ownerId)return;
        const byId=new Map(words.map(w=>[String(w.id),w]));const pool=ids.map(id=>byId.get(String(id)));
        if(pool.some(w=>!w))throw new Error('任務字庫缺字，請重新整理。');
        const context={ownerId:plan.ownerId,localDate:plan.localDate,kind,onStop:()=>renderDailyTasks(main)};
        if(kind==='new'||kind==='reinforcement')startPractice(pool,'daily',null,context);
        else startTaskReview(pool,context,main);
      } catch(err){if(alive()){paint({attempt,plan});main.querySelector('#daily-message').textContent=err.message;}}
    }
    main.querySelector('#daily-new').addEventListener('click',()=>start(fresh,'new'));
    main.querySelector('#daily-review').addEventListener('click',()=>start(review,'review'));
    main.querySelector('#daily-reinforce')?.addEventListener('click',()=>start(reinforcePending,'reinforcement'));
    // 短複測入口與只讀狀態：只讀既有批次（重開頁不新增 session），入口導向 #/recheck 建立／續作。
    const statusEl=main.querySelector('#daily-recheck-status');
    if(statusEl){
      readRecheckSession(plan.ownerId,plan.localDate).then(session=>{
        if(!alive()||!statusEl.isConnected)return;
        if(!session||!session.wordIds?.length){statusEl.textContent='尚未開始短複測。';return;}
        const ids=session.wordIds.map(String);
        const answered=ids.filter(id=>session.progress?.[id]?.answered).length;
        statusEl.textContent=session.submitted
          ? `短複測已提交（${ids.length} 字）。`
          : `短複測進行中：已作答 ${answered}／${ids.length} 字。`;
      }).catch(()=>{if(statusEl.isConnected)statusEl.textContent='短複測狀態暫時無法讀取。';});
    }
  }
}
