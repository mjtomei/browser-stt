import * as ort from 'onnxruntime-web/webgpu';
import wasm from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import encoder from '../vendor/stt/fluid-mini-encoder-webgpu.onnx?url';
export { ort, wasm, encoder };
