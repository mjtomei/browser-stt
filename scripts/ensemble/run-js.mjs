import {readFile,writeFile,mkdir}from'node:fs/promises';
import {performance}from'node:perf_hooks';
import {createRecognizer}from'./inference.mjs';
import {stitch}from'./stitch.mjs';
import {open,unlink}from'node:fs/promises';
const model=process.argv[2]||'moonshine-tiny';
// Per-passage locks allow disjoint case ranges without duplicate writers.
const held=new Set();
async function acquire(name){const path=`.state/ensemble/${name}.lock`;for(;;){
 try{const fd=await open(path,'wx');await fd.writeFile(String(process.pid));await fd.close();held.add(path);return path;}
 catch(e){if(e.code!=='EEXIST')throw e;let pid;try{pid=Number(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
 try{process.kill(pid,0);}catch{try{await unlink(path);}catch{}continue;}await new Promise(r=>setTimeout(r,500));}
}}
process.on('exit',()=>{for(const p of held)try{process.getBuiltinModule('fs').unlinkSync(p);}catch{}});
const input=JSON.parse(await readFile('benchmarks/ensemble-inputs.json'));
const range=process.argv.find(x=>x.startsWith('--cases='))?.slice(8).split(':').map(Number)||[0,input.length];
const testCases=process.argv.includes('--smoke')?input.slice(0,1):input.slice(...range);
const outdir=`test-results/ensemble/${model}`;await mkdir(outdir,{recursive:true});
const loadStart=performance.now(),engine=await createRecognizer(model,process.cwd()+'/.state/ensemble/models/');
console.log('Loaded',model,performance.now()-loadStart);
for(const c of testCases){
 const caseLock=await acquire(`${model}.${c.id}`);
 try{
 const raw=await readFile(c.file),pcm=new Float32Array((raw.length-44)/2);for(let i=0;i<pcm.length;i++)pcm[i]=raw.readInt16LE(44+i*2)/32768;
 // Independent full windows at two staggered grids, with half overlap within each.
 const requests=[];
 for(const window of [15,30,60]){if(model.startsWith('whisper')&&window>30)continue;
  for(const shift of [0,window/4]){
   // First prefix preserves beginning. Every subsequent window is full-sized until the tail.
   const ends=[...(shift?[window-shift]:[]),...Array.from({length:Math.ceil(c.seconds/(window/2))+1},(_,i)=>window+i*window/2-shift)].filter(x=>x>0&&x<c.seconds);
   ends.push(c.seconds);
   for(const end of [...new Set(ends)])requests.push({start:Math.max(0,end-window),end,window,shift,hints:true});
  }
 }
 // Unhinted paired 15-second baseline.
 for(const r of requests.filter(x=>x.window===15&&x.shift===0))requests.push({...r,hints:false});
 if(process.argv.includes("--fallback")){requests.length=0;requests.push(...JSON.parse(await readFile("test-results/ensemble-fallbacks.json")).filter(r=>r.model===model&&r.case===c.id));}
 const file=`${outdir}/${c.id}.json`;let report;try{report=JSON.parse(await readFile(file));}catch{report={model,case:c.id,runtime:'native ONNX Runtime / Transformers.js CPU, 1 thread',windows:[],errors:[]};}
 for(const req of requests){const key=JSON.stringify(req);if(report.windows.some(x=>x.key===key))continue;
  const start=performance.now();try{const result=await engine.transcribe(pcm.subarray(Math.round(req.start*16000),Math.round(req.end*16000)),req.hints?c.vocabulary:[]);report.windows.push({key,...req,...result,wallMs:performance.now()-start});}
  catch(e){report.errors.push({key,...req,error:String(e)});await writeFile(file,JSON.stringify(report));throw e;}
  await writeFile(file,JSON.stringify(report));
 }
 // Finish ambiguous seams using only the newly captured audio, as in production.
 for(let attempt=0;attempt<64;attempt++){
  const groups=[...new Map(report.windows.filter(w=>!w.fallback).map(w=>[`${w.window}/${w.shift}/${w.hints}`,{window:w.window,shift:w.shift,hints:w.hints}])).values()];
  const missing=groups.flatMap(g=>stitch(report,g).missing);if(!missing.length)break;if(attempt===63)throw new Error('Too many unresolved seams');
  for(const req of missing){if(report.windows.some(w=>w.fallback&&Math.abs(w.start-req.start)<.001&&Math.abs(w.end-req.end)<.001&&w.hints===req.hints))continue;
   const start=performance.now(),result=await engine.transcribe(pcm.subarray(Math.round(req.start*16000),Math.round(req.end*16000)),req.hints?c.vocabulary:[]);
   report.windows.push({key:JSON.stringify(req),...req,...result,wallMs:performance.now()-start});await writeFile(file,JSON.stringify(report));
  }
 }
 console.log(model,c.id,report.windows.length,'windows');
 }finally{await unlink(caseLock);held.delete(caseLock);}
}
await engine.close();
