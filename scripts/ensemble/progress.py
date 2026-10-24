import json,pathlib
root=pathlib.Path('test-results/ensemble')
durations={c['id']:c['seconds']for c in json.loads(pathlib.Path('benchmarks/ensemble-inputs.json').read_text())}
for model in sorted(root.iterdir()):
 files=list(model.glob('*.json')); n=0;calls=0;seconds=0
 for p in files:
  r=json.loads(p.read_text());calls+=len(r['windows']);seconds+=sum(w['wallMs']for w in r['windows'])/1000
  # Final no-hint tail is last in each primary plan.
  if any(w['hints']==False and not w.get('fallback') and abs(w['end']-durations[r['case']])<.001 and w['window']==15 for w in r['windows']):n+=1
 print(f'{model.name:26} {n:2}/15 primary  {calls:4} calls  {seconds/60:5.1f} inference-min')
