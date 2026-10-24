// A separate CPU artifact lets consumers omit correction downloads entirely.
// Source imports and the normal worker retain the full package API.
export const correctionsAvailable = typeof __STT_CPU_ONLY__ === 'undefined' || !__STT_CPU_ONLY__;
