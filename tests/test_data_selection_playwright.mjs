/**
 * Playwright E2E: Data Selection — upstream node output selection in saver plugin
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
import { ELECTRON_ROOT, XAPPHUB, TEST_IMAGES, SCREENSHOT_DIR, CONFIG } from './test_paths.mjs';

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function shot(win, name) {
  const p = path.join(SCREENSHOT_DIR, name);
  await win.screenshot({ path: p });
  console.log(`  screenshot: ${name} (${(fs.statSync(p).size / 1024).toFixed(0)}KB)`);
}

/** Send a PI command with timeout protection. */
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

async function piExchange(win, instanceId, cmdInfo) {
  return piSend(win, { type: 'exchange', instance_id: instanceId, cmd_info: cmdInfo });
}

/** Fire graph_execute without awaiting (response can be huge BMP). */
async function fireGraphExecute(win, graphId) {
  await win.evaluate((meta) => {
    const sendData = window.__sendData;
    if (sendData) sendData({
      tl: 'PI', target_id: 1, is_end_of_group: true,
      content: { metadata_str: JSON.stringify(meta) }
    });
  }, { type: 'graph_execute', graph_id: graphId });
}

/** Poll a condition. Returns true if met within maxMs. */
async function pollUntil(fn, maxMs = 15000, intervalMs = 500) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function waitForPluginCount(win, expected, maxMs = 30000) {
  return pollUntil(async () => {
    const t = await win.locator('button').filter({ hasText: /載入狀態/ }).innerText().catch(() => '');
    const m = t.match(/\[(\d+)\]/);
    return m && parseInt(m[1]) >= expected;
  }, maxMs, 1000);
}

/** Wait for saver to have saved_count > 0. */
async function waitForSaved(win, instanceId, maxMs = 15000) {
  return pollUntil(async () => {
    const s = await piExchange(win, instanceId, { command: 'get_status' });
    return (s?.saved_count ?? 0) > 0;
  }, maxMs);
}

const FOLDER_INST = 'folder_src';
const INVERT_INST = 'inverter';
const SAVER_INST  = 'saver';
const N_FOLDER = 'n_folder';
const N_INVERT = 'n_invert';
const N_SAVER  = 'n_saver';

describe('Data Selection E2E', { timeout: 120000 }, () => {
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
    tmpOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xinsp_ds_e2e_'));
  });

  after(async () => {
    try { if (tmpOutputDir) fs.rmSync(tmpOutputDir, { recursive: true, force: true }); } catch {}
    if (app) await app.close().catch(() => {});
  });

  it('Step 1: Load config with 3 plugins', async () => {
    const fcp = win.waitForEvent('filechooser', { timeout: 15000 });
    await win.locator('button:has-text("Load Config")').click();
    (await fcp).setFiles(CONFIG);
    const loaded = await waitForPluginCount(win, 3);
    assert.ok(loaded, 'expected >= 3 plugins');
    await shot(win, 'ds_01_config_loaded.png');
  });

  it('Step 2: Load graph via piGraphLoad', async () => {
    const result = await piSend(win, { type: 'graph_load', graph: {
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
    }});
    assert.ok(result?.ACK, 'graph_load ACK');
  });

  it('Step 3: Configure folder source and saver', async () => {
    const sf = await piExchange(win, FOLDER_INST, { command: 'set_folder', path: TEST_IMAGES });
    assert.ok(sf?.ACK && sf?.file_count > 0, 'set_folder OK');
    await piExchange(win, FOLDER_INST, { command: 'get_image' });
    const ss = await piExchange(win, SAVER_INST, {
      command: 'set_output', path: tmpOutputDir.replace(/\\/g, '/'), prefix: 'ds_e2e', format: '.png',
    });
    assert.ok(ss?.ACK, 'set_output ACK');
  });

  it('Step 4: Execute graph', async () => {
    await fireGraphExecute(win, 'g_ds');
    const saved = await waitForSaved(win, SAVER_INST);
    assert.ok(saved, 'saver saved at least one image');
    await shot(win, 'ds_02_after_execute.png');
  });

  it('Step 5: get_upstream_outputs returns upstream nodes', async () => {
    const up = await piExchange(win, SAVER_INST, { command: 'get_upstream_outputs' });
    assert.ok(up?.ACK, 'ACK');
    const nodeIds = Object.keys(up.nodes);
    assert.ok(nodeIds.includes(N_FOLDER), 'folder in upstream');
    assert.ok(nodeIds.includes(N_INVERT), 'invert in upstream');
    assert.ok(!nodeIds.includes(N_SAVER), 'saver not in own upstream');
    assert.equal(up.nodes[N_FOLDER].name, 'Folder Source');
    assert.equal(up.nodes[N_INVERT].name, 'Inverter');
    assert.equal(up.selection.length, 0, 'empty initial selection');
    // Verify image metadata
    assert.ok(up.nodes[N_FOLDER].images.out?.w > 0, 'folder image has width');
  });

  it('Step 6: Set data selection to folder source', async () => {
    const r = await piExchange(win, SAVER_INST, {
      command: 'set_data_selection',
      selection: [{ sourceNodeId: N_FOLDER, dataPath: 'images/out' }],
    });
    assert.ok(r?.ACK, 'set_data_selection ACK');
    const up = await piExchange(win, SAVER_INST, { command: 'get_upstream_outputs' });
    assert.equal(up.selection.length, 1);
    assert.equal(up.selection[0].sourceNodeId, N_FOLDER);
  });

  it('Step 7: Re-execute saves from selected upstream', async () => {
    await piExchange(win, SAVER_INST, { command: 'reset_counter' });
    for (const f of fs.readdirSync(tmpOutputDir)) fs.unlinkSync(path.join(tmpOutputDir, f));

    await fireGraphExecute(win, 'g_ds');
    const saved = await waitForSaved(win, SAVER_INST);
    assert.ok(saved, 'saver saved from selected upstream');

    const files = fs.readdirSync(tmpOutputDir).filter(f => f.startsWith('ds_e2e'));
    assert.ok(files.length > 0, `files saved: ${files.join(', ')}`);
    await shot(win, 'ds_03_after_selection.png');
  });

  it('Step 8: Clear selection falls back to direct input', async () => {
    await piExchange(win, SAVER_INST, { command: 'set_data_selection', selection: [] });
    await piExchange(win, SAVER_INST, { command: 'reset_counter' });
    for (const f of fs.readdirSync(tmpOutputDir)) fs.unlinkSync(path.join(tmpOutputDir, f));

    await fireGraphExecute(win, 'g_ds');
    const saved = await waitForSaved(win, SAVER_INST);
    assert.ok(saved, 'saver saves via fallback');
    await shot(win, 'ds_04_after_clear.png');
  });

  it('Step 9: getDef round-trip preserves selection', async () => {
    await piExchange(win, SAVER_INST, {
      command: 'set_data_selection',
      selection: [{ sourceNodeId: N_INVERT, dataPath: 'images/out' }],
    });
    const def = await piSend(win, { type: 'get_instance_def', instance_id: SAVER_INST });
    assert.ok(def?.ACK, 'get_instance_def ACK');
    assert.equal(def.def.data_selection.length, 1);
    assert.equal(def.def.data_selection[0].sourceNodeId, N_INVERT);
    assert.equal(def.def.data_selection[0].dataPath, 'images/out');
  });
});
