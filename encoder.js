/*
 * GifX encoder — runs inside Web Workers.
 *
 * The whole worker lives inside one function so it can be started from a Blob URL.
 * That way the app also works when index.html is opened straight from disk (file://),
 * where browsers refuse `new Worker('file.js')`.
 *
 * Per frame:
 *   1. Palette: exact colors when the frame has few of them, otherwise Wu's quantizer
 *      followed by k-means refinement (perceptual "redmean" distance).
 *   2. Mapping: error-diffusion (Floyd–Steinberg / Sierra / Sierra Lite / Atkinson, serpentine)
 *      or ordered Bayer 8x8 dithering, or plain nearest color.
 *   3. LZW compression into GIF sub-blocks.
 */
'use strict';

function GifXWorker() {
  const SIZE = 33;
  const SZ3 = SIZE * SIZE * SIZE;
  let cache = null; // nearest-color cache, 7 bits per channel

  // ---------------------------------------------------------------- distance
  function nearestBrute(pal, n, r, g, b) {
    let best = 0, bd = Infinity;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const pr = pal[j], pg = pal[j + 1], pb = pal[j + 2];
      const rm = (r + pr) >> 1, dr = r - pr, dg = g - pg, db = b - pb;
      const d = (512 + rm) * dr * dr + 1024 * dg * dg + (767 - rm) * db * db;
      if (d < bd) { bd = d; best = i; if (d === 0) break; }
    }
    return best;
  }

  function makeLookup(pal, n) {
    if (!cache) cache = new Int16Array(1 << 21);
    cache.fill(-1);
    return function (r, g, b) {
      const k = ((r >> 1) << 14) | ((g >> 1) << 7) | (b >> 1);
      let v = cache[k];
      if (v < 0) { v = nearestBrute(pal, n, r, g, b); cache[k] = v; }
      return v;
    };
  }

  // ---------------------------------------------------------------- exact colors
  function exactColors(rgba, mask, limit) {
    const seen = new Map();
    const len = rgba.length >> 2;
    for (let p = 0; p < len; p++) {
      if (mask && !mask[p]) continue;
      const o = p << 2;
      const key = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
      if (!seen.has(key)) {
        if (seen.size >= limit) return null;
        seen.set(key, 1);
      }
    }
    const n = Math.max(1, seen.size);
    const pal = new Uint8Array(n * 3);
    let i = 0;
    for (const key of seen.keys()) {
      pal[i++] = (key >> 16) & 255; pal[i++] = (key >> 8) & 255; pal[i++] = key & 255;
    }
    return { pal, n };
  }

  // ---------------------------------------------------------------- Wu quantizer
  const ix = (r, g, b) => (r * SIZE + g) * SIZE + b;

  function wuQuantize(rgba, mask, maxColors) {
    const wt = new Float64Array(SZ3), mr = new Float64Array(SZ3), mg = new Float64Array(SZ3),
      mb = new Float64Array(SZ3), m2 = new Float64Array(SZ3);
    const len = rgba.length >> 2;
    let total = 0;
    for (let p = 0; p < len; p++) {
      if (mask && !mask[p]) continue;
      const o = p << 2, r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      const k = (((r >> 3) + 1) * SIZE + ((g >> 3) + 1)) * SIZE + ((b >> 3) + 1);
      wt[k]++; mr[k] += r; mg[k] += g; mb[k] += b; m2[k] += r * r + g * g + b * b;
      total++;
    }
    if (!total) return { pal: new Uint8Array(3), n: 1, bins: null };

    // occupied bins (raw histogram) — used later for k-means refinement
    let nb = 0;
    for (let k = 0; k < SZ3; k++) if (wt[k]) nb++;
    const bins = { n: nb, r: new Float32Array(nb), g: new Float32Array(nb), b: new Float32Array(nb), w: new Float32Array(nb) };
    for (let k = 0, j = 0; k < SZ3; k++) {
      const w = wt[k];
      if (!w) continue;
      bins.r[j] = mr[k] / w; bins.g[j] = mg[k] / w; bins.b[j] = mb[k] / w; bins.w[j] = w; j++;
    }

    // cumulative moments
    const aw = new Float64Array(SIZE), ar = new Float64Array(SIZE), ag = new Float64Array(SIZE),
      ab = new Float64Array(SIZE), a2 = new Float64Array(SIZE);
    for (let r = 1; r < SIZE; r++) {
      aw.fill(0); ar.fill(0); ag.fill(0); ab.fill(0); a2.fill(0);
      for (let g = 1; g < SIZE; g++) {
        let lw = 0, lr = 0, lg = 0, lb = 0, l2 = 0;
        for (let b = 1; b < SIZE; b++) {
          const i1 = (r * SIZE + g) * SIZE + b;
          lw += wt[i1]; lr += mr[i1]; lg += mg[i1]; lb += mb[i1]; l2 += m2[i1];
          aw[b] += lw; ar[b] += lr; ag[b] += lg; ab[b] += lb; a2[b] += l2;
          const i2 = i1 - SIZE * SIZE;
          wt[i1] = wt[i2] + aw[b]; mr[i1] = mr[i2] + ar[b]; mg[i1] = mg[i2] + ag[b];
          mb[i1] = mb[i2] + ab[b]; m2[i1] = m2[i2] + a2[b];
        }
      }
    }

    const vol = (c, m) =>
      m[ix(c.r1, c.g1, c.b1)] - m[ix(c.r1, c.g1, c.b0)] - m[ix(c.r1, c.g0, c.b1)] + m[ix(c.r1, c.g0, c.b0)]
      - m[ix(c.r0, c.g1, c.b1)] + m[ix(c.r0, c.g1, c.b0)] + m[ix(c.r0, c.g0, c.b1)] - m[ix(c.r0, c.g0, c.b0)];

    const bottom = (c, d, m) => {
      if (d === 0) return -m[ix(c.r0, c.g1, c.b1)] + m[ix(c.r0, c.g1, c.b0)] + m[ix(c.r0, c.g0, c.b1)] - m[ix(c.r0, c.g0, c.b0)];
      if (d === 1) return -m[ix(c.r1, c.g0, c.b1)] + m[ix(c.r1, c.g0, c.b0)] + m[ix(c.r0, c.g0, c.b1)] - m[ix(c.r0, c.g0, c.b0)];
      return -m[ix(c.r1, c.g1, c.b0)] + m[ix(c.r1, c.g0, c.b0)] + m[ix(c.r0, c.g1, c.b0)] - m[ix(c.r0, c.g0, c.b0)];
    };
    const top = (c, d, pos, m) => {
      if (d === 0) return m[ix(pos, c.g1, c.b1)] - m[ix(pos, c.g1, c.b0)] - m[ix(pos, c.g0, c.b1)] + m[ix(pos, c.g0, c.b0)];
      if (d === 1) return m[ix(c.r1, pos, c.b1)] - m[ix(c.r1, pos, c.b0)] - m[ix(c.r0, pos, c.b1)] + m[ix(c.r0, pos, c.b0)];
      return m[ix(c.r1, c.g1, pos)] - m[ix(c.r1, c.g0, pos)] - m[ix(c.r0, c.g1, pos)] + m[ix(c.r0, c.g0, pos)];
    };
    const variance = (c) => {
      const dr = vol(c, mr), dg = vol(c, mg), db = vol(c, mb);
      return vol(c, m2) - (dr * dr + dg * dg + db * db) / vol(c, wt);
    };
    const maximize = (c, d, first, last, wR, wG, wB, wW) => {
      const bR = bottom(c, d, mr), bG = bottom(c, d, mg), bB = bottom(c, d, mb), bW = bottom(c, d, wt);
      let max = 0, cut = -1;
      for (let i = first; i < last; i++) {
        let hR = bR + top(c, d, i, mr), hG = bG + top(c, d, i, mg), hB = bB + top(c, d, i, mb), hW = bW + top(c, d, i, wt);
        if (hW === 0) continue;
        let t = (hR * hR + hG * hG + hB * hB) / hW;
        hR = wR - hR; hG = wG - hG; hB = wB - hB; hW = wW - hW;
        if (hW === 0) continue;
        t += (hR * hR + hG * hG + hB * hB) / hW;
        if (t > max) { max = t; cut = i; }
      }
      return [max, cut];
    };
    const cutBox = (s1, s2) => {
      const wR = vol(s1, mr), wG = vol(s1, mg), wB = vol(s1, mb), wW = vol(s1, wt);
      const [maxr, cutr] = maximize(s1, 0, s1.r0 + 1, s1.r1, wR, wG, wB, wW);
      const [maxg, cutg] = maximize(s1, 1, s1.g0 + 1, s1.g1, wR, wG, wB, wW);
      const [maxb, cutb] = maximize(s1, 2, s1.b0 + 1, s1.b1, wR, wG, wB, wW);
      let d;
      if (maxr >= maxg && maxr >= maxb) { d = 0; if (cutr < 0) return false; }
      else if (maxg >= maxr && maxg >= maxb) d = 1;
      else d = 2;
      s2.r1 = s1.r1; s2.g1 = s1.g1; s2.b1 = s1.b1;
      if (d === 0) { s2.r0 = s1.r1 = cutr; s2.g0 = s1.g0; s2.b0 = s1.b0; }
      else if (d === 1) { s2.g0 = s1.g1 = cutg; s2.r0 = s1.r0; s2.b0 = s1.b0; }
      else { s2.b0 = s1.b1 = cutb; s2.r0 = s1.r0; s2.g0 = s1.g0; }
      s1.vol = (s1.r1 - s1.r0) * (s1.g1 - s1.g0) * (s1.b1 - s1.b0);
      s2.vol = (s2.r1 - s2.r0) * (s2.g1 - s2.g0) * (s2.b1 - s2.b0);
      return true;
    };

    const cubes = [{ r0: 0, g0: 0, b0: 0, r1: 32, g1: 32, b1: 32, vol: 32 * 32 * 32 }];
    const vv = new Float64Array(maxColors);
    let K = maxColors, next = 0;
    for (let i = 1; i < K; i++) {
      cubes[i] = { r0: 0, g0: 0, b0: 0, r1: 0, g1: 0, b1: 0, vol: 0 };
      if (cutBox(cubes[next], cubes[i])) {
        vv[next] = cubes[next].vol > 1 ? variance(cubes[next]) : 0;
        vv[i] = cubes[i].vol > 1 ? variance(cubes[i]) : 0;
      } else {
        vv[next] = 0; i--;
      }
      next = 0;
      let t = vv[0];
      for (let k = 1; k <= i; k++) if (vv[k] > t) { t = vv[k]; next = k; }
      if (t <= 0) { K = i + 1; break; }
    }

    const tmp = [];
    for (let k = 0; k < K; k++) {
      const c = cubes[k];
      const w = vol(c, wt);
      if (w > 0) tmp.push(Math.round(vol(c, mr) / w), Math.round(vol(c, mg) / w), Math.round(vol(c, mb) / w));
    }
    return { pal: Uint8Array.from(tmp), n: tmp.length / 3, bins };
  }

  // k-means refinement over the histogram bins (weighted by pixel count)
  function refine(pal, n, bins, iterations) {
    if (!bins || n < 2) return;
    const sum = new Float64Array(n * 4);
    for (let it = 0; it < iterations; it++) {
      sum.fill(0);
      for (let j = 0; j < bins.n; j++) {
        const r = bins.r[j], g = bins.g[j], b = bins.b[j], w = bins.w[j];
        const i = nearestBrute(pal, n, Math.round(r), Math.round(g), Math.round(b)) * 4;
        sum[i] += r * w; sum[i + 1] += g * w; sum[i + 2] += b * w; sum[i + 3] += w;
      }
      let moved = 0;
      for (let i = 0; i < n; i++) {
        const w = sum[i * 4 + 3];
        if (!w) continue;
        const r = Math.round(sum[i * 4] / w), g = Math.round(sum[i * 4 + 1] / w), b = Math.round(sum[i * 4 + 2] / w);
        moved += Math.abs(r - pal[i * 3]) + Math.abs(g - pal[i * 3 + 1]) + Math.abs(b - pal[i * 3 + 2]);
        pal[i * 3] = r; pal[i * 3 + 1] = g; pal[i * 3 + 2] = b;
      }
      if (moved === 0) break;
    }
  }

  function buildPalette(rgba, mask, maxColors) {
    maxColors = Math.max(1, Math.min(256, maxColors | 0));
    const exact = exactColors(rgba, mask, maxColors);
    if (exact) return exact;
    const q = wuQuantize(rgba, mask, maxColors);
    refine(q.pal, q.n, q.bins, 6);
    return { pal: q.pal, n: q.n };
  }

  // ---------------------------------------------------------------- dithering
  const KERNELS = {
    fs: [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]],
    sierra: [[1, 0, 5 / 32], [2, 0, 3 / 32], [-2, 1, 2 / 32], [-1, 1, 4 / 32], [0, 1, 5 / 32], [1, 1, 4 / 32], [2, 1, 2 / 32],
      [-1, 2, 2 / 32], [0, 2, 3 / 32], [1, 2, 2 / 32]],
    sierralite: [[1, 0, 2 / 4], [-1, 1, 1 / 4], [0, 1, 1 / 4]],
    atkinson: [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]],
  };
  const BAYER8 = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
  ];
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

  function mapPixels(rgba, w, h, mask, pal, n, tIndex, dither, strength) {
    const out = new Uint8Array(w * h);
    const look = makeLookup(pal, n);
    const kernel = KERNELS[dither];

    if (kernel && strength > 0) {
      const W3 = (w + 4) * 3;
      const rows = [new Float32Array(W3), new Float32Array(W3), new Float32Array(W3)];
      for (let y = 0; y < h; y++) {
        const rev = (y & 1) === 1;
        const e0 = rows[0];
        for (let xi = 0; xi < w; xi++) {
          const x = rev ? w - 1 - xi : xi;
          const p = y * w + x;
          if (mask && !mask[p]) { out[p] = tIndex; continue; }
          const o = p << 2, ei = (x + 2) * 3;
          const r = clamp(rgba[o] + e0[ei]), g = clamp(rgba[o + 1] + e0[ei + 1]), b = clamp(rgba[o + 2] + e0[ei + 2]);
          const c = look(r, g, b);
          out[p] = c;
          const er = (r - pal[c * 3]) * strength, eg = (g - pal[c * 3 + 1]) * strength, eb = (b - pal[c * 3 + 2]) * strength;
          if (er === 0 && eg === 0 && eb === 0) continue;
          for (let k = 0; k < kernel.length; k++) {
            const kk = kernel[k];
            const ti = (x + (rev ? -kk[0] : kk[0]) + 2) * 3;
            const row = rows[kk[1]], f = kk[2];
            row[ti] += er * f; row[ti + 1] += eg * f; row[ti + 2] += eb * f;
          }
        }
        const t = rows[0]; rows[0] = rows[1]; rows[1] = rows[2]; rows[2] = t; t.fill(0);
      }
      return out;
    }

    const spread = dither === 'bayer' ? strength * 0.6 * 255 / Math.cbrt(Math.max(2, n)) : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (mask && !mask[p]) { out[p] = tIndex; continue; }
        const o = p << 2;
        if (spread) {
          const t = ((BAYER8[((y & 7) << 3) | (x & 7)] + 0.5) / 64 - 0.5) * spread;
          out[p] = look(clamp(rgba[o] + t), clamp(rgba[o + 1] + t), clamp(rgba[o + 2] + t));
        } else {
          out[p] = look(rgba[o], rgba[o + 1], rgba[o + 2]);
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- LZW
  function lzwEncode(pixels, minCodeSize) {
    const BITS = 12, HSIZE = 5003, MAXMAX = 1 << BITS;
    const htab = new Int32Array(HSIZE), codetab = new Int32Array(HSIZE);
    const masks = [0x0000, 0x0001, 0x0003, 0x0007, 0x000F, 0x001F, 0x003F, 0x007F, 0x00FF,
      0x01FF, 0x03FF, 0x07FF, 0x0FFF, 0x1FFF, 0x3FFF, 0x7FFF, 0xFFFF];
    let buf = new Uint8Array(Math.max(1024, pixels.length >> 1)), blen = 0;
    const byteOut = (v) => {
      if (blen === buf.length) { const nb = new Uint8Array(buf.length * 2); nb.set(buf); buf = nb; }
      buf[blen++] = v;
    };

    const initBits = minCodeSize + 1;
    const clearCode = 1 << minCodeSize, eofCode = clearCode + 1;
    let nBits = initBits, maxcode = (1 << nBits) - 1;
    let freeEnt = clearCode + 2, clearFlg = false;
    let curAccum = 0, curBits = 0;

    const output = (code) => {
      curAccum &= masks[curBits];
      if (curBits > 0) curAccum |= code << curBits; else curAccum = code;
      curBits += nBits;
      while (curBits >= 8) { byteOut(curAccum & 0xff); curAccum >>>= 8; curBits -= 8; }
      if (freeEnt > maxcode || clearFlg) {
        if (clearFlg) { nBits = initBits; maxcode = (1 << nBits) - 1; clearFlg = false; }
        else { nBits++; maxcode = nBits === BITS ? MAXMAX : (1 << nBits) - 1; }
      }
      if (code === eofCode) {
        while (curBits > 0) { byteOut(curAccum & 0xff); curAccum >>>= 8; curBits -= 8; }
      }
    };

    htab.fill(-1);
    output(clearCode);
    const len = pixels.length;
    let ent = len ? pixels[0] : 0;
    const hshift = 4; // 8 - log2-ish(HSIZE) as in the classic compress()
    outer:
    for (let p = 1; p < len; p++) {
      const c = pixels[p];
      const fcode = (c << BITS) + ent;
      let i = (c << hshift) ^ ent;
      if (htab[i] === fcode) { ent = codetab[i]; continue; }
      if (htab[i] >= 0) {
        const disp = i === 0 ? 1 : HSIZE - i;
        do {
          i -= disp;
          if (i < 0) i += HSIZE;
          if (htab[i] === fcode) { ent = codetab[i]; continue outer; }
        } while (htab[i] >= 0);
      }
      output(ent);
      ent = c;
      if (freeEnt < MAXMAX) {
        codetab[i] = freeEnt++;
        htab[i] = fcode;
      } else {
        htab.fill(-1);
        freeEnt = clearCode + 2;
        clearFlg = true;
        output(clearCode);
      }
    }
    output(ent);
    output(eofCode);

    // pack into GIF sub-blocks: [minCodeSize][len][data...]...[0]
    const blocks = Math.ceil(blen / 255);
    const res = new Uint8Array(1 + blen + blocks + 1);
    let o = 0;
    res[o++] = minCodeSize;
    for (let s = 0; s < blen; s += 255) {
      const n = Math.min(255, blen - s);
      res[o++] = n;
      res.set(buf.subarray(s, s + n), o);
      o += n;
    }
    res[o++] = 0;
    return res;
  }

  // ---------------------------------------------------------------- messages
  self.onmessage = (e) => {
    const m = e.data;
    try {
      if (m.type === 'palette') {
        const res = buildPalette(m.rgba, null, m.maxColors);
        self.postMessage({ type: 'palette', id: m.id, palette: res.pal, n: res.n }, [res.pal.buffer]);
        return;
      }
      if (m.type === 'frame') {
        let pal = m.palette, n = m.n, bits = m.bits, tIndex = -1, table = null;
        if (!pal) {
          const res = buildPalette(m.rgba, m.mask, m.mask ? m.maxColors - 1 : m.maxColors);
          pal = res.pal; n = res.n;
          if (m.mask) tIndex = n;
          const count = n + (m.mask ? 1 : 0);
          bits = Math.max(1, Math.ceil(Math.log2(count)));
          table = new Uint8Array(3 << bits);
          table.set(pal);
        } else if (m.mask) {
          tIndex = m.tIndex;
        }
        const idx = mapPixels(m.rgba, m.w, m.h, m.mask, pal, n, tIndex, m.dither, m.strength);
        const lzw = lzwEncode(idx, Math.max(2, bits));
        const transfer = [lzw.buffer];
        if (table) transfer.push(table.buffer);
        self.postMessage({ type: 'frame', id: m.id, table, bits, tIndex, lzw }, transfer);
      }
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
    }
  };
}

/* Writes the final GIF file from encoded frames. Runs on the main thread. */
function assembleGif({ width, height, frames, globalTable, globalBits, loop }) {
  const parts = [];
  const u8 = (arr) => parts.push(Uint8Array.from(arr));
  const lo = (v) => v & 255, hi = (v) => (v >> 8) & 255;

  u8([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  const gctFlag = globalTable ? 0x80 | ((globalBits - 1) & 7) : 0;
  u8([lo(width), hi(width), lo(height), hi(height), gctFlag | 0x70, 0, 0]);
  if (globalTable) parts.push(globalTable);

  if (loop !== 1) {
    const count = loop === 0 ? 0 : Math.max(0, loop - 1);
    u8([0x21, 0xFF, 0x0B, 0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30, 0x03, 0x01, lo(count), hi(count), 0x00]);
  }

  for (const f of frames) {
    const hasT = f.tIndex >= 0;
    const packed = (1 << 2) | (hasT ? 1 : 0); // disposal: do not dispose
    u8([0x21, 0xF9, 0x04, packed, lo(f.delay), hi(f.delay), hasT ? f.tIndex : 0, 0x00]);
    const lct = f.table ? 0x80 | ((f.bits - 1) & 7) : 0;
    u8([0x2C, lo(f.x), hi(f.x), lo(f.y), hi(f.y), lo(f.w), hi(f.w), lo(f.h), hi(f.h), lct]);
    if (f.table) parts.push(f.table);
    parts.push(f.lzw);
  }
  u8([0x3B]);
  return new Blob(parts, { type: 'image/gif' });
}
