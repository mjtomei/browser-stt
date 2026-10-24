"""Native CPU comparison adapters. Not browser/phone performance measurements."""
import os,json,time,wave,re,math,sys,itertools,subprocess,fcntl,shutil
from pathlib import Path
import numpy as np
ROOT=Path(__file__).resolve().parents[2];D=ROOT/'.state/ensemble';MODELS=D/'models'
PAT=re.compile(r"[\w]+(?:['’][\w]+)*",re.UNICODE)
def words_from_pieces(pieces):
 text='';spans=[]
 for piece,prob in pieces:
  start=len(text);text+=piece;spans.append((start,len(text),float(prob)))
 words=[]
 for m in PAT.finditer(text):
  ps=[p for a,b,p in spans if a<m.end() and b>m.start()]
  if not ps:raise ValueError('Unscored word')
  words.append(dict(text=m.group(),confidence=math.exp(sum(math.log(max(1e-30,p)) for p in ps)/len(ps)),scores=dict(minimum=min(ps),mean=sum(ps)/len(ps)),start=m.start(),end=m.end()))
 return dict(text=text,words=words)
class Conformer:
 def __init__(self):
  import onnxruntime as ort,kaldi_native_fbank as knf
  self.knf=knf;p=MODELS/'sherpa-onnx-nemo-ctc-en-conformer-small';opts=ort.SessionOptions();opts.intra_op_num_threads=1;opts.inter_op_num_threads=1
  self.session=ort.InferenceSession(str(p/'model.int8.onnx'),sess_options=opts,providers=['CPUExecutionProvider']);self.tokens={int(line.split()[-1]):line.split()[0] for line in (p/'tokens.txt').read_text().splitlines()}
 def transcribe(self,audio,vocab):
  opts=self.knf.FbankOptions();opts.frame_opts.dither=0;opts.frame_opts.snip_edges=False;opts.frame_opts.samp_freq=16000;opts.mel_opts.num_bins=80
  fb=self.knf.OnlineFbank(opts);fb.accept_waveform(16000,(audio*32768).tolist());fb.input_finished()
  f=np.stack([fb.get_frame(i)for i in range(fb.num_frames_ready)]);f=(f-f.mean(axis=0,keepdims=True))/(f.std(axis=0,keepdims=True)+1e-5)
  logs=self.session.run(None,{'audio_signal':f.T[None].astype(np.float32),'length':np.array([len(f)],np.int64)})[0][0]
  if not np.allclose(np.exp(logs[:3]).sum(axis=1),1,atol=1e-3):raise ValueError('Not log probabilities')
  pieces=[];offset=0
  for token,group in itertools.groupby(logs.argmax(axis=-1)):
   n=len(list(group));score=float(np.exp(logs[offset:offset+n,token]).max());offset+=n
   if token!=1024:pieces.append((self.tokens[int(token)].replace('▁',' '),score))
  return{**words_from_pieces(pieces),'hintCount':0,'hintSupport':'No soft hotword support in this greedy CTC adapter','confidenceKind':'CTC peak frame posterior per token, geometric word mean'}
class Zipformer:
 def __init__(self):
  import sherpa_onnx,sentencepiece as sp
  p=MODELS/'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';self.sp=sp.SentencePieceProcessor(model_file=str(p/'bpe.model'))
  self.engine=sherpa_onnx.OnlineRecognizer.from_transducer(tokens=str(p/'tokens.txt'),encoder=str(p/'encoder-epoch-99-avg-1.int8.onnx'),decoder=str(p/'decoder-epoch-99-avg-1.onnx'),joiner=str(p/'joiner-epoch-99-avg-1.int8.onnx'),num_threads=1,decoding_method='modified_beam_search',max_active_paths=4,temperature_scale=1.0,modeling_unit='bpe',bpe_vocab=str(p/'bpe.vocab'))
 def transcribe(self,audio,vocab):
  hot='/'.join(v.upper() for v in vocab)
  s=self.engine.create_stream(hotwords=hot if hot else None);s.accept_waveform(16000,audio);s.accept_waveform(16000,np.zeros(4800,np.float32));s.input_finished()
  while self.engine.is_ready(s):self.engine.decode_stream(s)
  r=self.engine.get_result_all(s);logs=list(r.ys_probs);tokens=list(r.tokens)
  if len(logs)!=len(tokens):raise ValueError(f'Missing Zipformer scores {len(logs)} vs {len(tokens)}')
  result=words_from_pieces([(t.replace('▁',' '),math.exp(min(0,p)))for t,p in zip(tokens,logs)])
  result.update(hintCount=len(vocab),confidenceKind='Transducer token posterior, temperature 1, excludes context scores');return result
class Vosk:
 def __init__(self):
  import vosk
  vosk.SetLogLevel(-1);self.vosk=vosk;self.model=vosk.Model(str(MODELS/'vosk-model-small-en-us-0.15'))
 def transcribe(self,audio,vocab):
  r=self.vosk.KaldiRecognizer(self.model,16000);r.SetWords(True);all_words=[]
  pcm=(np.clip(audio,-1,1)*32767).astype('<i2').tobytes()
  for at in range(0,len(pcm),6400):
   if r.AcceptWaveform(pcm[at:at+6400]):all_words.extend(json.loads(r.Result()).get('result',[]))
  all_words.extend(json.loads(r.FinalResult()).get('result',[]))
  out=words_from_pieces([(' '+w['word'],w['conf'])for w in all_words]);out.update(hintCount=0,hintSupport='Restricted grammar is not appropriate for open dictation; using shipped language model',confidenceKind='Vosk word posterior');return out
class MoonStreaming:
 def __init__(self):
  from moonshine_voice import Transcriber,ModelArch
  p=json.loads((D/'moonshine-streaming-path.json').read_text())['path'];self.log=D/f'confidence-{os.getpid()}.tsv';os.environ['ENSEMBLE_CONFIDENCE_LOG']=str(self.log)
  self.engine=Transcriber(p,ModelArch.TINY_STREAMING,options={'use_speculative_decoding':False})
 def transcribe(self,audio,vocab):
  self.engine.set_keyterms(vocab);self.log.write_text('');t=self.engine.transcribe_without_streaming(audio.tolist());block=None;blocks=[]
  for line in self.log.read_text().splitlines():
   if line.startswith('BEGIN\t'):block={'text':bytes.fromhex(line[6:]).decode(),'pieces':[],'prefix':''}
   elif line=='END':blocks.append(block);block=None
   elif block is not None:
    prob,h=line.split('\t');text=bytes.fromhex(h).decode();old=block['prefix']
    if not text.startswith(old):raise ValueError('Nonmonotonic token decode')
    block['pieces'].append((text[len(old):],float(prob)));block['prefix']=text
  pieces=[]
  for line in t.lines:
   b=next((b for b in reversed(blocks)if b['text'].strip()==line.text.strip()),None)
   if b is None and line.text.strip():raise ValueError('Missing Moonshine confidence telemetry: '+line.text)
   if b:pieces.append((' ',1));pieces+=b['pieces']
  out=words_from_pieces(pieces);out.update(hintCount=len(vocab),internalSegments=len(t.lines),confidenceKind='Instrumented pre-bias greedy token posterior; geometric word mean');return out
ADAPTERS={'conformer-small':Conformer,'zipformer-20m':Zipformer,'vosk-small':Vosk,'moonshine-tiny-streaming':MoonStreaming}
def main():
 model=sys.argv[1]
 cases=json.loads((ROOT/'benchmarks/ensemble-inputs.json').read_text());engine=ADAPTERS[model]();outdir=ROOT/'test-results/ensemble'/model;outdir.mkdir(exist_ok=True,parents=True)
 if '--smoke' in sys.argv:cases=cases[:1]
 selected=next((arg[8:] for arg in sys.argv if arg.startswith('--cases=')),None)
 if selected:
  first,last=map(int,selected.split(':'));cases=cases[first:last]
 for c in cases:
  with open(D/(model+'.'+c['id']+'.flock'),'w') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX)
   with wave.open(str(ROOT/c['file'])) as w:audio=np.frombuffer(w.readframes(w.getnframes()),'<i2').astype(np.float32)/32768
   requests=[]
   for window in [15,30,60]:
    for shift in [0,window/4]:
     ends=sorted(set(([window-shift]if shift else[])+[window+i*window/2-shift for i in range(math.ceil(c['seconds']/(window/2))+1)if 0<window+i*window/2-shift<c['seconds']]+[c['seconds']]))
     for end in ends:requests.append(dict(start=max(0,end-window),end=end,window=window,shift=shift,hints=True))
   requests += [{**r,'hints':False}for r in requests if r['window']==15 and r['shift']==0]
   if '--fallback' in sys.argv:requests=[r for r in json.loads((ROOT/'test-results/ensemble-fallbacks.json').read_text()) if r['model']==model and r['case']==c['id']]
   file=outdir/(c['id']+'.json');report=json.loads(file.read_text())if file.exists()else dict(model=model,case=c['id'],runtime='Native CPU, research adapter (not browser)',windows=[],errors=[])
   for req in requests:
    key=json.dumps(req,separators=(',',':'))
    if any(r['key']==key for r in report['windows']):continue
    start=time.perf_counter()
    try:result=engine.transcribe(audio[round(req['start']*16000):round(req['end']*16000)],c['vocabulary']if req['hints']else[])
    except Exception as e:report['errors'].append(dict(**req,error=str(e)));file.write_text(json.dumps(report));raise
    report['windows'].append(dict(key=key,**req,**result,wallMs=(time.perf_counter()-start)*1000));file.write_text(json.dumps(report))
   for attempt in range(64):
    missing=json.loads(subprocess.check_output([os.environ.get('ENSEMBLE_NODE',shutil.which('node')),str(ROOT/'scripts/ensemble/stitch-case.mjs'),str(file)],cwd=ROOT))
    if not missing:break
    if attempt==63:raise ValueError('Unresolved seams')
    for req in missing:
     if any(w.get('fallback') and abs(w['start']-req['start'])<.001 and abs(w['end']-req['end'])<.001 and w['hints']==req['hints'] for w in report['windows']):continue
     start=time.perf_counter();result=engine.transcribe(audio[round(req['start']*16000):round(req['end']*16000)],c['vocabulary'] if req['hints'] else [])
     report['windows'].append(dict(key=json.dumps(req),**req,**result,wallMs=(time.perf_counter()-start)*1000));file.write_text(json.dumps(report))
   print(model,c['id'],len(report['windows']),'windows',flush=True)
if __name__=='__main__':main()
