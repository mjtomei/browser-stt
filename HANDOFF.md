# Browser STT release handoff

The production ensemble and version 0.1.17 source are published as a standalone repository. Pageborne imports this source through a pinned Git dependency; npm prepare builds full/CPU workers. The engineering report moved from Pageborne into README.md, with recorded data under benchmarks/. Runtime/model/cache identities are unchanged.

In the original development repository, the separate audio/LLM research has been saved on research/audio-llm-evaluations, including its previously uncommitted experiments and reports. It is excluded from this publication snapshot. Preserve that branch; do not resume those experiments without a user request. The rejected punctuation trial remains historical evidence, not part of inference.

README.md is the product and evaluation entry point. docs/API.md documents both ensemble and legacy APIs. docs/REPRODUCING.md covers build prerequisites and benchmark commands. VALIDATION.md records the publication checks and the limits of historical results. The public repository starts with a separate source snapshot, without the private development history. The bundled Sherpa runtime was rebuilt with compiler-path remapping and checked with actual models in Chromium and WebKit; recognizer configuration and model/cache identity remain unchanged.
