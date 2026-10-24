import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile,writeFile} from 'node:fs/promises';
import {SpeechStream} from '../../src/speech-stream.js';
import {pcmChecksum} from '../../src/pcm-microphone.js';
const model=process.argv[2]||'conformer-small',windowSeconds=Number(process.argv[3]||15);
const c=JSON.parse(await readFile('benchmarks/ensemble-inputs.json'))[0],raw=await readFile(c.file),pcm=new Uint8Array(raw.subarray(44));
let id=0,readyResolve;const pending=new Map(),ready=new Promise(r=>readyResolve=r),loadStart=performance.now();
const worker=spawn('.state/ensemble/venv/bin/python',['-u','scripts/ensemble/native-server.py',model],{stdio:['pipe','pipe','inherit']});
createInterface({input:worker.stdout}).on('line',line=>{const d=JSON.parse(line);if(d.ready)return readyResolve();const p=pending.get(d.id);pending.delete(d.id);d.error?p.reject(Error(d.error)):p.resolve(d.result);});
worker.on('exit',code=>{for(const p of pending.values())p.reject(Error(`Native worker exited ${code}`));});
const request=bytes=>new Promise((resolve,reject)=>{const float=new Float32Array(bytes.length/2),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);for(let i=0;i<float.length;i++)float[i]=view.getInt16(i*2,true)/32768;pending.set(++id,{resolve,reject});worker.stdin.write(JSON.stringify({id,pcm:Buffer.from(float.buffer).toString('base64'),vocabulary:c.vocabulary})+'\n');});
const report={model,windowSeconds,backend:'Native Conformer CPU through production SpeechStream; not WASM/phone',case:c.id};
try{
 await ready;const loadMs=performance.now()-loadStart;await request(pcm.slice(0,3*32000));
 const updates=[],calls=[],backlog=[],started=performance.now();let firstWordMs=null,maxFeedLateMs=0,fatal;
 const stream=new SpeechStream({windowSeconds,overlapSeconds:windowSeconds/2,commitOnPause:false,
  failure:e=>fatal=e,result:r=>{if(r.text){firstWordMs??=performance.now()-started;updates.push({ms:performance.now()-started,text:r.text,receivedSeconds:stream.length/32000,completedSeconds:stream.completedEnd/32000,partial:!!r.partial});}},
  transcribe:async blob=>{const bytes=new Uint8Array(await blob.arrayBuffer()).slice(44),t=performance.now(),r=await request(bytes);calls.push({audioSeconds:bytes.length/32000,ms:performance.now()-t});return r;}});
 stream.start(c.vocabulary);
 for(let i=0;i<pcm.length;i+=3200){const end=Math.min(pcm.length,i+3200),due=end/32;await new Promise(r=>setTimeout(r,Math.max(0,due-(performance.now()-started))));maxFeedLateMs=Math.max(maxFeedLateMs,performance.now()-started-due);backlog.push({ms:performance.now()-started,seconds:(stream.length-stream.completedEnd)/32000});if(fatal)throw fatal;stream.receive(pcm.slice(i,end));}
 const release=performance.now(),r=await stream.finish({kind:'pcm-stream',bytes:pcm.length,checksum:pcmChecksum(pcm)});
 report.result={loadMs,firstWordMs,releaseMs:performance.now()-release,maxFeedLateMs,updates,calls,backlog,...r};
}catch(e){report.error=String(e);throw e;}finally{worker.stdin.end();await writeFile(`test-results/ensemble-native-window-${model}-paced-${windowSeconds}.json`,JSON.stringify(report,null,2)+'\n');}
console.log(model,windowSeconds,'first',report.result.firstWordMs,'release',report.result.releaseMs);
