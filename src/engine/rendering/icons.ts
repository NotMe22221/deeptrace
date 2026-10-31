/**
 * Canvas-drawn sprites: crisp circular node glyphs (per node type, ring tinted by system/state),
 * particle sprites, halos and rings. Textures are cached by key so the billboard atlas holds
 * each variant once.
 */

export type IconTier = "major" | "medium" | "minor";

const MAJOR = new Set([
  "transmission_substation",
  "distribution_substation",
  "internet_exchange",
  "data_center",
  "central_office",
  "hospital",
  "transit_station",
  "transit_hub",
  "pump_station",
  "supply_source",
  "storage_tank",
  "gateway",
  "emergency_services",
  "government",
  "venue",
  "university",
]);
const MINOR = new Set(["valve", "junction", "access_node", "intersection"]);

export const iconTier = (type: string): IconTier => (MAJOR.has(type) ? "major" : MINOR.has(type) ? "minor" : "medium");
export const ICON_PX: Record<IconTier, number> = { major: 30, medium: 22, minor: 14 };

const DPR = 2;
const cache = new Map<string, HTMLCanvasElement>();

function canvas(px: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = c.height = Math.round(px * DPR);
  const ctx = c.getContext("2d")!;
  ctx.scale(DPR, DPR);
  return [c, ctx];
}

type Glyph = (ctx: CanvasRenderingContext2D) => void;

// Glyphs are drawn in a unit box (-1..1), filled/stroked with the current style.
const poly = (ctx: CanvasRenderingContext2D, pts: number[][], close = true) => {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
};
const bolt: Glyph = (ctx) => {
  poly(ctx, [
    [0.18, -0.95],
    [-0.5, 0.12],
    [-0.04, 0.12],
    [-0.2, 0.95],
    [0.5, -0.18],
    [0.04, -0.18],
  ]);
  ctx.fill();
};
const hexagon = (ctx: CanvasRenderingContext2D, r: number) => {
  const pts = Array.from({ length: 6 }, (_, i) => [Math.cos((Math.PI / 3) * i + Math.PI / 6) * r, Math.sin((Math.PI / 3) * i + Math.PI / 6) * r]);
  poly(ctx, pts);
};
const circle = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number) => {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
};
const rrect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
};

const GLYPHS: Record<string, Glyph> = {
  transmission_substation: (ctx) => {
    hexagon(ctx, 1.0);
    ctx.stroke();
    ctx.save();
    ctx.scale(0.62, 0.62);
    bolt(ctx);
    ctx.restore();
  },
  distribution_substation: (ctx) => {
    ctx.save();
    ctx.scale(0.85, 0.85);
    bolt(ctx);
    ctx.restore();
  },
  switch: (ctx) => {
    circle(ctx, -0.6, 0.35, 0.18);
    ctx.fill();
    circle(ctx, 0.62, 0.35, 0.18);
    ctx.fill();
    poly(ctx, [
      [-0.6, 0.35],
      [0.45, -0.35],
    ], false);
    ctx.stroke();
  },
  network_vault: (ctx) => {
    rrect(ctx, -0.82, -0.82, 1.64, 1.64, 0.2);
    ctx.stroke();
    ctx.save();
    ctx.scale(0.55, 0.55);
    bolt(ctx);
    ctx.restore();
  },
  supply_source: (ctx) => {
    ctx.beginPath();
    ctx.moveTo(0, -0.95);
    ctx.bezierCurveTo(0.55, -0.25, 0.7, 0.15, 0.7, 0.35);
    ctx.arc(0, 0.35, 0.7, 0, Math.PI);
    ctx.bezierCurveTo(-0.7, 0.15, -0.55, -0.25, 0, -0.95);
    ctx.fill();
  },
  pump_station: (ctx) => {
    circle(ctx, 0, 0, 0.85);
    ctx.stroke();
    poly(ctx, [
      [-0.38, -0.5],
      [0.55, 0],
      [-0.38, 0.5],
    ]);
    ctx.fill();
  },
  storage_tank: (ctx) => {
    rrect(ctx, -0.62, -0.9, 1.24, 1.3, 0.35);
    ctx.stroke();
    rrect(ctx, -0.62, -0.1, 1.24, 0.5, 0.2);
    ctx.fill();
    poly(ctx, [
      [-0.35, 0.4],
      [-0.5, 0.95],
    ], false);
    ctx.stroke();
    poly(ctx, [
      [0.35, 0.4],
      [0.5, 0.95],
    ], false);
    ctx.stroke();
  },
  valve: (ctx) => {
    poly(ctx, [
      [-0.8, -0.55],
      [0, 0],
      [-0.8, 0.55],
    ]);
    ctx.fill();
    poly(ctx, [
      [0.8, -0.55],
      [0, 0],
      [0.8, 0.55],
    ]);
    ctx.fill();
  },
  junction: (ctx) => {
    circle(ctx, 0, 0, 0.5);
    ctx.fill();
  },
  service_zone: (ctx) => {
    ctx.setLineDash([0.32, 0.22]);
    circle(ctx, 0, 0, 0.82);
    ctx.stroke();
    ctx.setLineDash([]);
    circle(ctx, 0, 0, 0.28);
    ctx.fill();
  },
  internet_exchange: (ctx) => {
    circle(ctx, 0, 0, 0.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 0, 0.36, 0.85, 0, 0, Math.PI * 2);
    ctx.stroke();
    poly(ctx, [
      [-0.85, 0],
      [0.85, 0],
    ], false);
    ctx.stroke();
  },
  central_office: (ctx) => {
    rrect(ctx, -0.6, -0.3, 1.2, 1.2, 0.12);
    ctx.stroke();
    poly(ctx, [
      [0, -0.3],
      [0, -0.95],
    ], false);
    ctx.stroke();
    circle(ctx, 0, -0.95, 0.14);
    ctx.fill();
    rrect(ctx, -0.3, 0.15, 0.6, 0.12, 0.05);
    ctx.fill();
    rrect(ctx, -0.3, 0.45, 0.6, 0.12, 0.05);
    ctx.fill();
  },
  data_center: (ctx) => {
    for (const y of [-0.78, -0.18, 0.42]) {
      rrect(ctx, -0.75, y, 1.5, 0.42, 0.1);
      ctx.stroke();
      circle(ctx, 0.45, y + 0.21, 0.08);
      ctx.fill();
    }
  },
  fiber_hub: (ctx) => {
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      poly(ctx, [
        [Math.cos(a) * 0.3, Math.sin(a) * 0.3],
        [Math.cos(a) * 0.9, Math.sin(a) * 0.9],
      ], false);
      ctx.stroke();
    }
    circle(ctx, 0, 0, 0.26);
    ctx.fill();
  },
  cell_site: (ctx) => {
    poly(ctx, [
      [0, -0.2],
      [0, 0.95],
    ], false);
    ctx.stroke();
    circle(ctx, 0, -0.25, 0.16);
    ctx.fill();
    for (const r of [0.45, 0.8]) {
      ctx.beginPath();
      ctx.arc(0, -0.25, r, -Math.PI * 0.3, Math.PI * 0.3);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -0.25, r, Math.PI * 0.7, Math.PI * 1.3);
      ctx.stroke();
    }
  },
  access_node: (ctx) => {
    rrect(ctx, -0.45, -0.45, 0.9, 0.9, 0.12);
    ctx.fill();
  },
  intersection: (ctx) => {
    ctx.fillRect(-0.16, -0.7, 0.32, 1.4);
    ctx.fillRect(-0.7, -0.16, 1.4, 0.32);
  },
  gateway: (ctx) => {
    poly(ctx, [
      [-0.75, -0.6],
      [-0.1, 0],
      [-0.75, 0.6],
    ], false);
    ctx.stroke();
    poly(ctx, [
      [-0.05, -0.6],
      [0.6, 0],
      [-0.05, 0.6],
    ], false);
    ctx.stroke();
  },
  transit_station: (ctx) => {
    rrect(ctx, -0.62, -0.85, 1.24, 1.4, 0.32);
    ctx.stroke();
    rrect(ctx, -0.4, -0.6, 0.8, 0.45, 0.08);
    ctx.fill();
    circle(ctx, -0.3, 0.22, 0.11);
    ctx.fill();
    circle(ctx, 0.3, 0.22, 0.11);
    ctx.fill();
    poly(ctx, [
      [-0.35, 0.6],
      [-0.6, 0.95],
    ], false);
    ctx.stroke();
    poly(ctx, [
      [0.35, 0.6],
      [0.6, 0.95],
    ], false);
    ctx.stroke();
  },
  utility_vault: (ctx) => {
    circle(ctx, 0, 0, 0.82);
    ctx.stroke();
    for (const o of [-0.35, 0, 0.35]) {
      poly(ctx, [
        [-0.6, o],
        [0.6, o],
      ], false);
      ctx.stroke();
    }
  },
  hospital: (ctx) => {
    ctx.fillRect(-0.24, -0.78, 0.48, 1.56);
    ctx.fillRect(-0.78, -0.24, 1.56, 0.48);
  },
  emergency_services: (ctx) => {
    const pts: number[][] = [];
    for (let i = 0; i < 12; i++) {
      const r = i % 2 ? 0.42 : 0.92;
      const a = (Math.PI / 6) * i - Math.PI / 2;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    poly(ctx, pts);
    ctx.fill();
  },
  government: (ctx) => {
    poly(ctx, [
      [-0.85, -0.35],
      [0, -0.9],
      [0.85, -0.35],
    ]);
    ctx.fill();
    for (const x of [-0.55, 0, 0.55]) ctx.fillRect(x - 0.1, -0.2, 0.2, 0.85);
    ctx.fillRect(-0.85, 0.7, 1.7, 0.2);
  },
  university: (ctx) => {
    poly(ctx, [
      [-0.95, -0.15],
      [0, -0.6],
      [0.95, -0.15],
      [0, 0.3],
    ]);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-0.5, 0.05);
    ctx.lineTo(-0.5, 0.55);
    ctx.quadraticCurveTo(0, 0.85, 0.5, 0.55);
    ctx.lineTo(0.5, 0.05);
    ctx.stroke();
  },
  venue: (ctx) => {
    const pts: number[][] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 0.4 : 0.92;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    poly(ctx, pts);
    ctx.fill();
  },
  commercial: (ctx) => {
    rrect(ctx, -0.6, -0.85, 1.2, 1.7, 0.1);
    ctx.stroke();
    for (const y of [-0.5, -0.1, 0.3]) {
      ctx.fillRect(-0.35, y, 0.25, 0.2);
      ctx.fillRect(0.1, y, 0.25, 0.2);
    }
  },
};
GLYPHS.transit_hub = GLYPHS.transit_station;

export interface IconSpec {
  type: string;
  /** ring / glyph colour (css hex) */
  color: string;
  tier: IconTier;
  /** extra mark for impacted states */
  mark?: "fail" | "none";
  /** underground nodes get a square-cut badge so they read differently from surface assets */
  underground?: boolean;
}

export function iconKey(s: IconSpec) {
  return `ic|${s.type}|${s.color}|${s.tier}|${s.mark ?? "none"}|${s.underground ? 1 : 0}`;
}

/** Node glyph: dark disc, system/state ring, inner type mark. */
export function nodeIcon(s: IconSpec): HTMLCanvasElement {
  const key = iconKey(s);
  const hit = cache.get(key);
  if (hit) return hit;
  const px = ICON_PX[s.tier] + 6; // padding for the outer glow
  const [c, ctx] = canvas(px);
  const cx = px / 2;
  const R = ICON_PX[s.tier] / 2;
  // soft outer glow
  const g = ctx.createRadialGradient(cx, cx, R * 0.6, cx, cx, px / 2);
  g.addColorStop(0, hexA(s.color, 0.32));
  g.addColorStop(1, hexA(s.color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, px, px);
  // body
  ctx.beginPath();
  if (s.underground) ctx.roundRect(cx - R + 0.5, cx - R + 0.5, 2 * R - 1, 2 * R - 1, R * 0.38);
  else ctx.arc(cx, cx, R - 0.5, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(6, 10, 19, 0.92)";
  ctx.fill();
  ctx.lineWidth = s.tier === "minor" ? 1.6 : 1.8;
  ctx.strokeStyle = s.color;
  ctx.stroke();
  if (s.tier !== "minor" || s.type === "valve") {
    const glyph = GLYPHS[s.type];
    ctx.save();
    ctx.translate(cx, cx);
    const gs = R * (s.tier === "major" ? 0.5 : 0.52);
    ctx.scale(gs, gs);
    ctx.fillStyle = lighten(s.color);
    ctx.strokeStyle = lighten(s.color);
    ctx.lineWidth = (s.tier === "major" ? 1.5 : 1.3) / gs;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (glyph) glyph(ctx);
    else {
      circle(ctx, 0, 0, 0.42);
      ctx.fill();
    }
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cx, R * 0.36, 0, Math.PI * 2);
    ctx.fillStyle = lighten(s.color);
    ctx.fill();
  }
  if (s.mark === "fail") {
    ctx.strokeStyle = "#fff1f2";
    ctx.lineWidth = 1.6;
    ctx.lineCap = "round";
    const k = R * 0.55;
    ctx.beginPath();
    ctx.moveTo(cx - k, cx - k);
    ctx.lineTo(cx + k, cx + k);
    ctx.stroke();
  }
  cache.set(key, c);
  return c;
}

/** Soft radial sprite (particles, halos, flashes). White so billboard colour tints it. */
export function glowSprite(kind: "dot" | "packet" | "halo" | "flare"): HTMLCanvasElement {
  const key = `glow|${kind}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const px = kind === "halo" ? 64 : kind === "flare" ? 96 : 24;
  const [c, ctx] = canvas(px);
  const r = px / 2;
  if (kind === "packet") {
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, "rgba(255,255,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "rgba(255,255,255,1)";
    ctx.beginPath();
    ctx.roundRect(r - px * 0.17, r - px * 0.17, px * 0.34, px * 0.34, px * 0.06);
    ctx.fill();
  } else {
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    if (kind === "dot") {
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.22, "rgba(255,255,255,0.95)");
      g.addColorStop(0.45, "rgba(255,255,255,0.35)");
      g.addColorStop(1, "rgba(255,255,255,0)");
    } else if (kind === "halo") {
      g.addColorStop(0, "rgba(255,255,255,0.5)");
      g.addColorStop(0.35, "rgba(255,255,255,0.28)");
      g.addColorStop(1, "rgba(255,255,255,0)");
    } else {
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.15, "rgba(255,255,255,0.7)");
      g.addColorStop(0.5, "rgba(255,255,255,0.18)");
      g.addColorStop(1, "rgba(255,255,255,0)");
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, px, px);
  }
  cache.set(key, c);
  return c;
}

/** Thin ring sprite used for the selection pulse. */
export function ringSprite(): HTMLCanvasElement {
  const key = "ring";
  const hit = cache.get(key);
  if (hit) return hit;
  const px = 96;
  const [c, ctx] = canvas(px);
  const r = px / 2;
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(r, r, r - 8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(r, r, r - 8, 0, Math.PI * 2);
  ctx.stroke();
  cache.set(key, c);
  return c;
}

/** Selection reticle: four corner brackets. */
export function reticleSprite(): HTMLCanvasElement {
  const key = "reticle";
  const hit = cache.get(key);
  if (hit) return hit;
  const px = 64;
  const [c, ctx] = canvas(px);
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  const a = 6;
  const b = px - 6;
  const k = 11;
  for (const [x, y, dx, dy] of [
    [a, a, 1, 1],
    [b, a, -1, 1],
    [a, b, 1, -1],
    [b, b, -1, -1],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x + dx * k, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * k);
    ctx.stroke();
  }
  cache.set(key, c);
  return c;
}

function hexA(hex: string, a: number) {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}

function lighten(hex: string) {
  const v = parseInt(hex.slice(1), 16);
  const f = (x: number) => Math.round(x + (255 - x) * 0.28);
  return `rgb(${f((v >> 16) & 255)},${f((v >> 8) & 255)},${f(v & 255)})`;
}
