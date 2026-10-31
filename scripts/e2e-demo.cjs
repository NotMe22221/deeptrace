#!/usr/bin/env node
/**
 * DEEPTRACE end-to-end demo check.
 *
 * Plays the 10-step judge walkthrough in a headless browser, screenshots every step and
 * fails on page errors. Requires Playwright (`npm i -D playwright && npx playwright install chromium`)
 * and running servers (`make dev`).
 *
 *   node scripts/e2e-demo.cjs [--url http://localhost:3000] [--out e2e-shots] [--offline]
 *
 * --offline blocks the backend URL to verify the offline-snapshot fallback.
 */
const path = require("node:path");
const fs = require("node:fs");

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const URL = arg("--url", "http://localhost:3000");
const OUT = arg("--out", "e2e-shots");
const OFFLINE = process.argv.includes("--offline");
const API = process.env.NEXT_PUBLIC_DEEPTRACE_API_URL || "http://localhost:8000";

(async () => {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    console.error("Playwright is not installed: npm i -D playwright && npx playwright install chromium");
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|ERR_|net::/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  if (OFFLINE) await page.route(`${API}/**`, (r) => r.abort());

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  // Wait for data + world
  await page.waitForFunction(
    () => {
      const s = window.__deeptraceStore?.getState();
      return s && (s.dataMode === "live" || s.dataMode === "snapshot") && s.demoScript && s.worldStatus.status === "ready";
    },
    null,
    { timeout: 90000 },
  );
  const mode = await page.evaluate(() => window.__deeptraceStore.getState().dataMode);
  console.log(`data mode: ${mode}`);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, "00-boot.png"), timeout: 120000 });

  await page.evaluate(() => window.__deeptraceStore.getState().startDemo());
  const steps = await page.evaluate(() => window.__deeptraceStore.getState().demoScript.steps.length);
  for (let i = 0; i < steps; i++) {
    if (i > 0) await page.evaluate(() => window.__deeptraceStore.getState().demoNext());
    // wait for the step to finish (async steps such as simulation / AI)
    await page.waitForFunction(() => !window.__deeptraceStore.getState().demo.busy, null, { timeout: 120000 });
    await page.waitForFunction(() => !window.__deeptraceStore.getState().analystPending, null, { timeout: 180000 });
    await page.waitForTimeout(i === 6 ? 9000 : 3500); // let the cascade animate
    const info = await page.evaluate(() => {
      const s = window.__deeptraceStore.getState();
      const st = s.demoScript.steps[s.demo.step];
      return {
        step: s.demo.step + 1,
        id: st.id,
        action: st.action,
        selected: s.selectedNodeId,
        deep: s.deepMode,
        result: s.result ? `${s.result.scenario_id} sev=${s.result.impact_metrics.severity_index.toFixed(1)}` : null,
        slots: [!!s.slots.A, !!s.slots.B],
        comparison: !!s.comparison,
        error: s.simError,
        lastMsg: s.messages.at(-1)?.error || (s.messages.at(-1)?.content || "").slice(0, 80),
      };
    });
    console.log(JSON.stringify(info));
    await page.screenshot({ path: path.join(OUT, `${String(i + 1).padStart(2, "0")}-${info.action}.png`), timeout: 120000 });
  }
  const final = await page.evaluate(() => {
    const s = window.__deeptraceStore.getState();
    return { comparison: !!s.comparison, slots: [!!s.slots.A, !!s.slots.B], messages: s.messages.length };
  });
  await page.evaluate(() => window.__deeptraceStore.getState().restoreWorld());
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, "11-restored.png"), timeout: 120000 });
  await browser.close();

  const ok = final.comparison && final.slots[0] && final.slots[1] && problems.length === 0;
  console.log(JSON.stringify({ final, problems: problems.slice(0, 20) }, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
