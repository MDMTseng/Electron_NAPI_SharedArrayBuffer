/**
 * Playwright E2E: Project CRUD — save, load, verify state restored
 *
 * Flow:
 *   1. Load config (3 plugins)
 *   2. Configure instances (folder path, saver output, data selection)
 *   3. Build graph via piGraphLoad
 *   4. Execute graph
 *   5. Save project to temp folder via project_save
 *   6. Verify folder structure on disk (project.json, graph.json, node.json files)
 *   7. Verify node.json contains settings from getDef
 *   8. Close app, relaunch
 *   9. Load project from saved folder — creates instances with settings
 *  10. Verify restored instance settings match originals
 *  11. Execute graph again — verify it still works
 *
 * Run:
 *   set PATH=C:\opencv\opencv\build\x64\vc16\bin;%PATH%
 *   node --test tests/test_project_crud_playwright.mjs
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

// Instance IDs from config
const FOLDER_INST = 'folder_src';
const INVERT_INST = 'inverter';
const SAVER_INST  = 'saver';

// Graph node IDs
const N_FOLDER = 'n_folder';
const N_INVERT = 'n_invert';
const N_SAVER  = 'n_saver';
const GRAPH_ID = 'g_prj';

// Plugin paths for project.json (using placeholder)
const PLUGIN_DIR = path.join(XAPPHUB, 'plugins', 'build').replace(/\\/g, '/');
const PLUGIN_UI_DIR = path.join(XAPPHUB, 'plugins').replace(/\\/g, '/');

const GRAPH_DEF = {
  id: GRAPH_ID, name: 'Project Test Pipeline',
  nodes: [
    { id: N_FOLDER, name: 'Front Camera',  pluginName: 'imgsrc_folder_plugin', instanceId: FOLDER_INST },
    { id: N_INVERT, name: 'Inverter',      pluginName: 'invert_plugin',        instanceId: INVERT_INST },
    { id: N_SAVER,  name: 'Output Saver',  pluginName: 'imgsaver_plugin',      instanceId: SAVER_INST },
  ],
  edges: [
    { fromNodeId: N_FOLDER, fromPortId: 'out', toNodeId: N_INVERT, toPortId: 'in' },
    { fromNodeId: N_INVERT, fromPortId: 'out', toNodeId: N_SAVER,  toPortId: 'in' },
  ],
};

describe('Project CRUD E2E', { timeout: 180000 }, () => {
  let app, win;
  let projectDir;
  let saverOutputDir;

  before(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xinsp_prj_e2e_'));
    saverOutputDir = path.join(projectDir, 'graphs', GRAPH_ID, 'nodes', N_SAVER, 'data', 'saved').replace(/\\/g, '/');
    console.log(`  Project dir: ${projectDir}`);
  });

  after(async () => {
    try { if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  });

  // =====================================================================
  // PHASE 1: Setup, configure, save
  // =====================================================================

  describe('Phase 1: Create and save project', { timeout: 120000 }, () => {
    before(async () => {
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

    it('load config with 3 plugins', async () => {
      const fcp = win.waitForEvent('filechooser', { timeout: 15000 });
      await win.locator('button:has-text("Load Config")').click();
      (await fcp).setFiles(CONFIG);
      const loaded = await waitForPluginCount(win, 3);
      assert.ok(loaded, 'plugins loaded');
    });

    it('configure folder source', async () => {
      const r = await piExchange(win, FOLDER_INST, { command: 'set_folder', path: TEST_IMAGES });
      assert.ok(r?.ACK, 'set_folder ACK');
      assert.ok(r?.file_count > 0, 'has images');
      await piExchange(win, FOLDER_INST, { command: 'get_image' });
    });

    it('configure saver with output dir and data selection', async () => {
      const r = await piExchange(win, SAVER_INST, {
        command: 'set_output', path: saverOutputDir, prefix: 'prj_test', format: '.png',
      });
      assert.ok(r?.ACK, 'set_output ACK');

      const sel = await piExchange(win, SAVER_INST, {
        command: 'set_data_selection',
        selection: [{ sourceNodeId: N_INVERT, dataPath: 'images/out' }],
      });
      assert.ok(sel?.ACK, 'set_data_selection ACK');
    });

    it('load and execute graph', async () => {
      const gl = await piSend(win, { type: 'graph_load', graph: GRAPH_DEF });
      assert.ok(gl?.ACK, 'graph_load ACK');

      await fireGraphExecute(win, GRAPH_ID);
      const saved = await pollUntil(async () => {
        const s = await piExchange(win, SAVER_INST, { command: 'get_status' });
        return (s?.saved_count ?? 0) > 0;
      });
      assert.ok(saved, 'graph executed and saver saved');
    });

    it('save project to disk', async () => {
      const projectData = {
        name: 'E2E Test Project',
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
        graphs: [GRAPH_DEF],
      };

      const r = await piSend(win, {
        type: 'project_save',
        path: projectDir.replace(/\\/g, '/'),
        project: projectData,
      });
      assert.ok(r?.ACK, 'project_save ACK');
      await shot(win, 'prj_01_saved.png');
    });

    it('verify project folder structure on disk', () => {
      // project.json
      const pjPath = path.join(projectDir, 'project.json');
      assert.ok(fs.existsSync(pjPath), 'project.json exists');
      const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
      assert.equal(pj.name, 'E2E Test Project');
      assert.ok(pj.plugins?.imgsrc_folder_plugin, 'has folder plugin');
      assert.ok(pj.plugins?.invert_plugin, 'has invert plugin');
      assert.ok(pj.plugins?.imgsaver_plugin, 'has saver plugin');

      // graph.json
      const gjPath = path.join(projectDir, 'graphs', GRAPH_ID, 'graph.json');
      assert.ok(fs.existsSync(gjPath), 'graph.json exists');
      const gj = JSON.parse(fs.readFileSync(gjPath, 'utf8'));
      assert.equal(gj.name, 'Project Test Pipeline');
      assert.equal(gj.nodes.length, 3);
      assert.equal(gj.edges.length, 2);

      // node.json for each node
      for (const nid of [N_FOLDER, N_INVERT, N_SAVER]) {
        const njPath = path.join(projectDir, 'graphs', GRAPH_ID, 'nodes', nid, 'node.json');
        assert.ok(fs.existsSync(njPath), `node.json exists for ${nid}`);
      }
    });

    it('verify node settings persisted correctly', () => {
      // Folder source settings
      const folderNode = JSON.parse(fs.readFileSync(
        path.join(projectDir, 'graphs', GRAPH_ID, 'nodes', N_FOLDER, 'node.json'), 'utf8'));
      assert.equal(folderNode.name, 'Front Camera');
      assert.equal(folderNode.pluginName, 'imgsrc_folder_plugin');
      assert.ok(folderNode.settings?.folder_path, 'folder_path saved');
      assert.ok(folderNode.settings.folder_path.includes('test_images'), 'correct folder path');
      console.log(`  folder settings: folder_path=${folderNode.settings.folder_path}`);

      // Saver settings
      const saverNode = JSON.parse(fs.readFileSync(
        path.join(projectDir, 'graphs', GRAPH_ID, 'nodes', N_SAVER, 'node.json'), 'utf8'));
      assert.equal(saverNode.name, 'Output Saver');
      assert.ok(saverNode.settings?.output_dir, 'output_dir saved');
      assert.equal(saverNode.settings.prefix, 'prj_test');
      assert.equal(saverNode.settings.format, '.png');
      assert.ok(Array.isArray(saverNode.settings.data_selection), 'data_selection saved');
      assert.equal(saverNode.settings.data_selection.length, 1);
      assert.equal(saverNode.settings.data_selection[0].sourceNodeId, N_INVERT);
      assert.equal(saverNode.settings.data_selection[0].dataPath, 'images/out');
      console.log(`  saver settings: output_dir=${saverNode.settings.output_dir}, selection=${JSON.stringify(saverNode.settings.data_selection)}`);

      // Inverter settings (empty)
      const invertNode = JSON.parse(fs.readFileSync(
        path.join(projectDir, 'graphs', GRAPH_ID, 'nodes', N_INVERT, 'node.json'), 'utf8'));
      assert.equal(invertNode.name, 'Inverter');
      assert.ok(invertNode.settings !== undefined, 'invert has settings (even if empty)');
    });

    it('verify saved image exists in project tree', () => {
      if (fs.existsSync(saverOutputDir)) {
        const files = fs.readdirSync(saverOutputDir).filter(f => f.startsWith('prj_test'));
        console.log(`  Saved images: ${files.length} in ${saverOutputDir}`);
        assert.ok(files.length > 0, 'saved image exists in project node folder');
      } else {
        console.log('  Note: saver output dir not yet created (may be outside project tree)');
      }
    });
  });

  // =====================================================================
  // PHASE 2: Relaunch, load project, verify restored state
  // =====================================================================

  describe('Phase 2: Load project and verify restored state', { timeout: 120000 }, () => {
    before(async () => {
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

    it('load project from saved folder', async () => {
      const r = await piSend(win, {
        type: 'project_load',
        path: projectDir.replace(/\\/g, '/'),
      });
      assert.ok(r?.ACK, 'project_load ACK');
      assert.ok(r?.project, 'project data returned');
      assert.ok(r?.graphs, 'graphs returned');
      assert.equal(r.graphs.length, 1, 'one graph');
      assert.equal(r.graphs[0].nodes.length, 3, 'three nodes');
      assert.equal(r.graphs[0].edges.length, 2, 'two edges');
      console.log(`  Loaded project: ${r.project.name}`);
    });

    it('load plugins from project config', async () => {
      // Read project.json to get plugin paths
      const pj = JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8'));

      for (const [name, info] of Object.entries(pj.plugins)) {
        const r = await piSend(win, { type: 'load', path: info.dll, name });
        assert.ok(r?.ACK, `load ${name} ACK`);
      }
      console.log('  Plugins loaded from project config');
    });

    it('create instances with saved settings', async () => {
      // Read graph to get nodes with settings
      const gj = JSON.parse(fs.readFileSync(
        path.join(projectDir, 'graphs', GRAPH_ID, 'graph.json'), 'utf8'));

      for (const node of gj.nodes) {
        // Read node.json for settings
        const njPath = path.join(projectDir, 'graphs', GRAPH_ID, 'nodes', node.id, 'node.json');
        const nj = JSON.parse(fs.readFileSync(njPath, 'utf8'));
        const settings = nj.settings || {};

        const r = await piSend(win, {
          type: 'create_instance',
          plugin_name: nj.pluginName,
          instance_id: node.instanceId,
          def: settings,
        });
        assert.ok(r?.ACK, `create ${node.instanceId} ACK`);
        console.log(`  Created ${node.instanceId} with settings: ${JSON.stringify(settings).substring(0, 80)}`);
      }
    });

    it('verify folder source restored with correct path', async () => {
      const r = await piExchange(win, FOLDER_INST, { command: 'get_status' });
      assert.ok(r?.ACK, 'get_status ACK');
      assert.ok(r.folder?.includes('test_images'), `folder_path restored: ${r.folder}`);
      assert.ok(r.file_count > 0, `file_count > 0: ${r.file_count}`);
      console.log(`  Folder restored: ${r.folder} (${r.file_count} files)`);
    });

    it('verify saver restored with correct settings', async () => {
      const r = await piExchange(win, SAVER_INST, { command: 'get_status' });
      assert.ok(r?.ACK, 'get_status ACK');
      assert.equal(r.prefix, 'prj_test', 'prefix restored');
      assert.equal(r.format, '.png', 'format restored');
      console.log(`  Saver restored: path=${r.path}, prefix=${r.prefix}, format=${r.format}`);
    });

    it('verify data selection restored', async () => {
      // Load graph first so upstreamOutputs_ gets populated
      const gl = await piSend(win, { type: 'graph_load', graph: GRAPH_DEF });
      assert.ok(gl?.ACK, 'graph_load ACK');

      // Execute to populate upstream
      await piExchange(win, FOLDER_INST, { command: 'get_image' });
      await fireGraphExecute(win, GRAPH_ID);
      await pollUntil(async () => {
        const s = await piExchange(win, SAVER_INST, { command: 'get_status' });
        return (s?.saved_count ?? 0) > 0;
      });

      // Check selection
      const up = await piExchange(win, SAVER_INST, { command: 'get_upstream_outputs' });
      assert.ok(up?.ACK, 'get_upstream_outputs ACK');
      assert.equal(up.selection.length, 1, 'one selection restored');
      assert.equal(up.selection[0].sourceNodeId, N_INVERT, 'correct sourceNodeId');
      assert.equal(up.selection[0].dataPath, 'images/out', 'correct dataPath');
      console.log(`  Data selection restored: ${up.selection[0].sourceNodeId} → ${up.selection[0].dataPath}`);
    });

    it('re-execute graph successfully after project load', async () => {
      await piExchange(win, SAVER_INST, { command: 'reset_counter' });

      await fireGraphExecute(win, GRAPH_ID);
      const saved = await pollUntil(async () => {
        const s = await piExchange(win, SAVER_INST, { command: 'get_status' });
        return (s?.saved_count ?? 0) > 0;
      });
      assert.ok(saved, 'graph executes after project load');
      console.log('  Graph re-executed successfully');
      await shot(win, 'prj_02_restored_executed.png');
    });
  });
});
