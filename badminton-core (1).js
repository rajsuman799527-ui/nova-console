/* ===========================================================================
 * Smash Court  -  badminton rules, physics, AI  (NO Three.js, NO DOM)
 * File 1 of 4 for NOVA game id 'badminton'.   Exposes  window.SmashCore.
 * ---------------------------------------------------------------------------
 * Pure simulation so it can be unit tested in Node (see tests/badminton-test.js).
 *
 * WORLD AXES (metres)
 *   x : to the RIGHT as seen from the broadcast camera
 *   y : up
 *   z : towards the camera.  The net is at z = 0.
 *   Team side sign: +1 = NEAR side (z > 0, camera is behind it), -1 = FAR side.
 *   A player on side s faces -s*z, so his racket hand (right) is at x = +s.
 *   Controls are SCREEN RELATIVE for everyone: stick up = -z, stick right = +x.
 *
 * TIME: the sim advances in fixed steps of STEP = 1/120 s. The shuttle and the
 * shot solver use the very same integrator, so a solved shot lands exactly where
 * the aim ring showed.
 * ========================================================================= */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------- CONSTANTS */
  var C = {
    HL: 6.7,                 // half court length (net to back line)
    HWS: 2.59, HWD: 3.05,    // half width singles / doubles
    SSL: 1.98,               // short service line (distance from net)
    LSLD: 5.94,              // doubles long service line (distance from net)
    NET: 1.524, NETP: 1.55,  // net height centre / posts
    POSTX: 3.4,              // post x
    G: 9.4, K: 0.15,         // gravity, quadratic drag (terminal speed ~ 7.9 m/s)
    STEP: 1 / 120,
    LINE: 0.04               // a shuttle touching the line is IN
  };
  var SHOTS = {
    //            launch elevation, max launch speed, default depth (0 net .. 1 baseline), contact delay s, ideal contact height
    clear:   { th: 0.84,  vmax: 36,  df: 0.94, dl: 0.13, yi: 2.3 },
    lift:    { th: 0.98,  vmax: 38,  df: 0.90, dl: 0.12, yi: 0.6 },
    drop:    { th: 0.10,  vmax: 22,  df: 0.15, dl: 0.10, yi: 1.8 },
    netdrop: { th: 0.30,  vmax: 16,  df: 0.07, dl: 0.10, yi: 0.8 },
    drive:   { th: 0.05,  vmax: 55,  df: 0.74, dl: 0.08, yi: 1.4 },
    smash:   { th: -0.42, vmax: 80,  df: 0.62, dl: 0.20, yi: 2.7 },
    super:   { th: -0.55, vmax: 100, df: 0.66, dl: 0.24, yi: 2.9 }
  };
  var SERVES = { drop: 'short', clear: 'high', drive: 'flat', smash: 'flat', super: 'flat' };
  var AI_LEVELS = [   // easy, normal, hard
    { rt: 0.34, spd: 0.84, err: 1.5, miss: 0.22, smash: 0.25, drop: 0.12, dive: 0.0, pos: 1.1 },
    { rt: 0.20, spd: 0.96, err: 0.85, miss: 0.09, smash: 0.45, drop: 0.20, dive: 0.5, pos: 0.6 },
    { rt: 0.10, spd: 1.06, err: 0.40, miss: 0.025, smash: 0.62, drop: 0.28, dive: 1.0, pos: 0.25 }
  ];
  var LADDER = [   // five solo opponents: name, character index, play style (bias for smash / drop / clear)
    { name: 'Pip',   ch: 4, sty: { smash: -0.1, drop: 0.1 }, rating: 1010 },
    { name: 'Nova',  ch: 2, sty: { smash: 0.0, drop: 0.0 },  rating: 1180 },
    { name: 'Sol',   ch: 3, sty: { smash: 0.05, drop: 0.1 }, rating: 1330 },
    { name: 'Rusty', ch: 1, sty: { smash: 0.2, drop: -0.1 }, rating: 1490 },
    { name: 'Bruno', ch: 5, sty: { smash: 0.12, drop: 0.12 }, rating: 1650 }
  ];

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function sgn(v) { return v < 0 ? -1 : 1; }
  function rng(seed) {                         // mulberry32, deterministic
    var a = seed >>> 0;
    function r() { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
    r.gauss = function () { return (r() + r() + r() + r() - 2) * 1.732; };
    return r;
  }
  function approach(v, t, d) { return v < t ? Math.min(t, v + d) : Math.max(t, v - d); }

  /* ------------------------------------------------------- SHUTTLE PHYSICS */
  function netTop(x) { var q = Math.min(1, Math.abs(x) / C.POSTX); return C.NET + (C.NETP - C.NET) * q * q; }
  /* One fixed step. Quadratic drag, gravity, net and floor.
   * Sets s.netted (hit the net this step) and s.landed (reached the floor; s.lx,s.lz = exact landing point). */
  function stepShuttle(s, h) {
    var sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz), d = C.K * sp;
    s.vx -= s.vx * d * h; s.vy -= (s.vy * d + C.G) * h; s.vz -= s.vz * d * h;
    var px = s.x, py = s.y, pz = s.z;
    s.x += s.vx * h; s.y += s.vy * h; s.z += s.vz * h;
    s.netted = false;
    if (!s.netDone && pz !== s.z && pz * s.z <= 0) {          // crossed the net plane
      var f = pz / (pz - s.z), cy = py + (s.y - py) * f, cx = px + (s.x - px) * f;
      s.crossY = cy;
      if (Math.abs(cx) < C.POSTX && cy - 0.05 < netTop(cx)) {  // below the tape: net fault, shuttle drops back
        s.netted = true; s.netDone = true; s.netY = cy;
        s.z = pz * 0.98; s.x = cx; s.y = Math.max(cy, 0.05);
        s.vz = -s.vz * 0.10; s.vx *= 0.25; s.vy = Math.min(s.vy * 0.15, 0.4);
      } else s.netDone = true;
    }
    if (s.y <= 0 && !s.landed) {
      var g = py / Math.max(1e-6, py - s.y);
      s.lx = lerp(px, s.x, g); s.lz = lerp(pz, s.z, g); s.y = 0; s.landed = true;
    }
  }
  var _t = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, netDone: false, landed: false };
  /* Simulate a launch; returns hdist (horizontal distance to landing), crossY (height over the net, or null). */
  function simLaunch(x0, y0, z0, vx, vy, vz, out) {
    var s = _t, n = 0;
    s.x = x0; s.y = y0; s.z = z0; s.vx = vx; s.vy = vy; s.vz = vz; s.netDone = false; s.landed = false; s.crossY = null; s.netted = false;
    while (!s.landed && n < 1000) { stepShuttle(s, C.STEP); n++; if (s.netted) break; }
    out.hd = Math.hypot((s.landed ? s.lx : s.x) - x0, (s.landed ? s.lz : s.z) - z0); out.crossY = s.crossY; out.t = n * C.STEP; out.netted = s.netted;
    out.lx = s.landed ? s.lx : s.x; out.lz = s.landed ? s.lz : s.z;
    return out;
  }
  var _o = {};
  /* Solve the launch speed so the shuttle lands on (tx,tz) with elevation th; raises th until the net is cleared. */
  function solveShot(x0, y0, z0, tx, tz, th, vmax, res) {
    var dx = tx - x0, dz = tz - z0, D = Math.hypot(dx, dz) || 0.01, ux = dx / D, uz = dz / D, k, ok = false, v = 10, cr = true;
    var crosses = z0 * tz < 0;
    for (k = 0; k < 9; k++) {
      var t = th + k * 0.07, ct = Math.cos(t), st = Math.sin(t), lo = 2, hi = vmax, it;
      simLaunch(x0, y0, z0, hi * ct * ux, hi * st, hi * ct * uz, _o);
      if (_o.hd < D) { v = hi; }
      else { for (it = 0; it < 22; it++) { v = (lo + hi) * 0.5; simLaunch(x0, y0, z0, v * ct * ux, v * st, v * ct * uz, _o); if (_o.hd < D) lo = v; else hi = v; } v = (lo + hi) * 0.5; }
      simLaunch(x0, y0, z0, v * ct * ux, v * st, v * ct * uz, _o);
      cr = !crosses || (_o.crossY != null && _o.crossY > C.NETP + 0.16);
      if (cr) { ok = true; th = t; break; }
      th = t;
    }
    res.vx = v * Math.cos(th) * ux; res.vy = v * Math.sin(th); res.vz = v * Math.cos(th) * uz; res.speed = v; res.th = th; res.ok = ok; res.lx = _o.lx; res.lz = _o.lz; res.t = _o.t;
    return res;
  }

  /* ------------------------------------------------------- RULES HELPERS */
  function gameWon(a, b, P) { return (a >= P && a - b >= 2) || a >= P + 4; }          // win by 2, cap at +4
  function inCourt(x, z, dbl) { return Math.abs(x) <= (dbl ? C.HWD : C.HWS) + C.LINE && Math.abs(z) <= C.HL + C.LINE; }
  /* service court check: tcs = world x sign of the court the serve must land in, rs = receiving side sign */
  function inServe(x, z, tcs, rs, dbl) {
    var d = Math.abs(z);
    return z * rs > 0 && d >= C.SSL - C.LINE && d <= (dbl ? C.LSLD : C.HL) + C.LINE && Math.abs(x) <= (dbl ? C.HWD : C.HWS) + C.LINE && x * tcs >= -C.LINE;
  }

  /* =========================================================================
   * createSim(cfg)
   *  cfg: { mode:'solo'|'1v1'|'2v2', points:7|11|21, bestOf:1|3, diff:0..2, ladder:0..4, seed,
   *         entries:[{id,human,name,char,team,assist}] }
   * ======================================================================= */
  function createSim(cfg) {
    var STEP = C.STEP, R = rng(cfg.seed || 1234567), dbl = cfg.mode === '2v2', P = cfg.points || 11, BO = cfg.bestOf === 3 ? 3 : 1;
    var sim = { events: [], t: 0, phase: 'intro', phaseT: 0, C: C, SHOTS: SHOTS };
    var sideSign = [1, -1], teams = [{ idx: 0, players: [], score: 0, games: 0, court: [0, 1] }, { idx: 1, players: [], score: 0, games: 0, court: [0, 1] }];
    var players = [], byId = {}, gameNo = 1, gameLog = [], serveTeam = 0, serverP = null, recvP = null, rallyN = 0, longest = 0, over = false, winnerTeam = -1;
    var sh = { x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 0, ox: 0, oy: 1, oz: 0, held: true, in: false, lastTeam: -1, last: null, shot: '', hits: 0, k: 0, path: null, pathN: 0,
               netted: false, netDone: false, landed: false, lx: 0, lz: 0, serveFirst: false, cool: 0, tFly: 0, spin: 0 };
    var pending = null, midSwitched = false, pauseSnap = false;
    sim.shuttle = sh; sim.players = players; sim.teams = teams; sim.sideSign = sideSign;

    /* ---------------------------------------------------------- PLAYERS */
    function mkPlayer(e, team) {
      var p = { id: e.id, human: !!e.human, name: e.name, char: e.char | 0, team: team, side: 1,
        x: 0, z: 0, y: 0, ox: 0, oz: 0, oy: 0, vx: 0, vz: 0, face: 0, state: 'idle', st: 0, runPh: 0,
        in: { x: 0, y: 0, t: -9 }, req: null, sw: null, jump: -1, jumpH: 0, dive: -1, rec: 0, cd: 0, energy: 0, assist: e.assist !== false,
        lastSeq: -1, flash: 0, tq: 0, ai: null, cpuName: e.cpu || '',
        stats: { pts: 0, winners: 0, smashes: 0, perfects: 0, hits: 0, errors: 0, supers: 0 }, diveCd: 0, idleT: 0 };
      if (!p.human) p.ai = { rt: 0, seq: -1, has: false, tx: 0, tz: 0, hit: false, serveT: 0, lv: null, sty: e.sty || { smash: 0, drop: 0 } };
      return p;
    }
    cfg.entries.forEach(function (e) {
      var p = mkPlayer(e, e.team); players.push(p); byId[p.id] = p; teams[e.team].players.push(p);
    });
    teams.forEach(function (t) { t.players.forEach(function (p, i) { p.idx = i; }); t.court = t.players.length > 1 ? [0, 1] : [0, 0]; });
    function lvOf(p) {   // fractional AI level (0 easy .. 2 hard), diff plus ladder bonus
      var sk = clamp((cfg.diff == null ? 1 : cfg.diff) + (cfg.ladder || 0) * 0.17, 0, 2), i = Math.min(1, Math.floor(sk)), f = sk - i, a = AI_LEVELS[i], b = AI_LEVELS[i + 1], o = {};
      for (var k in a) o[k] = lerp(a[k], b[k], f);
      return o;
    }
    players.forEach(function (p) { if (p.ai) p.ai.lv = lvOf(p); });
    function emit(o) { sim.events.push(o); }
    function other(t) { return 1 - t; }
    function serverOf(t) { var T = teams[t]; return T.players.length > 1 ? T.players[T.court[T.score % 2]] : T.players[0]; }
    function recvOf(t, sc) { var T = teams[t]; return T.players.length > 1 ? T.players[T.court[sc % 2]] : T.players[0]; }
    function courtX(t, c) { return (c === 0 ? 1 : -1) * sideSign[t]; }   // world x sign of team t's right(0)/left(1) service court

    /* ------------------------------------------------- SHUTTLE PATH CACHE */
    /* Pre-simulates the current flight with the exact integrator (used by AI, assist and swing look-ahead). */
    var _c = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, netDone: false, landed: false };
    function buildPath() {
      var s = _c, n = 0, arr = sh.pathBuf || (sh.pathBuf = new Float32Array(3 * 800));
      s.x = sh.x; s.y = sh.y; s.z = sh.z; s.vx = sh.vx; s.vy = sh.vy; s.vz = sh.vz; s.netDone = sh.netDone; s.landed = false;
      arr[0] = s.x; arr[1] = s.y; arr[2] = s.z; n = 1;
      while (!s.landed && n < 799) { stepShuttle(s, STEP); arr[n * 3] = s.x; arr[n * 3 + 1] = s.y; arr[n * 3 + 2] = s.z; n++; }
      sh.path = arr; sh.pathN = n; sh.k = 0; sh.pLx = s.landed ? s.lx : s.x; sh.pLz = s.landed ? s.lz : s.z; sh.pLt = n * STEP;
    }
    /* first path index >= k0 where the shuttle is descending through height H (or the landing) */
    function pathAtHeight(H, out) {
      var a = sh.path, n = sh.pathN, k = Math.max(1, sh.k);
      for (; k < n; k++) if (a[k * 3 + 1] <= H && a[k * 3 + 1] < a[k * 3 - 2]) break;
      k = Math.min(k, n - 1); out.x = a[k * 3]; out.y = a[k * 3 + 1]; out.z = a[k * 3 + 2]; out.t = (k - sh.k) * STEP; return out;
    }

    /* ---------------------------------------------------------- GEOMETRY */
    function rightSign(p) { return p.side; }                          // world x of the racket hand relative to the body
    function reachR(p, type) { return p.dive >= 0 ? 2.35 : (type === 'smash' || type === 'super' ? 1.6 : 1.72); }
    function canReachPt(p, x, y, z, type) {
      if (z * p.side < -0.25) return false;                                   // still on the other side of the net
      var ax = p.x + rightSign(p) * 0.28, d = Math.hypot(x - ax, z - p.z), ymax = p.dive >= 0 ? 1.45 : (type === 'smash' || type === 'super' ? 3.35 : 3.0);
      return d <= reachR(p, type) && y >= 0.08 && y <= ymax;
    }
    function nearestOpp(p) {                                           // position of the opposing player closest to the net-side centre
      var T = teams[other(p.team)].players, best = T[0], i;
      for (i = 1; i < T.length; i++) if (Math.abs(T[i].z) < Math.abs(best.z)) best = T[i];
      return best;
    }

    /* ------------------------------------------------------------ SERVES */
    function placeForServe() {
      var st = serveTeam, rt = other(st), c = teams[st].score % 2, T, i, c2;
      serverP = serverOf(st); recvP = recvOf(rt, teams[st].score);
      for (var t = 0; t < 2; t++) {
        T = teams[t];
        for (i = 0; i < T.players.length; i++) {
          var p = T.players[i]; p.side = sideSign[t];
          c2 = T.players.length > 1 ? (T.court[0] === i ? 0 : 1) : c;
          var cx = courtX(t, c2) * (dbl ? 1.5 : 1.35), cz;
          if (p === serverP) cz = 2.75; else if (p === recvP) cz = 4.1; else cz = (t === st ? 1.7 : 2.2);
          p.x = p.ox = cx; p.z = p.oz = sideSign[t] * cz; p.vx = p.vz = 0; p.y = p.oy = 0; p.req = null; p.sw = null; p.jump = p.dive = -1; p.jumpH = 0; p.rec = 0; p.state = 'idle'; p.st = 0; p.cd = 0;
          if (p.ai) { p.ai.has = false; p.ai.seq = -1; p.ai.serveT = 0.9 + R() * 0.9; }
        }
      }
      sh.held = true; sh.in = false; sh.last = null; sh.lastTeam = -1; sh.hits = 0; sh.shot = ''; sh.path = null; sh.serveFirst = true; sh.netDone = false; sh.landed = false; sh.netted = false;
      holdShuttle(); rallyN = 0; sim.phase = 'serve'; sim.phaseT = 0; sim.serveP = serverP; sim.recvP = recvP;
      emit({ t: 'serve', server: serverP.id, team: st, court: c });
    }
    function holdShuttle() {
      var p = serverP; sh.x = sh.ox = p.x + p.side * 0.38; sh.z = sh.oz = p.z - p.side * 0.35; sh.y = sh.oy = 1.12; sh.vx = sh.vy = sh.vz = 0;
    }
    function startServeSwing(p, type, ax, ay) {
      p.sw = { type: 'serve', k: type, wait: 0, t: 0, dur: 0.55, contact: 0.34, done: false, side: 'fh', ax: ax, ay: ay, press: sim.t };
      p.req = null; p.state = 'serve'; p.st = 0;
    }
    function doServe(p, kind, ax, ay) {
      var rs = -p.side, t = p.team, sc = teams[t].score, c = T_court(p), tcs = -courtX(t, c), q = SERVES[kind] || 'short', dz, wob = 0.15;
      var hwid = dbl ? C.HWD : C.HWS;
      var lat = clamp(1.45 + (ax * tcs > 0 ? ax * tcs : ax * tcs * 0.6) * 1.0, 0.45, hwid - 0.25);
      dz = q === 'short' ? C.SSL + 0.5 : (q === 'flat' ? 4.1 : (dbl ? 5.55 : 6.2));
      var level = p.ai ? p.ai.lv.err : 0.2, bad = p.ai && R() < p.ai.lv.miss * 0.5;
      var tx = tcs * lat + R.gauss() * wob * (1 + level), tz = rs * (dz + R.gauss() * wob * (1 + level));
      if (bad) tz = rs * (C.SSL - 0.5);                                        // AI service fault: short
      var spec = q === 'short' ? { th: 0.32, vmax: 14 } : (q === 'high' ? { th: 1.0, vmax: 34 } : { th: 0.18, vmax: 40 }), res = {};
      solveShot(sh.x, sh.y, sh.z, tx, tz, spec.th, spec.vmax, res);
      launch(p, res, q === 'high' ? 'clear' : (q === 'short' ? 'drop' : 'drive'), 0.5, true);
      sim.phase = 'rally'; sim.phaseT = 0;
      emit({ t: 'hit', id: p.id, team: p.team, shot: 'serve', serve: q, q: 0.5, lvl: 'good', x: sh.x, y: sh.y, z: sh.z, speed: res.speed, perfect: false });
    }
    function T_court(p) { var T = teams[p.team]; return T.players.length > 1 ? (T.court[0] === p.idx ? 0 : 1) : T.score % 2; }

    /* ----------------------------------------------------------- HITTING */
    function launch(p, res, shot, q, isServe) {
      sh.held = false; sh.in = true; sh.vx = res.vx; sh.vy = res.vy; sh.vz = res.vz; sh.last = p; sh.lastTeam = p.team; sh.shot = shot; sh.hits++; sh.cool = 0.14; sh.tFly = 0;
      sh.netDone = false; sh.landed = false; sh.netted = false; sh.serveFirst = !!isServe; sh.spin = 0; sh.lq = q;
      sh.ox = sh.x; sh.oy = sh.y; sh.oz = sh.z;
      buildPath(); rallyN++; if (rallyN > longest) longest = rallyN;
    }
    function lvlName(q) { return q >= 0.8 ? 'perfect' : (q >= 0.55 ? 'good' : (q >= 0.3 ? 'ok' : 'weak')); }
    var ERR = { perfect: 0.12, good: 0.42, ok: 0.9, weak: 1.9 };
    function defaultAim(p) {                                            // neutral aim: away from the closest opponent
      var o = nearestOpp(p), tx = -sgn(o.x || (R() < 0.5 ? 1 : -1)) * (0.9 + R() * 1.3);
      return tx;
    }
    function chooseType(p, y) {                                         // shot used by the assist circle
      var near = Math.abs(p.z) < 3.4;
      if (y < 0.9 && near) return 'lift';
      if (y > 2.0 && near && p.energy < 1) return 'drive';
      return near && y < 1.4 && R() < 0.35 ? 'netdrop' : 'clear';
    }
    function hit(p, sw) {                                               // contact! returns true when the shuttle was struck
      var type = sw.k, x = sh.x, y = sh.y, z = sh.z, auto = !!sw.auto, i;
      if (type === 'smash' && y < 1.6) type = 'drive';                      // not high enough for a smash
      if (type === 'super' && y < 1.2) type = 'drive';
      if (type === 'clear' && y < 0.9 && Math.abs(z) < 3.4) type = 'lift';
      if (type === 'drop' && y < 1.1 && Math.abs(z) < 2.6) type = 'netdrop';
      var spec = SHOTS[type];
      var ax = p.x + rightSign(p) * 0.28, dh = Math.max(0, Math.hypot(x - ax, z - p.z) - 0.25), d3 = Math.hypot(dh, 0.55 * (y - spec.yi));
      var Rq = p.dive >= 0 ? 2.1 : 1.65, q = clamp(1 - d3 / Rq, 0, 1);
      var lead = sim.t - (sw.press == null ? sim.t : sw.press);
      if (!auto && lead > spec.dl + 0.22) q = Math.min(q, 0.74);          // pressed way too early
      if (auto) q = Math.min(q, 0.62);
      if (p.ai) q = clamp(q + R.gauss() * 0.12 * p.ai.lv.err - (R() < p.ai.lv.miss * 0.6 ? 0.5 : 0), 0, type === 'super' ? 1 : 0.97);
      if (type === 'super') q = Math.max(q, 0.85);
      var lvl = lvlName(q), side = p.side;
      // ---- aim
      var aimx = sw.ax || 0, aimy = sw.ay || 0, mag = Math.hypot(aimx, aimy);
      if (p.human && p.in && (sim.t - p.in.t) < 0.3 && Math.hypot(p.in.x, p.in.y) > 0.25) { aimx = p.in.x; aimy = p.in.y; mag = Math.hypot(aimx, aimy); }
      var range = dbl ? 2.75 : 2.45, tx, away = side > 0 ? -aimy : aimy;   // away>0 : towards the opponent's baseline
      if (p.ai) { tx = sw.tx; away = sw.away || 0; mag = 1; }
      else { var neutral = defaultAim(p); tx = lerp(neutral, aimx * range, clamp(mag * 2.6, 0, 1)); }
      var df = spec.df;
      if (type === 'drop') df = clamp(0.10 + (away + 1) * 0.10, 0.08, 0.32);
      else if (type === 'netdrop') df = clamp(0.05 + (away + 1) * 0.04, 0.04, 0.16);
      else if (type === 'smash') df = clamp(0.58 + away * 0.2 + (lvl === 'perfect' ? 0.06 : 0), 0.34, 0.9);
      else if (type === 'super') df = clamp(0.62 + away * 0.18, 0.4, 0.9);
      else df = clamp(spec.df + away * (type === 'drive' ? 0.16 : 0.06), 0.4, 0.97);
      if (lvl === 'weak' && type !== 'drop' && type !== 'netdrop') df *= 0.76; else if (lvl === 'ok') df *= 0.93;
      var tz = -side * (0.45 + df * (C.HL - 0.9));
      var e = ERR[lvl] * (type === 'smash' ? 1.15 : 1) * (p.ai ? (0.6 + p.ai.lv.err * 0.7) : 1); if (type === 'super') e = 0.05;
      tx += R.gauss() * e * 0.6; tz += R.gauss() * e * 0.6;
      tx = clamp(tx, -(dbl ? C.HWD : C.HWS) - (lvl === 'weak' ? 1.2 : 0), (dbl ? C.HWD : C.HWS) + (lvl === 'weak' ? 1.2 : 0));
      // human shots: keep a perfect / good shot inside the lines, only weak ones may go out
      if (!p.ai && (lvl === 'perfect' || lvl === 'good')) { tx = clamp(tx, -(dbl ? C.HWD : C.HWS) + 0.15, (dbl ? C.HWD : C.HWS) - 0.15); tz = side > 0 ? clamp(tz, -(C.HL - 0.12), -0.9) : clamp(tz, 0.9, C.HL - 0.12); }
      var th = spec.th;
      if (type === 'smash') th = lvl === 'perfect' ? -0.6 : (lvl === 'good' ? -0.5 : (lvl === 'ok' ? -0.36 : -0.22));
      if (type === 'drive' && lvl === 'weak' && R() < 0.35) th = -0.12;       // sloppy flat drive may find the net
      var res = {}, vmax = spec.vmax * (lvl === 'weak' ? 0.85 : 1);
      solveShot(x, y, z, tx, tz, th, vmax, res);
      sh.x = x; sh.y = y; sh.z = z;
      launch(p, res, type, q, false);
      // ---- bookkeeping: energy, stats, events
      p.stats.hits++; p.flash = 0.35; p.tq = q;
      var gain = auto ? 0.02 : (lvl === 'perfect' ? 0.17 : (lvl === 'good' ? 0.08 : 0.02)); if (type === 'smash' && !auto) gain += 0.07;
      if (type === 'super') { p.energy = 0; p.stats.supers++; } else p.energy = Math.min(1, p.energy + gain);
      if (lvl === 'perfect') p.stats.perfects++; if (type === 'smash' || type === 'super') p.stats.smashes++;
      sw.shot = type; sw.hitLvl = lvl; sw.hitSide = sw.side;
      emit({ t: 'hit', id: p.id, team: p.team, shot: type, serve: '', q: q, lvl: lvl, perfect: lvl === 'perfect' && !auto, auto: auto, x: x, y: y, z: z, speed: res.speed, tx: tx, tz: tz, lx: res.lx, lz: res.lz, ok: res.ok });
      return true;
    }

    /* Try to turn a queued request into a swing. Look ahead 0.35 s along the shuttle's pre-computed path. */
    function tryStartSwing(p) {
      var rq = p.req; if (!rq || p.sw || p.cd > 0 || p.rec > 0) return;
      var age = sim.t - rq.t0, type = rq.k;
      if (sim.phase === 'serve' && p === serverP) { startServeSwing(p, type, rq.ax, rq.ay); return; }
      var incoming = sim.phase === 'rally' && sh.lastTeam !== p.team && sh.path && sh.cool <= 0;
      var found = -1, spec = SHOTS[type] || SHOTS.clear, k, kmax = Math.min(sh.pathN - 1, sh.k + 42);
      if (incoming) for (k = sh.k; k <= kmax; k += 2) {
        var a = sh.path, tt = (k - sh.k) * STEP;
        if (canReachPt(p, a[k * 3], a[k * 3 + 1], a[k * 3 + 2], type) || (p.dive < 0 && tt > 0.06 && canReachPt({ x: p.x, z: p.z, side: p.side, dive: -1 }, a[k * 3], a[k * 3 + 1], a[k * 3 + 2], type))) { found = tt; break; }
      }
      if (found >= 0) {
        var wait = Math.max(0, found - spec.dl);
        var hy = sh.path[Math.min(sh.pathN - 1, sh.k + Math.round(found / STEP)) * 3 + 1];
        p.sw = { type: 'rally', k: type, wait: wait, t: 0, dur: spec.dl + 0.32, contact: spec.dl, done: false, auto: !!rq.auto, ax: rq.ax, ay: rq.ay, tx: rq.tx, away: rq.away, press: rq.t0 };
        p.sw.side = swingSide(p, sh.path[Math.min(sh.pathN - 1, sh.k + Math.round(found / STEP)) * 3], hy);
        if (hy > 2.45 && p.jump < 0 && p.dive < 0) { p.jump = 0; }            // overhead: jump
        p.req = null; p.state = 'swing'; p.st = 0;
      } else if (age > 0.12 || sim.phase !== 'rally') {
        // nothing to hit: whiff swing, short cooldown
        p.sw = { type: 'whiff', k: type, wait: 0, t: 0, dur: 0.34, contact: 0.1, done: true, side: 'fh', ax: 0, ay: 0 };
        if (type === 'smash' && p.jump < 0 && p.dive < 0) p.jump = 0;
        p.req = null; p.state = 'swing'; p.st = 0; p.cd = 0.1;
      }
    }
    function swingSide(p, x, y) {
      if (y > 2.2) return 'over';
      return (x - p.x) * rightSign(p) >= -0.12 ? 'fh' : 'bh';
    }

    /* ----------------------------------------------------- PLAYER UPDATES */
    var VMAX = 5.5, ACC = 34, DEC = 48, DEAD = 0.1;
    function homeOf(p) {
      var s = p.side, T = teams[p.team], sh0 = sh.lastTeam === p.team && sim.phase === 'rally';  // attacking: team that just hit
      if (T.players.length === 1) return { x: clamp(sh.x * -0.2, -0.8, 0.8) * 1, z: s * 3.3 };
      var cx = T.court[0] === p.idx ? 1 : -1, front = sh0 ? (p.idx === T.players.reduce(function (b, q) { return Math.abs(q.z) > Math.abs(b.z) ? q : b; }, T.players[0]).idx ? 0 : 1) : -1;
      if (sh0) return front === 1 ? { x: 0.2 * cx * s, z: s * 2.5 } : { x: 0.1 * cx * s, z: s * 5.0 };      // front/back when attacking
      return { x: cx * s * 1.55, z: s * 3.7 };                                                              // side by side when defending
    }
    function stepPlayer(p, h, frozen) {
      p.ox = p.x; p.oz = p.z; p.oy = p.y; p.st += h; p.flash = Math.max(0, p.flash - h); p.cd = Math.max(0, p.cd - h); p.diveCd = Math.max(0, p.diveCd - h);
      if (p.ai) aiThink(p, h);
      // ---- swing machine
      if (p.req && !p.sw) tryStartSwing(p);
      if (p.req && p.sw && sim.t - p.req.t0 > 0.12) p.req = null;           // buffer expired
      var sw = p.sw;
      if (sw) {
        if (sw.wait > 0) sw.wait -= h;
        else {
          sw.t += h;
          if (!sw.done && sw.t >= sw.contact - 0.05) {
            if (sw.type === 'serve') { if (sw.t >= sw.contact) { sw.done = true; doServe(p, sw.k, sw.ax, sw.ay); } }
            else if (sim.phase === 'rally' && sh.lastTeam !== p.team && sh.cool <= 0 && canReachPt(p, sh.x, sh.y, sh.z, sw.k)) { sw.done = hit(p, sw); }
            else if (sw.t > sw.contact + 0.1) sw.done = true;                  // missed
          }
          if (sw.t >= sw.dur) { p.sw = null; p.cd = 0.1; if (p.state === 'swing' || p.state === 'serve') p.state = 'idle'; }
        }
      }
      // ---- vertical (jump)
      if (p.jump >= 0) { p.jump += h; var u = p.jump / 0.56; if (u >= 1) { p.jump = -1; p.jumpH = 0; } else p.jumpH = 0.62 * 4 * u * (1 - u); }
      p.y = p.jumpH;
      if (frozen) { p.vx = p.vz = 0; return; }
      // ---- planar movement
      if (p.dive >= 0) {
        p.dive += h; var dv = p.diveV;
        p.vx = dv.x * 7.4 * Math.max(0, 1 - p.dive / 0.42); p.vz = dv.z * 7.4 * Math.max(0, 1 - p.dive / 0.42);
        if (p.dive >= 0.42) { p.dive = -1; p.rec = 0.42; p.state = 'idle'; }
        p.state = p.dive >= 0 ? 'dive' : p.state;
      } else {
        var m = steer(p), vmax = VMAX * (p.ai ? p.ai.lv.spd : 1) * (p.sw && p.sw.wait <= 0 && !p.sw.done ? 0.55 : 1) * (p.rec > 0 ? 0.35 : 1);
        if (p.jump >= 0) vmax *= 0.5;
        var tvx = m.x * vmax, tvz = m.z * vmax;
        var ac = (Math.abs(tvx) + Math.abs(tvz) > 0.01 ? ACC : DEC) * h;
        p.vx = approach(p.vx, tvx, ac); p.vz = approach(p.vz, tvz, ac);
        p.rec = Math.max(0, p.rec - h);
      }
      p.x += p.vx * h; p.z += p.vz * h;
      var xm = C.HWD + 0.95, zmin = 0.3, zmax = C.HL + 1.0;
      p.x = clamp(p.x, -xm, xm); var zz = p.z * p.side; zz = clamp(zz, zmin, zmax); p.z = zz * p.side;
      var sp = Math.hypot(p.vx, p.vz); p.runPh += sp * h * 1.9;
      if (p.state === 'idle' || p.state === 'run') { p.state = sp > 0.6 ? 'run' : 'idle'; }
    }
    /* movement intent in [-1,1]^2 (+ assist) */
    var _g = {};
    function steer(p) {
      var mx = 0, mz = 0, mag = 0;
      if (p.human) {
        var i = p.in, stale = sim.t - i.t > 0.6, ix = stale ? 0 : i.x, iy = stale ? 0 : i.y, m = Math.hypot(ix, iy);
        if (m > DEAD) { var k = Math.min(1, (m - DEAD) / (0.88 - DEAD)); k = Math.pow(k, 0.85); mx = ix / m * k; mz = iy / m * k; mag = k; }
        if (mag > 0.05) { p.idleT = 0; } else p.idleT += STEP;
        if (p.assist && sim.phase === 'rally') {
          var g = assistGoal(p, _g);
          if (g) {
            var dx = g.x - p.x, dz = g.z - p.z, d = Math.hypot(dx, dz), w = mag < 0.05 ? 0.95 : 0.2, sp = clamp(d / 0.4, 0, 1);
            if (d > 0.05) { mx += dx / d * sp * w; mz += dz / d * sp * w; }
          } else if (mag < 0.05 && p.idleT > 0.5) {   // drift back to a ready position
            var hm = homeOf(p), hx = hm.x - p.x, hz = hm.z - p.z, hd = Math.hypot(hx, hz);
            if (hd > 0.25) { mx += hx / hd * 0.5; mz += hz / hd * 0.5; }
          }
        }
        var mm = Math.hypot(mx, mz); if (mm > 1) { mx /= mm; mz /= mm; }
        return { x: mx, z: mz };
      }
      return p.ai.mv || { x: 0, z: 0 };
    }
    /* auto step goal for assisted humans: the predicted contact point on my half (only for the closest team mate) */
    function assistGoal(p, out) {
      if (!(sh.in && sh.path && sh.lastTeam !== p.team && !sh.held)) return null;
      pathAtHeight(1.9, out);
      if (out.z * p.side < 0.2 || Math.abs(out.z) > C.HL + 1.2) { if (sh.pLz * p.side < 0.2 || Math.abs(sh.pLz) > C.HL + 0.6 || Math.abs(sh.pLx) > C.HWD + 0.6) return null; out.x = sh.pLx; out.z = sh.pLz; }
      if (Math.abs(out.x) > C.HWD + 0.8) return null;
      var T = teams[p.team].players;
      if (T.length > 1) { var o = T[1 - p.idx], dm = Math.hypot(out.x - p.x, out.z - p.z), dop = Math.hypot(out.x - o.x, out.z - o.z); if (o.human && dop < dm - 0.4) return null; }
      out.x = clamp(out.x - p.side * 0.18, -C.HWD - 0.6, C.HWD + 0.6);
      return out;
    }

    /* ------------------------------------------------------------- AI */
    var _a = {};
    function aiThink(p, h) {
      var ai = p.ai, lv = ai.lv, side = p.side, mv = { x: 0, z: 0 }, T = teams[p.team];
      ai.mv = mv;
      if (sim.phase === 'serve') {
        if (p === serverP && !p.sw && !p.req) { ai.serveT -= h; if (ai.serveT <= 0) { var r = R(), k = r < 0.4 ? 'drop' : (r < 0.8 ? 'clear' : 'drive'); p.req = { k: k, t0: sim.t, ax: (R() - 0.5) * 1.2, ay: 0 }; } }
        return;
      }
      if (sim.phase !== 'rally') return;
      var incoming = sh.in && sh.lastTeam !== p.team && sh.path;
      var goal = homeOf(p), hm = goal, desig = false, dist = 99;
      if (incoming) {
        if (ai.seq !== sh.hits) { ai.seq = sh.hits; ai.rt = lv.rt * (0.7 + R() * 0.6); ai.has = false; ai.hit = false; }
        ai.rt -= h;
        if (ai.rt <= 0 && !ai.has) {
          pathAtHeight(1.95, _a);
          var tgt = { x: _a.x, z: _a.z, t: _a.t };
          if (tgt.z * side < 0.2 || Math.abs(tgt.z) > C.HL + 1) { tgt.x = sh.pLx; tgt.z = sh.pLz; }
          var willBeOut = Math.abs(sh.pLx) > (dbl ? C.HWD : C.HWS) + 0.22 || Math.abs(sh.pLz) > C.HL + 0.22 || sh.pLz * side < 0;
          ai.tx = tgt.x + R.gauss() * lv.pos * 0.5; ai.tz = tgt.z + R.gauss() * lv.pos * 0.5; ai.out = willBeOut && R() > lv.miss * 2;
          ai.has = true;
        }
        if (ai.has && !ai.out) {
          desig = true;
          if (T.players.length > 1) { var o = T.players[1 - p.idx]; if (Math.hypot(ai.tx - o.x, ai.tz - o.z) + (o.human ? 0.45 : 0) < Math.hypot(ai.tx - p.x, ai.tz - p.z)) desig = false; }
          if (desig) goal = { x: clamp(ai.tx - side * 0.15, -C.HWD - 0.7, C.HWD + 0.7), z: ai.tz };
        }
      } else { ai.has = false; }
      var dx = goal.x - p.x, dz = goal.z - p.z, d = Math.hypot(dx, dz); dist = d;
      if (d > 0.08) { var f = clamp(d / 0.35, 0, 1) * (desig ? 1 : 0.75); mv.x = dx / d * f; mv.z = dz / d * f; }
      // dive for far shuttles
      if (desig && p.diveCd <= 0 && p.dive < 0 && !p.sw && p.rec <= 0 && lv.dive > 0.2) {
        var tl = ai.tz != null ? (sh.pLt - sh.k * STEP) : 9;
        if (d > 1.9 && d < 4.2 && tl < 0.55 && R() < lv.dive * 0.07) startDive(p, dx / d, dz / d);
      }
      // swing when the shuttle is about to be in reach
      if (desig && !p.req && !p.sw && p.cd <= 0) {
        var k, kmax = Math.min(sh.pathN - 1, sh.k + 30), a = sh.path, near = false;
        for (k = sh.k; k <= kmax; k += 2) if (canReachPt(p, a[k * 3], a[k * 3 + 1], a[k * 3 + 2], 'clear') && (k - sh.k) * STEP < 0.16) { near = true; break; }
        if (near) {
          if (R() < lv.miss * 0.35 && !ai.slip) { ai.slip = true; p.cd = 0.25; }                      // mistimed: late swing
          else { ai.slip = false; p.req = aiPick(p, a[k * 3], a[k * 3 + 1], a[k * 3 + 2]); }
        }
      }
    }
    function aiPick(p, x, y, z) {
      var lv = p.ai.lv, sty = p.ai.sty, side = p.side, opp = teams[other(p.team)].players, o = nearestOpp(p), r = R(), k, away = 0;
      var near = Math.abs(z) < 5.3, deepOpp = Math.abs(o.z) > 4.0, frontOpp = Math.abs(o.z) < 3.0, W = (dbl ? C.HWD : C.HWS) - 0.4;
      var ps = clamp(lv.smash + (sty.smash || 0), 0.05, 0.9), pd = clamp(lv.drop + (sty.drop || 0), 0.05, 0.6);
      if (p.energy >= 1 && y > 1.7 && r < 0.7) k = 'super';
      else if (y > 2.0 && near && r < ps) k = 'smash';
      else if (y < 0.95 && Math.abs(z) < 3.2) k = r < 0.5 ? 'lift' : 'netdrop';
      else if (r < pd && deepOpp) k = 'drop';
      else if (r < pd + 0.15 && y < 1.7) k = 'drive';
      else k = 'clear';
      if (k === 'clear' && frontOpp) away = 1; else if (k === 'drop') away = -0.2 + R() * 0.4; else away = R() * 0.6;
      var ox = o.x, tx = -sgn(ox || (R() < 0.5 ? 1 : -1)) * (1.1 + R() * (W - 1.1));      // opposite side to the nearest opponent
      if (opp.length > 1) tx = (Math.abs(opp[0].x - tx) > Math.abs(opp[1].x - tx) ? 1 : 0.8) * tx;
      tx = clamp(tx + R.gauss() * lv.err * 0.4, -W - 0.3, W + 0.3);
      return { k: k, t0: sim.t, ax: 0, ay: 0, tx: tx, away: away };
    }
    function startDive(p, dx, dz) {
      if (p.diveCd > 0 || p.dive >= 0 || p.rec > 0 || p.sim) return false;
      var d = Math.hypot(dx, dz); if (d < 0.01) { dx = 0; dz = -p.side; d = 1; }
      p.diveV = { x: dx / d, z: dz / d }; p.dive = 0; p.diveCd = 1.1; p.state = 'dive'; p.st = 0; p.stats.dives = (p.stats.dives || 0) + 1;
      p.sw = null; emit({ t: 'dive', id: p.id });
      // auto swing during the dive for assisted humans / AI
      p.req = p.req || { k: 'lift', t0: sim.t, ax: 0, ay: 0, auto: !!p.human, tx: p.ai ? defaultAim(p) : 0, away: 0.3 };
      return true;
    }

    /* ---------------------------------------------- AUTO SWING (assist) */
    function autoSwing(p) {
      if (!p.human || !p.assist || p.req || p.sw || p.cd > 0 || p.rec > 0 || sim.phase !== 'rally' || !sh.path || sh.lastTeam === p.team || sh.cool > 0) return;
      var a = sh.path, k, kmax = Math.min(sh.pathN - 1, sh.k + 16);
      for (k = sh.k; k <= kmax; k += 2) if (canReachPt(p, a[k * 3], a[k * 3 + 1], a[k * 3 + 2], 'clear') && Math.hypot(a[k * 3] - p.x, a[k * 3 + 2] - p.z) < 1.35 && (k - sh.k) * STEP < 0.1) {
        p.req = { k: chooseType(p, a[k * 3 + 1]), t0: sim.t, ax: 0, ay: 0, auto: true }; return;
      }
    }

    /* ----------------------------------------------------------- SHUTTLE */
    function stepRally(h) {
      sh.ox = sh.x; sh.oy = sh.y; sh.oz = sh.z; sh.cool = Math.max(0, sh.cool - h); sh.tFly += h;
      stepShuttle(sh, h); sh.k++; sh.spin += h * 14;
      if (sh.netted) {
        emit({ t: 'net', x: sh.x, y: sh.y, z: sh.z }); sh.path = null; buildPath();
      }
      if (sh.landed) { landed(); return; }
      if (sh.tFly > 9) { sh.lx = sh.x; sh.lz = sh.z; landed(); }
    }
    function landed() {
      var hitter = sh.last, ht = sh.lastTeam, x = sh.lx, z = sh.lz, why, win, inb, ls = z >= 0 ? 1 : -1;
      emit({ t: 'land', x: x, z: z });
      if (sh.serveFirst) {
        var rs = sideSign[other(ht)], c = T_court(hitter), tcs = -courtX(ht, c);
        inb = !sh.netDone || !sh.netted ? inServe(x, z, tcs, rs, dbl) : false;
        if (sh.netted || !inb) { win = other(ht); why = sh.netted ? 'NET' : 'SERVICE FAULT'; }
        else { win = ht; why = 'ACE'; }
      } else if (sh.netted) { win = other(ht); why = 'NET'; }
      else if (ls === sideSign[ht]) { win = other(ht); why = 'NET'; }                         // never crossed: counts as a net fault
      else if (inCourt(x, z, dbl)) { win = ht; why = (sh.shot === 'smash' || sh.shot === 'super') ? (sh.shot === 'super' ? 'SUPER SMASH' : 'SMASH WINNER') : 'WINNER'; }
      else { win = other(ht); why = 'OUT'; }
      sh.in = false; sh.landed = true;
      if (win === ht && hitter) { hitter.stats.winners++; } else if (hitter) { hitter.stats.errors++; }
      awardPoint(win, why, x, z);
    }

    /* ------------------------------------------------------ POINT / GAME */
    function awardPoint(win, why, lx, lz) {
      var T = teams[win], prevServe = serveTeam;
      T.score++;
      var scorer = sh.last && sh.last.team === win ? sh.last : T.players[0]; scorer.stats.pts++;
      T.players.forEach(function (p) { p.energy = Math.min(1, p.energy + 0.1); });
      if (win === serveTeam) { if (T.players.length > 1) T.court = [T.court[1], T.court[0]]; } else serveTeam = win;
      var a = teams[0].score, b = teams[1].score, gw = gameWon(T.score, teams[other(win)].score, P), ended = false, matchWon = false;
      if (gw) { T.games++; ended = true; gameLog.push([a, b]); if (T.games >= Math.ceil(BO / 2)) matchWon = true; }
      var lead = Math.max(a, b), mpt = matchPointInfo();
      var info = { t: 'point', team: win, why: why, score: [a, b], rally: rallyN, lx: lx, lz: lz, gameEnd: ended, matchEnd: matchWon, matchPoint: mpt, server: serveTeam };
      sim.last = info; emit(info);
      sim.phase = ended ? 'gameover' : 'point'; sim.phaseT = 0; sim.holdT = ended ? (matchWon ? 4.2 : 3.6) : 2.0;
      players.forEach(function (p) { p.req = null; p.sw = null; p.jump = -1; p.jumpH = 0; p.dive = -1; p.rec = 0; p.state = p.team === win ? 'win' : 'lose'; p.st = 0; if (!ended && rallyN < 4 && p.team !== win) p.state = 'idle'; });
      if (matchWon) { over = true; winnerTeam = win; }
      pending = { ended: ended, matchWon: matchWon };
    }
    function matchPointInfo() {      // does a team stand one point from winning the MATCH?
      var res = -1;
      for (var t = 0; t < 2; t++) {
        var s = teams[t].score + 1, o = teams[other(t)].score;
        if (gameWon(s, o, P) && teams[t].games + 1 >= Math.ceil(BO / 2)) res = t;
      }
      return res;
    }
    function nextAfterPoint() {
      if (pending && pending.matchWon) { sim.phase = 'over'; sim.phaseT = 0; emit({ t: 'match', team: winnerTeam }); return; }
      if (pending && pending.ended) {   // new game: change ends, winner serves
        var wt = teams[0].score > teams[1].score ? 0 : 1;
        gameNo++; teams[0].score = teams[1].score = 0; sideSign[0] = -sideSign[0]; sideSign[1] = -sideSign[1]; serveTeam = wt; midSwitched = false;
        teams.forEach(function (t) { t.court = t.players.length > 1 ? [0, 1] : [0, 0]; });
        emit({ t: 'switch', game: gameNo, why: 'game' });
      } else if (BO === 3 && gameNo === 3 && !midSwitched && Math.max(teams[0].score, teams[1].score) >= Math.ceil(P / 2)) {
        midSwitched = true; sideSign[0] = -sideSign[0]; sideSign[1] = -sideSign[1]; emit({ t: 'switch', game: gameNo, why: 'mid' });
      }
      pending = null; placeForServe();
    }

    /* ---------------------------------------------------------- MAIN STEP */
    sim.step = function (h) {
      sim.t += h; sim.phaseT += h; sh.ox = sh.x; sh.oy = sh.y; sh.oz = sh.z;
      var ph = sim.phase, i;
      if (ph === 'intro') { players.forEach(function (p) { p.ox = p.x; p.oz = p.z; p.st += h; }); if (sim.phaseT > 3.0) placeForServe(); return; }
      if (ph === 'serve') {
        for (i = 0; i < players.length; i++) { var p = players[i]; stepPlayer(p, h, p !== serverP); }
        if (sim.phase === 'serve') {
          if (serverP.sw && serverP.sw.type === 'serve' && serverP.sw.t < serverP.sw.contact) { holdShuttle(); }
          else if (sh.held) { holdShuttle(); }
          if (sim.phaseT > 9 && serverP.human && !serverP.sw && !serverP.req) serverP.req = { k: 'drop', t0: sim.t, ax: 0, ay: 0 };
          // the server may shuffle a little inside his court before serving
          var sp = serverP, cx = courtX(sp.team, T_court(sp)) * (dbl ? 1.5 : 1.35); sp.x = clamp(sp.x, cx - 0.55, cx + 0.55); sp.z = sp.side * clamp(Math.abs(sp.z), 2.3, 3.5);
        }
        return;
      }
      if (ph === 'rally') {
        for (i = 0; i < players.length; i++) autoSwing(players[i]);
        for (i = 0; i < players.length; i++) stepPlayer(players[i], h, false);
        if (sim.phase === 'rally') stepRally(h);
        return;
      }
      if (ph === 'point' || ph === 'gameover') {
        for (i = 0; i < players.length; i++) stepPlayer(players[i], h, true);
        if (sh.in === false && !sh.landed) { /* keep */ }
        if (sim.phaseT >= sim.holdT) nextAfterPoint();
        return;
      }
      if (ph === 'over') { players.forEach(function (p) { p.ox = p.x; p.oz = p.z; p.st += h; }); }
    };

    /* ---------------------------------------------------------- API */
    sim.input = function (id, x, y) { var p = byId[id]; if (p && p.human) { p.in.x = clamp(+x || 0, -1, 1); p.in.y = clamp(+y || 0, -1, 1); p.in.t = sim.t; } };
    sim.shot = function (id, k, ax, ay, seq) {
      var p = byId[id]; if (!p || !p.human) return false;
      if (seq != null) { if (seq <= p.lastSeq && p.lastSeq - seq < 1000) return false; p.lastSeq = seq; }
      if (!(k in SHOTS)) return false;
      if (k === 'super' && p.energy < 0.999) { emit({ t: 'nosuper', id: id }); return false; }
      p.req = { k: k, t0: sim.t, ax: clamp(+ax || 0, -1, 1), ay: clamp(+ay || 0, -1, 1) };
      p.idleT = 0; return true;
    };
    sim.dive = function (id) {
      var p = byId[id]; if (!p || !p.human || sim.phase !== 'rally') return false;
      var dx = p.in.x, dz = p.in.y;
      if (Math.hypot(dx, dz) < 0.25 || sim.t - p.in.t > 0.5) {         // no stick: dive towards the shuttle's landing
        if (sh.path && sh.lastTeam !== p.team) { dx = sh.pLx - p.x; dz = sh.pLz - p.z; } else { dx = 0; dz = -p.side; }
      }
      return startDive(p, dx, dz);
    };
    sim.replaceWithAI = function (id) {        // a disconnected human is taken over by the CPU
      var p = byId[id]; if (!p || !p.human) return;
      p.human = false; p.cpuName = p.name; p.name = p.name + ' (CPU)'; p.assist = false; p.req = null;
      p.ai = { rt: 0, seq: -1, has: false, tx: 0, tz: 0, hit: false, serveT: 1.2, lv: lvOf(p), sty: { smash: 0, drop: 0 } };
      p.ai.lv.err *= 1.2; emit({ t: 'cpu', id: id });
    };
    sim.setAssist = function (id, on) { var p = byId[id]; if (p) p.assist = !!on; };
    sim.byId = byId;
    sim.get = function () { return { sideSign: sideSign, serveTeam: serveTeam, server: serverP, recv: recvP, gameNo: gameNo, rally: rallyN, longest: longest, over: over, winner: winnerTeam, mp: matchPointInfo(), P: P, BO: BO, dbl: dbl, log: gameLog, midSwitched: midSwitched }; };
    sim.results = function () {
      return { winner: winnerTeam, games: [teams[0].games, teams[1].games], log: gameLog.slice(), longest: longest, mode: cfg.mode,
        players: players.map(function (p) { return { id: p.id, name: p.name, team: p.team, char: p.char, human: p.human, pts: p.stats.pts, winners: p.stats.winners, smashes: p.stats.smashes, perfects: p.stats.perfects, errors: p.stats.errors, supers: p.stats.supers }; }) };
    };
    // first serve
    teams.forEach(function (t, i) { t.players.forEach(function (p) { p.side = sideSign[i]; }); });
    placeForServe(); sim.phase = 'intro'; sim.phaseT = 0;
    return sim;
  }

  root.SmashCore = { C: C, SHOTS: SHOTS, AI_LEVELS: AI_LEVELS, LADDER: LADDER, createSim: createSim, rng: rng, solveShot: solveShot, stepShuttle: stepShuttle, simLaunch: simLaunch,
    gameWon: gameWon, inCourt: inCourt, inServe: inServe, netTop: netTop, clamp: clamp, lerp: lerp };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SmashCore;
})(typeof window !== 'undefined' ? window : globalThis);
