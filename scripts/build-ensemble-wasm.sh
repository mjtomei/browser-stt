#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
speech_root="$PWD"
speech_source="$speech_root/.state/ensemble/sherpa-source"
speech_build="$speech_root/.state/ensemble/sherpa-wasm"
speech_revision=11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf
test "$(git -C "$speech_source" rev-parse HEAD)" = "$speech_revision"
source "$speech_root/.state/ensemble/emsdk/emsdk_env.sh"
mkdir -p "$speech_source/pageborne"
cp scripts/wasm/{CMakeLists.txt,pageborne-speech.cc} "$speech_source/pageborne/"
if ! rg -q '^add_subdirectory\(pageborne\)' "$speech_source/CMakeLists.txt"; then
  printf '\nadd_subdirectory(pageborne)\n' >> "$speech_source/CMakeLists.txt"
fi
# Remap __FILE__/assertion paths as well as debug paths before compiling. This
# keeps local usernames and checkout locations out of distributable binaries.
speech_flags="-O3 -msimd128 -ffile-prefix-map=$speech_root=/src/browser-stt -fdebug-prefix-map=$speech_root=/src/browser-stt"
emcmake cmake -S "$speech_source" -B "$speech_build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS="$speech_flags" -DCMAKE_CXX_FLAGS="$speech_flags" \
  -DBUILD_SHARED_LIBS=OFF -DSHERPA_ONNX_ENABLE_PYTHON=OFF -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF -DSHERPA_ONNX_ENABLE_C_API=OFF -DSHERPA_ONNX_ENABLE_TTS=OFF \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF -DSHERPA_ONNX_ENABLE_GPU=OFF \
  -DSHERPA_ONNX_ENABLE_WASM=ON -DSHERPA_ONNX_ENABLE_BINARY=OFF \
  -DSHERPA_ONNX_USE_PRE_INSTALLED_ONNXRUNTIME_IF_AVAILABLE=OFF \
  -DSHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY=OFF "$@"
cmake --build "$speech_build" --target pageborne-speech --parallel 4
cp "$speech_build/bin/pageborne-speech."{mjs,wasm} vendor/ensemble-runtime/
cp "$speech_source/LICENSE" vendor/ensemble-runtime/sherpa-onnx-LICENSE
for speech_dep in kaldi_native_fbank kaldi_decoder kaldifst simple-sentencepiece hclust_cpp; do
  cp "$speech_build/_deps/$speech_dep-src/LICENSE" "vendor/ensemble-runtime/$speech_dep-LICENSE"
done
for speech_dep in openfst kissfft; do
  cp "$speech_build/_deps/$speech_dep-src/COPYING" "vendor/ensemble-runtime/$speech_dep-LICENSE"
done
cp vendor/stt/onnxruntime-LICENSE vendor/ensemble-runtime/onnxruntime-LICENSE

cp "$speech_build/_deps/eigen-src/COPYING.MPL2" vendor/ensemble-runtime/eigen-LICENSE
for speech_notice in "$speech_build"/_deps/eigen-src/COPYING.*; do
  cp "$speech_notice" "vendor/ensemble-runtime/eigen-$(basename "$speech_notice")"
done
cp "$speech_build/_deps/kissfft-src/LICENSES/BSD-3-Clause" vendor/ensemble-runtime/kissfft-BSD-3-Clause

speech_emscripten="$speech_root/.state/ensemble/emsdk/upstream/emscripten"
cp "$speech_emscripten/LICENSE" vendor/ensemble-runtime/emscripten-LICENSE
cp "$speech_emscripten/AUTHORS" vendor/ensemble-runtime/emscripten-AUTHORS
cp "$speech_emscripten/system/lib/libc/musl/COPYRIGHT" vendor/ensemble-runtime/musl-COPYRIGHT
cp "$speech_emscripten/system/lib/compiler-rt/LICENSE.TXT" vendor/ensemble-runtime/compiler-rt-LICENSE
cp "$speech_emscripten/system/lib/libcxx/LICENSE.TXT" vendor/ensemble-runtime/libcxx-LICENSE
cp "$speech_emscripten/system/lib/libcxxabi/LICENSE.TXT" vendor/ensemble-runtime/libcxxabi-LICENSE
cp "$speech_emscripten/system/lib/libunwind/LICENSE.TXT" vendor/ensemble-runtime/libunwind-LICENSE
cp "$speech_emscripten/system/lib/llvm-libc/LICENSE.TXT" vendor/ensemble-runtime/llvm-libc-LICENSE
