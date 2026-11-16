/* ===========================================================================
 * Smash Court  -  NOVA Console game  (id: 'badminton')                (file 4 of 4)
 * ---------------------------------------------------------------------------
 * 1 to 4 humans on ONE screen (+ extra phones spectate), AI fills empty seats.
 * Runs only on the screen page. Needs Three.js r128 and, loaded before this file:
 *   games/badminton-core.js   (rules, physics, AI; no Three.js)
 *   games/badminton-chars.js  (characters, shuttle, effects, optional GLB)
 *   games/badminton-world.js  (venues, court, net, crowd)
 *
 * Contract (same as the other games):
 *   window.NovaGames.badminton = { start(ctx), stop(), onPlayers(list), onButton(slot,key), onInput(slot,msg) }
 *
 * Phone -> screen  (onInput, msg.t === 'g', msg.id = phone id):
 *   {a:'mv', x:-1..1, y:-1..1}                 stick, y is DOWN = towards the camera   (<= every 30 ms + on release + heartbeat)
 *   {a:'shot', k:'smash'|'clear'|'drop'|'drive'|'super', n:seq, x, y}   discrete, aim = stick at the moment of the press
 *   {a:'dive'}
 *   {a:'setup', mode:'solo'|'1v1'|'2v2', diff:0..2, ven:0..2, pts:7|11|21, bo:1|3, lad:0..4}      Player 1 only, setup phase
 *   {a:'char', c:0..5}  {a:'assist', on:0|1}  {a:'team', pid?, tm:0|1}  {a:'ready'}           any player (team: P1 may pass pid)
 *   {a:'start'} {a:'again'} {a:'tosetup'} {a:'pause'}                                         Player 1 only
 * Screen -> phones (ctx.send('gstate', ...)), g:'badminton'. Re-sent every 700 ms in EVERY phase, 10 Hz while playing:
 *   ph: setup | intro | serve | rally | point | gameover | results | paused
 *   mode,diff,ven,pts,bo,lad, vn[] venue names, cn[] character names, on[] ladder opponents, rd[] ready ids,
 *   pl:[{id,n,c,t,ai}] seats, sc:[s0,s1], gm:[g0,g1], gn game number, en:{id:0..1}, sv server id, st serving team,
 *   ra rally, pf:{id:n} perfect counters, ht:{id:n} hit counters, as:{id:0|1} assist, tp:{id:team}, mp match point team (-1 none),
 *   msg last point reason, res results, np humans seated, ns spectators
 * ========================================================================= */
(function () {
  'use strict';
  window.NovaGames = window.NovaGames || {};

  var STEP = 1 / 120, STATE_MS = 100, HB_MS = 700;
  var TEAM_HEX = [0x2e8bff, 0xff4a5a], TEAM_CSS = ['#2e8bff', '#ff4a5a'];
  var VEN_NAMES = ['Sunny Street', 'Neon Sunset', 'Palm Beach'];
  var MODES = ['solo', '1v1', '2v2'];
  var FONT = 'ui-rounded,"SF Pro Rounded","Nunito","Varela Round","Arial Rounded MT Bold","Trebuchet MS",system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
  var RATING = {};                                   // phone id -> trophy points, kept for the page session
  var lastCfg = null;                                // setup survives leaving and re-entering the game

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function sgn(v) { return v < 0 ? -1 : 1; }

  /* ----------------------------------------------------------------- CSS */
  var OUT = '.05em .05em 0 var(--ink),-.05em .05em 0 var(--ink),.05em -.05em 0 var(--ink),-.05em -.05em 0 var(--ink),0 .09em 0 var(--ink)';
  var CSS =
    '.bm{position:absolute;inset:0;overflow:hidden;background:#9fd8ff;color:#fff;font-family:' + FONT + ';font-weight:800;--ink:#10286b;user-select:none;-webkit-user-select:none;font-variant-numeric:tabular-nums}' +
    '.bm canvas.gl{position:absolute;left:0;top:0;width:100%;height:100%;display:block;filter:saturate(1.12) contrast(1.04)}' +
    '.bm-vig{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 58%,rgba(10,10,40,.34) 100%)}' +
    '.bm-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}' +
    '.pl{position:absolute;top:1.1em;width:37%;pointer-events:none}.pl.l{left:0}.pl.r{right:0}' +
    '.pl .top{display:flex;align-items:center;gap:.5em;height:2.3em;padding:0 1em;color:#fff;font-size:1.05em;text-shadow:0 .08em .12em rgba(0,0,0,.4)}.pl.r .top{flex-direction:row-reverse}' +
    '.pl .top svg{width:1.7em;height:1.7em;flex:none}.pl .top b{font-size:1.2em}.pl.l .top{background:linear-gradient(90deg,rgba(40,140,255,.55),rgba(40,140,255,0))}.pl.r .top{background:linear-gradient(270deg,rgba(255,70,80,.55),rgba(255,70,80,0))}' +
    '.pl .main{position:relative;height:4.4em;padding:.55em 1.2em 0}.pl.l .main{background:linear-gradient(90deg,#1b9cff,#0b66e0 70%,#2bb8ff);clip-path:polygon(0 0,100% 0,91% 100%,0 100%)}' +
    '.pl.r .main{background:linear-gradient(270deg,#ff4a58,#d3222f 70%,#ff6a5a);clip-path:polygon(9% 0,100% 0,100% 100%,0 100%);text-align:right}' +
    '.pl .nm{display:block;font-size:1.55em;line-height:1.1;text-shadow:' + OUT + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:62%}.pl.r .nm{margin-left:auto}' +
    '.pl .eb{position:absolute;left:.5em;right:2.4em;bottom:.35em;height:1.15em;display:flex;align-items:center}.pl.r .eb{left:2.4em;right:.5em;flex-direction:row-reverse}' +
    '.pl .bar{flex:1;height:100%;border-radius:1em;background:#0b1740;border:.16em solid #0a1030;overflow:hidden;box-shadow:inset 0 .12em .2em rgba(0,0,0,.6)}.pl .bar u{display:block;height:100%;width:0;background:linear-gradient(180deg,#5dff4a,#0fbf1c);text-decoration:none;transition:width .12s}' +
    '.pl .bar.full u{animation:bmfull .5s ease-in-out infinite alternate;background:linear-gradient(180deg,#d8ff5a,#4de01c)}@keyframes bmfull{to{filter:brightness(1.6)}}' +
    '.pl .bolt{width:1.8em;height:1.8em;border-radius:50%;background:radial-gradient(circle at 35% 30%,#4a7bff,#12288a);border:.15em solid #0a1030;flex:none;display:grid;place-items:center;margin:0 -.5em;z-index:2}' +
    '.pl .bolt svg{width:.95em;height:.95em}.pl .sc{position:absolute;top:-.05em;font-size:6.2em;line-height:1;color:#fff;text-shadow:' + OUT + ',0 .14em .1em rgba(0,0,0,.35);z-index:3}' +
    '.pl.l .sc{left:55%}.pl.r .sc{right:55%}.pl .sc.pop{animation:bmpop .5s cubic-bezier(.2,1.8,.4,1)}@keyframes bmpop{0%{transform:scale(1.8)}100%{transform:scale(1)}}' +
    '.pl .srv{position:absolute;top:-.15em;padding:.1em .55em;border-radius:1em;background:#ffd21f;color:#3a2a00;font-size:.9em;display:none;text-shadow:none;box-shadow:0 .15em 0 rgba(0,0,0,.25)}.pl.l .srv{left:7.2em}.pl.r .srv{right:7.2em}.pl.sv .srv{display:block}' +
    '.pl .gp{position:absolute;top:4.7em;display:flex;gap:.3em}.pl.l .gp{left:1.4em}.pl.r .gp{right:1.4em}.pl .gp i{width:1em;height:1em;border-radius:50%;background:rgba(255,255,255,.35);border:.12em solid #fff}.pl .gp i.on{background:#ffd21f}' +
    '.bm-mid{position:absolute;left:0;right:0;bottom:2.2em;text-align:center;pointer-events:none}.bm-rally{display:inline-block;padding:.3em 1.2em;border-radius:2em;background:rgba(10,20,80,.55);border:.12em solid rgba(255,255,255,.7);font-size:1.5em;opacity:0;transition:opacity .2s}.bm-rally.on{opacity:1}' +
    '.bm-rules{position:absolute;left:1.2em;bottom:1em;font-size:.95em;opacity:.85;text-shadow:0 .08em .12em rgba(0,0,0,.6);pointer-events:none}' +
    '.bm-watch{position:absolute;left:50%;top:1.2em;transform:translateX(-50%);font-size:.95em;padding:.2em .9em;border-radius:2em;background:rgba(10,20,80,.5);pointer-events:none;display:none}' +
    '.bm-pop{position:absolute;left:0;right:0;top:27%;text-align:center;font-size:5.4em;font-style:italic;letter-spacing:.02em;text-shadow:' + OUT + ',0 .12em .1em rgba(0,0,0,.4);pointer-events:none;opacity:0}' +
    '.bm-pop.go{animation:bmpp .95s ease-out forwards}@keyframes bmpp{0%{opacity:0;transform:scale(.3) rotate(-6deg)}14%{opacity:1;transform:scale(1.25) rotate(-3deg)}28%{transform:scale(1) rotate(-3deg)}80%{opacity:1}100%{opacity:0;transform:scale(1.05) translateY(-.4em) rotate(-3deg)}}' +
    '.bm-ban{position:absolute;left:0;right:0;top:36%;text-align:center;pointer-events:none;opacity:0}.bm-ban b{display:block;font-size:6.6em;font-style:italic;line-height:1;text-shadow:' + OUT + ',0 .12em .1em rgba(0,0,0,.4)}.bm-ban small{display:block;margin-top:.3em;font-size:1.9em;text-shadow:' + OUT + '}' +
    '.bm-ban.go{animation:bmbn 2s ease-out forwards}@keyframes bmbn{0%{opacity:0;transform:translateY(1em) scale(.6)}10%{opacity:1;transform:none}85%{opacity:1}100%{opacity:0}}' +
    '.bm-mp{position:absolute;left:0;right:0;top:15%;text-align:center;font-size:2.6em;font-style:italic;color:#ffd21f;text-shadow:' + OUT + ';opacity:0;pointer-events:none}.bm-mp.on{opacity:1;animation:bmmp .8s ease-in-out infinite alternate}@keyframes bmmp{to{transform:scale(1.08)}}' +
    '.bm-ov{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}' +
    '.bm-card{min-width:26em;max-width:78%;padding:1.2em 1.8em;border-radius:1.2em;background:linear-gradient(160deg,rgba(18,40,120,.88),rgba(10,20,70,.9));border:.15em solid rgba(255,255,255,.75);box-shadow:0 .6em 2em rgba(0,0,0,.5);text-align:center}' +
    '.bm-card h1{font-size:3.4em;font-style:italic;line-height:1;margin:0;text-shadow:' + OUT + '}.bm-card h2{font-size:1.9em;margin:.3em 0 .1em;font-style:italic;text-shadow:' + OUT + '}.bm-card p{margin:.35em 0;font-size:1.15em;opacity:.92;font-weight:700}' +
    '.bm-card .rl{display:inline-block;margin:.3em;padding:.2em .8em;border-radius:1em;background:rgba(255,255,255,.14);font-size:1em}.bm-card .rl b{color:#ffd21f}' +
    '.bm-card table{width:100%;border-collapse:collapse;margin-top:.6em;font-size:1.05em}.bm-card td,.bm-card th{padding:.28em .5em;border-bottom:1px solid rgba(255,255,255,.18);text-align:center}.bm-card td:first-child,.bm-card th:first-child{text-align:left}.bm-card th{font-size:.8em;opacity:.7;letter-spacing:.12em}.bm-card i.dot{display:inline-block;width:.8em;height:.8em;border-radius:50%;margin-right:.45em}' +
    '.bm-vs{display:flex;align-items:center;justify-content:center;gap:1.2em;margin:.5em 0}.bm-vs div{font-size:1.9em;max-width:7em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bm-vs em{font-size:2.2em;color:#ffd21f}' +
    '.bm-chips span{display:inline-block;margin:.2em;padding:.25em .8em;border-radius:2em;border:.12em solid var(--c);color:var(--c);font-size:1em}.bm-chips .ok{background:var(--c);color:#06143a}' +
    '.bm-sw{position:absolute;inset:0;background:#000;opacity:0;pointer-events:none}';
  var TROPHY = '<svg viewBox="0 0 24 24"><path d="M6 3h12v4a6 6 0 0 1-12 0z" fill="#ffc21f" stroke="#b36b00" stroke-width="1"/><path d="M6 4H3v2a3 3 0 0 0 3 3M18 4h3v2a3 3 0 0 1-3 3" fill="none" stroke="#ffc21f" stroke-width="1.6"/><rect x="10.5" y="12" width="3" height="4" fill="#e89a00"/><rect x="7.5" y="16" width="9" height="3" rx="1" fill="#ffc21f" stroke="#b36b00" stroke-width="1"/><circle cx="12" cy="7" r="2" fill="#fff3b0"/></svg>';
  var BOLT = '<svg viewBox="0 0 24 24"><path d="M13.5 2L5 13.5h5.5L9.5 22 19 9.5h-5.8z" fill="#fff"/></svg>';

  /* ======================================================================
   * SOUND  (WebAudio, everything synthesised)
   * ==================================================================== */
  function makeSfx() {
    var ac = null, master = null, nb = null, crowd = null, wh = null, ok = true, lastStep = 0;
    function init() {
      if (ac || !ok) return;
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)(); master = ac.createGain(); master.gain.value = 0.55; master.connect(ac.destination);
        var buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), d = buf.getChannelData(0), i; for (i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; nb = buf;
        var s1 = ac.createBufferSource(); s1.buffer = buf; s1.loop = true; var lp = ac.createBiquadFilter(); lp.type = 'bandpass'; lp.frequency.value = 700; lp.Q.value = 0.5; var g1 = ac.createGain(); g1.gain.value = 0.03; s1.connect(lp); lp.connect(g1); g1.connect(master); s1.start(); crowd = { g: g1, f: lp };
        var s2 = ac.createBufferSource(); s2.buffer = buf; s2.loop = true; var bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 800; bp.Q.value = 2; var g2 = ac.createGain(); g2.gain.value = 0; s2.connect(bp); bp.connect(g2); g2.connect(master); s2.start(); wh = { g: g2, f: bp };
      } catch (e) { ok = false; }
    }
    function tone(f0, f1, t0, dur, type, vol) {
      if (!ac) return; var o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + t0; o.type = type || 'sine'; o.frequency.setValueAtTime(f0, t); if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.25, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
    }
    function noise(t0, dur, freq, q, vol, type) {
      if (!ac) return; var s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(), t = ac.currentTime + t0; s.buffer = nb; f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); s.connect(f); f.connect(g); g.connect(master); s.start(t, Math.random() * 0.5, dur + 0.02);
    }
    return {
      resume: function () { init(); if (ac) { if (ac.state === 'suspended') ac.resume(); master.gain.setTargetAtTime(0.55, ac.currentTime, 0.05); } },
      silence: function () { if (ac) master.gain.setTargetAtTime(0, ac.currentTime, 0.05); },
      hit: function (shot, q) {
        var v = 0.25 + q * 0.2;
        if (shot === 'smash') { noise(0, 0.1, 3200, 1.2, 0.5, 'highpass'); tone(980, 240, 0, 0.14, 'sawtooth', 0.3); tone(110, 60, 0, 0.18, 'sine', 0.4); }
        else if (shot === 'super') { noise(0, 0.25, 2200, 0.8, 0.6, 'highpass'); tone(1400, 120, 0, 0.3, 'sawtooth', 0.35); tone(90, 40, 0, 0.35, 'sine', 0.5); tone(660, 1320, 0.05, 0.3, 'triangle', 0.2); }
        else if (shot === 'drop' || shot === 'netdrop') { tone(1500, 900, 0, 0.05, 'triangle', 0.18); noise(0, 0.04, 2600, 2, 0.15); }
        else if (shot === 'drive') { tone(760, 380, 0, 0.1, 'square', 0.16); noise(0, 0.07, 2800, 1.5, 0.3); }
        else if (shot === 'lift') { tone(420, 260, 0, 0.1, 'sine', v); noise(0, 0.06, 1800, 1, 0.22); }
        else { tone(560, 300, 0, 0.1, 'sine', v); noise(0, 0.07, 2300, 1.2, 0.28); }
        if (q >= 0.8) tone(1568, 2093, 0.03, 0.18, 'sine', 0.12);
      },
      whoosh: function (v) { if (wh) { wh.g.gain.setTargetAtTime(clamp(v, 0, 1) * 0.1, ac.currentTime, 0.03); wh.f.frequency.setTargetAtTime(500 + v * 2200, ac.currentTime, 0.04); } },
      step: function () { if (!ac) return; var n = performance.now(); if (n - lastStep < 110) return; lastStep = n; noise(0, 0.035, 2600 + Math.random() * 900, 4, 0.07); },
      slide: function () { noise(0, 0.3, 1400, 0.7, 0.22); },
      net: function () { noise(0, 0.12, 500, 0.6, 0.35, 'lowpass'); tone(180, 90, 0, 0.12, 'sine', 0.25); },
      floor: function () { tone(1100, 700, 0, 0.04, 'triangle', 0.12); noise(0, 0.03, 3000, 2, 0.1); },
      cheer: function (amt) { if (!ac) return; noise(0, 0.9 + amt, 1300, 0.6, 0.12 + amt * 0.16); noise(0.05, 1.1 + amt, 2400, 0.8, 0.05 + amt * 0.08); },
      crowd: function (ex) { if (crowd) { crowd.g.gain.setTargetAtTime(0.03 + ex * 0.06, ac.currentTime, 0.2); crowd.f.frequency.setTargetAtTime(700 + ex * 700, ac.currentTime, 0.2); } },
      whistle: function () { tone(2850, 2900, 0, 0.26, 'sine', 0.16); tone(3050, 3000, 0.02, 0.26, 'sine', 0.09); tone(2850, 2850, 0.32, 0.4, 'sine', 0.14); },
      jingle: function (win) { var n = win ? [523, 659, 784, 1047] : [440, 523, 659]; n.forEach(function (f, i) { tone(f, 0, i * 0.09, 0.22, 'triangle', 0.2); }); },
      fanfare: function () { [523, 659, 784, 1047, 784, 1047, 1319].forEach(function (f, i) { tone(f, 0, i * 0.13, 0.28, 'square', 0.13); }); },
      beep: function (go) { tone(go ? 1320 : 660, 0, 0, go ? 0.5 : 0.18, 'sine', 0.3); },
      close: function () { try { if (ac) ac.close(); } catch (e) { /* ignore */ } ac = null; }
    };
  }

  /* ======================================================================
   * GAME
   * ==================================================================== */
  function createGame(ctx) {
    var THREE = window.THREE, SW = window.SmashWorld, Core = window.SmashCore, container = ctx.container, stopped = false, dead = false;
    var COLORS = (ctx.colors && ctx.colors.length) ? ctx.colors : ((window.CFG && window.CFG.COLORS) || ['#8b6cff', '#00e0a4', '#ff5c8a', '#ffb020', '#2ec5ff']);
    var root = document.createElement('div'); root.className = 'bm';
    var styleEl = document.createElement('style'); styleEl.textContent = CSS; root.appendChild(styleEl); container.appendChild(root);
    if (!THREE || !SW || !SW.buildVenue || !Core) {
      root.insertAdjacentHTML('beforeend', '<div style="position:absolute;inset:0;display:grid;place-items:center;color:#10286b;font:800 22px system-ui;text-align:center">Smash Court needs Three.js r128 and games/badminton-core.js, badminton-chars.js, badminton-world.js</div>');
      return { stop: function () { if (root.parentNode) root.parentNode.removeChild(root); }, onPlayers: function () {}, onButton: function () {}, onInput: function () {} };
    }

    /* ------------------------------------------------------------ STATE */
    var players = [];                                    // [{id,slot}] sorted by slot; players[0] = Player 1
    var cfg = lastCfg ? JSON.parse(JSON.stringify(lastCfg)) : { mode: 'solo', diff: 1, ven: 0, pts: 11, bo: 1, lad: 0 };
    var pick = { chr: {}, tp: {}, as: {} };              // per phone id: character, team (2v2), assist (default on)
    var ready = {}, gph = 'setup', prevGph = 'setup';    // setup | match | results | paused
    var sim = null, entries = [], actors = [], byActor = {}, results = null, resT = 0, clock = 0, acc = 0, alpha = 0, stateAcc = 0, stateDirty = true, notice = '', msg = '', noticeT = 0;
    var pf = {}, ht = {}, slow = 0, slowScale = 1, zoomT = 0, shakeT = 0, lastEvAnn = '', matchWon = null, lastScore = [0, 0];
    var sfx = makeSfx(), Q = { pr: 1, shadow: 0, shadowSize: 1024, level: 3 };
    var vname = SW.VENUES.map(function (v) { return v.name; }), cnames = SW.CHARS.map(function (c) { return c.name; }), onames = Core.LADDER.map(function (l) { return l.name; });

    /* ---------------------------------------------------------- THREE.js */
    var renderer = null;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }); } catch (e) { renderer = null; }
    if (!renderer) {
      root.insertAdjacentHTML('beforeend', '<div style="position:absolute;inset:0;display:grid;place-items:center;color:#10286b;font:800 22px system-ui">WebGL is not available in this browser.</div>');
      return { stop: function () { if (root.parentNode) root.parentNode.removeChild(root); }, onPlayers: function () {}, onButton: function () {}, onInput: function () {} };
    }
    renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.setClearColor(0x9fd8ff, 1);
    renderer.domElement.className = 'gl'; root.appendChild(renderer.domElement);
    var scene = new THREE.Scene(), L = SW.lib(THREE), camera = new THREE.PerspectiveCamera(44, 16 / 9, 0.1, 220);
    var camP = new THREE.Vector3(0, 7.4, 12.6), camL = new THREE.Vector3(0, 0.6, -1.6), camTgtP = new THREE.Vector3(), camTgtL = new THREE.Vector3(), camFov = 44, camPos = { x: 0, y: 7.4, z: 12.6 };
    var venue = null, venueIdx = -1, shuttle = SW.makeShuttle(L), fx = SW.makeFX(L, scene), sparks = SW.makePoints(L, scene, 220, false), confetti = SW.makePoints(L, scene, 260, true), dust = SW.makePoints(L, scene, 80, false);
    scene.add(shuttle.group); scene.add(shuttle.shadow); scene.add(shuttle.trail); scene.add(shuttle.glow);
    var aim = [SW.makeTarget(L, 0x5dff6a), SW.makeTarget(L, 0x5dff6a)], land = SW.makeTarget(L, 0xffb02e);
    scene.add(aim[0].group); scene.add(aim[1].group); scene.add(land.group);
    land.group.scale.set(0.8, 1, 0.8);

    /* ------------------------------------------------------------- DOM */
    function el(cls, html, parent) { var d = document.createElement('div'); d.className = cls; if (html != null) d.innerHTML = html; (parent || root).appendChild(d); return d; }
    var vig = el('bm-vig'), flash = el('bm-flash'), swEl = el('bm-sw');
    function plateHtml(c) { return '<div class="top">' + TROPHY + '<b class="rt">1200</b></div><div class="main"><span class="nm">-</span><div class="eb"><i class="bolt">' + BOLT + '</i><div class="bar"><u></u></div></div></div><span class="srv">SERVE</span><div class="sc">0</div><div class="gp"></div>'; }
    var plates = [el('pl l', plateHtml()), el('pl r', plateHtml())], pe = plates.map(function (p) { return { nm: p.querySelector('.nm'), rt: p.querySelector('.rt'), sc: p.querySelector('.sc'), bar: p.querySelector('.bar'), fill: p.querySelector('.bar u'), srv: p.querySelector('.srv'), gp: p.querySelector('.gp') }; });
    var mid = el('bm-mid', '<span class="bm-rally">RALLY 0</span>'), rallyEl = mid.firstChild, rulesEl = el('bm-rules'), watchEl = el('bm-watch');
    var popEl = el('bm-pop'), banEl = el('bm-ban', '<b></b><small></small>'), mpEl = el('bm-mp', 'MATCH POINT'), ovEl = el('bm-ov'), cache = {};
    function setT(e, k, v) { if (cache[k] !== v) { cache[k] = v; e.textContent = v; } }
    function setH(e, k, v) { if (cache[k] !== v) { cache[k] = v; e.innerHTML = v; } }
    function popup(text, color) { popEl.textContent = text; popEl.style.color = color || '#fff'; popEl.classList.remove('go'); void popEl.offsetWidth; popEl.classList.add('go'); }
    function banner(big, sub, color) { var b = banEl.firstChild; b.textContent = big; b.style.color = color || '#fff'; banEl.lastChild.textContent = sub || ''; banEl.classList.remove('go'); void banEl.offsetWidth; banEl.classList.add('go'); }

    /* ------------------------------------------------------- HELPERS */
    function pById(id) { for (var i = 0; i < players.length; i++) if (players[i].id === id) return players[i]; return null; }
    function isP1(id) { return players.length > 0 && players[0].id === id; }
    function humans() { return players.slice(0, 4); }
    function ratingOf(id) { return RATING[id] || (RATING[id] = 1200); }
    function charOf(p, i) { var c = pick.chr[p.id]; return c == null ? (p.slot % 6) : c; }
    function setPh() { stateDirty = true; }

    /* Who plays where. solo: P1 vs CPU; 1v1: P1 vs P2; 2v2: teams from setup, empty seats are CPUs. Extra phones spectate. */
    function buildEntries() {
      var hs = humans(), ents = [], used = {}, i, mode = cfg.mode;
      if (!hs.length) { cfg.effMode = mode; return ents; }
      if (mode === '1v1' && hs.length < 2) mode = 'solo';
      function human(p, team) { used[charOf(p)] = 1; return { id: p.id, slot: p.slot, human: true, name: 'Player ' + (p.slot + 1), char: charOf(p), team: team, assist: pick.as[p.id] !== 0, rating: ratingOf(p.id) }; }
      function cpu(k, team, nth) { var lad = Core.LADDER[(cfg.lad + nth) % 5], ch = lad.ch; if (used[ch]) { for (var q = 0; q < 6; q++) if (!used[q]) { ch = q; break; } } used[ch] = 1; return { id: 'cpu' + k, slot: -1, human: false, name: lad.name, char: ch, team: team, assist: false, sty: lad.sty, rating: lad.rating }; }
      if (mode === 'solo') { ents.push(human(hs[0], 0)); ents.push(cpu(0, 1, 0)); }
      else if (mode === '1v1') { ents.push(human(hs[0], 0)); ents.push(human(hs[1], 1)); }
      else {
        var cnt = [0, 0], k = 0;
        hs.forEach(function (p, idx) { var t = pick.tp[p.id]; if (t == null) t = idx % 2; if (cnt[t] >= 2) t = 1 - t; if (cnt[t] >= 2) return; cnt[t]++; ents.push(human(p, t)); });
        for (var t2 = 0; t2 < 2; t2++) while (cnt[t2] < 2) { ents.push(cpu(k, t2, k)); k++; cnt[t2]++; }
      }
      ents.sort(function (a, b) { return a.team - b.team; });
      cfg.effMode = mode; return ents;
    }

    /* ---------------------------------------------------- ACTORS (3D) */
    function disposeActors() { actors.forEach(function (a) { scene.remove(a.ch.group); a.ch.dispose(); }); actors = []; byActor = {}; }
    function makeActors(ents, simPlayers) {
      disposeActors();
      ents.forEach(function (e) {
        var sp = null; if (simPlayers) for (var i = 0; i < simPlayers.length; i++) if (simPlayers[i].id === e.id) sp = simPlayers[i];
        var def = SW.CHARS[e.char % SW.CHARS.length], a = { e: e, p: sp, ch: SW.makeCharacter(L, def, TEAM_HEX[e.team], e.human ? 'P' + (e.slot + 1) : null), lastPh: 0, yaw: e.team ? 0 : Math.PI, yawT: 0, vx: 0, vz: 0 };
        a.ch.group.position.set(0, 0, 0); scene.add(a.ch.group); actors.push(a); byActor[e.id] = a;
        if (SW.glbBuf) SW.makeGLBCharacter(L, def, TEAM_HEX[e.team], e.human ? 'P' + (e.slot + 1) : null, function (g) { if (!g || dead || byActor[e.id] !== a) return; scene.remove(a.ch.group); a.ch = g; scene.add(g.group); });
      });
    }
    /* In setup the characters stand on the court as a preview (near side = team 0). */
    function previewActors() {
      var ents = buildEntries(); entries = ents; makeActors(ents, null);
      var side = [0, 0];
      ents.forEach(function (e) { var s = e.team ? -1 : 1, n = side[e.team]++, cnt = ents.filter(function (x) { return x.team === e.team; }).length, a = byActor[e.id]; a.px = (cnt === 1 ? 0 : (n ? 1.5 : -1.5)); a.pz = s * 3.2; a.pyaw = s > 0 ? Math.PI : 0; });
    }

    /* --------------------------------------------------------- VENUE */
    function setVenue(i) {
      if (venue && venueIdx === i) return;
      if (venue) venue.dispose(); venueIdx = i; venue = SW.buildVenue(L, scene, i, Q.level); venue.setQuality(Q, Q.level); renderer.setClearColor(SW.VENUES[i].sky, 1);
    }

    /* --------------------------------------------------------- MATCH */
    function startMatch() {
      if (stopped || players.length === 0) return;
      entries = buildEntries(); matchWon = null; results = null; ready = {}; slow = 0; zoomT = 0; pf = {}; ht = {};
      var humansIn = entries.filter(function (e) { return e.human; }).length; if (!humansIn) return;
      sim = Core.createSim({ mode: cfg.effMode, points: cfg.pts, bestOf: cfg.bo, diff: cfg.diff, ladder: cfg.lad, seed: (Date.now() & 0xffffff) + 1, entries: entries });
      setVenue(cfg.ven); makeActors(entries, sim.players); sparks.clear(); confetti.clear(); dust.clear(); shuttle.reset();
      lastScore = [0, 0]; gph = 'match'; acc = 0; msg = ''; lastCfg = JSON.parse(JSON.stringify(cfg)); sfx.resume(); sfx.beep(false); setPh(); pushState(true);
    }
    function enterSetup() { sim = null; gph = 'setup'; results = null; matchWon = null; ready = {}; setVenue(cfg.ven); previewActors(); sparks.clear(); confetti.clear(); setPh(); pushState(true); }
    function finishMatch(winTeam) {
      var rs = sim.results(); results = rs; matchWon = winTeam;
      rs.players.forEach(function (p) { if (p.human) { RATING[p.id] = Math.max(100, ratingOf(p.id) + (p.team === winTeam ? 24 : -16)); } });
      if (cfg.effMode === 'solo' && winTeam === 0 && cfg.lad < 4) { cfg.lad++; rs.ladderUp = true; }
      rs.ladderNext = cfg.lad; setPh();
    }

    /* ----------------------------------------------------- PHONE PROTOCOL OUT */
    function stateObj() {
      var ph = gph === 'setup' ? 'setup' : (gph === 'results' ? 'results' : (gph === 'paused' ? 'paused' : (sim ? sim.phase : 'setup')));
      if (ph === 'over') ph = 'point';
      var seats = entries.map(function (e) { return { id: e.id, n: e.name, c: e.char, t: e.team, ai: e.human ? 0 : 1 }; });
      if (gph === 'setup') seats = buildEntries().map(function (e) { return { id: e.id, n: e.name, c: e.char, t: e.team, ai: e.human ? 0 : 1 }; });
      var en = {}, sc = [0, 0], gm = [0, 0], g = sim ? sim.get() : null, as = {}, tp = {}, np = 0;
      if (sim) { sim.players.forEach(function (p) { en[p.id] = +p.energy.toFixed(2); if (p.human) np++; }); sc = [sim.teams[0].score, sim.teams[1].score]; gm = [sim.teams[0].games, sim.teams[1].games]; }
      players.forEach(function (p) { as[p.id] = pick.as[p.id] === 0 ? 0 : 1; if (pick.tp[p.id] != null) tp[p.id] = pick.tp[p.id]; });
      var seated = {}; seats.forEach(function (s) { seated[s.id] = 1; });
      return { g: 'badminton', ph: ph, mode: cfg.mode, diff: cfg.diff, ven: cfg.ven, pts: cfg.pts, bo: cfg.bo, lad: cfg.lad, vn: vname, cn: cnames, on: onames,
        rd: Object.keys(ready).filter(function (k) { return ready[k]; }), pl: seats, sc: sc, gm: gm, gn: g ? g.gameNo : 1, en: en, sv: g && g.server ? g.server.id : '', st: g ? g.serveTeam : 0, ra: g ? g.rally : 0,
        pf: pf, ht: ht, as: as, tp: tp, mp: g ? g.mp : -1, msg: msg, res: ph === 'results' ? results : null, np: np || players.slice(0, 4).length, ns: players.filter(function (p) { return !seated[p.id]; }).length, sd: g ? g.sideSign : [1, -1] };
    }
    function pushState() {
      stateAcc = 0; stateDirty = false; if (!ctx.send) return;
      try { var r = ctx.send('gstate', stateObj()); if (r && r.catch) r.catch(function () {}); } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------------ INPUT FROM HOST */
    function idOf(slot, msgId) { if (msgId) return msgId; for (var i = 0; i < players.length; i++) if (players[i].slot === slot) return players[i].id; return null; }
    function onInput(slot, m) {
      if (stopped || !m || m.t !== 'g') return;
      var id = idOf(slot, m.id); if (!id || !pById(id)) return;
      var a = m.a, p1 = isP1(id);
      if (a === 'mv') { if (sim && gph !== 'setup') sim.input(id, m.x, m.y); }
      else if (a === 'shot') { if (sim && gph === 'match') { sfx.resume(); sim.shot(id, m.k, m.x, m.y, m.n); } }
      else if (a === 'dive') { if (sim && gph === 'match') sim.dive(id); }
      else if (a === 'char') { var c = clamp(Math.round(+m.c || 0), 0, 5); if (gph === 'setup' || gph === 'results') { pick.chr[id] = c; if (gph === 'setup') previewActors(); setPh(); } }
      else if (a === 'assist') { pick.as[id] = m.on ? 1 : 0; if (sim) sim.setAssist(id, !!m.on); setPh(); }
      else if (a === 'team') { var pid = p1 && m.pid ? m.pid : id; if (pById(pid) && (gph === 'setup' || gph === 'results')) { pick.tp[pid] = m.tm ? 1 : 0; if (gph === 'setup') previewActors(); setPh(); } }
      else if (a === 'ready') { if (gph === 'setup') { ready[id] = !ready[id]; setPh(); } }
      else if (a === 'setup') {
        if (!p1 || gph !== 'setup') return;
        if (MODES.indexOf(m.mode) >= 0) cfg.mode = m.mode; cfg.diff = clamp(Math.round(m.diff == null ? cfg.diff : +m.diff), 0, 2); cfg.ven = clamp(Math.round(m.ven == null ? cfg.ven : +m.ven), 0, 2);
        cfg.pts = [7, 11, 21].indexOf(+m.pts) >= 0 ? +m.pts : cfg.pts; cfg.bo = +m.bo === 3 ? 3 : 1; cfg.lad = clamp(Math.round(m.lad == null ? cfg.lad : +m.lad), 0, 4);
        setVenue(cfg.ven); previewActors(); setPh();
      }
      else if (a === 'start') { if (p1 && gph === 'setup') startMatch(); }
      else if (a === 'again') { if (p1 && gph === 'results') startMatch(); }
      else if (a === 'tosetup') { if (p1 && gph === 'results') enterSetup(); }
      else if (a === 'pause') {
        if (!p1) return;
        if (gph === 'paused') { gph = prevGph; sfx.resume(); setPh(); }
        else if (gph === 'match') { prevGph = gph; gph = 'paused'; sfx.silence(); setPh(); }
      }
    }
    /* Edge buttons: Player 1 can also drive the menus from the TV remote. */
    function onButton(slot, key) {
      if (stopped) return; sfx.resume();
      var id = idOf(slot, null); if (!id || !isP1(id)) return;
      if (gph === 'setup' && (key === 'cr' || key === 'start')) startMatch();
      else if (gph === 'setup' && (key === 'left' || key === 'right')) { cfg.ven = (cfg.ven + (key === 'right' ? 1 : 2)) % 3; setVenue(cfg.ven); previewActors(); setPh(); }
      else if (gph === 'results' && (key === 'cr' || key === 'start')) startMatch();
      else if (gph === 'results' && key === 'tri') enterSetup();
    }
    /* Roster changes: a human who left is replaced by the CPU; newcomers spectate (they are seated at the next setup / rematch). */
    function onPlayers(list) {
      if (stopped) return;
      players = (list || []).slice().sort(function (a, b) { return a.slot - b.slot; });
      var ids = {}; players.forEach(function (p) { ids[p.id] = p; });
      if (sim) {
        var hLeft = 0;
        sim.players.forEach(function (p) {
          if (p.human && !ids[p.id]) { sim.replaceWithAI(p.id); var a = byActor[p.id]; if (a) { a.e.human = false; if (a.ch.tag) a.ch.tag.visible = false; } notice = p.name + ' left: CPU takes over'; noticeT = 3; }
          if (p.human) hLeft++;
        });
        if (hLeft === 0 && gph !== 'results') { if (players.length) enterSetup(); }
      }
      for (var k in ready) if (!ids[k]) delete ready[k];
      if (gph === 'setup') { cfg.mode = cfg.mode === '1v1' && humans().length < 2 ? 'solo' : cfg.mode; previewActors(); }
      setPh();
    }

    /* ----------------------------------------------------- EVENTS -> FX */
    var _v = { x: 0, y: 0, z: 0 };
    function burst(x, y, z, n, spd, r, g, b, life, size, grav) { for (var i = 0; i < n; i++) { var a = Math.random() * 6.283, e = (Math.random() - 0.3) * 2, s = spd * (0.4 + Math.random() * 0.8); sparks.emit(x, y, z, Math.cos(a) * s, e * s * 0.6 + 1, Math.sin(a) * s, life * (0.6 + Math.random() * 0.6), size, r, g, b, grav || 0); } }
    function confettiAt(side, n) {
      var cols = [[1, 0.35, 0.5], [0.3, 0.7, 1], [1, 0.85, 0.2], [0.3, 0.95, 0.7], [0.7, 0.4, 1], [1, 1, 1]];
      for (var i = 0; i < n; i++) { var c = cols[i % 6]; confetti.emit((Math.random() - 0.5) * 7, 7 + Math.random() * 4, side * (1 + Math.random() * 5.5), (Math.random() - 0.5) * 2, -Math.random() * 2, (Math.random() - 0.5) * 2, 3 + Math.random() * 2, 0.11, c[0], c[1], c[2], 3.5); }
    }
    function handle(e) {
      var a, g = sim ? sim.get() : null;
      if (e.t === 'hit') {
        a = byActor[e.id]; var big = e.shot === 'smash' || e.shot === 'super', col = e.lvl === 'perfect' ? [1, 0.9, 0.3] : (big ? [1, 0.55, 0.2] : [1, 1, 1]), hx = e.x, hy = e.y, hz = e.z;
        fx.star(hx, hy, hz, e.lvl === 'perfect' ? 0xffe45e : (e.shot === 'super' ? 0xff5cf0 : (big ? 0xff8a3c : 0xffffff)), big ? 1.8 : (e.lvl === 'perfect' ? 1.5 : 0.9));
        if (e.lvl === 'perfect' || big) fx.ring(hx, hy, hz, e.lvl === 'perfect' ? 0x9dff7a : 0xffb060, big ? 2.6 : 1.8);
        burst(hx, hy, hz, big ? 22 : 10, big ? 5 : 3, col[0], col[1], col[2], 0.45, 0.16, 2);
        shuttle.boost = 1; sfx.hit(e.shot, e.q); venue.cheer(big ? 0.12 : 0.03);
        if (big) { var sp = Math.hypot(e.tx - hx, e.tz - hz) || 1; fx.speed(hx, hy, hz, (e.tx - hx) / sp * 0.8, -0.6, (e.tz - hz) / sp * 0.8, camPos); zoomT = 0.7; shakeT = big && e.shot === 'super' ? 0.5 : 0.22; if (g && g.mp >= 0 && g.mp === e.team) { slow = 0.55; slowScale = 0.45; } }
        if (e.shot === 'super') { popup('SUPER SMASH!', '#ff7af6'); flash.style.transition = 'none'; flash.style.opacity = 0.5; setTimeout(function () { flash.style.transition = 'opacity .35s'; flash.style.opacity = 0; }, 30); }
        else if (e.perfect) popup('PERFECT!', '#7dff6a'); else if (e.shot === 'smash') popup('SMASH!', '#ffb02e'); else if (e.lvl === 'good' && !e.auto && Math.random() < 0.45) popup('NICE!', '#6ad8ff');
        if (e.id && !e.id.indexOf('cpu')) { /* CPU hits: no haptics */ } else { ht[e.id] = (ht[e.id] || 0) + 1; if (e.perfect) pf[e.id] = (pf[e.id] || 0) + 1; stateDirty = true; }
      } else if (e.t === 'net') { sfx.net(); venue.netShake = 1; burst(e.x, e.y, e.z, 6, 1.5, 1, 1, 1, 0.4, 0.1, 3); }
      else if (e.t === 'land') { sfx.floor(); for (var i = 0; i < 8; i++) dust.emit(e.x, 0.05, e.z, (Math.random() - 0.5) * 1.8, Math.random() * 1.3, (Math.random() - 0.5) * 1.8, 0.5, 0.18, 0.95, 0.95, 0.85, 1); }
      else if (e.t === 'dive') { sfx.slide(); a = byActor[e.id]; if (a && a.p) for (var j = 0; j < 8; j++) dust.emit(a.p.x, 0.05, a.p.z, (Math.random() - 0.5) * 2, Math.random(), (Math.random() - 0.5) * 2, 0.6, 0.2, 0.95, 0.95, 0.85, 1); }
      else if (e.t === 'point') {
        var col2 = e.team ? '#ff6a78' : '#4aa8ff'; msg = e.why; sfx.whistle(); venue.cheer(e.why.indexOf('SMASH') >= 0 || e.rally > 8 ? 0.9 : 0.55); sfx.cheer(0.4); sfx.jingle(e.gameEnd);
        banner(e.why, (e.team ? 'RED' : 'BLUE') + ' POINT  ' + e.score[0] + ' - ' + e.score[1] + (e.rally > 6 ? '   RALLY ' + e.rally : ''), e.why === 'OUT' || e.why === 'NET' || e.why === 'SERVICE FAULT' ? '#ffd21f' : col2);
        confettiAt(e.team ? -1 : 1, e.gameEnd ? 160 : (e.why.indexOf('SMASH') >= 0 ? 90 : 50));
        if (e.matchEnd) { slow = 1.5; slowScale = 0.35; }
        stateDirty = true;
      } else if (e.t === 'switch') { swEl.style.transition = 'none'; swEl.style.opacity = 1; setTimeout(function () { swEl.style.transition = 'opacity .8s'; swEl.style.opacity = 0; }, 80); banner('SWITCH ENDS', e.why === 'game' ? 'GAME ' + e.game : 'MID GAME', '#ffd21f'); sfx.whistle(); lastScore = [0, 0]; shuttle.reset(); setPh(); }
      else if (e.t === 'match') { sfx.fanfare(); confettiAt(e.team ? -1 : 1, 260); confettiAt(e.team ? 1 : -1, 80); finishMatch(e.team); resT = 0; setPh(); }
      else if (e.t === 'serve') { shuttle.reset(); setPh(); }
      else if (e.t === 'cpu') setPh();
    }

    /* ------------------------------------------------------- UPDATE VIEW */
    function ang(a) { while (a > Math.PI) a -= 6.2832; while (a < -Math.PI) a += 6.2832; return a; }
    function updateActors(dt) {
      var sh = sim ? sim.shuttle : null, shown = 0;
      actors.forEach(function (a) {
        var p = a.p, g = a.ch.group, x, z, y, face, state = 'idle', info;
        if (sim && p) {
          x = lerp(p.ox, p.x, alpha); z = lerp(p.oz, p.z, alpha); y = lerp(p.oy, p.y, alpha);
          var side = p.side, base = side > 0 ? Math.PI : 0, des = base;
          if (p.state === 'win' || p.state === 'lose') des = 0;
          else if (p.dive >= 0) des = Math.atan2(p.vx, p.vz);
          else if (sh && sim.phase === 'rally') { var d = Math.atan2(sh.x - p.x, sh.z - p.z); des = base + clamp(ang(d - base), -0.9, 0.9) * 0.5; }
          a.yaw += ang(des - a.yaw) * clamp(dt * 12, 0, 1); face = a.yaw; state = p.state;
          var fwx = Math.sin(face), fwz = Math.cos(face), rx = -Math.cos(face), rz = Math.sin(face);
          var timing = 0;
          if (p.human && sh && sim.phase === 'rally' && sh.in && sh.lastTeam !== p.team && !p.sw) { var dd = Math.hypot(sh.x - p.x, sh.z - p.z); timing = dd < 3 ? 1 - dd / 3 : 0; if (sh.z * p.side < -0.3) timing = 0; }
          info = { state: state, t: p.st, clock: clock + a.e.char, runPh: p.runPh, vf: p.vx * fwx + p.vz * fwz, vs: p.vx * rx + p.vz * rz, sw: p.sw, jumpH: y, look: sh ? clamp(ang(Math.atan2(sh.x - p.x, sh.z - p.z) - face), -0.8, 0.8) : 0, timing: timing, flash: p.flash };
          if (p.state === 'run' && Math.floor(p.runPh * 1.8 / 3.1416) !== a.lastPh) { a.lastPh = Math.floor(p.runPh * 1.8 / 3.1416); if (p.human || Math.abs(p.vx) + Math.abs(p.vz) > 3) sfx.step(); }
        } else {                                              // setup preview
          x = a.px || 0; z = a.pz || 0; y = 0; a.yaw += ang((a.pyaw || 0) + Math.sin(clock * 0.8 + x) * 0.25 - a.yaw) * clamp(dt * 6, 0, 1); face = a.yaw;
          info = { state: 'idle', t: clock, clock: clock + a.e.char, runPh: 0, vf: 0, vs: 0, sw: null, jumpH: 0, look: 0, timing: 0, flash: 0 };
        }
        g.position.set(x, y, z); g.rotation.y = face; a.ch.update(dt, info);
      });
    }
    function previewTarget(p, out) {                          // where a normal shot would land for the stick's current aim (green ring)
      var o = sim.teams[1 - p.team].players, near = o[0]; if (o[1] && Math.abs(o[1].z) < Math.abs(near.z)) near = o[1];
      var ax = p.in.x, ay = p.in.y, mag = Math.hypot(ax, ay), fresh = sim.t - p.in.t < 0.4; if (!fresh) { ax = ay = mag = 0; }
      var range = sim.get().dbl ? 2.75 : 2.45, neutral = -sgn(near.x || 1) * 1.2, away = p.side > 0 ? -ay : ay;
      out.x = lerp(neutral, ax * range, clamp(mag * 2.6, 0, 1)); out.z = -p.side * (0.45 + clamp(0.74 + away * 0.16, 0.4, 0.97) * 5.8); return out;
    }
    function updateShuttle(dt) {
      if (!sim || gph === 'setup') { shuttle.update(0, 0, 0, 0, 0, 0, camPos, dt, false, 0); aim[0].set(0, 0, clock, false); aim[1].set(0, 0, clock, false); land.set(0, 0, clock, false); return; }
      var s = sim.shuttle, show = sim.phase !== 'intro';
      var x = lerp(s.ox, s.x, alpha), y = lerp(s.oy, s.y, alpha), z = lerp(s.oz, s.z, alpha), sp = Math.hypot(s.vx, s.vy, s.vz);
      shuttle.update(x, y, z, s.vx, s.vy, s.vz, camPos, dt, show, clamp(sp / 60, 0, 1));
      sfx.whoosh(sim.phase === 'rally' && s.in ? clamp(sp / 45, 0, 1) : 0);
      // landing marker for the flying shuttle (green when it flies away from the camera, amber when it comes towards us)
      var fly = sim.phase === 'rally' && s.in && s.path && !s.netted;
      land.set(s.pLx, s.pLz, clock, fly && Math.abs(s.pLz) < 8.5 && Math.abs(s.pLx) < 5);
      for (var i = 0; i < 2; i++) aim[i].set(0, 0, clock, false);
      // aim rings: one per team that is about to hit and has a human
      var k = 0;
      for (var t = 0; t < 2 && k < 2; t++) {
        var best = null, bd = 99;
        sim.teams[t].players.forEach(function (p) {
          if (!p.human) return;
          var want = (sim.phase === 'rally' && s.in && s.lastTeam !== t && s.path && !p.sw) || (sim.phase === 'serve' && sim.serveP === p);
          if (!want) return; var d = sim.phase === 'serve' ? 0 : Math.hypot(s.pLx - p.x, s.pLz - p.z); if (d < bd) { bd = d; best = p; }
        });
        if (best) { previewTarget(best, _v); aim[k].set(_v.x, _v.z, clock, true); k++; }
      }
    }
    var shot0 = { x: 0, z: 0 }, baseP = { x: 0, y: 7.4, z: 12.6 };
    function updateCamera(dt) {
      var asp = camera.aspect, fovB = 44 + Math.max(0, 1.7 - asp) * 22, s = sim ? sim.shuttle : null, tx, ty, tz, lx, ly, lz, fovT = fovB;
      var ph = gph === 'setup' ? 'setup' : (sim ? sim.phase : 'setup');
      if (ph === 'setup' || ph === 'intro') {
        var u = ph === 'intro' ? clamp(sim.phaseT / 3, 0, 1) : 1, e = u * u * (3 - 2 * u), a0 = ph === 'intro' ? (1 - e) * 1.1 : Math.sin(clock * 0.25) * 0.35, r = 14.8 - (ph === 'intro' ? (1 - e) * 2 : 0) * -1;
        tx = Math.sin(a0) * 14; tz = Math.cos(a0) * 12.6 + (ph === 'intro' ? 0 : 0.0); ty = 7.2 - (ph === 'intro' ? 0 : 0) + (1 - e) * 2; lx = 0; ly = 0.6; lz = -1.4;
      } else if (ph === 'over' || ph === 'gameover') {
        var wsd = sim.get().winner; wsd = wsd < 0 ? (sim.teams[0].score > sim.teams[1].score ? 0 : 1) : wsd; var ws = sim.get().sideSign[wsd];
        var oa = clock * 0.35; tx = Math.sin(oa) * 4.5; ty = 3.6; tz = ws * 9 + (ws > 0 ? 3 : -3) * 0; if (ws < 0) { tx = Math.sin(oa) * 4.5; tz = -9; } lx = 0; ly = 1.2; lz = ws * 3.2;
        if (ws > 0) { tx = Math.sin(oa) * 5; tz = 9.6; }
      } else {
        var sx = s ? clamp(lerp(s.ox, s.x, alpha), -5, 5) : 0, sz = s ? clamp(lerp(s.oz, s.z, alpha), -8, 8) : 0;
        tx = sx * 0.2; ty = 7.4 - (zoomT > 0 ? 0.8 : 0); tz = 12.6 + sz * 0.05 - (zoomT > 0 ? 1.4 : 0); lx = sx * 0.28; ly = 0.6; lz = -1.7 + sz * 0.1;
        if (zoomT > 0) fovT = fovB - 7 * Math.min(1, zoomT * 3);
      }
      var k = 1 - Math.exp(-dt * (ph === 'setup' ? 2 : 3.4));
      camP.x += (tx - camP.x) * k; camP.y += (ty - camP.y) * k; camP.z += (tz - camP.z) * k; camL.x += (lx - camL.x) * k; camL.y += (ly - camL.y) * k; camL.z += (lz - camL.z) * k;
      camFov += (fovT - camFov) * clamp(dt * 6, 0, 1);
      var sh = shakeT > 0 ? (Math.random() - 0.5) * shakeT * 0.35 : 0;
      camera.position.set(camP.x + sh, camP.y + sh, camP.z); camera.lookAt(camL.x, camL.y, camL.z); camera.fov = camFov; camera.updateProjectionMatrix();
      camPos.x = camP.x; camPos.y = camP.y; camPos.z = camP.z;
    }

    /* ------------------------------------------------------------- HUD */
    function teamName(t) { var ps = entries.filter(function (e) { return e.team === t; }); return ps.map(function (e) { return e.name; }).join(' & '); }
    function teamRating(t) { var ps = entries.filter(function (e) { return e.team === t; }); return Math.round(ps.reduce(function (s, e) { return s + (e.human ? ratingOf(e.id) : e.rating); }, 0) / Math.max(1, ps.length)); }
    function ruleLine() { return 'Rally scoring  \u00b7  first to ' + cfg.pts + '  \u00b7  win by 2, cap ' + (cfg.pts + 4) + '  \u00b7  best of ' + cfg.bo; }
    function updateHud(dt) {
      var ph = gph === 'setup' ? 'setup' : (gph === 'results' ? 'results' : (gph === 'paused' ? 'paused' : sim.phase)), g = sim ? sim.get() : null, i;
      root.style.fontSize = Math.max(8, Math.min(boxW / 68, boxH / 38)).toFixed(2) + 'px';
      var showPl = gph !== 'setup'; plates[0].style.display = plates[1].style.display = showPl ? '' : 'none';
      if (showPl && sim) {
        for (i = 0; i < 2; i++) {
          var T = sim.teams[i], en = 0; T.players.forEach(function (p) { if (p.energy > en) en = p.energy; });
          setT(pe[i].nm, 'nm' + i, teamName(i)); setT(pe[i].rt, 'rt' + i, String(teamRating(i)));
          setT(pe[i].sc, 'sc' + i, String(T.score)); if (lastScore[i] !== T.score) { lastScore[i] = T.score; pe[i].sc.classList.remove('pop'); void pe[i].sc.offsetWidth; pe[i].sc.classList.add('pop'); }
          var w = Math.round(en * 100) + '%'; if (cache['en' + i] !== w) { cache['en' + i] = w; pe[i].fill.style.width = w; pe[i].bar.classList.toggle('full', en >= 0.999); }
          plates[i].classList.toggle('sv', g.serveTeam === i && (ph === 'serve' || ph === 'rally' || ph === 'intro'));
          if (g.serveTeam === i) { var c = sim.teams[i].score % 2 ? 'LEFT' : 'RIGHT'; setT(pe[i].srv, 'sv' + i, 'SERVE ' + c); }
          setH(pe[i].gp, 'gp' + i, cfg.bo === 3 ? '<i class="' + (T.games >= 1 ? 'on' : '') + '"></i><i class="' + (T.games >= 2 ? 'on' : '') + '"></i>' : '');
        }
        var rl = g.rally; rallyEl.classList.toggle('on', ph === 'rally' && rl >= 3); setT(rallyEl, 'ral', 'RALLY ' + rl);
        mpEl.classList.toggle('on', g.mp >= 0 && (ph === 'serve' || ph === 'rally'));
        if (g.mp >= 0) setT(mpEl, 'mp', 'MATCH POINT  ' + (g.mp ? 'RED' : 'BLUE'));
      } else { mpEl.classList.remove('on'); rallyEl.classList.remove('on'); }
      var ns = players.length - entries.filter(function (e) { return e.human; }).length; watchEl.style.display = ns > 0 ? 'block' : 'none'; setT(watchEl, 'ns', 'WATCHING ' + ns);
      setT(rulesEl, 'rules', ruleLine() + (notice && noticeT > 0 ? '   \u00b7   ' + notice : ''));
      // overlays
      var h = '';
      if (ph === 'setup') {
        var chips = players.slice(0, 4).map(function (p) { var rd = isP1(p.id) || ready[p.id]; return '<span style="--c:' + COLORS[p.slot % COLORS.length] + '" class="' + (rd ? 'ok' : '') + '">P' + (p.slot + 1) + ' ' + esc(cnames[charOf(p)]) + (isP1(p.id) ? ' \u00b7 HOST' : (ready[p.id] ? ' \u00b7 READY' : '')) + '</span>'; }).join('');
        var modeTxt = { solo: 'SOLO vs CPU', '1v1': '1 vs 1', '2v2': 'DOUBLES 2 vs 2' }[cfg.effMode || cfg.mode] || '';
        h = '<div class="bm-card" style="margin-top:12em"><h1>SMASH COURT</h1><p>' + modeTxt + '  \u00b7  ' + esc(vname[cfg.ven]) + '  \u00b7  ' + ['EASY', 'NORMAL', 'HARD'][cfg.diff] + '</p>' +
          '<p><span class="rl">Rally scoring</span><span class="rl">First to <b>' + cfg.pts + '</b></span><span class="rl">Win by <b>2</b></span><span class="rl">Cap <b>' + (cfg.pts + 4) + '</b></span><span class="rl">Best of <b>' + cfg.bo + '</b></span></p>' +
          '<div class="bm-chips">' + chips + '</div><p style="opacity:.75;font-size:.95em">Player 1 picks the match on the phone, then taps START</p></div>';
      } else if (ph === 'intro') {
        var t0 = entries.filter(function (e) { return e.team === 0; }), t1 = entries.filter(function (e) { return e.team === 1; });
        h = '<div class="bm-card" style="margin-top:6em"><h2>GAME 1</h2><div class="bm-vs"><div style="color:#7fc0ff">' + esc(t0.map(function (e) { return e.name; }).join(' & ')) + '</div><em>VS</em><div style="color:#ff8a94">' + esc(t1.map(function (e) { return e.name; }).join(' & ')) + '</div></div><p>' + ruleLine() + '</p></div>';
      } else if (ph === 'gameover') {
        var lg = g.log[g.log.length - 1] || [0, 0];
        h = '<div class="bm-card" style="margin-top:10em"><h2>GAME ' + g.log.length + ' TO ' + (lg[0] > lg[1] ? 'BLUE' : 'RED') + '</h2><h1>' + lg[0] + ' - ' + lg[1] + '</h1><p>Games  ' + sim.teams[0].games + ' - ' + sim.teams[1].games + '</p></div>';
      } else if (ph === 'paused') h = '<div class="bm-card"><h1>PAUSED</h1><p>Player 1 resumes on the phone</p></div>';
      else if (ph === 'results' && results) {
        var r = results, wt = r.winner;
        h = '<div class="bm-card" style="min-width:40em"><h2>' + (wt ? 'RED' : 'BLUE') + ' TEAM WINS</h2><h1>' + r.games[0] + ' - ' + r.games[1] + '</h1><p>' + r.log.map(function (s, i) { return 'Game ' + (i + 1) + ': ' + s[0] + '-' + s[1]; }).join('  \u00b7  ') + '  \u00b7  Longest rally ' + r.longest + '</p>' +
          '<table><tr><th>PLAYER</th><th>POINTS</th><th>WINNERS</th><th>SMASHES</th><th>PERFECT</th><th>ERRORS</th></tr>' + r.players.map(function (p) { return '<tr><td><i class="dot" style="background:' + TEAM_CSS[p.team] + '"></i>' + esc(p.name) + '</td><td>' + p.pts + '</td><td>' + p.winners + '</td><td>' + p.smashes + '</td><td>' + p.perfects + '</td><td>' + p.errors + '</td></tr>'; }).join('') + '</table>' +
          '<p style="opacity:.75;font-size:.95em">' + (r.ladderUp ? 'Next opponent unlocked!  ' : '') + 'Player 1: rematch or menu on the phone</p></div>';
      }
      setH(ovEl, 'ov', h);
    }

    /* ------------------------------------------------------- RENDER SIZE / QUALITY */
    var boxW = 1280, boxH = 720, dprBase = Math.min(window.devicePixelRatio || 1, 1.5), ro = null, fpsEma = 60, lowT = 0, highT = 0, coolT = 0;
    function applyQuality() {
      var l = Q.level; Q.pr = Math.max(0.5, dprBase * [0.55, 0.7, 0.85, 1][l]); Q.shadow = l >= 2 ? 1 : 0; Q.shadowSize = l >= 3 ? 2048 : 1024;
      renderer.setPixelRatio(Q.pr); renderer.setSize(boxW, boxH, false); renderer.domElement.style.width = boxW + 'px'; renderer.domElement.style.height = boxH + 'px';
      renderer.shadowMap.enabled = Q.shadow > 0; if (venue) venue.setQuality(Q, l);
      actors.forEach(function (a) { a.ch.group.traverse(function (o) { if (o.isMesh) o.castShadow = Q.shadow > 0; }); });
    }
    function onResize() { boxW = Math.max(2, container.clientWidth || window.innerWidth); boxH = Math.max(2, container.clientHeight || window.innerHeight); camera.aspect = boxW / boxH; camera.updateProjectionMatrix(); applyQuality(); }
    function adapt(dt) {
      fpsEma += (Math.min(120, 1 / Math.max(dt, 0.001)) - fpsEma) * 0.04; coolT -= dt;
      if (fpsEma < 52) { lowT += dt; highT = 0; } else if (fpsEma >= 58) { highT += dt; lowT = 0; } else { lowT = highT = 0; }
      if (lowT > 2 && Q.level > 0) { Q.level--; applyQuality(); lowT = 0; coolT = 20; } else if (highT > 10 && Q.level < 3 && coolT <= 0) { Q.level++; applyQuality(); highT = 0; }
    }

    /* ------------------------------------------------------------ MAIN LOOP */
    var raf = 0, lastT = 0;
    function frame(now) {
      if (dead) return; raf = requestAnimationFrame(frame);
      var raw = lastT ? (now - lastT) / 1000 : 1 / 60; lastT = now; var dt = Math.min(0.05, Math.max(0.0005, raw));
      clock += dt; noticeT -= dt; zoomT = Math.max(0, zoomT - dt); shakeT = Math.max(0, shakeT - dt);
      var scale = 1; if (slow > 0) { slow -= dt; scale = slowScale; }
      if (gph === 'match' && sim) {
        acc += dt * scale; var n = 0;
        while (acc >= STEP && n < 12) { sim.step(STEP); acc -= STEP; n++; if (sim.events.length) { var evs = sim.events.splice(0); for (var i = 0; i < evs.length; i++) handle(evs[i]); } if (gph !== 'match') break; }
        if (acc > STEP * 4) acc = 0; alpha = acc / STEP;
        if (sim && sim.phase === 'over') { resT += dt; if (resT > 2.6) { gph = 'results'; setPh(); pushState(); } }
      } else { alpha = 1; }
      if (gph === 'results' && sim) sim.step(dt);   // characters keep celebrating
      updateActors(dt * scale); updateShuttle(dt); updateCamera(dt);
      if (venue) venue.update(dt, clock); fx.update(dt); sparks.update(dt); confetti.update(dt); dust.update(dt * 0.6); sparks.setView(boxH * renderer.getPixelRatio(), camera.fov); confetti.setView(boxH * renderer.getPixelRatio(), camera.fov); dust.setView(boxH * renderer.getPixelRatio(), camera.fov);
      renderer.render(scene, camera);
      updateHud(dt); adapt(dt);
      if (venue) sfx.crowd(venue.excite);
      stateAcc += dt * 1000; var playing = gph === 'match' && sim && (sim.phase === 'rally' || sim.phase === 'serve');
      if (stateDirty || (playing && stateAcc >= STATE_MS) || stateAcc >= HB_MS) pushState();
    }

    /* ---------------------------------------------------------------- BOOT / TEARDOWN */
    var gestureFn = function () { sfx.resume(); }; window.addEventListener('pointerdown', gestureFn); window.addEventListener('keydown', gestureFn);
    onResize(); if (window.ResizeObserver) { ro = new ResizeObserver(onResize); ro.observe(container); } else window.addEventListener('resize', onResize);
    if (SW.glbProbe) SW.glbProbe(SW.CHARS.map(function (c) { return c.id; }), function (bufs) { var any = false; for (var k in bufs) any = true; if (any && !dead) { SW.glbBuf = true; if (gph === 'setup') previewActors(); } });
    onPlayers(ctx.players || []); setVenue(cfg.ven); enterSetup(); applyQuality(); lastT = 0; raf = requestAnimationFrame(frame);

    function stop() {
      if (dead) return; dead = true; stopped = true; if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect(); window.removeEventListener('resize', onResize); window.removeEventListener('pointerdown', gestureFn); window.removeEventListener('keydown', gestureFn);
      sfx.close(); try { disposeActors(); if (venue) venue.dispose(); fx.dispose(); sparks.dispose(); confetti.dispose(); dust.dispose(); L.dispose(); } catch (e) { /* ignore */ }
      renderer.dispose(); if (renderer.forceContextLoss) renderer.forceContextLoss(); if (root.parentNode) root.parentNode.removeChild(root);
    }
    return { stop: stop, onPlayers: onPlayers, onButton: onButton, onInput: onInput, debug: { get sim() { return sim; }, get gph() { return gph; }, cfg: cfg, pushState: stateObj, startMatch: startMatch, frame: frame } };
  }

  /* ---------------------------------------------------------------- PUBLIC CONTRACT */
  var inst = null;
  window.NovaGames.badminton = {
    start: function (ctx) { if (inst) { try { inst.stop(); } catch (e) { /* ignore */ } } inst = createGame(ctx); },
    stop: function () { if (inst) { try { inst.stop(); } catch (e) { /* ignore */ } inst = null; } },
    onPlayers: function (list) { if (inst) inst.onPlayers(list); },
    onButton: function (slot, key) { if (inst) inst.onButton(slot, key); },
    onInput: function (slot, msg) { if (inst) inst.onInput(slot, msg); },
    debug: function () { return inst && inst.debug; }
  };
})();
