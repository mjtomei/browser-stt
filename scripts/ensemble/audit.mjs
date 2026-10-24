import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {stitch} from './stitch.mjs';
const cases=JSON.parse(await readFile('benchmarks/window-study-expanded-manifest.json')).cases;
const inputs=JSON.parse(await readFile('benchmarks/ensemble-inputs.json'));
const scoredIds=new Set(cases.flatMap(c=>c.samples.map(s=>s.id)));
assert.equal(cases.length,15);assert.equal(new Set(cases.map(c=>c.speaker)).size,15);
for(const c of inputs){assert(c.seconds>=90);assert(c.contextIds.every(id=>!scoredIds.has(id)));assert(c.vocabulary.length<=200);}
const rows=[],incomplete=[];
for(const model of await readdir('test-results/ensemble'))for(const c of cases){
 const path=`test-results/ensemble/${model}/${c.id}.json`;let raw;
 try{raw=await readFile(path);}catch{incomplete.push(path);continue;}
 const r=JSON.parse(raw),configs=[];
 for(const w of r.windows){
  assert(w.start>=0&&w.end<=c.seconds+.001&&w.end>w.start);
  assert(w.wallMs>=0);
  for(const word of w.words){assert(Number.isFinite(word.confidence)&&word.confidence>=0&&word.confidence<=1);assert.equal(w.text.slice(word.start,word.end),word.text);}
 }
 for(const window of [15,30,60]){
  if(model.startsWith('whisper')&&window===60)continue;
  for(const shift of [0,window/4])configs.push({window,shift,hints:true});
 }
 configs.push({window:15,shift:0,hints:false});
 for(const g of configs){const s=stitch(r,g);if(s.missing.length||Math.abs(s.seconds-c.seconds)>.001||!s.windows)incomplete.push({model,case:c.id,...g,missing:s.missing});}
 rows.push({model,case:c.id,sha256:createHash('sha256').update(raw).digest('hex'),calls:r.windows.length,fallbackCalls:r.windows.filter(w=>w.fallback).length,failedAttempts:r.errors,configs:configs.length});
}
const report={at:new Date().toISOString(),cases:cases.length,models:new Set(rows.map(r=>r.model)).size,configurations:rows.reduce((n,r)=>n+r.configs,0),incomplete,rows};
await writeFile('benchmarks/ensemble-audit.json',JSON.stringify(report,null,2)+'\n');
console.log('Audited',rows.length,'model/passages;',incomplete.length,'incomplete configurations');
if(incomplete.length&&!process.argv.includes('--partial'))process.exitCode=1;
