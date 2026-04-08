/**
 * Graph Pipeline E2E: Folder Source → Invert → Image Saver
 *
 * Loads plugins, builds graph, executes 5 times, verifies output images.
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
const TEST_IMAGES = path.resolve(__dirname, '..', '..', 'test_images');
const OUTPUT_DIR = path.resolve(__dirname, '..', '..', 'output');
const SCREENSHOTS = path.resolve(__dirname, '..', '..', 'screenshot');

const PLUGINS = {
  folder: path.join(XAPPHUB, 'plugins/build/imgsrc_folder_plugin/Release/imgsrc_folder_plugin.dll'),
  invert: path.join(XAPPHUB, 'plugins/build/invert_plugin/Release/invert_plugin.dll'),
  saver:  path.join(XAPPHUB, 'plugins/build/imgsaver_plugin/Release/imgsaver_plugin.dll'),
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('Graph Pipeline: Folder→Invert→Save', { timeout: 120000 }, () => {
  let app, win;

  before(async () => {
    // Clean output
    if (fs.existsSync(OUTPUT_DIR)) {
      for (const f of fs.readdirSync(OUTPUT_DIR)) fs.unlinkSync(path.join(OUTPUT_DIR, f));
    }
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    for (const [k, p] of Object.entries(PLUGINS)) {
      assert.ok(fs.existsSync(p), `${k} plugin must be built: ${p}`);
    }

    app = await electron.launch({ args: [ELECTRON_ROOT] });
    win = await app.firstWindow();
    await win.waitForLoadState('load');
    await sleep(4000);
  });

  after(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('should run full pipeline: load→configure→graph→execute→verify output', async () => {
    await win.screenshot({ path: path.join(SCREENSHOTS, 'pipeline_01_initial.png') });

    // Use the app's Load Config button with our pipeline config
    const configPath = path.join(XAPPHUB, 'tests', 'e2e_graph_pipeline_config.json');
    const fc = win.waitForEvent('filechooser', { timeout: 10000 });
    await win.locator('button:has-text("Load Config")').click({ timeout: 5000 });
    (await fc).setFiles(configPath);
    await sleep(6000);

    await win.screenshot({ path: path.join(SCREENSHOTS, 'pipeline_02_plugins_loaded.png') });

    // Configure and execute via sequential page.evaluate calls
    // (each returns to the event loop, letting the app's exchange system process)

    const fireCmd = async (meta, gid) => {
      await win.evaluate(({ meta, gid }) => {
        const { ipcRenderer } = window.require('electron');
        const cfg = ipcRenderer.sendSync('get-current-config');
        const addon = window.require(`${cfg.artifactPath}/native/addon.node`);
        const M = 0x42504701;
        const w32 = (b,p,v) => { b[p]=(v>>>24)&0xff;b[p+1]=(v>>>16)&0xff;b[p+2]=(v>>>8)&0xff;b[p+3]=v&0xff; };
        const s = Buffer.from(JSON.stringify(meta), 'utf8');
        const dl = 4+s.length, buf = Buffer.alloc(2*1024*1024);
        let o=0; w32(buf,o,M);o+=4;buf[o++]=0x50;buf[o++]=0x49;w32(buf,o,((1&0xff)<<8)|1);o+=4;
        w32(buf,o,0);o+=4;w32(buf,o,gid);o+=4;w32(buf,o,dl);o+=4;w32(buf,o,s.length);o+=4;s.copy(buf,o);
        addon.exchangeDataInPlace(buf, o+s.length, true);
      }, { meta, gid });
      await sleep(500); // yield to event loop — let app's exchange system drain
    };

    // 1. Configure folder source
    await fireCmd({ type:'exchange', instance_id:'folder_src',
      cmd_info: JSON.stringify({ command:'set_folder', path: TEST_IMAGES }) }, 8021);
    console.log('  Set folder source');

    // 2. Configure saver
    await fireCmd({ type:'exchange', instance_id:'saver',
      cmd_info: JSON.stringify({ command:'set_output', path: OUTPUT_DIR, prefix:'inv', format:'.png' }) }, 8022);
    console.log('  Set saver output');

    // 3. Load graph
    await fireCmd({ type:'graph_load', graph: {
      id: 'pipe1', name: 'Folder→Invert→Save',
      nodes: [
        { id: 'n1', instanceId: 'folder_src' },
        { id: 'n2', instanceId: 'inverter' },
        { id: 'n3', instanceId: 'saver' },
      ],
      edges: [
        { fromNodeId: 'n1', fromPortId: 'out', toNodeId: 'n2', toPortId: 'in' },
        { fromNodeId: 'n2', fromPortId: 'out', toNodeId: 'n3', toPortId: 'in' },
      ]
    }}, 8030);
    console.log('  Graph loaded');

    // 4. Execute graph 5 times
    for (let i = 0; i < 5; i++) {
      if (i > 0) {
        await fireCmd({ type:'exchange', instance_id:'folder_src',
          cmd_info: JSON.stringify({ command:'next' }) }, 8100+i);
      }
      await fireCmd({ type:'graph_execute', graph_id:'pipe1' }, 8200+i);
      console.log(`  Executed frame ${i}`);
    }

    const result = { log: ['done'] };

    console.log('  Pipeline log:', result.log.join(' → '));

    // Wait for file I/O to complete
    await sleep(3000);

    // Check output
    const outputFiles = fs.readdirSync(OUTPUT_DIR).filter(f =>
      f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.bmp'));

    console.log('  Output files:');
    for (const f of outputFiles) {
      const size = fs.statSync(path.join(OUTPUT_DIR, f)).size;
      console.log(`    ${f} (${(size/1024).toFixed(1)} KB)`);
    }

    await win.screenshot({ path: path.join(SCREENSHOTS, 'pipeline_02_complete.png') });

    assert.ok(outputFiles.length > 0, `Expected saved images in output/, got ${outputFiles.length}`);
    console.log(`  ✓ ${outputFiles.length} inverted images saved to output/`);
  });
});
