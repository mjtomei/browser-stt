"""Research-only JSON/PCM pipe for a resident CPU recognizer."""
import sys,json,base64
import numpy as np
from native import ADAPTERS
engine=ADAPTERS[sys.argv[1]]()
print(json.dumps({'ready':True}),flush=True)
for line in sys.stdin:
 req=json.loads(line)
 try:out=engine.transcribe(np.frombuffer(base64.b64decode(req['pcm']),'<f4'),req['vocabulary'])
 except Exception as e:print(json.dumps({'id':req['id'],'error':str(e)}),flush=True);continue
 print(json.dumps({'id':req['id'],'result':out}),flush=True)
