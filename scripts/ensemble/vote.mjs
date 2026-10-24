// Research ROVER-style word alignment and confidence-weighted voting.
// References are accepted ONLY by calibration/scoring functions, never vote().
import {benchmarkWords}from'../../src/speech-benchmark.js';
export const normalized=r=>r.words.flatMap(w=>benchmarkWords(w.text).map(text=>({text,confidence:w.confidence})));
export function align(a,b,equal=(x,y)=>x===y){
 const n=a.length,m=b.length,width=m+1,dp=new Uint16Array((n+1)*width),moves=new Uint8Array(dp.length);
 for(let i=1;i<=n;i++){dp[i*width]=i;moves[i*width]=2;}for(let j=1;j<=m;j++){dp[j]=j;moves[j]=3;}
 for(let i=1;i<=n;i++)for(let j=1;j<=m;j++){const p=i*width+j,d=dp[p-width-1]+Number(!equal(a[i-1],b[j-1])),del=dp[p-width]+1,ins=dp[p-1]+1;dp[p]=Math.min(d,del,ins);moves[p]=dp[p]===d?1:dp[p]===del?2:3;}
 let i=n,j=m,out=[];while(i||j){const k=moves[i*width+j];if(k===1)out.push([--i,--j]);else if(k===2)out.push([--i,-1]);else out.push([-1,--j]);}return out.reverse();
}
export function correctness(reference,result){const hyp=normalized(result),ref=benchmarkWords(reference);return align(ref,hyp.map(w=>w.text)).filter(([,j])=>j>=0).map(([i,j])=>({confidence:hyp[j].confidence,correct:i>=0&&ref[i]===hyp[j].text}));}
export function fitCalibration(samples){
 // Fixed deciles, weak Beta(1,1) prior, monotone pooled-adjacent-violators.
 const bins=Array.from({length:10},(_,i)=>({min:i/10,max:(i+1)/10,total:2,success:1}));
 for(const s of samples){if(!Number.isFinite(s.confidence))continue;const b=bins[Math.min(9,Math.floor(s.confidence*10))];b.total++;b.success+=Number(s.correct);}
 const groups=[];for(const b of bins){groups.push({...b});while(groups.length>1){const a=groups.at(-2),z=groups.at(-1);if(a.success/a.total<=z.success/z.total)break;groups.splice(-2,2,{min:a.min,max:z.max,total:a.total+z.total,success:a.success+z.success});}}
 return p=>{const b=groups.find(b=>p<b.max)||groups.at(-1);return b.success/b.total;};
}
export function vote(hypotheses,{calibrate=(_model,p)=>p,gapConfidence=.5,balanceModels=true}={}){
 if(!hypotheses.length)throw new Error('No hypotheses');
 const counts=new Map();for(const h of hypotheses)counts.set(h.model,(counts.get(h.model)||0)+1);
 let network=[],sources=[];
 for(const h of hypotheses){const words=normalized(h);if(words.some(w=>!Number.isFinite(w.confidence)||w.confidence<0||w.confidence>1))throw new Error('Missing or invalid confidence');
  const source={model:h.model,weight:balanceModels?1/counts.get(h.model):1};
  const values=words.map(w=>({text:w.text,score:calibrate(h.model,w.confidence),...source}));
  const nullVote=s=>({text:null,score:gapConfidence,...s});
  if(!sources.length)network=values.map(v=>[v]);
  else{const pairs=align(network,values,(column,w)=>column.some(v=>v.text===w.text));network=pairs.map(([i,j])=>i<0?[...sources.map(nullVote),values[j]]:j<0?[...network[i],nullVote(source)]:[...network[i],values[j]]);}
  sources.push(source);
 }
 const words=[],columns=[];for(const col of network){const sums=new Map();for(const v of col)sums.set(v.text,(sums.get(v.text)||0)+v.score*v.weight);
  // Fixed tie break: earliest input (baseline) wins. Do not inspect reference.
  const ranked=[...sums].sort((a,b)=>b[1]-a[1]),winner=ranked[0];columns.push({winner:winner[0],votes:[...sums]});if(winner[0]!==null)words.push(winner[0]);}
 return{text:words.join(' '),columns};
}
