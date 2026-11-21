/* GifX — UI, frame extraction and encoding pipeline. No dependencies. */
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const el = {
    drop: $('#drop'), file: $('#file'), pick: $('#pick'), editor: $('#editor'),
    video: $('#video'), frame: $('#frame'), cropLayer: $('#cropLayer'), cropBox: $('#cropBox'),
    play: $('#play'), timeline: $('#timeline'), tlSel: $('#tlSel'), hStart: $('#hStart'), hEnd: $('#hEnd'),
    tlHead: $('#tlHead'), timeNow: $('#timeNow'), start: $('#start'), end: $('#end'),
    setStart: $('#setStart'), setEnd: $('#setEnd'), cropBtn: $('#cropBtn'), aspect: $('#aspect'),
    cropReset: $('#cropReset'), cropInfo: $('#cropInfo'),
    width: $('#width'), widthChips: $('#widthChips'), sizeVal: $('#sizeVal'),
    fps: $('#fps'), fpsVal: $('#fpsVal'), speed: $('#speed'), direction: $('#direction'),
    colors: $('#colors'), colorsVal: $('#colorsVal'), palette: $('#palette'), dither: $('#dither'),
    strength: $('#strength'), strengthVal: $('#strengthVal'), optimize: $('#optimize'), loop: $('#loop'),
    summary: $('#summary'), actions: $('#actions'), convert: $('#convert'), change: $('#change'),
    progress: $('#progress'), pFill: $('#pFill'), pText: $('#pText'), cancel: $('#cancel'), error: $('#error'),
    result: $('#result'), gif: $('#gif'), stats: $('#stats'), download: $('#download'),
  };

  const state = {
    file: null, url: null, duration: 0, vw: 0, vh: 0,
    start: 0, end: 0, crop: null, cropMode: false, job: null, gifUrl: null,
  };

  const PRESETS = {
    max: { colors: 256, palette: 'local', dither: 'fs', strength: 85, optimize: '3' },
    balanced: { colors: 256, palette: 'local', dither: 'sierralite', strength: 75, optimize: '8' },
    small: { colors: 128, palette: 'global', dither: 'bayer', strength: 70, optimize: '16' },
  };

  // ------------------------------------------------------------------ helpers
  const fmtTime = (t) => {
    if (!isFinite(t)) t = 0;
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  };
  const fmtBytes = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const once = (target, ev) => new Promise((res) => target.addEventListener(ev, res, { once: true }));

  function showError(msg) {
    el.error.textContent = msg;
    el.error.hidden = !msg;
  }

  // ------------------------------------------------------------------ loading
  el.pick.addEventListener('click', () => el.file.click());
  el.change.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => { if (el.file.files[0]) loadFile(el.file.files[0]); el.file.value = ''; });

  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault(); el.drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
    e.preventDefault(); if (ev === 'drop' || !e.relatedTarget) el.drop.classList.remove('over');
  }));
  document.addEventListener('drop', (e) => {
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('video/') || /\.(mkv|mov|avi|mp4|webm|m4v|ogv)$/i.test(x.name));
    if (f) loadFile(f);
  });
  document.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('video/'));
    if (f) loadFile(f);
  });

  // Recorded WebM files often report duration = Infinity until the end is reached.
  async function fixDuration(v) {
    if (isFinite(v.duration) && v.duration > 0) return;
    v.currentTime = 1e101;
    await once(v, 'durationchange');
    for (let i = 0; i < 50 && !isFinite(v.duration); i++) await new Promise((r) => setTimeout(r, 20));
    v.currentTime = 0;
    await once(v, 'seeked');
  }

  async function loadFile(file) {
    if (state.job) return;
    showError('');
    if (state.url) URL.revokeObjectURL(state.url);
    state.file = file;
    state.url = URL.createObjectURL(file);
    const v = el.video;
    v.src = state.url;
    try {
      await new Promise((res, rej) => {
        v.onloadedmetadata = res;
        v.onerror = () => rej(new Error('decode'));
      });
      await fixDuration(v);
    } catch {
      el.drop.hidden = false; el.editor.hidden = true;
      alert('הדפדפן לא מצליח לפתוח את הקובץ הזה. נסו קובץ MP4 (H.264) או WebM.');
      return;
    }
    v.onerror = null;
    state.vw = v.videoWidth; state.vh = v.videoHeight;
    state.duration = v.duration;
    state.start = 0;
    state.end = Math.min(state.duration, 10);
    state.crop = null;
    setCropMode(false);
    el.start.max = el.end.max = state.duration.toFixed(2);
    el.width.value = Math.min(480, state.vw);
    el.drop.hidden = true;
    el.editor.hidden = false;
    renderTimeline(); renderCrop(); updateSummary();
  }

  // ------------------------------------------------------------------ playback + timeline
  const v = el.video;
  function togglePlay() {
    if (v.paused) {
      if (v.currentTime < state.start || v.currentTime >= state.end - 0.02) v.currentTime = state.start;
      v.play();
    } else v.pause();
  }
  el.play.addEventListener('click', togglePlay);
  v.addEventListener('click', () => { if (!state.cropMode) togglePlay(); });
  v.addEventListener('play', () => el.play.classList.add('playing'));
  v.addEventListener('pause', () => el.play.classList.remove('playing'));
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !el.editor.hidden && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) {
      e.preventDefault(); togglePlay();
    }
  });

  (function tick() {
    if (!el.editor.hidden && state.duration) {
      if (!v.paused && v.currentTime >= state.end) v.currentTime = state.start;
      el.tlHead.style.left = (v.currentTime / state.duration * 100) + '%';
      el.timeNow.textContent = fmtTime(v.currentTime);
    }
    requestAnimationFrame(tick);
  })();

  function renderTimeline() {
    const d = state.duration || 1;
    const a = state.start / d * 100, b = state.end / d * 100;
    el.tlSel.style.left = a + '%'; el.tlSel.style.width = (b - a) + '%';
    el.hStart.style.left = a + '%'; el.hEnd.style.left = b + '%';
    el.start.value = state.start.toFixed(2);
    el.end.value = state.end.toFixed(2);
  }

  function setRange(start, end, seekTo) {
    const minLen = 0.05;
    state.start = clamp(start, 0, Math.max(0, state.duration - minLen));
    state.end = clamp(end, state.start + minLen, state.duration);
    renderTimeline(); updateSummary();
    if (seekTo != null) { v.pause(); v.currentTime = seekTo; }
  }

  function timeAt(e) {
    const r = el.timeline.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1) * state.duration;
  }
  el.timeline.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    let what = 'seek';
    if (e.target === el.hStart) what = 'start';
    else if (e.target === el.hEnd) what = 'end';
    el.timeline.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const t = timeAt(ev);
      if (what === 'start') setRange(Math.min(t, state.end - 0.05), state.end, t);
      else if (what === 'end') setRange(state.start, Math.max(t, state.start + 0.05), t);
      else { v.currentTime = t; }
    };
    move(e);
    const up = () => {
      el.timeline.removeEventListener('pointermove', move);
      el.timeline.removeEventListener('pointerup', up);
      el.timeline.removeEventListener('pointercancel', up);
    };
    el.timeline.addEventListener('pointermove', move);
    el.timeline.addEventListener('pointerup', up);
    el.timeline.addEventListener('pointercancel', up);
  });
  el.start.addEventListener('change', () => setRange(+el.start.value || 0, state.end, +el.start.value || 0));
  el.end.addEventListener('change', () => setRange(state.start, +el.end.value || state.duration, +el.end.value));
  el.setStart.addEventListener('click', () => setRange(v.currentTime, Math.max(state.end, v.currentTime + 0.05)));
  el.setEnd.addEventListener('click', () => setRange(Math.min(state.start, v.currentTime - 0.05), v.currentTime));

  // ------------------------------------------------------------------ crop
  function setCropMode(on) {
    state.cropMode = on;
    el.cropLayer.classList.toggle('active', on);
    el.cropBtn.setAttribute('aria-pressed', on);
    el.cropBtn.textContent = on ? 'סיום חיתוך' : 'חיתוך תמונה';
    if (on) v.pause();
  }
  el.cropBtn.addEventListener('click', () => setCropMode(!state.cropMode));
  el.cropReset.addEventListener('click', () => { state.crop = null; renderCrop(); updateSummary(); });
  el.aspect.addEventListener('change', () => {
    const asp = +el.aspect.value;
    if (!asp) return;
    // fit the largest centered box with that ratio inside the current crop (or whole frame)
    const base = state.crop || { x: 0, y: 0, w: state.vw, h: state.vh };
    let w = base.w, h = w / asp;
    if (h > base.h) { h = base.h; w = h * asp; }
    state.crop = normCrop({ x: base.x + (base.w - w) / 2, y: base.y + (base.h - h) / 2, w, h });
    setCropMode(true); renderCrop(); updateSummary();
  });

  function normCrop(c) {
    const x = clamp(Math.round(c.x), 0, state.vw - 1), y = clamp(Math.round(c.y), 0, state.vh - 1);
    return { x, y, w: clamp(Math.round(c.w), 1, state.vw - x), h: clamp(Math.round(c.h), 1, state.vh - y) };
  }

  function renderCrop() {
    const c = state.crop;
    el.cropBox.hidden = !c;
    el.frame.classList.toggle('cropped', !!c);
    if (c) {
      Object.assign(el.cropBox.style, {
        left: c.x / state.vw * 100 + '%', top: c.y / state.vh * 100 + '%',
        width: c.w / state.vw * 100 + '%', height: c.h / state.vh * 100 + '%',
      });
      el.cropInfo.textContent = `${c.w}×${c.h}`;
    } else {
      el.cropInfo.textContent = state.cropMode ? 'גוררים על התמונה כדי לסמן' : '';
    }
  }

  function layerPoint(e) {
    const r = el.cropLayer.getBoundingClientRect();
    return {
      x: clamp((e.clientX - r.left) / r.width, 0, 1) * state.vw,
      y: clamp((e.clientY - r.top) / r.height, 0, 1) * state.vh,
    };
  }

  function boxFrom(anchor, p) {
    const asp = +el.aspect.value;
    let w = Math.abs(p.x - anchor.x), h = Math.abs(p.y - anchor.y);
    const sx = p.x >= anchor.x ? 1 : -1, sy = p.y >= anchor.y ? 1 : -1;
    if (asp) { if (w / Math.max(h, 1e-6) > asp) w = h * asp; else h = w / asp; }
    // keep inside the frame
    const maxW = sx > 0 ? state.vw - anchor.x : anchor.x, maxH = sy > 0 ? state.vh - anchor.y : anchor.y;
    if (w > maxW) { const k = maxW / w; w *= k; if (asp) h *= k; }
    if (h > maxH) { const k = maxH / h; h *= k; if (asp) w *= k; }
    return { x: sx > 0 ? anchor.x : anchor.x - w, y: sy > 0 ? anchor.y : anchor.y - h, w, h };
  }

  el.cropLayer.addEventListener('pointerdown', (e) => {
    if (!state.cropMode) return;
    e.preventDefault();
    el.cropLayer.setPointerCapture(e.pointerId);
    const p0 = layerPoint(e);
    const c = state.crop;
    let mode, anchor, offset;
    const h = e.target.dataset && e.target.dataset.h;
    if (c && h) {
      mode = 'resize';
      anchor = { x: h.includes('w') ? c.x + c.w : c.x, y: h.includes('n') ? c.y + c.h : c.y };
    } else if (c && e.target === el.cropBox) {
      mode = 'move'; offset = { x: p0.x - c.x, y: p0.y - c.y };
    } else {
      mode = 'new'; anchor = p0;
    }
    const move = (ev) => {
      const p = layerPoint(ev);
      if (mode === 'move') {
        const cc = state.crop;
        state.crop = normCrop({ x: clamp(p.x - offset.x, 0, state.vw - cc.w), y: clamp(p.y - offset.y, 0, state.vh - cc.h), w: cc.w, h: cc.h });
      } else {
        const b = boxFrom(anchor, p);
        state.crop = b.w >= 2 && b.h >= 2 ? normCrop(b) : (mode === 'new' ? null : state.crop);
      }
      renderCrop();
    };
    const up = () => {
      el.cropLayer.removeEventListener('pointermove', move);
      el.cropLayer.removeEventListener('pointerup', up);
      el.cropLayer.removeEventListener('pointercancel', up);
      if (state.crop && (state.crop.w < 8 || state.crop.h < 8)) state.crop = null;
      if (state.crop && state.crop.w === state.vw && state.crop.h === state.vh) state.crop = null;
      renderCrop(); updateSummary();
    };
    el.cropLayer.addEventListener('pointermove', move);
    el.cropLayer.addEventListener('pointerup', up);
    el.cropLayer.addEventListener('pointercancel', up);
  });

  // ------------------------------------------------------------------ settings
  function readSettings() {
    const crop = state.crop || { x: 0, y: 0, w: state.vw, h: state.vh };
    let width = Math.round(+el.width.value) || crop.w;
    width = clamp(width, 16, crop.w);
    const height = Math.max(1, Math.round(width * crop.h / crop.w));
    const fps = clamp(+el.fps.value, 1, 50);
    const speed = +el.speed.value;
    const step = speed / fps;
    const count = Math.max(1, Math.floor((state.end - state.start) / step + 1e-6));
    const direction = el.direction.value;
    const total = direction === 'boomerang' ? count + Math.max(0, count - 2) : count;
    return {
      crop, width, height, fps, speed, step, count, total, direction,
      colors: +el.colors.value, palette: el.palette.value, dither: el.dither.value,
      strength: +el.strength.value / 100, threshold: +el.optimize.value, loop: +el.loop.value,
    };
  }

  function updateSummary() {
    if (!state.duration) return;
    const s = readSettings();
    el.fpsVal.textContent = s.fps;
    el.colorsVal.textContent = s.colors;
    el.strengthVal.textContent = el.strength.value + '%';
    el.sizeVal.textContent = `${s.width}×${s.height}`;
    el.width.max = s.crop.w;
    const outDur = s.total / s.fps;
    el.summary.innerHTML =
      `<span><b>${s.total}</b> פריימים</span><span><b>${outDur.toFixed(2)}</b> שנ'</span><span dir="ltr"><b>${s.width}×${s.height}</b></span>`;
    const heavy = s.width * s.height * s.total > 2.5e8;
    el.summary.classList.toggle('warn', heavy);
    if (heavy) el.summary.innerHTML += '<em>הרבה פריימים בגודל הזה – ההמרה תיקח זמן והקובץ יהיה כבד</em>';
    document.querySelectorAll('[data-w]').forEach((b) => {
      const w = +b.dataset.w;
      b.classList.toggle('on', w ? w === s.width : s.width === s.crop.w);
      b.disabled = !!w && w > s.crop.w;
    });
    for (const [name, p] of Object.entries(PRESETS)) {
      const on = p.colors === s.colors && p.palette === s.palette && p.dither === s.dither &&
        p.strength === +el.strength.value && p.optimize === el.optimize.value;
      document.querySelector(`[data-preset="${name}"]`).classList.toggle('on', on);
    }
  }

  ['input', 'change'].forEach((ev) => document.querySelector('.panel').addEventListener(ev, updateSummary));
  el.widthChips.addEventListener('click', (e) => {
    const b = e.target.closest('[data-w]');
    if (!b) return;
    const crop = state.crop || { w: state.vw };
    el.width.value = +b.dataset.w || crop.w;
    updateSummary();
  });
  document.querySelector('.presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const p = PRESETS[b.dataset.preset];
    el.colors.value = p.colors; el.palette.value = p.palette; el.dither.value = p.dither;
    el.strength.value = p.strength; el.optimize.value = p.optimize;
    updateSummary();
  });

  // ------------------------------------------------------------------ worker pool
  let workerUrl = null;
  class Pool {
    constructor(size) {
      if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([`(${GifXWorker.toString()})()`], { type: 'text/javascript' }));
      this.workers = Array.from({ length: size }, () => new Worker(workerUrl));
      this.idle = [...this.workers];
      this.queue = [];
      this.waiting = new Map();
      this.seq = 0;
      for (const w of this.workers) {
        w.onmessage = (e) => {
          const cb = this.waiting.get(e.data.id);
          this.waiting.delete(e.data.id);
          this.idle.push(w);
          this.pump();
          if (e.data.type === 'error') cb.rej(new Error(e.data.message)); else cb.res(e.data);
        };
        w.onerror = (e) => {
          for (const cb of this.waiting.values()) cb.rej(new Error(e.message || 'worker error'));
          this.waiting.clear();
        };
      }
    }
    get size() { return this.workers.length; }
    get busy() { return this.queue.length + this.waiting.size; }
    run(msg, transfer) {
      return new Promise((res, rej) => {
        msg.id = ++this.seq;
        this.queue.push({ msg, transfer, res, rej });
        this.pump();
      });
    }
    pump() {
      while (this.idle.length && this.queue.length) {
        const w = this.idle.pop(), t = this.queue.shift();
        this.waiting.set(t.msg.id, t);
        w.postMessage(t.msg, t.transfer || []);
      }
    }
    terminate() { this.workers.forEach((w) => w.terminate()); }
  }

  // ------------------------------------------------------------------ frame grabbing
  function seek(vid, t) {
    return new Promise((res, rej) => {
      if (Math.abs(vid.currentTime - t) < 1e-6 && vid.readyState >= 2) { res(); return; }
      const timer = setTimeout(done, 8000);
      function done() { clearTimeout(timer); vid.removeEventListener('seeked', done); vid.removeEventListener('error', fail); res(); }
      function fail() { clearTimeout(timer); vid.removeEventListener('seeked', done); rej(new Error('seek')); }
      vid.addEventListener('seeked', done);
      vid.addEventListener('error', fail, { once: true });
      vid.currentTime = t;
    });
  }

  // High quality downscale: one smooth step (< 2x) at full resolution, then exact halvings.
  function makeGrabber(s) {
    const { crop, width: W, height: H } = s;
    let cw = W, ch = H;
    while (cw * 2 <= crop.w && ch * 2 <= crop.h) { cw *= 2; ch *= 2; }
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const octx = out.getContext('2d', { willReadFrequently: true });
    const tmp = [document.createElement('canvas'), document.createElement('canvas')];
    const setQ = (c) => { c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; return c; };
    setQ(octx);
    return (vid) => {
      if (cw === W) {
        octx.drawImage(vid, crop.x, crop.y, crop.w, crop.h, 0, 0, W, H);
      } else {
        let src = tmp[0], w = cw, h = ch;
        src.width = w; src.height = h;
        setQ(src.getContext('2d')).drawImage(vid, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
        let k = 1;
        while (w / 2 > W) {
          const dst = tmp[k]; k ^= 1;
          dst.width = w / 2; dst.height = h / 2;
          setQ(dst.getContext('2d')).drawImage(src, 0, 0, w, h, 0, 0, w / 2, h / 2);
          src = dst; w /= 2; h /= 2;
        }
        octx.drawImage(src, 0, 0, w, h, 0, 0, W, H);
      }
      return octx.getImageData(0, 0, W, H).data;
    };
  }

  // ------------------------------------------------------------------ conversion
  el.convert.addEventListener('click', () => convert().catch((err) => {
    if (err && err.message === 'cancel') return;
    console.error(err);
    showError('ההמרה נכשלה: ' + (err && err.message || err));
  }).finally(endJob));
  el.cancel.addEventListener('click', () => { if (state.job) state.job.cancelled = true; });

  function setProgress(frac, text) {
    el.pFill.style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';
    el.pText.textContent = text;
  }

  function endJob() {
    if (state.job && state.job.pool) state.job.pool.terminate();
    if (state.job && state.job.vid) { state.job.vid.removeAttribute('src'); state.job.vid.load(); }
    state.job = null;
    el.progress.hidden = true; el.actions.hidden = false;
    document.body.classList.remove('busy');
  }

  async function convert() {
    if (state.job) return;
    showError('');
    v.pause();
    const s = readSettings();
    const job = state.job = { cancelled: false };
    el.actions.hidden = true; el.progress.hidden = false;
    document.body.classList.add('busy');
    setProgress(0, 'מכין…');
    const t0 = performance.now();

    // output timestamps in display order
    const fwd = [];
    const maxT = state.duration - 0.001;
    for (let i = 0; i < s.count; i++) fwd.push(Math.min(maxT, state.start + i * s.step + 0.0005));
    let times = fwd;
    if (s.direction === 'reverse') times = fwd.slice().reverse();
    else if (s.direction === 'boomerang') times = fwd.concat(fwd.slice(1, -1).reverse());
    const N = times.length;
    const delayOf = (i) => Math.max(2, Math.round((i + 1) * 100 / s.fps) - Math.round(i * 100 / s.fps));

    const threads = clamp((navigator.hardwareConcurrency || 4) - 1, 1, 8);
    const pool = job.pool = new Pool(threads);
    const vid = job.vid = document.createElement('video');
    vid.muted = true; vid.preload = 'auto'; vid.playsInline = true;
    vid.src = state.url;
    await once(vid, 'loadeddata');
    const grab = makeGrabber(s);

    const W = s.width, H = s.height, P = W * H;
    const optimize = s.threshold >= 0;
    const global = s.palette === 'global';
    const last = optimize ? new Uint8ClampedArray(P * 4) : null;
    const frames = []; // in display order
    const jobs = [];
    let extracted = 0, encoded = 0, encodeTotal = 0;
    const tasks = [];
    const report = () => {
      const f = global ? (extracted / N) * 0.7 + (encodeTotal ? encoded / encodeTotal * 0.3 : 0)
        : (extracted + encoded) / (2 * N);
      setProgress(f, extracted < N ? `מחלץ פריימים ${extracted}/${N} · קודדו ${encoded}` : `מקודד ${encoded}/${encodeTotal}`);
    };
    const common = { maxColors: s.colors, dither: s.dither, strength: s.strength };

    const dispatch = (fr, jb, extra) => {
      encodeTotal++;
      const msg = Object.assign({ type: 'frame', rgba: jb.rgba, mask: jb.mask, w: fr.w, h: fr.h }, common, extra);
      const transfer = [jb.rgba.buffer];
      if (jb.mask) transfer.push(jb.mask.buffer);
      const t = pool.run(msg, transfer).then((r) => {
        fr.table = r.table; fr.bits = r.bits; fr.tIndex = r.tIndex; fr.lzw = r.lzw;
        encoded++; report();
      });
      tasks.push(t);
      inflight.add(t);
      t.then(() => inflight.delete(t), () => inflight.delete(t));
    };
    const inflight = new Set();

    for (let i = 0; i < N; i++) {
      if (job.cancelled) throw new Error('cancel');
      await seek(vid, times[i]);
      const img = grab(vid);
      extracted++;

      let x0 = 0, y0 = 0, x1 = W - 1, y1 = H - 1, mask = null;
      if (optimize && frames.length) {
        // pixels that did not change since they were last drawn become transparent
        const T = s.threshold;
        const changed = new Uint8Array(P);
        x0 = W; y0 = H; x1 = -1; y1 = -1;
        for (let y = 0, p = 0; y < H; y++) {
          for (let x = 0; x < W; x++, p++) {
            const o = p << 2;
            const d = Math.max(Math.abs(img[o] - last[o]), Math.abs(img[o + 1] - last[o + 1]), Math.abs(img[o + 2] - last[o + 2]));
            if (d > T) {
              changed[p] = 1;
              if (x < x0) x0 = x; if (x > x1) x1 = x;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
          }
        }
        if (x1 < 0) { // identical frame: just extend the previous one
          frames[frames.length - 1].delay += delayOf(i);
          report();
          continue;
        }
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        const sub = new Uint8ClampedArray(w * h * 4);
        const m = new Uint8Array(w * h);
        let all = true;
        for (let y = 0; y < h; y++) {
          const rowP = (y + y0) * W + x0;
          sub.set(img.subarray(rowP * 4, (rowP + w) * 4), y * w * 4);
          for (let x = 0; x < w; x++) {
            const p = rowP + x;
            if (changed[p]) {
              m[y * w + x] = 1;
              const o = p << 2;
              last[o] = img[o]; last[o + 1] = img[o + 1]; last[o + 2] = img[o + 2];
            } else all = false;
          }
        }
        mask = all ? null : m;
        const fr = { x: x0, y: y0, w, h, delay: delayOf(i) };
        frames.push(fr);
        const jb = { rgba: sub, mask };
        if (global) jobs.push([fr, jb]); else dispatch(fr, jb);
      } else {
        if (optimize) last.set(img);
        const fr = { x: 0, y: 0, w: W, h: H, delay: delayOf(i) };
        frames.push(fr);
        const jb = { rgba: new Uint8ClampedArray(img), mask: null };
        if (global) jobs.push([fr, jb]); else dispatch(fr, jb);
      }
      report();
      // backpressure: keep memory bounded
      while (!global && inflight.size > pool.size * 3) {
        await Promise.race(inflight);
        if (job.cancelled) throw new Error('cancel');
      }
    }

    let globalTable = null, globalBits = 0;
    if (global) {
      setProgress(0.7, 'בונה פלטת צבעים משותפת…');
      // sample pixels from every frame (only pixels that are actually drawn)
      let totalPx = 0;
      for (const [, jb] of jobs) totalPx += jb.mask ? jb.mask.reduce((a, b) => a + b, 0) : jb.rgba.length / 4;
      const stride = Math.max(1, Math.ceil(totalPx / 2e6));
      const sample = new Uint8ClampedArray(Math.ceil(totalPx / stride + jobs.length) * 4);
      let k = 0, c = 0;
      for (const [, jb] of jobs) {
        const n = jb.rgba.length / 4;
        for (let p = 0; p < n; p++) {
          if (jb.mask && !jb.mask[p]) continue;
          if (c++ % stride) continue;
          const o = p << 2;
          sample[k++] = jb.rgba[o]; sample[k++] = jb.rgba[o + 1]; sample[k++] = jb.rgba[o + 2]; sample[k++] = 255;
        }
      }
      const reserve = optimize ? 1 : 0;
      const pr = await pool.run({ type: 'palette', rgba: sample.subarray(0, k), maxColors: s.colors - reserve });
      if (job.cancelled) throw new Error('cancel');
      const n = pr.n;
      globalBits = Math.max(1, Math.ceil(Math.log2(n + reserve)));
      globalTable = new Uint8Array(3 << globalBits);
      globalTable.set(pr.palette);
      for (const [fr, jb] of jobs) {
        dispatch(fr, jb, { palette: pr.palette.slice(), n, bits: globalBits, tIndex: optimize ? n : -1 });
      }
      jobs.length = 0;
    }

    // wait for all frames, checking for cancel
    const all = Promise.all(tasks);
    while (true) {
      const r = await Promise.race([all.then(() => 'done'), new Promise((res) => setTimeout(res, 200, 'tick'))]);
      if (job.cancelled) throw new Error('cancel');
      if (r === 'done') break;
    }

    setProgress(1, 'כותב קובץ…');
    const blob = assembleGif({ width: W, height: H, frames, globalTable, globalBits, loop: s.loop });
    showResult(blob, s, frames.length, (performance.now() - t0) / 1000);
  }

  function showResult(blob, s, frameCount, secs) {
    if (state.gifUrl) URL.revokeObjectURL(state.gifUrl);
    state.gifUrl = URL.createObjectURL(blob);
    el.gif.src = state.gifUrl;
    el.download.href = state.gifUrl;
    const base = (state.file && state.file.name || 'video').replace(/\.[^.]+$/, '');
    el.download.download = base + '.gif';
    const dur = s.total / s.fps;
    el.stats.innerHTML = [
      ['גודל קובץ', fmtBytes(blob.size)],
      ['מידות', `<span dir="ltr">${s.width}×${s.height}</span>`],
      ['פריימים', `${frameCount}${frameCount < s.total ? ` <span class="muted">(מתוך ${s.total}, זהים אוחדו)</span>` : ''}`],
      ['אורך', `${dur.toFixed(2)} שנ' · ${s.fps} fps`],
      ['זמן המרה', `${secs.toFixed(1)} שנ'`],
    ].map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('');
    el.result.hidden = false;
    el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // for automated tests
  window.GifX = { loadFile, convert: () => convert().finally(endJob), state, readSettings };
})();
