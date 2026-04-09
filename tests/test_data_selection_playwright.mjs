/**
 * Playwright E2E: Data Selection — upstream node output selection in saver plugin
 *
 * Tests the full flow:
 *   1. Load 3 plugins + instances via config
 *   2. Switch to Graph Editor, build graph programmatically using config instances
 *   3. Configure folder source + saver output dir
 *   4. Execute graph (populates upstream outputs)
 *   5. Query get_upstream_outputs — verify upstream nodes
 *   6. Set data selection to folder source (bypass inverter)
 *   7. Re-execute → verify saved file
 *   8. Clear selection → verify fallback
 *   9. Verify getDef round-trip
 *
 * Run:
 *   set PATH=C:\opencv\opencv\build\x64\vc16\bin;%PATH%
 *   node --test tests/test_data_selection_playwright.mjs
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

/** Send a PI command via the app's __sendData and return parsed metadata. */
async function piSend(win, meta) {
  return win.evaluate(async (meta) => {
    const sendData = window.__sendData;
    if (!sendData) throw new Error('__sendData not available');
    const packet = {
      tl: 'PI', target_id: 1, is_end_of_group: true,
      content: { metadata_str: JSON.stringify(meta) }
    };
    const resp = await sendData(packet);
    return resp[0]?.content?.metadata_parsed;
  }, meta);
}

/** Send an exchange command to a plugin instance. */
async function piExchange(win, instanceId, cmdInfo) {
  return piSend(win, {
    type: 'exchange',
    instance_id: instanceId,
    cmd_info: cmdInfo,
  });
}

// Instance IDs matching the config file
const FOLDER_INST = 'folder_src';
const INVERT_INST = 'inverter';
const SAVER_INST  = 'saver';

// Graph node IDs (stable, used for edges and data selection)
const N_FOLDER = 'n_folder';
const N_INVERT = 'n_invert';
const N_SAVER  = 'n_saver';

describe('Data Selection E2E — full upstream selection flow', { timeout: 300000 }, () => {
  let app, win;
  let tmpOutputDir;

  before(async () => {
    app = await electron.launch({ args: [ELECTRON_ROOT] });
    win = await app.firstWindow();
    win.on('console', msg => {
      if (msg.type() === 'error') console.log(`  ERR: ${msg.text()}`);
    });
    await win.waitForLoadState('load');
    await sleep(5000);
    tmpOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xinsp_ds_e2e_'));
    console.log(`  Output dir: ${tmpOutputDir}`);
  });

  after(async () => {
    try { if (tmpOutputDir) fs.rmSync(tmpOutputDir, { recursive: true, force: true }); } catch {}
    if (app) await app.close().catch(() => {});
  });

  // -------------------------------------------------------------------
  // Step 1: Load config (3 plugins + 3 instances)
  // -------------------------------------------------------------------
  it('Step 1: Load config with 3 plugins', async () => {
    const fcp = win.waitForEvent('filechooser', { timeout: 15000 });
    await win.locator('button:has-text("Load Config")').click();
    (await fcp).setFiles(CONFIG);

    let count = 0;
    for (let i = 0; i < 30 && count < 3; i++) {
      await sleep(1000);
      const t = await win.locator('button').filter({ hasText: /載入狀態/ }).innerText().catch(() => '');
      const m = t.match(/\[(\d+)\]/);
      if (m) count = parseInt(m[1]);
    }
    console.log(`  Plugins loaded: ${count}`);
    assert.ok(count >= 3, `Expected >= 3 plugins, got ${count}`);
    await shot(win, 'ds_01_config_loaded.png');
  });

  // -------------------------------------------------------------------
  // Step 2: Build graph programmatically using the config's instances
  // -------------------------------------------------------------------
  it('Step 2: Load graph via piGraphLoad using config instances', async () => {
    const graphDef = {
      id: 'g_ds', name: 'DataSelectionTest',
      nodes: [
        { id: N_FOLDER, name: 'Folder Source',  pluginName: 'imgsrc_folder_plugin', instanceId: FOLDER_INST },
        { id: N_INVERT, name: 'Inverter',       pluginName: 'invert_plugin',        instanceId: INVERT_INST },
        { id: N_SAVER,  name: 'Output Saver',   pluginName: 'imgsaver_plugin',      instanceId: SAVER_INST },
      ],
      edges: [
        { fromNodeId: N_FOLDER, fromPortId: 'out', toNodeId: N_INVERT, toPortId: 'in' },
        { fromNodeId: N_INVERT, fromPortId: 'out', toNodeId: N_SAVER,  toPortId: 'in' },
      ],
    };
    const result = await piSend(win, { type: 'graph_load', graph: graphDef });
    console.log(`  graph_load: ACK=${result?.ACK}`);
    assert.ok(result?.ACK, 'graph_load ACK');
  });

  // -------------------------------------------------------------------
  // Step 3: Configure folder source + saver output
  // -------------------------------------------------------------------
  it('Step 3: Configure folder source and saver output', async () => {
    const setFolder = await piExchange(win, FOLDER_INST, {
      command: 'set_folder', path: TEST_IMAGES,
    });
    console.log(`  set_folder: ACK=${setFolder?.ACK} count=${setFolder?.file_count}`);
    assert.ok(setFolder?.ACK, 'set_folder ACK');
    assert.ok(setFolder?.file_count > 0, 'folder has images');

    // Load first image into cache
    const getImg = await piExchange(win, FOLDER_INST, { command: 'get_image' });
    console.log(`  get_image: file=${getImg?.file ?? 'n/a'}`);

    // Configure saver
    const outputPath = tmpOutputDir.replace(/\\/g, '/');
    const setSaver = await piExchange(win, SAVER_INST, {
      command: 'set_output', path: outputPath, prefix: 'ds_e2e', format: '.png',
    });
    console.log(`  set_output: ACK=${setSaver?.ACK}`);
    assert.ok(setSaver?.ACK, 'set_output ACK');
  });

  // -------------------------------------------------------------------
  // Step 4: Execute graph (fire-and-forget, then poll status)
  // -------------------------------------------------------------------
  it('Step 4: Execute graph pipeline', async () => {
    // Fire graph_execute without awaiting the response (it returns a large BMP stage)
    win.evaluate((meta) => {
      const sendData = window.__sendData;
      if (sendData) sendData({
        tl: 'PI', target_id: 1, is_end_of_group: true,
        content: { metadata_str: JSON.stringify(meta) }
      });
    }, { type: 'graph_execute', graph_id: 'g_ds' });

    // Wait for execution to complete
    let saved = 0;
    for (let i = 0; i < 20 && saved === 0; i++) {
      await sleep(1000);
      const status = await piExchange(win, SAVER_INST, { command: 'get_status' });
      saved = status?.saved_count ?? 0;
    }
    console.log(`  Saver saved_count: ${saved}`);
    assert.ok(saved > 0, 'saver saved at least one image');
    await shot(win, 'ds_02_after_first_execute.png');
  });

  // -------------------------------------------------------------------
  // Step 5: Query upstream outputs from saver
  // -------------------------------------------------------------------
  it('Step 5: get_upstream_outputs returns upstream nodes', async () => {
    const upstream = await piExchange(win, SAVER_INST, { command: 'get_upstream_outputs' });
    console.log(`  upstream ACK=${upstream?.ACK}`);
    assert.ok(upstream?.ACK, 'get_upstream_outputs ACK');
    assert.ok(upstream?.nodes, 'nodes object present');

    const nodeIds = Object.keys(upstream.nodes);
    console.log(`  Upstream nodes: ${nodeIds.join(', ')}`);
    assert.ok(nodeIds.includes(N_FOLDER), 'folder node in upstream');
    assert.ok(nodeIds.includes(N_INVERT), 'invert node in upstream');
    assert.ok(!nodeIds.includes(N_SAVER), 'saver NOT in its own upstream');

    // Check image metadata
    for (const nid of nodeIds) {
      const info = upstream.nodes[nid];
      const imgKeys = Object.keys(info.images || {});
      console.log(`    ${nid}: name="${info.name}" images=[${imgKeys}]`);
      assert.ok(imgKeys.length > 0, `${nid} has images`);
      const firstImg = info.images[imgKeys[0]];
      assert.ok(firstImg.w > 0 && firstImg.h > 0, `${nid} image has dimensions`);
    }

    // Display names
    assert.equal(upstream.nodes[N_FOLDER].name, 'Folder Source');
    assert.equal(upstream.nodes[N_INVERT].name, 'Inverter');

    // Empty initial selection
    assert.ok(Array.isArray(upstream.selection));
    assert.equal(upstream.selection.length, 0);
  });

  // -------------------------------------------------------------------
  // Step 6: Set data selection to folder source
  // -------------------------------------------------------------------
  it('Step 6: Set data selection to folder source image', async () => {
    const selResult = await piExchange(win, SAVER_INST, {
      command: 'set_data_selection',
      selection: [{ sourceNodeId: N_FOLDER, dataPath: 'images/out' }],
    });
    assert.ok(selResult?.ACK, 'set_data_selection ACK');

    // Verify persistence
    const upstream = await piExchange(win, SAVER_INST, { command: 'get_upstream_outputs' });
    assert.equal(upstream.selection.length, 1);
    assert.equal(upstream.selection[0].sourceNodeId, N_FOLDER);
    assert.equal(upstream.selection[0].dataPath, 'images/out');
    console.log(`  Selection set: ${N_FOLDER} → images/out`);
  });

  // -------------------------------------------------------------------
  // Step 7: Re-execute with selection
  // -------------------------------------------------------------------
  it('Step 7: Re-execute with selection saves from folder source', async () => {
    await piExchange(win, SAVER_INST, { command: 'reset_counter' });
    for (const f of fs.readdirSync(tmpOutputDir)) fs.unlinkSync(path.join(tmpOutputDir, f));

    // Fire-and-forget execute
    win.evaluate((meta) => {
      const sendData = window.__sendData;
      if (sendData) sendData({
        tl: 'PI', target_id: 1, is_end_of_group: true,
        content: { metadata_str: JSON.stringify(meta) }
      });
    }, { type: 'graph_execute', graph_id: 'g_ds' });

    let saved = 0;
    for (let i = 0; i < 20 && saved === 0; i++) {
      await sleep(1000);
      const status = await piExchange(win, SAVER_INST, { command: 'get_status' });
      saved = status?.saved_count ?? 0;
    }

    const files = fs.readdirSync(tmpOutputDir).filter(f => f.startsWith('ds_e2e'));
    console.log(`  Output files: ${files.length} saved_count=${saved}`);
    assert.ok(files.length > 0, 'file saved with data selection');
    assert.ok(saved > 0, 'saver saved from selected upstream');
    await shot(win, 'ds_03_after_selection_execute.png');
  });

  // -------------------------------------------------------------------
  // Step 8: Clear selection → fallback
  // -------------------------------------------------------------------
  it('Step 8: Clear selection falls back to direct input', async () => {
    await piExchange(win, SAVER_INST, { command: 'set_data_selection', selection: [] });
    await piExchange(win, SAVER_INST, { command: 'reset_counter' });
    for (const f of fs.readdirSync(tmpOutputDir)) fs.unlinkSync(path.join(tmpOutputDir, f));

    // Fire-and-forget execute
    win.evaluate((meta) => {
      const sendData = window.__sendData;
      if (sendData) sendData({
        tl: 'PI', target_id: 1, is_end_of_group: true,
        content: { metadata_str: JSON.stringify(meta) }
      });
    }, { type: 'graph_execute', graph_id: 'g_ds' });

    let saved = 0;
    for (let i = 0; i < 20 && saved === 0; i++) {
      await sleep(1000);
      const status = await piExchange(win, SAVER_INST, { command: 'get_status' });
      saved = status?.saved_count ?? 0;
    }

    const files = fs.readdirSync(tmpOutputDir).filter(f => f.startsWith('ds_e2e'));
    console.log(`  Fallback files: ${files.length}`);
    assert.ok(files.length > 0, 'saver saves via fallback (direct input)');
    await shot(win, 'ds_04_after_clear_execute.png');
  });

  // -------------------------------------------------------------------
  // Step 9: getDef round-trip
  // -------------------------------------------------------------------
  it('Step 9: Data selection round-trips through getDef', async () => {
    // Set selection
    await piExchange(win, SAVER_INST, {
      command: 'set_data_selection',
      selection: [{ sourceNodeId: N_INVERT, dataPath: 'images/out' }],
    });

    const defResult = await piSend(win, { type: 'get_instance_def', instance_id: SAVER_INST });
    console.log(`  getDef ACK=${defResult?.ACK}`);
    assert.ok(defResult?.ACK, 'get_instance_def ACK');
    assert.ok(defResult?.def?.data_selection, 'data_selection in def');
    assert.equal(defResult.def.data_selection.length, 1);
    assert.equal(defResult.def.data_selection[0].sourceNodeId, N_INVERT);
    assert.equal(defResult.def.data_selection[0].dataPath, 'images/out');
    console.log(`  Selection persisted: ${N_INVERT} → images/out`);
  });
});
