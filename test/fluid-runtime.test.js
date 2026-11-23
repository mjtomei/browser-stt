import test from 'node:test';
import assert from 'node:assert/strict';
import { fluidCpuThreads } from '../src/fluid-runtime.js';

test('Mini threads require isolation and shared memory and are bounded by available cores', () => {
  assert.equal(fluidCpuThreads({ isolated: true, shared: true, concurrency: 4 }), 4);
  assert.equal(fluidCpuThreads({ isolated: true, shared: true, concurrency: 32 }), 4);
  assert.equal(fluidCpuThreads({ isolated: true, shared: true, concurrency: 2 }), 2);
  for (const concurrency of [null, NaN, 0, -1]) assert.equal(fluidCpuThreads({ isolated: true, shared: true, concurrency }), 1);
  assert.equal(fluidCpuThreads({ isolated: false, shared: true, concurrency: 8 }), 1);
  assert.equal(fluidCpuThreads({ isolated: true, shared: false, concurrency: 8 }), 1);
});

test('Mini verification follows the available thread configuration', async () => {
  const { ensembleVerificationKey } = await import('../src/ensemble-verification.js');
  const descriptors = Object.fromEntries(['crossOriginIsolated', 'navigator'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const model = { id: 'fluid-mini', verificationRuntime: 'test', directory: 'test', files: [] };
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hardwareConcurrency: 4 } });
    Object.defineProperty(globalThis, 'crossOriginIsolated', { configurable: true, value: false });
    const single = ensembleVerificationKey(model, 'same-device');
    Object.defineProperty(globalThis, 'crossOriginIsolated', { configurable: true, value: true });
    assert.notEqual(ensembleVerificationKey(model, 'same-device'), single);
  } finally {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
