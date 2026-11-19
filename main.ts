// news-image-20261118 — "Sum up 18 November's world news in one image"
// Account 1 (@bayuanwar8). Node 22 stdlib only. Own PNG encoder + own
// TrueType parser/rasterizer (cmap 4+12, glyf/loca, composite glyphs,
// even-odd fill, 4x supersampling). No network, no random, no clock.
// Writes entry.png to MAKEFUN_OUTPUT_DIR (default /output).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const W = 1024, H = 1024;

// ---------------------------------------------------------------- PNG ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgb: Buffer, w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const prev = Buffer.alloc(w * 3);
  for (let y = 0; y < h; y++) {
    const row = rgb.subarray(y * w * 3, (y + 1) * w * 3);
    // Try filter 0 (None) and filter 1 (Sub); keep the smaller by abs-sum.
    let sum0 = 0, sum1 = 0;
    for (let i = 0; i < row.length; i++) {
      const v0 = row[i];
      const left = i >= 3 ? row[i - 3] : 0;
      const v1 = (v0 - left) & 0xff;
      sum0 += Math.abs(v0 < 128 ? v0 : v0 - 256);
      sum1 += Math.abs(v1 < 128 ? v1 : v1 - 256);
    }
    const off = y * (w * 3 + 1);
    if (sum1 < sum0) {
      raw[off] = 1;
      for (let i = 0; i < row.length; i++) {
        const left = i >= 3 ? row[i - 3] : 0;
        raw[off + 1 + i] = (row[i] - left) & 0xff;
      }
    } else {
      raw[off] = 0;
      row.copy(raw, off + 1);
    }
    prev.set(row);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------- TTF font --
type Pt = { x: number; y: number; on: boolean };
type Outline = Pt[][]; // contours

class Font {
  data: Buffer;
  unitsPerEm: number;
  numGlyphs: number;
  cmap4: { end: number; start: number; delta: number; ro: number }[] | null = null;
  cmap4Glyphs: Buffer | null = null;
  cmap12: { start: number; end: number; gid: number }[] | null = null;
  locaOff: number; locaFmt: number; glyfOff: number;
  hmtxOff: number; numHMetrics: number;
  name: string;
  cache = new Map<string, { bmp: Uint8Array; w: number; h: number; ox: number; oy: number; adv: number }>();

  constructor(path: string, name: string) {
    this.data = readFileSync(path);
    this.name = name;
    const d = this.data;
    const numTables = d.readUInt16BE(4);
    const tables = new Map<string, number>();
    for (let i = 0; i < numTables; i++) {
      const off = 12 + i * 16;
      tables.set(d.toString('ascii', off, off + 4), d.readUInt32BE(off + 8));
    }
    const need = ['head', 'maxp', 'hhea', 'hmtx', 'cmap', 'loca', 'glyf'];
    for (const t of need) if (!tables.has(t)) throw new Error(`${name}: missing ${t}`);
    this.unitsPerEm = d.readUInt16BE(tables.get('head')! + 18);
    this.numGlyphs = d.readUInt16BE(tables.get('maxp')! + 4);
    this.numHMetrics = d.readUInt16BE(tables.get('hhea')! + 34);
    this.hmtxOff = tables.get('hmtx')!;
    this.locaFmt = d.readInt16BE(tables.get('head')! + 50);
    this.locaOff = tables.get('loca')!;
    this.glyfOff = tables.get('glyf')!;
    // cmap: pick format 12 first, else format 4
    const cmapOff = tables.get('cmap')!;
    const nSub = d.readUInt16BE(cmapOff + 2);
    let f4 = -1, f12 = -1;
    for (let i = 0; i < nSub; i++) {
      const rec = cmapOff + 4 + i * 8;
      const subOff = d.readUInt32BE(rec + 4);
      const fmt = d.readUInt16BE(cmapOff + subOff);
      if (fmt === 12) f12 = subOff;
      else if (fmt === 4 && f4 < 0) f4 = subOff;
    }
    if (f12 >= 0) {
      const off = cmapOff + f12;
      const n = d.readUInt32BE(off + 12);
      this.cmap12 = [];
      for (let i = 0; i < n; i++) {
        const g = off + 16 + i * 12;
        this.cmap12.push({ start: d.readUInt32BE(g), end: d.readUInt32BE(g + 4), gid: d.readUInt32BE(g + 8) });
      }
    } else if (f4 >= 0) {
      const off = cmapOff + f4;
      const segCount = d.readUInt16BE(off + 6) / 2;
      const endOff = off + 14;
      const startOff = endOff + segCount * 2 + 2;
      const deltaOff = startOff + segCount * 2;
      const roOff = deltaOff + segCount * 2;
      this.cmap4 = [];
      for (let i = 0; i < segCount; i++) {
        this.cmap4.push({
          end: d.readUInt16BE(endOff + i * 2),
          start: d.readUInt16BE(startOff + i * 2),
          delta: d.readInt16BE(deltaOff + i * 2),
          ro: d.readUInt16BE(roOff + i * 2),
        });
      }
      this.cmap4Glyphs = d.subarray(roOff + segCount * 2);
    }
  }

  glyphId(cp: number): number {
    if (this.cmap12) {
      let lo = 0, hi = this.cmap12.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, g = this.cmap12[mid];
        if (cp < g.start) hi = mid - 1;
        else if (cp > g.end) lo = mid + 1;
        else return g.gid + (cp - g.start);
      }
      return 0;
    }
    if (this.cmap4) {
      for (let i = 0; i < this.cmap4.length; i++) {
        const s = this.cmap4[i];
        if (cp >= s.start && cp <= s.end) {
          if (s.ro === 0) return (cp + s.delta) & 0xffff;
          const idx = (s.ro / 2 + (cp - s.start) + i - this.cmap4.length) * 2;
          if (idx < 0 || idx + 1 >= this.cmap4Glyphs!.length) return 0;
          const g = this.cmap4Glyphs!.readUInt16BE(idx);
          return g === 0 ? 0 : (g + s.delta) & 0xffff;
        }
      }
    }
    return 0;
  }

  advance(gid: number): number {
    const g = Math.min(gid, this.numHMetrics - 1);
    return this.data.readUInt16BE(this.hmtxOff + g * 4);
  }

  glyphOffset(gid: number): [number, number] {
    if (this.locaFmt === 0) {
      const o = this.locaOff + gid * 2;
      return [this.data.readUInt16BE(o) * 2, this.data.readUInt16BE(o + 2) * 2];
    }
    const o = this.locaOff + gid * 4;
    return [this.data.readUInt32BE(o), this.data.readUInt32BE(o + 4)];
  }

  outline(gid: number, depth = 0): Outline {
    const [s, e] = this.glyphOffset(gid);
    if (e <= s || depth > 3) return [];
    const g = this.glyfOff + s;
    const d = this.data;
    const nContours = d.readInt16BE(g);
    if (nContours >= 0) {
      const endPts = Array.from({ length: nContours }, (_, i) => d.readUInt16BE(g + 10 + i * 2));
      let p = g + 10 + nContours * 2;
      const instrLen = d.readUInt16BE(p); p += 2 + instrLen;
      const nPts = endPts.length ? endPts[endPts.length - 1] + 1 : 0;
      const flags: number[] = [];
      while (flags.length < nPts) {
        const f = d[p++];
        flags.push(f);
        if (f & 0x08) { const r = d[p++]; for (let i = 0; i < r; i++) flags.push(f); }
      }
      const xs: number[] = []; let x = 0;
      for (let i = 0; i < nPts; i++) {
        const f = flags[i];
        if (f & 0x02) { const v = d[p++]; x += (f & 0x10) ? v : -v; }
        else if (!(f & 0x10)) { x += d.readInt16BE(p); p += 2; }
        xs.push(x);
      }
      const ys: number[] = []; let y = 0;
      for (let i = 0; i < nPts; i++) {
        const f = flags[i];
        if (f & 0x04) { const v = d[p++]; y += (f & 0x20) ? v : -v; }
        else if (!(f & 0x20)) { y += d.readInt16BE(p); p += 2; }
        ys.push(y);
      }
      const out: Outline = [];
      let start = 0;
      for (let c = 0; c < nContours; c++) {
        const pts: Pt[] = [];
        for (let i = start; i <= endPts[c]; i++) pts.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 0x01) });
        if (pts.length) out.push(pts);
        start = endPts[c] + 1;
      }
      return out;
    }
    // Composite glyph
    const out: Outline = [];
    let p = g + 10;
    while (true) {
      const flags = d.readUInt16BE(p); const comp = d.readUInt16BE(p + 2); p += 4;
      let arg1 = 0, arg2 = 0;
      if (flags & 0x0001) { arg1 = d.readInt16BE(p); arg2 = d.readInt16BE(p + 2); p += 4; }
      else { arg1 = d.readInt8(p); arg2 = d.readInt8(p + 1); p += 2; }
      let a = 1, b = 0, c = 0, dd = 1;
      if (flags & 0x0008) { a = d.readInt16BE(p) / 16384; dd = a; p += 2; }
      else if (flags & 0x0040) { a = d.readInt16BE(p) / 16384; dd = d.readInt16BE(p + 2) / 16384; p += 4; }
      else if (flags & 0x0080) { a = d.readInt16BE(p) / 16384; b = d.readInt16BE(p + 2) / 16384; c = d.readInt16BE(p + 4) / 16384; dd = d.readInt16BE(p + 6) / 16384; p += 8; }
      const dx = (flags & 0x0002) ? arg1 : 0, dy = (flags & 0x0002) ? arg2 : 0;
      for (const contour of this.outline(comp, depth + 1)) {
        out.push(contour.map(pt => ({ x: pt.x * a + pt.y * c + dx, y: pt.x * b + pt.y * dd + dy, on: pt.on })));
      }
      if (!(flags & 0x0020)) break;
    }
    return out;
  }
}

// ---------------------------------------------------------- rasterizer ---
const SS = 4; // 4x supersampling
function expandContour(pts: Pt[]): { x: number; y: number }[] {
  // Insert implied on-curve points between consecutive off-curve points,
  // and expand to a plain polyline (quadratic midpoints are close enough
  // at 4x supersampling for these small sizes).
  const n = pts.length;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    out.push({ x: p.x, y: p.y });
    if (!p.on && !q.on) out.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  }
  return out;
}

interface GlyphBmp { bmp: Uint8Array; w: number; h: number; ox: number; oy: number; adv: number }

function renderGlyph(font: Font, cp: number, px: number): GlyphBmp {
  const key = `${font.name}:${px}:${cp}`;
  const hit = font.cache.get(key);
  if (hit) return hit;
  const gid = font.glyphId(cp);
  const scale = px / font.unitsPerEm;
  const adv = font.advance(gid) * scale;
  const empty: GlyphBmp = { bmp: new Uint8Array(0), w: 0, h: 0, ox: 0, oy: 0, adv };
  if (gid === 0 || cp === 32) { font.cache.set(key, empty); return empty; }
  const outlines = font.outline(gid);
  if (!outlines.length) { font.cache.set(key, empty); return empty; }
  // Bounds in font units, y up.
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  const polys = outlines.map(expandContour);
  for (const poly of polys) for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const pad = 1;
  const w = Math.max(1, Math.ceil((maxX - minX) * scale) + pad * 2);
  const h = Math.max(1, Math.ceil((maxY - minY) * scale) + pad * 2);
  const ox = Math.floor(minX * scale) - pad;
  const oy = Math.floor(maxY * scale) + pad; // top in px coords (y down)
  // Supersampled coverage: SS x SS per pixel.
  const sw = w * SS, sh = h * SS;
  const cov = new Uint8Array(w * h); // 0..16
  // Scanline fill, even-odd, per supersampled row.
  const edges: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      // to pixel coords (y down), supersampled
      const x0 = (a.x * scale - ox) * SS, y0 = (oy - a.y * scale) * SS;
      const x1 = (b.x * scale - ox) * SS, y1 = (oy - b.y * scale) * SS;
      if (y0 !== y1) edges.push({ x0, y0, x1, y1 });
    }
  }
  for (let sy = 0; sy < sh; sy++) {
    const yc = sy + 0.5;
    const xs: number[] = [];
    for (const e of edges) {
      if ((yc >= Math.min(e.y0, e.y1)) && (yc < Math.max(e.y0, e.y1))) {
        xs.push(e.x0 + (e.x1 - e.x0) * (yc - e.y0) / (e.y1 - e.y0));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(xs[i])), x1 = Math.min(sw, Math.floor(xs[i + 1]));
      for (let sx = x0; sx < x1; sx++) cov[(sy / SS | 0) * w + (sx / SS | 0)]++;
    }
  }
  const bmp = new Uint8Array(w * h);
  for (let i = 0; i < bmp.length; i++) bmp[i] = Math.round(cov[i] * 255 / (SS * SS));
  const res: GlyphBmp = { bmp, w, h, ox, oy, adv };
  font.cache.set(key, res);
  return res;
}

function textWidth(font: Font, px: number, s: string, tracking = 0): number {
  let w = 0;
  for (const ch of s) {
    const g = renderGlyph(font, ch.codePointAt(0)!, px);
    w += g.adv + tracking;
  }
  return w - tracking;
}

function wrapText(font: Font, px: number, s: string, maxW: number, tracking = 0): string[] {
  const words = s.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? cur + ' ' + word : word;
    if (textWidth(font, px, test, tracking) <= maxW || !cur) cur = test;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------------------------------------------------------------- canvas --
type RGB = [number, number, number];
class Canvas {
  buf: Buffer;
  w: number; h: number;
  constructor(w: number, h: number, bg: RGB) {
    this.w = w; this.h = h;
    this.buf = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) { this.buf[i * 3] = bg[0]; this.buf[i * 3 + 1] = bg[1]; this.buf[i * 3 + 2] = bg[2]; }
  }
  set(x: number, y: number, c: RGB, a = 1) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    const i = (yi * this.w + xi) * 3;
    if (a >= 1) { this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2]; }
    else { this.buf[i] = Math.round(this.buf[i] * (1 - a) + c[0] * a); this.buf[i + 1] = Math.round(this.buf[i + 1] * (1 - a) + c[1] * a); this.buf[i + 2] = Math.round(this.buf[i + 2] * (1 - a) + c[2] * a); }
  }
  rect(x: number, y: number, w: number, h: number, c: RGB) {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.ceil(x + w)), y1 = Math.min(this.h, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const i = (yy * this.w + xx) * 3;
      this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2];
    }
  }
  hline(x0: number, x1: number, y: number, c: RGB) { this.rect(x0, y, x1 - x0, 1, c); }
  vline(x: number, y0: number, y1: number, c: RGB) { this.rect(x, y0, 1, y1 - y0, c); }
  line(x0: number, y0: number, x1: number, y1: number, c: RGB) {
    const dx = x1 - x0, dy = y1 - y0, steps = Math.max(Math.abs(dx), Math.abs(dy)) | 0;
    for (let i = 0; i <= steps; i++) this.set(x0 + dx * i / steps, y0 + dy * i / steps, c);
  }
  dashedLine(x0: number, y0: number, x1: number, y1: number, c: RGB, dash = 4, gap = 3) {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    const steps = Math.ceil(len);
    for (let i = 0; i <= steps; i++) if ((i % (dash + gap)) < dash) this.set(x0 + dx * i / len, y0 + dy * i / len, c);
  }
  circle(cx: number, cy: number, r: number, c: RGB) {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const ddx = x - cx, ddy = y - cy;
        if (ddx * ddx + ddy * ddy <= r2) this.set(x, y, c);
      }
  }
  ring(cx: number, cy: number, r: number, c: RGB, t = 1.5) {
    for (let a = 0; a < Math.PI * 2; a += 0.02) {
      for (let k = -t / 2; k <= t / 2; k += 0.5) this.set(cx + Math.cos(a) * (r + k), cy + Math.sin(a) * (r + k), c);
    }
  }
  poly(points: [number, number][], c: RGB) {
    let minY = 1e9, maxY = -1e9;
    for (const p of points) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      const xs: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        if ((y >= Math.min(a[1], b[1])) && (y < Math.max(a[1], b[1]))) {
          xs.push(a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]));
        }
      }
      xs.sort((x, y) => x - y);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.ceil(xs[i]); x < xs[i + 1]; x++) this.set(x, y, c);
      }
    }
  }
  vgrad(x: number, y: number, w: number, h: number, top: RGB, bot: RGB) {
    for (let yy = 0; yy < h; yy++) {
      const t = yy / Math.max(1, h - 1);
      const c: RGB = [Math.round(top[0] + (bot[0] - top[0]) * t), Math.round(top[1] + (bot[1] - top[1]) * t), Math.round(top[2] + (bot[2] - top[2]) * t)];
      this.rect(x, y + yy, w, 1, c);
    }
  }
  blit(g: GlyphBmp, dx: number, dy: number, c: RGB) {
    // dy = top of glyph bitmap in canvas coords
    for (let yy = 0; yy < g.h; yy++) {
      const cy = dy + yy;
      if (cy < 0 || cy >= this.h) continue;
      for (let xx = 0; xx < g.w; xx++) {
        const a = g.bmp[yy * g.w + xx];
        if (!a) continue;
        const cx = dx + xx;
        if (cx < 0 || cx >= this.w) continue;
        const i = (cy * this.w + cx) * 3;
        const al = a / 255;
        this.buf[i] = Math.round(this.buf[i] * (1 - al) + c[0] * al);
        this.buf[i + 1] = Math.round(this.buf[i + 1] * (1 - al) + c[1] * al);
        this.buf[i + 2] = Math.round(this.buf[i + 2] * (1 - al) + c[2] * al);
      }
    }
  }
  text(s: string, x: number, baselineY: number, font: Font, px: number, c: RGB, tracking = 0, align: 'l' | 'c' | 'r' = 'l') {
    const w = textWidth(font, px, s, tracking);
    let cx = x;
    if (align === 'c') cx = x - w / 2;
    else if (align === 'r') cx = x - w;
    for (const ch of s) {
      const g = renderGlyph(font, ch.codePointAt(0)!, px);
      if (g.w) this.blit(g, Math.round(cx + g.ox), Math.round(baselineY - g.oy), c);
      cx += g.adv + tracking;
    }
    return w;
  }
  para(s: string, x: number, y: number, maxW: number, font: Font, px: number, c: RGB, lh: number, tracking = 0): number {
    const lines = wrapText(font, px, s, maxW, tracking);
    let yy = y;
    for (const ln of lines) { this.text(ln, x, yy + px * 0.8, font, px, c, tracking); yy += lh; }
    return yy;
  }
}

// ------------------------------------------------------------------ fonts --
const SERIF = new Font(join(ROOT, 'fonts', 'LiberationSerif-Regular.ttf'), 'serif');
const SERIF_B = new Font(join(ROOT, 'fonts', 'LiberationSerif-Bold.ttf'), 'serifB');
const SERIF_I = new Font(join(ROOT, 'fonts', 'LiberationSerif-Italic.ttf'), 'serifI');
const SANS = new Font(join(ROOT, 'fonts', 'DejaVuSans.ttf'), 'sans');
const SANS_B = new Font(join(ROOT, 'fonts', 'DejaVuSans-Bold.ttf'), 'sansB');

// ----------------------------------------------------------------- colors --
const PAPER: RGB = [247, 243, 232];
const NAVY: RGB = [26, 42, 74];
const RED: RGB = [185, 28, 28];
const GOLD: RGB = [201, 162, 39];
const INK: RGB = [28, 26, 22];
const MUTED: RGB = [96, 88, 76];
const LINE: RGB = [190, 180, 162];
const WHITE: RGB = [255, 255, 255];
const CREAM: RGB = [250, 246, 236];
const REGION: Record<string, RGB> = {
  EUROPE: [43, 95, 138], AMERICAS: [46, 125, 79], ASIA: [107, 79, 161],
  AFRICA: [176, 106, 40], 'MIDDLE EAST': [160, 44, 44], OCEANIA: [42, 127, 127], WORLD: [95, 107, 122],
};

// ------------------------------------------------------------ art helpers --
function star(cv: Canvas, cx: number, cy: number, r: number, c: RGB) {
  cv.poly([[cx, cy - r], [cx + r * 0.28, cy - r * 0.28], [cx + r, cy], [cx + r * 0.28, cy + r * 0.28], [cx, cy + r], [cx - r * 0.28, cy + r * 0.28], [cx - r, cy], [cx - r * 0.28, cy - r * 0.28]], c);
}
function flag(cv: Canvas, x: number, y: number, w: number, h: number, kind: 'cn' | 'us' | 'ru') {
  // pole
  cv.rect(x - 1, y - 14, 2, h + 14, [60, 50, 40]);
  if (kind === 'cn') {
    cv.rect(x, y, w, h, [222, 41, 16]);
    star(cv, x + w * 0.28, y + h * 0.3, Math.min(w, h) * 0.16, [255, 222, 0]);
    star(cv, x + w * 0.55, y + h * 0.22, Math.min(w, h) * 0.07, [255, 222, 0]);
    star(cv, x + w * 0.62, y + h * 0.4, Math.min(w, h) * 0.07, [255, 222, 0]);
    star(cv, x + w * 0.55, y + h * 0.58, Math.min(w, h) * 0.07, [255, 222, 0]);
  } else if (kind === 'us') {
    const stripe = h / 13;
    for (let i = 0; i < 13; i++) cv.rect(x, y + i * stripe, w, stripe + 0.5, i % 2 === 0 ? [178, 34, 52] : [255, 255, 255]);
    cv.rect(x, y, w * 0.42, stripe * 7, [28, 42, 94]);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) star(cv, x + 3 + c * (w * 0.42 - 5) / 4, y + 3 + r * (stripe * 7 - 5) / 3, 1, [255, 255, 255]);
  } else {
    cv.rect(x, y, w, h / 3, [255, 255, 255]);
    cv.rect(x, y + h / 3, w, h / 3, [0, 57, 166]);
    cv.rect(x, y + 2 * h / 3, w, h / 3, [213, 0, 50]);
  }
}
function skyline(cv: Canvas, x: number, yBase: number, w: number, h: number, c: RGB, seed: number) {
  // deterministic pseudo-random skyline
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  let bx = x;
  while (bx < x + w - 8) {
    const bw = 8 + rnd() * 16;
    const bh = h * (0.3 + rnd() * 0.7);
    cv.rect(bx, yBase - bh, bw, bh, c);
    if (rnd() > 0.7) { // spire
      cv.poly([[bx + bw / 2 - 2, yBase - bh], [bx + bw / 2 + 2, yBase - bh], [bx + bw / 2, yBase - bh - 10]], c);
    }
    if (rnd() > 0.5) cv.rect(bx + 2, yBase - bh - 3, bw - 4, 3, c); // rooftop
    bx += bw + 2 + rnd() * 4;
  }
}
function windows(cv: Canvas, x: number, y: number, w: number, h: number, c: RGB) {
  for (let yy = y + 4; yy < y + h - 3; yy += 7)
    for (let xx = x + 3; xx < x + w - 3; xx += 6)
      if (((xx * 7 + yy * 13) % 11) < 5) cv.rect(xx, yy, 2, 3, c);
}

// -------------------------------------------------------------- hero art ---
function heroArt1(cv: Canvas, x: number, y: number, w: number, h: number) {
  // Shenzhen tarmac at sunset: warm sky, sun, skyline, 3 flags, red carpet.
  cv.vgrad(x, y, w, h, [248, 176, 88], [250, 214, 140]);
  cv.circle(x + w * 0.78, y + h * 0.3, 13, [255, 240, 190]);
  cv.circle(x + w * 0.78, y + h * 0.3, 17, [255, 220, 140]);
  skyline(cv, x + 4, y + h * 0.62, w - 8, h * 0.34, [52, 44, 66], 1234);
  windows(cv, x + 4, y + h * 0.3, w - 8, h * 0.3, [255, 214, 120]);
  cv.rect(x, y + h * 0.62, w, h * 0.38, [38, 36, 44]); // tarmac
  cv.rect(x, y + h * 0.66, w, 2, [220, 220, 220]);
  // red carpet
  cv.poly([[x + w * 0.34, y + h], [x + w * 0.44, y + h * 0.66], [x + w * 0.56, y + h * 0.66], [x + w * 0.66, y + h]], [150, 20, 20]);
  flag(cv, x + w * 0.14, y + h * 0.42, 26, 15, 'cn');
  flag(cv, x + w * 0.47, y + h * 0.42, 26, 15, 'us');
  flag(cv, x + w * 0.78, y + h * 0.42, 26, 15, 'ru');
}
function heroArt2(cv: Canvas, x: number, y: number, w: number, h: number) {
  // Night over the Gulf: stars, drones with dotted intercept paths, sea, ship.
  cv.vgrad(x, y, w, h, [8, 14, 40], [18, 34, 66]);
  let s = 777;
  for (let i = 0; i < 26; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; star(cv, x + (s % 1000) / 1000 * w, y + ((s >> 7) % 1000) / 1000 * h * 0.5, 1, [255, 255, 255]); }
  cv.circle(x + w * 0.85, y + h * 0.18, 9, [235, 235, 220]);
  // drones + dotted paths
  const drones: [number, number][] = [[0.18, 0.28], [0.42, 0.2], [0.62, 0.34], [0.8, 0.26]];
  for (const [fx, fy] of drones) {
    const dx = x + fx * w, dy = y + fy * h;
    cv.dashedLine(dx - 34, dy + 16, dx, dy, [255, 190, 90], 3, 3);
    cv.poly([[dx - 7, dy], [dx + 7, dy], [dx, dy + 3]], [40, 40, 46]);
    cv.circle(dx, dy - 1, 2, [255, 120, 60]);
  }
  // intercept burst
  star(cv, x + w * 0.55, y + h * 0.3, 6, [255, 200, 90]);
  // sea
  cv.rect(x, y + h * 0.68, w, h * 0.32, [10, 28, 52]);
  for (let i = 0; i < 4; i++) cv.line(x + 8 + i * 30, y + h * (0.74 + i * 0.05), x + 40 + i * 34, y + h * (0.74 + i * 0.05), [70, 110, 160]);
  // ship
  cv.rect(x + w * 0.6, y + h * 0.74, 52, 8, [30, 30, 36]);
  cv.rect(x + w * 0.6 + 14, y + h * 0.68, 18, 6, [30, 30, 36]);
  cv.rect(x + w * 0.6 + 30, y + h * 0.62, 3, 8, [30, 30, 36]);
  cv.circle(x + w * 0.6 + 31, y + h * 0.6, 2, [255, 80, 60]);
}
function heroArt3(cv: Canvas, x: number, y: number, w: number, h: number) {
  // Deep space: stars, small blue Earth, Voyager probe with dish, dotted path.
  cv.rect(x, y, w, h, [4, 6, 18]);
  let s = 4242;
  for (let i = 0; i < 40; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; star(cv, x + (s % 1000) / 1000 * w, y + ((s >> 7) % 1000) / 1000 * h, 1, [255, 255, 255]); }
  // Earth, small, lower left: blue disc, then green land patches on top
  cv.circle(x + w * 0.16, y + h * 0.72, 14, [52, 120, 200]);
  cv.circle(x + w * 0.16 - 4, y + h * 0.72 - 4, 4, [80, 170, 90]);
  cv.circle(x + w * 0.16 + 5, y + h * 0.72 + 4, 3.5, [80, 170, 90]);
  cv.circle(x + w * 0.16 + 2, y + h * 0.72 - 7, 2.5, [80, 170, 90]);
  // dotted path from Earth to probe
  cv.dashedLine(x + w * 0.2, y + h * 0.66, x + w * 0.66, y + h * 0.3, [255, 220, 120], 4, 4);
  // Voyager probe: gold body + white dish + booms
  const px = x + w * 0.68, py = y + h * 0.3;
  cv.line(px - 26, py + 10, px + 26, py - 10, [200, 200, 200]);
  cv.rect(px - 8, py - 6, 16, 12, [212, 175, 55]);
  cv.poly([[px + 6, py - 10], [px + 22, py - 18], [px + 22, py - 2], [px + 6, py + 2]], [240, 240, 240]);
  cv.line(px - 8, py + 6, px - 20, py + 16, [180, 180, 180]);
  cv.circle(px - 22, py + 17, 3, [255, 220, 120]);
  cv.text('1 LIGHT-DAY', px - 58, py - 14, SANS_B, 8, [255, 220, 120], 1);
}

// ------------------------------------------------------------ medium art ---
function medArt(cv: Canvas, id: number, x: number, y: number, w: number, h: number) {
  if (id === 4) { // drones over dark sky
    cv.vgrad(x, y, w, h, [16, 20, 44], [40, 52, 84]);
    cv.dashedLine(x + 8, y + h * 0.7, x + w * 0.4, y + h * 0.3, [255, 190, 90], 3, 3);
    cv.dashedLine(x + w * 0.6, y + h * 0.75, x + w * 0.8, y + h * 0.35, [255, 190, 90], 3, 3);
    cv.poly([[x + w * 0.38, y + h * 0.28], [x + w * 0.44, y + h * 0.28], [x + w * 0.41, y + h * 0.34]], [30, 30, 36]);
    star(cv, x + w * 0.82, y + h * 0.3, 5, [255, 200, 90]);
    cv.rect(x, y + h * 0.82, w, h * 0.18, [24, 24, 30]);
  } else if (id === 5) { // Fed: market bars falling
    cv.rect(x, y, w, h, [240, 238, 228]);
    const bars = [0.5, 0.62, 0.45, 0.7, 0.55, 0.8];
    for (let i = 0; i < bars.length; i++) {
      const bh = bars[i] * h * 0.7;
      cv.rect(x + 8 + i * 13, y + h - 6 - bh, 8, bh, i % 2 ? [46, 125, 79] : [185, 28, 28]);
    }
    cv.line(x + 6, y + h * 0.28, x + w - 6, y + h * 0.62, [28, 26, 22]);
    cv.poly([[x + w - 6, y + h * 0.62], [x + w - 14, y + h * 0.6], [x + w - 10, y + h * 0.72]], [28, 26, 22]);
  } else if (id === 6) { // cyclone spiral
    cv.vgrad(x, y, w, h, [120, 160, 200], [200, 220, 235]);
    const cx = x + w / 2, cy = y + h / 2;
    for (let r = 4; r < 26; r += 5) {
      for (let a = 0; a < Math.PI * 1.5; a += 0.08) {
        cv.set(cx + Math.cos(a + r * 0.12) * r * 1.3, cy + Math.sin(a + r * 0.12) * r * 0.8, [255, 255, 255]);
      }
    }
    cv.circle(cx, cy, 3, [40, 60, 90]);
    for (let i = 0; i < 5; i++) cv.line(x + 10 + i * 16, y + 4, x + 6 + i * 16, y + 12, [120, 150, 190]);
  } else if (id === 7) { // Sudan desert + sun
    cv.vgrad(x, y, w, h, [250, 210, 140], [240, 170, 90]);
    cv.circle(x + w * 0.78, y + h * 0.28, 8, [255, 240, 190]);
    cv.poly([[x, y + h], [x, y + h * 0.62], [x + w * 0.4, y + h * 0.78], [x + w * 0.7, y + h * 0.6], [x + w, y + h * 0.8], [x + w, y + h]], [200, 140, 70]);
    cv.poly([[x + w * 0.3, y + h * 0.3], [x + w * 0.36, y + h * 0.3], [x + w * 0.33, y + h * 0.36]], [40, 40, 46]);
    cv.poly([[x + w * 0.55, y + h * 0.22], [x + w * 0.61, y + h * 0.22], [x + w * 0.58, y + h * 0.28]], [40, 40, 46]);
  } else if (id === 8) { // EU stars circle + euro
    cv.rect(x, y, w, h, [28, 42, 94]);
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2 - Math.PI / 2;
      star(cv, x + w / 2 + Math.cos(a) * w * 0.32, y + h / 2 + Math.sin(a) * h * 0.32, 2.5, [255, 220, 60]);
    }
    cv.text('€45bn', x + w / 2, y + h / 2 + 5, SERIF_B, 13, [255, 220, 60], 0, 'c');
  } else if (id === 9) { // UK inflation rising line
    cv.rect(x, y, w, h, [240, 238, 228]);
    cv.line(x + 8, y + h * 0.72, x + w * 0.35, y + h * 0.6, [185, 28, 28]);
    cv.line(x + w * 0.35, y + h * 0.6, x + w * 0.62, y + h * 0.64, [185, 28, 28]);
    cv.line(x + w * 0.62, y + h * 0.64, x + w - 8, y + h * 0.3, [185, 28, 28]);
    cv.poly([[x + w - 8, y + h * 0.3], [x + w - 16, y + h * 0.3], [x + w - 10, y + h * 0.42]], [185, 28, 28]);
    cv.text('3.6%', x + w - 12, y + h * 0.22, SERIF_B, 12, [185, 28, 28], 0, 'r');
  } else if (id === 10) { // tank in Gaza desert
    cv.vgrad(x, y, w, h, [240, 220, 180], [210, 180, 130]);
    cv.rect(x, y + h * 0.72, w, h * 0.28, [180, 150, 100]);
    cv.rect(x + w * 0.2, y + h * 0.5, 52, 12, [70, 72, 60]);
    cv.rect(x + w * 0.32, y + h * 0.38, 22, 12, [70, 72, 60]);
    cv.line(x + w * 0.5, y + h * 0.42, x + w * 0.78, y + h * 0.36, [70, 72, 60]);
    for (let i = 0; i < 5; i++) cv.circle(x + w * 0.24 + i * 11, y + h * 0.66, 3, [40, 40, 36]);
    cv.rect(x + w * 0.1, y + h * 0.3, 2, 12, [120, 100, 70]);
  } else if (id === 11) { // Capitol dome + check
    cv.vgrad(x, y, w, h, [200, 215, 235], [240, 240, 235]);
    cv.rect(x + w * 0.18, y + h * 0.55, w * 0.64, h * 0.3, [220, 222, 226]);
    cv.poly([[x + w * 0.32, y + h * 0.55], [x + w * 0.68, y + h * 0.55], [x + w * 0.5, y + h * 0.28]], [200, 202, 206]);
    cv.circle(x + w * 0.5, y + h * 0.26, 3, [200, 202, 206]);
    cv.rect(x + w * 0.48, y + h * 0.16, 3, 10, [200, 202, 206]);
    for (let i = 0; i < 5; i++) cv.rect(x + w * 0.22 + i * 13, y + h * 0.6, 5, h * 0.2, [180, 182, 186]);
    // green checkmark (two thick strokes)
    cv.line(x + w * 0.68, y + h * 0.42, x + w * 0.76, y + h * 0.52, [46, 125, 79]);
    cv.line(x + w * 0.68, y + h * 0.44, x + w * 0.76, y + h * 0.54, [46, 125, 79]);
    cv.line(x + w * 0.76, y + h * 0.52, x + w * 0.9, y + h * 0.3, [46, 125, 79]);
    cv.line(x + w * 0.76, y + h * 0.54, x + w * 0.9, y + h * 0.32, [46, 125, 79]);
  } else if (id === 12) { // GTA VI: Vice City sunset + palms
    cv.vgrad(x, y, w, h, [250, 140, 90], [90, 40, 110]);
    cv.circle(x + w * 0.5, y + h * 0.55, 10, [255, 220, 150]);
    skyline(cv, x + 4, y + h * 0.8, w - 8, h * 0.4, [40, 20, 50], 99);
    // palm silhouettes
    for (const px of [0.16, 0.84]) {
      const bx = x + px * w, by = y + h * 0.85;
      cv.line(bx, by, bx + 3, by - 18, [30, 16, 40]);
      for (let a = 0; a < 5; a++) {
        const ang = Math.PI * (0.15 + a * 0.18);
        cv.line(bx + 3, by - 18, bx + 3 + Math.cos(ang) * 10, by - 18 - Math.sin(ang) * 6, [30, 16, 40]);
      }
    }
    cv.text('VI', x + w / 2, y + h * 0.42, SERIF_B, 16, [255, 240, 200], 0, 'c');
  } else if (id === 13) { // Bangladesh factories
    cv.vgrad(x, y, w, h, [230, 225, 210], [200, 190, 170]);
    cv.rect(x + 8, y + h * 0.5, 30, h * 0.35, [90, 88, 84]);
    cv.poly([[x + 8, y + h * 0.5], [x + 23, y + h * 0.38], [x + 38, y + h * 0.5]], [90, 88, 84]);
    cv.rect(x + 44, y + h * 0.42, 26, h * 0.43, [110, 108, 104]);
    cv.poly([[x + 44, y + h * 0.42], [x + 57, y + h * 0.32], [x + 70, y + h * 0.42]], [110, 108, 104]);
    cv.rect(x + 74, y + h * 0.3, 6, h * 0.55, [80, 78, 74]);
    cv.circle(x + 77, y + h * 0.24, 5, [200, 200, 195]);
    cv.circle(x + 80, y + h * 0.16, 7, [210, 210, 205]);
    cv.rect(x, y + h * 0.85, w, h * 0.15, [70, 68, 64]);
  }
}

// ------------------------------------------------------------------ map ---
// Simplified continent outlines in [lon, lat]; drawn as a dot matrix.
const CONTINENTS: number[][][] = [
  [[-168,66],[-165,60],[-158,58],[-152,60],[-140,60],[-135,57],[-130,54],[-125,49],[-124,42],[-120,34],[-114,29],[-110,24],[-105,20],[-97,16],[-94,17],[-90,14],[-86,12],[-83,9],[-80,8],[-77,8],[-79,9],[-82,10],[-84,13],[-87,15],[-90,14],[-92,15],[-95,16],[-97,19],[-97,26],[-93,30],[-89,30],[-84,30],[-81,26],[-80,32],[-76,35],[-74,40],[-70,42],[-68,44],[-65,45],[-60,47],[-55,47],[-53,48],[-56,50],[-60,52],[-64,58],[-68,58],[-72,62],[-78,62],[-85,66],[-92,66],[-95,69],[-110,68],[-125,70],[-140,70],[-155,71],[-165,68],[-168,66]],
  [[-58,64],[-52,60],[-44,60],[-40,64],[-32,68],[-22,70],[-20,74],[-25,78],[-40,80],[-55,80],[-60,76],[-58,70],[-58,64]],
  [[-77,8],[-80,5],[-81,0],[-80,-5],[-81,-6],[-77,-12],[-72,-18],[-70,-23],[-70,-30],[-72,-37],[-73,-44],[-74,-50],[-70,-54],[-66,-55],[-65,-50],[-62,-45],[-58,-38],[-52,-32],[-48,-28],[-41,-23],[-39,-18],[-35,-9],[-35,-6],[-40,-3],[-44,-2],[-50,0],[-52,4],[-55,6],[-60,8],[-62,9],[-68,11],[-72,12],[-76,10],[-77,8]],
  [[-6,35],[-10,31],[-15,27],[-17,21],[-17,15],[-15,12],[-12,8],[-8,5],[-4,5],[0,6],[6,4],[9,4],[9,0],[12,-4],[13,-10],[12,-17],[14,-22],[16,-28],[19,-34],[25,-34],[28,-32],[32,-28],[35,-24],[36,-20],[40,-16],[40,-10],[42,-4],[46,-1],[51,2],[51,11],[48,11],[44,11],[40,15],[38,18],[35,22],[32,28],[30,31],[25,32],[20,32],[15,32],[11,34],[10,37],[5,37],[0,36],[-6,35]],
  [[-10,36],[-9,43],[-2,44],[-1,46],[-4,48],[-2,49],[0,51],[3,53],[8,55],[8,57],[10,59],[5,60],[5,62],[10,64],[14,67],[18,69],[25,71],[30,70],[35,68],[40,68],[45,68],[50,69],[55,68],[60,69],[65,68],[70,70],[75,72],[80,73],[85,74],[90,75],[95,76],[100,77],[105,77],[110,74],[115,73],[120,73],[125,72],[130,72],[135,71],[140,72],[145,72],[150,70],[155,69],[158,66],[160,62],[162,58],[158,55],[156,52],[150,59],[145,59],[142,54],[140,50],[138,46],[135,43],[132,42],[130,42],[127,40],[126,38],[122,38],[120,35],[122,31],[120,28],[118,25],[116,23],[112,22],[108,20],[106,19],[104,16],[102,14],[100,12],[98,10],[97,8],[94,16],[92,21],[90,22],[88,22],[86,20],[84,18],[82,17],[80,15],[80,13],[77,8],[76,10],[74,14],[72,20],[70,21],[68,23],[66,25],[64,25],[62,25],[60,25],[58,26],[56,27],[54,26],[52,25],[50,26],[48,28],[48,30],[50,29],[52,28],[54,26],[56,26],[58,24],[59,22],[57,20],[55,18],[54,16],[52,15],[50,16],[48,15],[46,15],[44,13],[43,12],[42,13],[40,15],[39,18],[38,20],[36,22],[34,27],[34,29],[35,31],[36,36],[35,36],[32,36],[30,36],[27,37],[26,38],[23,36],[22,37],[20,39],[19,42],[16,44],[14,45],[12,44],[10,44],[8,44],[6,43],[3,43],[0,40],[-2,37],[-6,36],[-9,37],[-10,36]],
  [[114,-22],[114,-30],[115,-34],[118,-35],[124,-33],[129,-32],[132,-32],[135,-35],[138,-35],[140,-38],[145,-38],[150,-37],[153,-32],[153,-27],[150,-23],[146,-19],[142,-15],[142,-11],[140,-17],[136,-15],[135,-12],[132,-11],[130,-13],[126,-14],[122,-17],[118,-20],[114,-22]],
  [[167,-45],[170,-43],[173,-41],[175,-38],[177,-38],[175,-40],[173,-42],[170,-44],[167,-46],[167,-45]],
  [[44,-16],[47,-15],[50,-16],[50,-20],[48,-24],[45,-25],[43,-22],[43,-18],[44,-16]],
  [[-22,64],[-18,63],[-14,64],[-15,66],[-20,66],[-24,65],[-22,64]],
  [[-5,50],[-3,53],[-5,56],[-3,58],[-1,57],[0,53],[1,51],[-2,50],[-5,50]],
  [[130,31],[132,33],[134,34],[137,35],[139,37],[140,39],[141,41],[141,44],[143,44],[145,44],[142,42],[140,38],[138,36],[135,34],[132,33],[130,31]],
  [[95,5],[98,3],[100,0],[102,-3],[104,-5],[106,-6],[108,-7],[110,-7],[112,-7],[114,-8],[116,-8],[118,-9],[120,-9],[122,-9],[124,-10],[126,-9],[128,-6],[130,-4],[132,-2],[134,-3],[136,-4],[138,-6],[140,-7],[141,-5],[138,-2],[136,0],[134,1],[132,1],[130,0],[128,2],[126,3],[124,2],[122,0],[120,1],[118,2],[116,0],[114,1],[112,3],[110,2],[108,1],[106,0],[104,-1],[102,1],[100,3],[98,5],[95,5]],
  [[80,6],[81,7],[81,9],[80,9],[79,8],[80,6]],
  [[120,22],[121,23],[121,25],[120,25],[120,22]],
  [[120,18],[122,18],[122,16],[121,14],[120,13],[121,11],[122,10],[123,10],[124,11],[122,13],[120,14],[120,18]],
];
function onLand(lon: number, lat: number): boolean {
  for (const poly of CONTINENTS) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}
// [id, lat, lon] — red pins for stories 1–13 (3 = Voyager, drawn off-map)
const PINS: [number, number, number][] = [
  [1, 22.5, 114], [2, 26, 50.5], [4, 50.4, 30.5], [5, 43, -79], [6, 16, 84],
  [7, 13.2, 30.2], [8, 47, 11], [9, 52, 0], [10, 31.4, 34.4],
  [11, 35, -70], [12, -41.3, 174.8], [13, 26, 92],
];
const BRIEF_DOTS: [number, number][] = [
  [14.6, 121], [35.7, 139.7], [45.4, -75.7], [37.5, 127], [24.7, 46.7], [33.9, 35.5],
  [52.5, 13.4], [52.1, 4.3], [55.4, 86.1], [51.5, 3], [-4.3, 15.3], [38.9, -80],
  [14.7, 37.8], [9.5, -13.7], [-25.9, 32.6], [-25.7, 28.2], [37.8, -122.4], [10.5, -66.9],
  [4.7, -74.1], [-15.8, -47.9], [-3.6, -80.4], [36.9, 30.7], [45.1, 7.7], [48.9, 2.3],
  [-33.9, 151.2], [-6, 150], [-35.3, 149.1],
];
function drawMap(cv: Canvas, mx: number, my: number, mw: number, mh: number) {
  const lon0 = -180, lon1 = 180, lat0 = 80, lat1 = -55;
  const px = (lon: number) => mx + (lon - lon0) / (lon1 - lon0) * mw;
  const py = (lat: number) => my + (lat0 - lat) / (lat0 - lat1) * mh;
  // dot matrix, step 4px
  for (let gy = my + 2; gy < my + mh; gy += 4) {
    const lat = lat0 - (gy - my) / mh * (lat0 - lat1);
    for (let gx = mx + 2; gx < mx + mw; gx += 4) {
      const lon = lon0 + (gx - mx) / mw * (lon1 - lon0);
      if (onLand(lon, lat)) cv.circle(gx, gy, 1.3, [150, 140, 120]);
    }
  }
  // brief dots (grey, slightly larger)
  for (const [lat, lon] of BRIEF_DOTS) cv.circle(px(lon), py(lat), 2.2, [90, 84, 72]);
  // red numbered pins
  for (const [id, lat, lon] of PINS) {
    const cx = px(lon), cy = py(lat);
    cv.circle(cx, cy, 6, RED);
    cv.ring(cx, cy, 6, WHITE, 1);
    cv.text(String(id), cx, cy + 3, SANS_B, 8, WHITE, 0, 'c');
  }
  // Voyager: off-map label, top right, on a paper patch so dots don't show through
  cv.rect(mx + mw - 108, my + 2, 106, 12, [250, 246, 236]);
  cv.text('3 → VOYAGER 1', mx + mw - 4, my + 11, SANS_B, 8, [95, 107, 122], 0, 'r');
  star(cv, mx + mw - 96, my + 8, 3, [201, 162, 39]);
}

// ---------------------------------------------------------------- layout ---
const HEROES = [
  { id: 1, region: 'ASIA', tag: 'APEC SUMMIT', src: 'NPR · Reuters', head: 'Xi greets Trump on the tarmac in Shenzhen', body: "China's leader gives Trump a rare airport welcome as APEC opens; three-way talks with Putin are set for Thursday.", art: heroArt1 },
  { id: 2, region: 'MIDDLE EAST', tag: 'IRAN WAR', src: 'Reuters', head: 'Kuwait and Bahrain intercept Iranian drones', body: "Iran says it aimed at US forces at Kuwait's Ali Al Salem base after the US strike on Qeshm; an ADNOC ship is hit in Hormuz, 1 missing, 11 hurt.", art: heroArt2 },
  { id: 3, region: 'WORLD', tag: 'SPACE', src: 'NASA', head: 'Voyager 1 is one light-day from Earth', body: "NASA's 1977 probe is the first craft to get 25.9 billion km away; a radio command sent today arrives tomorrow. Nothing human-made has been farther.", art: heroArt3 },
];
const MEDIUMS = [
  { id: 4, region: 'EUROPE', tag: 'UKRAINE WAR', head: 'Russia fires 141 drones at Ukraine; 126 downed', body: 'Hits at seven sites overnight; four killed in the Donetsk region, its governor says.' },
  { id: 5, region: 'AMERICAS', tag: 'MARKETS', head: 'Fed minutes: almost all officials see more hikes', body: 'A bigger December rise is floated; the Dow drops 561 points (-1.1%).' },
  { id: 6, region: 'ASIA', tag: 'WEATHER', head: 'Cyclone Akvan veers north toward Odisha', body: 'India moves ~50,000 people to shelters; landfall due Friday 20 November.' },
  { id: 7, region: 'AFRICA', tag: 'SUDAN WAR', head: 'Amnesty: RSF drones killed 37 in El Obeid', body: 'It urges a war-crimes inquiry; the RSF blames Sudan\u2019s army for the deaths.' },
  { id: 8, region: 'EUROPE', tag: 'UKRAINE AID', head: 'EU proposes €45bn loan to fund Ukraine in 2027', body: 'Two-thirds of a €70bn gap, repaid only once Russia pays reparations.' },
  { id: 9, region: 'EUROPE', tag: 'ECONOMY', head: 'UK inflation climbs to 3.6%, a one-year high', body: 'Fuel prices and a tobacco duty rise pushed October CPI up from 3.5%.' },
  { id: 10, region: 'MIDDLE EAST', tag: 'GAZA', head: 'Israeli tanks push into central Gaza near Nuseirat', body: 'The army says it is destroying a tunnel past the Yellow Line; three killed.' },
  { id: 11, region: 'AMERICAS', tag: 'US POLITICS', head: 'Jeffries wins Democrats\u2019 nod for House Speaker', body: 'On course to be the first Black Speaker when the House votes on 3 January.' },
  { id: 12, region: 'WORLD', tag: 'CULTURE', head: 'GTA VI goes on sale after a 13-year wait', body: 'New Zealand plays first at midnight; 14.9m digital pre-orders banked.' },
  { id: 13, region: 'ASIA', tag: 'LABOUR', head: 'Bangladesh wage protests shut 55 factories', body: 'Police tear-gas garment workers blocking a highway over pay.' },
];
const BRIEFS = [
  'Manila: Trump hails the \u2018biggest\u2019 Philippine trade deal',
  'Tokyo: Takaichi makes first China visit since 2019',
  'Ottawa: Carney and Xi agree tariff relief at APEC',
  'Seoul: Lee seeks Xi\u2019s help on the North',
  'Riyadh: the coalition downs a Houthi cruise missile',
  'Beirut: World Bank warns Lebanon\u2019s rebuilding lags badly',
  'Berlin: Germany pledges air defences and F-16 ammo to Kyiv',
  'The Hague: a court gives ex-president Thaci 17 months',
  'Kemerovo: 19 die in an An-12 plane crash, media say',
  'London: Britain hands a US Army spy suspect to Washington',
  'Kinshasa: Ebola passes 11,300 cases; WHO keeps global emergency',
  'Washington: US loses measles-elimination status after 26 years',
  'Badme: Ethiopia and Eritrea trade artillery fire in a buildup',
  'Guinea: 224 jailed over illegal gold mining',
  'Maputo: opposition leader Mondlane goes on trial',
  'Pretoria: South Africa reprimands Nigeria\u2019s incoming envoy',
  'San Francisco: Anthropic prices $81bn IPO at $83; trading Thursday',
  'Caracas: Hegseth visits and seals a defence pact',
  'Bogota: Colombia\u2019s economy shrinks 0.8% in the third quarter',
  'Brasilia: the Senate passes Lula\u2019s $10bn fiscal package',
  'Peru: the Tumbes River passes its red-alert level',
  'Antalya: COP31 ministers weigh a divided fossil-fuel draft',
  'Turin: Alcaraz beats Medvedev 6\u20132, 6\u20134 in the Finals',
  'Paris: FIFA \u2014 France\u2019s Diallo to challenge Infantino',
  'Sydney: Tame Impala sweeps seven ARIA Music Awards',
  'Pacific: Cat-5 Cyclone Xavier turns east; a 6.0 quake hits PNG',
  'Canberra: Australia sanctions settler leader Daniella Weiss',
];

function build(): Buffer {
  const cv = new Canvas(W, H, PAPER);
  // ---- masthead
  cv.rect(0, 0, W, 92, NAVY);
  cv.rect(10, 8, 96, 76, RED);
  cv.text('NOV', 58, 30, SANS_B, 15, WHITE, 1, 'c');
  cv.text('18', 58, 62, SERIF_B, 34, WHITE, 0, 'c');
  cv.text('WED · 2026', 58, 78, SANS_B, 9, WHITE, 1, 'c');
  cv.text('THE DAY IN WORLD NEWS', 118, 26, SANS_B, 13, GOLD, 2);
  cv.text('Wednesday 18 November 2026', 118, 64, SERIF_B, 36, WHITE);
  cv.text('Everything on this page happened, or was first reported, on Wednesday 18 November 2026.', 118, 84, SERIF_I, 12.5, [200, 205, 220]);
  cv.text('40 STORIES', 1014, 30, SERIF_B, 20, WHITE, 0, 'r');
  cv.text('7 REGIONS', 1014, 50, SANS_B, 12, GOLD, 1, 'r');
  cv.text('ONE PAGE', 1014, 68, SANS_B, 12, GOLD, 1, 'r');
  // ---- region strip
  const regions: [string, number][] = [['EUROPE', 8], ['AMERICAS', 9], ['ASIA', 6], ['AFRICA', 6], ['MIDDLE EAST', 4], ['OCEANIA', 3], ['WORLD', 4]];
  let rx = 10;
  for (const [name, n] of regions) {
    const rw = n / 40 * 1004;
    cv.rect(rx, 96, rw, 22, REGION[name]);
    cv.text(`${name} ${n}`, rx + rw / 2, 111, SANS_B, 10, WHITE, 0, 'c');
    rx += rw;
  }
  // ---- stat strip
  cv.text('THE DAY', 40, 138, SANS_B, 9, MUTED, 1, 'c');
  cv.text('IN NUMBERS', 40, 152, SANS_B, 9, MUTED, 1, 'c');
  const stats: [string, string, RGB][] = [
    ['141', 'Russian drones fired at Ukraine overnight', RED],
    ['126', 'of them downed, Kyiv\u2019s air force says', INK],
    ['25.9bn km', 'Voyager 1 from Earth \u2014 one light-day out', [43, 95, 138]],
    ['55', 'factories shut by Bangladesh wage protests', INK],
    ['251\u201311', 'the caucus vote that nominates Jeffries', INK],
    ['11,300+', 'Ebola cases counted in DR Congo', INK],
  ];
  let sx = 76;
  const sw = (1014 - 76) / 6;
  for (const [num, cap, col] of stats) {
    cv.text(num, sx + 4, 142, SERIF_B, 20, col);
    cv.para(cap, sx + 4, 146, sw - 10, SERIF, 9.5, MUTED, 11.5);
    sx += sw;
    if (sx < 1010) cv.vline(Math.round(sx), 126, 166, LINE);
  }
  cv.hline(10, 1014, 170, LINE);
  // ---- heroes
  for (let i = 0; i < 3; i++) {
    const hh = HEROES[i];
    const x = 10 + i * 336, w = 332;
    hh.art(cv, x, 174, w, 70);
    cv.rect(x, 244, w, 14, REGION[hh.region]);
    cv.text(`${hh.id} · ${hh.region} · ${hh.tag}`, x + 6, 254, SANS_B, 9, WHITE, 0.5);
    cv.text(hh.src, x + w - 6, 254, SERIF_I, 9, [230, 230, 230], 0, 'r');
    cv.para(hh.head, x, 262, w, SERIF_B, 18, INK, 20);
    cv.para(hh.body, x, 304, w, SERIF, 10.5, [60, 56, 48], 12.5);
  }
  // ---- mediums
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 5; c++) {
      const m = MEDIUMS[r * 5 + c];
      const x = 10 + c * 204.5, y = 340 + r * 134, w = 198;
      medArt(cv, m.id, x, y, w, 46);
      cv.rect(x, y + 46, w, 13, REGION[m.region]);
      cv.text(`${m.id} · ${m.region} · ${m.tag}`, x + 5, y + 56, SANS_B, 8, WHITE, 0.5);
      cv.para(m.head, x, y + 62, w, SERIF_B, 12.5, INK, 14.5);
      cv.para(m.body, x, y + 94, w, SERIF, 10, [60, 56, 48], 12);
    }
  }
  cv.hline(10, 1014, 612, LINE);
  // ---- bottom: map + briefs
  cv.rect(10, 618, 320, 262, CREAM);
  cv.rect(10, 618, 320, 262, CREAM);
  cv.hline(10, 330, 618, LINE); cv.hline(10, 330, 880, LINE);
  cv.vline(10, 618, 880, LINE); cv.vline(330, 618, 880, LINE);
  cv.text('WHERE IT HAPPENED', 20, 634, SANS_B, 11, INK, 1);
  drawMap(cv, 18, 642, 304, 196);
  cv.text('Red pins: stories 1\u201313; dots: briefs 14\u201340', 20, 852, SERIF_I, 9.5, MUTED);
  cv.text('positions approximate', 20, 866, SERIF_I, 9.5, MUTED);
  cv.rect(338, 618, 676, 262, CREAM);
  cv.hline(338, 1014, 618, LINE); cv.hline(338, 1014, 880, LINE);
  cv.vline(338, 618, 880, LINE); cv.vline(1014, 618, 880, LINE);
  cv.text('ALSO ON WEDNESDAY 18 NOVEMBER \u2014 27 MORE STORIES', 350, 634, SANS_B, 11, INK, 1);
  for (let i = 0; i < 27; i++) {
    const col = i < 14 ? 0 : 1;
    const row = i < 14 ? i : i - 14;
    const bx = col === 0 ? 350 : 684;
    const by = 646 + row * 17.2;
    const n = 14 + i;
    cv.text(String(n), bx, by + 8, SERIF_B, 10, RED, 0, 'r');
    cv.text(BRIEFS[i], bx + 6, by + 8, SERIF, 9.5, INK);
  }
  // ---- date check
  cv.rect(10, 888, 1004, 64, CREAM);
  cv.hline(10, 1014, 888, RED); cv.hline(10, 1014, 952, RED);
  cv.vline(10, 888, 952, RED); cv.vline(1014, 888, 952, RED);
  cv.hline(10, 1014, 890, RED);
  cv.text('DATE CHECK', 22, 908, SANS_B, 11, RED, 1);
  cv.para('Left out on purpose \u2014 each was first reported on Tuesday 17 November: the Trump\u2013Xi\u2013Putin talks (Thu 19) \u00b7 Cyclone Akvan\u2019s landfall (Fri 20) \u00b7 the close of COP31 (Fri 20) \u00b7 the Kerch Bridge collapse \u00b7 the Knesset speaker vote \u00b7 Nvidia\u2019s results \u00b7 Peltola\u2019s Alaska Senate win \u00b7 Mongolia\u2019s president resigning \u00b7 the Prague train crash.', 22, 912, 980, SERIF, 11, INK, 14);
  // ---- footer
  cv.text('Sources: Reuters \u00b7 AP \u00b7 AFP \u00b7 BBC \u00b7 Al Jazeera \u00b7 ONS \u00b7 IMD \u00b7 NASA \u00b7 Amnesty \u00b7 WHO \u2014 every story happened, or was first reported, on Wednesday 18 November 2026.', 512, 972, SERIF, 9.5, MUTED, 0, 'c');
  return encodePNG(cv.buf, W, H);
}

function main() {
  const png = build();
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, 'entry.png');
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
main();
