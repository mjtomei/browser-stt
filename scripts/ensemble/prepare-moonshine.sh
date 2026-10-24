#!/usr/bin/env bash
# Isolated, pinned ARM64 Linux telemetry build. Never modifies system libraries.
set -euo pipefail
cd "$(dirname "$0")/../.."
test "$(uname -s)" = Linux
test "$(uname -m)" = aarch64
ensemble_source="$PWD/.state/ensemble/moonshine-source"
ensemble_revision=234f60faa0eb388b01cdf7e60aca232af37aefda
if [ ! -d "$ensemble_source/.git" ]; then
 git init "$ensemble_source"
 git -C "$ensemble_source" remote add origin https://github.com/moonshine-ai/moonshine.git
 git -C "$ensemble_source" fetch --depth=1 origin "$ensemble_revision"
 GIT_LFS_SKIP_SMUDGE=1 git -C "$ensemble_source" checkout --detach FETCH_HEAD
fi
test "$(git -C "$ensemble_source" rev-parse HEAD)" = "$ensemble_revision"
.state/ensemble/venv/bin/python - <<'PY'
import hashlib,urllib.request
from pathlib import Path
root=Path('.state/ensemble/moonshine-source')
revision='234f60faa0eb388b01cdf7e60aca232af37aefda'
files={
 'core/moonshine-tts/src/zipvoice-voices-data.cpp':'f3e4d62cae93c465e1de8521bc5706b9a20f834cbbf37404bf03f0d35dffa012',
 'core/cpp-annote/src/community1_cpp_annote_embedded.cpp':'9424da4176b33e67e4000ea2a776d64b6a78ee9bbf72d40405fb6805d12758c4',
}
for name,expected in files.items():
 p=root/name
 if hashlib.sha256(p.read_bytes()).hexdigest()!=expected:
  data=urllib.request.urlopen(f'https://media.githubusercontent.com/media/moonshine-ai/moonshine/{revision}/{name}',timeout=120).read()
  assert hashlib.sha256(data).hexdigest()==expected
  p.write_bytes(data)
PY
.state/ensemble/venv/bin/python scripts/ensemble/instrument-moonshine.py
cmake -S "$ensemble_source/core" -B .state/ensemble/moonshine-build -DCMAKE_BUILD_TYPE=Release -DMOONSHINE_TTS_BUILD_ONNX=ON
cmake --build .state/ensemble/moonshine-build --target moonshine -j2
ensemble_library=$(.state/ensemble/venv/bin/python -c 'import pathlib,moonshine_voice;print(pathlib.Path(moonshine_voice.__file__).parent/"libmoonshine.so")')
if [ ! -f .state/ensemble/libmoonshine-original.so ]; then
 cp "$ensemble_library" .state/ensemble/libmoonshine-original.so
fi
cp .state/ensemble/moonshine-build/libmoonshine.so "$ensemble_library"
