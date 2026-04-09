# Playwright E2E Testing — Common Issues & Caveats

## Running Tests

```bash
# Requires OpenCV in PATH
set PATH=C:\opencv\opencv\build\x64\vc16\bin;%PATH%

# Run one test
node --test tests/test_graph_pipeline_playwright.mjs

# Run all Playwright tests
node --test tests/test_graph_pipeline_playwright.mjs tests/test_data_selection_playwright.mjs
```

## Prerequisites

- **OpenCV DLLs** in PATH — backend crashes without them
- **Built plugin DLLs** — `cd XAppHub_APP/plugins/build && cmake --build . --config Release`
- **Built backend DLL** — `cd XAppHub_APP/backend/build && cmake --build . --config Release`
- **Copy DLLs to working dir** if needed:
  ```bash
  cp backend/build/Release/libdlib.dll backend/libdlib.dll
  cp native/build/Release/addon.node native/addon.node
  ```
- **Built frontend dist** (for prod mode) — `cd XAppHub_APP/frontend && npm run build`
- **Playwright installed** — `npm install` in the Electron repo

## Dev Mode vs Prod Mode

| | Dev | Prod |
|---|-----|------|
| Source | Vite dev server `http://127.0.0.1:5173` | `frontend/dist/index.html` |
| Detection | Electron probes `http://127.0.0.1:5173` on startup | Fallback if probe fails |
| Hot reload | Yes | No — must `npm run build` after code changes |
| Plugin UIs | Loaded via Vite @fs URLs | Loaded as IIFE bundles |

### How Electron detects dev mode

`electron/main.js` → `probeDevServer()` sends HTTP GET to `http://127.0.0.1:5173/`. If 200 → dev mode. Otherwise → prod mode (loads `dist/index.html`).

### Common: tests pass in prod but fail in dev

**Root cause 1: Vite not binding to 127.0.0.1**

Vite defaults to `localhost` which may resolve to `::1` (IPv6) on Windows. Electron probes `127.0.0.1` (IPv4). Fix in `vite.config.ts`:
```ts
server: {
  port: 5173,
  host: '127.0.0.1',  // MUST be IPv4 — Electron probes this
}
```

**Root cause 2: Port mismatch**

Electron probes port 5173. If Vite runs on a different port (e.g. 3000), the probe fails. Ensure `vite.config.ts` uses `port: 5173`.

**Root cause 3: Stale dist/ build**

If Vite isn't running, Electron loads from `dist/`. If `dist/` was built before your code changes, the test runs old code. Always `npm run build` after changes if testing in prod mode.

### Recommendation for CI / automated tests

Kill Vite before running Playwright tests to force prod mode. Prod mode is deterministic — no HMR race conditions.

```bash
# Ensure no Vite running
taskkill /F /IM node.exe 2>nul  # or be more targeted
cd XAppHub_APP/frontend && npm run build
cd ../../Electron_NAPI_SharedArrayBuffer
node --test tests/test_graph_pipeline_playwright.mjs
```

---

## Common Issues

### 1. `graph_execute` sendData Promise hangs forever

**Symptom:** `piSend(win, {type: 'graph_execute', ...})` never resolves. Test times out.

**Root cause:** `graph_execute` returns a Stage with binary BMP data (can be 60MB+). The exchange buffer round-trip takes time, and the sendData Promise waits for a matching group_id response that may not arrive before the timeout.

**Fix:** Fire-and-forget pattern — don't await the response. Poll saver status instead:
```javascript
// DON'T do this:
await piSend(win, { type: 'graph_execute', graph_id: 'g1' });

// DO this:
await win.evaluate((meta) => {
  window.__sendData?.({
    tl: 'PI', target_id: 1, is_end_of_group: true,
    content: { metadata_str: JSON.stringify(meta) }
  });
}, { type: 'graph_execute', graph_id: 'g1' });

// Then poll for completion:
await pollUntil(async () => {
  const s = await piExchange(win, 'saver', { command: 'get_status' });
  return (s?.saved_count ?? 0) > 0;
});
```

### 2. `waitForEvent('filechooser')` times out

**Symptom:** Clicking "Load Config" doesn't trigger the filechooser event.

**Possible causes:**
- App hasn't finished mounting React — increase initial `sleep()` in `before()`
- Button text doesn't match the selector — check with DevTools
- In dev mode, HMR re-renders can swallow the click

**Fix:** Ensure the app is fully loaded before interacting:
```javascript
await win.waitForLoadState('load');
await sleep(3000);  // let React mount fully
```

### 3. Hardcoded instance IDs break after node identity refactor

**Symptom:** Edge connections fail, `piExchange` gets NACK.

**Root cause:** "Add Node" via the UI now generates `inst_{hex}` instance IDs (random). Old tests hardcoded `imgsrc_folder_plugin_1`.

**Fix:** Don't use "Add Node" UI for programmatic tests. Use `piGraphLoad` with the config's known instance IDs:
```javascript
// Config creates instances: folder_src, inverter, saver
// Use piGraphLoad to build the graph referencing those IDs
await piSend(win, { type: 'graph_load', graph: {
  id: 'g1', name: 'Test',
  nodes: [
    { id: 'n1', name: 'Src', pluginName: 'imgsrc_folder_plugin', instanceId: 'folder_src' },
    // ...
  ],
  edges: [...]
}});
```

### 4. `page.evaluate: Target crashed` or `Target page, context or browser has been closed`

**Symptom:** Electron renderer process crashes during test.

**Possible causes:**
- **Stale DLL** — `backend/libdlib.dll` or plugin DLLs built before code changes. Copy freshly built DLLs.
- **Out of memory** — unlikely with shared_ptr Stage copies, but check if you're allocating huge buffers.
- **Infinite render loop** — React component causes "Maximum update depth exceeded" which crashes the renderer.

**Fix:** Rebuild DLLs and copy to working dirs:
```bash
cd XAppHub_APP/backend/build && cmake --build . --config Release
cp Release/libdlib.dll ../libdlib.dll

cd ../../plugins/build && cmake --build . --config Release
```

### 5. `piExchange` returns ACK:false for new commands

**Symptom:** New exchangeCMD commands (e.g. `get_upstream_outputs`) return `ACK:false` / "unknown command".

**Root cause:** Plugin DLL on disk is the old version without the new command. The C++ source was changed but the DLL wasn't rebuilt.

**Fix:** Rebuild the plugin and ensure the correct DLL is loaded:
```bash
cd XAppHub_APP/plugins/build
cmake --build . --config Release --target imgsaver_plugin
```

### 6. DLL locked — can't rebuild while Electron is running

**Symptom:** `LNK1104: cannot open file '...plugin.dll'`

**Root cause:** Electron loaded the DLL and holds a lock.

**Fix:** Kill Electron first, then rebuild:
```bash
taskkill /F /IM electron.exe
cmake --build . --config Release
```

### 7. Plugins loaded count never reaches expected

**Symptom:** `waitForPluginCount(win, 3)` times out. Status button shows fewer plugins.

**Possible causes:**
- DLL path in config is wrong — check `e2e_graph_pipeline_config.json` paths
- Plugin DLL missing or failed to build
- Backend failed to load DLL (missing OpenCV dependency)

**Fix:** Check console errors:
```javascript
win.on('console', msg => {
  if (msg.type() === 'error') console.log('ERR:', msg.text());
});
```

---

## Reliability Patterns

### Use `pollUntil` instead of `sleep`

```javascript
async function pollUntil(fn, maxMs = 15000, intervalMs = 500) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  return false;
}
```

### Add timeout to `piSend`

```javascript
async function piSend(win, meta, timeoutMs = 10000) {
  return win.evaluate(async ({ meta, timeoutMs }) => {
    const sendData = window.__sendData;
    const packet = { tl: 'PI', target_id: 1, is_end_of_group: true,
      content: { metadata_str: JSON.stringify(meta) } };
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('piSend timeout')), timeoutMs));
    const resp = await Promise.race([sendData(packet), timeout]);
    return resp[0]?.content?.metadata_parsed;
  }, { meta, timeoutMs });
}
```

### Use `__sendData` for programmatic control

The app exposes `window.__sendData` (the exchange client's sendData function) for testing. Use it to send PI commands without clicking UI buttons:
```javascript
await piSend(win, { type: 'graph_load', graph: graphDef });
await piExchange(win, 'folder_src', { command: 'set_folder', path: '/images' });
```

### Screenshot at key steps

```javascript
async function shot(win, name) {
  const p = path.join(SCREENSHOT_DIR, name);
  await win.screenshot({ path: p });
}
```
Screenshots go to `xInsp/screenshot/`. Useful for debugging failures.

### Separate test concerns

- **Config loading** → tests the UI (file chooser, button click)
- **Graph operations** → use `piSend`/`piExchange` (faster, deterministic)
- **Execution** → fire-and-forget + poll status
- **Verification** → check files on disk, query backend state

---

## File Locations

| File | Purpose |
|------|---------|
| `tests/test_graph_pipeline_playwright.mjs` | Basic pipeline: load → graph → execute → verify |
| `tests/test_data_selection_playwright.mjs` | Upstream data selection: execute → query → select → re-execute |
| `tests/e2e_graph_pipeline_config.json` | Config with 3 plugins (in XAppHub_APP/tests/) |
| `xInsp/screenshot/` | Test screenshots output |
| `xInsp/test_images/` | 5 BMP test images (checker, colorbars, gradients, radial) |

## Config JSON (e2e_graph_pipeline_config.json)

The config creates these instances on the backend:

| instance_id | plugin_name |
|-------------|-------------|
| `folder_src` | imgsrc_folder_plugin |
| `inverter` | invert_plugin |
| `saver` | imgsaver_plugin |

Use these IDs in `piGraphLoad` and `piExchange` calls. Do NOT depend on "Add Node" UI-generated IDs.
