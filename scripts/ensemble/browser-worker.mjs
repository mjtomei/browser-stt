import{createRecognizer}from'./inference.mjs';
import{env}from'@huggingface/transformers';
let engine;
self.onmessage=async({data})=>{try{
 if(data.type==='load'){
  env.backends.onnx.wasm.wasmPaths={mjs:self.location.origin+'/ort/ort-wasm-simd-threaded.mjs',wasm:self.location.origin+'/ort/ort-wasm-simd-threaded.wasm'};
  engine=await createRecognizer(data.model,'/ensemble-models/',{device:'wasm',onWord:piece=>self.postMessage({id:data.id,partial:piece})});self.postMessage({id:data.id,ready:true});
 }else{const t=performance.now(),result=await engine.transcribe(data.audio,data.vocabulary||[]);self.postMessage({id:data.id,result,wallMs:performance.now()-t});}
}catch(e){self.postMessage({id:data.id,error:String(e)});}};
