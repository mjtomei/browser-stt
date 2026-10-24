"""Download consecutive, known-reference LibriSpeech clips for the window study.

Requires ffmpeg (or FFMPEG=/path/to/ffmpeg). Audio stays in ignored .state/.
Source: hf-internal-testing/librispeech_asr_dummy, clean/validation, rows 0–9.
Audio/transcripts originate in LibriSpeech (CC BY 4.0; vendor/stt licenses).
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request
import wave

directory = Path('.state/window-study')
directory.mkdir(parents=True, exist_ok=True)
source = 'https://datasets-server.huggingface.co/rows?dataset=hf-internal-testing/librispeech_asr_dummy&config=clean&split=validation&offset=0&length=10'
data = json.load(urllib.request.urlopen(source, timeout=30))
pin = Path('benchmarks/window-study-2026-10-13.json')
expected = {s['file']: s for r in json.loads(pin.read_text())['reports'] if r['scenario'] == 'prose' for s in r['samples']} if pin.exists() else {}
manifest = []
for item in data['rows']:
    row = item['row']
    path = directory / (row['id'] + '.wav')
    if not path.exists():
        audio = urllib.request.urlopen(row['audio'][0]['src'], timeout=30).read()
        pcm = subprocess.run([os.environ.get('FFMPEG', 'ffmpeg'), '-v', 'error', '-i', 'pipe:0',
                              '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
                             input=audio, stdout=subprocess.PIPE, check=True).stdout
        with wave.open(str(path), 'wb') as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(16000)
            writer.writeframes(pcm)
    with wave.open(str(path), 'rb') as reader:
        seconds = reader.getnframes() / reader.getframerate()
    entry = dict(id=row['id'], file=path.name, reference=row['text'], seconds=seconds,
                 sha256=hashlib.sha256(path.read_bytes()).hexdigest(), row=item['row_idx'])
    if path.name in expected and any(entry[key] != expected[path.name][key] for key in ['sha256', 'reference']):
        raise ValueError(f'Study sample differs from the recorded reference/checksum: {path.name}')
    manifest.append(entry)
    print(row['id'], seconds, flush=True)
(directory / 'samples.json').write_text(json.dumps(dict(source=source, samples=manifest), indent=2))
print('Total seconds:', sum(row['seconds'] for row in manifest))
