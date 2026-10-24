"""Real-time input delivery to three native incremental decoders; NOT phone/WASM."""
import json,os,queue,threading,time,wave,sys
from pathlib import Path
import numpy as np
from native import ADAPTERS,ROOT

model=sys.argv[1]
c=json.loads((ROOT/'benchmarks/ensemble-inputs.json').read_text())[0]
with wave.open(str(ROOT/c['file'])) as w: audio=np.frombuffer(w.readframes(w.getnframes()),'<i2').astype(np.float32)/32768
load=time.perf_counter();engine=ADAPTERS[model]();load_ms=(time.perf_counter()-load)*1000
# Warm the exact path before the measured capture.
engine.transcribe(audio[:3*16000],c['vocabulary'])
updates=[];backlog=[];first=None;previous='';consumed=0;lines={};committed=[]
def text_update(text):
 global first,previous
 text=text.strip()
 if text and text!=previous:
  now=(time.perf_counter()-started)*1000
  if first is None:first=now
  updates.append(dict(ms=now,text=text,consumedSeconds=consumed/16000));previous=text
if model=='zipformer-20m':
 stream=engine.engine.create_stream(hotwords='/'.join(v.upper() for v in c['vocabulary']) or None)
 def push(a):
  stream.accept_waveform(16000,a)
  while engine.engine.is_ready(stream):engine.engine.decode_stream(stream)
  text_update(engine.engine.get_result(stream))
 def finish():
  stream.accept_waveform(16000,np.zeros(4800,np.float32));stream.input_finished()
  while engine.engine.is_ready(stream):engine.engine.decode_stream(stream)
  text_update(engine.engine.get_result(stream))
elif model=='vosk-small':
 stream=engine.vosk.KaldiRecognizer(engine.model,16000)
 def push(a):
  if stream.AcceptWaveform((np.clip(a,-1,1)*32767).astype('<i2').tobytes()):
   committed.append(json.loads(stream.Result()).get('text',''));text_update(' '.join(committed))
  else:text_update(' '.join(committed+[json.loads(stream.PartialResult()).get('partial','')]))
 def finish():
  committed.append(json.loads(stream.FinalResult()).get('text',''));text_update(' '.join(committed))
elif model=='moonshine-tiny-streaming':
 engine.engine.set_keyterms(c['vocabulary']);stream=engine.engine.create_stream(update_interval=.5)
 def event(e):
  if hasattr(e,'error'):raise e.error
  lines[e.line.line_id]=e.line.text;text_update(' '.join(lines.values()))
 stream.add_listener(event);stream.start()
 def push(a):stream.add_audio(a.tolist())
 def finish():stream.stop()
else:raise ValueError('This model has no native incremental adapter')

chunks=queue.Queue();feed_late=[];started=time.perf_counter()
def capture():
 for at in range(0,len(audio),1600):
  end=min(len(audio),at+1600);due=end/16000
  time.sleep(max(0,due-(time.perf_counter()-started)))
  feed_late.append(max(0,(time.perf_counter()-started-due)*1000));chunks.put((end,audio[at:end]))
 chunks.put(None)
producer=threading.Thread(target=capture);producer.start()
while (item:=chunks.get()) is not None:
 end,a=item;consumed=end;push(a)
 backlog.append(dict(ms=(time.perf_counter()-started)*1000,seconds=max(0,min(c['seconds'],time.perf_counter()-started)-consumed/16000)))
finish();producer.join()
out=dict(model=model,runtime='Native incremental CPU / one thread; shared ARM64 workstation',phone=False,case=c['id'],loadMs=load_ms,firstWordMs=first,releaseMs=max(0,(time.perf_counter()-started-c['seconds'])*1000),maxFeedLateMs=max(feed_late),updates=updates,backlog=backlog,text=previous)
path=ROOT/f'test-results/ensemble-native-paced-{model}.json';path.write_text(json.dumps(out,indent=2)+'\n')
print(model,'first word',first,'release',out['releaseMs'],'updates',len(updates),flush=True)
