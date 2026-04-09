/**
 * Playwright E2E: Create project, execute, switch saver input, re-execute, save
 *
 * Flow:
 *   1. Remove ./test_prj if exists
 *   2. Load config (3 plugins)
 *   3. Switch to Graph Editor, add 3 nodes, connect edges
 *   4. Configure folder source + saver
 *   5. Execute graph (saver saves inverted image — direct input from inverter)
 *   6. Change saver data selection to imgsrc_folder image (original)
 *   7. Execute again (saver saves original image)
 *   8. Save project to ./test_prj
 *   9. Verify both images on disk + project structure
 *
 * Run:
 *   set PATH=C:\opencv\opencv\build\x64\vc16\bin;%PATH%
 *   node --test tests/test_project_create_playwright.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { ELECTRON_ROOT, XAPPHUB, TEST_IMAGES, SCREENSHOT_DIR, CONFIG } from './test_paths.mjs';

// test_prj lives in workspace root (same level as test_images)
const PROJECT_DIR = path.resolve(path.dirname(TEST_IMAGES), 'test_prj').replace(/\\/g, '/');

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function shot(win, name) {
  const p = path.join(SCREENSHOT_DIR, name);
  await win.screenshot({ path: p });
  console.log(`  screenshot: ${name} (${(fs.statSync(p).size / 1024).toFixed(0)}KB)`);
}

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

async function fireGraphExecute(win, graphId) {
  await win.evaluate((meta) => {
    window.__sendData?.({
      tl: 'PI', target_id: 1, is_end_of_group: true,
      content: { metadata_str: JSON.stringify(meta) }
    });
  }, { type: 'graph_execute', graph_id: graphId });
}

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

/** Get instance list from backend */
async function getInstanceList(win) {
  return piSend(win, { type: 'get_instance_list' });
}

describe('Create project → execute → switch saver input → re-execute → save', { timeout: 120000 }, () => {
  let app, win;
  let folderInstId, invertInstId, saverInstId;
  let nodeIds = [];
  const GRAPH_ID = 'g_create';

  before(async () => {
    // Clean previous test_prj
    if (fs.existsSync(PROJECT_DIR)) {
      fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
      console.log('  Removed old test_prj');
    }

    app = await electron.launch({ args: [ELECTRON_ROOT] });
    win = await app.firstWindow();
    win.on('console', msg => {
      if (msg.type() === 'error') console.log(`  ERR: ${msg.text()}`);
    });
    await win.waitForLoadState('load');
    await sleep(3000);
  });

  after(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('Step 1: Load config', async () => {
    const fcp = win.waitForEvent('filechooser', { timeout: 15000 });
    await win.locator('button:has-text("Load Config")').click();
    (await fcp).setFiles(CONFIG);
    const loaded = await waitForPluginCount(win, 3);
    assert.ok(loaded, 'plugins loaded');
  });

  it('Step 2: Add 3 nodes and connect edges', async () => {
    await win.locator('button:has-text("Graph Editor")').click();
    await sleep(1000);

    for (const p of ['imgsrc_folder_plugin', 'invert_plugin', 'imgsaver_plugin']) {
      await win.locator('select').first().selectOption(p);
      await sleep(300);
      await win.locator('button:has-text("Add Node")').click();
      await sleep(2000);
    }

    // Get node IDs from DOM
    nodeIds = await win.evaluate(() =>
      Array.from(document.querySelectorAll('.react-flow__node')).map(el => el.getAttribute('data-id')));
    assert.ok(nodeIds.length >= 3, `3 nodes: ${nodeIds.join(', ')}`);

    // Discover instance IDs
    const instances = await piSend(win, { type: 'get_instance_list' });
    const graphInsts = (instances?.instance_list || []).filter(i => i.instance_id.startsWith('inst_'));
    folderInstId = graphInsts.find(i => i.plugin_name === 'imgsrc_folder_plugin')?.instance_id;
    invertInstId = graphInsts.find(i => i.plugin_name === 'invert_plugin')?.instance_id;
    saverInstId = graphInsts.find(i => i.plugin_name === 'imgsaver_plugin')?.instance_id;
    assert.ok(folderInstId && invertInstId && saverInstId, 'all instances found');
    console.log(`  folder=${folderInstId}, invert=${invertInstId}, saver=${saverInstId}`);

    // Connect edges
    for (const edge of [
      { source: nodeIds[0], sourceHandle: 'out', target: nodeIds[1], targetHandle: 'in' },
      { source: nodeIds[1], sourceHandle: 'out', target: nodeIds[2], targetHandle: 'in' },
    ]) {
      await win.evaluate((e) => {
        window.dispatchEvent(new CustomEvent('graph-connect-edge', { detail: e }));
      }, edge);
      await sleep(300);
    }
    await shot(win, 'create_01_graph.png');
  });

  it('Step 3: Configure folder + saver, load graph', async () => {
    const sf = await piExchange(win, folderInstId, { command: 'set_folder', path: TEST_IMAGES });
    assert.ok(sf?.ACK && sf.file_count > 0, 'set_folder OK');
    await piExchange(win, folderInstId, { command: 'get_image' });

    await piExchange(win, saverInstId, {
      command: 'set_output',
      path: `${PROJECT_DIR}/output`,
      prefix: 'inverted',
      format: '.bmp',
    });

    // Load graph to backend
    const gl = await piSend(win, { type: 'graph_load', graph: {
      id: GRAPH_ID, name: 'Created Pipeline',
      nodes: [
        { id: nodeIds[0], name: 'Folder Source', pluginName: 'imgsrc_folder_plugin', instanceId: folderInstId },
        { id: nodeIds[1], name: 'Inverter',      pluginName: 'invert_plugin',        instanceId: invertInstId },
        { id: nodeIds[2], name: 'Output Saver',  pluginName: 'imgsaver_plugin',      instanceId: saverInstId },
      ],
      edges: [
        { fromNodeId: nodeIds[0], fromPortId: 'out', toNodeId: nodeIds[1], toPortId: 'in' },
        { fromNodeId: nodeIds[1], fromPortId: 'out', toNodeId: nodeIds[2], toPortId: 'in' },
      ],
    }});
    assert.ok(gl?.ACK, 'graph_load ACK');
  });

  it('Step 4: First execute — saver saves INVERTED image (direct input)', async () => {
    await fireGraphExecute(win, GRAPH_ID);
    const saved = await pollUntil(async () => {
      const s = await piExchange(win, saverInstId, { command: 'get_status' });
      return (s?.saved_count ?? 0) > 0;
    });
    assert.ok(saved, 'saver saved inverted image');

    const outputDir = path.join(PROJECT_DIR, 'output');
    const files = fs.existsSync(outputDir) ? fs.readdirSync(outputDir).filter(f => f.startsWith('inverted')) : [];
    console.log(`  Inverted files: ${files.length} (${files.join(', ')})`);
    assert.ok(files.length > 0, 'inverted image file exists');
    await shot(win, 'create_02_first_execute.png');
  });

  it('Step 5: Switch saver to folder source image (original)', async () => {
    // Change saver output prefix so we can distinguish files
    await piExchange(win, saverInstId, {
      command: 'set_output',
      path: `${PROJECT_DIR}/output`,
      prefix: 'original',
      format: '.bmp',
    });
    await piExchange(win, saverInstId, { command: 'reset_counter' });

    // Set data selection to folder source node
    const sel = await piExchange(win, saverInstId, {
      command: 'set_data_selection',
      selection: [{ sourceNodeId: nodeIds[0], dataPath: 'images/out' }],
    });
    assert.ok(sel?.ACK, 'set_data_selection ACK');
    console.log(`  Data selection set to: ${nodeIds[0]} (folder source) → images/out`);
  });

  it('Step 6: Second execute — saver saves ORIGINAL image (from folder source)', async () => {
    await fireGraphExecute(win, GRAPH_ID);
    const saved = await pollUntil(async () => {
      const s = await piExchange(win, saverInstId, { command: 'get_status' });
      return (s?.saved_count ?? 0) > 0;
    });
    assert.ok(saved, 'saver saved original image');

    const outputDir = path.join(PROJECT_DIR, 'output');
    const origFiles = fs.readdirSync(outputDir).filter(f => f.startsWith('original'));
    console.log(`  Original files: ${origFiles.length} (${origFiles.join(', ')})`);
    assert.ok(origFiles.length > 0, 'original image file exists');
    await shot(win, 'create_03_second_execute.png');
  });

  it('Step 7: Verify both images exist and differ', () => {
    const outputDir = path.join(PROJECT_DIR, 'output');
    const invertedFiles = fs.readdirSync(outputDir).filter(f => f.startsWith('inverted'));
    const originalFiles = fs.readdirSync(outputDir).filter(f => f.startsWith('original'));
    assert.ok(invertedFiles.length > 0, 'inverted file');
    assert.ok(originalFiles.length > 0, 'original file');

    // Read center pixels from both BMPs and verify they differ
    const inv = readBmpCenterPixel(path.join(outputDir, invertedFiles[0]));
    const orig = readBmpCenterPixel(path.join(outputDir, originalFiles[0]));
    console.log(`  Original center pixel: RGB(${orig.r},${orig.g},${orig.b})`);
    console.log(`  Inverted center pixel: RGB(${inv.r},${inv.g},${inv.b})`);

    // They should be different (inverted = 255 - original)
    const isDifferent = (orig.r !== inv.r || orig.g !== inv.g || orig.b !== inv.b);
    assert.ok(isDifferent, 'original and inverted pixels differ');

    const isInverted = (orig.r + inv.r === 255 && orig.g + inv.g === 255 && orig.b + inv.b === 255);
    console.log(`  Pixel inversion check: ${isInverted ? 'EXACT (sum=255)' : 'DIFFERENT (not exact inversion)'}`);
  });

  it('Step 8: Save project to ./test_prj', async () => {
    const PLUGIN_DIR = path.join(XAPPHUB, 'plugins', 'build').replace(/\\/g, '/');
    const PLUGIN_UI_DIR = path.join(XAPPHUB, 'plugins').replace(/\\/g, '/');

    const r = await piSend(win, { type: 'project_save', path: PROJECT_DIR, project: {
      name: 'Test Project',
      plugins: {
        imgsrc_folder_plugin: {
          dll: `${PLUGIN_DIR}/imgsrc_folder_plugin/Release/imgsrc_folder_plugin.dll`,
          ui: `${PLUGIN_UI_DIR}/imgsrc_folder_plugin/UI/index.tsx`,
        },
        invert_plugin: {
          dll: `${PLUGIN_DIR}/invert_plugin/Release/invert_plugin.dll`,
          ui: `${PLUGIN_UI_DIR}/invert_plugin/UI/index.tsx`,
        },
        imgsaver_plugin: {
          dll: `${PLUGIN_DIR}/imgsaver_plugin/Release/imgsaver_plugin.dll`,
          ui: `${PLUGIN_UI_DIR}/imgsaver_plugin/UI/index.tsx`,
        },
      },
      graphs: [{
        id: GRAPH_ID, name: 'Created Pipeline',
        nodes: [
          { id: nodeIds[0], name: 'Folder Source', pluginName: 'imgsrc_folder_plugin', instanceId: folderInstId },
          { id: nodeIds[1], name: 'Inverter',      pluginName: 'invert_plugin',        instanceId: invertInstId },
          { id: nodeIds[2], name: 'Output Saver',  pluginName: 'imgsaver_plugin',      instanceId: saverInstId },
        ],
        edges: [
          { fromNodeId: nodeIds[0], fromPortId: 'out', toNodeId: nodeIds[1], toPortId: 'in' },
          { fromNodeId: nodeIds[1], fromPortId: 'out', toNodeId: nodeIds[2], toPortId: 'in' },
        ],
      }],
    }});
    assert.ok(r?.ACK, 'project_save ACK');
    console.log(`  Project saved to: ${PROJECT_DIR}`);
  });

  it('Step 9: Verify project on disk', async () => {
    assert.ok(fs.existsSync(path.join(PROJECT_DIR, 'project.json')), 'project.json');
    const gjPath = path.join(PROJECT_DIR, 'graphs', GRAPH_ID, 'graph.json');
    assert.ok(fs.existsSync(gjPath), 'graph.json');

    // Verify saver node has data_selection pointing to folder source
    const saverNodePath = path.join(PROJECT_DIR, 'graphs', GRAPH_ID, 'nodes', nodeIds[2], 'node.json');
    const saverNode = JSON.parse(fs.readFileSync(saverNodePath, 'utf8'));
    assert.ok(saverNode.settings?.data_selection?.length > 0, 'data_selection saved');
    assert.equal(saverNode.settings.data_selection[0].sourceNodeId, nodeIds[0], 'selection points to folder');
    assert.equal(saverNode.settings.data_selection[0].dataPath, 'images/out');
    console.log(`  Saver data_selection: ${saverNode.settings.data_selection[0].sourceNodeId} → images/out`);

    // Both output images exist
    const outputDir = path.join(PROJECT_DIR, 'output');
    const allFiles = fs.readdirSync(outputDir);
    console.log(`  Output files: ${allFiles.join(', ')}`);

    console.log('\n  Project tree:');
    printTree(PROJECT_DIR, '  ');
    await shot(win, 'create_04_final.png');
  });
});

/** Read center pixel RGB from a BMP file */
function readBmpCenterPixel(filePath) {
  const d = fs.readFileSync(filePath);
  const off = d.readUInt32LE(10);
  const w = d.readInt32LE(18);
  const h = Math.abs(d.readInt32LE(22));
  const bpp = d.readUInt16LE(28);
  const bytesPerPixel = bpp / 8;
  const rowSize = Math.ceil(w * bytesPerPixel / 4) * 4;
  const mid = Math.floor(h / 2);
  const col = Math.floor(w / 2);
  const p = off + mid * rowSize + col * bytesPerPixel;
  return { b: d[p], g: d[p + 1], r: d[p + 2] };
}

/** Print directory tree for visual verification */
function printTree(dir, indent = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      console.log(`${indent}${entry.name}/`);
      printTree(full, indent + '  ');
    } else {
      const size = fs.statSync(full).size;
      console.log(`${indent}${entry.name} (${size > 1024 ? Math.round(size/1024) + 'KB' : size + 'B'})`);
    }
  }
}
