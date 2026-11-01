// Regression checks for async state races in the store (src/lib/store.ts): stale simulate /
// trace / analyst responses after Restore world or Reset demo, demo steps that outlive Exit,
// mid-session engine failover to the offline snapshot, and scenario-scoped analyst replays.
// Needs both dev servers and Playwright:  NODE_PATH=$(npm root -g) node scripts/e2e-races.cjs
// Engine latency, stalls and outages are simulated with Playwright request routing.
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info) => { results.push({ name, ok, info }); console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(info ?? '')); };

async function open(routeFn) {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (routeFn) await routeFn(page);
  await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__deeptraceStore && ['live', 'snapshot', 'error'].includes(window.__deeptraceStore.getState().dataMode), null, { timeout: 120000 });
  await page.waitForFunction(() => window.__deeptraceStore.getState().snapshot, null, { timeout: 60000 });
  return { browser, page, errors };
}

const delays = {}; // url-substring -> ms (mutable from tests)
const bodyDelays = {}; // request-body substring (e.g. a preset's scenario_id) -> ms, checked first
let blockEngine = false;
let stallChat = false;
let failSim = false; // /api/simulate answers HTTP 500
let failCompare = false; // /api/compare answers HTTP 500
let chatReply = null; // scripted SSE body for /api/analyst/chat (an LLM-style answer)
async function routes(page) {
  await page.route('http://localhost:8000/**', async (route) => {
    const url = route.request().url();
    if (blockEngine) return route.abort('connectionrefused');
    if (stallChat && url.includes('/api/analyst/chat')) return; // never respond
    // decided when the request is made, not when its delay ends
    const fail = (failSim && url.includes('/api/simulate')) || (failCompare && url.includes('/api/compare'));
    const reply = chatReply && url.includes('/api/analyst/chat') ? chatReply : null;
    const body = route.request().postData() || '';
    const byBody = Object.entries(bodyDelays).find(([k]) => body.includes(k));
    if (byBody) await sleep(byBody[1]);
    else for (const [k, ms] of Object.entries(delays)) if (url.includes(k)) { await sleep(ms); break; }
    try {
      if (fail) return await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'injected failure' }) });
      if (reply) return await route.fulfill({ status: 200, contentType: 'text/event-stream', body: reply });
      await route.continue();
    } catch {}
  });
}
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

(async () => {
  const { browser, page, errors } = await open(routes);
  const S = (fn, arg) => page.evaluate(fn, arg);
  const reset = async () => { for (const k of Object.keys(delays)) delete delays[k]; for (const k of Object.keys(bodyDelays)) delete bodyDelays[k]; blockEngine = false; stallChat = false; failSim = false; failCompare = false; chatReply = null;
    await S(() => { const s = window.__deeptraceStore.getState(); s.exitDemo(); s.clearChat(); s.restoreWorld(); }); await sleep(300); };

  // [0]/[32] Restore during a running simulation
  await reset(); delays['/api/simulate'] = 2500;
  await S(() => { const s = window.__deeptraceStore.getState(); const p = s.presets.find((x) => x.id === 'A-DS-FIVEPOINTS'); window.__p = s.runSimulation(p.scenario, 'A'); });
  await sleep(300); await S(() => window.__deeptraceStore.getState().restoreWorld());
  await S(() => window.__p);
  let st = await S(() => { const s = window.__deeptraceStore.getState(); return { result: s.result?.scenario_id ?? null, slotA: s.slots.A?.scenario_id ?? null, sim: s.panels.simulation, status: s.simStatus }; });
  check('[0/32] stale simulate dropped after Restore world', !st.result && !st.slotA && !st.sim && st.status === 'idle', st);

  // [0] overlapping runs: a slow older run must not replace a newer one
  await reset(); delays['/api/simulate'] = 2000;
  await S(() => { const s = window.__deeptraceStore.getState(); window.__pa = s.runSimulation(s.presets.find((x) => x.id === 'A-DS-FIVEPOINTS').scenario); });
  await sleep(400); delays['/api/simulate'] = 100;
  await S(() => { const s = window.__deeptraceStore.getState(); window.__pc = s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario); });
  await S(() => Promise.all([window.__pa, window.__pc]));
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { result: s.result?.scenario_id, status: s.simStatus }; });
  check('[0] newest run wins over a slower older one', st.result === 'C-WATER-MAIN-DECATUR' && st.status === 'idle', st);

  // [1]/[28b] analyst stream cancelled by Start demo
  await reset(); delays['/api/analyst/chat'] = 2500;
  await S(() => { const s = window.__deeptraceStore.getState(); s.selectNode('PWR-DS-FIVEPOINTS'); window.__pq = s.sendAnalystMessage('What happens if this fails?', { forceOffline: true }); });
  await sleep(300); await S(() => window.__deeptraceStore.getState().startDemo());
  st = await S(() => ({ pending: window.__deeptraceStore.getState().analystPending }));
  const pendingRightAfter = st.pending;
  await sleep(3500);
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { result: s.result?.scenario_id ?? null, msgs: s.messages.length, step: s.demo.step, pending: s.analystPending }; });
  check('[1] Start demo cancels the in-flight analyst answer', !pendingRightAfter && !st.result && st.msgs === 0 && st.step === 0, { pendingRightAfter, ...st });

  // [2] Exit demo during reveal_layers: layers stay as the user set them
  await reset(); delays['/api/simulate'] = 0;
  await S(() => { const s = window.__deeptraceStore.getState(); s.startDemo(); });
  await sleep(200);
  await S(() => { window.__pr = window.__deeptraceStore.getState().demoGoto(2); });
  await sleep(800);
  await S(() => { const s = window.__deeptraceStore.getState(); s.exitDemo(); s.setAllLayers(true); s.setLayer('water', false); });
  await sleep(4000);
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { water: s.layers.water, active: s.demo.active }; });
  check('[2] exited reveal_layers step stops changing layers', st.water === false && !st.active, st);

  // [28a] Reset demo during the simulate step
  await reset(); delays['/api/simulate'] = 2000;
  await S(() => { const s = window.__deeptraceStore.getState(); s.startDemo(); });
  await sleep(200);
  await S(() => { window.__pd = window.__deeptraceStore.getState().demoGoto(5); });
  await sleep(300); await S(() => window.__deeptraceStore.getState().resetDemo());
  await sleep(3000);
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { step: s.demo.step, result: s.result?.scenario_id ?? null, slotA: s.slots.A?.scenario_id ?? null, busy: s.demo.busy }; });
  check('[28] Reset demo mid-step: stale step does not write into the reset world', st.step === 0 && !st.result && !st.slotA, st);

  // [7]/[31] trace response for a node no longer selected is dropped
  await reset(); delays['/api/trace/PWR-DS-FIVEPOINTS'] = 1500;
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.selectNode('PWR-DS-FIVEPOINTS'); window.__pt = s.showTrace('PWR-DS-FIVEPOINTS'); });
  await sleep(200); await S(() => window.__deeptraceStore.getState().selectNode('PWR-TS-SOUTH'));
  await S(() => window.__pt); await sleep(300);
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { sel: s.selectedNodeId, vis: s.traceVisible, tn: s.trace?.node_id ?? null }; });
  check('[7/31] slow trace for a deselected node is not shown', st.sel === 'PWR-TS-SOUTH' && !(st.vis && st.tn === 'PWR-DS-FIVEPOINTS'), st);
  // hide during in-flight follow-trace
  delete delays['/api/trace/PWR-DS-FIVEPOINTS']; delays['/api/trace/'] = 1200;
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.selectNode('TEL-HUB-GSU', { trace: false }); });
  delete delays['/api/trace/']; await S(() => window.__deeptraceStore.getState().showTrace('TEL-HUB-GSU'));
  delays['/api/trace/'] = 1200;
  await S(() => { window.__ps = window.__deeptraceStore.getState().selectNode('PWR-TS-SOUTH'); });
  await sleep(400); await S(() => window.__deeptraceStore.getState().hideTrace());
  await S(() => window.__ps); await sleep(200);
  st = await S(() => ({ vis: window.__deeptraceStore.getState().traceVisible }));
  check('[31] Hide trace is not undone by an in-flight follow-trace', st.vis === false, st);

  // [4] highlight cleared on new run
  await reset(); delete delays['/api/trace/'];
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.runSimulation(s.presets.find((x) => x.id === 'A-DS-FIVEPOINTS').scenario);
    s.setHighlight({ node_ids: ['FAC-CITYHALL'], edge_ids: [], label: 'Critical facilities affected', tone: 'critical', source: 'user' });
    await window.__deeptraceStore.getState().runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario); });
  st = await S(() => ({ hl: window.__deeptraceStore.getState().highlight }));
  check('[4] a new simulation clears the previous result highlight', st.hl === null, st);

  // [14]/[36]/[12] restore resets overlays and ends demo
  await reset();
  await S(() => { const s = window.__deeptraceStore.getState(); s.startDemo(); s.setShowDependencies(false); s.setShowParticles(false); s.setShowLabels(false); s.setDepthScale(1); s.restoreWorld(); });
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { dep: s.showDependencies, part: s.showParticles, lab: s.showLabels, depth: s.depthScale, demo: s.demo.active }; });
  check('[12/14/36] Restore world resets overlays/depth and ends the demo', st.dep && st.part && st.lab && st.depth === 8 && !st.demo, st);
  await S(() => { const s = window.__deeptraceStore.getState(); s.startDemo(); s.setPanel('layers', true); s.resetDemo(); });
  st = await S(() => ({ layersPanel: window.__deeptraceStore.getState().panels.layers }));
  check('[36] Reset demo hides the explorer like Start demo', st.layersPanel === false, st);
  await S(() => window.__deeptraceStore.getState().exitDemo());

  // [6] compare keeps slot identity
  await reset();
  await S(async () => { const s = window.__deeptraceStore.getState();
    await s.runSimulation(s.presets.find((x) => x.id === 'A-DS-FIVEPOINTS').scenario, 'A');
    await window.__deeptraceStore.getState().runSimulation(s.presets.find((x) => x.id === 'B-EDGEWOOD-DUCTBANK').scenario, 'B');
    await window.__deeptraceStore.getState().runComparison(); });
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { isB: s.result === s.slots.B, cmp: !!s.comparison, view: s.compareView }; });
  check('[6] after Compare the displayed result is still slot B', st.isB && st.cmp && st.view === 'diff', st);

  // [34] ask_ai waits for an in-flight answer instead of skipping its question
  await reset(); delays['/api/analyst/chat'] = 1500;
  await S(async () => { const s = window.__deeptraceStore.getState(); s.startDemo(); await new Promise((r) => setTimeout(r, 200)); await window.__deeptraceStore.getState().demoGoto(5); });
  await S(() => { const s = window.__deeptraceStore.getState(); s.sendAnalystMessage('Which component is the most important in this network?', { forceOffline: true }); });
  await sleep(100);
  await S(() => window.__deeptraceStore.getState().demoGoto(7));
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { qs: s.messages.filter((m) => m.role === 'user').map((m) => m.content), step: s.demo.step, busy: s.demo.busy }; });
  check('[34] demo ask_ai step asks its question after waiting', st.qs.length === 2 && st.qs[1].startsWith('Why did this happen') && !st.busy, st);
  await S(() => window.__deeptraceStore.getState().exitDemo());

  // [35] stalled stream can be stopped
  await reset(); stallChat = true;
  await S(() => { window.__deeptraceStore.getState().sendAnalystMessage('Which component is the most important in this network?', { forceOffline: true }); });
  await sleep(1500);
  const before = await S(() => window.__deeptraceStore.getState().analystPending);
  await S(() => window.__deeptraceStore.getState().stopAnalyst());
  st = await S(() => { const s = window.__deeptraceStore.getState(); const last = s.messages[s.messages.length - 1]; return { pending: s.analystPending, lastPending: !!last?.pending, err: last?.error }; });
  check('[35] Stop ends a stalled answer', before === true && !st.pending && !st.lastPending, { before, ...st });
  stallChat = false;

  // R2: Exit demo while the simulate step's request is in flight -> it is dropped, no spinner
  await reset(); delays['/api/simulate'] = 2500;
  await S(async () => { window.__deeptraceStore.getState().startDemo(); await new Promise((r) => setTimeout(r, 200)); window.__pd = window.__deeptraceStore.getState().demoGoto(5); });
  await sleep(400);
  await S(() => window.__deeptraceStore.getState().exitDemo());
  const rightAfterExit = await S(() => window.__deeptraceStore.getState().simStatus);
  await S(() => window.__pd); await sleep(2600);
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { result: s.result?.scenario_id ?? null, slotA: s.slots.A?.scenario_id ?? null, sim: s.panels.simulation, playing: s.playback.playing, status: s.simStatus }; });
  check('R2 Exit demo drops the simulate step\'s in-flight run', rightAfterExit === 'idle' && !st.result && !st.slotA && !st.sim && !st.playing && st.status === 'idle', { rightAfterExit, ...st });

  // R2: Exit demo while the compare step's request is in flight
  await reset();
  await S(async () => { const s = window.__deeptraceStore.getState(); s.startDemo(); await new Promise((r) => setTimeout(r, 200)); await window.__deeptraceStore.getState().demoGoto(5); await window.__deeptraceStore.getState().demoGoto(8); });
  delays['/api/compare'] = 2500;
  await S(() => { window.__pd = window.__deeptraceStore.getState().demoGoto(9); });
  await sleep(400);
  await S(() => window.__deeptraceStore.getState().exitDemo());
  const cmpAfterExit = await S(() => window.__deeptraceStore.getState().compareStatus);
  await S(() => window.__pd); await sleep(2600);
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { cmp: !!s.comparison, view: s.compareView, panel: s.panels.comparison, status: s.compareStatus }; });
  check('R2 Exit demo drops the compare step\'s in-flight comparison', cmpAfterExit === 'idle' && !st.cmp && st.view !== 'diff' && !st.panel && st.status === 'idle', { cmpAfterExit, ...st });

  // R2: Exit demo mid reveal_layers turns the layers it had not revealed yet back on
  await reset();
  await S(async () => { window.__deeptraceStore.getState().startDemo(); await new Promise((r) => setTimeout(r, 200)); window.__pd = window.__deeptraceStore.getState().demoGoto(2); });
  await sleep(1300);
  await S(() => window.__deeptraceStore.getState().exitDemo());
  st = await S(() => window.__deeptraceStore.getState().layers);
  check('R2 Exit mid reveal_layers leaves every layer on', Object.values(st).every(Boolean), st);

  // R2: a comparison that lands after slot A was re-run keeps the newer run
  await reset();
  await S(async () => { const s = window.__deeptraceStore.getState(); const P = (id) => s.presets.find((x) => x.id === id).scenario;
    await s.runSimulation(P('A-DS-FIVEPOINTS'), 'A'); await window.__deeptraceStore.getState().runSimulation(P('B-EDGEWOOD-DUCTBANK'), 'B'); });
  delays['/api/compare'] = 2500;
  await S(() => { window.__pc = window.__deeptraceStore.getState().runComparison(); });
  await sleep(200);
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario, 'A'); });
  await S(() => window.__pc);
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { slotA: s.slots.A?.scenario_id, result: s.result?.scenario_id, cmp: !!s.comparison, view: s.compareView, status: s.compareStatus }; });
  check('R2 slow comparison does not overwrite a newer slot run', st.slotA === 'C-WATER-MAIN-DECATUR' && st.result === 'C-WATER-MAIN-DECATUR' && st.cmp && st.view !== 'diff' && st.status === 'idle', st);

  // R2: show_comparison that moves the displayed result also moves playback
  await reset();
  st = await S(async () => { const s = window.__deeptraceStore.getState(); const P = (id) => s.presets.find((x) => x.id === id).scenario;
    await s.runSimulation(P('C-WATER-MAIN-DECATUR'), 'A'); await window.__deeptraceStore.getState().runSimulation(P('B-EDGEWOOD-DUCTBANK'), 'B');
    window.__deeptraceStore.getState().showSlot('A');
    const c = await (await fetch('http://localhost:8000/api/compare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario_a: P('F-TS-SOUTH'), scenario_b: P('B-EDGEWOOD-DUCTBANK') }) })).json();
    window.__deeptraceStore.getState().applyUIAction({ kind: 'show_comparison', comparison: c, node_ids: [], edge_ids: [] });
    const t = window.__deeptraceStore.getState(); const max = Math.max(0, ...t.result.affected_nodes.map((a) => a.step ?? 0));
    return { result: t.result.scenario_id, isA: t.result === t.slots.A, maxStep: t.playback.maxStep, resultMax: max }; });
  check('R2 show_comparison resets playback to the result it shows', st.result === 'F-TS-SOUTH' && st.isA && st.maxStep >= st.resultMax, st);

  // R2: a failed slot run that a newer run overlapped still reports its error
  await reset(); delays['/api/simulate'] = 1500;
  await S(() => { const s = window.__deeptraceStore.getState(); window.__pa = s.runSimulation({ failed_nodes: ['NO-SUCH-NODE'], failed_edges: [], horizon_hours: 4, enable_restoration: true }, 'A'); });
  await sleep(200); delays['/api/simulate'] = 0;
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario); });
  await S(() => window.__pa);
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { slotA: s.slots.A?.scenario_id ?? null, err: s.simError, result: s.result?.scenario_id, status: s.simStatus }; });
  check('R2 overlapped failed slot run is reported', !st.slotA && /^Scenario A failed/.test(st.err ?? '') && st.result === 'C-WATER-MAIN-DECATUR' && st.status === 'idle', st);

  // R2: clearSimulation during a comparison does not leave its spinner on
  await reset();
  await S(async () => { const s = window.__deeptraceStore.getState(); const P = (id) => s.presets.find((x) => x.id === id).scenario;
    await s.runSimulation(P('A-DS-FIVEPOINTS'), 'A'); await window.__deeptraceStore.getState().runSimulation(P('B-EDGEWOOD-DUCTBANK'), 'B'); });
  delays['/api/compare'] = 1500;
  await S(() => { window.__pc = window.__deeptraceStore.getState().runComparison(); });
  await sleep(200);
  await S(() => window.__deeptraceStore.getState().clearSimulation());
  await S(() => window.__pc);
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { status: s.compareStatus, cmp: !!s.comparison }; });
  check('R2 clearSimulation settles an in-flight comparison', st.status === 'idle' && !st.cmp, st);

  // R3: a slot run started just BEFORE Compare that lands during the comparison keeps its slot
  await reset();
  await S(async () => { const s = window.__deeptraceStore.getState(); const P = (id) => s.presets.find((x) => x.id === id).scenario;
    await s.runSimulation(P('A-DS-FIVEPOINTS'), 'A'); await window.__deeptraceStore.getState().runSimulation(P('B-EDGEWOOD-DUCTBANK'), 'B'); });
  delays['/api/simulate'] = 1500;
  await S(() => { const s = window.__deeptraceStore.getState(); window.__pa = s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario, 'A'); });
  await sleep(250); delays['/api/compare'] = 3000;
  await S(() => { window.__pc = window.__deeptraceStore.getState().runComparison(); });
  await S(() => Promise.all([window.__pa, window.__pc]));
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { slotA: s.slots.A?.scenario_id, result: s.result?.scenario_id, view: s.compareView, cmpA: s.comparison?.scenario_a.scenario_id }; });
  check('R3 slot run started before Compare keeps its slot', st.slotA === 'C-WATER-MAIN-DECATUR' && st.result === 'C-WATER-MAIN-DECATUR' && st.view !== 'diff' && st.cmpA === 'A-DS-FIVEPOINTS', st);

  // R3: a slot re-run that FAILS during the comparison does not block the diff view
  await reset();
  await S(async () => { const s = window.__deeptraceStore.getState(); const P = (id) => s.presets.find((x) => x.id === id).scenario;
    await s.runSimulation(P('A-DS-FIVEPOINTS'), 'A'); await window.__deeptraceStore.getState().runSimulation(P('B-EDGEWOOD-DUCTBANK'), 'B'); });
  delays['/api/compare'] = 2000;
  await S(() => { window.__pc = window.__deeptraceStore.getState().runComparison(); });
  await sleep(200);
  await S(() => window.__deeptraceStore.getState().runSimulation({ failed_nodes: ['NO-SUCH-NODE'], failed_edges: [], horizon_hours: 4, enable_restoration: true }, 'A'));
  await S(() => window.__pc);
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { slotA: s.slots.A?.scenario_id, view: s.compareView, cmp: !!s.comparison }; });
  check('R3 failed re-run during a comparison still shows the diff', st.slotA === 'A-DS-FIVEPOINTS' && st.view === 'diff' && st.cmp, st);

  // R3: tracing (inspector button or analyst show_trace) leaves the diff view, which hides traces;
  // the highlight chip's "show" button keeps keyboard focus inside the chip
  await S(async () => { await window.__deeptraceStore.getState().selectNode('PWR-DS-FIVEPOINTS', { fly: false }); });
  const traceBtn = page.getByRole('button', { name: 'Trace', exact: true });
  await traceBtn.waitFor({ timeout: 30000 }); await traceBtn.click();
  await page.waitForFunction(() => window.__deeptraceStore.getState().traceVisible, null, { timeout: 30000 });
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { view: s.compareView, trace: s.trace?.node_id }; });
  check('R3 inspector Trace leaves the A/B diff view', st.view !== 'diff' && st.trace === 'PWR-DS-FIVEPOINTS', st);
  st = await S(() => { const s = window.__deeptraceStore.getState(); const tr = s.trace; s.hideTrace(); s.setCompareView('diff');
    s.applyUIAction({ kind: 'show_trace', trace: tr, node_ids: [], edge_ids: [] }); const t = window.__deeptraceStore.getState(); return { view: t.compareView, vis: t.traceVisible }; });
  check('R3 analyst show_trace leaves the A/B diff view', st.view !== 'diff' && st.vis, st);
  await S(() => { const s = window.__deeptraceStore.getState(); s.hideTrace(); s.setCompareView('diff'); s.setHighlight({ node_ids: ['PWR-DS-FIVEPOINTS'], edge_ids: [], label: 'Focus test', tone: 'info', source: 'ai' }); });
  const showBtn = page.locator('button', { hasText: 'hidden in A/B diff' }).first();
  await showBtn.waitFor({ timeout: 30000 }); await showBtn.focus(); await page.keyboard.press('Enter');
  await sleep(300);
  st = await S(() => ({ view: window.__deeptraceStore.getState().compareView, focus: document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName, hl: !!window.__deeptraceStore.getState().highlight }));
  check('R3 highlight chip "show" leaves the diff and keeps focus in the chip', st.view !== 'diff' && st.focus === 'status' && st.hl, st);
  await page.keyboard.press('Tab');
  st = await S(() => document.activeElement?.getAttribute('aria-label'));
  check('R4 Tab from the chip reaches its Clear button', st === 'Clear highlight', { focus: st });

  // R4: a mouse click on "show" then Space plays the cascade (focus is not left on Clear)
  await S(() => { const s = window.__deeptraceStore.getState(); s.setCompareView('diff'); s.setPlaying(false); s.setHighlight({ node_ids: ['PWR-DS-FIVEPOINTS'], edge_ids: [], label: 'Focus test', tone: 'info', source: 'ai' }); });
  const showBtn2 = page.locator('button', { hasText: 'hidden in A/B diff' }).first();
  await showBtn2.waitFor({ timeout: 30000 }); await showBtn2.click();
  await sleep(200); await page.keyboard.press(' ');
  await sleep(200);
  st = await S(() => { const s = window.__deeptraceStore.getState(); const a = document.activeElement; return { hl: !!s.highlight, playing: s.playback.playing, view: s.compareView, focus: a?.tagName, ring: !!a && a !== document.body && a.matches(':focus-visible') }; });
  check('R4 click "show", then Space plays instead of clearing the highlight (no focus ring)', st.hl && st.playing && st.view !== 'diff' && !st.ring, st);

  // R5: a mouse click on the chip's label does not focus it (no ring after the next shortcut key)
  await page.locator('[role=status]', { hasText: 'Highlight:' }).first().click();
  await page.keyboard.press('ArrowRight');
  st = await S(() => { const a = document.activeElement; return { focus: a?.tagName, ring: !!a && a !== document.body && a.matches(':focus-visible') }; });
  check('R5 clicking the highlight label leaves no focus ring', st.focus === 'BODY' && !st.ring, st);
  // screen readers may send a click with detail 1 and no pointer press: still treated as keyboard use
  await S(() => { const s = window.__deeptraceStore.getState(); s.setCompareView('diff'); });
  const showBtn3 = page.locator('button', { hasText: 'hidden in A/B diff' }).first();
  await showBtn3.waitFor({ timeout: 30000 });
  st = await S(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('hidden in A/B diff'));
    b.focus(); b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    return new Promise((r) => setTimeout(() => r({ view: window.__deeptraceStore.getState().compareView, focus: document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName }), 200)); });
  check('R5 a screen-reader style click on "show" keeps focus in the chip', st.view !== 'diff' && st.focus === 'status', st);

  // R4: an analyst comparison answering an earlier question does not count as a newer slot run
  await reset();
  await S(async () => { const s = window.__deeptraceStore.getState(); const P = (id) => s.presets.find((x) => x.id === id).scenario;
    await s.runSimulation(P('C-WATER-MAIN-DECATUR'), 'A'); await window.__deeptraceStore.getState().runSimulation(P('B-EDGEWOOD-DUCTBANK'), 'B'); });
  delays['/api/analyst/chat'] = 3000;
  await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('Compare scenario A and B'); });
  await sleep(200);
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.runSimulation(s.presets.find((x) => x.id === 'A-DS-FIVEPOINTS').scenario, 'A'); });
  delays['/api/compare'] = 6000;
  await S(() => { window.__pc = window.__deeptraceStore.getState().runComparison(); });
  await S(() => window.__pq);
  const analystCmp = await S(() => window.__deeptraceStore.getState().comparison?.scenario_a.scenario_id ?? null);
  await S(() => window.__pc);
  st = { analystCmp, ...(await S(() => { const s = window.__deeptraceStore.getState(); return { slotA: s.slots.A?.scenario_id, result: s.result?.scenario_id, cmpA: s.comparison?.scenario_a.scenario_id, view: s.compareView }; })) };
  // (analyst answers are ordered at question time: the answer's comparison shows while the Compare
  // started after asking is in flight, then that newer Compare replaces it and owns the slots)
  check('R4/R6 a Compare started after asking replaces the analyst\'s comparison when it lands', st.analystCmp === 'C-WATER-MAIN-DECATUR' && st.slotA === 'A-DS-FIVEPOINTS' && st.result === 'A-DS-FIVEPOINTS' && st.cmpA === 'A-DS-FIVEPOINTS' && st.view === 'diff', st);

  const P2 = async (a, b) => S(async ([x, y]) => { const s = window.__deeptraceStore.getState(); const P = (id) => s.presets.find((p) => p.id === id).scenario;
    await s.runSimulation(P(x), 'A'); await window.__deeptraceStore.getState().runSimulation(P(y), 'B'); }, [a, b]);
  const snap = () => S(() => { const s = window.__deeptraceStore.getState(); return { slotA: s.slots.A?.scenario_id ?? null, result: s.result?.scenario_id ?? null, resultFailed: s.result?.scenario.failed_nodes ?? [], cmpA: s.comparison?.scenario_a.scenario_id ?? null, view: s.compareView, simStatus: s.simStatus, compareStatus: s.compareStatus }; });

  // R6 race 1: a Compare started BEFORE asking does not replace the analyst's comparison when it lands
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  delays['/api/compare'] = 6000;
  await S(() => { window.__pc = window.__deeptraceStore.getState().runComparison(); });
  await sleep(200);
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario, 'A'); });
  await S(() => window.__deeptraceStore.getState().sendAnalystMessage('Compare scenario A and B'));
  const afterAnswer = await snap();
  await S(() => window.__pc);
  st = { afterAnswer, final: await snap() };
  check('R6 an older in-flight Compare does not replace the analyst\'s comparison', afterAnswer.cmpA === 'C-WATER-MAIN-DECATUR' && afterAnswer.compareStatus === 'idle' && st.final.cmpA === 'C-WATER-MAIN-DECATUR' && st.final.slotA === 'C-WATER-MAIN-DECATUR' && st.final.view === 'diff' && st.final.compareStatus === 'idle', st);

  // R6 race 2: the analyst's comparison (computed from the slots it was given) keeps a slot you re-ran after asking
  await reset(); await P2('C-WATER-MAIN-DECATUR', 'B-EDGEWOOD-DUCTBANK');
  delays['/api/analyst/chat'] = 3000;
  await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('Compare scenario A and B'); });
  await sleep(200);
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.runSimulation(s.presets.find((x) => x.id === 'A-DS-FIVEPOINTS').scenario, 'A'); });
  await S(() => window.__pq);
  st = await snap();
  check('R6 the analyst\'s comparison does not overwrite a slot re-run after asking', st.slotA === 'A-DS-FIVEPOINTS' && st.result === 'A-DS-FIVEPOINTS' && st.cmpA === 'C-WATER-MAIN-DECATUR' && st.view !== 'diff', st);

  // R6 race 3: the analyst's simulation is newer than a run started before asking...
  await reset();
  await S(async () => { await window.__deeptraceStore.getState().selectNode('PWR-DS-FIVEPOINTS', { fly: false }); });
  delays['/api/simulate'] = 4000;
  await S(() => { const s = window.__deeptraceStore.getState(); window.__pr = s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario); });
  await sleep(200);
  await S(() => window.__deeptraceStore.getState().sendAnalystMessage('What happens if this fails?'));
  const afterSim = await snap();
  await S(() => window.__pr);
  st = { afterSim, final: await snap() };
  check('R6 a run started before asking does not replace the analyst\'s simulation', afterSim.resultFailed.includes('PWR-DS-FIVEPOINTS') && afterSim.simStatus === 'idle' && st.final.resultFailed.includes('PWR-DS-FIVEPOINTS') && st.final.simStatus === 'idle', st);

  // ...including a slot it fills (an older in-flight run for that slot does not overwrite it)
  await reset();
  const rAds = await S(async () => { const s = window.__deeptraceStore.getState(); const sc = s.presets.find((x) => x.id === 'A-DS-FIVEPOINTS').scenario;
    return (await fetch('http://localhost:8000/api/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sc) })).json(); });
  delays['/api/simulate'] = 3000;
  await S(() => { const s = window.__deeptraceStore.getState(); window.__pa = s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario, 'A'); });
  await sleep(200);
  await S((r) => window.__deeptraceStore.getState().applyUIAction({ kind: 'show_simulation', result: r, slot: 'A', node_ids: [], edge_ids: [] }), rAds);
  await S(() => window.__pa);
  st = await snap();
  check('R6 an analyst slot write is newer than an in-flight run for that slot', st.slotA === 'A-DS-FIVEPOINTS' && st.result === 'A-DS-FIVEPOINTS' && st.simStatus === 'idle', st);

  // ...but never replaces a run you started after asking
  await reset();
  await S(async () => { await window.__deeptraceStore.getState().selectNode('PWR-DS-FIVEPOINTS', { fly: false }); });
  delays['/api/analyst/chat'] = 3000;
  await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('What happens if this fails?'); });
  await sleep(200);
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario); });
  await S(() => window.__pq);
  st = await S(() => { const s = window.__deeptraceStore.getState(); const m = s.messages[s.messages.length - 1]; return { result: s.result?.scenario_id, answered: !!m?.content && !m?.pending }; });
  check('R6 the analyst\'s simulation does not replace a run started after asking', st.result === 'C-WATER-MAIN-DECATUR' && st.answered, st);

  // R7: a slot run started before asking does not take the map from the analyst's comparison
  // (it still fills its own slot as data, so the comparison shows as stale)
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  delays['/api/simulate'] = 5000;
  await S(() => { const s = window.__deeptraceStore.getState(); window.__pr = s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario, 'A'); });
  await sleep(200);
  await S(() => window.__deeptraceStore.getState().sendAnalystMessage('Compare scenario A and B'));
  const r7a = await snap();
  await S(() => window.__pr);
  st = { afterAnswer: r7a, final: await snap() };
  check('R7 an older slot run lands in its slot but not over the analyst\'s diff', r7a.view === 'diff' && r7a.cmpA === 'A-DS-FIVEPOINTS' && r7a.simStatus === 'running' && st.final.view === 'diff' && st.final.cmpA === 'A-DS-FIVEPOINTS' && st.final.slotA === 'C-WATER-MAIN-DECATUR' && st.final.simStatus === 'idle', st);

  // R7: ...and an older active run is dropped (its spinner clears when the answer takes the map)
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  delays['/api/simulate'] = 5000;
  await S(() => { const s = window.__deeptraceStore.getState(); window.__pr = s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario); });
  await sleep(200);
  await S(() => window.__deeptraceStore.getState().sendAnalystMessage('Compare scenario A and B'));
  const r7b = await snap();
  await S(() => window.__pr);
  st = { afterAnswer: r7b, final: await snap() };
  check('R7 an older active run does not replace the analyst\'s diff', r7b.view === 'diff' && r7b.simStatus === 'idle' && st.final.view === 'diff' && st.final.result === 'B-EDGEWOOD-DUCTBANK' && st.final.simStatus === 'idle', st);

  // R7: the analyst's comparison does not switch the map to its diff over a run started after asking
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  delays['/api/analyst/chat'] = 3000;
  await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('Compare scenario A and B'); });
  await sleep(200);
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario); });
  await S(() => window.__pq);
  st = await snap();
  check('R7 the analyst\'s comparison is stored without its diff over a newer run', st.result === 'C-WATER-MAIN-DECATUR' && st.view !== 'diff' && st.cmpA === 'A-DS-FIVEPOINTS', st);

  // R7: a Compare started before asking stores its comparison but does not hide the analyst's simulation
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  await S(async () => { await window.__deeptraceStore.getState().selectNode('PWR-DS-FIVEPOINTS', { fly: false }); });
  delays['/api/compare'] = 5000;
  await S(() => { window.__pc = window.__deeptraceStore.getState().runComparison(); });
  await sleep(200);
  await S(() => window.__deeptraceStore.getState().sendAnalystMessage('What happens if this fails?'));
  const r7d = await snap();
  await S(() => window.__pc);
  st = { afterAnswer: r7d, final: await snap() };
  check('R7 an older Compare does not hide the analyst\'s simulation', r7d.resultFailed.includes('PWR-DS-FIVEPOINTS') && st.final.resultFailed.includes('PWR-DS-FIVEPOINTS') && st.final.view !== 'diff' && st.final.cmpA === 'A-DS-FIVEPOINTS' && st.final.compareStatus === 'idle', st);

  // R7: a run or Compare started after asking that FAILS does not hold the answer back
  await reset();
  await S(async () => { await window.__deeptraceStore.getState().selectNode('PWR-DS-FIVEPOINTS', { fly: false }); });
  delays['/api/analyst/chat'] = 3000;
  await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('What happens if this fails?'); });
  await sleep(200); failSim = true;
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario); });
  failSim = false;
  const failedStatus = await S(() => window.__deeptraceStore.getState().simStatus);
  await S(() => window.__pq);
  st = { failedStatus, ...(await snap()) };
  check('R7 a failed run started after asking does not suppress the analyst\'s simulation', failedStatus === 'error' && st.resultFailed.includes('PWR-DS-FIVEPOINTS'), st);
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  delays['/api/analyst/chat'] = 3000;
  await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('Compare scenario A and B'); });
  await sleep(200); failCompare = true;
  await S(() => window.__deeptraceStore.getState().runComparison());
  failCompare = false;
  const failedCmp = await S(() => window.__deeptraceStore.getState().compareStatus);
  await S(() => window.__pq);
  st = { failedCmp, ...(await snap()) };
  check('R7 a failed Compare started after asking does not suppress the analyst\'s comparison', failedCmp === 'error' && st.cmpA === 'A-DS-FIVEPOINTS' && st.view === 'diff', st);

  // R7: when a run started after asking already took the map, the answer's highlight is not drawn on it
  await reset();
  const rAds2 = await S(async () => { const s = window.__deeptraceStore.getState(); const sc = s.presets.find((x) => x.id === 'A-DS-FIVEPOINTS').scenario;
    return (await fetch('http://localhost:8000/api/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sc) })).json(); });
  chatReply = sse([
    { type: 'status', mode: 'llm', model: 'scripted' },
    { type: 'tool_call', id: 't1', name: 'run_failure_simulation', input: {} },
    { type: 'tool_result', id: 't1', ok: true, summary: 'simulated' },
    { type: 'ui_action', action: { kind: 'show_simulation', result: rAds2, slot: 'active', node_ids: [], edge_ids: [] } },
    { type: 'ui_action', action: { kind: 'highlight', node_ids: rAds2.affected_nodes.map((n) => n.node_id), edge_ids: [], label: 'Affected components', tone: 'critical' } },
    { type: 'message', text: 'If DS-2 Five Points fails, the modelled cascade affects several components.' },
    { type: 'done', tool_calls: 1, mode: 'llm' },
  ]);
  delays['/api/analyst/chat'] = 3000;
  await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('What happens if Five Points fails?'); });
  await sleep(200);
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario); });
  await S(() => window.__pq);
  st = await S(() => { const s = window.__deeptraceStore.getState(); const m = s.messages[s.messages.length - 1]; return { result: s.result?.scenario_id, hl: s.highlight?.label ?? null, answered: !!m?.content && !m?.pending }; });
  check('R7 a suppressed answer\'s highlight is not drawn over a newer run', st.result === 'C-WATER-MAIN-DECATUR' && st.hl === null && st.answered, st);
  // control: with no newer run, the same scripted answer shows its simulation and its highlight
  await reset();
  chatReply = sse([
    { type: 'status', mode: 'llm', model: 'scripted' },
    { type: 'ui_action', action: { kind: 'show_simulation', result: rAds2, slot: 'active', node_ids: [], edge_ids: [] } },
    { type: 'ui_action', action: { kind: 'highlight', node_ids: rAds2.affected_nodes.map((n) => n.node_id), edge_ids: [], label: 'Affected components', tone: 'critical' } },
    { type: 'message', text: 'ok' }, { type: 'done', tool_calls: 1, mode: 'llm' },
  ]);
  await S(() => window.__deeptraceStore.getState().sendAnalystMessage('What happens if Five Points fails?'));
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { result: s.result?.scenario_id, hl: s.highlight?.label ?? null }; });
  check('R7 control: the scripted answer shows its simulation and highlight', st.result === 'A-DS-FIVEPOINTS' && st.hl === 'Affected components', st);
  chatReply = null;

  // R8: a Compare started after asking replaces the answer's slot write when it lands
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  const rCw = await S(async () => { const s = window.__deeptraceStore.getState(); const sc = s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario;
    return (await fetch('http://localhost:8000/api/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sc) })).json(); });
  chatReply = sse([
    { type: 'status', mode: 'llm', model: 'scripted' },
    { type: 'ui_action', action: { kind: 'show_simulation', result: rCw, slot: 'A', node_ids: [], edge_ids: [] } },
    { type: 'message', text: 'ok' }, { type: 'done', tool_calls: 1, mode: 'llm' },
  ]);
  delays['/api/analyst/chat'] = 2500; delays['/api/compare'] = 6000;
  await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('Put the Decatur main break in slot A'); });
  await sleep(300);
  await S(() => { window.__pc = window.__deeptraceStore.getState().runComparison(); });
  await S(() => window.__pq);
  const r8a = await snap();
  await S(() => window.__pc);
  st = { afterAnswer: r8a, final: await snap() };
  check('R8 a Compare started after asking replaces the answer\'s slot write when it lands', r8a.slotA === 'C-WATER-MAIN-DECATUR' && st.final.view === 'diff' && st.final.slotA === 'A-DS-FIVEPOINTS' && st.final.cmpA === 'A-DS-FIVEPOINTS' && st.final.compareStatus === 'idle', st);

  // R8: ...and once such a Compare has landed, the answer no longer writes into its slots
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  chatReply = sse([
    { type: 'status', mode: 'llm', model: 'scripted' },
    { type: 'ui_action', action: { kind: 'show_simulation', result: rCw, slot: 'A', node_ids: [], edge_ids: [] } },
    { type: 'message', text: 'ok' }, { type: 'done', tool_calls: 1, mode: 'llm' },
  ]);
  delays['/api/analyst/chat'] = 3000;
  await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('Put the Decatur main break in slot A'); });
  await sleep(300);
  await S(() => window.__deeptraceStore.getState().runComparison());
  await S(() => window.__pq);
  st = await S(() => { const s = window.__deeptraceStore.getState(); const m = s.messages[s.messages.length - 1]; return { view: s.compareView, slotA: s.slots.A?.scenario_id, cmpA: s.comparison?.scenario_a.scenario_id, scripted: m?.model === 'scripted' }; });
  check('R8 an answer does not write into the slots of a Compare started after asking', st.scripted && st.view === 'diff' && st.slotA === 'A-DS-FIVEPOINTS' && st.cmpA === 'A-DS-FIVEPOINTS', st);
  chatReply = null;

  // R8: a slot run started before asking that lands before the answer does not hold back its diff
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  delays['/api/simulate'] = 1500; delays['/api/analyst/chat'] = 4000;
  await S(() => { const s = window.__deeptraceStore.getState(); window.__pr = s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario, 'A'); });
  await sleep(200);
  await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('Compare scenario A and B'); });
  await S(() => window.__pr);
  const r8c = await snap();
  await S(() => window.__pq);
  st = { runLanded: r8c, final: await snap() };
  check('R8 an older slot run landing first does not hold back the answer\'s diff', r8c.slotA === 'C-WATER-MAIN-DECATUR' && st.final.view === 'diff' && st.final.cmpA === 'A-DS-FIVEPOINTS' && st.final.slotA === 'C-WATER-MAIN-DECATUR', st);

  // R8: the answer's trace does not take the map from a Compare started after asking...
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  await S(async () => { await window.__deeptraceStore.getState().selectNode('PWR-DS-FIVEPOINTS', { fly: false }); });
  delays['/api/analyst/chat'] = 3000;
  await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('Trace the connections of this component'); });
  await sleep(300);
  await S(() => window.__deeptraceStore.getState().runComparison());
  await S(() => window.__pq);
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { view: s.compareView, trace: s.trace?.node_id ?? null, cmpA: s.comparison?.scenario_a.scenario_id ?? null }; });
  check('R8 an answer\'s trace does not take the map from a newer Compare', st.view === 'diff' && st.trace === 'PWR-DS-FIVEPOINTS' && st.cmpA === 'A-DS-FIVEPOINTS', st);

  // R8: ...and a Compare started before asking does not take the diff back over the answer's trace
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  await S(() => window.__deeptraceStore.getState().runComparison());
  await S(async () => { await window.__deeptraceStore.getState().selectNode('PWR-DS-FIVEPOINTS', { fly: false }); });
  delays['/api/compare'] = 5000;
  await S(() => { window.__pc = window.__deeptraceStore.getState().runComparison(); });
  await sleep(200);
  await S(() => window.__deeptraceStore.getState().sendAnalystMessage('Trace the connections of this component'));
  const r8e = await S(() => { const s = window.__deeptraceStore.getState(); return { view: s.compareView, vis: s.traceVisible }; });
  await S(() => window.__pc);
  st = { afterAnswer: r8e, final: await S(() => { const s = window.__deeptraceStore.getState(); return { view: s.compareView, vis: s.traceVisible, status: s.compareStatus }; }) };
  check('R8 an older Compare does not take the diff back over the answer\'s trace', r8e.view !== 'diff' && r8e.vis && st.final.view !== 'diff' && st.final.vis && st.final.status === 'idle', st);

  // R9: an answer's trace shown with no diff on screen is not hidden by a Compare started before asking
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  await S(async () => { await window.__deeptraceStore.getState().selectNode('PWR-DS-FIVEPOINTS', { fly: false }); });
  delays['/api/compare'] = 5000;
  await S(() => { window.__pc = window.__deeptraceStore.getState().runComparison(); });
  await sleep(200);
  await S(() => window.__deeptraceStore.getState().sendAnalystMessage('Trace the connections of this component'));
  const r9a = await S(() => { const s = window.__deeptraceStore.getState(); return { view: s.compareView, vis: s.traceVisible }; });
  await S(() => window.__pc);
  st = { afterAnswer: r9a, final: await S(() => { const s = window.__deeptraceStore.getState(); return { view: s.compareView, vis: s.traceVisible, cmp: !!s.comparison, status: s.compareStatus }; }) };
  check('R9 an older Compare does not hide the answer\'s trace (no diff on screen)', r9a.vis && st.final.view !== 'diff' && st.final.vis && st.final.cmp && st.final.status === 'idle', st);

  // R9: a Compare that takes a slot back from an older answer also clears that answer's highlight
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  chatReply = sse([
    { type: 'status', mode: 'llm', model: 'scripted' },
    { type: 'ui_action', action: { kind: 'show_simulation', result: rCw, slot: 'A', node_ids: [], edge_ids: [] } },
    { type: 'ui_action', action: { kind: 'highlight', node_ids: rCw.affected_nodes.map((n) => n.node_id), edge_ids: [], label: 'Affected components', tone: 'critical' } },
    { type: 'message', text: 'ok' }, { type: 'done', tool_calls: 1, mode: 'llm' },
  ]);
  delays['/api/analyst/chat'] = 2500; delays['/api/compare'] = 6000;
  await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('Put the Decatur main break in slot A'); });
  await sleep(300);
  await S(() => { window.__pc = window.__deeptraceStore.getState().runComparison(); });
  await S(() => window.__pq);
  const r9b = await S(() => window.__deeptraceStore.getState().highlight?.label ?? null);
  await S(() => window.__pc);
  st = { hlAfterAnswer: r9b, ...(await S(() => { const s = window.__deeptraceStore.getState(); return { view: s.compareView, slotA: s.slots.A?.scenario_id, result: s.result?.scenario_id, hl: s.highlight?.label ?? null }; })) };
  check('R9 a Compare that takes back the answer\'s slot clears its highlight', r9b === 'Affected components' && st.view === 'diff' && st.slotA === 'A-DS-FIVEPOINTS' && st.result === 'A-DS-FIVEPOINTS' && st.hl === null, st);

  // R9: a Compare started after asking that only KEPT an older run in slot A does not block the answer's slot write
  const rTel = await S(async () => { const s = window.__deeptraceStore.getState(); const sc = s.presets.find((x) => x.id === 'D-TELECOM-56MARIETTA').scenario;
    return (await fetch('http://localhost:8000/api/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sc) })).json(); });
  const telReply = sse([
    { type: 'status', mode: 'llm', model: 'scripted' },
    { type: 'ui_action', action: { kind: 'show_simulation', result: rTel, slot: 'A', node_ids: [], edge_ids: [] } },
    { type: 'message', text: 'ok' }, { type: 'done', tool_calls: 1, mode: 'llm' },
  ]);
  for (const [preset, label] of [['C-WATER-MAIN-DECATUR', 'other scenario'], ['A-DS-FIVEPOINTS', 'same scenario']]) {
    await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
    chatReply = telReply;
    delays['/api/simulate'] = 1500; delays['/api/compare'] = 3000; delays['/api/analyst/chat'] = 6000;
    await S((id) => { const s = window.__deeptraceStore.getState(); window.__pr = s.runSimulation(s.presets.find((x) => x.id === id).scenario, 'A'); }, preset);
    await sleep(150);
    await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('Put the Marietta telecom failure in slot A'); });
    await sleep(200);
    await S(() => { window.__pc = window.__deeptraceStore.getState().runComparison(); });
    await S(() => Promise.all([window.__pr, window.__pc, window.__pq]));
    st = await snap();
    if (label === 'other scenario')
      check('R9 an older run kept by a newer Compare does not block the answer\'s slot write', st.slotA === 'D-TELECOM-56MARIETTA', st);
    else
      check('R9 ...but a slot showing what the newer Compare compared keeps it', st.slotA === 'A-DS-FIVEPOINTS' && st.view === 'diff' && st.cmpA === 'A-DS-FIVEPOINTS', st);
  }
  chatReply = null;

  // R10: a later answer that shows a new result does not keep an earlier answer's highlight
  await reset();
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.runSimulation(s.presets.find((x) => x.id === 'A-DS-FIVEPOINTS').scenario); });
  await S(() => window.__deeptraceStore.getState().sendAnalystMessage('Why did this happen, and what could we do differently?'));
  const hl1 = await S(() => window.__deeptraceStore.getState().highlight?.source ?? null);
  await S(() => window.__deeptraceStore.getState().sendAnalystMessage('What happens if PWR-TS-SOUTH fails?'));
  st = { hl1, ...(await S(() => { const s = window.__deeptraceStore.getState(); return { failed: s.result?.scenario.failed_nodes ?? [], hl: s.highlight?.label ?? null }; })) };
  check('R10 a later answer\'s new result does not keep the earlier answer\'s highlight', st.hl1 === 'ai' && st.failed.includes('PWR-TS-SOUTH') && st.hl === null, st);

  // R10: a stale Compare drawn into the diff already on screen owns the map: an older run does not take it
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  await S(() => window.__deeptraceStore.getState().runComparison());
  bodyDelays['C-WATER-MAIN-DECATUR'] = 1000; bodyDelays['D-TELECOM-56MARIETTA'] = 5000; delays['/api/compare'] = 2500;
  await S(() => { const s = window.__deeptraceStore.getState(); const P = (id) => s.presets.find((x) => x.id === id).scenario;
    window.__px = s.runSimulation(P('C-WATER-MAIN-DECATUR'), 'A'); window.__py = s.runSimulation(P('D-TELECOM-56MARIETTA')); window.__pc = s.runComparison(); });
  await S(() => Promise.all([window.__px, window.__py, window.__pc]));
  st = await snap();
  check('R10 a run requested before a Compare that redrew the diff does not take the map', st.view === 'diff' && st.result === 'B-EDGEWOOD-DUCTBANK' && st.slotA === 'C-WATER-MAIN-DECATUR' && st.simStatus === 'idle', st);

  // R10: a Compare started before a later answer's trace leaves that answer's result, trace and highlight alone
  await reset(); await P2('A-DS-FIVEPOINTS', 'B-EDGEWOOD-DUCTBANK');
  const trDs = await S(async () => (await fetch('http://localhost:8000/api/trace/PWR-DS-FIVEPOINTS?max_depth=8')).json());
  // Q1 asked, then Compare (in flight); Q1's answer lands; Q2 asked and answered; then the Compare lands
  delays['/api/compare'] = 6000; delays['/api/analyst/chat'] = 1500;
  chatReply = sse([
    { type: 'status', mode: 'llm', model: 'scripted' },
    { type: 'ui_action', action: { kind: 'show_simulation', result: rCw, slot: 'A', node_ids: [], edge_ids: [] } },
    { type: 'message', text: 'ok' }, { type: 'done', tool_calls: 1, mode: 'llm' },
  ]);
  await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('Put the Decatur main break in slot A'); });
  await S(() => { window.__pc = window.__deeptraceStore.getState().runComparison(); });
  await S(() => window.__pq);
  chatReply = sse([
    { type: 'status', mode: 'llm', model: 'scripted' },
    { type: 'ui_action', action: { kind: 'select_node', node_id: 'PWR-DS-FIVEPOINTS', node_ids: [], edge_ids: [] } },
    { type: 'ui_action', action: { kind: 'show_trace', trace: trDs, node_ids: [], edge_ids: [] } },
    { type: 'ui_action', action: { kind: 'highlight', node_ids: ['PWR-DS-FIVEPOINTS'], edge_ids: [], label: 'Connections of DS-2', tone: 'info' } },
    { type: 'message', text: 'ok' }, { type: 'done', tool_calls: 1, mode: 'llm' },
  ]);
  await S(() => window.__deeptraceStore.getState().sendAnalystMessage('Trace DS-2 Five Points'));
  await S(() => window.__pc);
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { result: s.result?.scenario_id, view: s.compareView, trace: s.trace?.node_id ?? null, hl: s.highlight?.label ?? null, slotA: s.slots.A?.scenario_id, cmpA: s.comparison?.scenario_a.scenario_id ?? null, status: s.compareStatus }; });
  check('R10 an older Compare leaves a later answer\'s result, trace and highlight', st.result === 'C-WATER-MAIN-DECATUR' && st.view !== 'diff' && st.trace === 'PWR-DS-FIVEPOINTS' && st.hl === 'Connections of DS-2' && st.slotA === 'A-DS-FIVEPOINTS' && st.cmpA === 'A-DS-FIVEPOINTS' && st.status === 'idle', st);
  chatReply = null;

  // R11: switching the shown slot drops an analyst highlight that described the other slot's result
  await reset(); await P2('A-DS-FIVEPOINTS', 'C-WATER-MAIN-DECATUR');
  await S(() => window.__deeptraceStore.getState().sendAnalystMessage('Why did this happen, and what could we do differently?'));
  const r11a = await S(() => { const s = window.__deeptraceStore.getState(); return { result: s.result?.scenario_id, hl: s.highlight?.source ?? null }; });
  await S(() => window.__deeptraceStore.getState().showSlot('A'));
  st = { onB: r11a, ...(await S(() => { const s = window.__deeptraceStore.getState(); return { result: s.result?.scenario_id, hl: s.highlight?.label ?? null }; })) };
  check('R11 switching to slot A drops the AI highlight about slot B', r11a.result === 'C-WATER-MAIN-DECATUR' && r11a.hl === 'ai' && st.result === 'A-DS-FIVEPOINTS' && st.hl === null, st);

  // R11: an answer's highlight is not drawn on a result of another scenario that an older run put on the map meanwhile
  await reset();
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.runSimulation(s.presets.find((x) => x.id === 'A-DS-FIVEPOINTS').scenario); });
  bodyDelays['C-WATER-MAIN-DECATUR'] = 1500; delays['/api/analyst/chat'] = 5000;
  await S(() => { const s = window.__deeptraceStore.getState(); window.__pr = s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario); });
  await sleep(150);
  await S(() => { window.__pq = window.__deeptraceStore.getState().sendAnalystMessage('Why did this happen, and what could we do differently?'); });
  await S(() => Promise.all([window.__pr, window.__pq]));
  st = await S(() => { const s = window.__deeptraceStore.getState(); const m = s.messages[s.messages.length - 1]; return { result: s.result?.scenario_id, hl: s.highlight?.label ?? null, sim: s.simStatus, answered: !!m?.content && !m?.pending }; });
  check('R11 an answer\'s highlight is not drawn on a newer scenario an older run showed', st.result === 'C-WATER-MAIN-DECATUR' && st.hl === null && st.sim === 'idle' && st.answered, st);

  // R2: a live result keeps its provenance after a failover (not relabelled "precomputed")
  await reset();
  st = await S(async () => { const s = window.__deeptraceStore.getState(); const r = await s.runSimulation({ failed_nodes: ['PWR-DS-FIVEPOINTS'], failed_edges: [], horizon_hours: 6, enable_restoration: true });
    return { live: !!r }; });
  const liveRes = st.live;
  blockEngine = true;
  await S(async () => { await window.__deeptraceStore.getState().selectNode('PWR-TS-SOUTH'); });
  st = await S(() => ({ mode: window.__deeptraceStore.getState().dataMode, label: document.body.innerText.includes('precomputed (offline snapshot)') }));
  check('R2 live result is not labelled precomputed after failover', liveRes && st.mode === 'snapshot' && !st.label, st);
  blockEngine = false;

  // [26]/[27] engine dies mid-session -> snapshot failover; offline trace uses engine trace
  await reset(); blockEngine = true;
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.runSimulation(s.presets.find((x) => x.id === 'A-DS-FIVEPOINTS').scenario, 'A'); });
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { mode: s.dataMode, result: s.result?.scenario_id ?? null, err: s.simError }; });
  check('[26] engine down mid-session fails over to the snapshot', st.mode === 'snapshot' && st.result === 'A-DS-FIVEPOINTS', st);
  await S(async () => { const s = window.__deeptraceStore.getState(); await s.selectNode('PWR-DS-FIVEPOINTS'); await window.__deeptraceStore.getState().showTrace('PWR-DS-FIVEPOINTS'); });
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { up: s.trace?.upstream.length, down: s.trace?.downstream.length, deps: s.trace?.dependents.length, dUp: s.details?.upstream_ids.length, dDown: s.details?.downstream_ids.length, spof: s.details?.is_single_point_of_failure }; });
  check('[27] offline trace/details use the engine trace from the snapshot', st.up === 1 && st.down === 15 && st.deps === 33 && st.dDown === 15 && st.spof === true, st);
  await S(async () => { await window.__deeptraceStore.getState().selectNode('PWR-SW-CEN1'); });
  st = await S(() => { const s = window.__deeptraceStore.getState(); return { up: s.details?.upstream_ids.length, conn: s.details?.connected_node_ids.length, spof: s.details?.is_single_point_of_failure }; });
  check('[27] node without a precomputed trace: no fake upstream, SPOF from engine set', st.up === 0 && st.conn > 0 && st.spof === true, st);

  // [29] replay only for the scenario it was recorded for
  await S(async () => { const s = window.__deeptraceStore.getState(); s.clearChat(); await s.runSimulation(s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario); });
  await S(() => window.__deeptraceStore.getState().sendAnalystMessage('Why did this happen, and what could we do differently?'));
  st = await S(() => { const s = window.__deeptraceStore.getState(); const m = s.messages[s.messages.length - 1]; return { content: (m.content || '').slice(0, 60), err: (m.error || '').slice(0, 60), tools: m.tools.length }; });
  check('[29] recorded replay is not shown for a different scenario', !st.content && st.tools === 0 && !!st.err, st);
  await S(async () => { const s = window.__deeptraceStore.getState(); s.clearChat(); await s.runSimulation(s.presets.find((x) => x.id === 'A-DS-FIVEPOINTS').scenario); await window.__deeptraceStore.getState().sendAnalystMessage('Why did this happen, and what could we do differently?'); });
  st = await S(() => { const s = window.__deeptraceStore.getState(); const m = s.messages[s.messages.length - 1]; return { content: (m.content || '').slice(0, 60), tools: m.tools.length, pending: s.analystPending }; });
  check('[29] recorded replay still works for the demo scenario', st.content.length > 0 && st.tools > 0 && !st.pending, st);

  // R2: snapshot mode, the ask_ai step reached by a step chip or Prev still replays its answer
  await S(async () => { const s = window.__deeptraceStore.getState(); s.startDemo(); await new Promise((r) => setTimeout(r, 200)); await window.__deeptraceStore.getState().demoGoto(7); });
  st = await S(() => { const s = window.__deeptraceStore.getState(); const m = s.messages[s.messages.length - 1]; return { mode: s.dataMode, result: s.result?.scenario_id ?? null, content: (m?.content || '').slice(0, 50), err: m?.error ?? null }; });
  check('R2 snapshot ask_ai reached cold replays the recorded answer', st.mode === 'snapshot' && st.result === 'A-DS-FIVEPOINTS' && st.content.length > 0 && !st.err, st);
  await S(async () => { await window.__deeptraceStore.getState().demoGoto(8); await window.__deeptraceStore.getState().demoPrev(); });
  st = await S(() => { const s = window.__deeptraceStore.getState(); const m = s.messages[s.messages.length - 1]; return { step: s.demo.step, result: s.result?.scenario_id ?? null, content: (m?.content || '').slice(0, 50), err: m?.error ?? null }; });
  check('R2 snapshot ask_ai reached by Prev replays the recorded answer', st.step === 7 && st.result === 'A-DS-FIVEPOINTS' && st.content.length > 0 && !st.err, st);
  await S(() => window.__deeptraceStore.getState().exitDemo());

  check('no page errors', errors.length === 0, errors.slice(0, 5));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
