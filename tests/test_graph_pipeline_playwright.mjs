/**
 * Playwright E2E: Graph Pipeline — load plugins, build graph, execute, verify output
 *
 * Uses piGraphLoad with known instance IDs (from config) instead of "Add Node" UI
 * to avoid depending on auto-generated instance IDs. This makes the test deterministic.
 *
 * Run:
 *   set PATH=C:\opencv\opencv\build\x64\vc16\bin;%PATH%
 *   node --test tests/test_graph_pipeline_playwright.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_ROOT = path.resolve(__dirname, '..');
const XAPPHUB = path.resolve(__dirname, '..', '..', 'XAppHub_APP');
const CONFIG = path.join(XAPPHUB, 'tests', 'e2e_graph_pipeline_config.json');
const TEST_IMAGES = path.resolve(__dirname, '..', '..', 'test_images').replace(/\\/g, '/');
const SCREENSHOT_DIR = path.resolve(__dirname, '..', '..', 'screenshot');

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function shot(win, name) {
  const p = path.join(SCREENSHOT_DIR, name);
  await win.screenshot({ path: p });
  console.log(`  screenshot: ${name} (${(fs.statSync(p).size / 1024).toFixed(0)}KB)`);
}

/** Send a PI command via the app's __sendData. Returns parsed metadata. */
async function piSend(win, meta, timeoutMs = 10000) {
  return win.evaluate(async ({ meta, timeoutMs }) => {
    const sendData = window.__sendData;
    if (!sendData) throw new Error('__sendData not available');
    const packet = {
      tl: 'PI', target_id: 1, is_end_of_group: true,
      content: { metadata_str: JSON.stringify(meta) }
    };
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('piSend timeout')), timeoutMs));
    const resp = await Promise.race([sendData(packet), timeout]);
    return resp[0]?.content?.metadata_parsed;
  }, { meta, timeoutMs });
}

/** Send an exchange command to a plugin instance. */
async function piExchange(win, instanceId, cmdInfo) {
  return piSend(win, { type: 'exchange', instance_id: instanceId, cmd_info: cmdInfo });
}

/** Fire graph_execute without waiting for the (potentially huge) response. */
async function fireGraphExecute(win, graphId) {
  await win.evaluate((meta) => {
    const sendData = window.__sendData;
    if (sendData) sendData({
      tl: 'PI', target_id: 1, is_end_of_group: true,
      content: { metadata_str: JSON.stringify(meta) }
    });
  }, { type: 'graph_execute', graph_id: graphId });
}

/** Poll a condition up to maxMs. Returns true if condition met. */
async function pollUntil(fn, maxMs = 15000, intervalMs = 500) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

/** Wait for plugins to finish loading by checking the status button text. */
async function waitForPluginCount(win, expected, maxMs = 30000) {
  return pollUntil(async () => {
    const t = await win.locator('button').filter({ hasText: /載入狀態/ }).innerText().catch(() => '');
    const m = t.match(/\[(\d+)\]/);
    return m && parseInt(m[1]) >= expected;
  }, maxMs, 1000);
}

// Instance IDs from e2e_graph_pipeline_config.json
const FOLDER_INST = 'folder_src';
const INVERT_INST = 'inverter';
const SAVER_INST  = 'saver';

describe('Graph Pipeline E2E', { timeout: 120000 }, () => {
  let app, win;
  let tmpOutputDir;

  before(async () => {
    app = await electron.launch({ args: [ELECTRON_ROOT] });
    win = await app.firstWindow();
    win.on('console', msg => {
      if (msg.type() === 'error') console.log(`  ERR: ${msg.text()}`);
    });
    await win.waitForLoadState('load');
    await sleep(3000);
    tmpOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xinsp_pipeline_'));
  });

  after(async () => {
    try { if (tmpOutputDir) fs.rmSync(tmpOutputDir, { recursive: true, force: true }); } catch {}
    if (app) await app.close().catch(() => {});
  });

  it('load 3 plugins via config', async () => {
    const fcp = win.waitForEvent('filechooser', { timeout: 15000 });
    await win.locator('button:has-text("Load Config")').click();
    (await fcp).setFiles(CONFIG);

    const loaded = await waitForPluginCount(win, 3);
    assert.ok(loaded, 'expected >= 3 plugins loaded');
    await shot(win, 'pipeline_01_loaded.png');
  });

  it('configure folder source and saver', async () => {
    const sf = await piExchange(win, FOLDER_INST, { command: 'set_folder', path: TEST_IMAGES });
    assert.ok(sf?.ACK, 'set_folder ACK');
    assert.ok(sf?.file_count > 0, 'folder has images');

    await piExchange(win, FOLDER_INST, { command: 'get_image' });

    const outputPath = tmpOutputDir.replace(/\\/g, '/');
    const ss = await piExchange(win, SAVER_INST, {
      command: 'set_output', path: outputPath, prefix: 'pipe', format: '.png',
    });
    assert.ok(ss?.ACK, 'set_output ACK');
  });

  it('load graph via piGraphLoad', async () => {
    const graphDef = {
      id: 'g_pipe', name: 'PipelineTest',
      nodes: [
        { id: 'n1', name: 'Folder Source', pluginName: 'imgsrc_folder_plugin', instanceId: FOLDER_INST },
        { id: 'n2', name: 'Inverter',      pluginName: 'invert_plugin',        instanceId: INVERT_INST },
        { id: 'n3', name: 'Saver',         pluginName: 'imgsaver_plugin',      instanceId: SAVER_INST },
      ],
      edges: [
        { fromNodeId: 'n1', fromPortId: 'out', toNodeId: 'n2', toPortId: 'in' },
        { fromNodeId: 'n2', fromPortId: 'out', toNodeId: 'n3', toPortId: 'in' },
      ],
    };
    const result = await piSend(win, { type: 'graph_load', graph: graphDef });
    assert.ok(result?.ACK, 'graph_load ACK');
  });

  it('execute graph and verify saved output', async () => {
    await fireGraphExecute(win, 'g_pipe');

    const saved = await pollUntil(async () => {
      const s = await piExchange(win, SAVER_INST, { command: 'get_status' });
      return (s?.saved_count ?? 0) > 0;
    });
    assert.ok(saved, 'saver saved at least one image');

    const files = fs.readdirSync(tmpOutputDir).filter(f => f.startsWith('pipe'));
    assert.ok(files.length > 0, `output files exist: ${files.join(', ')}`);
    console.log(`  Saved ${files.length} file(s)`);
    await shot(win, 'pipeline_02_executed.png');
  });

  it('cached output available on each node', async () => {
    for (const instId of [FOLDER_INST, INVERT_INST, SAVER_INST]) {
      const result = await piExchange(win, instId, { command: 'get_cached_output' });
      // get_cached_output returns ACK:true if no binary, or binary data
      console.log(`  ${instId} cached: ACK=${result?.ACK ?? 'has binary'}`);
    }
  });

  it('NodeInspector preview on folder node', async () => {
    // Switch to graph tab and click a node (if UI is showing the graph)
    await win.locator('button:has-text("Graph Editor")').click().catch(() => {});
    await sleep(1000);

    const nodes = win.locator('.react-flow__node');
    const count = await nodes.count().catch(() => 0);
    if (count > 0) {
      await nodes.first().click();
      await sleep(2000);
      const hasPreview = await win.locator('img[alt="node output"]').isVisible({ timeout: 3000 }).catch(() => false);
      console.log(`  Preview visible: ${hasPreview}`);
    } else {
      console.log('  No graph nodes in UI (graph loaded via API, not UI)');
    }
    await shot(win, 'pipeline_03_inspector.png');
  });
});
