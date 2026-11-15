/* ===========================================================================
 * Carrom  -  NOVA Console game  (id: 'carrom')
 * ---------------------------------------------------------------------------
 * Top-down 2D carrom for 2-4 players. Runs ONLY on the screen page.
 * Everything (board, coins, sounds, particles) is generated procedurally.
 * No external libraries, no image files.
 *
 * Public contract (what screen/index.html talks to):
 *   window.NovaGames.carrom = {
 *     start(ctx)        ctx = { container, players, colors, input(slot), send(event,payload), exit() }
 *     stop()
 *     onPlayers(list)   list = [{id, slot}, ...]
 *     onButton(slot,k)  button went DOWN (Player 1 'cr' = play again on the winner screen)
 *     onInput(slot,msg) generic phone message {id, t:'g', a:'pos'|'aim'|'shoot', ...}
 *   }
 *
 * Phone -> screen (relative to the player's own side, forward = towards the centre)
 *   {t:'g', a:'pos',   v}                 striker slider 0..1 (0 = player's left, 1 = right)
 *   {t:'g', a:'aim',   ang, pow, on}      ang radians (0 = forward, + = player's right), pow 0..1
 *   {t:'g', a:'shoot', ang, pow, v}       fired once on finger release
 *
 * Screen -> phones: ctx.send('gstate', payload)   (see pushState())
 *
 * Seats: tracked by player ID (slots are re-indexed by the host). Seats are
 * re-built live until the first shot, then frozen. Extra phones spectate.
 * ========================================================================= */
(function () {
  'use strict';

  window.NovaGames = window.NovaGames || {};

  /* ======================================================================
   * TUNABLES  (board units: playing surface is 2*H = 740 wide)
   * ==================================================================== */
  var H = 370;                       // half size of the playing surface
  var FRAME = 50;                    // wooden frame thickness
  var HALF = H + FRAME;              // half size of the whole board
  var R_COIN = 17, R_STRK = 21;      // radii
  var M_COIN = 1, M_STRK = 2.6;      // masses
  var POCKET_R = 29, POCKET_IN = 14; // capture radius, pocket centre inset from the corner
  var PC = H - POCKET_IN;            // pocket centre coordinate (+-PC, +-PC)
  var BASE_OFF = 105, RANGE = 205;   // baseline distance from wall, half length of striker travel
  var K_DRAG = 1.55, A_DRAG = 250, V_STOP = 9;   // friction: exponential + constant, stop speed
  var E_COIN = 0.94, E_WALL = 0.78;  // restitution
  var V_MIN = 380, V_MAX = 2500;     // striker speed at power 0 / 1  (units per second)
  var MAX_ANG = 85 * Math.PI / 180;  // max shot angle away from forward
  var DT = 1 / 60, SUB = 4;          // fixed step, physics substeps per step (240 Hz)
  var TURN_TIME = 20;                // seconds per turn
  var SETTLE = 0.35;                 // all still for this long -> shot is over
  var OVER_LOCK = 1.2;               // seconds before "play again" is accepted
  var PTS_COIN = 10, PTS_QUEEN = 50, PTS_FOUL = 10;

  // side 0 bottom, 1 left, 2 top, 3 right (clockwise). Forward = towards centre.
  var SIDE_F = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  var SEAT_SIDES = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };
  var ARROWS = ['\u25B2', '\u25B6', '\u25BC', '\u25C0'];   // pointing from the seat to the board centre
  var FONT = 'ui-rounded,"SF Pro Rounded","Nunito","Varela Round","Arial Rounded MT Bold","Trebuchet MS",' +
    'system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rgt(f) { return [-f[1], f[0]]; }                 // player's right-hand vector
  function easeOutBack(t) { var c = 1.70158; t = t - 1; return 1 + (c + 1) * t * t * t + c * t * t; }
  function hex2rgb(h) {
    h = String(h || '#888888').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16); if (isNaN(n)) n = 0x888888;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(h, t, a) {
    var c = hex2rgb(h);
    return 'rgb(' + Math.round(c[0] + (t - c[0]) * a) + ',' + Math.round(c[1] + (t - c[1]) * a) + ',' +
      Math.round(c[2] + (t - c[2]) * a) + ')';
  }
  function rgba(h, a) { var c = hex2rgb(h); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function prng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function rr(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r);
    g.lineTo(x + w, y + h - r); g.arcTo(x + w, y + h, x + w - r, y + h, r); g.lineTo(x + r, y + h);
    g.arcTo(x, y + h, x, y + h - r, r); g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r); g.closePath();
  }

  /* ======================================================================
   * HUD STYLES (em based, JS sets the root font-size from the container)
   * ==================================================================== */
  var CSS = [
    '.cr-root{position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden;background:#000;color:#fff;',
    'font-family:', FONT, ';font-weight:700;user-select:none;-webkit-user-select:none;display:grid;',
    'grid-template-rows:auto minmax(0,1fr);font-variant-numeric:tabular-nums}',
    '.cr-top{display:flex;justify-content:center;padding:.9em 1em .1em;pointer-events:none;position:relative;z-index:3}',
    '.cr-turn{position:relative;display:flex;align-items:center;gap:.9em;padding:.55em 1.5em .75em;min-width:21em;border-radius:999px;',
    'background:linear-gradient(180deg,rgba(255,255,255,.13),rgba(255,255,255,.04));border:1px solid rgba(255,255,255,.2);',
    'backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);overflow:hidden;',
    'box-shadow:0 0 2.6em -.7em var(--c,#8b6cff),inset 0 1px rgba(255,255,255,.28);transition:box-shadow .4s,border-color .4s}',
    '.cr-turn.pulse{animation:cr-pulse .5s ease-out}',
    '@keyframes cr-pulse{0%{transform:scale(.94)}60%{transform:scale(1.04)}100%{transform:scale(1)}}',
    '.cr-dot{flex:none;width:1.1em;height:1.1em;border-radius:50%;background:var(--c,#888);box-shadow:0 0 0 .16em rgba(255,255,255,.85),0 0 1em var(--c,#888)}',
    '.cr-tt{display:flex;flex-direction:column;flex:1;min-width:0}',
    '.cr-who{font-size:1.35em;font-weight:900;letter-spacing:-.01em;white-space:nowrap}',
    '.cr-sub{font-size:.8em;opacity:.7;font-weight:700;white-space:nowrap}',
    '.cr-time{flex:none;font-size:2em;font-weight:900;min-width:1.4em;text-align:right;color:var(--c,#fff);text-shadow:0 0 .6em var(--c,transparent)}',
    '.cr-turn.low .cr-time{color:#ff5c6c;animation:cr-blink .5s ease-in-out infinite alternate}',
    '@keyframes cr-blink{to{opacity:.45}}',
    '.cr-bar{position:absolute;left:0;right:0;bottom:0;height:.28em;background:rgba(255,255,255,.1)}',
    '.cr-bar u{display:block;height:100%;width:100%;background:var(--c,#fff);box-shadow:0 0 .8em var(--c,#fff);transform-origin:left;text-decoration:none}',
    '.cr-main{display:grid;grid-template-columns:minmax(12em,17em) minmax(0,1fr) minmax(12em,17em);gap:1em;padding:0 1.2em 1em;min-height:0}',
    '.cr-col{display:flex;flex-direction:column;justify-content:center;gap:1em;min-width:0}',
    '.cr-stage{position:relative;min-width:0;min-height:0}',
    '.cr-cv{position:absolute;top:0;left:0;width:100%;height:100%}',
    '.cr-p{position:relative;padding:.8em 1em .9em;border-radius:1.2em;overflow:hidden;',
    'background:linear-gradient(160deg,rgba(255,255,255,.11),rgba(255,255,255,.03));',
    'border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);',
    'box-shadow:inset 0 1px rgba(255,255,255,.22),0 .6em 1.6em -.8em #000;opacity:.62;transform:scale(.97);',
    'transition:opacity .35s,transform .35s,box-shadow .35s,border-color .35s}',
    '.cr-p::before{content:"";position:absolute;left:0;top:0;bottom:0;width:.32em;background:var(--c);box-shadow:0 0 1em var(--c)}',
    '.cr-p.act{opacity:1;transform:scale(1.04);border-color:var(--c);box-shadow:inset 0 1px rgba(255,255,255,.3),0 0 2.6em -.5em var(--c)}',
    '.cr-p.off{opacity:.3;filter:grayscale(.8)}',
    '.cr-pt{display:flex;align-items:center;gap:.55em;font-size:1.05em}',
    '.cr-pd{width:.85em;height:.85em;border-radius:50%;background:var(--c);box-shadow:0 0 0 .13em rgba(255,255,255,.85),0 0 .8em var(--c)}',
    '.cr-pn{flex:1;font-weight:900;white-space:nowrap}.cr-ar{opacity:.65;font-size:.8em}',
    '.cr-pc{display:flex;align-items:center;gap:.6em;margin-top:.35em;font-size:.78em;opacity:.8;white-space:nowrap}',
    '.cr-chip{display:inline-flex;align-items:center;gap:.4em}',
    '.cr-chip i{width:.95em;height:.95em;border-radius:50%;display:inline-block;border:1px solid rgba(255,255,255,.55)}',
    '.cr-chip.w i{background:radial-gradient(circle at 35% 30%,#fff,#d9cdb4)}',
    '.cr-chip.b i{background:radial-gradient(circle at 35% 30%,#555,#050505)}',
    '.cr-chip.a i{background:linear-gradient(90deg,#fff 50%,#111 50%)}',
    '.cr-sc{font-size:3em;font-weight:900;line-height:1.05;margin-top:.1em;text-shadow:0 0 .5em var(--c)}',
    '.cr-p.flash .cr-sc{animation:cr-flash .7s ease-out}',
    '@keyframes cr-flash{0%{transform:scale(1.5);color:var(--c)}100%{transform:scale(1)}}',
    '.cr-toasts{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;z-index:4}',
    '.cr-toast{font-size:2.6em;font-weight:900;letter-spacing:-.01em;color:var(--c,#fff);text-shadow:0 0 .5em var(--c,#fff),0 .08em .3em #000;',
    'animation:cr-toast 1.5s cubic-bezier(.2,.8,.2,1) forwards;position:absolute}',
    '@keyframes cr-toast{0%{transform:translateY(.6em) scale(.6);opacity:0}18%{transform:scale(1.08);opacity:1}70%{opacity:1}100%{transform:translateY(-1.6em) scale(1);opacity:0}}',
    '.cr-ov{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;z-index:6;',
    'background:rgba(0,0,0,.6);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);opacity:0;pointer-events:none;transition:opacity .45s}',
    '.cr-ov.on{opacity:1}',
    '.cr-card{min-width:22em;max-width:86%;padding:1.8em 3em 2em;border-radius:1.8em;text-align:center;',
    'background:linear-gradient(160deg,rgba(255,255,255,.14),rgba(255,255,255,.04));border:1px solid rgba(255,255,255,.22);',
    'box-shadow:0 0 6em -1.5em var(--c,#8b6cff),inset 0 1px rgba(255,255,255,.3);transform:scale(.92);transition:transform .5s cubic-bezier(.2,.8,.2,1)}',
    '.cr-ov.on .cr-card{transform:scale(1)}',
    '.cr-k{display:inline-block;padding:.3em 1.2em;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);',
    'font-size:.9em;letter-spacing:.25em;font-weight:900}',
    '.cr-w{font-size:3.4em;font-weight:900;letter-spacing:-.02em;line-height:1.05;margin:.3em 0 .15em;color:var(--c,#fff);text-shadow:0 0 .6em var(--c,#fff)}',
    '.cr-m{font-size:1.1em;opacity:.75}',
    '.cr-st{margin:1.2em auto 0;display:flex;flex-direction:column;gap:.5em;min-width:17em}',
    '.cr-row{display:flex;align-items:center;gap:.7em;padding:.45em 1em;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12)}',
    '.cr-row.win{border-color:var(--c);box-shadow:0 0 1.4em -.3em var(--c)}',
    '.cr-row i{width:.8em;height:.8em;border-radius:50%;background:var(--c);box-shadow:0 0 .7em var(--c)}',
    '.cr-row span{flex:1;text-align:left}.cr-row b{font-size:1.2em}',
    '.cr-cta{margin-top:1.5em;font-size:1.05em;opacity:.9}',
    '.cr-key{display:inline-block;min-width:1.7em;padding:.05em .55em;border-radius:.5em;background:#fff;color:#000;font-weight:900;margin:0 .15em}',
    '.cr-root.narrow .cr-main{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto}',
    '.cr-root.narrow .cr-col{flex-direction:row;justify-content:center;flex-wrap:wrap}',
    '.cr-root.narrow .cr-p{min-width:9em}.cr-root.narrow .cr-sc{font-size:2em}'
  ].join('');

  /* ======================================================================
   * SOUND (WebAudio, procedural). Audio stays suspended until the TV page
   * has had one click / key / touch; we resume on any of those.
   * ==================================================================== */
  function makeSfx() {
    var ac = null, master = null, noise = null, lastHit = 0, lastWall = 0;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        ac = new AC();
        master = ac.createGain(); master.gain.value = 0.6;
        var comp = ac.createDynamicsCompressor(); master.connect(comp); comp.connect(ac.destination);
        var len = Math.floor(ac.sampleRate * 0.5); noise = ac.createBuffer(1, len, ac.sampleRate);
        var d = noise.getChannelData(0); for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
    } catch (e) { ac = null; }
    function now() { return ac.currentTime; }
    function env(gn, t, a, peak, dec) {
      gn.gain.setValueAtTime(0.0001, t);
      gn.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
    }
    function tone(freq, t, dur, type, peak, slideTo) {
      var o = ac.createOscillator(), gn = ac.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      env(gn, t, 0.004, peak, dur); o.connect(gn); gn.connect(master); o.start(t); o.stop(t + dur + 0.06);
    }
    function burst(t, dur, peak, freq, q, type) {
      var s = ac.createBufferSource(); s.buffer = noise;
      var f = ac.createBiquadFilter(); f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1;
      var gn = ac.createGain(); env(gn, t, 0.002, peak, dur);
      s.connect(f); f.connect(gn); gn.connect(master); s.start(t); s.stop(t + dur + 0.06);
    }
    function safe(fn) { return function () { if (!ac) return; try { fn.apply(null, arguments); } catch (e) { /* ignore */ } }; }
    return {
      resume: function () { if (ac && ac.state === 'suspended') { try { ac.resume(); } catch (e) { /* ignore */ } } },
      close: function () { if (ac) { try { ac.close(); } catch (e) { /* ignore */ } ac = null; } },
      hit: safe(function (v) {          // wooden "tock", v 0..1
        var t = now(); if (t - lastHit < 0.018) return; lastHit = t;
        var f = 1250 + Math.random() * 500 + v * 700;
        tone(f, t, 0.07, 'triangle', 0.1 + 0.4 * v, f * 0.55);
        burst(t, 0.03, 0.06 + 0.2 * v, 3200, 2);
      }),
      wall: safe(function (v) {         // softer thud
        var t = now(); if (t - lastWall < 0.04) return; lastWall = t;
        tone(210 + Math.random() * 40, t, 0.09, 'sine', 0.08 + 0.3 * v, 120);
        burst(t, 0.05, 0.04 + 0.12 * v, 900, 1, 'lowpass');
      }),
      pocket: safe(function () {        // drop + rattle
        var t = now();
        tone(300, t, 0.3, 'sine', 0.45, 70); burst(t, 0.2, 0.28, 700, 1.1);
        burst(t + 0.09, 0.05, 0.14, 2400, 2); burst(t + 0.16, 0.04, 0.1, 2000, 2);
      }),
      score: safe(function (big) {      // bell chime
        var t = now(), n = big ? [784, 988, 1175, 1568] : [880, 1320];
        for (var i = 0; i < n.length; i++) { tone(n[i], t + i * 0.08, 0.5, 'sine', 0.18, 0); tone(n[i] * 2, t + i * 0.08, 0.3, 'sine', 0.05, 0); }
      }),
      foul: safe(function () { var t = now(); tone(180, t, 0.4, 'sawtooth', 0.18, 70); tone(140, t + 0.12, 0.4, 'sawtooth', 0.14, 55); }),
      turn: safe(function () { var t = now(); tone(660, t, 0.12, 'sine', 0.12); tone(990, t + 0.07, 0.18, 'sine', 0.1); }),
      tick: safe(function () { tone(1400, now(), 0.05, 'square', 0.05); }),
      shot: safe(function (p) { var t = now(); burst(t, 0.12, 0.1 + 0.15 * p, 1800, 0.8, 'highpass'); tone(420, t, 0.1, 'triangle', 0.15, 160); }),
      win: safe(function () {
        var t = now(), n = [523, 659, 784, 1047, 1319];
        for (var i = 0; i < n.length; i++) { tone(n[i], t + i * 0.11, 0.6, 'triangle', 0.2, 0); tone(n[i] / 2, t + i * 0.11, 0.6, 'sine', 0.1, 0); }
      })
    };
  }

  /* ======================================================================
   * THE GAME (one instance per start())
   * ==================================================================== */
  function createGame(ctx) {
    var container = ctx.container, stopped = false;
    var COLORS = (ctx.colors && ctx.colors.length) ? ctx.colors :
      ((window.CFG && window.CFG.COLORS) || ['#8b6cff', '#00e0a4', '#ff5c8a', '#ffb020', '#2ec5ff']);
    var sfx = makeSfx();

    /* ---------- DOM ---------- */
    var root = document.createElement('div');
    root.className = 'cr-root';
    root.innerHTML = '<style>' + CSS + '</style>' +
      '<div class="cr-top"><div class="cr-turn"><i class="cr-dot"></i><div class="cr-tt"><span class="cr-who">Carrom</span>' +
      '<span class="cr-sub"></span></div><div class="cr-time"></div><div class="cr-bar"><u></u></div></div></div>' +
      '<div class="cr-main"><div class="cr-col cr-l"></div><div class="cr-stage"><canvas class="cr-cv"></canvas>' +
      '<div class="cr-toasts"></div></div><div class="cr-col cr-r"></div></div>' +
      '<div class="cr-ov"><div class="cr-card"></div></div>';
    container.appendChild(root);
    function q(s) { return root.querySelector(s); }
    var elTurn = q('.cr-turn'), elDot = q('.cr-dot'), elWho = q('.cr-who'), elSub = q('.cr-sub'),
      elTime = q('.cr-time'), elBar = q('.cr-bar u'), colL = q('.cr-l'), colR = q('.cr-r'),
      stage = q('.cr-stage'), cv = q('.cr-cv'), toasts = q('.cr-toasts'), ov = q('.cr-ov'), ovCard = q('.cr-card');
    var g = cv.getContext('2d');

    /* ---------- state ---------- */
    var players = [], seats = [], N = 0, seatSig = '#';
    var coins = [];
    var st = { kind: 's', x: 0, y: 0, vx: 0, vy: 0, r: R_STRK, m: M_STRK, alive: false, pop: 1, rot: 0 };
    var tgt = { x: 0, y: 0, v: 0.5 };
    var phase = 'wait';                 // wait | aim | move | over
    var started = false, turn = 0, seq = 0, bonus = false, timeLeft = TURN_TIME, absent = 0;
    var aim = { on: false, ang: 0, pow: 0, at: 0, dAng: 0, dPow: 0 };
    var shot = null, winInfo = null, overAt = 0, clock = 0, acc = 0;
    var warnText = '', warnId = 0, strikerBlocked = false, lastTickSec = -1;
    var impact = 0, wallImpact = 0;
    var parts = [], rings = [], sinks = [], ghosts = [], pops = [];
    var hb = 0, confT = 0;
    var raf = 0, lastT = 0, fs = 16;
    var sc = 1, dpr = 1, boardCv = null, spr = {}, strikerSpr = {};

    /* ======================================================================
     * SEATS / COINS
     * ==================================================================== */
    function buildSeats(list) {
      var n = Math.min(4, list.length), sides = SEAT_SIDES[n] || [];
      seats = [];
      for (var i = 0; i < n; i++) {
        var p = list[i];
        seats.push({
          id: p.id, idx: i, side: sides[i],
          team: n === 2 ? (i ? 'b' : 'w') : (n === 4 ? (i % 2 ? 'b' : 'w') : null),
          color: COLORS[p.slot % COLORS.length], name: 'Player ' + (p.slot + 1),
          score: 0, present: true, el: null
        });
      }
      N = n;
    }
    function seatById(id) { for (var i = 0; i < seats.length; i++) if (seats[i].id === id) return seats[i]; return null; }
    function presentCount() { var c = 0; for (var i = 0; i < seats.length; i++) if (seats[i].present) c++; return c; }
    function teamScore(t) { var s = 0; for (var i = 0; i < seats.length; i++) if (seats[i].team === t) s += seats[i].score; return s; }
    function owns(seat, c) { return c.t === 'q' || N === 3 || c.t === seat.team; }

    function layoutCoins() {
      coins = []; var id = 0, d = 2 * R_COIN + 0.8, k;
      function add(t, x, y) { coins.push({ kind: 'c', id: id++, t: t, x: x, y: y, vx: 0, vy: 0, r: R_COIN, m: M_COIN, alive: true, pop: 1, rot: Math.random() * 6.28 }); }
      add('q', 0, 0);
      for (k = 0; k < 6; k++) { var a = -Math.PI / 2 + k * Math.PI / 3; add(k % 2 ? 'b' : 'w', Math.cos(a) * d, Math.sin(a) * d); }
      for (k = 0; k < 12; k++) {
        var an = -Math.PI / 2 + k * Math.PI / 6, rad = (k % 2 === 0) ? 2 * d : Math.sqrt(3) * d;
        add(k % 2 ? 'b' : 'w', Math.cos(an) * rad, Math.sin(an) * rad);
      }
    }
    function aliveCoins() { var c = 0; for (var i = 0; i < coins.length; i++) if (coins[i].alive) c++; return c; }

    function baselinePos(side, v) {
      var f = SIDE_F[side], r = rgt(f), o = (v - 0.5) * 2 * RANGE;
      return [-f[0] * (H - BASE_OFF) + r[0] * o, -f[1] * (H - BASE_OFF) + r[1] * o];
    }
    function spotFree(x, y, rad) {
      if (Math.abs(x) > H - rad || Math.abs(y) > H - rad) return false;
      for (var i = 0; i < coins.length; i++) {
        var c = coins[i]; if (!c.alive) continue;
        var dx = c.x - x, dy = c.y - y, rr2 = c.r + rad + 0.5;
        if (dx * dx + dy * dy < rr2 * rr2) return false;
      }
      return true;
    }
    function findFree(x, y, rad) {
      if (spotFree(x, y, rad)) return [x, y];
      for (var rd = 6; rd < 340; rd += 6) {
        for (var k = 0; k < 24; k++) {
          var a = k * Math.PI / 12 + rd * 0.13, px = x + Math.cos(a) * rd, py = y + Math.sin(a) * rd;
          if (spotFree(px, py, rad)) return [px, py];
        }
      }
      return [x, y];
    }

    /* ======================================================================
     * TURN FLOW
     * ==================================================================== */
    function setStrikerTarget(seat, v) {
      tgt.v = clamp(v, 0, 1);
      var p = baselinePos(seat.side, tgt.v); tgt.x = p[0]; tgt.y = p[1];
    }
    function startTurn(idx, extra) {
      turn = idx; bonus = !!extra; seq++; phase = 'aim'; timeLeft = TURN_TIME; absent = 0; lastTickSec = -1;
      aim.on = false; aim.pow = aim.dPow = 0; aim.ang = aim.dAng = 0; shot = null; warnText = '';
      var seat = seats[turn], v = 0.5, i, off = [0, 0.05, -0.05, 0.1, -0.1, 0.15, -0.15, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4, 0.5, -0.5];
      for (i = 0; i < off.length; i++) {
        var p = baselinePos(seat.side, clamp(0.5 + off[i], 0, 1));
        if (spotFree(p[0], p[1], R_STRK + 1)) { v = clamp(0.5 + off[i], 0, 1); break; }
      }
      setStrikerTarget(seat, v);
      st.x = tgt.x; st.y = tgt.y; st.vx = st.vy = 0; st.alive = true; st.pop = 0;
      sfx.turn();
      rings.push({ x: st.x, y: st.y, t: 0, max: 0.7, col: seat.color, r0: R_STRK, r1: 80 });
      if (extra) toast('Extra turn', seat.color);
      elTurn.classList.remove('pulse'); void elTurn.offsetWidth; elTurn.classList.add('pulse');
      refreshHud(); pushState(true);
    }
    function nextSeatFrom(i, includeSelf) {
      for (var k = includeSelf ? 0 : 1; k <= N; k++) { var j = (i + k) % N; if (seats[j] && seats[j].present) return j; }
      return -1;
    }
    function advance(extra) {
      if (N < 2 || presentCount() < 2) { phase = 'wait'; st.alive = false; refreshHud(); pushState(true); return; }
      var idx = (extra && seats[turn].present) ? turn : nextSeatFrom(turn, false);
      startTurn(idx, extra && idx === turn);
    }
    function addScore(seat, pts, x, y) {
      seat.score += pts;
      var neg = pts < 0;
      pops.push({ x: x, y: y, text: (neg ? '-' : '+') + Math.abs(pts), col: neg ? '#ff5c6c' : seat.color, t: 0 });
      if (seat.el) { seat.el.classList.remove('flash'); void seat.el.offsetWidth; seat.el.classList.add('flash'); }
      refreshHud(); pushState(true);
    }

    function setPos(seat, v) { if (isFinite(v)) setStrikerTarget(seat, +v); }
    function doShoot(seat, msg) {
      var pow = clamp(+msg.pow || 0, 0, 1);
      if (pow < 0.05) return;
      if (msg.v != null && isFinite(msg.v)) setStrikerTarget(seat, +msg.v);
      st.x = tgt.x; st.y = tgt.y;
      if (!spotFree(st.x, st.y, R_STRK)) { warn('Striker is blocked - slide it'); return; }
      var ang = clamp(+msg.ang || 0, -MAX_ANG, MAX_ANG), f = SIDE_F[seat.side], r = rgt(f);
      var dx = f[0] * Math.cos(ang) + r[0] * Math.sin(ang), dy = f[1] * Math.cos(ang) + r[1] * Math.sin(ang);
      var sp = V_MIN + (V_MAX - V_MIN) * pow;
      st.vx = dx * sp; st.vy = dy * sp; st.alive = true; st.pop = 1;
      aim.on = false; started = true; phase = 'move';
      shot = { own: false, foul: false, returns: [], t: 0, still: 0 };
      sfx.shot(pow);
      rings.push({ x: st.x, y: st.y, t: 0, max: 0.45, col: seat.color, r0: R_STRK, r1: 60 });
      refreshHud(); pushState(true);
    }
    function warn(text) { warnText = text; warnId++; sfx.foul(); pushState(true); warnText = ''; }

    function endShot() {
      var seat = seats[turn], i, c;
      // opponent coins return to the centre
      for (i = 0; i < shot.returns.length; i++) {
        c = shot.returns[i];
        var p = findFree(0, 0, c.r); c.x = p[0]; c.y = p[1]; c.vx = c.vy = 0; c.alive = true; c.pop = 0;
        rings.push({ x: c.x, y: c.y, t: 0, max: 0.6, col: '#ffffff', r0: c.r, r1: 50 });
      }
      if (st.alive) { ghosts.push({ kind: 's', col: seat.color, x: st.x, y: st.y, t: 0 }); st.alive = false; }
      if (aliveCoins() === 0) { finish(); return; }
      var extra = shot.own && !shot.foul;
      shot = null;
      advance(extra);
    }
    function finish() {
      phase = 'over'; overAt = clock; st.alive = false; aim.on = false;
      var res = [], i, best = -1e9;
      if (N === 4) {
        var tw = teamScore('w'), tb = teamScore('b');
        res.push({ name: 'White team', sub: seats[0].name + ' + ' + seats[2].name, score: tw, color: seats[0].color, ids: [seats[0].id, seats[2].id] });
        res.push({ name: 'Black team', sub: seats[1].name + ' + ' + seats[3].name, score: tb, color: seats[1].color, ids: [seats[1].id, seats[3].id] });
      } else {
        for (i = 0; i < seats.length; i++) res.push({ name: seats[i].name, sub: '', score: seats[i].score, color: seats[i].color, ids: [seats[i].id] });
      }
      for (i = 0; i < res.length; i++) if (res[i].score > best) best = res[i].score;
      var win = res.filter(function (r) { return r.score === best; });
      var ids = []; win.forEach(function (w) { ids = ids.concat(w.ids); });
      res.sort(function (a, b) { return b.score - a.score; });
      winInfo = {
        ids: win.length === res.length && res.length > 1 ? [] : ids,
        draw: win.length > 1,
        title: win.length > 1 ? 'It\u2019s a draw!' : win[0].name + ' wins!',
        color: win.length > 1 ? '#ffffff' : win[0].color,
        sub: win.length > 1 ? 'Shared top score: ' + best : (win[0].sub || ''),
        rows: res
      };
      sfx.win();
      refreshHud(); renderOverlay(); pushState(true);
    }
    function resetGame() {
      started = false; winInfo = null; shot = null; parts = []; rings = []; sinks = []; ghosts = []; pops = [];
      layoutCoins(); seatSig = players.slice(0, 4).map(function (p) { return p.id; }).join(',');
      buildSeats(players); buildPanels();
      st.alive = false;
      if (N >= 2) startTurn(0, false); else { phase = 'wait'; refreshHud(); pushState(true); }
      renderOverlay();
    }

    /* ======================================================================
     * PHYSICS
     * ==================================================================== */
    var bodies = [];
    function pocketIndex(b) {
      for (var sx = -1; sx <= 1; sx += 2) for (var sy = -1; sy <= 1; sy += 2) {
        var dx = b.x - sx * PC, dy = b.y - sy * PC;
        if (dx * dx + dy * dy < POCKET_R * POCKET_R) return [sx, sy];
      }
      return null;
    }
    function pocketed(b, pk) {
      b.alive = false; b.vx = b.vy = 0;
      var px = pk[0] * PC, py = pk[1] * PC, seat = seats[turn];
      sinks.push({ kind: b.kind, t: b.t, col: seat.color, x: b.x, y: b.y, tx: px, ty: py, p: 0, rot: b.rot });
      sfx.pocket();
      var cols = b.kind === 's' ? [seat.color, '#ffffff'] : (b.t === 'w' ? ['#fff3d6', '#ffd37a'] : b.t === 'b' ? ['#8a8a98', '#ffd37a'] : ['#ff4d5e', '#ffd37a']);
      for (var i = 0; i < 22; i++) {
        var a = Math.random() * 6.283, s = 60 + Math.random() * 260;
        parts.push({ x: px, y: py, vx: Math.cos(a) * s - pk[0] * 60, vy: Math.sin(a) * s - pk[1] * 60, life: 0, max: 0.5 + Math.random() * 0.6, size: 2 + Math.random() * 3.5, col: cols[i % cols.length], add: true });
      }
      rings.push({ x: px, y: py, t: 0, max: 0.55, col: seat.color, r0: 20, r1: 110 });
      if (b.kind === 's') {
        shot.foul = true; addScore(seat, -PTS_FOUL, px - pk[0] * 90, py - pk[1] * 90);
        sfx.foul(); toast('Foul! Striker pocketed', '#ff5c6c');
      } else if (owns(seat, b)) {
        shot.own = true;
        var pts = b.t === 'q' ? PTS_QUEEN : PTS_COIN;
        addScore(seat, pts, px - pk[0] * 90, py - pk[1] * 90);
        sfx.score(b.t === 'q');
        if (b.t === 'q') toast('Queen! +50', '#ff6b7e');
      } else {
        shot.returns.push(b);
        toast('Opponent coin - returns to centre', '#ffffff');
      }
    }
    function sub(dt) {
      var i, j, b, a, nx, ny, d, d2, rs, sp, ns, f, it;
      for (i = 0; i < bodies.length; i++) {
        b = bodies[i]; if (!b.alive) continue;
        sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        if (sp > 0) {
          ns = sp * Math.exp(-K_DRAG * dt) - A_DRAG * dt;
          if (ns < V_STOP) { b.vx = b.vy = 0; }
          else { f = ns / sp; b.vx *= f; b.vy *= f; b.x += b.vx * dt; b.y += b.vy * dt; b.rot += ns * dt / b.r * 0.3; }
        }
      }
      for (i = 0; i < bodies.length; i++) {
        b = bodies[i]; if (!b.alive) continue;
        var pk = pocketIndex(b); if (pk) pocketed(b, pk);
      }
      for (it = 0; it < 2; it++) {
        for (i = 0; i < bodies.length; i++) {
          a = bodies[i]; if (!a.alive) continue;
          for (j = i + 1; j < bodies.length; j++) {
            b = bodies[j]; if (!b.alive) continue;
            var dx = b.x - a.x, dy = b.y - a.y; rs = a.r + b.r; d2 = dx * dx + dy * dy;
            if (d2 >= rs * rs) continue;
            d = Math.sqrt(d2); if (d < 1e-4) { dx = 1; dy = 0; d = 1e-4; }
            nx = dx / d; ny = dy / d;
            var ia = 1 / a.m, ib = 1 / b.m, corr = (rs - d) / (ia + ib);
            a.x -= nx * corr * ia; a.y -= ny * corr * ia; b.x += nx * corr * ib; b.y += ny * corr * ib;
            var rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
            if (rvn < 0) {
              var e = -rvn < 14 ? 0 : E_COIN, jn = -(1 + e) * rvn / (ia + ib);
              a.vx -= jn * ia * nx; a.vy -= jn * ia * ny; b.vx += jn * ib * nx; b.vy += jn * ib * ny;
              if (-rvn > impact) impact = -rvn;
            }
          }
        }
      }
      for (i = 0; i < bodies.length; i++) {
        b = bodies[i]; if (!b.alive) continue;
        var lim = H - b.r;
        if (b.x > lim) { b.x = lim; if (b.vx > 0) { if (b.vx > wallImpact) wallImpact = b.vx; b.vx = -b.vx * E_WALL; } }
        else if (b.x < -lim) { b.x = -lim; if (b.vx < 0) { if (-b.vx > wallImpact) wallImpact = -b.vx; b.vx = -b.vx * E_WALL; } }
        if (b.y > lim) { b.y = lim; if (b.vy > 0) { if (b.vy > wallImpact) wallImpact = b.vy; b.vy = -b.vy * E_WALL; } }
        else if (b.y < -lim) { b.y = -lim; if (b.vy < 0) { if (-b.vy > wallImpact) wallImpact = -b.vy; b.vy = -b.vy * E_WALL; } }
      }
    }
    function physicsStep(dt) {
      bodies.length = 0;
      for (var i = 0; i < coins.length; i++) if (coins[i].alive) bodies.push(coins[i]);
      if (st.alive) bodies.push(st);
      var h = dt / SUB;
      for (var s = 0; s < SUB; s++) sub(h);
      var moving = false;
      for (i = 0; i < bodies.length; i++) if (bodies[i].alive && (bodies[i].vx !== 0 || bodies[i].vy !== 0)) { moving = true; break; }
      if (impact > 40) sfx.hit(clamp(impact / 1800, 0.05, 1));
      if (wallImpact > 80) sfx.wall(clamp(wallImpact / 1500, 0.05, 1));
      if (impact > 260) { for (var k = 0; k < 2; k++) { /* tiny sparks on hard hits */ } }
      impact = 0; wallImpact = 0;
      return moving;
    }

    /* ======================================================================
     * LOGIC STEP (fixed 60 Hz)
     * ==================================================================== */
    function logicStep(dt) {
      clock += dt;
      var seat = seats[turn], i;
      if (phase === 'wait') {
        if (N >= 2 && presentCount() >= 2) { if (started) advance(false); else startTurn(0, false); }
      } else if (phase === 'aim') {
        if (presentCount() < 2) { phase = 'wait'; st.alive = false; refreshHud(); pushState(true); return; }
        if (!seat.present) { absent += dt; if (absent > 0.9) { toast(seat.name + ' left - skipped', '#ffffff'); advance(false); } return; }
        timeLeft -= dt;
        var sec = Math.ceil(timeLeft);
        if (timeLeft <= 5 && sec !== lastTickSec && timeLeft > 0) { lastTickSec = sec; sfx.tick(); }
        if (aim.on && clock - aim.at > 1.2) aim.on = false;      // finger lost
        var k = Math.min(1, dt * 22); st.x += (tgt.x - st.x) * k; st.y += (tgt.y - st.y) * k;
        if (st.pop < 1) st.pop = Math.min(1, st.pop + dt * 4.5);
        if (timeLeft <= 0) {
          toast('Time up - turn skipped', '#ffffff'); sfx.foul();
          ghosts.push({ kind: 's', col: seat.color, x: st.x, y: st.y, t: 0 }); st.alive = false; aim.on = false;
          advance(false);
        }
      } else if (phase === 'move') {
        shot.t += dt;
        var moving = physicsStep(dt);
        if (!moving) shot.still += dt; else shot.still = 0;
        if (shot.still >= SETTLE || shot.t > 14) {
          for (i = 0; i < coins.length; i++) { coins[i].vx = coins[i].vy = 0; }
          st.vx = st.vy = 0; endShot();
        }
      }
      hb += dt;
      if (hb > (phase === 'aim' ? 0.4 : 1.0)) { hb = 0; pushState(false); }
    }

    /* ======================================================================
     * INPUT FROM THE HOST
     * ==================================================================== */
    function onInput(slot, msg) {
      if (stopped || !msg) return;
      var seat = seatById(msg.id), i;
      if (!seat) { for (i = 0; i < players.length; i++) if (players[i].slot === slot) { seat = seatById(players[i].id); break; } }
      if (!seat || phase !== 'aim' || seats[turn] !== seat) return;
      if (msg.a === 'pos') setPos(seat, msg.v);
      else if (msg.a === 'aim') {
        aim.on = !!msg.on; aim.at = clock;
        aim.ang = clamp(+msg.ang || 0, -MAX_ANG, MAX_ANG); aim.pow = clamp(+msg.pow || 0, 0, 1);
        if (aim.on && aim.dPow < 0.02) { aim.dAng = aim.ang; }
      } else if (msg.a === 'shoot') doShoot(seat, msg);
    }
    function onButton(slot, key) {
      if (stopped) return;
      sfx.resume();
      if (phase === 'over' && slot === 0 && (key === 'cr' || key === 'start') && clock - overAt > OVER_LOCK) resetGame();
    }
    function applyPlayers(list) {
      if (stopped) return;
      players = (list || []).slice().sort(function (a, b) { return a.slot - b.slot; });
      var i;
      if (!started && phase !== 'over') {
        var sig = players.slice(0, 4).map(function (p) { return p.id; }).join(',');
        if (sig !== seatSig) {
          seatSig = sig; buildSeats(players); buildPanels(); layoutCoins(); parts = []; sinks = [];
          if (N >= 2) startTurn(0, false); else { phase = 'wait'; st.alive = false; refreshHud(); pushState(true); }
          renderOverlay();
        }
      } else {
        for (i = 0; i < seats.length; i++) {
          var here = false;
          for (var j = 0; j < players.length; j++) if (players[j].id === seats[i].id) here = true;
          seats[i].present = here;
        }
        refreshHud(); renderOverlay(); pushState(true);
      }
    }

    /* ======================================================================
     * STATE TO PHONES
     * ==================================================================== */
    function pushState() {
      if (!ctx.send) return;
      var cur = seats[turn];
      var payload = {
        g: 'carrom', ph: phase, turn: cur ? cur.id : null, ti: turn, seq: seq,
        t: Math.round(Math.max(0, timeLeft) * 10) / 10, tmax: TURN_TIME, bonus: bonus, n: N,
        seats: seats.map(function (s) { return { id: s.id, name: s.name, color: s.color, side: s.side, team: s.team, score: s.score, present: s.present }; }),
        win: phase === 'over' && winInfo ? { title: winInfo.title, sub: winInfo.sub, ids: winInfo.ids, draw: winInfo.draw } : null,
        warn: warnText, wid: warnId
      };
      try { var r = ctx.send('gstate', payload); if (r && r.catch) r.catch(function () {}); } catch (e) { /* ignore */ }
    }

    /* ======================================================================
     * HUD
     * ==================================================================== */
    function toast(text, col) {
      var d = document.createElement('div'); d.className = 'cr-toast'; d.textContent = text;
      d.style.setProperty('--c', col || '#fff'); toasts.appendChild(d);
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 1600);
    }
    function buildPanels() {
      colL.innerHTML = ''; colR.innerHTML = '';
      var left = [], right = [];
      seats.forEach(function (s) {
        var d = document.createElement('div'); d.className = 'cr-p'; d.style.setProperty('--c', s.color);
        var chip = N === 3 ? '<span class="cr-chip a"><i></i>Any coin</span>' :
          '<span class="cr-chip ' + s.team + '"><i></i>' + (s.team === 'w' ? 'White' : 'Black') + '</span>';
        d.innerHTML = '<div class="cr-pt"><i class="cr-pd"></i><span class="cr-pn">' + s.name + '</span><span class="cr-ar">' + ARROWS[s.side] + '</span></div>' +
          '<div class="cr-pc">' + chip + '<span class="cr-tm"></span></div><div class="cr-sc">0</div>';
        s.el = d; s.scEl = d.querySelector('.cr-sc'); s.tmEl = d.querySelector('.cr-tm');
        (s.side <= 1 ? left : right).push(s);
      });
      left.sort(function (a, b) { return b.side - a.side; });
      right.sort(function (a, b) { return a.side - b.side; });
      left.forEach(function (s) { colL.appendChild(s.el); });
      right.forEach(function (s) { colR.appendChild(s.el); });
    }
    function refreshHud() {
      var cur = seats[turn], i, s;
      for (i = 0; i < seats.length; i++) {
        s = seats[i];
        s.el.classList.toggle('act', (phase === 'aim' || phase === 'move') && s === cur);
        s.el.classList.toggle('off', !s.present);
        if (s.scEl.textContent !== String(s.score)) s.scEl.textContent = s.score;
        s.tmEl.textContent = N === 4 ? 'Team ' + teamScore(s.team) : '';
      }
      var who = 'Carrom', col = '#8b6cff';
      if ((phase === 'aim' || phase === 'move') && cur) { who = cur.name + '\u2019s turn' + (bonus ? ' \u00B7 extra' : ''); col = cur.color; }
      else if (phase === 'wait') who = 'Waiting for players';
      else if (phase === 'over') who = 'Game over';
      elWho.textContent = who; elTurn.style.setProperty('--c', col); elDot.style.background = col;
    }
    function hudTick() {
      var sub = '', tm = '';
      if (phase === 'aim') {
        tm = String(Math.max(0, Math.ceil(timeLeft)));
        sub = aim.on ? 'Aiming \u00B7 power ' + Math.round(aim.pow * 100) + '%' : 'Slide the striker, pull back and release';
        elBar.style.transform = 'scaleX(' + clamp(timeLeft / TURN_TIME, 0, 1) + ')';
      } else if (phase === 'move') { sub = 'Shot in play'; elBar.style.transform = 'scaleX(1)'; }
      else if (phase === 'wait') { sub = 'Carrom needs 2 to 4 players'; elBar.style.transform = 'scaleX(0)'; }
      else { elBar.style.transform = 'scaleX(0)'; }
      if (elTime.textContent !== tm) elTime.textContent = tm;
      if (elSub.textContent !== sub) elSub.textContent = sub;
      elTurn.classList.toggle('low', phase === 'aim' && timeLeft <= 5);
    }
    function renderOverlay() {
      if (phase === 'over' && winInfo) {
        ov.classList.add('on'); ovCard.style.setProperty('--c', winInfo.color);
        var rows = winInfo.rows.map(function (r, i) {
          var w = !winInfo.draw && i === 0 || (winInfo.draw && r.score === winInfo.rows[0].score);
          return '<div class="cr-row' + (w ? ' win' : '') + '" style="--c:' + r.color + '"><i></i><span>' + r.name + '</span><b>' + r.score + '</b></div>';
        }).join('');
        ovCard.innerHTML = '<span class="cr-k">GAME OVER</span><div class="cr-w">' + winInfo.title + '</div><div class="cr-m">' + winInfo.sub + '</div>' +
          '<div class="cr-st">' + rows + '</div>' +
          '<div class="cr-cta">Player 1: press <span class="cr-key">\u2715</span> to play again \u00B7 <span class="cr-key">Select</span> for the menu</div>';
      } else if (phase === 'wait') {
        ov.classList.add('on'); ovCard.style.setProperty('--c', '#8b6cff');
        var have = players.length, left = started;
        ovCard.innerHTML = '<span class="cr-k">CARROM</span><div class="cr-w" style="font-size:2.6em">' + (left ? 'Player disconnected' : 'Waiting for players') + '</div>' +
          '<div class="cr-m">' + (left ? 'The game continues when enough players are back.' : 'Carrom is for 2 to 4 players. ' + have + ' connected.') + '</div>';
      } else ov.classList.remove('on');
    }

    /* ======================================================================
     * RENDERING
     * ==================================================================== */
    function mkCv(size) { var c = document.createElement('canvas'); c.width = c.height = Math.max(2, Math.ceil(size)); return c; }

    function buildBoard() {
      var S = Math.ceil(2 * HALF * sc) + 2; boardCv = mkCv(S);
      var b = boardCv.getContext('2d'), rnd = prng(11), i, k, x;
      b.translate(S / 2, S / 2); b.scale(sc, sc);
      // frame
      var fg = b.createLinearGradient(-HALF, -HALF, HALF, HALF);
      fg.addColorStop(0, '#6e4121'); fg.addColorStop(0.3, '#8a5528'); fg.addColorStop(0.55, '#5a3217'); fg.addColorStop(0.8, '#744420'); fg.addColorStop(1, '#4a2a12');
      rr(b, -HALF, -HALF, 2 * HALF, 2 * HALF, 30); b.fillStyle = fg; b.fill();
      b.save(); rr(b, -HALF, -HALF, 2 * HALF, 2 * HALF, 30); b.clip();
      for (i = 0; i < 190; i++) {
        var y0 = -HALF + rnd() * 2 * HALF, amp = 1 + rnd() * 3.5, ph = rnd() * 6, fr = 0.004 + rnd() * 0.01;
        b.beginPath();
        for (x = -HALF; x <= HALF; x += 22) { var yy = y0 + Math.sin(x * fr + ph) * amp; if (x === -HALF) b.moveTo(x, yy); else b.lineTo(x, yy); }
        b.strokeStyle = rnd() < 0.55 ? 'rgba(25,10,0,' + (0.05 + rnd() * 0.13) + ')' : 'rgba(255,205,150,' + (0.03 + rnd() * 0.08) + ')';
        b.lineWidth = 0.8 + rnd() * 1.8; b.stroke();
      }
      b.restore();
      rr(b, -HALF + 2, -HALF + 2, 2 * HALF - 4, 2 * HALF - 4, 28); b.strokeStyle = 'rgba(255,214,160,.38)'; b.lineWidth = 3; b.stroke();
      rr(b, -HALF, -HALF, 2 * HALF, 2 * HALF, 30); b.strokeStyle = 'rgba(0,0,0,.7)'; b.lineWidth = 2; b.stroke();
      // rail lip
      rr(b, -H - 13, -H - 13, 2 * H + 26, 2 * H + 26, 10); b.fillStyle = '#2b160a'; b.fill();
      rr(b, -H - 12, -H - 12, 2 * H + 24, 2 * H + 24, 9); b.strokeStyle = 'rgba(238,198,118,.6)'; b.lineWidth = 1.5; b.stroke();
      // playing surface
      var sg = b.createRadialGradient(0, 0, 30, 0, 0, H * 1.35);
      sg.addColorStop(0, '#f4dba6'); sg.addColorStop(0.6, '#e4bf84'); sg.addColorStop(1, '#c79e68');
      b.fillStyle = sg; b.fillRect(-H, -H, 2 * H, 2 * H);
      b.save(); b.beginPath(); b.rect(-H, -H, 2 * H, 2 * H); b.clip();
      for (i = 0; i < 120; i++) {
        var gy = -H + rnd() * 2 * H, ga = 0.6 + rnd() * 1.6, gp = rnd() * 6, gf = 0.003 + rnd() * 0.008;
        b.beginPath();
        for (x = -H; x <= H; x += 26) { var gg = gy + Math.sin(x * gf + gp) * ga; if (x === -H) b.moveTo(x, gg); else b.lineTo(x, gg); }
        b.strokeStyle = 'rgba(120,70,20,' + (0.04 + rnd() * 0.07) + ')'; b.lineWidth = 0.7 + rnd() * 1.1; b.stroke();
      }
      var vg = b.createRadialGradient(0, 0, H * 0.6, 0, 0, H * 1.42);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(70,35,5,.28)'); b.fillStyle = vg; b.fillRect(-H, -H, 2 * H, 2 * H);
      b.restore();
      // inlay: corner arcs
      var INK = 'rgba(78,44,18,.85)';
      for (var sx = -1; sx <= 1; sx += 2) for (var sy = -1; sy <= 1; sy += 2) {
        var base = Math.atan2(-sy, -sx);
        b.beginPath(); b.arc(sx * PC, sy * PC, 96, base - Math.PI / 4, base + Math.PI / 4); b.strokeStyle = INK; b.lineWidth = 2.2; b.stroke();
        b.beginPath(); b.arc(sx * PC, sy * PC, 108, base - Math.PI / 5, base + Math.PI / 5); b.setLineDash([2, 7]); b.lineWidth = 1.6; b.stroke(); b.setLineDash([]);
        for (k = -1; k <= 1; k += 2) {
          var ea = base + k * Math.PI / 4, ex = sx * PC + Math.cos(ea) * 96, ey = sy * PC + Math.sin(ea) * 96;
          b.save(); b.translate(ex, ey); b.rotate(Math.PI / 4); b.fillStyle = 'rgba(150,40,40,.85)'; b.fillRect(-5, -5, 10, 10); b.restore();
        }
      }
      // baselines
      for (k = 0; k < 4; k++) {
        var f = SIDE_F[k], rv = rgt(f), cx = -f[0] * (H - BASE_OFF), cy = -f[1] * (H - BASE_OFF);
        b.save(); b.translate(cx, cy); b.rotate(Math.atan2(rv[1], rv[0]));
        var L = RANGE + R_STRK + 9, w = R_STRK + 7;
        rr(b, -L, -w, 2 * L, 2 * w, w); b.strokeStyle = INK; b.lineWidth = 2.2; b.stroke();
        b.setLineDash([10, 9]); b.beginPath(); b.moveTo(-RANGE, 0); b.lineTo(RANGE, 0); b.lineWidth = 1.2; b.stroke(); b.setLineDash([]);
        for (var s2 = -1; s2 <= 1; s2 += 2) {
          b.save(); b.translate(s2 * RANGE, 0); b.rotate(Math.PI / 4); b.fillStyle = 'rgba(150,40,40,.9)'; b.fillRect(-6, -6, 12, 12); b.restore();
          b.beginPath(); b.arc(s2 * RANGE, 0, R_COIN + 4, 0, 6.283); b.lineWidth = 1.4; b.stroke();
        }
        b.restore();
      }
      // centre medallion
      b.strokeStyle = INK;
      b.beginPath(); b.arc(0, 0, 78, 0, 6.283); b.lineWidth = 2.6; b.stroke();
      b.beginPath(); b.arc(0, 0, 58, 0, 6.283); b.lineWidth = 1.3; b.setLineDash([6, 6]); b.stroke(); b.setLineDash([]);
      for (k = 0; k < 24; k++) {
        var ta = k * Math.PI / 12; b.beginPath(); b.moveTo(Math.cos(ta) * 78, Math.sin(ta) * 78); b.lineTo(Math.cos(ta) * (k % 3 === 0 ? 92 : 86), Math.sin(ta) * (k % 3 === 0 ? 92 : 86)); b.lineWidth = 1.4; b.stroke();
      }
      for (k = 0; k < 2; k++) {
        b.save(); b.rotate(k * Math.PI / 4); b.strokeRect(-40, -40, 80, 80); b.restore();
      }
      b.beginPath(); b.arc(0, 0, 21, 0, 6.283); b.fillStyle = 'rgba(160,40,45,.2)'; b.fill(); b.lineWidth = 1.4; b.stroke();
      // pockets
      for (sx = -1; sx <= 1; sx += 2) for (sy = -1; sy <= 1; sy += 2) {
        var px = sx * PC, py = sy * PC;
        var rg = b.createLinearGradient(px - 36, py - 36, px + 36, py + 36);
        rg.addColorStop(0, '#f7df93'); rg.addColorStop(0.5, '#a97a2a'); rg.addColorStop(1, '#f1d37a');
        b.beginPath(); b.arc(px, py, POCKET_R + 6, 0, 6.283); b.fillStyle = rg; b.fill();
        var hg = b.createRadialGradient(px - 5, py - 5, 3, px, py, POCKET_R);
        hg.addColorStop(0, '#2a2118'); hg.addColorStop(0.55, '#060403'); hg.addColorStop(1, '#000');
        b.beginPath(); b.arc(px, py, POCKET_R, 0, 6.283); b.fillStyle = hg; b.fill();
        b.beginPath(); b.arc(px, py, POCKET_R, 0, 6.283); b.strokeStyle = 'rgba(0,0,0,.8)'; b.lineWidth = 2; b.stroke();
      }
    }

    function coinSprite(t) {
      var rp = R_COIN * sc, s = Math.ceil(rp * 2 + 8), c = mkCv(s), p = c.getContext('2d'), m = s / 2;
      var c0, c1, ridge, petal;
      if (t === 'w') { c0 = '#fffaf0'; c1 = '#cfc2a6'; ridge = 'rgba(120,95,50,.32)'; petal = 'rgba(120,95,50,.4)'; }
      else if (t === 'b') { c0 = '#4a4a54'; c1 = '#08080b'; ridge = 'rgba(255,255,255,.14)'; petal = 'rgba(255,255,255,.2)'; }
      else { c0 = '#ff7a86'; c1 = '#9c0f2a'; ridge = 'rgba(255,220,150,.45)'; petal = 'rgba(255,225,160,.8)'; }
      var gr = p.createRadialGradient(m - rp * 0.3, m - rp * 0.35, rp * 0.1, m, m, rp);
      gr.addColorStop(0, c0); gr.addColorStop(1, c1);
      p.beginPath(); p.arc(m, m, rp, 0, 6.283); p.fillStyle = gr; p.fill();
      p.lineWidth = Math.max(1, rp * 0.09); p.strokeStyle = t === 'b' ? 'rgba(255,255,255,.35)' : (t === 'q' ? 'rgba(255,215,120,.9)' : 'rgba(90,70,40,.55)');
      p.beginPath(); p.arc(m, m, rp - p.lineWidth / 2, 0, 6.283); p.stroke();
      p.strokeStyle = ridge; p.lineWidth = Math.max(1, rp * 0.05);
      p.beginPath(); p.arc(m, m, rp * 0.74, 0, 6.283); p.stroke();
      p.beginPath(); p.arc(m, m, rp * 0.52, 0, 6.283); p.stroke();
      p.strokeStyle = petal;
      for (var k = 0; k < 6; k++) {
        p.save(); p.translate(m, m); p.rotate(k * Math.PI / 3);
        p.beginPath(); p.ellipse(0, -rp * 0.3, rp * 0.1, rp * 0.2, 0, 0, 6.283); p.stroke(); p.restore();
      }
      var hl = p.createRadialGradient(m - rp * 0.38, m - rp * 0.45, 0, m - rp * 0.38, m - rp * 0.45, rp * 0.55);
      hl.addColorStop(0, 'rgba(255,255,255,' + (t === 'b' ? 0.4 : 0.6) + ')'); hl.addColorStop(1, 'rgba(255,255,255,0)');
      p.beginPath(); p.arc(m, m, rp, 0, 6.283); p.fillStyle = hl; p.fill();
      return c;
    }
    function strikerSprite(col) {
      var rp = R_STRK * sc, s = Math.ceil(rp * 2 + 10), c = mkCv(s), p = c.getContext('2d'), m = s / 2;
      var gr = p.createRadialGradient(m - rp * 0.25, m - rp * 0.3, rp * 0.05, m, m, rp);
      gr.addColorStop(0, mix(col, 255, 0.75)); gr.addColorStop(0.55, col); gr.addColorStop(1, mix(col, 0, 0.55));
      p.beginPath(); p.arc(m, m, rp, 0, 6.283); p.fillStyle = gr; p.fill();
      p.lineWidth = Math.max(1.5, rp * 0.1); p.strokeStyle = 'rgba(255,255,255,.9)';
      p.beginPath(); p.arc(m, m, rp - p.lineWidth / 2, 0, 6.283); p.stroke();
      p.strokeStyle = 'rgba(255,255,255,.5)'; p.lineWidth = Math.max(1, rp * 0.05);
      p.beginPath(); p.arc(m, m, rp * 0.7, 0, 6.283); p.stroke();
      p.beginPath(); p.arc(m, m, rp * 0.42, 0, 6.283); p.stroke();
      p.fillStyle = 'rgba(255,255,255,.85)'; p.beginPath(); p.arc(m, m, rp * 0.1, 0, 6.283); p.fill();
      var hl = p.createRadialGradient(m - rp * 0.4, m - rp * 0.5, 0, m - rp * 0.4, m - rp * 0.5, rp * 0.6);
      hl.addColorStop(0, 'rgba(255,255,255,.75)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
      p.beginPath(); p.arc(m, m, rp, 0, 6.283); p.fillStyle = hl; p.fill();
      return c;
    }
    function buildSprites() {
      spr = { w: coinSprite('w'), b: coinSprite('b'), q: coinSprite('q') }; strikerSpr = {};
      var rp = R_COIN * sc * 1.25, s = Math.ceil(rp * 2 + 4), c = mkCv(s), p = c.getContext('2d'), m = s / 2;
      var gr = p.createRadialGradient(m, m, rp * 0.4, m, m, rp);
      gr.addColorStop(0, 'rgba(30,12,0,.5)'); gr.addColorStop(1, 'rgba(30,12,0,0)');
      p.fillStyle = gr; p.beginPath(); p.arc(m, m, rp, 0, 6.283); p.fill(); spr.sh = c;
    }
    function strikerFor(col) { return strikerSpr[col] || (strikerSpr[col] = strikerSprite(col)); }
    function blit(img, x, y, scl, rot, alpha) {
      var w = img.width / sc * scl, h = img.height / sc * scl;
      g.save(); g.globalAlpha = alpha == null ? 1 : alpha; g.translate(x, y); if (rot) g.rotate(rot);
      g.drawImage(img, -w / 2, -h / 2, w, h); g.restore();
    }
    function sprFor(b) { return b.kind === 's' ? strikerFor(seats[turn] ? seats[turn].color : '#8b6cff') : spr[b.t]; }

    function castRay(sx, sy, dx, dy) {
      var best = 900, hit = null, i, c;
      for (i = 0; i < coins.length; i++) {
        c = coins[i]; if (!c.alive) continue;
        var ox = c.x - sx, oy = c.y - sy, proj = ox * dx + oy * dy; if (proj < 0) continue;
        var R = R_STRK + c.r, p2 = ox * ox + oy * oy - proj * proj; if (p2 > R * R) continue;
        var t = proj - Math.sqrt(R * R - p2); if (t > 0 && t < best) { best = t; hit = c; }
      }
      var lim = H - R_STRK, tx = dx > 0 ? (lim - sx) / dx : (dx < 0 ? (-lim - sx) / dx : 1e9), ty = dy > 0 ? (lim - sy) / dy : (dy < 0 ? (-lim - sy) / dy : 1e9);
      var tw = Math.min(tx, ty); if (tw < best) { best = Math.max(0, tw); hit = null; }
      return { t: best, coin: hit };
    }

    function drawSeatMarkers() {
      for (var i = 0; i < seats.length; i++) {
        var s = seats[i], f = SIDE_F[s.side], r = rgt(f), act = (phase === 'aim' || phase === 'move') && i === turn;
        var cx = -f[0] * 392, cy = -f[1] * 392, pulse = act ? 0.75 + 0.25 * Math.sin(clock * 6) : 0;
        g.save(); g.translate(cx, cy); g.rotate(Math.atan2(r[1], r[0]));
        g.lineCap = 'round'; g.lineWidth = 8;
        g.strokeStyle = rgba(s.color, act ? 0.55 + 0.45 * pulse : (s.present ? 0.32 : 0.1));
        if (act) { g.shadowColor = s.color; g.shadowBlur = 26 * sc; }
        g.beginPath(); g.moveTo(-170, 0); g.lineTo(170, 0); g.stroke(); g.shadowBlur = 0;
        g.fillStyle = rgba('#ffe9c8', act ? 0.95 : 0.5); g.font = '800 13px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(s.name.toUpperCase(), 0, 17);
        g.restore();
      }
    }
    function drawAim(seat) {
      if (phase !== 'aim' || !aim.on) return;
      var f = SIDE_F[seat.side], r = rgt(f), a = aim.dAng, p = aim.dPow;
      var dx = f[0] * Math.cos(a) + r[0] * Math.sin(a), dy = f[1] * Math.cos(a) + r[1] * Math.sin(a);
      var ray = castRay(st.x, st.y, dx, dy), ex = st.x + dx * ray.t, ey = st.y + dy * ray.t;
      var hue = 130 - 130 * p, pc = 'hsl(' + hue + ',95%,60%)';
      g.save(); g.lineCap = 'round';
      // slingshot band behind the striker
      var tail = R_STRK + 14 + p * 105, tx = st.x - dx * tail, ty = st.y - dy * tail, px = -dy * R_STRK * 0.85, py = dx * R_STRK * 0.85;
      g.strokeStyle = rgba(seat.color, 0.85); g.lineWidth = 3.2;
      g.beginPath(); g.moveTo(st.x + px, st.y + py); g.lineTo(tx, ty); g.lineTo(st.x - px, st.y - py); g.stroke();
      g.fillStyle = seat.color; g.beginPath(); g.arc(tx, ty, 6, 0, 6.283); g.fill();
      // dotted guide
      g.setLineDash([12, 11]); g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,' + (0.35 + 0.45 * p) + ')';
      g.beginPath(); g.moveTo(st.x + dx * (R_STRK + 4), st.y + dy * (R_STRK + 4)); g.lineTo(ex, ey); g.stroke(); g.setLineDash([]);
      g.beginPath(); g.arc(ex, ey, R_STRK, 0, 6.283); g.setLineDash([4, 6]); g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 2; g.stroke(); g.setLineDash([]);
      if (ray.coin) {
        var nx = ray.coin.x - ex, ny = ray.coin.y - ey, nl = Math.sqrt(nx * nx + ny * ny) || 1;
        g.strokeStyle = 'rgba(255,230,150,.8)'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(ray.coin.x, ray.coin.y);
        g.lineTo(ray.coin.x + nx / nl * 80, ray.coin.y + ny / nl * 80); g.stroke();
      }
      // power gauge ring + arrow
      g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.arc(st.x, st.y, R_STRK + 12, 0, 6.283); g.stroke();
      g.strokeStyle = pc; g.shadowColor = pc; g.shadowBlur = 12 * sc;
      g.beginPath(); g.arc(st.x, st.y, R_STRK + 12, -Math.PI / 2, -Math.PI / 2 + p * 6.283); g.stroke(); g.shadowBlur = 0;
      var al = R_STRK + 18 + p * 60, ax = st.x + dx * al, ay = st.y + dy * al;
      g.strokeStyle = pc; g.fillStyle = pc; g.lineWidth = 5;
      g.beginPath(); g.moveTo(st.x + dx * (R_STRK + 14), st.y + dy * (R_STRK + 14)); g.lineTo(ax, ay); g.stroke();
      g.beginPath(); g.moveTo(ax + dx * 16, ay + dy * 16); g.lineTo(ax - dy * 10, ay + dx * 10); g.lineTo(ax + dy * 10, ay - dx * 10); g.closePath(); g.fill();
      g.fillStyle = '#fff'; g.font = '900 20px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(Math.round(p * 100) + '%', st.x, st.y - R_STRK - 34 * (dy > 0 ? -1 : 1));
      g.restore();
    }

    function updateFx(dt) {
      var i, p;
      for (i = parts.length - 1; i >= 0; i--) {
        p = parts[i]; p.life += dt; if (p.life >= p.max) { parts.splice(i, 1); continue; }
        p.x += p.vx * dt; p.y += p.vy * dt; var dr = Math.exp(-2.4 * dt); p.vx *= dr; p.vy *= dr;
      }
      for (i = rings.length - 1; i >= 0; i--) { rings[i].t += dt; if (rings[i].t >= rings[i].max) rings.splice(i, 1); }
      for (i = sinks.length - 1; i >= 0; i--) { sinks[i].p += dt / 0.32; if (sinks[i].p >= 1) sinks.splice(i, 1); }
      for (i = ghosts.length - 1; i >= 0; i--) { ghosts[i].t += dt; if (ghosts[i].t >= 0.5) ghosts.splice(i, 1); }
      for (i = pops.length - 1; i >= 0; i--) { pops[i].t += dt; if (pops[i].t >= 1.3) pops.splice(i, 1); }
      for (i = 0; i < coins.length; i++) if (coins[i].pop < 1) coins[i].pop = Math.min(1, coins[i].pop + dt * 3);
      var ka = Math.min(1, dt * 18); aim.dAng += (aim.ang - aim.dAng) * ka; aim.dPow += (aim.pow - aim.dPow) * ka;
      if (phase === 'over') {
        confT -= dt;
        if (confT <= 0) {
          confT = 0.28; var cols = [winInfo ? winInfo.color : '#fff', '#ffd37a', '#ffffff', '#ff6fa5', '#3ee0c4'];
          var bx = (Math.random() * 2 - 1) * 300, by = (Math.random() * 2 - 1) * 300;
          for (i = 0; i < 26; i++) {
            var a = Math.random() * 6.283, s = 80 + Math.random() * 320;
            parts.push({ x: bx, y: by, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 0.8 + Math.random() * 0.9, size: 2.5 + Math.random() * 3.5, col: cols[i % cols.length], add: true });
          }
        }
      }
    }

    function draw() {
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height);
      if (!boardCv) return;
      var i, b, seat = seats[turn];
      g.drawImage(boardCv, Math.round((cv.width - boardCv.width) / 2), Math.round((cv.height - boardCv.height) / 2));
      g.translate(cv.width / 2, cv.height / 2); g.scale(sc, sc);
      drawSeatMarkers();
      for (i = 0; i < coins.length; i++) { b = coins[i]; if (b.alive) blit(spr.sh, b.x + 2.5, b.y + 4, b.pop, 0, 1); }
      if (st.alive) blit(spr.sh, st.x + 3, st.y + 5, 1.15 * st.pop, 0, 1);
      for (i = 0; i < sinks.length; i++) {            // coins dropping into a pocket
        var sk = sinks[i], e = sk.p * sk.p, sx = sk.x + (sk.tx - sk.x) * e, sy = sk.y + (sk.ty - sk.y) * e;
        blit(sk.kind === 's' ? strikerFor(sk.col) : spr[sk.t], sx, sy, 1 - 0.7 * sk.p, sk.rot, 1 - sk.p * 0.8);
      }
      for (i = 0; i < ghosts.length; i++) { var gh = ghosts[i]; blit(strikerFor(gh.col), gh.x, gh.y, 1 + gh.t * 0.5, 0, 0.8 * (1 - gh.t / 0.5)); }
      for (i = 0; i < coins.length; i++) {
        b = coins[i]; if (!b.alive) continue;
        blit(spr[b.t], b.x, b.y, b.pop < 1 ? easeOutBack(b.pop) : 1, b.rot, b.pop < 1 ? Math.min(1, b.pop * 2) : 1);
      }
      if (seat && st.alive) {
        if (phase === 'aim') {
          drawAim(seat);
          strikerBlocked = !spotFree(tgt.x, tgt.y, R_STRK);
        } else strikerBlocked = false;
        var sc2 = phase === 'aim' ? easeOutBack(st.pop) : 1;
        blit(strikerFor(seat.color), st.x, st.y, Math.max(0.01, sc2), st.rot, 1);
        if (strikerBlocked) {
          g.strokeStyle = 'rgba(255,70,90,' + (0.6 + 0.4 * Math.sin(clock * 12)) + ')'; g.lineWidth = 4;
          g.beginPath(); g.arc(st.x, st.y, R_STRK + 6, 0, 6.283); g.stroke();
          g.beginPath(); g.moveTo(st.x - 12, st.y - 12); g.lineTo(st.x + 12, st.y + 12); g.moveTo(st.x + 12, st.y - 12); g.lineTo(st.x - 12, st.y + 12); g.stroke();
        }
      }
      for (i = 0; i < rings.length; i++) {
        var rg = rings[i], k = rg.t / rg.max;
        g.strokeStyle = rgba(rg.col, 0.8 * (1 - k)); g.lineWidth = 4 * (1 - k) + 1;
        g.beginPath(); g.arc(rg.x, rg.y, rg.r0 + (rg.r1 - rg.r0) * (1 - (1 - k) * (1 - k)), 0, 6.283); g.stroke();
      }
      g.globalCompositeOperation = 'lighter';
      for (i = 0; i < parts.length; i++) {
        var p = parts[i], kk = 1 - p.life / p.max;
        g.globalAlpha = Math.max(0, kk); g.fillStyle = p.col;
        g.beginPath(); g.arc(p.x, p.y, p.size * (0.4 + 0.6 * kk), 0, 6.283); g.fill();
      }
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '900 30px ' + FONT;
      for (i = 0; i < pops.length; i++) {
        var pp = pops[i], pk = pp.t / 1.3;
        g.globalAlpha = pk < 0.7 ? 1 : 1 - (pk - 0.7) / 0.3;
        g.fillStyle = '#000'; g.fillText(pp.text, pp.x + 1.5, pp.y - pk * 60 + 2);
        g.fillStyle = pp.col; g.fillText(pp.text, pp.x, pp.y - pk * 60);
      }
      g.globalAlpha = 1;
    }

    function resize() {
      if (stopped) return;
      var w = container.clientWidth || root.clientWidth || 1280, h = container.clientHeight || root.clientHeight || 720;
      fs = clamp(Math.min(h / 46, w / 88), 8, 30); root.style.fontSize = fs + 'px';
      root.classList.toggle('narrow', w / h < 1.3);
      var r = stage.getBoundingClientRect(), sw = Math.max(10, r.width), sh = Math.max(10, r.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.max(2, Math.round(sw * dpr)); cv.height = Math.max(2, Math.round(sh * dpr));
      sc = Math.min(cv.width, cv.height) / (2 * HALF) * 0.985;
      buildBoard(); buildSprites();
    }

    function frame(t) {
      if (stopped) return;
      raf = requestAnimationFrame(frame);
      var dt = Math.min(0.1, (t - lastT) / 1000 || 0); lastT = t;
      acc += dt;
      while (acc >= DT) { acc -= DT; logicStep(DT); if (stopped) return; }
      updateFx(dt); draw(); hudTick();
    }

    /* ---------- boot ---------- */
    function wake() { sfx.resume(); }
    var wakeEv = ['pointerdown', 'keydown', 'touchstart', 'click'];
    wakeEv.forEach(function (ev) { document.addEventListener(ev, wake, true); });
    var ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(function () { resize(); }); ro.observe(container); }
    window.addEventListener('resize', resize);

    layoutCoins();
    resize();
    applyPlayers(ctx.players || []);
    renderOverlay(); refreshHud();
    lastT = (window.performance && performance.now) ? performance.now() : 0;
    raf = requestAnimationFrame(frame);

    function stop() {
      if (stopped) return;
      stopped = true; cancelAnimationFrame(raf);
      wakeEv.forEach(function (ev) { document.removeEventListener(ev, wake, true); });
      window.removeEventListener('resize', resize);
      if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } }
      sfx.close();
      if (root.parentNode) root.parentNode.removeChild(root);
    }
    return { stop: stop, onPlayers: applyPlayers, onButton: onButton, onInput: onInput };
  }

  /* ======================================================================
   * PUBLIC API
   * ==================================================================== */
  var inst = null;
  window.NovaGames.carrom = {
    start: function (ctx) {
      if (inst) { inst.stop(); inst = null; }
      inst = createGame(ctx);
    },
    stop: function () { if (inst) { inst.stop(); inst = null; } },
    onPlayers: function (players) { if (inst) inst.onPlayers(players); },
    onButton: function (slot, key) { if (inst) inst.onButton(slot, key); },
    onInput: function (slot, msg) { if (inst) inst.onInput(slot, msg); }
  };
})();
