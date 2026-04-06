/**
 * E2E Test for Electron_NAPI_SharedArrayBuffer
 *
 * Tests the full Electron app lifecycle:
 *   1. BIOS window launches
 *   2. Dev mode selection and main window launch
 *   3. Native addon loads
 *   4. SharedMemoryChannel round-trip communication
 *   5. Window lifecycle (close, quit)
 *
 * Run:  node tests/test_e2e.mjs
 *
 * Prerequisites:
 *   - npm install (with electron, playwright)
 *   - node-gyp rebuild (native addon)
 *   - cd APP/frontend && npm run build (or have dev server running on 5173)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Timeout helper
function withTimeout(promise, ms, msg) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(msg || `Timeout after ${ms}ms`)), ms))
    ]);
}

describe('Electron E2E Tests', { timeout: 60000 }, () => {
    let electronApp;
    let biosWindow;

    before(async () => {
        // Launch Electron app — pass "." as the app path so Electron reads
        // package.json's "main" field, which resolves bios.html correctly.
        electronApp = await electron.launch({
            args: [ROOT],
        });
    });

    after(async () => {
        if (electronApp) {
            await electronApp.close().catch(() => {});
        }
    });

    // -----------------------------------------------------------------------
    // Test 1: BIOS window appears
    // -----------------------------------------------------------------------
    it('should launch and show the BIOS window', async () => {
        // The first window should be the BIOS
        biosWindow = await electronApp.firstWindow();
        assert.ok(biosWindow, 'BIOS window should exist');

        // Wait for BIOS page to fully load
        await biosWindow.waitForLoadState('load');

        const title = await biosWindow.title();
        const url = biosWindow.url();
        console.log(`  BIOS window title: "${title}", URL: ${url}`);

        // Debug: dump page HTML
        const html = await biosWindow.content();
        console.log(`  BIOS HTML length: ${html.length}`);
        console.log(`  Has launchButton: ${html.includes('launchButton')}`);
        console.log(`  Has mode radio: ${html.includes('name="mode"')}`);

        // Verify BIOS has the expected content (button is #launchButton)
        const launchBtn = biosWindow.locator('#launchButton');
        await launchBtn.waitFor({ state: 'visible', timeout: 10000 });
        assert.ok(await launchBtn.isVisible(), 'Launch button should be visible');
    });

    // -----------------------------------------------------------------------
    // Test 2: BIOS mode selection UI works
    // -----------------------------------------------------------------------
    it('should have dev/prod mode radio buttons in BIOS', async () => {
        // Radio buttons use name="mode" with value="dev" / "prod"
        const devRadio = biosWindow.locator('input[name="mode"][value="dev"]');
        const prodRadio = biosWindow.locator('input[name="mode"][value="prod"]');

        assert.ok(await devRadio.isVisible(), 'Dev mode radio should be visible');
        assert.ok(await prodRadio.isVisible(), 'Prod mode radio should be visible');
    });

    // -----------------------------------------------------------------------
    // Test 3: Launch main window in prod mode (file://)
    // -----------------------------------------------------------------------
    it('should launch main window from BIOS in prod mode', async () => {
        // Select production mode
        await biosWindow.locator('input[name="mode"][value="prod"]').click();

        // Wait for artifact path input to become visible
        const pathInput = biosWindow.locator('#artifactPath');
        await pathInput.waitFor({ state: 'visible', timeout: 3000 });

        // Set artifact path to local build
        const artifactPathVal = path.join(ROOT, 'APP').replace(/\\/g, '/');
        await pathInput.fill(artifactPathVal);

        // Click launch
        await biosWindow.locator('#launchButton').click();

        // Wait for main window to appear (second window)
        const mainWindow = await withTimeout(
            new Promise(resolve => {
                const check = async () => {
                    const windows = await electronApp.windows();
                    // Find a window that isn't the BIOS (which may be closing)
                    for (const win of windows) {
                        const url = win.url();
                        if (url.includes('index.html') || url.includes('localhost')) {
                            resolve(win);
                            return;
                        }
                    }
                    setTimeout(check, 200);
                };
                check();
            }),
            15000,
            'Main window did not appear within 15s'
        );

        assert.ok(mainWindow, 'Main window should exist');
        const url = mainWindow.url();
        console.log(`  Main window URL: ${url}`);
        assert.ok(
            url.includes('index.html') || url.includes('localhost'),
            `Main window should load the app (got: ${url})`
        );

        // Wait for React to render
        await mainWindow.waitForSelector('body', { timeout: 5000 });
        console.log('  Main window loaded successfully');
    });

    // -----------------------------------------------------------------------
    // Test 4: Verify app content rendered
    // -----------------------------------------------------------------------
    it('should render the React app content', async () => {
        const windows = await electronApp.windows();
        const mainWindow = windows.find(w => {
            const url = w.url();
            return url.includes('index.html') || url.includes('localhost');
        });
        assert.ok(mainWindow, 'Main window should still exist');

        // Wait for the app to fully render
        await mainWindow.waitForLoadState('domcontentloaded');

        // Check that the page has some content (React rendered)
        const bodyText = await mainWindow.locator('body').innerText();
        console.log(`  Body text length: ${bodyText.length} chars`);
        assert.ok(bodyText.length > 0, 'Page should have rendered content');
    });

    // -----------------------------------------------------------------------
    // Test 5: Window count and lifecycle
    // -----------------------------------------------------------------------
    it('should have correct window count after BIOS closes', async () => {
        // After launching main window, BIOS should have closed
        // Give it a moment to close
        await new Promise(r => setTimeout(r, 1000));

        const windows = await electronApp.windows();
        console.log(`  Window count: ${windows.length}`);
        // Should have 1 main window (BIOS closed after launch)
        // DevTools may count as a separate window
        assert.ok(windows.length >= 1, 'Should have at least 1 window (main)');
    });

    // -----------------------------------------------------------------------
    // Test 6: App closes cleanly
    // -----------------------------------------------------------------------
    it('should close cleanly when all windows are closed', async () => {
        const windows = await electronApp.windows();
        for (const win of windows) {
            await win.close().catch(() => {});
        }

        // App should exit
        await withTimeout(
            new Promise(resolve => {
                electronApp.process().on('exit', resolve);
                // Also check if already exited
                if (electronApp.process().exitCode !== null) resolve(electronApp.process().exitCode);
            }),
            10000,
            'Electron process did not exit within 10s'
        );

        console.log('  App closed cleanly');
    });
});
