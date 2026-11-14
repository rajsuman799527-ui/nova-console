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
  var GRID = 3;                                // floor grid cell size
  var FLAP_KEYS = { cr: 1, ci: 1, sq: 1, tri: 1 };
  var MAX_PLAYERS = 5;

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
  var CSS = [
    '.sd-root{position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden;background:#000;color:#fff;',
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
    'font-variant-numeric:tabular-nums;font-feature-settings:"tnum";user-select:none;-webkit-user-select:none}',
    '.sd-vig{position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;',
    'background:radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 58%,rgba(0,0,0,.6) 100%)}',
    '.sd-top{position:absolute;top:0;left:0;right:0;padding:1.1em 1.5em;display:flex;justify-content:space-between;',
    'align-items:flex-start;gap:1em;pointer-events:none}',
    '.sd-pills{display:flex;flex-wrap:wrap;gap:.55em;align-items:center}',
    '.sd-pill,.sd-time,.sd-chip{display:inline-flex;align-items:center;gap:.55em;padding:.5em .95em;border-radius:999px;',
    'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);',
    'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);font-weight:700;font-size:1.05em;',
    'box-shadow:0 0 1.6em -.6em var(--c,rgba(255,255,255,.3));transition:opacity .35s}',
    '.sd-pill i,.sd-chip i{width:.8em;height:.8em;border-radius:50%;background:var(--c);box-shadow:0 0 .9em var(--c)}',
    '.sd-pill b{min-width:1.5em;text-align:right;font-weight:800}',
    '.sd-pill.dead{opacity:.32}',
    '.sd-spec{font-size:.85em;opacity:.6;padding:.5em .4em}',
    '.sd-time{font-size:1.15em;letter-spacing:.06em}',
    '.sd-center{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;pointer-events:none}',
    '.sd-big{font-size:11em;font-weight:800;line-height:1;letter-spacing:-.04em;',
    'text-shadow:0 0 .3em rgba(170,200,255,.75),0 0 1.1em rgba(120,140,255,.55);',
    'animation:sd-pop .95s cubic-bezier(.2,.8,.2,1) both}',
    '.sd-big.go{color:#9dffd8;text-shadow:0 0 .3em rgba(0,224,164,.9),0 0 1.1em rgba(0,224,164,.55)}',
    '@keyframes sd-pop{0%{transform:scale(1.8);opacity:0}20%{transform:scale(1);opacity:1}70%{opacity:1}100%{transform:scale(.82);opacity:0}}',
    '.sd-panel{padding:2em 3.2em;border-radius:1.5em;text-align:center;min-width:22em;max-width:90%;',
    'background:rgba(10,10,16,.58);border:1px solid rgba(255,255,255,.17);',
    'backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);',
    'box-shadow:0 0 6em -1.5em var(--c,#8b6cff),inset 0 1px rgba(255,255,255,.14);',
    'animation:sd-in .55s .05s cubic-bezier(.2,.8,.2,1) both}',
    '.sd-panel.late{animation-delay:.75s}',
    '.sd-panel.nofx{animation:none}',
    '@keyframes sd-in{from{opacity:0;transform:scale(.93) translateY(3%)}to{opacity:1;transform:none}}',
    '.sd-kicker{font-size:.9em;letter-spacing:.32em;opacity:.65;font-weight:700}',
    '.sd-title{font-size:3.4em;font-weight:800;letter-spacing:-.03em;margin:.15em 0 .1em;',
    'text-shadow:0 0 .6em rgba(139,108,255,.55)}',
    '.sd-name{font-size:4.2em;font-weight:800;letter-spacing:-.02em;line-height:1.05;margin:.1em 0;',
    'text-shadow:0 0 .55em currentColor}',
    '.sd-score{font-size:6em;font-weight:800;line-height:1;margin:.05em 0}',
    '.sd-sub{font-size:1.15em;opacity:.75;margin-top:.35em}',
    '.sd-chips,.sd-tally{display:flex;flex-wrap:wrap;justify-content:center;gap:.55em;margin-top:1.1em}',
    '.sd-dim{opacity:.5}',
    '.sd-cta{margin-top:1.4em;font-size:1.15em;opacity:.92}',
    '.sd-cta b{font-weight:800}',
    '.sd-key{display:inline-block;min-width:1.7em;padding:.05em .45em;border-radius:.4em;',
    'background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);font-weight:800}',
    '.sd-conf{position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden;pointer-events:none}',
    '.sd-conf span{position:absolute;top:-4%;width:.55em;height:.95em;border-radius:.12em;opacity:.95;',
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
        'text-align:center;color:#fff;font:600 22px system-ui,sans-serif">Sky Dash 3D could not start<br>' +
        '<span style="opacity:.6;font-size:16px;font-weight:500">' + why + '</span></div>';
      return {
        stop: function () { if (root.parentNode) root.parentNode.removeChild(root); },
        onPlayers: function () {}, onButton: function () {}
      };
    }

    var cv = renderer.domElement;
    cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;background:#000;border:0;border-radius:0';
    root.appendChild(cv);
    renderer.setClearColor(0x000000, 1);

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
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.Fog(0x000000, 38, 115);

    var camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.1, 300);
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    var sun = new THREE.DirectionalLight(0xffffff, 0.85);
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
    var dotTex = radialTex(64, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,.8)'], [1, 'rgba(255,255,255,0)']]);

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
      g.fillStyle = 'rgba(0,0,0,.6)'; g.fill();
      g.lineWidth = 6; g.strokeStyle = color; g.stroke();
      g.textBaseline = 'middle'; g.textAlign = 'center';
      if (score === null) {
        g.fillStyle = '#fff';
        g.font = '800 58px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
        g.fillText(label, 128, 66);
      } else {
        g.fillStyle = color;
        g.font = '800 40px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
        g.fillText(label, 78, 66);
        g.fillStyle = '#fff';
        g.font = '800 58px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
        g.fillText(String(score), 178, 66);
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
      beak: new THREE.ConeGeometry(0.17, 0.42, 6),
      tail: new THREE.ConeGeometry(0.22, 0.4, 4),
      eye: new THREE.SphereGeometry(0.13, 8, 6),
      pupil: new THREE.SphereGeometry(0.065, 6, 5),
      wingR: new THREE.BoxGeometry(0.55, 0.07, 0.65),
      wingL: new THREE.BoxGeometry(0.55, 0.07, 0.65)
    };
    GEO.wingR.translate(0, 0, 0.325);     // pivot on the inner edge
    GEO.wingL.translate(0, 0, -0.325);
    GEO.boxEdges = new THREE.EdgesGeometry(GEO.box);

    /* ---------- stars (twinkling, slow parallax drift) ---------- */
    var STAR_N = 480, STAR_X0 = -100, STAR_W = 260;
    var starPos = new Float32Array(STAR_N * 3), starCol = new Float32Array(STAR_N * 3);
    var starBase = new Float32Array(STAR_N * 3), starPh = new Float32Array(STAR_N), starTw = new Float32Array(STAR_N);
    (function () {
      for (var i = 0; i < STAR_N; i++) {
        starPos[i * 3] = rand(STAR_X0, STAR_X0 + STAR_W);
        starPos[i * 3 + 1] = rand(-3, 80);
        starPos[i * 3 + 2] = rand(-170, -30);
        var b = rand(0.35, 1), k = Math.random();
        starBase[i * 3] = b * (k < 0.3 ? 0.75 : 1);
        starBase[i * 3 + 1] = b * (k < 0.3 ? 0.85 : 0.95);
        starBase[i * 3 + 2] = b * (k > 0.7 ? 0.8 : 1);
        starPh[i] = rand(0, 6.28);
        starTw[i] = rand(0.6, 2.2);
      }
    })();
    var starGeo = new THREE.BufferGeometry();
    var starPosAttr = new THREE.BufferAttribute(starPos, 3);
    var starColAttr = new THREE.BufferAttribute(starCol, 3);
    starPosAttr.setUsage(THREE.DynamicDrawUsage);
    starColAttr.setUsage(THREE.DynamicDrawUsage);
    starGeo.setAttribute('position', starPosAttr);
    starGeo.setAttribute('color', starColAttr);
    var stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      size: 0.4, map: dotTex, vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false
    }));
    stars.frustumCulled = false;
    scene.add(stars);

    /* ---------- floor / ceiling grids and lane rails ---------- */
    var gridMatFloor = new THREE.LineBasicMaterial({ color: 0x4a2fd0, transparent: true, opacity: 0.6 });
    var gridMatCeil = new THREE.LineBasicMaterial({ color: 0x4a2fd0, transparent: true, opacity: 0.16 });
    var railMat = new THREE.LineBasicMaterial({ color: 0x7a5cff, transparent: true, opacity: 0.95 });

    (function buildGround() {
      var floorPlane = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshBasicMaterial({ color: 0x000000 }));
      floorPlane.rotation.x = -Math.PI / 2;
      floorPlane.position.set(60, FLOOR_Y - 0.02, 0);
      scene.add(floorPlane);

      var v = [], x, z;
      for (x = -48; x <= 144; x += GRID) v.push(x, 0, -45, x, 0, 45);
      for (z = -45; z <= 45; z += GRID) v.push(-48, 0, z, 144, 0, z);
      var gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
      var floorGrid = new THREE.LineSegments(gg, gridMatFloor);
      floorGrid.position.y = FLOOR_Y;
      var ceilGrid = new THREE.LineSegments(gg, gridMatCeil);
      ceilGrid.position.y = CEIL_Y;
      scene.add(floorGrid); scene.add(ceilGrid);
      floorGrid.frustumCulled = false; ceilGrid.frustumCulled = false;
      scene.userData.floorGrid = floorGrid;
      scene.userData.ceilGrid = ceilGrid;

      // bright rails marking the edges of the flight lanes
      var hz = PIPE_DEPTH / 2, r = [];
      [FLOOR_Y + 0.03, CEIL_Y - 0.03].forEach(function (y) {
        r.push(-48, y, hz, 144, y, hz, -48, y, -hz, 144, y, -hz);
      });
      var rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(r), 3));
      var rails = new THREE.LineSegments(rg, railMat);
      rails.frustumCulled = false;
      scene.add(rails);
    })();

    /* ---------- distant neon pylons (parallax skyline) ---------- */
    var pylons = [];
    (function buildPylons() {
      var mats = [0.55, 0.78, 0.93].map(function (h) {
        var m = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.34 });
        m.color.setHSL(h, 0.9, 0.55);
        return m;
      });
      for (var i = 0; i < 18; i++) {
        var w = rand(1.5, 3.2), h = rand(6, 28), d = rand(1.5, 3.2);
        var m = new THREE.LineSegments(GEO.boxEdges, mats[i % 3]);
        m.scale.set(w, h, d);
        m.position.set(rand(-60, 150), FLOOR_Y + h / 2, rand(-78, -36));
        m.frustumCulled = false;
        scene.add(m);
        pylons.push(m);
      }
    })();

    /* ---------- pipes / towers ---------- */
    function makeSlab(bodyMat, lineMat) {
      var g = new THREE.Group();
      g.add(new THREE.Mesh(GEO.box, bodyMat));
      g.add(new THREE.LineSegments(GEO.boxEdges, lineMat));
      return g;
    }
    function setSlab(g, y0, y1, w, d) {
      g.position.set(0, (y0 + y1) / 2, 0);
      g.scale.set(w, Math.max(0.01, y1 - y0), d);
    }
    function makePipe() {
      var bodyMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide
      });
      var capMat = bodyMat.clone();
      capMat.opacity = 0.3;
      var lineMat = new THREE.LineBasicMaterial({ color: 0xffffff });
      var group = new THREE.Group();
      var p = {
        x: 0, gapY: 0, gap: 5, idx: 0, passed: false, group: group,
        topBody: makeSlab(bodyMat, lineMat), topCap: makeSlab(capMat, lineMat),
        botBody: makeSlab(bodyMat, lineMat), botCap: makeSlab(capMat, lineMat),
        bodyMat: bodyMat, capMat: capMat, lineMat: lineMat
      };
      group.add(p.topBody); group.add(p.topCap); group.add(p.botBody); group.add(p.botCap);
      group.visible = false;
      scene.add(group);
      return p;
    }
    function layoutPipe(p) {
      var gTop = p.gapY + p.gap / 2, gBot = p.gapY - p.gap / 2;
      var cw = PIPE_W + 2 * CAP_PAD, cd = PIPE_DEPTH + 2 * CAP_PAD;
      setSlab(p.topBody, gTop + CAP_H, CEIL_Y, PIPE_W, PIPE_DEPTH);
      setSlab(p.topCap, gTop, gTop + CAP_H, cw, cd);
      setSlab(p.botBody, FLOOR_Y, gBot - CAP_H, PIPE_W, PIPE_DEPTH);
      setSlab(p.botCap, gBot - CAP_H, gBot, cw, cd);
      var h = (0.52 + p.idx * 0.03) % 1;
      p.bodyMat.color.setHSL(h, 1, 0.5);
      p.capMat.color.setHSL(h, 1, 0.55);
      p.lineMat.color.setHSL(h, 0.95, 0.62);
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
      function mat(opts) {
        var m = new THREE.MeshPhongMaterial(Object.assign({ transparent: true, flatShading: true, shininess: 40 }, opts));
        mats.push(m);
        return m;
      }
      var bodyMat = mat({ color: col, emissive: col.clone().multiplyScalar(0.35) });
      var torso = new THREE.Mesh(GEO.bird, bodyMat);
      torso.scale.set(1.15, 0.95, 0.95);
      body.add(torso);

      var beak = new THREE.Mesh(GEO.beak, mat({ color: 0xffc24a, emissive: 0x553300 }));
      beak.rotation.z = -Math.PI / 2;
      beak.position.set(0.62, -0.02, 0);
      body.add(beak);

      var tail = new THREE.Mesh(GEO.tail, bodyMat);
      tail.rotation.z = Math.PI / 2;
      tail.position.set(-0.64, 0.05, 0);
      body.add(tail);

      var eyeMat = mat({ color: 0xffffff, emissive: 0x333333 });
      var pupMat = mat({ color: 0x111111, emissive: 0x000000 });
      [-1, 1].forEach(function (s) {
        var e = new THREE.Mesh(GEO.eye, eyeMat);
        e.position.set(0.3, 0.2, 0.34 * s);
        body.add(e);
        var pu = new THREE.Mesh(GEO.pupil, pupMat);
        pu.position.set(0.39, 0.21, 0.42 * s);
        body.add(pu);
      });

      var wingMat = mat({ color: col.clone().lerp(new THREE.Color(0xffffff), 0.25), emissive: col.clone().multiplyScalar(0.3) });
      var wingR = new THREE.Group(), wingL = new THREE.Group();
      wingR.position.set(-0.05, 0.02, 0.4);
      wingL.position.set(-0.05, 0.02, -0.4);
      wingR.add(new THREE.Mesh(GEO.wingR, wingMat));
      wingL.add(new THREE.Mesh(GEO.wingL, wingMat));
      body.add(wingR); body.add(wingL);

      var glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: col, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending,
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
          glow.material.opacity = 0.6 * o;
          tag.material.opacity = o;
        }
      };
    }
    var rigs = [];
    for (var ri = 0; ri < MAX_PLAYERS; ri++) rigs.push(makeRig(COLORS[ri % COLORS.length], 'P' + (ri + 1)));

    /* ---------- particles (one additive Points pool) ---------- */
    var MAXP = 800, pHead = 0, pAny = false;
    var pPos = new Float32Array(MAXP * 3), pCol = new Float32Array(MAXP * 3), pBase = new Float32Array(MAXP * 3);
    var pVel = new Float32Array(MAXP * 3), pLife = new Float32Array(MAXP), pMax = new Float32Array(MAXP), pGrav = new Float32Array(MAXP);
    for (var qi = 0; qi < MAXP; qi++) pPos[qi * 3 + 1] = -100;
    var pGeo = new THREE.BufferGeometry();
    var pPosAttr = new THREE.BufferAttribute(pPos, 3), pColAttr = new THREE.BufferAttribute(pCol, 3);
    pPosAttr.setUsage(THREE.DynamicDrawUsage);
    pColAttr.setUsage(THREE.DynamicDrawUsage);
    pGeo.setAttribute('position', pPosAttr);
    pGeo.setAttribute('color', pColAttr);
    var pPoints = new THREE.Points(pGeo, new THREE.PointsMaterial({
      size: 0.38, map: dotTex, vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false
    }));
    pPoints.frustumCulled = false;
    scene.add(pPoints);

    function emit(x, y, z, vx, vy, vz, r, g, b, life, grav) {
      var i = pHead, j = i * 3;
      pHead = (pHead + 1) % MAXP;
      pPos[j] = x; pPos[j + 1] = y; pPos[j + 2] = z;
      pVel[j] = vx; pVel[j + 1] = vy; pVel[j + 2] = vz;
      pBase[j] = r; pBase[j + 1] = g; pBase[j + 2] = b;
      pCol[j] = r; pCol[j + 1] = g; pCol[j + 2] = b;
      pLife[i] = pMax[i] = life;
      pGrav[i] = grav || 0;
      pAny = true;
    }
    function burst(x, y, z, col, n, speed, life, grav, whiten) {
      for (var i = 0; i < n; i++) {
        var th = rand(0, 6.283), ph = Math.acos(rand(-1, 1)), v = rand(0.25, 1) * speed;
        var w = whiten && Math.random() < 0.4 ? 1 : 0;
        emit(x, y, z,
          Math.sin(ph) * Math.cos(th) * v, Math.sin(ph) * Math.sin(th) * v, Math.cos(ph) * v,
          w ? 1 : col.r, w ? 1 : col.g, w ? 1 : col.b, life * rand(0.6, 1), grav);
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
          pCol[j] = pCol[j + 1] = pCol[j + 2] = 0;
          pPos[j + 1] = -100;
          continue;
        }
        alive++;
        pVel[j + 1] -= pGrav[i] * dt;
        pPos[j] += pVel[j] * dt; pPos[j + 1] += pVel[j + 1] * dt; pPos[j + 2] += pVel[j + 2] * dt;
        var f = pLife[i] / pMax[i];
        pCol[j] = pBase[j] * f; pCol[j + 1] = pBase[j + 1] * f; pCol[j + 2] = pBase[j + 2] * f;
      }
      pPosAttr.needsUpdate = true;
      pColAttr.needsUpdate = true;
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
        var w = Math.random() < 0.35;
        emit(b.x - 0.3, b.y - 0.2, b.lane + rand(-0.3, 0.3), -speedNow * 0.6 + rand(-2, 0), rand(-5, -1.5), rand(-1, 1),
          w ? 1 : c.r, w ? 1 : c.g, w ? 1 : c.b, 0.5, 2);
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
      burst(b.x, b.y, b.lane, b.rig.col, reason === 'left' ? 14 : 34, 8, 0.9, 6, true);
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
      var cols = [color, '#ffffff', color, COLORS[Math.floor(rand(0, COLORS.length))], '#ffffff'];
      for (var i = 0; i < 90; i++) {
        var s = document.createElement('span');
        s.style.left = rand(0, 100) + '%';
        s.style.background = cols[i % cols.length];
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
        '<div class="sd-kicker">NOVA CONSOLE</div><div class="sd-title">Sky Dash 3D</div>' +
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
          '<div class="sd-sub">' + (roundInfo.newBest ? 'New best!' : 'Best ' + bestSolo) + '</div>' + hint + '</div>';
      }
      w = roundInfo.winner;
      if (!w) return '';
      var tally = presentIdents().map(function (i) {
        return '<span class="sd-chip" style="--c:' + i.color + '"><i></i>' + i.label + ' <b>' + i.wins + '</b></span>';
      }).join('');
      return '<div class="' + cls + '" style="--c:' + w.idn.color + '"><div class="sd-kicker">WINNER</div>' +
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
        var gs = 3.2 + b.flapE * 0.9;
        r.glow.scale.set(gs, gs, 1);

        if (b.alive && state === 'play') {          // light trail, drifts back with the world
          b.trailT -= dt;
          if (b.trailT <= 0) {
            b.trailT = 0.035;
            emit(b.x - 0.55, y, b.lane + rand(-0.15, 0.15), -speedNow + rand(-1, 1), rand(-0.6, 0.6), rand(-0.4, 0.4),
              r.col.r, r.col.g, r.col.b, 0.5, 0);
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
    }

    function updateScenery(dt) {
      var off = dist % GRID;
      var fg = scene.userData.floorGrid, cg = scene.userData.ceilGrid;
      fg.position.x = -off; cg.position.x = -off;
      var h = (0.72 + dist * 0.0012) % 1;
      gridMatFloor.color.setHSL(h, 0.8, 0.42);
      gridMatCeil.color.setHSL(h, 0.8, 0.42);
      railMat.color.setHSL(h, 0.9, 0.6);

      var i, p;
      for (i = 0; i < pipes.length; i++) pipes[i].group.position.x = pipes[i].x;

      for (i = 0; i < pylons.length; i++) {
        p = pylons[i];
        p.position.x -= speedNow * 0.3 * dt;
        if (p.position.x < -60) p.position.x += 210;
      }
      var drift = speedNow * 0.03 * dt;
      for (i = 0; i < STAR_N; i++) {
        var j = i * 3;
        starPos[j] -= drift;
        if (starPos[j] < STAR_X0) starPos[j] += STAR_W;
        var tw = 0.65 + 0.35 * Math.sin(time * starTw[i] + starPh[i]);
        starCol[j] = starBase[j] * tw; starCol[j + 1] = starBase[j + 1] * tw; starCol[j + 2] = starBase[j + 2] * tw;
      }
      starPosAttr.needsUpdate = true;
      starColAttr.needsUpdate = true;
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
