import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
// The fixed manifest includes ranked terms; regeneration explicitly uses the app ranker.
let speechVocabulary;
const root=process.cwd(), dest=path.join(root,'.state/ensemble/models');
let manifests;try{manifests=JSON.parse(await readFile('benchmarks/ensemble-models.json'));}catch{}
if(!manifests){manifests=[JSON.parse(await readFile('vendor/stt/model.json')), ...JSON.parse(await readFile('vendor/stt/benchmark-models.json')).filter(x=>!x.directory.includes('small'))];
const repo='onnx-community/whisper-tiny.en'; const meta=await(await fetch(`https://huggingface.co/api/models/${repo}`)).json();
manifests.push({repository:repo,revision:meta.sha,directory:'whisper-tiny.en',files:meta.siblings.filter(x=>x.rfilename.endsWith('.json') || /onnx\/(encoder_model|decoder_model_merged)_quantized.onnx$/.test(x.rfilename)).map(x=>({file:x.rfilename}))});
}
for(const m of manifests){
 m.files=m.files.filter(f=>!f.file.endsWith('.onnx')||(m.directory.startsWith('moonshine')?['onnx/encoder_model.onnx','onnx/decoder_model_merged_q4.onnx'].includes(f.file):f.file.includes('_quantized')));
 const dir=path.join(dest,m.directory); await mkdir(dir,{recursive:true});
 for(const f of m.files){
  if(f.file.endsWith('.onnx') && (m.directory.startsWith('moonshine') ? !['onnx/encoder_model.onnx','onnx/decoder_model_merged_q4.onnx'].includes(f.file) : !f.file.includes('_quantized')))continue;
  const target=path.join(dir,f.file);let bytes;
  for(const base of [dest,process.env.BROWSER_STT_CACHE,process.env.BROWSER_STT_BENCHMARK_CACHE].filter(Boolean)){
   try{const b=await readFile(path.join(base,m.directory,f.file));if(!f.sha256||createHash('sha256').update(b).digest('hex')===f.sha256){bytes=b;break;}}catch{}
  }
  if(!bytes){console.log('Fetching',m.directory,f.file);const r=await fetch(`https://huggingface.co/${m.repository}/resolve/${m.revision}/${f.file}`,{signal:AbortSignal.timeout(120000)});if(!r.ok)throw new Error(`${r.status} ${f.file}`);bytes=Buffer.from(await r.arrayBuffer());}
  const sha=createHash('sha256').update(bytes).digest('hex');if(f.sha256 &&sha!==f.sha256)throw new Error('Bad hash');f.sha256=sha;f.bytes=bytes.length;
  await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);
 }
}
await writeFile('benchmarks/ensemble-models.json',JSON.stringify(manifests,null,2)+'\n');
const inputs=JSON.parse(await readFile('benchmarks/ensemble-inputs.json'));
for(const c of inputs){if(!c.vocabulary){if(!process.env.PAGEBORNE_READER)throw Error('Set PAGEBORNE_READER to regenerate document-ranked hints; the recorded manifest already includes hints.');speechVocabulary ||= (await import(process.env.PAGEBORNE_READER+'/src/speech-vocabulary-ranking.js')).speechVocabulary;c.vocabulary=speechVocabulary('',{passage:c.context,focusOffset:0}).slice(0,200);}console.log(c.id,'hints',c.vocabulary.length);}
await writeFile('benchmarks/ensemble-inputs.json',JSON.stringify(inputs,null,2)+'\n');
