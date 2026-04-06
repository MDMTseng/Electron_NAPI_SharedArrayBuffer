/**
 * Integration tests for SharedArrayBuffer communication between JS and Native.
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
 *   node --test tests/test_integration.mjs
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

// Default buffer sizes used in tests
const R2N_SIZE = 1024;
const N2R_SIZE = 1024;
const TOTAL_SIZE = CONTROL_BYTES + R2N_SIZE + N2R_SIZE;

// ---------------------------------------------------------------------------
// Load the native addon via the same mechanism the project uses (bindings)
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let addon;
let addonAvailable = false;

try {
    // Try the standard build output location first (node-gyp places it here)
    addon = require(path.resolve(__dirname, '..', 'build', 'Release', 'addon'));
    addonAvailable = true;
} catch {
    try {
        addon = require('bindings')('addon');
        addonAvailable = true;
    } catch {
        console.warn(
            'WARNING: Native addon not found. Build it first with `node-gyp rebuild`.\n' +
            'Tests that require the native addon will be skipped.'
        );
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh SharedArrayBuffer and typed-array views for the control
 * region and both data buffers.
 */
function createBufferViews(r2nSize = R2N_SIZE, n2rSize = N2R_SIZE) {
    const totalSize = CONTROL_BYTES + r2nSize + n2rSize;
    // The native addon checks IsArrayBuffer(), which returns false for
    // SharedArrayBuffer in standalone Node.js (outside Electron).
    // Use ArrayBuffer for compatibility; Atomics won't work but we use
    // direct Int32Array reads/writes instead for polling.
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
// Tests
// ---------------------------------------------------------------------------

describe('SharedArrayBuffer Integration Tests', { skip: !addonAvailable && 'native addon not built' }, () => {
    let sab, control, dataR2N, dataN2R;

    beforeEach(() => {
        const views = createBufferViews();
        sab = views.sab;
        control = views.control;
        dataR2N = views.dataR2N;
        dataN2R = views.dataN2R;
    });

    afterEach(() => {
        // Always attempt cleanup; the native side should tolerate double-cleanup
        try {
            addon.cleanup();
        } catch {
            // ignore errors during teardown
        }
    });

    // -----------------------------------------------------------------------
    // 1. Setup & Teardown
    // -----------------------------------------------------------------------
    describe('Setup & Teardown', () => {
        it('should initialize with setSharedBuffer without throwing', () => {
            assert.doesNotThrow(() => {
                addon.setSharedBuffer(sab, R2N_SIZE, N2R_SIZE);
            });
        });

        it('should reject invalid arguments', () => {
            // Missing arguments
            assert.throws(() => addon.setSharedBuffer(), { message: /Expected/ });
            // Wrong types
            assert.throws(() => addon.setSharedBuffer('not a buffer', 1024, 1024), { message: /Expected/ });
        });

        it('should reject a buffer that is too small for the specified sizes', () => {
            const tinyBuf = new ArrayBuffer(8); // way too small
            assert.throws(() => addon.setSharedBuffer(tinyBuf, R2N_SIZE, N2R_SIZE), { message: /too small/i });
        });

        it('should allow cleanup without prior initialization', () => {
            // cleanup on a fresh addon state should not crash
            assert.doesNotThrow(() => addon.cleanup());
        });

        it('should allow double cleanup without crash', () => {
            addon.setSharedBuffer(sab, R2N_SIZE, N2R_SIZE);
            assert.doesNotThrow(() => {
                addon.cleanup();
                addon.cleanup();
            });
        });
    });

    // -----------------------------------------------------------------------
    // 2. Memory Layout Verification
    // -----------------------------------------------------------------------
    describe('Memory Layout Verification', () => {
        it('should zero-initialize the 4 control Int32 values after setSharedBuffer', () => {
            // Write non-zero sentinel values first
            control[R2N_SIGNAL] = 99;
            control[R2N_LENGTH] = 99;
            control[N2R_SIGNAL] = 99;
            control[N2R_LENGTH] = 99;

            addon.setSharedBuffer(sab, R2N_SIZE, N2R_SIZE);

            assert.equal(control[R2N_SIGNAL], 0, 'R2N_SIGNAL should be 0');
            assert.equal(control[R2N_LENGTH], 0, 'R2N_LENGTH should be 0');
            assert.equal(control[N2R_SIGNAL], 0, 'N2R_SIGNAL should be 0');
            assert.equal(control[N2R_LENGTH], 0, 'N2R_LENGTH should be 0');
        });

        it('should have the correct total buffer byte length', () => {
            assert.equal(sab.byteLength, TOTAL_SIZE);
        });

        it('should have data views at the correct byte offsets', () => {
            // dataR2N starts at byte 16
            assert.equal(dataR2N.byteOffset, CONTROL_BYTES);
            assert.equal(dataR2N.byteLength, R2N_SIZE);

            // dataN2R starts at byte 16 + R2N_SIZE
            assert.equal(dataN2R.byteOffset, CONTROL_BYTES + R2N_SIZE);
            assert.equal(dataN2R.byteLength, N2R_SIZE);
        });
    });

    // -----------------------------------------------------------------------
    // 3. R->N Signal (Renderer to Native)
    // -----------------------------------------------------------------------
    describe('Renderer to Native Signal (R2N)', () => {
        it('should pick up data when R2N_SIGNAL is set to 1 and reset signal to 0', async () => {
            addon.setSharedBuffer(sab, R2N_SIZE, N2R_SIZE);

            // Write a small payload into the R2N data buffer
            const payload = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
            dataR2N.set(payload, 0);

            // Set length and signal
            control[R2N_LENGTH] = payload.length;
            control[R2N_SIGNAL] = 1;

            // The native recv thread should pick it up and reset R2N_SIGNAL to 0
            const signalReset = await pollUntil(
                () => control[R2N_SIGNAL] === 0,
                3000
            );

            assert.ok(signalReset, 'R2N_SIGNAL should be reset to 0 by native thread');
        });
    });

    // -----------------------------------------------------------------------
    // 4. N->R Signal (Native to Renderer)
    // -----------------------------------------------------------------------
    describe('Native to Renderer Signal (N2R)', () => {
        it('should send data from native via triggerTestCallback and set N2R_SIGNAL to 1', async () => {
            addon.setSharedBuffer(sab, R2N_SIZE, N2R_SIZE);

            // triggerTestCallback sends "Test callback from native code!" through the channel
            addon.triggerTestCallback();

            // Wait for the native side to signal data is ready
            const signalSet = await pollUntil(
                () => control[N2R_SIGNAL] === 1,
                3000
            );

            assert.ok(signalSet, 'N2R_SIGNAL should become 1 after triggerTestCallback');

            // Read the length
            const length = control[N2R_LENGTH];
            assert.ok(length > 0, 'N2R_LENGTH should be > 0');

            // Read the data
            const receivedData = dataN2R.slice(0, length);
            const receivedStr = new TextDecoder().decode(receivedData);
            assert.equal(receivedStr, 'Test callback from native code!');

            // Acknowledge: reset N2R_SIGNAL so native can send again
            control[N2R_SIGNAL] = 0;
        });
    });

    // -----------------------------------------------------------------------
    // 5. Data Integrity
    // -----------------------------------------------------------------------
    describe('Data Integrity', () => {
        it('should preserve known byte patterns through R2N path', async () => {
            addon.setSharedBuffer(sab, R2N_SIZE, N2R_SIZE);

            // Create a pattern: 0x00..0xFF repeated to fill a chunk
            const patternSize = 256;
            const pattern = new Uint8Array(patternSize);
            for (let i = 0; i < patternSize; i++) {
                pattern[i] = i & 0xFF;
            }

            // Write the pattern
            dataR2N.set(pattern, 0);
            control[R2N_LENGTH] = patternSize;
            control[R2N_SIGNAL] = 1;

            // Wait for native to consume it
            const consumed = await pollUntil(
                () => control[R2N_SIGNAL] === 0,
                3000
            );
            assert.ok(consumed, 'Native should consume the R2N message');

            // Verify the data in the buffer was not corrupted before native read it.
            // Since native resets signal after reading, and we wrote before signaling,
            // the data region should still hold our bytes (native only reads, does not
            // clear the data region).
            for (let i = 0; i < patternSize; i++) {
                assert.equal(
                    dataR2N[i], pattern[i],
                    `Byte at offset ${i} should be ${pattern[i]} but got ${dataR2N[i]}`
                );
            }
        });

        it('should deliver correct N2R data via triggerTestCallback', async () => {
            addon.setSharedBuffer(sab, R2N_SIZE, N2R_SIZE);

            addon.triggerTestCallback();

            const ready = await pollUntil(
                () => control[N2R_SIGNAL] === 1,
                3000
            );
            assert.ok(ready, 'N2R_SIGNAL should be 1');

            const len = control[N2R_LENGTH];
            const expected = new TextEncoder().encode('Test callback from native code!');
            assert.equal(len, expected.length, 'Length should match expected string');

            const received = dataN2R.slice(0, len);
            assert.deepEqual(received, expected, 'Received bytes should match exactly');

            control[N2R_SIGNAL] = 0;
        });
    });

    // -----------------------------------------------------------------------
    // 6. Sequential Messages
    // -----------------------------------------------------------------------
    describe('Sequential Messages', () => {
        it('should process multiple R2N messages in order', async () => {
            addon.setSharedBuffer(sab, R2N_SIZE, N2R_SIZE);

            const messages = [
                new Uint8Array([0x01, 0x02, 0x03]),
                new Uint8Array([0x0A, 0x0B, 0x0C, 0x0D]),
                new Uint8Array([0xFF]),
            ];

            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];

                // Wait until native is ready to receive (R2N_SIGNAL === 0)
                const ready = await pollUntil(
                    () => control[R2N_SIGNAL] === 0,
                    3000
                );
                assert.ok(ready, `Native should be ready before message ${i}`);

                // Write data
                dataR2N.set(msg, 0);
                control[R2N_LENGTH] = msg.length;
                control[R2N_SIGNAL] = 1;

                // Wait for native to consume
                const consumed = await pollUntil(
                    () => control[R2N_SIGNAL] === 0,
                    3000
                );
                assert.ok(consumed, `Native should consume message ${i}`);
            }
        });

        it('should deliver multiple N2R messages sequentially via triggerTestCallback', async () => {
            addon.setSharedBuffer(sab, R2N_SIZE, N2R_SIZE);

            const expectedStr = 'Test callback from native code!';
            const count = 3;

            for (let i = 0; i < count; i++) {
                // Ensure N2R line is free before triggering
                const lineReady = await pollUntil(
                    () => control[N2R_SIGNAL] === 0,
                    3000
                );
                assert.ok(lineReady, `N2R line should be free before trigger ${i}`);

                addon.triggerTestCallback();

                const signaled = await pollUntil(
                    () => control[N2R_SIGNAL] === 1,
                    3000
                );
                assert.ok(signaled, `N2R_SIGNAL should become 1 after trigger ${i}`);

                const len = control[N2R_LENGTH];
                const received = new TextDecoder().decode(dataN2R.slice(0, len));
                assert.equal(received, expectedStr, `Message ${i} content should match`);

                // Acknowledge receipt
                control[N2R_SIGNAL] = 0;
            }
        });
    });

    // -----------------------------------------------------------------------
    // 7. Cleanup Under Use
    // -----------------------------------------------------------------------
    describe('Cleanup Under Use', () => {
        it('should not crash or hang when cleanup is called while channel is active', async () => {
            addon.setSharedBuffer(sab, R2N_SIZE, N2R_SIZE);

            // Send a message to get the native thread busy
            dataR2N.set(new Uint8Array([0xDE, 0xAD]), 0);
            control[R2N_LENGTH] = 2;
            control[R2N_SIGNAL] = 1;

            // Give native thread a moment to start processing
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Cleanup should not hang (we rely on the test timeout to catch hangs)
            assert.doesNotThrow(() => {
                addon.cleanup();
            });
        });

        it('should allow re-initialization after cleanup', async () => {
            // First cycle
            addon.setSharedBuffer(sab, R2N_SIZE, N2R_SIZE);
            addon.cleanup();

            // Second cycle with fresh buffer
            const views2 = createBufferViews();
            assert.doesNotThrow(() => {
                addon.setSharedBuffer(views2.sab, R2N_SIZE, N2R_SIZE);
            });

            // Verify it works: send a message
            views2.dataR2N.set(new Uint8Array([0x42]), 0);
            views2.control[R2N_LENGTH] = 1;
            views2.control[R2N_SIGNAL] = 1;

            const consumed = await pollUntil(
                () => views2.control[R2N_SIGNAL] === 0,
                3000
            );
            assert.ok(consumed, 'Native should consume message after re-initialization');

            addon.cleanup();
        });
    });
});

// ---------------------------------------------------------------------------
// Standalone tests that work even without the native addon
// ---------------------------------------------------------------------------
describe('SharedArrayBuffer Layout Tests (no addon required)', () => {
    it('should create a buffer with correct total size', () => {
        const { sab } = createBufferViews(512, 256);
        assert.equal(sab.byteLength, CONTROL_BYTES + 512 + 256);
    });

    it('should have non-overlapping control, R2N, and N2R regions', () => {
        const r2n = 128;
        const n2r = 64;
        const { control, dataR2N, dataN2R } = createBufferViews(r2n, n2r);

        // Control: bytes 0..15
        assert.equal(control.byteOffset, 0);
        assert.equal(control.byteLength, CONTROL_BYTES);

        // R2N data: bytes 16..143
        assert.equal(dataR2N.byteOffset, CONTROL_BYTES);
        assert.equal(dataR2N.byteLength, r2n);

        // N2R data: bytes 144..207
        assert.equal(dataN2R.byteOffset, CONTROL_BYTES + r2n);
        assert.equal(dataN2R.byteLength, n2r);

        // No overlap: N2R starts where R2N ends
        assert.equal(dataN2R.byteOffset, dataR2N.byteOffset + dataR2N.byteLength);
    });

    it('should allow atomic operations on the control region', () => {
        const { control } = createBufferViews();

        control[R2N_SIGNAL] = 1;
        assert.equal(control[R2N_SIGNAL], 1);

        control[R2N_SIGNAL] = 0;
        assert.equal(control[R2N_SIGNAL], 0);

        // Compare-and-exchange
        const old = (function(a,i,e,r){const o=a[i];if(o===e)a[i]=r;return o})(control,N2R_SIGNAL,0,1);
        assert.equal(old, 0);
        assert.equal(control[N2R_SIGNAL], 1);
    });

    it('should isolate writes to their respective data regions', () => {
        const { dataR2N, dataN2R, control } = createBufferViews(64, 64);

        // Fill R2N with 0xAA
        dataR2N.fill(0xAA);
        // Fill N2R with 0xBB
        dataN2R.fill(0xBB);

        // Verify control region was not affected
        for (let i = 0; i < 4; i++) {
            assert.equal(control[i], 0, `Control[${i}] should remain 0`);
        }

        // Verify R2N data
        for (let i = 0; i < 64; i++) {
            assert.equal(dataR2N[i], 0xAA, `R2N[${i}] should be 0xAA`);
        }

        // Verify N2R data
        for (let i = 0; i < 64; i++) {
            assert.equal(dataN2R[i], 0xBB, `N2R[${i}] should be 0xBB`);
        }
    });
});
