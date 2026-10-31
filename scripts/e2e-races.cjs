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

  // [0] overlapping runs: newest wins
  await reset();
  await S(async () => {
    const s = window.__deeptraceStore.getState();
    const A = s.presets.find((x) => x.id === 'A-DS-FIVEPOINTS').scenario, C = s.presets.find((x) => x.id === 'C-WATER-MAIN-DECATUR').scenario;
    window.__pa = s.runSimulation(A);
  });
  delays['/api/simulate'] = 0;
  // make the first slower by delaying before issuing second
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

  check('no page errors', errors.length === 0, errors.slice(0, 5));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
