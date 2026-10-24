# Runtime sources and notices

The bundled `pageborne-speech.wasm` is built by `scripts/build-ensemble-wasm.sh`
from the adapter in `scripts/wasm/` and [sherpa-onnx v1.13.8](https://github.com/k2-fsa/sherpa-onnx/tree/11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf),
revision `11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf`, with Emscripten 4.0.23.
The script adds the adapter target to upstream CMake; upstream dependency
versions and archive hashes are pinned in that revision's `cmake/` directory.

## Eigen source availability

This binary includes unmodified Eigen 5.0.1 headers under MPL-2.0, with the
additional upstream notices in `eigen-COPYING.*`. The complete source is
available without charge at:

https://gitlab.com/libeigen/eigen/-/archive/5.0.1/eigen-5.0.1.tar.gz

SHA-256: `e9c326dc8c05cd1e044c71f30f1b2e34a6161a3b6ecf445d56b53ff1669e3dec`.
See `eigen-LICENSE` for MPL-2.0. Preserve this source-availability notice with
binary distributions. Changes to covered Eigen files must remain available
under MPL-2.0; separate application files are not relicensed by this notice.

## Other components

The accompanying files retain the upstream licenses for Sherpa, ONNX Runtime,
kaldi-native-fbank, kaldi-decoder, kaldifst, OpenFst, simple-sentencepiece,
hclust_cpp and KissFFT. `kissfft-LICENSE` supplies the copyright notice and
`kissfft-BSD-3-Clause` supplies the full terms it references.

The runtime contains no model weights. Model download identities are in
`vendor/stt/ensemble-models.json`; Conformer and Zipformer distributions are
Apache-2.0, and Moonshine is MIT. The speech asset plugin copies this directory,
including these notices, alongside the binary in consuming app builds.

Emscripten's generated glue and standard libraries retain the accompanying
Emscripten MIT/NCSA, musl MIT/BSD, and LLVM Apache-2.0-with-exception notices.
Their source is in https://github.com/emscripten-core/emscripten/tree/4.0.23 .
