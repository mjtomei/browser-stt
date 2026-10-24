"""Prepare pinned models and reference-free inference inputs for the ensemble study."""
import json,hashlib,urllib.request,tarfile,zipfile,wave,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]; D=ROOT/'.state/ensemble'; D.mkdir(exist_ok=True)
def fetch(url,path):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
 if not path.exists():
  print('Downloading',url,flush=True)
  for attempt in range(5):
   try:
    with urllib.request.urlopen(url,timeout=90) as r,open(str(path)+'.part','wb') as w:
     while b:=r.read(1024*1024):w.write(b)
    break
   except Exception:
    if attempt==4: raise
    time.sleep(2**attempt)
  Path(str(path)+'.part').rename(path)
 return path
manifest=json.loads((ROOT/'benchmarks/window-study-expanded-manifest.json').read_text()); inputs=[]
excluded={s['id'] for c in manifest['cases'] for s in c['samples']}
for c in manifest['cases']:
 pcm=b''
 for s in c['samples']:
  p=ROOT/'.state/expanded-window-study'/s['file'];assert hashlib.sha256(p.read_bytes()).hexdigest()==s['sha256']
  with wave.open(str(p)) as w: pcm+=w.readframes(w.getnframes())
 out=D/'audio'/f"{c['id']}.wav";out.parent.mkdir(exist_ok=True)
 with wave.open(str(out),'wb') as w:w.setparams((1,2,16000,len(pcm)//2,'NONE','not compressed'));w.writeframes(pcm)
 offset=max(0,c['samples'][0]['row']-30)
 url=f"https://datasets-server.huggingface.co/rows?dataset=openslr/librispeech_asr&config={c['config']}&split=test&offset={offset}&length=100"
 source=fetch(url,D/'context'/f"{c['id']}.json");response=json.loads(source.read_text());assert not response.get('partial');rows=response['rows']
 assert all('/--/'+manifest['revision']+'/--/' in r['row']['audio'][0]['src'] for r in rows), 'Dataset revision changed'
 neighbors=[r['row'] for r in rows if r['row']['id'] not in excluded and r['row']['chapter_id']==c['chapter'] and r['row']['speaker_id']==c['speaker']]
 # Nearby, non-evaluated source text only. No scored reference words enter hints.
 context=' '.join(r['text'] for r in neighbors)
 inputs.append(dict(id=c['id'],seconds=c['seconds'],file=str(out.relative_to(ROOT)),context=context,contextIds=[r['id'] for r in neighbors],sourceRevision=manifest['revision']))
previous=json.loads((ROOT/'benchmarks/ensemble-inputs.json').read_text()) if (ROOT/'benchmarks/ensemble-inputs.json').exists() else []
for c in inputs:
 old=next((x for x in previous if x['id']==c['id']),None)
 if old and old.get('context')==c['context'] and 'vocabulary' in old:c['vocabulary']=old['vocabulary']
(ROOT/'benchmarks/ensemble-inputs.json').write_text(json.dumps(inputs,indent=2)+'\n')
release=fetch('https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/asr-models',D/'zipformer-models.json')
assets=json.loads(release.read_text())['assets']
for name in ['sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2','sherpa-onnx-nemo-ctc-en-conformer-small.tar.bz2']:
 entry=next(x for x in assets if x['name']==name);archive=fetch(entry['browser_download_url'],D/name)
 with tarfile.open(archive) as t:t.extractall(D/'models',filter='data')
 archive.with_suffix(archive.suffix+'.sha256').write_text(hashlib.sha256(archive.read_bytes()).hexdigest())
archive=fetch('https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip',D/'vosk-model-small-en-us-0.15.zip')
with zipfile.ZipFile(archive) as z:z.extractall(D/'models')
# Use the recorded CDN revision, not a future runtime's default model catalog.
provenance=json.loads((ROOT/'benchmarks/ensemble-provenance.json').read_text())
for entry in provenance['modelFiles']:
 if entry['file'].startswith('models/download.moonshine.ai/'):
  path=fetch('https://'+entry['file'][7:],D/entry['file'])
  assert hashlib.sha256(path.read_bytes()).hexdigest()==entry['sha256'], entry['file']
p=D/'models/download.moonshine.ai/model/tiny-streaming-en/quantized_26_08_21'
(D/'moonshine-streaming-path.json').write_text(json.dumps(dict(path=str(p),arch=2)))
print('Ready: audio, disjoint context, native models',flush=True)

# Contextual hotwords require the matching SentencePiece vocabulary.
import sentencepiece as sp
p=D/'models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17'
bpe=fetch('https://huggingface.co/desh2608/icefall-asr-librispeech-pruned-transducer-stateless7-streaming-small/resolve/be162ecc09bade73063a671fad9d18220149d25b/data/lang_bpe_500/bpe.model',p/'bpe.model')
tokenizer=sp.SentencePieceProcessor(model_file=str(bpe))
(p/'bpe.vocab').write_text(''.join(f'{tokenizer.id_to_piece(i)}\t{tokenizer.get_score(i)}\n' for i in range(tokenizer.get_piece_size())))

for entry in provenance['modelFiles']:
 path=D/entry['file']
 if path.exists():assert hashlib.sha256(path.read_bytes()).hexdigest()==entry['sha256'], entry['file']
