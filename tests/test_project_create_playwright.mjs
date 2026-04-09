/**
 * Playwright E2E: Create project from scratch via UI
 *
 * Flow:
 *   1. Load config (3 plugins)
 *   2. Switch to Graph Editor
 *   3. Add 3 nodes via UI (imgsrc, invert, saver)
 *   4. Connect edges via programmatic events
 *   5. Configure folder source + saver
 *   6. Execute graph
 *   7. Save project to ./test_prj
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
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_ROOT = path.resolve(__dirname, '..');
const XAPPHUB = path.resolve(__dirname, '..', '..', 'XAppHub_APP');
const CONFIG = path.join(XAPPHUB, 'tests', 'e2e_graph_pipeline_config.json');
const TEST_IMAGES = path.resolve(__dirname, '..', '..', 'test_images').replace(/\\/g, '/');
const SCREENSHOT_DIR = path.resolve(__dirname, '..', '..', 'screenshot');
const PROJECT_DIR = path.resolve(__dirname, '..', '..', 'test_prj').replace(/\\/g, '/');

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

describe('Create project from UI → save to ./test_prj', { timeout: 120000 }, () => {
  let app, win;

  // Track the instance IDs created by "Add Node" (they are inst_{hex})
  let folderInstId, invertInstId, saverInstId;
  // Track graph node IDs (from React Flow DOM)
  let nodeIds = [];

  before(async () => {
    // Clean previous test_prj
    if (fs.existsSync(PROJECT_DIR)) {
      fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
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

  it('Step 1: Load config with 3 plugins', async () => {
    const fcp = win.waitForEvent('filechooser', { timeout: 15000 });
    await win.locator('button:has-text("Load Config")').click();
    (await fcp).setFiles(CONFIG);
    const loaded = await waitForPluginCount(win, 3);
    assert.ok(loaded, 'plugins loaded');
    await shot(win, 'create_01_config.png');
  });

  it('Step 2: Switch to Graph Editor', async () => {
    await win.locator('button:has-text("Graph Editor")').click();
    await sleep(1000);
    await shot(win, 'create_02_graph_tab.png');
  });

  it('Step 3: Add 3 nodes via UI', async () => {
    for (const pluginName of ['imgsrc_folder_plugin', 'invert_plugin', 'imgsaver_plugin']) {
      await win.locator('select').first().selectOption(pluginName);
      await sleep(300);
      await win.locator('button:has-text("Add Node")').click();
      await sleep(2000);
    }

    // Verify 3 nodes in React Flow
    const count = await win.locator('.react-flow__node').count();
    console.log(`  Nodes in graph: ${count}`);
    assert.ok(count >= 3, `expected >= 3 nodes, got ${count}`);

    // Get React Flow node IDs (these are the graph node IDs, e.g. hex IDs)
    nodeIds = await win.evaluate(() => {
      return Array.from(document.querySelectorAll('.react-flow__node'))
        .map(el => el.getAttribute('data-id'));
    });
    console.log(`  Node IDs: ${nodeIds.join(', ')}`);

    // Discover instance IDs from the backend
    const instances = await piSend(win, { type: 'get_instance_list' });
    const instList = instances?.instance_list || [];
    console.log(`  Backend instances: ${instList.map(i => i.instance_id).join(', ')}`);

    // Match by plugin name — the "Add Node" created them in order
    folderInstId = instList.find(i => i.plugin_name === 'imgsrc_folder_plugin')?.instance_id;
    invertInstId = instList.find(i => i.plugin_name === 'invert_plugin')?.instance_id;
    saverInstId = instList.find(i => i.plugin_name === 'imgsaver_plugin')?.instance_id;

    // Filter to only inst_ prefixed (graph-created, not config-created)
    const graphInsts = instList.filter(i => i.instance_id.startsWith('inst_'));
    if (graphInsts.length >= 3) {
      folderInstId = graphInsts.find(i => i.plugin_name === 'imgsrc_folder_plugin')?.instance_id;
      invertInstId = graphInsts.find(i => i.plugin_name === 'invert_plugin')?.instance_id;
      saverInstId = graphInsts.find(i => i.plugin_name === 'imgsaver_plugin')?.instance_id;
    }

    console.log(`  folder=${folderInstId}, invert=${invertInstId}, saver=${saverInstId}`);
    assert.ok(folderInstId, 'folder instance created');
    assert.ok(invertInstId, 'invert instance created');
    assert.ok(saverInstId, 'saver instance created');

    await shot(win, 'create_03_nodes_added.png');
  });

  it('Step 4: Connect edges (folder→invert→saver)', async () => {
    assert.ok(nodeIds.length >= 3, 'have node IDs');

    // Connect: node[0]→node[1], node[1]→node[2]
    for (const edge of [
      { source: nodeIds[0], sourceHandle: 'out', target: nodeIds[1], targetHandle: 'in' },
      { source: nodeIds[1], sourceHandle: 'out', target: nodeIds[2], targetHandle: 'in' },
    ]) {
      await win.evaluate((e) => {
        window.dispatchEvent(new CustomEvent('graph-connect-edge', { detail: e }));
      }, edge);
      await sleep(300);
    }

    const edgeCount = await win.evaluate(() =>
      document.querySelectorAll('.react-flow__edge').length);
    console.log(`  Edges: ${edgeCount}`);
    assert.ok(edgeCount >= 2, `expected >= 2 edges, got ${edgeCount}`);

    await shot(win, 'create_04_edges.png');
  });

  it('Step 5: Configure folder source and saver', async () => {
    // Set folder
    const sf = await piExchange(win, folderInstId, { command: 'set_folder', path: TEST_IMAGES });
    assert.ok(sf?.ACK, 'set_folder ACK');
    console.log(`  set_folder: ${sf.file_count} files`);

    // Load first image
    await piExchange(win, folderInstId, { command: 'get_image' });

    // Set saver output to project node folder
    const saverOutput = `${PROJECT_DIR}/output`;
    const ss = await piExchange(win, saverInstId, {
      command: 'set_output', path: saverOutput, prefix: 'result', format: '.png',
    });
    assert.ok(ss?.ACK, 'set_output ACK');
    console.log(`  set_output: ${saverOutput}`);
  });

  it('Step 6: Execute graph', async () => {
    // Build graph def from discovered IDs and load it
    const graphDef = {
      id: 'g_create', name: 'Created Pipeline',
      nodes: [
        { id: nodeIds[0], name: 'Folder Source',  pluginName: 'imgsrc_folder_plugin', instanceId: folderInstId },
        { id: nodeIds[1], name: 'Inverter',       pluginName: 'invert_plugin',        instanceId: invertInstId },
        { id: nodeIds[2], name: 'Output Saver',   pluginName: 'imgsaver_plugin',      instanceId: saverInstId },
      ],
      edges: [
        { fromNodeId: nodeIds[0], fromPortId: 'out', toNodeId: nodeIds[1], toPortId: 'in' },
        { fromNodeId: nodeIds[1], fromPortId: 'out', toNodeId: nodeIds[2], toPortId: 'in' },
      ],
    };
    const gl = await piSend(win, { type: 'graph_load', graph: graphDef });
    assert.ok(gl?.ACK, 'graph_load ACK');

    await fireGraphExecute(win, 'g_create');
    const saved = await pollUntil(async () => {
      const s = await piExchange(win, saverInstId, { command: 'get_status' });
      return (s?.saved_count ?? 0) > 0;
    });
    assert.ok(saved, 'saver saved image');

    await shot(win, 'create_05_executed.png');
  });

  it('Step 7: Save project to ./test_prj', async () => {
    const PLUGIN_DIR = path.join(XAPPHUB, 'plugins', 'build').replace(/\\/g, '/');
    const PLUGIN_UI_DIR = path.join(XAPPHUB, 'plugins').replace(/\\/g, '/');

    const projectData = {
      name: 'Test Project (UI Created)',
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
        id: 'g_create', name: 'Created Pipeline',
        nodes: [
          { id: nodeIds[0], name: 'Folder Source',  pluginName: 'imgsrc_folder_plugin', instanceId: folderInstId },
          { id: nodeIds[1], name: 'Inverter',       pluginName: 'invert_plugin',        instanceId: invertInstId },
          { id: nodeIds[2], name: 'Output Saver',   pluginName: 'imgsaver_plugin',      instanceId: saverInstId },
        ],
        edges: [
          { fromNodeId: nodeIds[0], fromPortId: 'out', toNodeId: nodeIds[1], toPortId: 'in' },
          { fromNodeId: nodeIds[1], fromPortId: 'out', toNodeId: nodeIds[2], toPortId: 'in' },
        ],
      }],
    };

    const r = await piSend(win, { type: 'project_save', path: PROJECT_DIR, project: projectData });
    assert.ok(r?.ACK, 'project_save ACK');
    console.log(`  Project saved to: ${PROJECT_DIR}`);
    await shot(win, 'create_06_saved.png');
  });

  it('Step 8: Verify project on disk', () => {
    // project.json
    assert.ok(fs.existsSync(path.join(PROJECT_DIR, 'project.json')), 'project.json');
    const pj = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.json'), 'utf8'));
    assert.equal(pj.name, 'Test Project (UI Created)');

    // graph.json
    const gjPath = path.join(PROJECT_DIR, 'graphs', 'g_create', 'graph.json');
    assert.ok(fs.existsSync(gjPath), 'graph.json');
    const gj = JSON.parse(fs.readFileSync(gjPath, 'utf8'));
    assert.equal(gj.nodes.length, 3);
    assert.equal(gj.edges.length, 2);

    // node.json for each node
    for (const nid of nodeIds) {
      const njPath = path.join(PROJECT_DIR, 'graphs', 'g_create', 'nodes', nid, 'node.json');
      assert.ok(fs.existsSync(njPath), `node.json for ${nid}`);
      const nj = JSON.parse(fs.readFileSync(njPath, 'utf8'));
      assert.ok(nj.settings, `settings present for ${nid}`);
      console.log(`  ${nid}: name=${nj.name}, plugin=${nj.pluginName}`);
    }

    // output folder has saved image
    const outputDir = path.join(PROJECT_DIR, 'output');
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir).filter(f => f.startsWith('result'));
      console.log(`  Output images: ${files.length}`);
    }

    console.log('\n  Project tree:');
    printTree(PROJECT_DIR, '  ');
  });
});

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
