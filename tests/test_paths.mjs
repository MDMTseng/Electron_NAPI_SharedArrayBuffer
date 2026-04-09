/**
 * Shared path resolver for E2E tests.
 *
 * Works in both layouts:
 *   - Submodule: XAppHub_APP/Electron_NAPI_SharedArrayBuffer/tests/
 *   - Sibling:   xInsp/Electron_NAPI_SharedArrayBuffer/tests/ (alongside xInsp/XAppHub_APP/)
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ELECTRON_ROOT = path.resolve(__dirname, '..');

// Detect layout: if parent of Electron is XAppHub_APP (has frontend/), we're a submodule
const parentDir = path.resolve(ELECTRON_ROOT, '..');
const isSubmodule = fs.existsSync(path.join(parentDir, 'frontend', 'src'));

export const XAPPHUB = isSubmodule
  ? parentDir                                              // XAppHub_APP/Electron/.. = XAppHub_APP
  : path.resolve(__dirname, '..', '..', 'XAppHub_APP');    // sibling layout

// test_images / screenshot live in the workspace root (parent of XAppHub_APP)
const workspaceRoot = isSubmodule
  ? path.resolve(XAPPHUB, '..')     // XAppHub_APP/..
  : path.resolve(__dirname, '../..');  // Electron/tests/../.. = xInsp

export const TEST_IMAGES = path.resolve(workspaceRoot, 'test_images').replace(/\\/g, '/');
export const SCREENSHOT_DIR = path.resolve(workspaceRoot, 'screenshot');
export const CONFIG = path.join(XAPPHUB, 'tests', 'e2e_graph_pipeline_config.json');

// Log detected layout
console.log(`  [test_paths] layout=${isSubmodule ? 'submodule' : 'sibling'} XAPPHUB=${XAPPHUB}`);
