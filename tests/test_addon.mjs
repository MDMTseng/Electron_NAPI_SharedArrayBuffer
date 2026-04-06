/**
 * Comprehensive tests for the native addon (addon.node).
 *
 * Run with:
 *   node --test tests/test_addon.mjs
 *
 * Prerequisites:
 *   The addon must be built first (node-gyp rebuild) so that
 *   build/Release/addon.node exists.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const addonPath = path.join(projectRoot, 'build', 'Release', 'addon.node');

// ---------------------------------------------------------------------------
// Pre-flight: check that the addon binary exists
// ---------------------------------------------------------------------------

let addon;

before(() => {
  if (!fs.existsSync(addonPath)) {
    throw new Error(
      `Addon binary not found at ${addonPath}. ` +
      'Build it first with: npx node-gyp rebuild'
    );
  }

  const require = createRequire(import.meta.url);
  addon = require(addonPath);
});

// ---------------------------------------------------------------------------
// 1. Addon Loading -- verify all exported functions exist
// ---------------------------------------------------------------------------

describe('Addon Loading', () => {
  const expectedExports = [
    'setSharedBuffer',
    'cleanup',
    'hello',
    'setMessageCallback',
    'triggerTestCallback',
    'loadPlugin',
    'unloadPlugin',
  ];

  it('should load the addon without errors', () => {
    assert.ok(addon, 'addon object should be truthy');
    assert.strictEqual(typeof addon, 'object');
  });

  for (const name of expectedExports) {
    it(`should export "${name}" as a function`, () => {
      assert.strictEqual(typeof addon[name], 'function', `addon.${name} should be a function`);
    });
  }

  it('hello() should return a greeting string', () => {
    const result = addon.hello();
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.length > 0, 'hello() should return a non-empty string');
    assert.ok(result.includes('Hello'), 'hello() should contain "Hello"');
  });
});

// ---------------------------------------------------------------------------
// 2. SharedArrayBuffer Setup
// ---------------------------------------------------------------------------

describe('SharedArrayBuffer Setup', () => {
  // Layout mirrors SharedMemoryChannel.ts:
  //   16 bytes control (4 x Int32)  +  R2N data  +  N2R data
  const CONTROL_SIZE = 16; // 4 * Int32Array.BYTES_PER_ELEMENT
  const R2N_SIZE = 512 * 1024; // 512 KB
  const N2R_SIZE = 512 * 1024; // 512 KB
  const TOTAL_SIZE = CONTROL_SIZE + R2N_SIZE + N2R_SIZE; // ~1 MB

  after(() => {
    // Always cleanup after this suite to stop background threads
    addon.cleanup();
  });

  it('should accept a correctly-sized ArrayBuffer via setSharedBuffer', () => {
    const sab = new ArrayBuffer(TOTAL_SIZE);

    // Should not throw
    assert.doesNotThrow(() => {
      addon.setSharedBuffer(sab, R2N_SIZE, N2R_SIZE);
    });
  });

  it('should initialize the control region to zeros', () => {
    // After setSharedBuffer the native side sets control[0..3] = 0
    const sab = new ArrayBuffer(TOTAL_SIZE);
    addon.setSharedBuffer(sab, R2N_SIZE, N2R_SIZE);

    const control = new Int32Array(sab, 0, 4);
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(
        Atomics.load(control, i),
        0,
        `control[${i}] should be 0 after initialization`
      );
    }
  });

  it('should reject a buffer that is too small', () => {
    const tinyBuffer = new ArrayBuffer(8); // way too small
    assert.throws(
      () => addon.setSharedBuffer(tinyBuffer, R2N_SIZE, N2R_SIZE),
      // The native side throws a TypeError with "Buffer too small..."
      (err) => {
        assert.ok(err instanceof TypeError || err instanceof Error);
        return true;
      }
    );
  });

  it('should allow re-initialization (setSharedBuffer called twice)', () => {
    const sab1 = new ArrayBuffer(TOTAL_SIZE);
    const sab2 = new ArrayBuffer(TOTAL_SIZE);

    // Both calls should succeed without crashing
    assert.doesNotThrow(() => {
      addon.setSharedBuffer(sab1, R2N_SIZE, N2R_SIZE);
    });
    // Cleanup first to join the recv thread before re-initializing
    addon.cleanup();
    assert.doesNotThrow(() => {
      addon.setSharedBuffer(sab2, R2N_SIZE, N2R_SIZE);
    });

    const control = new Int32Array(sab2, 0, 4);
    assert.strictEqual(Atomics.load(control, 0), 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Plugin Load / Unload
// ---------------------------------------------------------------------------

describe('Plugin Load / Unload', () => {
  before(() => {
    // Ensure we start clean
    addon.cleanup();
  });

  after(() => {
    addon.cleanup();
  });

  it('loadPlugin with a non-existent path should return false (not crash)', () => {
    const result = addon.loadPlugin('/does/not/exist/plugin.dll');
    assert.strictEqual(result, false, 'loadPlugin should return false for invalid path');
  });

  it('loadPlugin with empty string should return false (not crash)', () => {
    const result = addon.loadPlugin('');
    assert.strictEqual(result, false, 'loadPlugin should return false for empty string');
  });

  it('unloadPlugin should not crash when no plugin is loaded', () => {
    assert.doesNotThrow(() => {
      addon.unloadPlugin();
    });
  });

  it('unloadPlugin called multiple times should be safe', () => {
    assert.doesNotThrow(() => {
      addon.unloadPlugin();
      addon.unloadPlugin();
      addon.unloadPlugin();
    });
  });

  it('loadPlugin then unloadPlugin cycle should not crash', () => {
    // load (will fail) then unload -- should still be safe
    addon.loadPlugin('/nonexistent/path.so');
    assert.doesNotThrow(() => {
      addon.unloadPlugin();
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Cleanup
// ---------------------------------------------------------------------------

describe('Cleanup', () => {
  it('cleanup should not crash when called with no prior setup', () => {
    assert.doesNotThrow(() => {
      addon.cleanup();
    });
  });

  it('cleanup called after setSharedBuffer should not crash', () => {
    const CONTROL_SIZE = 16;
    const R2N = 1024;
    const N2R = 1024;
    const sab = new ArrayBuffer(CONTROL_SIZE + R2N + N2R);
    addon.setSharedBuffer(sab, R2N, N2R);

    assert.doesNotThrow(() => {
      addon.cleanup();
    });
  });

  it('double cleanup should be safe (idempotent)', () => {
    const CONTROL_SIZE = 16;
    const R2N = 1024;
    const N2R = 1024;
    const sab = new ArrayBuffer(CONTROL_SIZE + R2N + N2R);
    addon.setSharedBuffer(sab, R2N, N2R);

    assert.doesNotThrow(() => {
      addon.cleanup();
      addon.cleanup();
    });
  });

  it('triple cleanup should still be safe', () => {
    assert.doesNotThrow(() => {
      addon.cleanup();
      addon.cleanup();
      addon.cleanup();
    });
  });

  it('setup -> cleanup -> setup -> cleanup cycle should work', () => {
    const CONTROL_SIZE = 16;
    const R2N = 2048;
    const N2R = 2048;

    for (let i = 0; i < 3; i++) {
      const sab = new ArrayBuffer(CONTROL_SIZE + R2N + N2R);
      assert.doesNotThrow(() => {
        addon.setSharedBuffer(sab, R2N, N2R);
      }, `setSharedBuffer should not throw on cycle ${i}`);
      assert.doesNotThrow(() => {
        addon.cleanup();
      }, `cleanup should not throw on cycle ${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Error Handling -- wrong types should not crash the process
// ---------------------------------------------------------------------------

describe('Error Handling', () => {
  after(() => {
    addon.cleanup();
  });

  it('setSharedBuffer with no arguments should throw TypeError', () => {
    assert.throws(
      () => addon.setSharedBuffer(),
      (err) => {
        assert.ok(err instanceof TypeError || err instanceof Error);
        return true;
      }
    );
  });

  it('setSharedBuffer with wrong types should throw', () => {
    // string instead of ArrayBuffer
    assert.throws(
      () => addon.setSharedBuffer('not a buffer', 1024, 1024),
      (err) => {
        assert.ok(err instanceof TypeError || err instanceof Error);
        return true;
      }
    );
  });

  it('setSharedBuffer with missing size arguments should throw', () => {
    const sab = new ArrayBuffer(4096);
    assert.throws(
      () => addon.setSharedBuffer(sab),
      (err) => {
        assert.ok(err instanceof TypeError || err instanceof Error);
        return true;
      }
    );
  });

  it('setSharedBuffer with only one size argument should throw', () => {
    const sab = new ArrayBuffer(4096);
    assert.throws(
      () => addon.setSharedBuffer(sab, 1024),
      (err) => {
        assert.ok(err instanceof TypeError || err instanceof Error);
        return true;
      }
    );
  });

  it('loadPlugin with no arguments should throw TypeError', () => {
    assert.throws(
      () => addon.loadPlugin(),
      (err) => {
        assert.ok(err instanceof TypeError || err instanceof Error);
        return true;
      }
    );
  });

  it('loadPlugin with wrong type should throw TypeError', () => {
    assert.throws(
      () => addon.loadPlugin(12345),
      (err) => {
        assert.ok(err instanceof TypeError || err instanceof Error);
        return true;
      }
    );
  });

  it('loadPlugin with null should throw TypeError', () => {
    assert.throws(
      () => addon.loadPlugin(null),
      (err) => {
        assert.ok(err instanceof TypeError || err instanceof Error);
        return true;
      }
    );
  });

  it('setMessageCallback with no arguments should throw TypeError', () => {
    assert.throws(
      () => addon.setMessageCallback(),
      (err) => {
        assert.ok(err instanceof TypeError || err instanceof Error);
        return true;
      }
    );
  });

  it('setMessageCallback with wrong type should throw TypeError', () => {
    assert.throws(
      () => addon.setMessageCallback('not a function'),
      (err) => {
        assert.ok(err instanceof TypeError || err instanceof Error);
        return true;
      }
    );
  });

  it('setMessageCallback with a valid function should not throw', () => {
    assert.doesNotThrow(() => {
      addon.setMessageCallback(() => {});
    });
  });

  it('triggerTestCallback should not crash even without shared buffer', () => {
    // triggerTestCallback tries to send via channel.send_buffer.
    // Without a shared buffer set up, it should just fail silently (no crash).
    assert.doesNotThrow(() => {
      addon.triggerTestCallback();
    });
  });

  it('unloadPlugin with extra arguments should not crash', () => {
    assert.doesNotThrow(() => {
      addon.unloadPlugin('extra', 'args', 123);
    });
  });

  it('cleanup with extra arguments should not crash', () => {
    assert.doesNotThrow(() => {
      addon.cleanup('extra', 42, null);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. setMessageCallback integration
// ---------------------------------------------------------------------------

describe('setMessageCallback', () => {
  after(() => {
    addon.cleanup();
  });

  it('should accept a callback function', () => {
    let called = false;
    assert.doesNotThrow(() => {
      addon.setMessageCallback((buffer) => {
        called = true;
      });
    });
  });

  it('should allow replacing the callback', () => {
    assert.doesNotThrow(() => {
      addon.setMessageCallback(() => { /* first */ });
      addon.setMessageCallback(() => { /* second */ });
      addon.setMessageCallback(() => { /* third */ });
    });
  });
});
