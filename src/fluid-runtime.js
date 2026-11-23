// Shared WASM memory is only available in isolated browser contexts. Keep the
// single-thread path for embedded hosts, and leave cores free on larger CPUs.
export function fluidCpuThreads({ isolated = globalThis.crossOriginIsolated,
  shared = typeof SharedArrayBuffer === 'function', concurrency = globalThis.navigator?.hardwareConcurrency } = {}) {
  return isolated && shared && Number.isFinite(concurrency) ? Math.max(1, Math.min(4, Math.floor(concurrency))) : 1;
}
