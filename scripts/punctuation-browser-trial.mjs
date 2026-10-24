// Experimental only: invokes a separate WASM target; no production runtime edits.
// Curated references are withheld from the model. Real ASR transcripts come from
// the previous dictation study, not from the reference sentences.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const browserName = process.argv.includes('--webkit') ? 'webkit' : 'chromium';
const precision = process.argv.includes('--fp32') ? 'fp32' : 'int8';
const root = path.resolve('.state/punctuation');
const modelDir = path.join(root, 'sherpa-onnx-online-punct-en-2024-08-06');
const binaryDir = path.resolve('.state/ensemble/sherpa-wasm/bin');
const cases = JSON.parse(await readFile('benchmarks/punctuation-cases.json'));
// Remove sentence punctuation, but retain apostrophes, hyphens and decimal dots.
const unpunctuate = text => text.toLowerCase().replace(/(?<!\d)\.|\.(?!\d)|[,?!;:"“”]/gu, '').replace(/\s+/gu, ' ').trim();
const inputs = [
  { id: 'upstream-example', source: 'sanity', input: 'how are you i am fine thank you', expected: 'How are you? I am fine. Thank you.' },
  ...cases.map(row => ({ ...row, input: unpunctuate(row.reference), source: 'curated-text' })),
];
// Freeze the prior ASR outputs so this trial can be reproduced without rerunning
// recognition or depending on ignored reports/current voting implementation.
const captured = JSON.parse(await readFile('benchmarks/punctuation-asr-inputs.json'));
inputs.push(...captured.rows.map(row => ({ ...row, input: unpunctuate(row.original) })));
const workerSource = `
import createRuntime from '/punctuation-trial.mjs';
let runtime;
self.onmessage=async ({data}) => {
  try {
    if(data.kind==='prepare'){
      const started=performance.now();
      runtime=await createRuntime({locateFile:file=>'/'+file,print:()=>{},printErr:()=>{}});
      const emptyHeap=runtime.HEAPU8.byteLength;
      for(const name of ['model.onnx','bpe.vocab']){
        const bytes=new Uint8Array(await (await fetch('/'+name)).arrayBuffer());
        runtime.FS.writeFile('/'+name,bytes);
      }
      const at=performance.now();
      if(!runtime._punct_init())throw Error('Initialization failed');
      const initializationMs=performance.now()-at;
      for(const name of ['model.onnx','bpe.vocab'])runtime.FS.unlink('/'+name);
      self.postMessage({id:data.id,value:{loadMs:performance.now()-started,initializationMs,emptyHeap,loadedHeap:runtime.HEAPU8.byteLength}});
    } else {
      const started=performance.now();
      const text=runtime.ccall('punct_run','string',['string'],[data.text]);
      self.postMessage({id:data.id,value:{text,ms:performance.now()-started,heap:runtime.HEAPU8.byteLength}});
    }
  }catch(error){self.postMessage({id:data.id,error:error.message||String(error)});}
};`;
const routes = new Map([
  ['/punctuation-trial.mjs', [path.join(binaryDir, 'punctuation-trial.mjs'), 'text/javascript']],
  ['/punctuation-trial.wasm', [path.join(binaryDir, 'punctuation-trial.wasm'), 'application/wasm']],
  ['/model.onnx', [path.join(modelDir, precision === 'int8' ? 'model.int8.onnx' : 'model.onnx'), 'application/octet-stream']],
  ['/bpe.vocab', [path.join(modelDir, 'bpe.vocab'), 'text/plain']],
]);
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>Punctuation trial</title>'); return; }
  if (req.url === '/worker.js') { res.setHeader('Content-Type','text/javascript'); res.end(workerSource); return; }
  const file = routes.get(req.url);
  if (!file) { res.writeHead(404).end(); return; }
  try { res.setHeader('Content-Type',file[1]); res.end(await readFile(file[0])); }
  catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await (browserName === 'webkit' ? webkit : chromium).launch({ executablePath: browserName === 'webkit' ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome' });
const report = { browser: browserName, precision, physicalPhone: false, createdAt: new Date().toISOString(), rows: [] };
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  report.preparation = await page.evaluate(async () => {
    const worker = window.worker = new Worker('/worker.js', {type:'module'});
    let serial = 0; const waiting = new Map();
    worker.onmessage = ({data}) => { const item=waiting.get(data.id); waiting.delete(data.id); data.error ? item.reject(Error(data.error)) : item.resolve(data.value); };
    worker.onerror = event => { for(const item of waiting.values())item.reject(Error(event.message));waiting.clear(); };
    window.run = data => new Promise((resolve,reject) => { const id=++serial; waiting.set(id,{resolve,reject}); worker.postMessage({...data,id}); });
    return window.run({kind:'prepare'});
  });
  for (const input of inputs) {
    const predictions = [];
    for (let repeat = 0; repeat < 3; repeat++) predictions.push(await page.evaluate(text => window.run({kind:'run',text}), input.input));
    assert(predictions.every(p => p.text === predictions[0].text), 'Repeated output differs');
    const row = { ...input, output: predictions[0].text, timesMs: predictions.map(p => p.ms), heap: predictions.at(-1).heap };
    if (row.expected) assert.equal(row.output, row.expected, 'Upstream example must match before interpreting results');
    report.rows.push(row);
    console.log(JSON.stringify({id:row.id,source:row.source,original:row.original,reference:row.reference,output:row.output,ms:row.timesMs}));
  }
  report.passed = true;
} finally {
  await mkdir('test-results/punctuation', {recursive:true});
  await writeFile(`test-results/punctuation/${browserName}-${precision}.json`, JSON.stringify(report,null,2)+'\n');
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
