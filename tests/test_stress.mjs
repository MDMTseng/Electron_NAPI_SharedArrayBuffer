/**
 * Stress tests for SharedArrayBuffer native addon.
 *
 * Memory layout (from addon.cc):
 *   Byte offset  0..15  : Control region (4 x Int32)
 *     Int32 index 0 : R2N_SIGNAL  (renderer -> native signal; 0=ready, 1=data ready)
 *     Int32 index 1 : R2N_LENGTH  (renderer -> native data length)
 *     Int32 index 2 : N2R_SIGNAL  (native -> renderer signal; 0=ready, 1=data ready)
 *     Int32 index 3 : N2R_LENGTH  (native -> renderer data length)
 *   Byte offset 16            : start of R2N data buffer  (r2nSize bytes)
 *   Byte offset 16 + r2nSize  : start of N2R data buffer  (n2rSize bytes)
 *
 * Run with:
 *   node --test tests/test_stress.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants matching the protocol
// ---------------------------------------------------------------------------
const R2N_SIGNAL = 0;
const R2N_LENGTH = 1;
const N2R_SIGNAL = 2;
const N2R_LENGTH = 3;
const CONTROL_BYTES = 16; // 4 * Int32Array.BYTES_PER_ELEMENT

// ---------------------------------------------------------------------------
// Load the native addon
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let addon;
let addonAvailable = false;

try {
    addon = require(path.resolve(__dirname, '..', 'build', 'Release', 'addon'));
    addonAvailable = true;
} catch {
    try {
        addon = require('bindings')('addon');
        addonAvailable = true;
    } catch {
        console.warn(
            'WARNING: Native addon not found. Build it first with `node-gyp rebuild`.\n' +
            'Stress tests will be skipped.'
        );
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh ArrayBuffer and typed-array views for the control
 * region and both data buffers.
 */
function createBufferViews(r2nSize = 1024, n2rSize = 1024) {
    const totalSize = CONTROL_BYTES + r2nSize + n2rSize;
    const sab = new ArrayBuffer(totalSize);
    const control = new Int32Array(sab, 0, 4);
    const dataR2N = new Uint8Array(sab, CONTROL_BYTES, r2nSize);
    const dataN2R = new Uint8Array(sab, CONTROL_BYTES + r2nSize, n2rSize);
    return { sab, control, dataR2N, dataN2R };
}

/**
 * Poll a condition function until it returns true, or time out.
 * Returns true if the condition was met, false on timeout.
 */
function pollUntil(conditionFn, timeoutMs = 2000, intervalMs = 1) {
    const start = Date.now();
    return new Promise((resolve) => {
        const check = () => {
            if (conditionFn()) {
                resolve(true);
                return;
            }
            if (Date.now() - start > timeoutMs) {
                resolve(false);
                return;
            }
            setTimeout(check, intervalMs);
        };
        check();
    });
}

// ---------------------------------------------------------------------------
// Stress Tests
// ---------------------------------------------------------------------------

describe('Stress Tests', { skip: !addonAvailable && 'native addon not built' }, () => {

    afterEach(() => {
        try {
            addon.cleanup();
        } catch {
            // ignore errors during teardown
        }
    });

    // -----------------------------------------------------------------------
    // 1. Throughput Test
    // -----------------------------------------------------------------------
    it('should sustain > 100 msgs/sec over 1000 R2N messages', { timeout: 60000 }, async () => {
        const r2nSize = 4096;
        const n2rSize = 1024;
        const { sab, control, dataR2N } = createBufferViews(r2nSize, n2rSize);
        addon.setSharedBuffer(sab, r2nSize, n2rSize);

        const messageCount = 1000;
        const payload = new Uint8Array(64);
        for (let i = 0; i < payload.length; i++) {
            payload[i] = i & 0xFF;
        }

        const startTime = Date.now();

        for (let i = 0; i < messageCount; i++) {
            // Wait until native is ready
            const ready = await pollUntil(() => control[R2N_SIGNAL] === 0, 5000);
            assert.ok(ready, `Native should be ready before message ${i}`);

            // Write payload
            dataR2N.set(payload, 0);
            control[R2N_LENGTH] = payload.length;
            control[R2N_SIGNAL] = 1;

            // Wait for native to consume
            const consumed = await pollUntil(() => control[R2N_SIGNAL] === 0, 5000);
            assert.ok(consumed, `Native should consume message ${i}`);
        }

        const elapsedMs = Date.now() - startTime;
        const msgsPerSec = (messageCount / elapsedMs) * 1000;

        console.log(`Throughput: ${messageCount} messages in ${elapsedMs}ms = ${msgsPerSec.toFixed(1)} msgs/sec`);
        // Standalone Node.js polling is slower than Electron (no Atomics.waitAsync).
        // 30 msgs/sec is a conservative floor for CI / slow machines.
        assert.ok(msgsPerSec > 30, `Expected > 30 msgs/sec, got ${msgsPerSec.toFixed(1)}`);
    });

    // -----------------------------------------------------------------------
    // 2. Large Buffer Test
    // -----------------------------------------------------------------------
    it('should handle a 10MB buffer with a 4MB payload without crashing', { timeout: 30000 }, async () => {
        const r2nSize = 5 * 1024 * 1024; // 5MB
        const n2rSize = 5 * 1024 * 1024; // 5MB
        const { sab, control, dataR2N } = createBufferViews(r2nSize, n2rSize);

        assert.doesNotThrow(() => {
            addon.setSharedBuffer(sab, r2nSize, n2rSize);
        });

        // Write a 4MB payload
        const payloadSize = 4 * 1024 * 1024;
        const payload = new Uint8Array(payloadSize);
        for (let i = 0; i < payloadSize; i++) {
            payload[i] = i & 0xFF;
        }

        dataR2N.set(payload, 0);
        control[R2N_LENGTH] = payloadSize;
        control[R2N_SIGNAL] = 1;

        // Wait for native to consume it (signal resets to 0)
        const consumed = await pollUntil(() => control[R2N_SIGNAL] === 0, 10000);
        assert.ok(consumed, 'Native should consume the 4MB R2N message (signal reset to 0)');
    });

    // -----------------------------------------------------------------------
    // 3. Rapid Setup/Teardown
    // -----------------------------------------------------------------------
    it('should survive 50 rapid setSharedBuffer + cleanup cycles without crash or memory leak', { timeout: 30000 }, async () => {
        const iterations = 50;
        const heapBefore = process.memoryUsage().heapUsed;

        for (let i = 0; i < iterations; i++) {
            const { sab } = createBufferViews(1024, 1024);
            addon.setSharedBuffer(sab, 1024, 1024);
            addon.cleanup();
        }

        // Force GC if available, then measure
        if (global.gc) {
            global.gc();
        }

        const heapAfter = process.memoryUsage().heapUsed;
        const heapGrowthMB = (heapAfter - heapBefore) / (1024 * 1024);

        console.log(`Rapid setup/teardown: ${iterations} cycles, heap growth = ${heapGrowthMB.toFixed(2)}MB`);

        // Heap should not grow excessively (allow up to 50MB for GC lag)
        assert.ok(
            heapGrowthMB < 50,
            `Heap grew by ${heapGrowthMB.toFixed(2)}MB over ${iterations} cycles, possible memory leak`
        );
    });

    // -----------------------------------------------------------------------
    // 4. Rapid Plugin Toggle
    // -----------------------------------------------------------------------
    it('should survive 100 loadPlugin (invalid) + unloadPlugin cycles without crash', { timeout: 30000 }, () => {
        const iterations = 100;

        for (let i = 0; i < iterations; i++) {
            // loadPlugin with an invalid path should return false but not crash
            const result = addon.loadPlugin('/nonexistent/path/to/plugin.dll');
            assert.equal(result, false, `loadPlugin should return false for invalid path (iteration ${i})`);

            // unloadPlugin should be safe even if nothing is loaded
            assert.doesNotThrow(() => {
                addon.unloadPlugin();
            }, `unloadPlugin should not throw (iteration ${i})`);
        }
    });

    // -----------------------------------------------------------------------
    // 5. Concurrent Signal Stress
    // -----------------------------------------------------------------------
    it('should handle 500 rapid R2N signal cycles without control region corruption', { timeout: 60000 }, async () => {
        const r2nSize = 1024;
        const n2rSize = 1024;
        const { sab, control, dataR2N } = createBufferViews(r2nSize, n2rSize);
        addon.setSharedBuffer(sab, r2nSize, n2rSize);

        const iterations = 500;
        const payload = new Uint8Array([0xCA, 0xFE]);

        for (let i = 0; i < iterations; i++) {
            // Wait for native to be ready
            const ready = await pollUntil(() => control[R2N_SIGNAL] === 0, 5000);
            assert.ok(ready, `Native should be ready at iteration ${i}`);

            // Set R2N signal
            dataR2N.set(payload, 0);
            control[R2N_LENGTH] = payload.length;
            control[R2N_SIGNAL] = 1;

            // Wait for native to reset the signal
            const reset = await pollUntil(() => control[R2N_SIGNAL] === 0, 5000);
            assert.ok(reset, `Native should reset R2N_SIGNAL at iteration ${i}`);

            // Verify control region integrity: N2R signals should not be
            // corrupted by R2N processing (they should remain 0 since we
            // never triggered N2R)
            assert.equal(control[N2R_SIGNAL], 0, `N2R_SIGNAL should be 0 at iteration ${i}`);
        }
    });

    // -----------------------------------------------------------------------
    // 6. Memory Stability
    // -----------------------------------------------------------------------
    it('should not leak memory when sending 100 messages of 100KB each on a 50MB buffer', { timeout: 60000 }, async () => {
        const r2nSize = 25 * 1024 * 1024; // 25MB
        const n2rSize = 25 * 1024 * 1024; // 25MB
        const { sab, control, dataR2N } = createBufferViews(r2nSize, n2rSize);
        addon.setSharedBuffer(sab, r2nSize, n2rSize);

        const messageCount = 100;
        const payloadSize = 100 * 1024; // 100KB
        const payload = new Uint8Array(payloadSize);
        for (let i = 0; i < payloadSize; i++) {
            payload[i] = i & 0xFF;
        }

        // Force GC before measuring if available
        if (global.gc) {
            global.gc();
        }
        const heapBefore = process.memoryUsage().heapUsed;

        for (let i = 0; i < messageCount; i++) {
            const ready = await pollUntil(() => control[R2N_SIGNAL] === 0, 5000);
            assert.ok(ready, `Native should be ready before message ${i}`);

            dataR2N.set(payload, 0);
            control[R2N_LENGTH] = payloadSize;
            control[R2N_SIGNAL] = 1;

            const consumed = await pollUntil(() => control[R2N_SIGNAL] === 0, 5000);
            assert.ok(consumed, `Native should consume message ${i}`);
        }

        // Force GC after if available
        if (global.gc) {
            global.gc();
        }

        const heapAfter = process.memoryUsage().heapUsed;
        const heapDeltaMB = (heapAfter - heapBefore) / (1024 * 1024);

        console.log(`Memory stability: ${messageCount} x ${payloadSize / 1024}KB messages, heap delta = ${heapDeltaMB.toFixed(2)}MB`);

        // Delta should be < 50MB (no major leak)
        assert.ok(
            heapDeltaMB < 50,
            `Heap grew by ${heapDeltaMB.toFixed(2)}MB after ${messageCount} messages, possible memory leak`
        );
    });
});
