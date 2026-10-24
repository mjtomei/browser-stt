#!/usr/bin/env bash
# Uses the existing pinned Sherpa/emsdk checkout from the ensemble build.
# Builds an isolated experimental target without copying into vendor/ or dist/.
set -euo pipefail
cd "$(dirname "$0")/.."
punct_source="$PWD/.state/ensemble/sherpa-source"
punct_build="$PWD/.state/ensemble/sherpa-wasm"
test "$(git -C "$punct_source" rev-parse HEAD)" = 11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf
mkdir -p .state/punctuation "$punct_source/pageborne-punctuation"
if [ ! -f .state/punctuation/edge-punct.tar.bz2 ]; then
  curl -fL --retry 2 --max-time 120 \
    https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-online-punct-en-2024-08-06.tar.bz2 \
    -o .state/punctuation/edge-punct.tar.bz2
fi
echo '9f5e5a72c7d2829635bd074fce92b6bbd5b78da8a52e7ad8ed1be933f366b99d  .state/punctuation/edge-punct.tar.bz2' | sha256sum -c -
python3 - <<'PY'
from pathlib import Path
import tarfile
folder = Path('.state/punctuation')
with tarfile.open(folder / 'edge-punct.tar.bz2') as archive:
    archive.extractall(folder, filter='data')
PY
cp scripts/punctuation/{CMakeLists.txt,punctuation-trial.cc} "$punct_source/pageborne-punctuation/"
if ! rg -q '^add_subdirectory\(pageborne-punctuation\)' "$punct_source/CMakeLists.txt"; then
  printf '\nadd_subdirectory(pageborne-punctuation)\n' >> "$punct_source/CMakeLists.txt"
fi
source .state/ensemble/emsdk/emsdk_env.sh
cmake -S "$punct_source" -B "$punct_build"
cmake --build "$punct_build" --target punctuation-trial --parallel 4
