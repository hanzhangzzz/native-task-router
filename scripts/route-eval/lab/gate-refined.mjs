// 细分失败类型的闸门分析（TE-4b，仅 dev 子集）：硬送错 / 新建标签跨项目误续 / 同项目误续，并加"无内容短句不自动"规则。
import fs from 'node:fs';
import { loadSamples, labelOf, poolFor, cardId } from './data.mjs';
import { LAB_DIR } from './llm.mjs';
const all=loadSamples('dev');
const rd=n=>new Map(fs.readFileSync(`${LAB_DIR}/runs/${n}.jsonl`,'utf8').trim().split('\n').map(JSON.parse).map(r=>[r.id,r]));
const R={son:rd('cli-sonnet-s3'),opus:rd('cli-opus-s3'),ds:rd('e4-ds-rf-u20'),luna:rd('e4-luna-rf-u20'),qwen:rd('e4-qwen-rf-u20'),haiku:rd('e4-haiku-rf-u20')};
const S=all.filter(s=>R.son.has(s.id));
const pools=new Map(); for (const s of S) pools.set(s.id,new Map((await poolFor(s)).map(c=>[cardId(c),c])));
const GENERIC=/^(好的?|好吧|行|可以|可以了|ok|okay|继续|开始|开始搞|搞|搞定为止|继续搞|再试|再试一次|再来|然后呢|接着|go|yes|是的?|对|嗯|没问题|你看看|看看|改一下|修一下|试试|执行|做吧|干吧|我要看到最终结果|为止|搞定)+$/i;
const contentFree=t=>{const x=t.replace(/[\s\p{P}\p{S}]/gu,''); return x.length<=12||GENERIC.test(x);};
const g=(m,id)=>{const r=R[m].get(id); return r&&r.ok&&!r.error?r:null;};
function run(ms,T,cf,newOnly=false){
  let auto=0,hard=0,newX=0,newSame=0,b1=0,ok=0;
  for (const s of S){ const rs=ms.map(m=>g(m,s.id)); if(rs.some(r=>!r)) continue; const c=rs[0].choice;
    if(!(rs.every(r=>r.choice===c)&&Math.min(...rs.map(r=>r.confidence))>=T&&(!cf||!contentFree(s.text)))) continue;
    if(newOnly&&c!=='NEW') continue;
    auto++; const lab=labelOf(s); if(c===lab){ok++;continue;} if(c==='NEW'){b1++;continue;} if(lab!=='NEW'){hard++;continue;}
    const cc=pools.get(s.id).get(c); (cc&&cc.cwd===s.cwd)?newSame++:newX++; }
  console.log(`${ms.join('∧')} T=${T}${cf?' +noShort':''}`.padEnd(40),`auto=${auto}/${S.length} (${(auto/S.length*100).toFixed(0)}%) ok=${ok} HARD=${hard} newCross=${newX} newSame=${newSame} B1=${b1}`);
}
for (const ms of [['son'],['opus'],['son','opus'],['opus','ds'],['son','ds'],['opus','ds','luna'],['son','opus','ds']]) for (const T of [0.8,0.9,0.95]) run(ms,T,true);
// top1/top3 for clarify UX
for (const m of ['son','opus','ds']){ let t1=0,t3=0,n=0; for(const s of S){const r=g(m,s.id); if(!r) continue; n++; const lab=labelOf(s); if(r.choice===lab) t1++; if(r.choice===lab||r.top3.includes(lab)) t3++;} console.log(m,'top1',(t1/n).toFixed(3),'top3(all incl NEW)',(t3/n).toFixed(3)); }
