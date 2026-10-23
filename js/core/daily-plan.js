// 6.0.0：只規劃唯一單字，不以舊 card 活動次數代替學習完成。
export const LOADS = Object.freeze({light:{label:'輕量',newLimit:5,totalLimit:30},standard:{label:'標準',newLimit:10,totalLimit:50},intensive:{label:'加強',newLimit:20,totalLimit:80}});
export function localDateKey(now=new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}
const unique=xs=>{
  const seen=new Set();const out=[];
  for(const id of (xs ?? [])){const key=String(id);if(seen.has(key))continue;seen.add(key);out.push(id);}
  return out;
};
export function buildDailyPlan({ownerId,localDate,seed,load='standard',dueIds=[],mustIds=[],candidates=[],learnedIds=[],reinforcementIds=[],previousPlan=null}) {
  if(!ownerId || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new Error('INVALID_OWNER_DATE');
  if(!Object.hasOwn(LOADS,load))throw new Error('INVALID_LOAD');
  const limits=LOADS[load];
  if(previousPlan && (previousPlan.ownerId!==ownerId || previousPlan.localDate!==localDate))throw new Error('OWNER_DATE_CONFLICT');
  const old=previousPlan;
  const completedIds=unique(old?.completedIds), done=new Set(completedIds.map(String));
  const doneReviews=unique(old?.reviewIds).filter(id=>done.has(String(id)));
  const doneNew=unique(old?.newIds).filter(id=>done.has(String(id)));
  // SRS 已評分但任務 DB 尚未保存時，保留凍結範圍，讓持久化收據可補記完成。
  const due=unique([...(old?.reviewIds ?? []),...dueIds]).filter(id=>!done.has(String(id)));
  // 已完成永遠保留；調低份量不刪紀錄，也不把超出預算的到期字改日期。
  const remainingBudget=Math.max(0,limits.totalLimit-completedIds.length);
  const reviewPending=due.slice(0,remainingBudget);
  const reviewIds=unique([...doneReviews,...reviewPending]);
  const learnedSet=new Set(learnedIds.map(String));
  // 6.0.2：補強（reinforcementIds）＝「學過的弱字（含次日 prior 錯字）」。
  //   規則：學過的弱字不得再算新字；只從「到期複習後剩餘既有預算」安排補強，不增加原每日字數。
  //   補強字以獨立欄位回傳，供 UI 可操作；不寫進 newIds，也不佔新字上限。
  const doneReinforce=unique(old?.reinforcementIds).filter(id=>done.has(String(id)));
  const budgetAfterReview=Math.max(0,remainingBudget-reviewPending.length);
  const blockedForReinforce=new Set([...due,...reviewIds,...doneNew,...doneReinforce].map(String));
  const reinforceMust=unique(reinforcementIds).filter(id=>!done.has(String(id))&&learnedSet.has(String(id))&&!blockedForReinforce.has(String(id)));
  const reinforcePending=reinforceMust.slice(0,budgetAfterReview);
  const reinforcementPendingIds=unique([...doneReinforce,...reinforcePending]);
  // 補強已佔用的預算不得再被新字重複使用（同一交易內總量仍受 totalLimit 限制，不灌高每日字數）。
  const blocked=new Set([...due,...reviewIds,...learnedIds,...doneNew,...reinforcementPendingIds].map(String));
  const newBudget=Math.max(0,Math.min(limits.newLimit-doneNew.length,budgetAfterReview-reinforcePending.length));
  // 診斷實測弱字是「必做」：先保留給 weakPending，其餘新字才由候選補。
  const weakMust=unique(mustIds).filter(id=>!done.has(String(id))&&!learnedSet.has(String(id))&&!due.some(d=>String(d)===String(id)));
  const weakPending=weakMust.slice(0,newBudget);
  const overflowMustIds=weakMust.slice(weakPending.length);
  const orderedCandidates=unique([...(old?.newIds ?? []),...(seed?.weakWordIds ?? []),...candidates]);
  const otherPending=orderedCandidates.filter(id=>!blocked.has(String(id))&&!done.has(String(id))&&!weakPending.some(w=>String(w)===String(id))).slice(0,Math.max(0,newBudget-weakPending.length));
  const newPending=unique([...weakPending,...otherPending]);
  return {ownerId,localDate,revision:old?.revision ?? 0,attemptId:seed?.attemptId,load,
    reviewIds,newIds:unique([...doneNew,...newPending]),reinforcementIds:reinforcementPendingIds,completedIds,
    overflowDueIds:due.slice(reviewPending.length),overflowMustIds};
}
