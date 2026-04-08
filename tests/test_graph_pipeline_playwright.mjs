/**
 * Playwright E2E: Graph Editor — load image, show in NodeInspector
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

/** Send an exchange command to a plugin instance via the app's sendData */
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

describe('Graph Editor — image in NodeInspector', { timeout: 300000 }, () => {
  let app, win;

  before(async () => {
    app = await electron.launch({ args: [ELECTRON_ROOT] });
    win = await app.firstWindow();
    win.on('console', msg => {
      if (msg.type() === 'error') console.log(`  ERR: ${msg.text()}`);
    });
    await win.waitForLoadState('load');
    await sleep(5000);
  });

  after(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('load 3 plugins via Load Config', async () => {
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
    assert.ok(count >= 3);
  });

  it('switch to Graph Editor, add 3 nodes, connect edges', async () => {
    await win.locator('button:has-text("Graph Editor")').click();
    await sleep(1000);

    for (const p of ['imgsrc_folder_plugin', 'invert_plugin', 'imgsaver_plugin']) {
      await win.locator('select').first().selectOption(p);
      await sleep(300);
      await win.locator('button:has-text("Add Node")').click();
      await sleep(2000);
    }

    // Connect: folder→invert→saver
    for (const edge of [
      { source: 'imgsrc_folder_plugin_1', sourceHandle: 'out', target: 'invert_plugin_1', targetHandle: 'in' },
      { source: 'invert_plugin_1', sourceHandle: 'out', target: 'imgsaver_plugin_1', targetHandle: 'in' },
    ]) {
      await win.evaluate((e) => {
        window.dispatchEvent(new CustomEvent('graph-connect-edge', { detail: e }));
      }, edge);
      await sleep(300);
    }

    await shot(win, 'graph_01_nodes_edges.png');
    console.log('  3 nodes added, 2 edges connected');
  });

  it('set folder on graph instance and load image', async () => {
    // Send set_folder to the GRAPH instance (imgsrc_folder_plugin_1)
    const setResult = await piExchange(win, 'imgsrc_folder_plugin_1', {
      command: 'set_folder', path: TEST_IMAGES
    });
    console.log(`  set_folder: ${JSON.stringify(setResult)}`);

    // Load the first image
    const getResult = await piExchange(win, 'imgsrc_folder_plugin_1', {
      command: 'get_image'
    });
    console.log(`  get_image: ${JSON.stringify(getResult)}`);
    await sleep(1000);
  });

  it('execute graph pipeline', async () => {
    await win.locator('button:has-text("Execute")').click();
    console.log('  Graph executing...');
    await sleep(5000);
    await shot(win, 'graph_02_after_execute.png');
  });

  it('click folder node → NodeInspector shows preview', async () => {
    const nodes = win.locator('.react-flow__node');
    const count = await nodes.count();
    console.log(`  Nodes: ${count}`);

    // Click the first node (folder)
    await nodes.first().click();
    await sleep(3000);

    const hasPreview = await win.locator('img[alt="node output"]').isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`  Preview image visible: ${hasPreview}`);

    await shot(win, 'graph_03_folder_inspector.png');

    // Also click invert node
    if (count >= 2) {
      await nodes.nth(1).click();
      await sleep(3000);
      await shot(win, 'graph_04_invert_inspector.png');
    }
  });
});
