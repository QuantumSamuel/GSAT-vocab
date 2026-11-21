// 純函式參考核心；正式答案與進級由伺服器控制，作答頁不載入此模組。
export const ALGORITHM_VERSION='partial-12-v1';
export const INITIAL_COUNTS=Object.freeze([3,4,4,5,5,6,6]);
export const EXTRA_COUNTS=Object.freeze([2,3,4,5,6,6,6]);
const fail=code=>{throw new Error(code);};
const unique=xs=>new Set(xs).size===xs.length;
export function scoreDiagnosticAnswer({correctOptionIds,selectedOptionIds,unknown=false}) {
  if(!Array.isArray(correctOptionIds)||!Array.isArray(selectedOptionIds)||typeof unknown!=='boolean')fail('INVALID_ANSWER');
  const correct=correctOptionIds,selected=selectedOptionIds,ids=[...correct,...selected];
  const allowed=ids.some(x=>typeof x==='string' && /^[A-D]$/.test(x))?['A','B','C','D']:['a','b','c','d'];
  if(correct.length<1||correct.length>3||!unique(correct)||!unique(selected)||ids.some(x=>!allowed.includes(x))||
    (unknown?selected.length!==0:selected.length===0))fail('INVALID_ANSWER');
  if(unknown)return {scoreUnits:0,missedOptionIds:[],wrongOptionIds:[],unknown:true};
  const wrongOptionIds=selected.filter(x=>!correct.includes(x)),missedOptionIds=correct.filter(x=>!selected.includes(x));
  return {scoreUnits:12*(selected.length-wrongOptionIds.length)/(correct.length+wrongOptionIds.length),missedOptionIds,wrongOptionIds,unknown:false};
}
export function createDiagnosticState(candidateIdsByLevel,config={}) {
  const candidates=Array.from({length:7},(_,i)=>[...((Array.isArray(candidateIdsByLevel)?candidateIdsByLevel[i]:candidateIdsByLevel?.[i+1]) ?? [])]);
  if(candidates.some(xs=>xs.length!==30||xs.some(id=>typeof id!=='string'||!id))||!unique(candidates.flat()))fail('BANK_INVALID');
  if(Object.keys(config).length)fail('UNSUPPORTED_CONFIG');
  return {algorithmVersion:ALGORITHM_VERSION,status:'in_progress',revision:0,answeredCount:0,level:1,
    candidates,currentQuestionId:candidates[0][0],batchEnd:INITIAL_COUNTS[0],completionReason:null,focusLevels:[],
    levels:Array.from({length:7},(_,i)=>({level:i+1,n:0,sumScoreUnits:0,meanScore:null,omittedOptionCount:0,wrongOptionCount:0,unknownCount:0})),answers:[]};
}
export function applyDiagnosticAnswer(state,answer) {
  if(state.status!=='in_progress')fail('ALREADY_COMPLETED');
  if(answer.questionId!==state.currentQuestionId||(answer.expectedRevision!=null&&answer.expectedRevision!==state.revision))fail('CONFLICT');
  if(![0,3,4,6,8,9,12].includes(answer.scoreUnits)||!Array.isArray(answer.missedOptionIds)||!Array.isArray(answer.wrongOptionIds)||
    typeof answer.unknown!=='boolean'||!unique(answer.missedOptionIds)||!unique(answer.wrongOptionIds)||
    answer.missedOptionIds.some(x=>answer.wrongOptionIds.includes(x))||
    (answer.unknown&&(answer.scoreUnits!==0||answer.missedOptionIds.length||answer.wrongOptionIds.length)))fail('INVALID_SCORE');
  const next=structuredClone(state),lv=next.level,summary=next.levels[lv-1];
  if(!next.candidates[lv-1]||next.candidates[lv-1].length!==30)fail('BANK_INVALID');
  summary.n++;summary.sumScoreUnits+=answer.scoreUnits;summary.meanScore=summary.sumScoreUnits/(12*summary.n);
  summary.omittedOptionCount+=answer.missedOptionIds.length;summary.wrongOptionCount+=answer.wrongOptionIds.length;summary.unknownCount+=Number(answer.unknown);
  next.revision++;next.answeredCount++;next.answers.push({...answer,level:lv});
  if(summary.n===next.batchEnd){
    // 第30題先看達標，再看耗盡；總作答數從不決定完成。
    if(5*summary.sumScoreUnits>=48*summary.n){
      if(lv===7){next.status='completed';next.completionReason='seven_levels';}
      else{next.level++;next.batchEnd=INITIAL_COUNTS[next.level-1];}
    }else if(summary.n===30){next.status='completed';next.completionReason='bottleneck';}
    else next.batchEnd=Math.min(30,summary.n+EXTRA_COUNTS[lv-1]);
  }
  next.currentQuestionId=next.status==='completed'?null:next.candidates[next.level-1][next.levels[next.level-1].n];
  if(next.status!=='completed'&&!next.currentQuestionId)fail('BANK_INVALID');
  if(next.status==='completed'){
    const weak=next.levels.find(x=>x.n&&5*x.sumScoreUnits<48*x.n);
    next.focusLevels=weak?[weak.level,...(weak.level<7?[weak.level+1]:[])]:[6,7];
  }
  return next;
}
