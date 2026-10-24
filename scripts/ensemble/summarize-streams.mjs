// Endpoint anchors are not forced-aligned word timestamps.
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {benchmarkWords,scoreSpeech} from '../../src/speech-benchmark.js';
const c=JSON.parse(await readFile('benchmarks/window-study-expanded-manifest.json')).cases[0],reference=c.samples.map(x=>x.reference).join(' ');
const percentile=(values,p)=>{const a=values.toSorted((a,b)=>a-b);return a.length?a[Math.min(a.length-1,Math.floor(a.length*p))]:null;};
const contains=(a,b)=>a.some((_,i)=>b.every((w,j)=>a[i+j]===w));
const count=(a,b)=>a.reduce((n,_,i)=>n+Number(b.every((w,j)=>a[i+j]===w)),0);
const rows=[];
for(const file of await readdir('test-results')){
 if(!/^ensemble-(browser-.+-paced-\d+(?:-plain)?|native-window-.+-paced-\d+|native-paced-.+)\.json$/.test(file))continue;
 const report=JSON.parse(await readFile('test-results/'+file)),r=report.result||report;
 if(report.error){rows.push({raw:file,model:report.model,error:report.error});continue;}
 const updates=r.updates.map(u=>({...u,words:benchmarkWords(u.text)})),final=benchmarkWords(r.text),ref=benchmarkWords(reference);let end=0;
 const tails=c.samples.map(s=>{end+=s.seconds;const phrase=benchmarkWords(s.reference).slice(-3);if(phrase.length!==3||count(ref,phrase)!==1)return null;
  const flags=updates.map(u=>contains(u.words,phrase)),first=flags.indexOf(true),lastAbsent=flags.lastIndexOf(false),survives=contains(final,phrase);
  return{clip:s.id,phrase:phrase.join(' '),clipEndSeconds:end,final:survives,firstDelay:first<0?null:updates[first].ms/1000-end,stableDelay:survives?updates[lastAbsent+1]?.ms/1000-end:null};
 }).filter(Boolean);
 let revisions=0,previous=[];for(const u of updates){if(previous.some((w,i)=>u.words[i]!==w))revisions++;previous=u.words;}
 rows.push({model:report.model,hints:report.hints!==false,window:report.windowSeconds||'incremental',runtime:report.backend||report.runtime,raw:file,case:c.id,
  firstWordMs:r.firstWordMs,releaseMs:r.releaseMs,loadMs:r.loadMs,maxFeedLateMs:r.maxFeedLateMs,updates:updates.length,revisions,p95BacklogSeconds:percentile(r.backlog.map(x=>x.seconds),.95),
  finalErrors:scoreSpeech(reference,r.text).errors,referenceWords:ref.length,tails,medianRecognizedTailDelay:percentile(tails.map(x=>x.firstDelay).filter(x=>x!==null),.5),text:r.text});
}
const out={case:c.id,seconds:c.seconds,scope:'One representative long passage per configuration; shared desktop, not phone. Native incremental and Chrome WASM are separate runtimes. Tails are endpoint-relative exact three-word matches, not forced-aligned word latency. Only recognized tails contribute delay; preserve missing counts.',rows};
await writeFile('benchmarks/ensemble-streams.json',JSON.stringify(out,null,2)+'\n');
console.table(rows.map(({model,window,firstWordMs,releaseMs,p95BacklogSeconds,finalErrors})=>({model,window,first:Math.round(firstWordMs),release:Math.round(releaseMs),p95BacklogSeconds,finalErrors})));
