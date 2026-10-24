#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Use Node 22.13+ from PATH.
export ENSEMBLE_NODE="$(command -v node)"
export OPENBLAS_NUM_THREADS=1
export MOONSHINE_ORT_SINGLE_THREAD=1
lane="$1"; shift
if [ "$lane" = js ]; then
 for model in moonshine-tiny whisper-tiny.en moonshine-base whisper-base.en; do
  node scripts/ensemble/run-js.mjs "$model" "$@"
 done
else
 export LD_LIBRARY_PATH="$PWD/.state/ensemble/moonshine-source/core/third-party/onnxruntime/lib/linux/aarch64"
 for model in conformer-small zipformer-20m vosk-small moonshine-tiny-streaming; do
  .state/ensemble/venv/bin/python -u scripts/ensemble/native.py "$model" "$@"
 done
fi
