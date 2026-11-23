import {LOADS} from '../core/daily-plan.js';
import {getDiagnosticResult} from './diagnostic-api.js';
import {setDailyLoad} from './daily-tasks.js';
import {getUser,authReady,getAuthGeneration} from './auth.js';
import {el} from '../core/ui.js';
export async function mountDailyLoadControls(container) {
  container.replaceChildren(el('<h3>個人化每日份量</h3><p role="status">確認帳戶計畫中…</p>'));
  await authReady;const owner=getUser()?.id,generation=getAuthGeneration();
  const alive=()=>container.isConnected && getUser()?.id===owner && getAuthGeneration()===generation;
  if(!owner){container.replaceChildren(el('<h3>個人化每日份量</h3><p>登入並完成詞彙診斷後，可在此調整每日任務。</p><a href="#/auth?tab=login">登入</a>'));return;}
  try{const attempt=await getDiagnosticResult();if(alive())paint(attempt.load || 'standard');}
  catch(err){if(alive()){container.replaceChildren(el('<h3>個人化每日份量</h3><p role="status"></p><a href="#/diagnostic">開始／繼續詞彙診斷</a>'));container.querySelector('p').textContent=/NOT_COMPLETED/.test(err.message)?'完成診斷後開放每日任務。':'暫時無法載入份量：'+err.message;}}
  function paint(load) {
    container.replaceChildren(el(`<h3>個人化每日份量</h3><div class="diagnostic-loads">${Object.entries(LOADS).map(([id,v])=>`<button class="btn ${load===id?'primary':''}" data-load="${id}" aria-pressed="${load===id}">${v.label}<small>新字最多 ${v.newLimit} · 共 ${v.totalLimit} 字</small></button>`).join('')}</div><p role="status"></p><p class="muted small">直接點選即保存。複習優先，調低只縮減未完成項目，已完成紀錄保留。</p>`));
    container.querySelectorAll('button').forEach(b=>b.onclick=async()=>{
      // 舊頁面不能借用新登入的帳戶送出設定；晚回應檢查不足以阻止寫入。
      if(!alive()){
        if(container.isConnected){
          container.replaceChildren(el('<h3>個人化每日份量</h3><p role="status">帳戶已變更，請重新確認目前帳戶的份量。</p><button type="button" class="btn">重新確認帳戶</button>'));
          container.querySelector('button').onclick=()=>mountDailyLoadControls(container);
        }
        return;
      }
      container.querySelectorAll('button').forEach(x=>x.disabled=true);
      container.querySelector('[role=status]').textContent='保存中…';
      try{await setDailyLoad(b.dataset.load);if(alive()){paint(b.dataset.load);container.querySelector('[role=status]').textContent='已保存並更新今日任務。';}}
      catch(err){if(alive()){paint(load);container.querySelector('[role=status]').textContent='未能完整更新，請重試：'+err.message;}}
    });
  }
}
