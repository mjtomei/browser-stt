// Synthetic encoder-size stream, using real integrity checks and model response.
// Reports aggregate Linux child-process PSS; no inference, GPU or phone claim.
import {chromium,webkit} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const size=352825870, hash=createHash('sha256');
for(let offset=0;offset<size;offset+=4*1024*1024) hash.update(Buffer.alloc(Math.min(4*1024*1024,size-offset),123));
const sha256=hash.digest('hex');
const server=await createServer({configFile:false,clearScreen:false,optimizeDeps:{include:['@noble/hashes/sha2.js']},server:{host:'127.0.0.1',port:0},plugins:[{name:'probe',configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url==='/__memory'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Model buffer probe</title>');}else next();});}}]});await server.listen();
async function memory(pid=process.pid){
 const children=await readFile(`/proc/${pid}/task/${pid}/children`,'utf8').catch(()=>'');let total=0;
 for(const child of children.trim().split(/\s+/).filter(Boolean)){
  const text=await readFile(`/proc/${child}/smaps_rollup`,'utf8').catch(()=>'');total+=Number(text.match(/^Pss:\s+(\d+)/m)?.[1]||0);total+=await memory(child);
 }
 return total/1;
}
const results=[];
try{for(const engine of [chromium,webkit])for(const method of ['native','pinned-buffer']){
 const browser=await engine.launch({headless:true,executablePath:engine===chromium?'/usr/bin/google-chrome':process.env.WEBKIT_PATH});
 try{
  const page=await browser.newPage();await page.goto(`${server.resolvedUrls.local[0]}__memory`);
  const baseline=await memory();let peak=baseline,running=true;
  const sample=(async()=>{while(running){peak=Math.max(peak,await memory());await new Promise(r=>setTimeout(r,20));}})();
  const data=await page.evaluate(async ({method,size,sha256})=>{
   const {speechDownloader}=await import('/src/speech-download.js');
   let sent=0;
   const base=new URL('/stt/',location.href).href;
   const entry={local:'weights.onnx',url:'https://weights.test/immutable',bytes:size,sha256};
   const loader=speechDownloader({base,storage:null,entries:[entry],fetch:async()=>new Response(new ReadableStream({pull(sink){if(sent===size)return sink.close();const bytes=new Uint8Array(Math.min(4*1024*1024,size-sent));bytes.fill(123);sent+=bytes.length;sink.enqueue(bytes);}},{highWaterMark:0}))});
   const response=await loader.fetch(new URL(entry.local,base));
   const start=performance.now();let buffer;
   if(method==='native')buffer=await Response.prototype.arrayBuffer.call(response);
   else buffer=await response.arrayBuffer();
   window.__retained=buffer;await new Promise(r=>setTimeout(r,250));
   return {bytes:buffer.byteLength,first:new Uint8Array(buffer)[0],last:new Uint8Array(buffer).at(-1),ms:Math.round(performance.now()-start)};
  },{method,size,sha256});
  assert.equal(data.bytes,size);assert.equal(data.first,123);assert.equal(data.last,123);
  running=false;await sample;
  const result={engine:engine.name(),method,physicalPhone:false,syntheticBufferOnly:true,baselinePssMiB:Math.round(baseline/1024),peakPssMiB:Math.round(peak/1024),deltaPssMiB:Math.round((peak-baseline)/1024),...data};results.push(result);console.log(JSON.stringify(result));
 }finally{await browser.close();}
}}finally{await server.close();}
await writeFile('test-results/model-buffer-memory-probe.json',JSON.stringify(results,null,2));
