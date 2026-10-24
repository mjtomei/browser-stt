import{readFile,writeFile}from'node:fs/promises';
import{benchmarkWords,scoreSpeech,correctionChanges}from'../../src/speech-benchmark.js';
import{vote,correctness,fitCalibration}from'./vote.mjs';
const rows=JSON.parse(await readFile('test-results/ensemble-merged/results.json'));
const cases=JSON.parse(await readFile('benchmarks/window-study-expanded-manifest.json')).cases;
const refs=new Map(cases.map(c=>[c.id,c.samples.map(s=>s.reference).join(' ')]));
const models=['moonshine-tiny','conformer-small','zipformer-20m','moonshine-tiny-streaming','whisper-tiny.en','vosk-small','moonshine-base','whisper-base.en'];
const key=r=>`${r.model}/${r.window}/${r.shift}/${r.hints?'hints':'plain'}`;
const complete=rows.filter(r=>r.seconds>=cases.find(c=>c.id===r.case).seconds-.001);
const baseline=(model,id,hints=true)=>complete.find(r=>r.model===model&&r.case===id&&r.window===15&&r.shift===0&&r.hints===hints);
const calibration=new Map();
for(const c of cases)for(const model of models)for(const hints of [true,false]){const evidence=cases.filter(x=>x.id!==c.id).flatMap(x=>{const r=baseline(model,x.id,hints);return r?correctness(refs.get(x.id),r):[];});calibration.set(`${c.id}/${model}/${hints}`,fitCalibration(evidence));}
const trials=[];
function repetition(reference,text){const counts=words=>{const m=new Map();for(let i=0;i+8<=words.length;i++){const phrase=words.slice(i,i+8).join(' ');m.set(phrase,(m.get(phrase)||0)+1);}return m;};const ref=counts(benchmarkWords(reference)),hyp=counts(benchmarkWords(text));return [...hyp].some(([p,n])=>n>=4&&n-(ref.get(p)||0)>=3);}

function add(name,id,text,kind,metadata={}){const score=scoreSpeech(refs.get(id),text);const base=baseline('moonshine-tiny',id);trials.push({name,case:id,kind,text,score,majorRepetition:repetition(refs.get(id),text),changes:base?correctionChanges(scoreSpeech(refs.get(id),base.text),score):null,...metadata});}
for(const r of complete)add(key(r),r.case,r.text,'individual',{fallbacks:r.fallbacks,window:r.window,shift:r.shift,hints:r.hints});
function combination(list,n,start=0,part=[]){if(part.length===n)return[part];return list.slice(start).flatMap((x,i)=>combination(list,n,start+i+1,[...part,x]));}
const subsets=Array.from({length:models.length-1},(_,i)=>combination(models,i+2)).flat();
// Fixed after the original single-grid study; no new inference or reference-led
// per-passage selection. Preserve the original model order for alignment/ties.
const topThree=['conformer-small','zipformer-20m','moonshine-base'];
const windowSets=[
 ...[15,30,60].flatMap(w=>[
  [`${w}-original`,r=>r.window===w&&r.shift===0],
  [`${w}-shifted`,r=>r.window===w&&r.shift>0],
  [`${w}-both-grids`,r=>r.window===w],
 ]),
 ['15+30',r=>r.window<=30],
 ['15+60',r=>r.window!==30],
 ['30+60',r=>r.window!==15],
 ['all-windows',()=>true],
];
for(const c of cases){
 const byModel=new Map(models.map(m=>[m,baseline(m,c.id)]));
 const cal=(model,p)=>calibration.get(`${c.id}/${model}/true`)(p);
 for(const hints of [true,false])for(const subset of subsets){const hs=subset.map(m=>baseline(m,c.id,hints));if(hs.some(x=>!x))continue;
  const calibrate=(model,p)=>calibration.get(`${c.id}/${model}/${hints}`)(p);
  for(const scheme of['raw','calibrated'])add(`${scheme}${hints?'':'-plain'}:${subset.join('+')}`,c.id,vote(hs,{calibrate:scheme==='raw'?undefined:calibrate}).text,'cross-model',{members:subset,hints});
 }
 for(const model of models){const options=complete.filter(r=>r.model===model&&r.case===c.id&&r.hints);
  for(const [label,selected]of[['15-shifted',options.filter(r=>r.window===15)],['15+30',options.filter(r=>r.window<=30)],['all-windows',options]]){
   if(selected.length<2)continue;
   for(const scheme of['raw','calibrated'])add(`${scheme}:${model}:${label}`,c.id,vote(selected,{calibrate:scheme==='raw'?undefined:cal}).text,'same-model-windows');
  }
 }
 if(models.every(m=>byModel.get(m))){for(const cutoff of [30,60]){const options=complete.filter(r=>r.case===c.id&&r.hints&&r.window<=cutoff);add(`calibrated:all-models+windows<=${cutoff}`,c.id,vote(options,{calibrate:cal}).text,'cross-model-windows');}}
 for(const [label,include]of windowSets){
  const selected=topThree.flatMap(model=>complete.filter(r=>r.model===model&&r.case===c.id&&r.hints&&include(r)).sort((a,b)=>a.window-b.window||a.shift-b.shift));
  if(!topThree.every(model=>selected.some(r=>r.model===model)))throw Error(`Missing top-three input for ${c.id}/${label}`);
  for(const scheme of ['raw','calibrated'])add(`${scheme}:top-three:${label}`,c.id,vote(selected,{calibrate:scheme==='raw'?undefined:cal}).text,'top-three-windows',{members:topThree,hints:true,gridsPerModel:selected.length/topThree.length});
 }
 console.log(`Scored ${c.id}`);
}
const summaries=[];for(const name of new Set(trials.map(t=>t.name))){const ts=trials.filter(t=>t.name===name);const total=k=>ts.reduce((s,t)=>s+(t.score[k]||0),0);summaries.push({name,kind:ts[0].kind,count:ts.length,repetitionCases:ts.filter(t=>t.majorRepetition).length,errors:total('errors'),words:total('referenceWords'),wer:total('errors')/total('referenceWords'),substitutions:total('substitutions'),deletions:total('deletions'),insertions:total('insertions'),fixed:ts.reduce((s,t)=>s+(t.changes?.fixed||0),0),introduced:ts.reduce((s,t)=>s+(t.changes?.introduced||0),0)});}
summaries.sort((a,b)=>a.wer-b.wer);
const out={createdAt:new Date().toISOString(),protocol:'15 paired long passages; leave-one-speaker-out monotone confidence calibration; raw confidence controls; exploratory combination selection, no independent confirmation set.',completeSweep:complete.length===780,completeConfigurations:complete.length,summaries,trials};
await writeFile('test-results/ensemble-analysis.json',JSON.stringify(out)+'\n');
const compact={...out,trials:trials.map(({text,score,...t})=>({...t,score:{errors:score.errors,referenceWords:score.referenceWords,wer:score.wer,substitutions:score.substitutions,deletions:score.deletions,insertions:score.insertions}}))};
await writeFile('benchmarks/ensemble-results.json',JSON.stringify(compact)+'\n');
console.log('Top COMPLETE results:');console.table(summaries.filter(s=>s.count===15).slice(0,12).map(s=>({name:s.name,errors:s.errors,wer:(100*s.wer).toFixed(2),introduced:s.introduced})));
console.log('complete',complete.length,'partial summary counts', [...new Set(summaries.map(s=>s.count))]);
