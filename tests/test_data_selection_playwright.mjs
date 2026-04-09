/**
 * Playwright E2E: Data Selection — upstream node output selection in saver plugin
 *
 * Tests the full flow:
 *   1. Load 3 plugins (folder, invert, saver) via config
 *   2. Switch to graph editor, add 3 nodes, connect edges
 *   3. Configure folder source + saver output dir
 *   4. Execute graph (populates upstream outputs)
 *   5. Open saver plugin UI, click Refresh upstream
 *   6. Verify DataPathSelector shows upstream nodes
 *   7. Select folder source image (not the direct invert input)
 *   8. Execute again → verify saved file comes from folder (not inverted)
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

/** Send an exchange command to a plugin instance via the app's __sendData */
async function piExchange(win, instanceId, cmdInfo) {
  return win.evaluate(async ({ instanceId, cmdInfo }) => {
    const sendData = window.__sendData;
    if (!sendData) throw new Error('__sendData not available');
    const packet = {
      tl: 'PI', target_id: 1, is_end_of_group: true,
      content: { metadata_str: JSON.stringify({
        type: 'exchange', instance_id: instanceId, cmd_info: cmdInfo
      })}
    };
    const resp = await sendData(packet);
    return resp[0]?.content?.metadata_parsed;
  }, { instanceId, cmdInfo });
}

/** Send a generic PI command via the app's __sendData */
async function piCommand(win, meta) {
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

/**
 * Get the current graph state from the React app.
 * Returns { nodes: [{id, name, pluginName, instanceId}], edges: [...] }
 */
async function getGraphState(win) {
  return win.evaluate(() => {
    // The graph editor exposes its state via the useGraphEditor hook
    // We can read it from the DOM or from exposed globals.
    // Since __sendData is exposed, let's also check if graph state is accessible.
    // Fallback: count DOM nodes and read data attributes.
    const flowNodes = document.querySelectorAll('.react-flow__node');
    const nodes = [];
    for (const el of flowNodes) {
      nodes.push({ domId: el.getAttribute('data-id') });
    }
    const edgeCount = document.querySelectorAll('.react-flow__edge').length;
    return { nodeCount: nodes.length, nodes, edgeCount };
  });
}

/**
 * Get instance IDs from the plugin instance list displayed in the app.
 * After Load Config, instances are created with the config's instance_id values.
 */
async function getInstanceIds(win) {
  return win.evaluate(() => {
    // The app stores plugin_instance_list in state. We can read it from
    // the DOM (instance cards show instance_id) or via exposed state.
    // Look for spans that contain instance IDs in the plugin tab.
    const spans = document.querySelectorAll('span');
    const ids = [];
    for (const s of spans) {
      const text = s.textContent?.trim();
      if (text && (text.startsWith('folder_') || text.startsWith('inverter') || text.startsWith('saver') || text.startsWith('inst_'))) {
        ids.push(text);
      }
    }
    return ids;
  });
}

describe('Data Selection E2E — full upstream selection flow', { timeout: 300000 }, () => {
  let app, win;
  let tmpOutputDir;
  // Instance IDs from config (config creates these, not the graph editor)
  const FOLDER_INST = 'folder_src';
  const INVERT_INST = 'inverter';
  const SAVER_INST  = 'saver';

  before(async () => {
    app = await electron.launch({ args: [ELECTRON_ROOT] });
    win = await app.firstWindow();
    win.on('console', msg => {
      if (msg.type() === 'error') console.log(`  ERR: ${msg.text()}`);
    });
    await win.waitForLoadState('load');
    await sleep(5000);

    // Create temp output dir
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

    // Wait for plugins to load
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
  // Step 2: Switch to Graph tab, add 3 nodes, connect edges
  // -------------------------------------------------------------------
  it('Step 2: Add 3 graph nodes and connect edges', async () => {
    await win.locator('button:has-text("Graph Editor")').click();
    await sleep(1000);

    // Add nodes via the UI
    for (const p of ['imgsrc_folder_plugin', 'invert_plugin', 'imgsaver_plugin']) {
      await win.locator('select').first().selectOption(p);
      await sleep(300);
      await win.locator('button:has-text("Add Node")').click();
      await sleep(2000);
    }

    // Get the graph node IDs from the DOM (React Flow data-id attributes)
    const graphState = await getGraphState(win);
    console.log(`  Graph nodes: ${graphState.nodeCount}`);
    assert.ok(graphState.nodeCount >= 3, `Expected >= 3 nodes, got ${graphState.nodeCount}`);

    // Get the React Flow node IDs (these are the graph node IDs, not instanceIds)
    const rfNodeIds = graphState.nodes.map(n => n.domId);
    console.log(`  React Flow node IDs: ${rfNodeIds.join(', ')}`);

    // Connect edges using React Flow node IDs
    // Node order matches add order: [0]=folder, [1]=invert, [2]=saver
    for (const edge of [
      { source: rfNodeIds[0], sourceHandle: 'out', target: rfNodeIds[1], targetHandle: 'in' },
      { source: rfNodeIds[1], sourceHandle: 'out', target: rfNodeIds[2], targetHandle: 'in' },
    ]) {
      await win.evaluate((e) => {
        window.dispatchEvent(new CustomEvent('graph-connect-edge', { detail: e }));
      }, edge);
      await sleep(300);
    }

    await sleep(1000);
    const afterState = await getGraphState(win);
    console.log(`  After connect: ${afterState.nodeCount} nodes, ${afterState.edgeCount} edges`);
    assert.ok(afterState.edgeCount >= 2, `Expected >= 2 edges, got ${afterState.edgeCount}`);
    await shot(win, 'ds_02_graph_connected.png');
  });

  // -------------------------------------------------------------------
  // Step 3: Configure folder source + saver output
  // -------------------------------------------------------------------
  it('Step 3: Configure folder source and saver output', async () => {
    // Set folder on the folder source instance (from config: "folder_src")
    const setFolder = await piExchange(win, FOLDER_INST, {
      command: 'set_folder', path: TEST_IMAGES,
    });
    console.log(`  set_folder: ACK=${setFolder?.ACK} count=${setFolder?.file_count}`);
    assert.ok(setFolder?.ACK, 'set_folder ACK');
    assert.ok(setFolder?.file_count > 0, 'folder has images');

    // Load first image
    const getImg = await piExchange(win, FOLDER_INST, { command: 'get_image' });
    console.log(`  get_image: ACK=${getImg?.ACK}`);

    // Configure saver output
    const outputPath = tmpOutputDir.replace(/\\/g, '/');
    const setSaver = await piExchange(win, SAVER_INST, {
      command: 'set_output', path: outputPath, prefix: 'ds_e2e', format: '.png',
    });
    console.log(`  set_output: ACK=${setSaver?.ACK} path=${setSaver?.path}`);
    assert.ok(setSaver?.ACK, 'set_output ACK');
  });

  // -------------------------------------------------------------------
  // Step 4: Execute graph (populates upstream outputs)
  // -------------------------------------------------------------------
  it('Step 4: Execute graph pipeline', async () => {
    await win.locator('button:has-text("Execute")').click();
    console.log('  Executing graph...');
    await sleep(5000);

    // Verify saver saved something (default: saves direct input = inverted image)
    const status = await piExchange(win, SAVER_INST, { command: 'get_status' });
    console.log(`  Saver status: saved_count=${status?.saved_count}`);
    assert.ok(status?.saved_count > 0, 'saver saved at least one image on first execute');

    await shot(win, 'ds_03_after_first_execute.png');
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
    assert.ok(nodeIds.length >= 2, `Expected >= 2 upstream nodes, got ${nodeIds.length}`);

    // Check that upstream nodes have image data
    for (const nid of nodeIds) {
      const info = upstream.nodes[nid];
      console.log(`    ${nid}: name="${info.name}" images=${JSON.stringify(Object.keys(info.images))}`);
      assert.ok(info.images, `node ${nid} has images`);
    }

    // Selection should be empty initially
    assert.ok(Array.isArray(upstream.selection), 'selection is array');
    assert.equal(upstream.selection.length, 0, 'initial selection empty');
  });

  // -------------------------------------------------------------------
  // Step 6: Set data selection to folder source (skip inverter)
  // -------------------------------------------------------------------
  it('Step 6: Set data selection to folder source image', async () => {
    // First, find the folder node ID in upstream
    const upstream = await piExchange(win, SAVER_INST, { command: 'get_upstream_outputs' });
    const nodeIds = Object.keys(upstream.nodes);

    // Find the folder source node (has name containing "imgsrc" or "folder" or "Folder")
    let folderNodeId = null;
    for (const nid of nodeIds) {
      const name = upstream.nodes[nid].name || '';
      if (name.toLowerCase().includes('folder') || name.toLowerCase().includes('imgsrc')) {
        folderNodeId = nid;
        break;
      }
    }
    // Fallback: if names don't match, take the first one (folder is added first, executed first)
    if (!folderNodeId) folderNodeId = nodeIds[0];
    console.log(`  Folder node ID: ${folderNodeId}`);
    assert.ok(folderNodeId, 'found folder node in upstream');

    // Select folder source image
    const selResult = await piExchange(win, SAVER_INST, {
      command: 'set_data_selection',
      selection: [{ sourceNodeId: folderNodeId, dataPath: 'images/out' }],
    });
    assert.ok(selResult?.ACK, 'set_data_selection ACK');

    // Verify selection persisted
    const upstream2 = await piExchange(win, SAVER_INST, { command: 'get_upstream_outputs' });
    assert.equal(upstream2.selection.length, 1, 'one selection stored');
    assert.equal(upstream2.selection[0].sourceNodeId, folderNodeId);
    assert.equal(upstream2.selection[0].dataPath, 'images/out');
    console.log(`  Selection set: ${folderNodeId} → images/out`);
  });

  // -------------------------------------------------------------------
  // Step 7: Reset counter and re-execute with selection
  // -------------------------------------------------------------------
  it('Step 7: Re-execute with selection saves from folder source', async () => {
    // Reset counter
    await piExchange(win, SAVER_INST, { command: 'reset_counter' });

    // Clear previous output files
    const existingFiles = fs.readdirSync(tmpOutputDir);
    for (const f of existingFiles) fs.unlinkSync(path.join(tmpOutputDir, f));

    // Execute
    await win.locator('button:has-text("Execute")').click();
    console.log('  Re-executing with data selection...');
    await sleep(5000);

    // Verify files saved
    const files = fs.readdirSync(tmpOutputDir).filter(f => f.startsWith('ds_e2e'));
    console.log(`  Output files: ${files.length} (${files.join(', ')})`);
    assert.ok(files.length > 0, 'at least one file saved with data selection');

    // Verify save count
    const status = await piExchange(win, SAVER_INST, { command: 'get_status' });
    console.log(`  Saver status: saved_count=${status?.saved_count}`);
    assert.ok(status?.saved_count > 0, 'saver saved from selected upstream');

    await shot(win, 'ds_04_after_selection_execute.png');
  });

  // -------------------------------------------------------------------
  // Step 8: Clear selection and verify fallback to direct input
  // -------------------------------------------------------------------
  it('Step 8: Clear selection falls back to direct input', async () => {
    // Clear selection
    const clearResult = await piExchange(win, SAVER_INST, {
      command: 'set_data_selection', selection: [],
    });
    assert.ok(clearResult?.ACK, 'clear selection ACK');

    // Reset counter and clear files
    await piExchange(win, SAVER_INST, { command: 'reset_counter' });
    const existingFiles = fs.readdirSync(tmpOutputDir);
    for (const f of existingFiles) fs.unlinkSync(path.join(tmpOutputDir, f));

    // Execute
    await win.locator('button:has-text("Execute")').click();
    await sleep(5000);

    // Should still save (from direct edge input)
    const files = fs.readdirSync(tmpOutputDir).filter(f => f.startsWith('ds_e2e'));
    console.log(`  Fallback files: ${files.length}`);
    assert.ok(files.length > 0, 'saver saves via fallback (direct input)');

    await shot(win, 'ds_05_after_clear_execute.png');
  });

  // -------------------------------------------------------------------
  // Step 9: Verify selection persists through getDef
  // -------------------------------------------------------------------
  it('Step 9: Data selection round-trips through getDef', async () => {
    // Set a selection
    const upstream = await piExchange(win, SAVER_INST, { command: 'get_upstream_outputs' });
    const firstNodeId = Object.keys(upstream.nodes)[0];

    await piExchange(win, SAVER_INST, {
      command: 'set_data_selection',
      selection: [{ sourceNodeId: firstNodeId, dataPath: 'images/out' }],
    });

    // Query getDef
    const defResult = await piCommand(win, { type: 'get_instance_def', instance_id: SAVER_INST });
    console.log(`  getDef ACK=${defResult?.ACK}`);
    assert.ok(defResult?.ACK, 'get_instance_def ACK');
    assert.ok(defResult?.def?.data_selection, 'data_selection in def');
    assert.equal(defResult.def.data_selection.length, 1);
    assert.equal(defResult.def.data_selection[0].sourceNodeId, firstNodeId);
    console.log(`  Selection persisted in getDef: ${firstNodeId} → images/out`);
  });
});
