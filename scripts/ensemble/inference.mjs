import { AutoTokenizer, AutoProcessor, MoonshineForConditionalGeneration, WhisperForConditionalGeneration, AutomaticSpeechRecognitionPipeline, LogitsProcessorList, TextStreamer, env } from '@huggingface/transformers';
import { confidenceWords } from '../../src/speech-confidence.js';
import { vocabularyBias, whisperVocabularyPrompt } from '../../src/speech-vocabulary.js';
export async function createRecognizer(directory,base,{device='cpu',onWord}={}){
 env.allowRemoteModels=false;env.allowLocalModels=true;env.localModelPath=base;env.useBrowserCache=false;
 env.backends.onnx.wasm.numThreads=1;
 const whisper=directory.startsWith('whisper');
 const opts={device,dtype:whisper?'q8':{encoder_model:'fp32',decoder_model_merged:'q4'},session_options:{intraOpNumThreads:1,interOpNumThreads:1}};
 const tokenizer=await AutoTokenizer.from_pretrained(directory,opts),processor=await AutoProcessor.from_pretrained(directory,opts);
 const model=await(whisper?WhisperForConditionalGeneration:MoonshineForConditionalGeneration).from_pretrained(directory,opts);
 const pipe=new AutomaticSpeechRecognitionPipeline({task:'automatic-speech-recognition',tokenizer,processor,model});
 return{close:()=>model.dispose(),async transcribe(audio,vocabulary=[]){
  if(whisper&&audio.length>30*16000)throw new Error('Whisper has a 30-second acoustic window; 60-second input is unsupported.');
  const scores=[],special=new Set(tokenizer.all_special_ids||[]),bias=!whisper&&vocabulary.length?vocabularyBias(tokenizer,vocabulary):null;
  const prompt=whisper?whisperVocabularyPrompt(tokenizer,model.generation_config,vocabulary,model.config.max_target_positions):null;
  const processors=new LogitsProcessorList();processors.push((ids,logits)=>{
   const boosts=bias?.(ids,logits);let max=-Infinity,selected=-Infinity,token=-1;
   for(let i=0;i<logits.data.length;i++){max=Math.max(max,logits.data[i]);const v=logits.data[i]+(boosts?.get(i)||0);if(v>selected){selected=v;token=i;}}
   if(Number.isFinite(max)&&!special.has(token)){let sum=0;for(const v of logits.data)sum+=Math.exp(v-max);scores.push({token,probability:Math.exp(logits.data[token]-max)/sum});}
   for(const [token,amount]of boosts||[])logits.data[token]+=amount;return logits;
  });
  const allowance=Math.min(480,Math.max(8,Math.ceil(audio.length/16000*8)));
  // Whisper's previous-text prompt and generated tokens share 448 positions.
  const contextCapacity=whisper?model.config.max_target_positions-(prompt?.prefix?.length||2)-1:480;
  const options={max_new_tokens:Math.min(allowance,contextCapacity),do_sample:false,logits_processor:processors,
   ...(onWord?{streamer:new TextStreamer(tokenizer,{skip_prompt:true,callback_function:onWord})}:{})};
  let text;
  if(prompt?.prefix){const inputs=await processor(audio);const out=await model.generate({inputs:inputs.input_features,decoder_input_ids:prompt.prefix,...options});text=tokenizer.decode(out.tolist()[0].slice(prompt.prefix.length),{skip_special_tokens:true}).trim();}
  else text=(await pipe(audio,options)).text.trim();
  const words=confidenceWords(text,scores,ids=>tokenizer.decode(ids,{skip_special_tokens:true,clean_up_tokenization_spaces:false}),{metric:'geometricMean'});
  if(text&&words.length===0)throw new Error('Missing word confidence alignment');
  return{text,words:words.map(w=>({text:w.text,confidence:w.confidence,scores:w.scores,start:w.start,end:w.end})),hintCount:prompt?prompt.terms.length:vocabulary.length,tokens:scores.length,tokenLimit:options.max_new_tokens,contextCapacity};
 }};
}
