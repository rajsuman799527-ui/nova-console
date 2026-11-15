/* ===========================================================================
 * Sky Dash 3D  -  NOVA Console game  (id: 'flappy')
 * ---------------------------------------------------------------------------
 * 3D side-scrolling "flappy" race for 1-5 players. Last bird flying wins.
 *
 * Runs ONLY on the screen page. No network traffic, no external assets:
 * everything (geometry, textures, sounds) is generated procedurally.
 * Requires Three.js r128 (global THREE) to be loaded first.
 *
 * Public contract (what screen/index.html talks to):
 *   window.NovaGames.flappy = {
 *     start(ctx)        ctx = { container, players, colors, input(slot), exit() }
 *     stop()
 *     onPlayers(list)   list = [{id, slot}, ...]   (call whenever roster changes)
 *     onButton(slot,k)  OPTIONAL edge event: a button went DOWN (d=1). Makes a
 *                       quick tap impossible to miss. If the host never calls
 *                       it, the game falls back to polling ctx.input() each frame.
 *   }
 *
 * Notes on design decisions
 *  - Players are tracked by their ID, not their slot. The host re-indexes slots
 *    when somebody disconnects, so a slot is only used to READ input.
 *  - Physics runs on a fixed 120 Hz step (frame-rate independent, no tunnelling,
 *    and "who died first" is resolved with ~8 ms precision).
 *  - Score = pipes cleared. Last alive wins; if everybody dies in the same
 *    physics step the tie-break is: score, then lowest player number.
 *  - Visual theme: bright daytime "candy" look (gradient sky, low-poly clouds,
 *    hills, floating islands, candy pipes, striped ground, cartoon birds).
 *    Everything is procedural and cheap: no extra lights, no external files.
 * ========================================================================= */
(function () {
  'use strict';

  window.NovaGames = window.NovaGames || {};

  /* ======================================================================
   * TUNABLES  (world units: 1 unit ~ one bird body)
   * ==================================================================== */
  var FLOOR_Y = -7, CEIL_Y = 7;                // playfield vertical limits
  var BIRD_R = 0.42;                           // collision radius
  var GRAVITY = 36, FLAP_V = 10.8, FALL_MAX = 18, START_VY = 3;   // flap peak ~1.6 units, 0.3 s
  var STEP = 1 / 120;                          // fixed physics step
  var PIPE_W = 2.4, PIPE_DEPTH = 11.5;         // tower size (depth covers all lanes)
  var CAP_PAD = 0.3, CAP_H = 0.8;              // lip on the open end of each tower
  var PIPE_SPACING = 16, FIRST_PIPE_X = 34, SPAWN_X = 80, DESPAWN_X = -26;
  var SPEED0 = 8, SPEED_MAX = 13.5, SPEED_GAIN = 0.04;   // units/s, +0.04 per second survived
  var ATTRACT_SPEED = 4.5;                     // idle scroll on the waiting screen
  var GAP0 = 5.4, GAP_MIN = 3.6, GAP_SHRINK = 0.0125;    // gap height (units), shrinks per second
  var LANE_GAP = 1.7;                          // depth distance between birds
  var OVER_LOCK = 1.4;                         // seconds before "play again" is accepted
  var FADE_DELAY = 0.8, FADE_TIME = 0.9;       // dead bird: seconds before fading / fade length
  var GRID = 3;                                // (legacy) floor cell size
  var FLAP_KEYS = { cr: 1, ci: 1, sq: 1, tri: 1 };
  var MAX_PLAYERS = 5;

  /* ---------- visual constants ---------- */
  var HORIZON_HEX = 0xffd8bc;                  // warm peach at the horizon (also the fog colour)
  var PIPE_PAL = [0x35d05a, 0xff9a2e, 0xff5fa8, 0x14c9c0];   // green, orange, pink, teal
  var SPARK_CSS = ['#ffd93b', '#ff6fa5', '#3ee0c4', '#6ab7ff', '#ff9a3e', '#b07bff', '#ffffff'];
  var FONT = 'ui-rounded,"SF Pro Rounded","Nunito","Varela Round","Arial Rounded MT Bold","Trebuchet MS",' +
    'system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';

  var bestSolo = 0;                            // best solo score this page session

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtClock(t) { return Math.floor(t / 60) + ':' + pad2(Math.floor(t % 60)); }
  function fmtPrecise(t) {
    var m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  function circleRect(cx, cy, r, x0, x1, y0, y1) {
    var nx = clamp(cx, x0, x1), ny = clamp(cy, y0, y1);
    var dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  /* ======================================================================
   * HUD / OVERLAY STYLES  (everything sized in em; JS sets root font-size
   * from the container size, so the UI scales to any screen)
   * ==================================================================== */
  var OUTLINE = '.04em .04em 0 var(--ink),-.04em .04em 0 var(--ink),.04em -.04em 0 var(--ink),' +
    '-.04em -.04em 0 var(--ink),0 .1em 0 var(--ink)';
  var CSS = [
    '.sd-root{position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden;background:#cfe9ff;color:#fff;',
    '--ink:#1d2470;font-weight:800;font-family:', FONT, ';',
    'font-variant-numeric:tabular-nums;font-feature-settings:"tnum";user-select:none;-webkit-user-select:none}',
    '.sd-vig{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;',
    'background:radial-gradient(ellipse at 50% 50%,rgba(255,255,255,0) 62%,rgba(255,140,110,.2) 100%)}',
    '.sd-top{position:absolute;top:0;left:0;right:0;padding:1.1em 1.5em;display:flex;justify-content:space-between;',
    'align-items:flex-start;gap:1em;pointer-events:none}',
    '.sd-pills{display:flex;flex-wrap:wrap;gap:.55em;align-items:center}',
    '.sd-pill,.sd-time,.sd-chip{display:inline-flex;align-items:center;gap:.55em;padding:.4em .95em;border-radius:999px;',
    'background:linear-gradient(180deg,rgba(255,255,255,.86),rgba(255,255,255,.55));',
    'border:.14em solid rgba(255,255,255,.95);color:var(--ink);',
    'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);font-weight:900;font-size:1.05em;',
    'box-shadow:0 .22em 0 rgba(29,36,112,.22),0 0 1.5em -.2em var(--c,rgba(255,255,255,.5));transition:opacity .35s}',
    '.sd-pill i,.sd-chip i{width:.85em;height:.85em;border-radius:50%;background:var(--c);',
    'box-shadow:0 0 0 .14em #fff,0 0 .8em var(--c)}',
    '.sd-pill b{min-width:1.5em;text-align:right;font-weight:900;font-size:1.15em}',
    '.sd-pill.dead{opacity:.42;filter:grayscale(.45)}',
    '.sd-spec{font-size:.85em;color:var(--ink);background:rgba(255,255,255,.6);border-radius:999px;',
    'padding:.4em .9em;font-weight:800}',
    '.sd-time{font-size:1.15em;letter-spacing:.06em;border-color:#ffd93b}',
    '.sd-center{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;pointer-events:none}',
    '.sd-big{font-size:11em;font-weight:900;line-height:1;letter-spacing:-.02em;color:#fff;',
    'text-shadow:', OUTLINE, ',0 .16em .3em rgba(29,36,112,.35);',
    'animation:sd-pop .95s cubic-bezier(.2,.8,.2,1) both}',
    '.sd-big.go{color:#fff6a8}',
    '@keyframes sd-pop{0%{transform:scale(1.8);opacity:0}20%{transform:scale(1);opacity:1}70%{opacity:1}100%{transform:scale(.82);opacity:0}}',
    '.sd-panel{padding:1.7em 3em 1.9em;border-radius:1.8em;text-align:center;min-width:22em;max-width:90%;',
    'background:linear-gradient(160deg,rgba(110,92,255,.62),rgba(24,128,230,.56));',
    'border:.18em solid rgba(255,255,255,.92);',
    'backdrop-filter:blur(16px) saturate(1.3);-webkit-backdrop-filter:blur(16px) saturate(1.3);',
    'box-shadow:0 .45em 0 rgba(29,36,112,.3),0 0 5em -1em var(--c,#8b6cff),inset 0 .12em rgba(255,255,255,.55);',
    'animation:sd-in .55s .05s cubic-bezier(.2,.8,.2,1) both}',
    '.sd-panel.late{animation-delay:.75s}',
    '.sd-panel.nofx{animation:none}',
    '@keyframes sd-in{from{opacity:0;transform:scale(.93) translateY(3%)}to{opacity:1;transform:none}}',
    '.sd-kicker{display:inline-block;padding:.3em 1.1em;border-radius:999px;background:var(--c,#ff6fa5);',
    'border:.1em solid rgba(255,255,255,.9);font-size:.95em;letter-spacing:.2em;font-weight:900;color:#fff;',
    'text-shadow:0 .08em 0 rgba(29,36,112,.45);box-shadow:0 .15em 0 rgba(29,36,112,.3)}',
    '.sd-title{font-size:3.6em;font-weight:900;letter-spacing:-.01em;margin:.2em 0 .1em;color:#fff;',
    'text-shadow:', OUTLINE, ',0 .18em .35em rgba(29,36,112,.4)}',
    '.sd-name{font-size:4.2em;font-weight:900;letter-spacing:-.01em;line-height:1.05;margin:.15em 0 .05em;',
    'text-shadow:', OUTLINE, ',0 0 .5em rgba(255,255,255,.45)}',
    '.sd-score{font-size:6em;font-weight:900;line-height:1;margin:.05em 0;color:#fff;',
    'text-shadow:', OUTLINE, ',0 .16em .3em rgba(29,36,112,.35)}',
    '.sd-sub{font-size:1.15em;font-weight:800;margin-top:.35em;text-shadow:0 .08em 0 rgba(29,36,112,.5)}',
    '.sd-chips,.sd-tally{display:flex;flex-wrap:wrap;justify-content:center;gap:.55em;margin-top:1.1em}',
    '.sd-dim{opacity:.8}',
    '.sd-cta{margin-top:1.4em;font-size:1.15em;text-shadow:0 .08em 0 rgba(29,36,112,.5)}',
    '.sd-cta b{font-weight:900}',
    '.sd-key{display:inline-block;min-width:1.7em;padding:.05em .45em;border-radius:.5em;',
    'background:#ffd93b;color:#3a2a00;border:.1em solid #fff;font-weight:900;text-shadow:none;',
    'box-shadow:0 .12em 0 #c99a00}',
    '.sd-conf{position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden;pointer-events:none}',
    '.sd-conf span{position:absolute;top:-4%;width:.6em;height:1em;border-radius:.15em;opacity:.98;',
    'animation:sd-fall 3.2s linear forwards}',
    '@keyframes sd-fall{to{transform:translate3d(var(--dx,0px),var(--ty,900px),0) rotate(var(--r,720deg))}}'
  ].join('');

  /* ======================================================================
   * SOUND  (WebAudio, procedural). Browsers keep audio suspended until the
   * page has had a user gesture; we resume on any click/key/touch.
   * ==================================================================== */
  function makeSfx() {
    var ac = null, master = null, noiseBuf = null;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        ac = new AC();
        master = ac.createGain();
        master.gain.value = 0.5;
        var comp = ac.createDynamicsCompressor();
        master.connect(comp);
        comp.connect(ac.destination);
        noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
        var d = noiseBuf.getChannelData(0);
        for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
    } catch (e) { ac = null; }

    function resume() {
      if (!ac || ac.state !== 'suspended') return;
      try { var r = ac.resume(); if (r && r.catch) r.catch(function () {}); } catch (e) { /* ignore */ }
    }
    function ready() { resume(); return !!ac && ac.state === 'running'; }
    function env(g, t, vol, dur) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    }
    function tone(f0, f1, dur, type, vol, delay) {
      if (!ready()) return;
      var t = ac.currentTime + (delay || 0);
      var o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f0, t);
      if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      env(g, t, vol, dur);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + dur + 0.03);
    }
    function noise(dur, vol, freq, delay) {
      if (!ready()) return;
      var t = ac.currentTime + (delay || 0);
      var s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = noiseBuf;
      f.type = 'lowpass';
      f.frequency.setValueAtTime(freq, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 0.1), t + dur);
      env(g, t, vol, dur);
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t); s.stop(t + dur + 0.03);
    }
    return {
      resume: resume,
      flap: function (slot, quiet) {
        var v = quiet ? 0.05 : 0.11;
        tone(380 + slot * 45, 760 + slot * 60, 0.12, 'triangle', v);
        noise(0.05, quiet ? 0.02 : 0.05, 3500);
      },
      score: function () { tone(880, 880, 0.09, 'sine', 0.13); tone(1320, 1320, 0.16, 'sine', 0.11, 0.07); },
      die: function () { noise(0.35, 0.28, 2000); tone(320, 60, 0.4, 'sawtooth', 0.14); },
      tick: function () { tone(660, 660, 0.13, 'square', 0.07); },
      go: function () { tone(1320, 1320, 0.4, 'square', 0.08); tone(880, 880, 0.4, 'triangle', 0.1); },
      win: function () {
        var n = [523, 659, 784, 1047, 1319];
        for (var i = 0; i < n.length; i++) tone(n[i], n[i], 0.3, 'triangle', 0.12, i * 0.11);
        tone(1047, 1047, 0.9, 'sine', 0.08, 0.55);
      },
      close: function () { try { if (ac) ac.close(); } catch (e) { /* ignore */ } ac = null; }
    };
  }

  /* ======================================================================
   * THE GAME (one instance per start())
   * ==================================================================== */
  function createGame(ctx) {
    var container = ctx.container;
    var COLORS = (ctx.colors && ctx.colors.length) ? ctx.colors :
      ((window.CFG && window.CFG.COLORS) || ['#8b6cff', '#00e0a4', '#ff5c8a', '#ffb020', '#2ec5ff']);

    var stopped = false;

    /* ---------- DOM root ---------- */
    var root = document.createElement('div');
    root.className = 'sd-root';
    var styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    root.appendChild(styleEl);
    container.appendChild(root);

    /* ---------- renderer (fail gracefully) ---------- */
    var renderer = null;
    try {
      if (!window.THREE) throw new Error('three.js not loaded');
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch (err) {
      if (window.console) console.error('[flappy3d] cannot start:', err);
      var why = window.THREE ? 'WebGL is not available in this browser.' : 'three.js failed to load. Check the connection.';
      root.innerHTML = '<div style="position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);' +
        'text-align:center;color:#1d2470;font:800 22px system-ui,sans-serif">Sky Dash 3D could not start<br>' +
        '<span style="opacity:.7;font-size:16px;font-weight:600">' + why + '</span></div>';
      return {
        stop: function () { if (root.parentNode) root.parentNode.removeChild(root); },
        onPlayers: function () {}, onButton: function () {}
      };
    }

    var cv = renderer.domElement;
    cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;background:#cfe9ff;border:0;border-radius:0';
    root.appendChild(cv);
    renderer.setClearColor(HORIZON_HEX, 1);
    var maxAniso = 1;
    try { maxAniso = Math.min(4, renderer.capabilities.getMaxAnisotropy() || 1); } catch (e) { maxAniso = 1; }

    /* ---------- HUD elements ---------- */
    function el(cls, parent) {
      var d = document.createElement('div');
      d.className = cls;
      (parent || root).appendChild(d);
      return d;
    }
    el('sd-vig');
    var confEl = el('sd-conf');
    var topEl = el('sd-top');
    var pillsEl = el('sd-pills', topEl);
    var timeEl = el('sd-time', topEl);
    timeEl.style.display = 'none';
    var bigEl = el('sd-center');
    var panelEl = el('sd-center');
    var lastPills = null, lastTime = null, lastPanel = null;

    /* ======================================================================
     * THREE.JS SCENE
     * ==================================================================== */
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(HORIZON_HEX);
    scene.fog = new THREE.Fog(HORIZON_HEX, 70, 215);

    var camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.1, 300);
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    var sun = new THREE.DirectionalLight(0xfff4e0, 0.55);
    sun.position.set(-6, 10, 14);
    scene.add(sun);

    /* ---------- procedural textures ---------- */
    function radialTex(size, stops) {
      var c = document.createElement('canvas');
      c.width = c.height = size;
      var g = c.getContext('2d');
      var gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      for (var i = 0; i < stops.length; i++) gr.addColorStop(stops[i][0], stops[i][1]);
      g.fillStyle = gr;
      g.fillRect(0, 0, size, size);
      var t = new THREE.CanvasTexture(c);
      t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      return t;
    }
    var glowTex = radialTex(128, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,.45)'], [1, 'rgba(255,255,255,0)']]);
    var sunTex = radialTex(128, [[0, 'rgba(255,255,255,1)'], [0.48, 'rgba(255,252,225,1)'], [0.56, 'rgba(255,240,170,.9)'],
      [0.72, 'rgba(255,230,150,.22)'], [1, 'rgba(255,220,140,0)']]);

    /* repeating stripe strip (power-of-two sizes so mipmaps/repeat work on WebGL1 too) */
    function stripeTex(cols, cellW, h) {
      var c = document.createElement('canvas');
      c.width = cellW * cols.length; c.height = h;
      var g = c.getContext('2d');
      for (var i = 0; i < cols.length; i++) { g.fillStyle = cols[i]; g.fillRect(i * cellW, 0, cellW, h); }
      var t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = maxAniso;
      return t;
    }

    /* particle atlas: 0 sparkle, 1 star, 2 soft puff, 3 feather */
    function atlasTex() {
      var c = document.createElement('canvas');
      c.width = 256; c.height = 64;
      var g = c.getContext('2d'), i, a, r, gr;
      // 0: four-point sparkle with soft glow
      g.save(); g.translate(32, 32);
      gr = g.createRadialGradient(0, 0, 0, 0, 0, 24);
      gr.addColorStop(0, 'rgba(255,255,255,.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 24, 0, 6.283); g.fill();
      g.fillStyle = '#fff'; g.beginPath();
      for (i = 0; i < 8; i++) {
        a = i * Math.PI / 4 - Math.PI / 2; r = (i % 2 === 0) ? 29 : 7;
        g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.closePath(); g.fill(); g.restore();
      // 1: five-point star
      g.save(); g.translate(96, 34);
      g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineWidth = 4; g.lineJoin = 'round';
      g.beginPath();
      for (i = 0; i < 10; i++) {
        a = i * Math.PI / 5 - Math.PI / 2; r = (i % 2 === 0) ? 26 : 11;
        g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.closePath(); g.fill(); g.stroke(); g.restore();
      // 2: soft puff
      g.save(); g.translate(160, 32);
      gr = g.createRadialGradient(0, 0, 0, 0, 0, 30);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 30, 0, 6.283); g.fill(); g.restore();
      // 3: feather
      g.save(); g.translate(224, 32);
      g.fillStyle = '#fff'; g.beginPath();
      g.moveTo(0, -28); g.quadraticCurveTo(18, -6, 0, 28); g.quadraticCurveTo(-18, -6, 0, -28);
      g.closePath(); g.fill();
      g.strokeStyle = 'rgb(190,190,190)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(0, -26); g.lineTo(0, 28); g.stroke(); g.restore();
      var t = new THREE.CanvasTexture(c);
      t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      return t;
    }

    function rrect(g, x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
      g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
      g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
      g.closePath();
    }
    /* Name tag ("P1") and death-score badge ("P1  12") share one painter. */
    function badgeTex(label, color, score) {
      var c = document.createElement('canvas');
      c.width = 256; c.height = 128;
      var g = c.getContext('2d');
      rrect(g, 10, 22, 236, 84, 42);
      g.fillStyle = 'rgba(255,255,255,.95)'; g.fill();
      g.lineWidth = 9; g.strokeStyle = color; g.stroke();
      g.textBaseline = 'middle'; g.textAlign = 'center';
      if (score === null) {
        g.fillStyle = '#262e6e';
        g.font = '900 56px ' + FONT;
        g.fillText(label, 128, 67);
      } else {
        g.fillStyle = color;
        g.beginPath(); g.arc(62, 66, 22, 0, 6.283); g.fill();
        g.lineWidth = 4; g.strokeStyle = '#fff'; g.stroke();
        g.fillStyle = '#262e6e';
        g.font = '900 36px ' + FONT;
        g.fillText(label, 122, 67);
        g.font = '900 56px ' + FONT;
        g.fillText(String(score), 192, 67);
      }
      var t = new THREE.CanvasTexture(c);
      t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      return t;
    }

    /* ---------- shared geometry ---------- */
    var GEO = {
      box: new THREE.BoxGeometry(1, 1, 1),
      bird: new THREE.IcosahedronGeometry(0.5, 1),
      beak: new THREE.ConeGeometry(0.19, 0.42, 6),
      beakLo: new THREE.ConeGeometry(0.15, 0.3, 6),
      tail: new THREE.ConeGeometry(0.15, 0.46, 4),
      crest: new THREE.ConeGeometry(0.085, 0.3, 4),
      eye: new THREE.SphereGeometry(0.19, 10, 8),
      pupil: new THREE.SphereGeometry(0.1, 8, 6),
      shine: new THREE.SphereGeometry(0.04, 6, 4),
      cheek: new THREE.SphereGeometry(0.09, 6, 5),
      cloud: new THREE.IcosahedronGeometry(1, 1),
      hill: new THREE.IcosahedronGeometry(1, 1),
      rock: new THREE.ConeGeometry(1, 1.5, 7),
      islTop: new THREE.CylinderGeometry(1.05, 1.0, 0.3, 7),
      trunk: new THREE.CylinderGeometry(0.12, 0.18, 1, 6),
      crown: new THREE.IcosahedronGeometry(1, 1),
      crystal: new THREE.ConeGeometry(0.32, 1, 5)
    };
    (function () {
      var wg = new THREE.IcosahedronGeometry(0.5, 0);
      wg.scale(0.62, 0.14, 0.58);
      GEO.wingR = wg.clone().translate(-0.08, 0, 0.3);   // pivot near the inner edge
      GEO.wingL = wg.clone().translate(-0.08, 0, -0.3);
      wg.dispose();
    })();
    GEO.boxEdges = new THREE.EdgesGeometry(GEO.box);

    /* ---------- sky dome (vertical gradient: peach horizon -> light blue) ---------- */
    var skyDome = (function () {
      var R = 250, g = new THREE.SphereGeometry(R, 20, 48);
      var pos = g.attributes.position, cols = new Float32Array(pos.count * 3);
      var stops = [[0, new THREE.Color('#ffd4b3')], [0.22, new THREE.Color('#ffe9d6')],
        [0.5, new THREE.Color('#c9e9ff')], [1, new THREE.Color('#58b2ff')]];
      var tmp = new THREE.Color();
      for (var i = 0; i < pos.count; i++) {
        var t = clamp(pos.getY(i) / R / 0.32, 0, 1), k = 0;
        while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
        var f = clamp((t - stops[k][0]) / (stops[k + 1][0] - stops[k][0]), 0, 1);
        tmp.copy(stops[k][1]).lerp(stops[k + 1][1], f);
        cols[i * 3] = tmp.r; cols[i * 3 + 1] = tmp.g; cols[i * 3 + 2] = tmp.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      var m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false
      }));
      m.renderOrder = -100;
      m.frustumCulled = false;
      scene.add(m);
      return m;
    })();

    /* ---------- sun glow ---------- */
    (function () {
      var glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: 0xffd9a0, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
        depthWrite: false, fog: false
      }));
      glow.scale.set(150, 150, 1);
      glow.position.set(45, 32, -200);
      scene.add(glow);
      var core = new THREE.Sprite(new THREE.SpriteMaterial({
        map: sunTex, color: 0xfff2b8, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
        depthWrite: false, fog: false
      }));
      core.scale.set(34, 34, 1);
      core.position.set(45, 32, -199);
      scene.add(core);
    })();

    /* ---------- ground: scrolling grass, sandy lane, candy curbs ---------- */
    var hzLane = PIPE_DEPTH / 2;
    var grassTex = stripeTex(['#86ea62', '#74d84f'], 64, 16);
    grassTex.repeat.set(500 / 12, 1);
    var laneTex = stripeTex(['#ffeab0', '#ffdc86'], 64, 16);
    laneTex.repeat.set(500 / 8, 1);
    var curbTex = stripeTex(['#ff5fa8', '#ffffff', '#ffb02e', '#ffffff', '#3ed36a', '#ffffff', '#2ec5ff', '#ffffff'], 32, 16);
    curbTex.repeat.set(500 / 8, 1);
    var ceilTex = stripeTex(['rgba(255,255,255,.6)', 'rgba(255,255,255,.16)'], 64, 16);
    ceilTex.repeat.set(500 / 12, 1);

    (function buildGround() {
      function strip(w, d, tex, x, y, z, flip) {
        var m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: tex }));
        m.rotation.x = flip ? Math.PI / 2 : -Math.PI / 2;
        m.position.set(x, y, z);
        m.frustumCulled = false;
        scene.add(m);
        return m;
      }
      strip(500, 500, grassTex, 60, FLOOR_Y - 0.02, 0, false);
      strip(500, PIPE_DEPTH, laneTex, 60, FLOOR_Y - 0.01, 0, false);
      strip(500, 1.0, curbTex, 60, FLOOR_Y - 0.01, hzLane + 0.5, false);
      strip(500, 1.0, curbTex, 60, FLOOR_Y - 0.01, -hzLane - 0.5, false);

      // translucent "cloud ceiling" marking the top of the flight lanes
      var cp = new THREE.Mesh(new THREE.PlaneGeometry(500, PIPE_DEPTH), new THREE.MeshBasicMaterial({
        map: ceilTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false
      }));
      cp.rotation.x = Math.PI / 2;
      cp.position.set(60, CEIL_Y, 0);
      cp.frustumCulled = false;
      scene.add(cp);

      // bright rails marking the edges of the flight lanes
      var r = [];
      [FLOOR_Y + 0.03, CEIL_Y - 0.03].forEach(function (y) {
        r.push(-48, y, hzLane, 250, y, hzLane, -48, y, -hzLane, 250, y, -hzLane);
      });
      var rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(r), 3));
      var rails = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
      rails.frustumCulled = false;
      scene.add(rails);
    })();

    /* ---------- low-poly clouds (drift slowly) ---------- */
    var clouds = [];
    (function buildClouds() {
      var mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x20263d, flatShading: true });
      for (var i = 0; i < 12; i++) {
        var g = new THREE.Group(), n = 4 + Math.floor(rand(0, 3)), w = rand(6, 11);
        for (var k = 0; k < n; k++) {
          var m = new THREE.Mesh(GEO.cloud, mat);
          var s = rand(0.55, 1) * w * 0.5 * (1 - Math.abs(k - (n - 1) / 2) / n * 0.8);
          m.scale.set(s * 1.2, s * 0.7, s * 0.9);
          m.position.set((k - (n - 1) / 2) * w * 0.45, rand(-0.1, 0.25) * s, rand(-1, 1));
          g.add(m);
        }
        var cz = -rand(55, 140);
        g.position.set(-60 + i * 27 + rand(-8, 8), rand(7, 10 - cz * 0.17), cz);
        scene.add(g);
        clouds.push(g);
      }
    })();

    /* ---------- distant colourful hills ---------- */
    var hills = [];
    (function buildHills() {
      var cols = [0x7fe3a8, 0x6fd6d0, 0xb7a2ff, 0xffb98f, 0xa6e36f, 0xff9ec0];
      var mats = cols.map(function (c) { return new THREE.MeshLambertMaterial({ color: c, flatShading: true }); });
      for (var i = 0; i < 12; i++) {
        var m = new THREE.Mesh(GEO.hill, mats[i % mats.length]);
        m.scale.set(rand(26, 46), rand(9, 20), rand(14, 22));
        m.position.set(-50 + i * 25 + rand(-8, 8), FLOOR_Y, -rand(75, 140));
        scene.add(m);
        hills.push(m);
      }
    })();

    /* ---------- floating islands ---------- */
    var islands = [];
    (function buildIslands() {
      var rockMat = new THREE.MeshLambertMaterial({ color: 0xc79a6b, flatShading: true });
      var grassMat = new THREE.MeshLambertMaterial({ color: 0x6fe07a, flatShading: true });
      var trunkMat = new THREE.MeshLambertMaterial({ color: 0x9a6a3c, flatShading: true });
      var acc = [0xff7fb0, 0xffd93b, 0x2ec5c0, 0xb07bff].map(function (c) {
        return new THREE.MeshLambertMaterial({ color: c, flatShading: true });
      });
      for (var i = 0; i < 6; i++) {
        var g = new THREE.Group();
        var rock = new THREE.Mesh(GEO.rock, rockMat);
        rock.rotation.x = Math.PI; rock.position.y = -0.85;
        var top = new THREE.Mesh(GEO.islTop, grassMat);
        top.position.y = 0.0;
        g.add(rock); g.add(top);
        if (i % 2 === 0) {
          var tr = new THREE.Mesh(GEO.trunk, trunkMat);
          tr.scale.set(1, 0.8, 1); tr.position.set(0.2, 0.55, 0);
          var cr = new THREE.Mesh(GEO.crown, acc[i % acc.length]);
          cr.scale.set(0.5, 0.45, 0.5); cr.position.set(0.2, 1.15, 0);
          g.add(tr); g.add(cr);
        } else {
          var cy = new THREE.Mesh(GEO.crystal, acc[(i + 1) % acc.length]);
          cy.scale.set(1, 1.1, 1); cy.position.set(0.15, 0.6, 0);
          g.add(cy);
        }
        var s = rand(2.6, 4.5);
        g.scale.set(s, s, s);
        var y0 = rand(5, 14);
        g.position.set(-30 + i * 45 + rand(-10, 10), y0, -rand(40, 85));
        g.userData.y0 = y0;
        g.userData.ph = rand(0, 6.28);
        scene.add(g);
        islands.push(g);
      }
    })();

    /* ---------- lollipop trees and bushes behind the lanes (scroll with the ground) ---------- */
    var deco = [], DECO_L = 160;
    (function buildDeco() {
      var trunkMat = new THREE.MeshLambertMaterial({ color: 0x9a6a3c, flatShading: true });
      var leafMats = [0x4fd96b, 0xff7fb0, 0xffb02e, 0x2ec5c0, 0x9b7bff].map(function (c) {
        return new THREE.MeshLambertMaterial({ color: c, flatShading: true });
      });
      var N = 16;
      for (var i = 0; i < N; i++) {
        var g = new THREE.Group(), s = rand(1.0, 1.8), bush = (i % 3 === 1);
        var crown = new THREE.Mesh(GEO.crown, leafMats[bush ? 0 : (i % leafMats.length)]);
        if (bush) {
          crown.scale.set(s * 1.1, s * 0.8, s * 1.1);
          crown.position.y = FLOOR_Y + s * 0.3;
        } else {
          var h = 1.4 * s;
          var tr = new THREE.Mesh(GEO.trunk, trunkMat);
          tr.scale.set(s, h, s);
          tr.position.y = FLOOR_Y + h / 2;
          g.add(tr);
          crown.scale.set(s * 0.95, s * 0.95, s * 0.95);
          crown.position.y = FLOOR_Y + h + s * 0.6;
        }
        g.add(crown);
        var x0 = i * (DECO_L / N) + rand(-3, 3);
        g.position.set(x0, 0, -(hzLane + rand(2.2, 9)));
        scene.add(g);
        deco.push({ g: g, x0: x0 });
      }
    })();

    /* ---------- pipes / towers (candy colours) ---------- */
    function makeSlab(bodyMat, lineMat, hiMat, shMat) {
      var g = new THREE.Group();
      g.add(new THREE.Mesh(GEO.box, bodyMat));
      g.add(new THREE.LineSegments(GEO.boxEdges, lineMat));
      if (hiMat) {                                  // glossy highlight + soft shade stripes on the front face
        var sz = 0.05 / PIPE_DEPTH;
        var hi = new THREE.Mesh(GEO.box, hiMat);
        hi.position.set(-0.27, 0, 0.5 + sz * 0.5); hi.scale.set(0.15, 1, sz);
        var hi2 = new THREE.Mesh(GEO.box, hiMat);
        hi2.position.set(-0.08, 0, 0.5 + sz * 0.5); hi2.scale.set(0.04, 1, sz);
        var sh = new THREE.Mesh(GEO.box, shMat);
        sh.position.set(0.34, 0, 0.5 + sz * 0.5); sh.scale.set(0.22, 1, sz);
        g.add(hi); g.add(hi2); g.add(sh);
      }
      return g;
    }
    function setSlab(g, y0, y1, w, d) {
      g.position.set(0, (y0 + y1) / 2, 0);
      g.scale.set(w, Math.max(0.01, y1 - y0), d);
    }
    function makePipe() {
      var bodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
      var capMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
      var lineMat = new THREE.LineBasicMaterial({ color: 0x000000 });
      var hiMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      var shMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
      var group = new THREE.Group();
      var p = {
        x: 0, gapY: 0, gap: 5, idx: 0, passed: false, group: group,
        topBody: makeSlab(bodyMat, lineMat, hiMat, shMat), topCap: makeSlab(capMat, lineMat),
        botBody: makeSlab(bodyMat, lineMat, hiMat, shMat), botCap: makeSlab(capMat, lineMat),
        bodyMat: bodyMat, capMat: capMat, lineMat: lineMat, hiMat: hiMat, shMat: shMat
      };
      group.add(p.topBody); group.add(p.topCap); group.add(p.botBody); group.add(p.botCap);
      group.visible = false;
      scene.add(group);
      return p;
    }
    var tmpC = new THREE.Color(), whiteC = new THREE.Color(0xffffff);
    function layoutPipe(p) {
      var gTop = p.gapY + p.gap / 2, gBot = p.gapY - p.gap / 2;
      var cw = PIPE_W + 2 * CAP_PAD, cd = PIPE_DEPTH + 2 * CAP_PAD;
      setSlab(p.topBody, gTop + CAP_H, CEIL_Y, PIPE_W, PIPE_DEPTH);
      setSlab(p.topCap, gTop, gTop + CAP_H, cw, cd);
      setSlab(p.botBody, FLOOR_Y, gBot - CAP_H, PIPE_W, PIPE_DEPTH);
      setSlab(p.botCap, gBot - CAP_H, gBot, cw, cd);
      tmpC.setHex(PIPE_PAL[p.idx % PIPE_PAL.length]);
      p.bodyMat.color.copy(tmpC);
      p.bodyMat.emissive.copy(tmpC).multiplyScalar(0.22);
      p.capMat.color.copy(tmpC).lerp(whiteC, 0.38);
      p.capMat.emissive.copy(tmpC).lerp(whiteC, 0.2).multiplyScalar(0.25);
      p.hiMat.color.copy(tmpC).lerp(whiteC, 0.62);
      p.shMat.color.copy(tmpC).multiplyScalar(0.68);
      p.lineMat.color.copy(tmpC).multiplyScalar(0.42);
    }
    var pipePool = [], pipes = [];
    for (var pi = 0; pi < 12; pi++) pipePool.push(makePipe());

    /* ---------- birds (5 rigs built once, one per identity slot) ---------- */
    function makeRig(colorCss, label) {
      var col = new THREE.Color(colorCss);
      var holder = new THREE.Group();   // world position
      var body = new THREE.Group();     // pitch / tumble
      holder.add(body);
      var mats = [];
      function reg(m) { mats.push(m); return m; }
      function mat(opts) {
        return reg(new THREE.MeshPhongMaterial(Object.assign({ transparent: true, flatShading: true, shininess: 25, specular: 0x333333 }, opts)));
      }
      var light = col.clone().lerp(new THREE.Color(0xffffff), 0.35);

      var bodyMat = mat({ color: col, emissive: col.clone().multiplyScalar(0.28) });
      var torso = new THREE.Mesh(GEO.bird, bodyMat);
      torso.scale.set(1.12, 1.0, 1.0);
      body.add(torso);

      // cartoon outline (inverted hull)
      var hull = new THREE.Mesh(GEO.bird, reg(new THREE.MeshBasicMaterial({
        color: col.clone().multiplyScalar(0.3), side: THREE.BackSide, transparent: true
      })));
      hull.scale.set(1.12 * 1.09, 1.09, 1.09);
      body.add(hull);

      // white belly
      var belly = new THREE.Mesh(GEO.bird, mat({ color: 0xfff6e2, emissive: 0x2a2620 }));
      belly.scale.set(0.95, 0.82, 1.1);
      belly.position.set(0.12, -0.16, 0);
      body.add(belly);

      // orange beak (upper + lower)
      var beak = new THREE.Mesh(GEO.beak, mat({ color: 0xff9d1c, emissive: 0x663300 }));
      beak.rotation.z = -Math.PI / 2;
      beak.position.set(0.64, 0.0, 0);
      body.add(beak);
      var beakLo = new THREE.Mesh(GEO.beakLo, mat({ color: 0xff7a00, emissive: 0x552200 }));
      beakLo.rotation.z = -Math.PI / 2;
      beakLo.position.set(0.58, -0.11, 0);
      body.add(beakLo);

      // fanned tail feathers
      var tailMat = mat({ color: light, emissive: col.clone().multiplyScalar(0.25) });
      for (var tk = -1; tk <= 1; tk++) {
        var tf = new THREE.Mesh(GEO.tail, tailMat);
        tf.rotation.z = Math.PI / 2 + tk * 0.4;
        tf.position.set(-0.66, 0.1 + tk * 0.12, 0);
        body.add(tf);
      }

      // head crest
      var crestMat = mat({ color: light, emissive: col.clone().multiplyScalar(0.25) });
      [[0.2, 0.5, -0.25], [0.05, 0.54, -0.05], [-0.1, 0.5, 0.18]].forEach(function (c) {
        var m = new THREE.Mesh(GEO.crest, crestMat);
        m.position.set(c[0], c[1], 0);
        m.rotation.z = c[2];
        body.add(m);
      });

      // big eyes + blush cheeks
      var eyeMat = mat({ color: 0xffffff, emissive: 0x555555 });
      var pupMat = mat({ color: 0x111111, emissive: 0x000000 });
      var cheekMat = mat({ color: 0xff8fb0, emissive: 0x44202a });
      [-1, 1].forEach(function (s) {
        var e = new THREE.Mesh(GEO.eye, eyeMat);
        e.position.set(0.32, 0.2, 0.36 * s);
        body.add(e);
        var pu = new THREE.Mesh(GEO.pupil, pupMat);
        pu.position.set(0.41, 0.21, 0.46 * s);
        body.add(pu);
        var sh = new THREE.Mesh(GEO.shine, eyeMat);
        sh.position.set(0.44, 0.27, 0.5 * s);
        body.add(sh);
        var ch = new THREE.Mesh(GEO.cheek, cheekMat);
        ch.scale.set(1, 0.7, 0.5);
        ch.position.set(0.36, -0.09, 0.4 * s);
        body.add(ch);
      });

      // flapping wings
      var wingMat = mat({ color: light, emissive: col.clone().multiplyScalar(0.25) });
      var wingR = new THREE.Group(), wingL = new THREE.Group();
      wingR.position.set(-0.1, 0.0, 0.42);
      wingL.position.set(-0.1, 0.0, -0.42);
      wingR.add(new THREE.Mesh(GEO.wingR, wingMat));
      wingL.add(new THREE.Mesh(GEO.wingL, wingMat));
      body.add(wingR); body.add(wingL);

      var glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: col, transparent: true, opacity: 0.3,
        depthWrite: false, fog: false
      }));
      glow.scale.set(3.2, 3.2, 1);
      holder.add(glow);

      var tag = new THREE.Sprite(new THREE.SpriteMaterial({
        map: badgeTex(label, colorCss, null), transparent: true, depthTest: false, depthWrite: false, fog: false
      }));
      tag.scale.set(1.5, 0.75, 1);
      tag.position.set(0, 1.15, 0);
      tag.renderOrder = 5;
      holder.add(tag);

      holder.visible = false;
      scene.add(holder);
      return {
        holder: holder, body: body, wingR: wingR, wingL: wingL, glow: glow, tag: tag, col: col, css: colorCss,
        setOpacity: function (o) {
          for (var i = 0; i < mats.length; i++) mats[i].opacity = o;
          glow.material.opacity = 0.3 * o;
          tag.material.opacity = o;
        }
      };
    }
    var rigs = [];
    for (var ri = 0; ri < MAX_PLAYERS; ri++) rigs.push(makeRig(COLORS[ri % COLORS.length], 'P' + (ri + 1)));

    /* ---------- particles (one alpha-blended Points pool: sparkles, stars, puffs, feathers) ---------- */
    var PAL = SPARK_CSS.map(function (c) { return new THREE.Color(c); });
    function palPick() { return PAL[Math.floor(Math.random() * PAL.length)]; }
    var MAXP = 800, pHead = 0, pAny = false;
    var pPos = new Float32Array(MAXP * 3), pCol = new Float32Array(MAXP * 3), pVel = new Float32Array(MAXP * 3);
    var pLife = new Float32Array(MAXP), pMax = new Float32Array(MAXP), pGrav = new Float32Array(MAXP);
    var pAl = new Float32Array(MAXP), pSz = new Float32Array(MAXP), pSzB = new Float32Array(MAXP);
    var pKind = new Float32Array(MAXP), pRot = new Float32Array(MAXP), pSpin = new Float32Array(MAXP);
    for (var qi = 0; qi < MAXP; qi++) pPos[qi * 3 + 1] = -100;
    var pGeo = new THREE.BufferGeometry();
    var pAttrs = {
      position: new THREE.BufferAttribute(pPos, 3), aColor: new THREE.BufferAttribute(pCol, 3),
      aAlpha: new THREE.BufferAttribute(pAl, 1), aSize: new THREE.BufferAttribute(pSz, 1),
      aKind: new THREE.BufferAttribute(pKind, 1), aRot: new THREE.BufferAttribute(pRot, 1)
    };
    for (var an in pAttrs) { pAttrs[an].setUsage(THREE.DynamicDrawUsage); pGeo.setAttribute(an, pAttrs[an]); }
    var atlas = atlasTex();
    var partMat = new THREE.ShaderMaterial({
      uniforms: { map: { value: atlas }, uScale: { value: 600 } },
      vertexShader: [
        'attribute vec3 aColor; attribute float aAlpha; attribute float aSize; attribute float aKind; attribute float aRot;',
        'uniform float uScale;',
        'varying vec3 vColor; varying float vAlpha; varying float vKind; varying float vRot;',
        'void main(){',
        '  vColor = aColor; vAlpha = aAlpha; vKind = aKind; vRot = aRot;',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  gl_PointSize = aSize * uScale / max(0.1, -mv.z);',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D map;',
        'varying vec3 vColor; varying float vAlpha; varying float vKind; varying float vRot;',
        'void main(){',
        '  vec2 uv = gl_PointCoord - 0.5;',
        '  float c = cos(vRot), s = sin(vRot);',
        '  uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y) + 0.5;',
        '  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;',
        '  vec2 tuv = vec2((vKind + 0.02 + uv.x * 0.96) * 0.25, 1.0 - uv.y);',
        '  vec4 t = texture2D(map, tuv);',
        '  float a = t.a * vAlpha;',
        '  if (a < 0.01) discard;',
        '  gl_FragColor = vec4(vColor * t.rgb, a);',
        '}'
      ].join('\n'),
      transparent: true, depthWrite: false
    });
    var pPoints = new THREE.Points(pGeo, partMat);
    pPoints.frustumCulled = false;
    scene.add(pPoints);

    // kind: 0 sparkle, 1 star, 2 puff, 3 feather
    function emit(x, y, z, vx, vy, vz, r, g, b, life, grav, size, kind, spin) {
      var i = pHead, j = i * 3;
      pHead = (pHead + 1) % MAXP;
      pPos[j] = x; pPos[j + 1] = y; pPos[j + 2] = z;
      pVel[j] = vx; pVel[j + 1] = vy; pVel[j + 2] = vz;
      pCol[j] = r; pCol[j + 1] = g; pCol[j + 2] = b;
      pLife[i] = pMax[i] = life;
      pGrav[i] = grav || 0;
      pSzB[i] = pSz[i] = size || 0.4;
      pKind[i] = kind || 0;
      pRot[i] = Math.random() * 6.283;
      pSpin[i] = spin || 0;
      pAl[i] = 1;
      pAny = true;
    }
    /* colourful sparkle / star burst (whiten = mix in the rainbow palette) */
    function burst(x, y, z, col, n, speed, life, grav, whiten) {
      for (var i = 0; i < n; i++) {
        var th = rand(0, 6.283), ph = Math.acos(rand(-1, 1)), v = rand(0.25, 1) * speed;
        var c = (whiten && Math.random() < 0.55) ? palPick() : col;
        var star = Math.random() < 0.4;
        emit(x, y, z,
          Math.sin(ph) * Math.cos(th) * v, Math.sin(ph) * Math.sin(th) * v, Math.cos(ph) * v,
          c.r, c.g, c.b, life * rand(0.6, 1), grav, star ? rand(0.45, 0.7) : rand(0.3, 0.55), star ? 1 : 0, star ? rand(-4, 4) : 0);
      }
    }
    /* crash: a puff of feathers, stars and a soft cloud */
    function crashFx(b, big) {
      var col = b.rig.col, x = b.x, y = b.y, z = b.lane, i, th, ph, v, c;
      var nf = big ? 12 : 5, ns = big ? 9 : 3, np = big ? 6 : 3;
      for (i = 0; i < nf; i++) {
        th = rand(0, 6.283); ph = Math.acos(rand(-1, 1)); v = rand(4, 9);
        c = (i % 2 === 0) ? col : whiteC;
        emit(x, y, z, Math.sin(ph) * Math.cos(th) * v, Math.sin(ph) * Math.sin(th) * v + 2, Math.cos(ph) * v,
          c.r, c.g, c.b, rand(1.1, 1.8), 3, 0.6, 3, rand(-8, 8));
      }
      for (i = 0; i < ns; i++) {
        th = rand(0, 6.283); ph = Math.acos(rand(-1, 1)); v = rand(6, 10);
        c = PAL[i % 3];                                  // yellow / pink / mint
        emit(x, y, z, Math.sin(ph) * Math.cos(th) * v, Math.sin(ph) * Math.sin(th) * v, Math.cos(ph) * v,
          c.r, c.g, c.b, rand(0.7, 1.1), 6, rand(0.6, 0.85), 1, rand(-6, 6));
      }
      for (i = 0; i < np; i++) {
        emit(x + rand(-0.3, 0.3), y + rand(-0.3, 0.3), z + rand(-0.3, 0.3), rand(-2, 2), rand(-1, 2), rand(-2, 2),
          1, 1, 1, rand(0.5, 0.8), 0, 1.5, 2, 0);
      }
    }
    function updateParticles(dt) {
      if (!pAny) return;
      var alive = 0;
      for (var i = 0; i < MAXP; i++) {
        if (pLife[i] <= 0) continue;
        var j = i * 3;
        pLife[i] -= dt;
        if (pLife[i] <= 0) {
          pAl[i] = 0; pSz[i] = 0;
          pPos[j + 1] = -100;
          continue;
        }
        alive++;
        pVel[j + 1] -= pGrav[i] * dt;
        pPos[j] += pVel[j] * dt; pPos[j + 1] += pVel[j + 1] * dt; pPos[j + 2] += pVel[j + 2] * dt;
        var f = pLife[i] / pMax[i], k = pKind[i];
        pAl[i] = (f > 0.45 ? 1 : f / 0.45) * (k === 2 ? 0.75 : 1);
        pSz[i] = k === 2 ? pSzB[i] * (1 + (1 - f) * 1.2)
          : pSzB[i] * (0.5 + 0.5 * Math.min(1, f * 2.5)) * (0.85 + 0.15 * Math.sin(time * 22 + i));
        pRot[i] += pSpin[i] * dt;
      }
      pAttrs.position.needsUpdate = true;
      pAttrs.aColor.needsUpdate = true;
      pAttrs.aAlpha.needsUpdate = true;
      pAttrs.aSize.needsUpdate = true;
      pAttrs.aKind.needsUpdate = true;
      pAttrs.aRot.needsUpdate = true;
      if (!alive) pAny = false;
    }

    /* ---------- floating score badges (shown where a bird died) ---------- */
    var popups = [];
    function spawnPopup(b) {
      var mat = new THREE.SpriteMaterial({
        map: badgeTex(b.idn.label, b.idn.color, b.score), transparent: true, depthTest: false, depthWrite: false, fog: false
      });
      var s = new THREE.Sprite(mat);
      s.scale.set(2.2, 1.1, 1);
      s.position.set(b.x + 0.3, b.y + 1.4, b.lane);
      s.renderOrder = 9;
      scene.add(s);
      popups.push({ s: s, t: 0, life: 2.6, y0: s.position.y });
    }
    function updatePopups(dt) {
      for (var i = popups.length - 1; i >= 0; i--) {
        var p = popups[i];
        p.t += dt;
        if (p.t >= p.life) {
          scene.remove(p.s);
          p.s.material.map.dispose();
          p.s.material.dispose();
          popups.splice(i, 1);
          continue;
        }
        p.s.position.y = p.y0 + p.t * 0.9;
        p.s.position.x -= speedNow * 0.4 * dt;
        var o = p.t < 0.2 ? p.t / 0.2 : (p.t > p.life - 0.6 ? (p.life - p.t) / 0.6 : 1);
        p.s.material.opacity = o;
        var k = 0.7 + 0.3 * Math.min(1, p.t / 0.2);
        p.s.scale.set(2.2 * k, 1.1 * k, 1);
      }
    }

    /* ======================================================================
     * GAME STATE
     * ==================================================================== */
    var state = 'waiting';              // waiting | countdown | play | over
    var stateT = 0;                     // seconds in current state (render time)
    var time = 0;                       // total render time
    var acc = 0;                        // fixed-step accumulator
    var tPlay = 0;                      // seconds of the current round (sim time)
    var dist = 0;                       // distance scrolled (drives the floor)
    var speedNow = 0;                   // current world speed (units/s)
    var cdT = 0, cdShown = null, goT = 0, overT = 0;
    var trauma = 0;                     // camera-shake energy 0..1
    var lastGapY = null, pipeCounter = 0;
    var roundSolo = false, roundInfo = null, winnerBird = null;
    var confTimer = 0;

    var present = [];                   // [{id, slot}] currently connected
    var presentIds = {};                // id -> true
    var slotToId = {};                  // slot -> id
    var idents = {};                    // id -> {id, slot(identity 0..4), color, label, wins}
    var prevKeys = {};                  // id -> last seen held state of each face button
    var birds = [];                     // participants of the current round

    var sfx = makeSfx();

    /* ---------- identities: stable colour/label/lane per player id ---------- */
    function resolveIdentities() {
      var used = {};
      for (var i = 0; i < present.length; i++) {
        var p = present[i], idn = idents[p.id];
        if (!idn || used[idn.slot]) {
          var s = (p.slot >= 0 && p.slot < MAX_PLAYERS && !used[p.slot]) ? p.slot : -1;
          if (s < 0) { s = 0; while (used[s] && s < MAX_PLAYERS - 1) s++; }
          if (!idn) { idn = idents[p.id] = { id: p.id, wins: 0 }; }
          idn.slot = s;
          idn.color = COLORS[s % COLORS.length];
          idn.label = 'P' + (s + 1);
        }
        used[idn.slot] = true;
      }
    }
    function presentIdents() {
      var out = [];
      for (var i = 0; i < present.length; i++) if (idents[present[i].id]) out.push(idents[present[i].id]);
      out.sort(function (a, b) { return a.slot - b.slot; });
      return out;
    }
    function snapshotKeys(id, slot) {
      var st = ctx.input ? ctx.input(slot) : null, k = (st && st.k) || {};
      prevKeys[id] = { cr: !!k.cr, ci: !!k.ci, sq: !!k.sq, tri: !!k.tri };
    }

    /* ---------- birds ---------- */
    function newBird(id) {
      var idn = idents[id];
      var b = {
        id: id, idn: idn, rig: rigs[idn.slot],
        x: 0, y: 0, vx: 0, vy: 0, lane: null, laneT: 0,
        alive: true, score: 0, diedAt: 0, reason: '',
        flapPending: false, flapE: 0, wingPh: rand(0, 6.28), hoverPh: rand(0, 6.28),
        rotX: 0, rotY: 0, rotZ: 0, spinX: 0, spinZ: 0, fadeT: 0, trailT: 0, lastSnd: -1
      };
      b.rig.setOpacity(1);
      return b;
    }
    function birdById(id) {
      for (var i = 0; i < birds.length; i++) if (birds[i].id === id) return birds[i];
      return null;
    }
    /* waiting/countdown: keep one hovering bird per connected player */
    function syncBirds() {
      birds = birds.filter(function (b) { return presentIds[b.id]; });
      for (var i = 0; i < present.length; i++) if (!birdById(present[i].id)) birds.push(newBird(present[i].id));
      birds.sort(function (a, b) { return a.idn.slot - b.idn.slot; });
      var n = birds.length;
      birds.forEach(function (b, k) {
        b.laneT = (k - (n - 1) / 2) * LANE_GAP;
        if (b.lane === null) b.lane = b.laneT;
      });
    }

    /* ---------- pipes ---------- */
    function currentSpeedTarget() { return Math.min(SPEED_MAX, SPEED0 + tPlay * SPEED_GAIN); }
    function spawnPipe(x) {
      var p = pipePool.pop();
      if (!p) return;
      var gap = Math.max(GAP_MIN, GAP0 - tPlay * GAP_SHRINK);
      var lo = FLOOR_Y + 1.3 + gap / 2, hi = CEIL_Y - 1.3 - gap / 2;
      var mn = lo, mx = hi;
      if (lastGapY !== null) {
        // Never ask for a climb/drop the bird physically cannot make in time.
        var dtp = PIPE_SPACING / Math.max(currentSpeedTarget(), 6);
        mn = Math.max(lo, lastGapY - Math.min(9, dtp * 9));
        mx = Math.min(hi, lastGapY + Math.min(6.5, dtp * 4.6));
        if (mn > mx) mn = mx = clamp(lastGapY, lo, hi);
      }
      p.x = x; p.gap = gap; p.gapY = mn + Math.random() * (mx - mn);
      p.idx = pipeCounter++; p.passed = false;
      lastGapY = p.gapY;
      layoutPipe(p);
      p.group.position.x = x;
      p.group.visible = true;
      pipes.push(p);
    }
    function ensurePipes() {
      var lastX = pipes.length ? pipes[pipes.length - 1].x : FIRST_PIPE_X - PIPE_SPACING;
      while (lastX + PIPE_SPACING <= SPAWN_X && pipePool.length) {
        lastX += PIPE_SPACING;
        spawnPipe(lastX);
      }
    }
    function recyclePipes() {
      while (pipes.length && pipes[0].x < DESPAWN_X) {
        var p = pipes.shift();
        p.group.visible = false;
        pipePool.push(p);
      }
    }
    function resetPipes() {
      while (pipes.length) {
        var p = pipes.shift();
        p.group.visible = false;
        pipePool.push(p);
      }
      lastGapY = null;
      ensurePipes();
    }
    function hitsPipe(b, p) {
      var gTop = p.gapY + p.gap / 2, gBot = p.gapY - p.gap / 2;
      var hw = PIPE_W / 2, cw = hw + CAP_PAD, px = p.x;
      return circleRect(b.x, b.y, BIRD_R, px - hw, px + hw, gTop, CEIL_Y + 2) ||
        circleRect(b.x, b.y, BIRD_R, px - cw, px + cw, gTop, gTop + CAP_H) ||
        circleRect(b.x, b.y, BIRD_R, px - hw, px + hw, FLOOR_Y - 2, gBot) ||
        circleRect(b.x, b.y, BIRD_R, px - cw, px + cw, gBot - CAP_H, gBot);
    }

    /* ---------- flap / death effects ---------- */
    function doFlapFx(b) {
      b.flapE = 1;
      var c = b.rig.col;
      for (var i = 0; i < 7; i++) {
        var cc = Math.random() < 0.45 ? c : palPick();
        var star = Math.random() < 0.3;
        emit(b.x - 0.3, b.y - 0.2, b.lane + rand(-0.3, 0.3), -speedNow * 0.6 + rand(-2, 0), rand(-5, -1.5), rand(-1, 1),
          cc.r, cc.g, cc.b, 0.55, 2, rand(0.3, 0.55), star ? 1 : 0, star ? rand(-5, 5) : 0);
      }
      if (time - b.lastSnd > 0.05) { sfx.flap(b.idn.slot, false); b.lastSnd = time; }
    }
    function wingKick(b) {            // flap on waiting / countdown screens (visual only)
      b.flapE = 1;
      if (time - b.lastSnd > 0.08) { sfx.flap(b.idn.slot, true); b.lastSnd = time; }
    }
    function kill(b, reason) {
      if (!b.alive) return;
      b.alive = false; b.diedAt = tPlay; b.reason = reason; b.fadeT = 0;
      b.vx = -(speedNow * 0.4) - 1.5;
      b.vy = reason === 'ground' ? 5 : (reason === 'ceiling' ? -2 : 4.5);
      b.spinX = rand(-7, 7); b.spinZ = rand(-9, -4);
      crashFx(b, reason !== 'left');
      trauma = Math.min(1, trauma + (reason === 'left' ? 0.12 : 0.65));
      if (reason !== 'left') sfx.die();
      spawnPopup(b);
    }
    function tumble(b, dt) {          // dead bird: gravity + bounce, carried back by the world
      b.vy -= GRAVITY * 0.8 * dt;
      b.y += b.vy * dt;
      b.x += b.vx * dt;
      if (b.y - BIRD_R < FLOOR_Y) {
        b.y = FLOOR_Y + BIRD_R;
        b.vy = Math.abs(b.vy) * 0.3 > 1 ? Math.abs(b.vy) * 0.3 : 0;
        b.vx *= 0.9; b.spinX *= 0.8; b.spinZ *= 0.8;
      } else if (b.y + BIRD_R > CEIL_Y) {
        b.y = CEIL_Y - BIRD_R;
        b.vy = -Math.abs(b.vy) * 0.3;
      }
    }

    /* ======================================================================
     * SIMULATION (fixed step)
     * ==================================================================== */
    function stepBird(b, dt) {
      if (!b.alive) { tumble(b, dt); return; }
      if (b.flapPending) { b.flapPending = false; b.vy = FLAP_V; doFlapFx(b); }
      b.vy -= GRAVITY * dt;
      if (b.vy < -FALL_MAX) b.vy = -FALL_MAX;
      b.y += b.vy * dt;
      if (b.y - BIRD_R <= FLOOR_Y) { b.y = FLOOR_Y + BIRD_R; kill(b, 'ground'); return; }
      if (b.y + BIRD_R >= CEIL_Y) { b.y = CEIL_Y - BIRD_R; kill(b, 'ceiling'); return; }
      for (var i = 0; i < pipes.length; i++) {
        var p = pipes[i];
        if (Math.abs(p.x) > PIPE_W / 2 + CAP_PAD + BIRD_R + 0.1) continue;
        if (hitsPipe(b, p)) { kill(b, 'pipe'); return; }
      }
    }

    function checkRoundEnd() {
      if (state !== 'play') return;
      var alive = [], i;
      for (i = 0; i < birds.length; i++) if (birds[i].alive) alive.push(birds[i]);
      if (roundSolo) { if (!alive.length) endRound(null); return; }
      if (alive.length >= 2) return;
      if (alive.length === 1) { endRound(alive[0]); return; }
      // Everyone died: longest survival wins; exact tie -> higher score -> lower player number.
      var best = null;
      for (i = 0; i < birds.length; i++) {
        var b = birds[i];
        if (!best || b.diedAt > best.diedAt + 1e-9 ||
          (Math.abs(b.diedAt - best.diedAt) <= 1e-9 &&
            (b.score > best.score || (b.score === best.score && b.idn.slot < best.idn.slot)))) best = b;
      }
      endRound(best);
    }

    function simStep(dt) {
      var tgt = state === 'play' ? currentSpeedTarget() : (state === 'waiting' ? ATTRACT_SPEED : 0);
      speedNow += (tgt - speedNow) * (1 - Math.exp(-(state === 'over' ? 8 : 3.5) * dt));
      dist += speedNow * dt;
      var i, b;
      for (i = 0; i < pipes.length; i++) pipes[i].x -= speedNow * dt;

      if (state === 'play') {
        tPlay += dt;
        for (i = 0; i < birds.length; i++) stepBird(birds[i], dt);
        // score: a pipe counts once its tower is fully behind the birds
        for (i = 0; i < pipes.length; i++) {
          var p = pipes[i];
          if (!p.passed && p.x < -(PIPE_W / 2 + CAP_PAD + BIRD_R)) {
            p.passed = true;
            var any = false;
            for (var k = 0; k < birds.length; k++) {
              b = birds[k];
              if (b.alive) {
                b.score++; any = true;
                burst(b.x, b.y, b.lane, b.rig.col, 5, 3, 0.5, 0, true);
              }
            }
            if (any) sfx.score();
          }
        }
        checkRoundEnd();
      } else if (state === 'over') {
        for (i = 0; i < birds.length; i++) {
          b = birds[i];
          if (!b.alive) { tumble(b, dt); continue; }
          // winner glides to the middle of the nearest gap
          var ty = 0;
          for (var q = 0; q < pipes.length; q++) if (pipes[q].x > -3 && pipes[q].x < 8) { ty = pipes[q].gapY; break; }
          b.vy = 0;
          b.y += (ty - b.y) * (1 - Math.exp(-2.5 * dt));
        }
      }
      recyclePipes();
      ensurePipes();
    }

    /* ======================================================================
     * STATE TRANSITIONS
     * ==================================================================== */
    function clearOverlays() {
      bigEl.innerHTML = '';
      confEl.innerHTML = '';
      goT = 0;
    }
    function setState(s) { state = s; stateT = 0; }

    function toWaiting() {
      setState('waiting');
      clearOverlays();
      birds = []; winnerBird = null; roundInfo = null;
      tPlay = 0; acc = 0;
      resetPipes();
      syncBirds();
    }
    function beginCountdown() {
      clearOverlays();
      birds = [];
      syncBirds();                    // fresh bird for every connected player
      winnerBird = null; roundInfo = null;
      tPlay = 0; acc = 0; speedNow = 0; trauma = 0;
      resetPipes();
      cdT = 0; cdShown = null;
      setState('countdown');
    }
    function startPlay() {
      if (!birds.length) { toWaiting(); return; }
      roundSolo = birds.length === 1;
      tPlay = 0; acc = 0;
      for (var i = 0; i < birds.length; i++) {
        var b = birds[i];
        b.y += Math.sin(b.hoverPh) * 0.28;   // keep the visual height continuous
        b.vy = START_VY; b.alive = true; b.score = 0; b.flapPending = false;
      }
      setState('play');
      bigEl.innerHTML = '<div class="sd-big go">GO!</div>';
      goT = 0.8;
      sfx.go();
    }
    function endRound(winner) {
      var solo = roundSolo, b0 = birds[0];
      setState('over');
      overT = 0;
      winnerBird = winner;
      roundInfo = { solo: solo, winner: winner, time: tPlay, score: 0, newBest: false };
      if (solo) {
        roundInfo.score = b0 ? b0.score : 0;
        roundInfo.time = b0 ? b0.diedAt : tPlay;
        if (roundInfo.score > bestSolo) { bestSolo = roundInfo.score; roundInfo.newBest = true; }
      } else if (winner) {
        roundInfo.time = winner.alive ? tPlay : winner.diedAt;
        roundInfo.score = winner.score;
        winner.idn.wins++;
        confetti(winner.idn.color);
        sfx.win();
        if (winner.alive) burst(winner.x, winner.y, winner.lane, winner.rig.col, 40, 9, 1.4, 3, true);
      }
    }

    function confetti(color) {
      confEl.innerHTML = '';
      var h = container.clientHeight || 720;
      var cols = [color, '#ffd93b', '#ff6fa5', '#3ee0c4', '#6ab7ff', '#ff9a3e', '#b07bff', '#ffffff', color,
        COLORS[Math.floor(rand(0, COLORS.length))]];
      for (var i = 0; i < 110; i++) {
        var s = document.createElement('span');
        s.style.left = rand(0, 100) + '%';
        s.style.background = cols[i % cols.length];
        if (i % 3 === 0) s.style.borderRadius = '50%';
        if (i % 4 === 1) { s.style.width = '.9em'; s.style.height = '.45em'; }
        s.style.setProperty('--ty', (h * 1.1) + 'px');
        s.style.setProperty('--dx', rand(-120, 120) + 'px');
        s.style.setProperty('--r', rand(360, 1080) + 'deg');
        s.style.animationDuration = rand(2.4, 4.6) + 's';
        s.style.animationDelay = rand(0, 1.2) + 's';
        confEl.appendChild(s);
      }
      clearTimeout(confTimer);
      confTimer = setTimeout(function () { confEl.innerHTML = ''; }, 7500);
    }

    /* ======================================================================
     * INPUT
     * ==================================================================== */
    function handleKey(slot, key) {
      if (!FLAP_KEYS[key]) return;
      var id = slotToId[slot];
      if (id === undefined) return;
      var b = birdById(id);
      if (state === 'waiting') {
        if (b) wingKick(b);
        if (slot === 0 && key === 'cr') beginCountdown();
      } else if (state === 'countdown') {
        if (b) wingKick(b);
      } else if (state === 'play') {
        if (b && b.alive) b.flapPending = true;
      } else if (state === 'over') {
        if (slot === 0 && key === 'cr' && overT >= OVER_LOCK) beginCountdown();
      }
    }
    /* Edge event from the host (button went down). Also marks the key as
       "already seen" so the polling fallback below does not flap twice. */
    function onButton(slot, key) {
      if (stopped || !FLAP_KEYS[key]) return;
      var id = slotToId[slot];
      if (id === undefined) return;
      if (!prevKeys[id]) snapshotKeys(id, slot);
      prevKeys[id][key] = true;
      handleKey(slot, key);
    }
    /* Fallback: detect rising edges by polling the live state every frame. */
    function pollInput() {
      for (var i = 0; i < present.length; i++) {
        var p = present[i];
        var st = ctx.input ? ctx.input(p.slot) : null;
        if (!st || !st.k) continue;
        var pk = prevKeys[p.id];
        if (!pk) { snapshotKeys(p.id, p.slot); continue; }
        for (var key in FLAP_KEYS) {
          var now = !!st.k[key];
          if (now && !pk[key]) handleKey(p.slot, key);
          pk[key] = now;
        }
      }
    }

    /* ======================================================================
     * ROSTER CHANGES
     * ==================================================================== */
    function applyPlayers(list) {
      if (stopped) return;
      present = []; presentIds = {}; slotToId = {};
      for (var i = 0; i < (list || []).length; i++) {
        var p = list[i];
        present.push({ id: p.id, slot: p.slot });
        presentIds[p.id] = true;
        slotToId[p.slot] = p.id;
      }
      resolveIdentities();
      for (var j = 0; j < present.length; j++) if (!prevKeys[present[j].id]) snapshotKeys(present[j].id, present[j].slot);

      if (!present.length) {
        if (state !== 'waiting') toWaiting(); else { birds = []; }
        return;
      }
      if (state === 'play') {
        // a disconnect counts as a death; joiners spectate until the next round
        for (var k = 0; k < birds.length; k++) if (!presentIds[birds[k].id] && birds[k].alive) kill(birds[k], 'left');
        checkRoundEnd();
      } else if (state === 'waiting' || state === 'countdown') {
        syncBirds();
        if (state === 'countdown' && !birds.length) toWaiting();
      }
    }

    /* ======================================================================
     * HUD RENDERING (DOM is only touched when the markup actually changes)
     * ==================================================================== */
    function pill(idn, score, alive) {
      return '<div class="sd-pill' + (alive ? '' : ' dead') + '" style="--c:' + idn.color + '"><i></i>' + idn.label +
        (score === null ? '' : '<b>' + score + '</b>') + '</div>';
    }
    function waitingHtml() {
      var list = presentIdents();
      var chips = list.map(function (i) {
        return '<span class="sd-chip" style="--c:' + i.color + '"><i></i>' + i.label + '</span>';
      }).join('');
      var cta = list.length ? '<b>Player 1</b>: press <span class="sd-key">\u2715</span> to start' : 'Waiting for players to join\u2026';
      return '<div class="sd-panel' + (stateT < 1.5 ? '' : ' nofx') + '" style="--c:' + COLORS[0] + '">' +
        '<div class="sd-kicker">NOVA CONSOLE</div><div class="sd-title">Sky Dash <span style="color:#ffd93b">3D</span></div>' +
        '<div class="sd-sub">Tap any button to flap \u00b7 last bird flying wins</div>' +
        '<div class="sd-chips">' + (chips || '<span class="sd-dim">No players yet</span>') + '</div>' +
        '<div class="sd-cta">' + cta + '</div></div>';
    }
    function overHtml() {
      if (!roundInfo) return '';
      var cls = 'sd-panel late' + (stateT < 2.4 ? '' : ' nofx');
      var hint = '<div class="sd-cta"><b>Player 1</b> <span class="sd-key">\u2715</span> Play again &nbsp;\u00b7&nbsp; <b>Select</b> Menu</div>';
      var w, c;
      if (roundInfo.solo) {
        var b0 = birds[0];
        c = b0 ? b0.idn.color : '#ffffff';
        return '<div class="' + cls + '" style="--c:' + c + '"><div class="sd-kicker">GAME OVER</div>' +
          '<div class="sd-name" style="color:' + c + '">' + (b0 ? b0.idn.label : '') + '</div>' +
          '<div class="sd-score">' + roundInfo.score + '</div>' +
          '<div class="sd-sub">pipes cleared \u00b7 survived ' + fmtPrecise(roundInfo.time) + '</div>' +
          '<div class="sd-sub">' + (roundInfo.newBest ? '\u2605 New best! \u2605' : 'Best ' + bestSolo) + '</div>' + hint + '</div>';
      }
      w = roundInfo.winner;
      if (!w) return '';
      var tally = presentIdents().map(function (i) {
        return '<span class="sd-chip" style="--c:' + i.color + '"><i></i>' + i.label + ' <b>' + i.wins + '</b></span>';
      }).join('');
      return '<div class="' + cls + '" style="--c:' + w.idn.color + '"><div class="sd-kicker">\u2605 WINNER \u2605</div>' +
        '<div class="sd-name" style="color:' + w.idn.color + '">PLAYER ' + (w.idn.slot + 1) + '</div>' +
        '<div class="sd-sub">Survived ' + fmtPrecise(roundInfo.time) + ' \u00b7 Score ' + roundInfo.score + '</div>' +
        '<div class="sd-tally">' + tally + '</div>' + hint + '</div>';
    }
    function renderHud() {
      var h = '', i;
      if (state === 'waiting') {
        var pl = presentIdents();
        for (i = 0; i < pl.length; i++) h += pill(pl[i], null, true);
      } else {
        for (i = 0; i < birds.length; i++) h += pill(birds[i].idn, birds[i].score, birds[i].alive);
        var spec = [];
        for (i = 0; i < present.length; i++) if (!birdById(present[i].id)) spec.push(idents[present[i].id].label);
        if (spec.length) h += '<div class="sd-spec">Next round: ' + spec.join(' ') + '</div>';
      }
      if (h !== lastPills) { pillsEl.innerHTML = h; lastPills = h; }

      var t = (state === 'play' || state === 'over') ? fmtClock(tPlay) : '';
      if (t !== lastTime) { timeEl.textContent = t; timeEl.style.display = t ? '' : 'none'; lastTime = t; }

      var ph = state === 'waiting' ? waitingHtml() : (state === 'over' ? overHtml() : '');
      if (ph !== lastPanel) { panelEl.innerHTML = ph; lastPanel = ph; }
    }

    /* ======================================================================
     * PER-FRAME VISUALS
     * ==================================================================== */
    function updateBirds(dt) {
      var i, hover = (state === 'waiting' || state === 'countdown');
      for (i = 0; i < rigs.length; i++) rigs[i].holder.visible = false;
      for (i = 0; i < birds.length; i++) {
        var b = birds[i], r = b.rig;
        if (b.lane === null) b.lane = b.laneT;
        b.lane += (b.laneT - b.lane) * (1 - Math.exp(-6 * dt));

        var op = 1;
        if (!b.alive) {
          b.fadeT += dt;
          op = b.fadeT < FADE_DELAY ? 1 : Math.max(0, 1 - (b.fadeT - FADE_DELAY) / FADE_TIME);
        }
        if (op <= 0.001) continue;
        r.holder.visible = true;
        r.setOpacity(op);

        var floating = hover || (state === 'over' && b.alive);
        var y = b.y;
        if (floating) { b.hoverPh += dt * 2.3; y += Math.sin(b.hoverPh) * (hover ? 0.28 : 0.18); }
        r.holder.position.set(b.x, y, b.lane);

        if (!b.alive) { b.rotZ += b.spinZ * dt; b.rotX += b.spinX * dt; }
        else if (state === 'play') { b.rotZ += (clamp(b.vy * 0.07, -1.0, 0.5) - b.rotZ) * (1 - Math.exp(-12 * dt)); }
        else { b.rotZ += (0 - b.rotZ) * (1 - Math.exp(-6 * dt)); }
        if (state === 'over' && b.alive) b.rotY += dt * 2.6;
        r.body.rotation.set(b.rotX, b.rotY, b.rotZ);

        b.flapE *= Math.exp(-5 * dt);
        b.wingPh += dt * (9 + 38 * b.flapE);
        var a = b.alive ? 0.15 + (0.3 + 0.75 * b.flapE) * Math.sin(b.wingPh) : 0.7;
        r.wingR.rotation.x = -a;
        r.wingL.rotation.x = a;
        var sq = b.alive ? b.flapE : 0;              // cartoon squash & stretch on every flap
        r.body.scale.set(1 - 0.05 * sq, 1 + 0.09 * sq, 1 - 0.05 * sq);
        var gs = 3.2 + b.flapE * 0.9;
        r.glow.scale.set(gs, gs, 1);

        if (b.alive && state === 'play') {          // soft colour trail, drifts back with the world
          b.trailT -= dt;
          if (b.trailT <= 0) {
            b.trailT = 0.035;
            emit(b.x - 0.55, y, b.lane + rand(-0.15, 0.15), -speedNow + rand(-1, 1), rand(-0.6, 0.6), rand(-0.4, 0.4),
              r.col.r, r.col.g, r.col.b, 0.5, 0, rand(0.28, 0.4), 2, 0);
          }
        }
        if (state === 'over' && b.alive && Math.random() < dt * 14) {
          burst(b.x, y, b.lane, r.col, 2, 4, 0.9, 2, true);
        }
      }
    }

    var camX = -8, camY = 2.4, camZ = 20, lookX = 5.5, lookY = -0.3, lookZ = 0, avgY = 0, baseFov = 48;
    function updateCamera(dt) {
      var sum = 0, c = 0, i;
      for (i = 0; i < birds.length; i++) if (birds[i].alive) { sum += birds[i].y; c++; }
      if (!c) for (i = 0; i < birds.length; i++) { sum += birds[i].y; c++; }
      avgY += ((c ? sum / c : 0) - avgY) * (1 - Math.exp(-3 * dt));

      var px = -8, py = 2.4 + avgY * 0.35, pz = 20, lx = 5.5, ly = avgY * 0.55 - 0.3, lz = 0;
      if (state === 'over' && winnerBird && winnerBird.alive) {      // push in on the winner
        px = -4.5; py = 1.6 + winnerBird.y * 0.3; pz = 14;
        lx = 0.8; ly = winnerBird.y * 0.8; lz = winnerBird.lane * 0.9;
      }
      var k = 1 - Math.exp(-2.2 * dt);
      camX += (px - camX) * k; camY += (py - camY) * k; camZ += (pz - camZ) * k;
      lookX += (lx - lookX) * k; lookY += (ly - lookY) * k; lookZ += (lz - lookZ) * k;

      var s = trauma * trauma, tt = time * 30;
      var sx = (Math.sin(tt * 1.3) + Math.sin(tt * 2.7 + 1.3)) * 0.5 * s * 0.9;
      var sy = (Math.sin(tt * 1.7 + 0.4) + Math.sin(tt * 3.1 + 2.1)) * 0.5 * s * 0.9;
      var roll = Math.sin(tt * 1.9 + 0.7) * s * 0.03;
      trauma = Math.max(0, trauma - dt * 1.5);

      camera.position.set(camX + sx, camY + sy, camZ);
      camera.lookAt(lookX, lookY, lookZ);
      camera.rotateZ(roll);
      camera.fov = baseFov + Math.max(0, speedNow - SPEED0) * 0.6;
      camera.updateProjectionMatrix();

      skyDome.position.copy(camera.position);       // sky always surrounds the camera
      partMat.uniforms.uScale.value = (ch * pr) * 0.5 / Math.tan(camera.fov * Math.PI / 360);
    }

    function updateScenery(dt) {
      // ground stripes scroll exactly with the pipes
      grassTex.offset.x = (dist / 12) % 1;
      laneTex.offset.x = (dist / 8) % 1;
      curbTex.offset.x = (dist / 8) % 1;
      ceilTex.offset.x = (dist / 12) % 1;

      var i, o;
      for (i = 0; i < pipes.length; i++) pipes[i].group.position.x = pipes[i].x;

      for (i = 0; i < deco.length; i++) {
        o = deco[i];
        o.g.position.x = -25 + ((((o.x0 - dist) % DECO_L) + DECO_L) % DECO_L);
      }
      var cdx = (0.6 + speedNow * 0.05) * dt;
      for (i = 0; i < clouds.length; i++) {
        o = clouds[i];
        o.position.x -= cdx;
        if (o.position.x < -70) o.position.x += 320;
      }
      for (i = 0; i < hills.length; i++) {
        o = hills[i];
        o.position.x -= speedNow * 0.1 * dt;
        if (o.position.x < -60) o.position.x += 320;
      }
      for (i = 0; i < islands.length; i++) {
        o = islands[i];
        o.position.x -= speedNow * 0.18 * dt;
        if (o.position.x < -50) o.position.x += 290;
        o.position.y = o.userData.y0 + Math.sin(time * 0.8 + o.userData.ph) * 0.5;
      }
    }

    /* ======================================================================
     * SIZING + MAIN LOOP
     * ==================================================================== */
    var pr = Math.min(window.devicePixelRatio || 1, 1.5);
    var cw = 0, ch = 0;
    function resize(force) {
      var w = Math.max(2, container.clientWidth || root.clientWidth || 1280);
      var h = Math.max(2, container.clientHeight || root.clientHeight || 720);
      if (!force && w === cw && h === ch) return;
      cw = w; ch = h;
      renderer.setPixelRatio(pr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      baseFov = 48 + Math.max(0, 1.7 - camera.aspect) * 22;      // keep the playfield in view on narrow windows
      camera.updateProjectionMatrix();
      root.style.fontSize = Math.max(8, Math.min(w / 68, h / 38)).toFixed(2) + 'px';
    }
    var ro = null;
    var onResize = function () { resize(false); };
    window.addEventListener('resize', onResize);
    if (window.ResizeObserver) { ro = new ResizeObserver(onResize); ro.observe(container); }

    var gestEvents = ['pointerdown', 'keydown', 'click', 'touchstart'];
    var onGesture = function () { sfx.resume(); };
    gestEvents.forEach(function (e) { document.addEventListener(e, onGesture, true); });

    function update(dt) {
      time += dt;
      stateT += dt;
      pollInput();

      if (state === 'countdown') {
        cdT += dt;
        var n = 3 - Math.floor(cdT);
        if (n >= 1 && n !== cdShown) {
          cdShown = n;
          bigEl.innerHTML = '<div class="sd-big">' + n + '</div>';
          sfx.tick();
        }
        if (cdT >= 3) startPlay();
      } else if (state === 'over') {
        overT += dt;
      }
      if (goT > 0) { goT -= dt; if (goT <= 0) bigEl.innerHTML = ''; }

      acc += dt;
      var steps = 0;
      while (acc >= STEP && steps < 10) { simStep(STEP); acc -= STEP; steps++; }
      if (acc > STEP) acc = 0;                    // spiral-of-death guard

      updateBirds(dt);
      updateParticles(dt);
      updatePopups(dt);
      updateScenery(dt);
      updateCamera(dt);
      renderHud();
    }

    var raf = 0, lastTs = 0, frames = 0, emaDt = 1 / 60;
    function frame(ts) {
      if (stopped) return;
      raf = requestAnimationFrame(frame);
      var now = (ts || performance.now()) / 1000;
      var raw = lastTs ? now - lastTs : 1 / 60;
      lastTs = now;
      if (raw <= 0) return;
      update(Math.min(raw, 0.05));
      renderer.render(scene, camera);

      // Adaptive quality: if the device cannot hold ~60 fps, lower the render resolution a notch.
      frames++;
      emaDt += (Math.min(raw, 0.1) - emaDt) * 0.05;
      if (frames > 150 && frames % 90 === 0 && emaDt > 0.0215 && pr > 0.8) {
        pr = Math.max(0.75, pr - 0.25);
        resize(true);
      }
    }

    /* ======================================================================
     * BOOT + TEARDOWN
     * ==================================================================== */
    resize(true);
    camera.position.set(camX, camY, camZ);
    camera.lookAt(lookX, lookY, lookZ);
    applyPlayers(ctx.players || []);
    toWaiting();
    raf = requestAnimationFrame(frame);

    function stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      clearTimeout(confTimer);
      window.removeEventListener('resize', onResize);
      gestEvents.forEach(function (e) { document.removeEventListener(e, onGesture, true); });
      if (ro) ro.disconnect();
      sfx.close();
      scene.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        var m = o.material;
        if (m) (Array.isArray(m) ? m : [m]).forEach(function (mm) { if (mm.map) mm.map.dispose(); mm.dispose(); });
      });
      atlas.dispose();
      glowTex.dispose(); sunTex.dispose();
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch (e) { /* ignore */ }
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    return { stop: stop, onPlayers: applyPlayers, onButton: onButton };
  }

  /* ======================================================================
   * PUBLIC API
   * ==================================================================== */
  var inst = null;
  window.NovaGames.flappy = {
    start: function (ctx) {
      if (inst) { inst.stop(); inst = null; }
      inst = createGame(ctx);
    },
    stop: function () {
      if (inst) { inst.stop(); inst = null; }
    },
    onPlayers: function (players) {
      if (inst) inst.onPlayers(players);
    },
    onButton: function (slot, key) {
      if (inst) inst.onButton(slot, key);
    }
  };
})();
