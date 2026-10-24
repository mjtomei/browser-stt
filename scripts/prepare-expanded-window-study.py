"""Fixed, output-independent long passages for a paired 15/30/60-second study.

Consecutive source utterances, one chapter/speaker per passage, at least 95 s.
10 test-clean + 5 test-other, no speakers from the earlier two-sample study.
Requires FFMPEG (default ffmpeg); keeps downloaded audio in ignored .state/.
"""
import hashlib
import itertools
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / '.state/expanded-window-study'
MANIFEST = ROOT / 'benchmarks/window-study-expanded-manifest.json'
REVISION = '71cacbfb7e2354c4226d01e70d77d5fca3d04ba1'
FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')
DEST.mkdir(parents=True, exist_ok=True)


def fetch(url):
    for attempt in range(4):
        try:
            return urllib.request.urlopen(url, timeout=40).read()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def rows(config, offset):
    url = f'https://datasets-server.huggingface.co/rows?dataset=openslr/librispeech_asr&config={config}&split=test&offset={offset}&length=100'
    result = json.loads(fetch(url))
    if result.get('partial'):
        raise ValueError('Partial source dataset response')
    return result['rows']


def audio(config, item):
    row = item['row']
    url = row['audio'][0]['src']
    if f'/--/{REVISION}/--/' not in url:
        raise ValueError('Source dataset revision changed')
    name = f"{config}-{row['id']}.wav"
    path = DEST / name
    meta = path.with_suffix('.json')
    if meta.exists() and path.exists():
        entry = json.loads(meta.read_text())
        if entry['sha256'] == hashlib.sha256(path.read_bytes()).hexdigest() and entry['reference'] == row['text']:
            return entry
    raw = fetch(url)
    pcm = subprocess.run([FFMPEG, '-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'], input=raw, stdout=subprocess.PIPE, check=True).stdout
    with wave.open(str(path), 'wb') as writer:
        writer.setparams((1, 2, 16000, len(pcm) // 2, 'NONE', 'not compressed'))
        writer.writeframes(pcm)
    entry = dict(file=name, id=row['id'], reference=row['text'], seconds=len(pcm) / 32000,
                 row=item['row_idx'], speaker=row['speaker_id'], chapter=row['chapter_id'],
                 sha256=hashlib.sha256(path.read_bytes()).hexdigest(), flacSha256=hashlib.sha256(raw).hexdigest())
    if not 0 < entry['seconds'] <= 60:
        raise ValueError('Unexpected source clip duration')
    meta.write_text(json.dumps(entry, indent=2) + '\n')
    return entry


def main():
    if MANIFEST.exists():
        manifest = json.loads(MANIFEST.read_text())
        for case in manifest['cases']:
            for sample in case['samples']:
                path = DEST / sample['file']
                if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == sample['sha256']:
                    continue
                found = next(r for r in rows(case['config'], sample['row']) if r['row_idx'] == sample['row'])
                if audio(case['config'], found) != sample:
                    raise ValueError(f"Changed source sample: {sample['id']}")
        print('Verified', len(manifest['cases']), 'fixed passages', flush=True)
        return
    seen = {1272, 1320, 2961, 8455}
    cases, exclusions = [], []
    slots = [('clean', 40 + 200 * i) for i in range(10)] + [('other', 40 + 500 * i) for i in range(5)]
    for config, initial in slots:
        selected = None
        for offset in range(initial, min(initial + 700, 2600 if config == 'clean' else 2900), 100):
            page = rows(config, offset)
            for (speaker, chapter), group in itertools.groupby(page, key=lambda item: (item['row']['speaker_id'], item['row']['chapter_id'])):
                if speaker in seen:
                    continue
                samples, seconds = [], 0
                for item in group:
                    sample = audio(config, item)
                    samples.append(sample)
                    seconds += sample['seconds']
                    if seconds >= 95:
                        break
                if seconds < 95:
                    exclusions.append(dict(config=config, speaker=speaker, chapter=chapter, firstRow=samples[0]['row'], seconds=seconds, reason='Insufficient remaining consecutive audio in this metadata group'))
                    continue
                selected = dict(id=f'{len(cases) + 1:02d}-{config}-{speaker}-{chapter}', config=config,
                                speaker=speaker, chapter=chapter, seconds=seconds, samples=samples)
                seen.add(speaker)
                break
            if selected:
                break
        if not selected:
            raise ValueError(f'Could not select a new speaker for {config}/{initial}')
        cases.append(selected)
        print(f"Selected {selected['id']}: {selected['seconds']:.2f}s / {len(selected['samples'])} clips", flush=True)
    manifest = dict(dataset='openslr/librispeech_asr', revision=REVISION, source='https://www.openslr.org/12', license='CC-BY-4.0',
                    selection='Fixed metadata offsets: clean 40+200*i (i=0..9), other 40+500*i (i=0..4). First unused speaker/chapter with >=95 seconds; advance metadata by 100 if needed. No output-based selection, repeated audio, inserted silence, or synthetic noise.',
                    cases=cases, exclusions=exclusions)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + '\n')
    print('Total audio seconds', sum(case['seconds'] for case in cases), flush=True)


if __name__ == '__main__':
    main()
