// 顯示卡片不等於完成。只有看過中文並明確前進／結束，才確認這個任務單字。
// kind：任務類型（'new'｜'review'｜'reinforcement'）。無 kind 沿既有 new 相容（6.0.2 補強入口）。
export async function creditTaskCard(session,{complete,getOwner,getGeneration}) {
  if(!session?.taskContext)return true;
  const entry=session.shown[session.idx];
  if(!entry || entry.taskCredited)return true;
  if(!entry.meaningSeen)return false;
  const ctx=session.taskContext;
  const check=()=>{if(getOwner()!==ctx.ownerId || (getGeneration && ctx.authGeneration!==getGeneration()))throw new Error('ACCOUNT_CHANGED');};
  check();
  const kind=ctx.kind || 'new';
  await complete(ctx.ownerId,ctx.localDate,entry.word.id,kind);
  check();
  entry.taskCredited=true;return true;
}
