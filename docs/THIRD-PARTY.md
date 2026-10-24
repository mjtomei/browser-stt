# Third-party components

Reviewed 2026-10-24 against Browser STT 0.1.17, its lockfile, vendored runtime,
model manifests and browser build inputs. The inventory separates browser
artifacts from optional native packages installed by npm.

| Component | Terms | Distribution obligations |
| --- | --- | --- |
| Eigen 5.0.1 inside Sherpa WASM | MPL-2.0, plus upstream compatible notices | Preserve notices and provide the covered source. Unmodified source URL and checksum are shipped in `vendor/ensemble-runtime/SOURCES.md`. Changes to covered files remain MPL. |
| Sherpa, kaldi components, OpenFst, simple-sentencepiece | Apache-2.0 | Preserve upstream license/notices and identify modifications. Adapter and build recipe are included. |
| ONNX Runtime, Moonshine/Whisper models | MIT | Preserve copyright and permission notices. |
| Conformer and Zipformer model distributions | Apache-2.0 | Preserve notices with downloaded models. Immutable download revisions/hashes are recorded in the model manifest. |
| Transformers.js, Jinja, Tokenizers | Apache-2.0 | Preserve notices. `NOTICE` identifies the Transformers session-loader adaptation. |
| hclust_cpp, KissFFT | BSD-3-Clause | Preserve copyright, full terms and disclaimer. |
| LibriSpeech fixtures and excerpts | CC BY 4.0 | Attribute dataset/authors, link the license and describe conversions. See `vendor/stt/librispeech-LICENSE.txt` and fixture manifests. |
| sharp/libvips (npm transitive native dependency) | Apache-2.0 / LGPL-3.0-or-later | Not included in browser workers or source/package exports. A distributor shipping native dependencies must preserve their notices and meet library source/relinking obligations. |

MPL is file-level: it does not require separate application files to use MPL,
including when linked into a larger executable. See the [Mozilla FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/),
particularly the executable-distribution/source-availability and larger-work
answers. Keep the Eigen source notice with the WASM, not only in this repository.

The asset plugin emits notices with consumer builds. Worker builds also emit
`licenses/bundled/manifest.json`, identifying actual bundled npm modules and
copying their available license/NOTICE files. Builds reject accidental inclusion
of native sharp/libvips. Lockfile entries alone do not establish browser inclusion.
Sharp's [licensing notes](https://sharp.pixelplumbing.com/install/#licensing)
and the [LGPL text](https://www.gnu.org/licenses/lgpl-3.0.html) describe its native
library distribution requirements.

No GPL/AGPL dependency was identified in the shipped Browser STT browser runtime.
The MPL requirement applies to covered Eigen source, not the separately authored
JavaScript or adapter files. Model licenses and dataset attribution remain separate
from code licenses. Recheck this inventory when versions or bundled assets change.

The separate audio/LLM correction research and HyPoradise tools are retained on
`research/audio-llm-evaluations`; their downloaded datasets and experimental
models are not part of this release or its runtime.
