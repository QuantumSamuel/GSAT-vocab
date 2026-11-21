import {buildDailyPlan,localDateKey,LOADS} from '../core/daily-plan.js';
import {priorWeakWordIds} from '../core/recheck-session.js';
import {getUser,authReady,getAuthGeneration} from './auth.js';
import {getDiagnosticResult,setDiagnosticLoad} from './diagnostic-api.js';
import {getAttempt,getDayPlan,updateDayPlan,listDayPlans,saveAttempt} from './diagnostic-store.js';
import {listOwnerRecheckEvents} from './diagnostic-store.js';
import {getSrsQueues} from './store.js';
import {loadWords} from './vocab.js';
import {emit} from '../core/eventbus.js';

function assertOwner(ownerId,generation=getAuthGeneration()) {if(getUser()?.id!==ownerId || getAuthGeneration()!==generation)throw new Error('ACCOUNT_CHANGED');}
function stableOrder(words,ownerId,date) {
  const hash=text=>{let h=2166136261;for(const c of text)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0;};
  return [...words].sort((a,b)=>hash(`${ownerId}:${date}:${a.id}`)-hash(`${ownerId}:${date}:${b.id}`));
}
function completedAttempt(attempt,ownerId){
  return !!attempt && attempt.ownerId===ownerId && attempt.status==='completed' && !!attempt.planSeed;
}
function assertNotAborted(signal){if(signal?.aborted)throw new DOMException('已取消每日任務請求','AbortError');}
// 6.0.3 離線先存／連網補傳的「可回退快取」判定。
// 只有兩種真網路情境可回退快取：
//   ① 真 fetch 斷網：TypeError，且不帶 HTTP status（瀏覽器 Failed to fetch／Node fetch failed）。
//   ② 上游暫時性 HTTP 500–599（diagnostic-api 以 Error＋status 丟出）。
// 先排除所有「非網路」失敗，即使帶 5xx status 也不得回退：
//   外部 abort／signal 已中止、帳戶或世代變更（AUTH_CHANGED／ACCOUNT_CHANGED）、
//   401／403、UNAUTHENTICATED／OWNER_MISMATCH／NOT_COMPLETED／INVALID_RESPONSE／NOT_CONFIGURED。
const NON_TRANSIENT_CODES=new Set(['UNAUTHENTICATED','AUTH_CHANGED','ACCOUNT_CHANGED','OWNER_MISMATCH','NOT_COMPLETED','INVALID_RESPONSE','NOT_CONFIGURED']);
function statusOf(err){const s=err?.status ?? err?.response?.status;return typeof s==='number'?s:null;}
function isAbortFailure(err){return err?.name==='AbortError' || err?.code==='ABORT_ERR' || err?.code==='ABORTED';}
function isExcludedDiagnosticFailure(err,{signal}={}) {
  if(isAbortFailure(err))return true;
  if(signal?.aborted)return true;
  if(typeof err?.code==='string' && NON_TRANSIENT_CODES.has(err.code))return true;
  // 本模組與診斷儲存以「純 Error(訊息)」表示的非網路失敗（assertOwner 的 ACCOUNT_CHANGED、
  // updateDayPlan 的 DAY_CHANGED 等）也一律排除，不因缺少 code 而被誤判為網路錯誤。
  if(NON_TRANSIENT_CODES.has(String(err?.message ?? '')))return true;
  const status=statusOf(err);
  if(status===401 || status===403)return true;
  return false;
}
function transientDiagnosticFailure(err,{signal}={}){
  if(isExcludedDiagnosticFailure(err,{signal}))return false;
  const status=statusOf(err);
  if(status!=null)return status>=500 && status<=599; // HTTP 5xx：上游暫時性
  return err instanceof TypeError;                    // 無 status 的真網路 TypeError
}
async function loadCompletedAttempt(ownerId,generation,{signal}={}) {
  let attempt;
  try {
    // 只有 RPC 呼叫落在這個 try；本機 saveAttempt 在 try 之外，
    // 因此本機儲存失敗不會被當成網路問題而錯誤地回退快取。
    attempt=await getDiagnosticResult({signal});
  } catch(err) {
    if(!transientDiagnosticFailure(err,{signal})){
      assertOwner(ownerId,generation);
      throw err;
    }
    // 回退只讀本帳戶自己的快取；所有 await 前後都重驗 owner／generation，
    // 杜絕 A→B→A 晚到時誤用舊帳戶資料。
    assertOwner(ownerId,generation);
    const cached=await getAttempt(ownerId);
    assertOwner(ownerId,generation);assertNotAborted(signal);
    if(!completedAttempt(cached,ownerId))throw new Error('NOT_COMPLETED');
    return cached;
  }
  assertOwner(ownerId,generation);assertNotAborted(signal);
  if(!completedAttempt(attempt,ownerId))throw new Error('NOT_COMPLETED');
  await saveAttempt(ownerId,attempt);
  assertOwner(ownerId,generation);assertNotAborted(signal);
  return attempt;
}
export async function getDailyPlan({signal}={}) {
  await authReady;
  const ownerId=getUser()?.id,generation=getAuthGeneration();if(!ownerId)throw new Error('UNAUTHENTICATED');
  const attempt=await loadCompletedAttempt(ownerId,generation,{signal});
  // 首次進入任務／短複測要先採用同帳戶雲端清單，避免新裝置先建空白批次。
  // 與背景初始化共用 flight；網路失敗仍保留本機待送，換帳戶／取消則拒絕晚到結果。
  const {syncLearningNow}=await import('./learning-sync.js');
  assertOwner(ownerId,generation);assertNotAborted(signal);
  await syncLearningNow({signal});
  assertOwner(ownerId,generation);assertNotAborted(signal);
  return {attempt,plan:await refreshPlan(ownerId,attempt,generation,{signal})};
}
async function refreshPlan(ownerId,attempt,generation,{signal}={}) {
  assertNotAborted(signal);
  const localDate=localDateKey();
  const [words,queues,history,recheckEvents]=await Promise.all([loadWords(),getSrsQueues(),listDayPlans(ownerId),listOwnerRecheckEvents(ownerId)]);
  assertOwner(ownerId,generation);assertNotAborted(signal);
  const learnedSet=new Set(history.flatMap(p=>p.newIds.filter(id=>p.completedIds.some(c=>String(c)===String(id))).map(String)));
  // 6.0.2 次日校準：prior 錯字＝依既有證據、時間低於今日、最新仍錯者（樣本少但真錯也算）。
  //   只取有效證據（缺 owner／word／session／時間者由 priorWeakWordIds 忽略），未知/缺 owner 舊 quiz 不得導入。
  const startOfToday=new Date();startOfToday.setHours(0,0,0,0);
  const priorIds=priorWeakWordIds(recheckEvents,{ownerId,todayStartMs:startOfToday.getTime()});
  // 次日錯誤字若已正式學過，走補強；尚未正式完成的新字保留為 mustIds，排一般候選之前。
  const learnedPriorIds=priorIds.filter(id=>learnedSet.has(String(id)));
  const unlearnedPriorIds=priorIds.filter(id=>!learnedSet.has(String(id)));
  const levels=new Set(attempt.planSeed.focusLevels);
  const candidates=stableOrder(words.filter(w=>levels.has(w.level)),ownerId,localDate).map(w=>w.id);
  // 交易內使用最新 previousPlan，兩個分頁調份量不會覆蓋完成紀錄。
  return updateDayPlan(ownerId,localDate,previousPlan=>{
    assertOwner(ownerId,generation);assertNotAborted(signal);if(localDate!==localDateKey())throw new Error('DAY_CHANGED');
    const next=buildDailyPlan({ownerId,localDate,seed:attempt.planSeed,
      load:attempt.load || 'standard',dueIds:queues.due.map(m=>m.wordId),mustIds:[...unlearnedPriorIds,...(attempt.planSeed.weakWordIds || [])],candidates,learnedIds:[...learnedSet],
      reinforcementIds:learnedPriorIds,previousPlan});
    // 6.0.2：短複測批次（dayPlans.recheck）不因重排計畫而遺失——原樣保留。
    if(previousPlan?.recheck!==undefined)next.recheck=previousPlan.recheck;
    return next;
  });
}
export async function setDailyLoad(load,{signal}={}) {
  if(!Object.hasOwn(LOADS,load))throw new Error('INVALID_LOAD');
  await authReady;const ownerId=getUser()?.id,generation=getAuthGeneration();if(!ownerId)throw new Error('UNAUTHENTICATED');
  const changed=await setDiagnosticLoad(load,{signal});assertOwner(ownerId,generation);
  const attempt=changed?.status?changed:await getDiagnosticResult({signal});assertOwner(ownerId,generation);
  // 6.0.3：把雲端 authoritative attempt（含新 load）寫回本機快取；否則離線 getDailyPlan
  //   會用舊 cached attempt.load 反向重排成舊份量。本機儲存失敗屬真失敗，直接往外拋、不吞。
  await saveAttempt(ownerId,{...attempt,load});assertOwner(ownerId,generation);
  const plan=await refreshPlan(ownerId,{...attempt,load},generation,{signal});assertOwner(ownerId,generation);
  emit('daily:changed',{ownerId,plan});return {attempt:{...attempt,load},plan};
}
export async function completeTaskWord(ownerId,localDate,wordId,kind) {
  const generation=getAuthGeneration();
  assertOwner(ownerId,generation);
  if(localDate!==localDateKey())throw new Error('DAY_CHANGED');
  const plan=await updateDayPlan(ownerId,localDate,current=>{
    assertOwner(ownerId,generation);
    if(localDate!==localDateKey())throw new Error('DAY_CHANGED');
    if(!current)throw new Error('TASK_NOT_FOUND');
    // 補強（reinforcement）沿用同一完成紀錄 completedIds；不寫 SRS、不改 dueAt/marks。
    const ids=kind==='review'?current.reviewIds:kind==='reinforcement'?(current.reinforcementIds||[]):kind==='new'?current.newIds:[];
    if(!ids.some(id=>String(id)===String(wordId)))throw new Error('WORD_NOT_PLANNED');
    return {...current,completedIds:[...new Set([...current.completedIds,wordId])]};
  });
  assertOwner(ownerId,generation);emit('daily:changed',{ownerId,plan});return plan;
}
export {getDayPlan};
