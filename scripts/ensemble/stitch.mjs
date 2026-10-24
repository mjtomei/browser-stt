import {readFile,writeFile,readdir,mkdir}from'node:fs/promises';
import {mergeSpeechOverlap}from'../../src/speech-overlap.js';
export function trimResult(r){const lead=r.text.length-r.text.trimStart().length;return{text:r.text.trim(),words:r.words.map(w=>({...w,start:w.start-lead,end:w.end-lead}))};}
const append=(a,b)=>{const n=a.text?a.text.length+1:0;return{text:(a.text?a.text+' ':'')+b.text,words:[...a.words,...b.words.map(w=>({...w,start:w.start+n,end:w.end+n}))]};};
export function stitch(report,group){
 const parts=report.windows.filter(r=>!r.fallback&&r.window===group.window&&r.shift===group.shift&&r.hints===group.hints).sort((a,b)=>a.end-b.end);
 let whole={text:'',words:[]},textStart=0,lastEnd=0,missing=[],fallbacks=0;
 for(const r of parts){const value=trimResult(r);
  if(!whole.text||r.start>=lastEnd-.001){textStart=whole.text?whole.text.length+1:0;whole=append(whole,value);lastEnd=r.end;continue;}
  const previous={text:whole.text.slice(textStart),words:whole.words.filter(w=>w.start>=textStart).map(w=>({...w,start:w.start-textStart,end:w.end-textStart}))};
  const merged=mergeSpeechOverlap(previous,value);
  if(merged){const prefix={text:whole.text.slice(0,textStart).trimEnd(),words:whole.words.filter(w=>w.end<=textStart)};const n=prefix.text?prefix.text.length+1:0;whole=append(prefix,merged);textStart=n+merged.overlapStart;}
  else{fallbacks++;const fallback=report.windows.find(w=>w.fallback&&Math.abs(w.start-lastEnd)<.001&&Math.abs(w.end-r.end)<.001&&w.hints===group.hints);
   if(!fallback){missing.push({model:report.model,case:report.case,...group,start:lastEnd,end:r.end,fallback:true});return{missing};}
   textStart=whole.text?whole.text.length+1:0;whole=append(whole,trimResult(fallback));
  }
  lastEnd=r.end;
 }
 for(const w of whole.words)if(whole.text.slice(w.start,w.end)!==w.text)throw new Error(`Offset mismatch ${report.model} ${w.text}`);
 return{...group,...whole,missing,fallbacks,seconds:lastEnd,windows:parts.length,model:report.model,case:report.case};
}
if(import.meta.url===new URL(process.argv[1],'file:').href){
 const missing=[],results=[];
 for(const model of await readdir('test-results/ensemble'))for(const file of await readdir('test-results/ensemble/'+model)){
  if(!file.endsWith('.json'))continue;const r=JSON.parse(await readFile(`test-results/ensemble/${model}/${file}`));
  const groups=[...new Map(r.windows.filter(w=>!w.fallback).map(w=>[`${w.window}/${w.shift}/${w.hints}`,{window:w.window,shift:w.shift,hints:w.hints}])).values()];
  for(const g of groups){const out=stitch(r,g);missing.push(...out.missing);if(!out.missing.length)results.push(out);}
 }
 await mkdir('test-results/ensemble-merged',{recursive:true});
 await writeFile('test-results/ensemble-fallbacks.json',JSON.stringify(missing,null,2));
 await writeFile('test-results/ensemble-merged/results.json',JSON.stringify(results));
 console.log('Stitched',results.length,'configurations;',missing.length,'fallbacks required');
}
