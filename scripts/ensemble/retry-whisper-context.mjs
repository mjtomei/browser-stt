// Preserve earlier adapter attempts before applying the shared-context cap.
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {AutoTokenizer,env} from '@huggingface/transformers';
import {whisperVocabularyPrompt} from '../../src/speech-vocabulary.js';
env.allowRemoteModels=false;env.localModelPath=process.cwd()+'/.state/ensemble/models/';
const inputs=JSON.parse(await readFile('benchmarks/ensemble-inputs.json'));
await mkdir('test-results/ensemble-attempts/whisper-context',{recursive:true});
for(const model of ['whisper-tiny.en','whisper-base.en']){
 const tok=await AutoTokenizer.from_pretrained(model),config=JSON.parse(await readFile(`.state/ensemble/models/${model}/generation_config.json`));
 for(const file of await readdir('test-results/ensemble/'+model)){
  const path=`test-results/ensemble/${model}/${file}`,r=JSON.parse(await readFile(path)),c=inputs.find(x=>x.id===r.case),removed=[];
  r.windows=r.windows.filter(w=>{const p=whisperVocabularyPrompt(tok,config,w.hints?c.vocabulary:[],448),cap=448-(p.prefix?.length||2)-1,expected=Math.min(480,Math.max(8,Math.ceil((w.end-w.start)*8)),cap);
   if(w.tokenLimit!==expected&&w.tokens>=expected){removed.push(w);return false;}return true;});
  if(removed.length){await writeFile(`test-results/ensemble-attempts/whisper-context/${model}-${file}`,JSON.stringify({model,case:r.case,reason:'Output reached a limit larger than remaining shared context; retry with bounded generation',windows:removed}));await writeFile(path,JSON.stringify(r));console.log(model,file,'retry',removed.length);}
 }
}
