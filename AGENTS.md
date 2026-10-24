# Working in Browser STT

Read HANDOFF.md, README.md and VALIDATION.md for current scope and evidence.

- The release product is a standalone browser speech engine. Pageborne consumes a pinned Git revision and builds workers during npm installation; no application tarball is maintained.
- Preserve the production Conformer/Zipformer/Moonshine ensemble and the existing Tiny/optional-Whisper API. Do not change model identity or verification revisions for documentation/build-only work.
- Audio/LLM correction research lives separately on research/audio-llm-evaluations. Do not merge it into release work or resume its experiments without a user request.
- Distinguish real model inference, mocked integration tests, native execution, browser execution and physical phone measurements.
- Use focused checks: npm test, npm run test:types and build/package checks for code or packaging; link/path checks for documentation. Avoid rerunning model benchmarks unless behavior or an unresolved concern warrants it.
- Keep HANDOFF.md and VALIDATION.md current. Do not stop unrelated services, reset GPUs or restart the desktop for a benchmark.
