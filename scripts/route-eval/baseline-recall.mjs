// 旧生产路由（MVP-1，src/router/route.ts，2026-10-16 随旧内核删除）的候选召回，原样冻结在这里，
// 只供评测基线 jev-baseline 复现当时的口径；新路由不使用。
export function relevantCards(cards,text) {
  const normalized=text.toLowerCase();const tokens=new Set(normalized.match(/[a-z0-9_-]{2,}|[\p{Script=Han}]{2}/gu)??[]);
  // Overlapping Chinese bigrams support ordinary phrases without another model call.
  for(const run of normalized.match(/[\p{Script=Han}]+/gu)??[])for(let i=0;i+1<run.length;i++)tokens.add(run.slice(i,i+2));
  return cards.map((card,index)=>({card,index,score:[...tokens].reduce((sum,token)=>sum+(card.goal.toLowerCase().includes(token)?4:0)+(card.last_input?.toLowerCase().includes(token)?2:0)+(card.last_progress?.toLowerCase().includes(token)?1:0)+(card.workspace_path.toLowerCase().includes(token)?1:0),0)})).sort((a,b)=>b.score-a.score||a.index-b.index).map(x=>x.card);
}
