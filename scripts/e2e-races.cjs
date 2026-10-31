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
let blockEngine = false;
let stallChat = false;
async function routes(page) {
  await page.route('http://localhost:8000/**', async (route) => {
    const url = route.request().url();
    if (blockEngine) return route.abort('connectionrefused');
    if (stallChat && url.includes('/api/analyst/chat')) return; // never respond
    for (const [k, ms] of Object.entries(delays)) if (url.includes(k)) { await sleep(ms); break; }
    try { await route.continue(); } catch {}
  });
}

(async () => {
  const { browser, page, errors } = await open(routes);
  const S = (fn, arg) => page.evaluate(fn, arg);
  const reset = async () => { for (const k of Object.keys(delays)) delete delays[k]; blockEngine = false; stallChat = false;
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
  st = await S(() => ({ view: window.__deeptraceStore.getState().compareView, focus: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName }));
  check('R3 highlight chip "show" leaves the diff and keeps focus in the chip', st.view !== 'diff' && st.focus === 'Clear highlight', st);

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
