/* ===========================================================================
 * Apex Rush  -  NOVA Console game  (id: 'racing')
 * ---------------------------------------------------------------------------
 * 1 to 5 humans (split screen on ONE WebGL canvas) + bots, up to 8 cars.
 * Runs only on the screen page. Needs Three.js r128 and games/racing-world.js.
 *
 * Contract (same as the other games):
 *   window.NovaGames.racing = { start(ctx), stop(), onPlayers(list), onButton(slot,key), onInput(slot,msg) }
 *
 * Phone -> screen  (onInput, msg.t === 'g'):
 *   {a:'drive',steer:-1..1,thr:0..1,brk:0..1}  {a:'cam'}  {a:'tc',on}
 *   {a:'setup',trk,laps,bots} {a:'ready'} {a:'start'} {a:'again'} {a:'pause'}   (setup/start/again/pause: Player 1 only)
 * Screen -> phones (ctx.send('gstate', ...)), g:'racing':
 *   ph: setup | grid | count | race | finish | results | paused
 *   trk, laps, bots, tn[] (track names), rd[] (ready ids), n (cars), cd (countdown, 0 = GO),
 *   cars {id:[pos,lap,kmh,gear,rpm01,finished]}, hit {id:counter}, res [{id,name,color,pos,t,best}]
 *
 * File layout (all inside createGame):  3a state + race flow + protocol,
 *   3b car physics, collisions, bots,  3c renderer, cameras, split screen,  3d HUD + audio + main loop + API.
 * Players are tracked by ID (the host re-indexes slots when somebody leaves).
 * ========================================================================= */
(function () {
  'use strict';
  window.NovaGames = window.NovaGames || {};

  /* ---------------------------------------------------------------- TUNABLES */
  var MAX_CARS = 8, MAX_HUMANS = 5, LAPS_MIN = 1, LAPS_MAX = 5;
  var STEP = 1 / 120;                         // fixed physics step (frame-rate independent)
  var GRID_T = 3.5, COUNT_T = 3, GO_T = 0.9;  // grid fly-in, 3-2-1, "GO" banner (cars are already released)
  var FINISH_T = 2.8, END_GRACE = 30;         // finish flourish; seconds the others get after the first finisher
  var STATE_MS = 100;                         // gstate rate during a race (10 Hz); every phase change is sent at once
  var BOT_NAMES = ['Ryo K.', 'Mara V.', 'Dex T.', 'Nia O.', 'Juno B.', 'Kai S.', 'Lex R.', 'Tala M.'];
  var BOT_COLORS = ['#e8e8ec', '#ff7a1a', '#1fd1c1', '#c0392b', '#7fdc3c', '#f1c40f', '#b36bff', '#4d6a8a'];

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(t) {                        // m:ss.mmm
    if (!(t > 0) || t > 3599) return '--:--.---';
    var m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3);
  }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  function createGame(ctx) {
    var THREE = window.THREE, W = window.Apex && window.Apex.World, container = ctx.container, stopped = false;
    var COLORS = (ctx.colors && ctx.colors.length) ? ctx.colors : ((window.CFG && window.CFG.COLORS) || ['#8b6cff', '#00e0a4', '#ff5c8a', '#ffb020', '#2ec5ff']);

    /* ------------------------------------------------------------------ STATE */
    var players = [];                          // [{id,slot}] sorted by slot; players[0] is "Player 1"
    var cfg = { trk: 0, laps: 3, bots: 3 };    // chosen on Player 1's phone
    var phase = 'setup', prevPhase = 'setup';  // setup | grid | count | race | finish | results | paused
    var ready = {};                            // id -> true (setup)
    var cars = [], world = null, tr = null, worldTrk = -1, skid = null, parts = null, scene = null;
    var raceT = 0, ct = 0, cdVal = 0, released = false, finishTimer = 0, firstFinT = -1, finCount = 0, results = [];
    var stateAcc = 0, stateDirty = true, rankAcc = 0, clock = 0;
    var sfx = null;                            // WebAudio helper (3d)
    var Q = { pr: 1, trees: 1, shadow: 0, shadowSize: 1024, level: 3 };   // adaptive quality (3c / 3d)
    var inp = {};                              // id -> {steer,thr,brk,t}

    /* ---------------------------------------------------------------- HELPERS */
    function carById(id) { for (var i = 0; i < cars.length; i++) if (cars[i].id === id) return cars[i]; return null; }
    function humanCars() { return cars.filter(function (c) { return c.human; }); }
    function isP1(id) { return players.length > 0 && players[0].id === id; }
    function playerById(id) { for (var i = 0; i < players.length; i++) if (players[i].id === id) return players[i]; return null; }
    function colorOfSlot(slot) { return COLORS[slot % COLORS.length]; }
    function setPhase(p) { if (phase !== p) { prevPhase = phase; phase = p; } stateDirty = true; }
    function readyCount() { var c = 0; for (var k in ready) if (ready[k]) c++; return c; }

    /* ------------------------------------------------------------ WORLD BUILD */
    function disposeCars() {
      cars.forEach(function (c) { if (c.model) { scene.remove(c.model.group); c.model.dispose(); c.model = null; } });
      cars = [];
    }
    function disposeWorld() {
      disposeCars();
      if (skid) { skid.dispose(); skid = null; }
      if (parts) { parts.dispose(); parts = null; }
      if (world) { world.dispose(); world = null; tr = null; worldTrk = -1; }
    }
    function buildWorld(trk) {
      if (world && worldTrk === trk) return;
      disposeWorld();
      world = W.buildScenery(THREE, scene, trk, { treeDensity: Q.trees });
      tr = world.tr; worldTrk = trk;
      skid = new W.SkidMarks(THREE, scene, 1500);
      parts = new W.Particles(THREE, scene, 700);
      world.setShadow(Q.shadow > 0, Q.shadowSize, 70);
    }

    /* ------------------------------------------------------------------- CARS */
    function newCar(id, slot, human, name, color, gridK, botIdx) {
      var g = W.gridSlot(tr, gridK), c = {
        id: id, slot: slot, human: human, name: name, color: color, botIdx: botIdx == null ? -1 : botIdx, grid: gridK,
        x: g.x, y: g.y, z: g.z, yaw: Math.atan2(g.hz, g.hx), u: 0, v: 0, vx: 0, vz: 0, yawRate: 0, speed: 0,
        steerIn: 0, thr: 0, brk: 0, steerVis: 0, tc: tcPref[id] !== false, cam: 0, auto: false, wk: [id + 'a', id + 'b', id + 'c', id + 'd'],
        pitch: 0, roll: 0, q: {}, hint: g.i, s: g.s % tr.L, prog: 0, lap: 0, maxLap: 0, lapT0: 0, lapTimes: [], best: 1e9, last: 0,
        finished: false, finishT: 0, finPos: 0, pos: 0,
        wheelAng: 0, slip: 0, off: false, wrongT: 0, stuckT: 0, respT: 0, hitN: 0, rpm: 0.3, gear: 1, kmh: 0, shake: 0, lastHit: -9,
        skill: 0.78 + (botIdx >= 0 ? ((botIdx * 37) % 15) / 100 : 0.1), lane: 0, laneT: 0, model: null
      };
      W.query(tr, c.x, c.z, g.i, c.q); c.hint = c.q.i; c.s = c.q.s; c.prog = c.q.s - tr.L;   // negative until the start line is crossed
      c.model = W.makeCar(THREE, color, name, world.env); scene.add(c.model.group);
      c.lane = ((botIdx * 5) % 9 - 4) * 0.8;
      return c;
    }
    function makeCars() {
      disposeCars();
      var hs = players.slice(0, MAX_HUMANS), nb = clamp(cfg.bots, 0, MAX_CARS - hs.length), k = 0, i;
      for (i = 0; i < nb; i++, k++) cars.push(newCar('bot' + i, -1, false, BOT_NAMES[i % BOT_NAMES.length], BOT_COLORS[i % BOT_COLORS.length], k, i));
      for (i = 0; i < hs.length; i++, k++) cars.push(newCar(hs[i].id, hs[i].slot, true, 'Player ' + (hs[i].slot + 1), colorOfSlot(hs[i].slot), k, -1));
      cars.forEach(function (c) { var s = inp[c.id]; if (s) { s.steer = s.thr = s.brk = 0; } placeModel(c); });
      rankCars();
    }
    /* Copy physics state to the 3D model (pose, wheel spin/steer, lights). Called every frame by the renderer. */
    function placeModel(c) {
      if (!c.model) return;
      W.setCarPose(THREE, c.model, c.x, c.y, c.z, Math.cos(c.yaw), Math.sin(c.yaw), c.pitch, c.roll);
      c.model.setSteer(c.steerVis); c.model.setSpin(c.wheelAng); c.model.setBrake(c.brk > 0.2 && c.speed > 0.5);
      c.model.setHeadlights(world && world.env.name === 'misty' ? 0.9 : (world && world.env.name === 'golden' ? 0.35 : 0.12));
    }

    /* ------------------------------------------------------- PROGRESS / RANKS */
    /* Called by the physics after c.q was refreshed. prog is unwrapped distance along the track; lap = floor(prog/L)+1. */
    function trackProgress(c) {
      var L = tr.L, s = c.q.s, d = s - c.s;
      if (d < -L / 2) d += L; else if (d > L / 2) d -= L;
      c.s = s; c.prog += d;
      var lapNow = Math.floor(c.prog / L) + 1;
      if (lapNow > c.maxLap) {
        if (c.maxLap >= 1) {                                   // a lap was completed
          var lt = raceT - c.lapT0; c.lapTimes.push(lt); c.last = lt; if (lt < c.best) c.best = lt;
          if (c.human && sfx) sfx.lap();
        }
        c.maxLap = lapNow; c.lapT0 = raceT; stateDirty = true;
        if (lapNow > cfg.laps && !c.finished) finishCar(c);
      }
      c.lap = Math.max(0, lapNow);
    }
    function finishCar(c) {
      c.finished = true; c.finishT = raceT; c.finPos = ++finCount; c.auto = true;    // auto-pilot keeps it out of the way
      if (firstFinT < 0) { firstFinT = raceT; if (sfx) sfx.finish(); }
      stateDirty = true;
    }
    function rankCars() {
      var order = cars.slice().sort(function (a, b) {
        if (a.finished !== b.finished) return a.finished ? -1 : 1;
        if (a.finished) return a.finPos - b.finPos;
        return b.prog - a.prog;
      });
      order.forEach(function (c, i) { c.pos = i + 1; });
      return order;
    }
    function computeResults() {
      results = rankCars().map(function (c) {
        return { id: c.id, name: c.name, color: c.color, pos: c.pos, t: c.finished ? +c.finishT.toFixed(3) : 0, best: c.best < 1e8 ? +c.best.toFixed(3) : 0, human: c.human };
      });
      stateDirty = true;
    }

    /* ------------------------------------------------------------- RACE FLOW */
    function enterSetup() {
      disposeCars(); ready = {}; released = false; raceT = 0; firstFinT = -1; finCount = 0; results = [];
      buildWorld(cfg.trk); setPhase('setup'); pushState(true);
    }
    function startRace() {
      if (players.length === 0 || stopped) return;
      cfg.bots = clamp(cfg.bots, 0, MAX_CARS - Math.min(players.length, MAX_HUMANS));
      buildWorld(cfg.trk); makeCars(); if (skid) skid.clear();
      released = false; raceT = 0; ct = 0; cdVal = 4; firstFinT = -1; finCount = 0; finishTimer = 0; results = []; ready = {};
      setPhase('grid'); pushState(true);
    }
    function beginFinish() { finishTimer = 0; cars.forEach(function (c) { if (!c.finished) c.auto = true; }); computeResults(); setPhase('finish'); pushState(true); }

    /* Phase timers. dt = real frame time (clamped). Physics is stepped separately in 3b. */
    function updateFlow(dt) {
      clock += dt;
      if (phase === 'paused' || phase === 'setup') { if (stateDirty) pushState(true); return; }   // still tell the phones about ready / setup / pause changes
      if (released && (phase === 'count' || phase === 'race' || phase === 'finish')) raceT += dt;
      if (phase === 'grid') {
        ct += dt;
        if (ct >= GRID_T) { setPhase('count'); ct = COUNT_T; cdVal = 3; if (sfx) sfx.beep(3); pushState(true); }
      } else if (phase === 'count') {
        ct -= dt;
        var cd = ct > 0 ? Math.ceil(ct) : 0;
        if (cd !== cdVal) {
          cdVal = cd;
          if (cd > 0) { if (sfx) sfx.beep(cd); } else { released = true; raceT = 0; if (sfx) sfx.go(); cars.forEach(function (c) { c.lapT0 = 0; }); }
          pushState(true);
        }
        if (ct <= -GO_T) { setPhase('race'); pushState(true); }
      } else if (phase === 'race') {
        var alive = 0, i;
        for (i = 0; i < cars.length; i++) if (cars[i].human && !cars[i].finished) alive++;
        var humansTotal = humanCars().length;
        if ((humansTotal > 0 && alive === 0) || (firstFinT >= 0 && raceT - firstFinT > END_GRACE)) beginFinish();
      } else if (phase === 'finish') {
        finishTimer += dt; if (finishTimer >= FINISH_T) { setPhase('results'); pushState(true); }
      }
      rankAcc += dt; if (rankAcc > 0.15) { rankAcc = 0; rankCars(); }
      stateAcc += dt * 1000;
      if (stateDirty || (phase === 'race' && stateAcc >= STATE_MS)) pushState(true);
    }

    /* ----------------------------------------------------- PHONE PROTOCOL OUT */
    function pushState(force) {
      stateAcc = 0; stateDirty = false;
      if (!ctx.send) return;
      var racing = phase !== 'setup', cm = {}, hit = {}, nh = Math.min(players.length, MAX_HUMANS);
      cars.forEach(function (c) {
        if (!c.human) return;
        cm[c.id] = [c.pos, Math.max(1, Math.min(c.lap, cfg.laps)), Math.round(c.kmh), c.gear, +c.rpm.toFixed(2), c.finished ? 1 : 0]; hit[c.id] = c.hitN;
      });
      var payload = {
        g: 'racing', ph: phase, trk: cfg.trk, laps: cfg.laps, bots: cfg.bots, tn: W.names, rd: Object.keys(ready).filter(function (k) { return ready[k]; }),
        n: racing ? cars.length : nh + Math.min(cfg.bots, MAX_CARS - nh), cd: phase === 'count' ? cdVal : 0, cars: cm, hit: hit,
        res: (phase === 'results' || phase === 'finish') ? results : []
      };
      try { var r = ctx.send('gstate', payload); if (r && r.catch) r.catch(function () {}); } catch (e) { /* ignore */ }
    }

    /* Called by physics (3b) when a car hits a wall or another car; force in m/s of closing speed. */
    function onCollision(c, force, wx, wy, wz) {
      if (force < 2.5) return;
      if (clock - c.lastHit > 0.25) { c.hitN++; c.lastHit = clock; stateDirty = true; }
      c.shake = Math.min(1, c.shake + force / 18);
      if (sfx) sfx.collision(clamp(force / 20, 0.1, 1));
      if (parts) for (var k = 0; k < Math.min(10, 2 + force | 0); k++)
        parts.emit(wx, wy + 0.4, wz, (Math.random() - 0.5) * 9, Math.random() * 6, (Math.random() - 0.5) * 9, 0.45 + Math.random() * 0.3, 0.35, 0.1, 1, [1, 0.72 + Math.random() * 0.2, 0.25], 3);
    }

    /* -------------------------------------------------------- INPUT FROM HOST */
    function onInput(slot, msg) {
      if (stopped || !msg || msg.t !== 'g') return;
      var id = msg.id; if (!id) { for (var i = 0; i < players.length; i++) if (players[i].slot === slot) id = players[i].id; }
      if (!id || !playerById(id)) return;
      var a = msg.a, c = carById(id), p1 = isP1(id);
      if (a === 'drive') {
        var s = inp[id] || (inp[id] = { steer: 0, thr: 0, brk: 0, t: 0 });
        s.steer = clamp(+msg.steer || 0, -1, 1); s.thr = clamp(+msg.thr || 0, 0, 1); s.brk = clamp(+msg.brk || 0, 0, 1); s.t = clock;
      } else if (a === 'cam') { if (c) c.cam = (c.cam + 1) % 3; }
      else if (a === 'tc') { if (c) c.tc = !!msg.on; tcPref[id] = !!msg.on; }
      else if (a === 'ready') { if (phase === 'setup') { ready[id] = !ready[id]; stateDirty = true; } }
      else if (a === 'setup') {
        if (!p1 || phase !== 'setup') return;
        var trk = clamp(Math.round(+msg.trk || 0), 0, W.TRACKS.length - 1), laps = clamp(Math.round(+msg.laps || cfg.laps), LAPS_MIN, LAPS_MAX);
        var bots = clamp(Math.round(msg.bots == null ? cfg.bots : +msg.bots), 0, MAX_CARS - Math.min(players.length, MAX_HUMANS));
        var changed = trk !== cfg.trk; cfg.trk = trk; cfg.laps = laps; cfg.bots = bots;
        if (changed) { ready = {}; buildWorld(trk); }
        stateDirty = true;
      }
      else if (a === 'start') { if (p1 && phase === 'setup') startRace(); }
      else if (a === 'again') { if (p1 && phase === 'results') startRace(); }
      else if (a === 'pause') {
        if (!p1) return;
        if (phase === 'paused') { phase = prevPhase; stateDirty = true; if (sfx) sfx.resume(); }
        else if (phase === 'race' || phase === 'count') { prevPhase = phase; phase = 'paused'; stateDirty = true; if (sfx) sfx.silence(); }
      }
    }
    var tcPref = {};                           // id -> traction control choice, survives restarts
    /* Edge button events (PlayStation-style). Handy for Player 1 on the TV remote too. */
    function onButton(slot, key) {
      if (stopped) return;
      if (sfx) sfx.resume();
      var p = null, i; for (i = 0; i < players.length; i++) if (players[i].slot === slot) p = players[i];
      if (!p || !isP1(p.id)) return;
      if (phase === 'setup' && (key === 'cr' || key === 'start')) startRace();
      else if (phase === 'setup' && (key === 'left' || key === 'right')) { onInput(slot, { t: 'g', id: p.id, a: 'setup', trk: (cfg.trk + (key === 'right' ? 1 : W.TRACKS.length - 1)) % W.TRACKS.length, laps: cfg.laps, bots: cfg.bots }); }
      else if (phase === 'results' && (key === 'cr' || key === 'start')) startRace();
      else if (phase === 'results' && key === 'tri') enterSetup();
    }
    /* Roster changes: a human who left mid-race is taken over by a bot; newcomers during a race just spectate. */
    function onPlayers(list) {
      if (stopped) return;
      players = (list || []).slice().sort(function (a, b) { return a.slot - b.slot; });
      var ids = {}; players.forEach(function (p) { ids[p.id] = p; });
      cars.forEach(function (c) {
        if (c.human && !ids[c.id]) { c.human = false; c.auto = true; c.name = c.name + ' (bot)'; c.botIdx = 9; c.skill = 0.82; stateDirty = true; }
        else if (c.human) c.slot = ids[c.id].slot;
      });
      for (var k in ready) if (!ids[k]) delete ready[k];
      for (k in inp) if (!ids[k]) delete inp[k];
      if (phase === 'setup') cfg.bots = clamp(cfg.bots, 0, MAX_CARS - Math.min(players.length, MAX_HUMANS));
      if (typeof layoutPanes === 'function') layoutPanes();
      stateDirty = true;
    }

    /* =====================================================================
     * 3b  CAR PHYSICS, COLLISIONS, BOTS
     * Arcade-sim: single-track model in the car's own frame (u forward, v sideways, r yaw rate).
     *   u' = a_long + v*r        v' = -u*r + tyreLateral + banking
     * tyreLateral is clamped by the grip limit G, so pushing past it makes the car slide (drift).
     * The car is glued to the track surface (y from the spline), so it can never flip; a stuck car is respawned.
     * =================================================================== */
    var TAU = Math.PI * 2, WB = 2.7, accum = 0, leadProg = 0;
    function wrapA(a) { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; }
    /* Largest useful steering angle at speed u: about what the tyres can turn into at their limit (speed-sensitive steering). */
    function maxDelta(u) { var a = Math.abs(u); return Math.min(0.5, Math.atan(1.12 * (15 + 0.0022 * a * a) * WB / Math.max(a * a, 4))); }

    /* Fixed-step driver. dt = frame time. */
    function stepPhysics(dt) {
      if (!tr) return;
      var run = released && (phase === 'count' || phase === 'race' || phase === 'finish');
      if (phase === 'paused') return;
      accum = Math.min(accum + dt, 0.1);
      while (accum >= STEP) { accum -= STEP; if (run) stepAll(STEP); else idleCars(STEP); }
    }
    /* Before GO: cars sit on the grid; the wheel can still be wiggled and the engine revs. */
    function idleCars(h) {
      for (var i = 0; i < cars.length; i++) {
        var c = cars[i], s = inp[c.id];
        c.steerIn += ((s && c.human ? s.steer : 0) - c.steerIn) * Math.min(1, h * 12);
        c.steerVis = lerp(c.steerVis, c.steerIn * 0.5, Math.min(1, h * 14));
        c.thr = s && c.human ? s.thr : 0; c.brk = s && c.human ? s.brk : 0;
        c.u = c.v = c.vx = c.vz = c.yawRate = c.speed = c.kmh = 0; c.gear = 0; c.rpm = lerp(c.rpm, 0.3 + 0.6 * c.thr, Math.min(1, h * 6));
      }
    }
    function stepAll(h) {
      var i, c;
      leadProg = -1e9; for (i = 0; i < cars.length; i++) if (cars[i].human && !cars[i].finished && cars[i].prog > leadProg) leadProg = cars[i].prog;
      for (i = 0; i < cars.length; i++) { c = cars[i]; controls(c, h); stepCar(c, h); }
      collideCars(h);
    }

    /* ---- input -> controls (humans), or bot controller */
    function controls(c, h) {
      if (!c.human || c.auto) { botControl(c, h); return; }
      var s = inp[c.id], ok = s && (clock - s.t) < 0.5;             // no packet for 0.5 s = hands off
      var st = ok ? s.steer : 0, th = ok ? s.thr : 0, bk = ok ? s.brk : 0;
      c.steerIn += (st - c.steerIn) * Math.min(1, h * 16); c.thr = th; c.brk = bk;
    }

    function stepCar(c, h) {
      var q = c.q, fx = Math.cos(c.yaw), fz = Math.sin(c.yaw), rx = -fz, rz = fx, N = tr.N;
      var u = c.vx * fx + c.vz * fz, v = c.vx * rx + c.vz * rz;          // world velocity -> body frame
      var alat = Math.abs(q.lat), onRoad = alat <= q.h, onKerb = alat <= q.h + 1.5;
      var surf = onRoad ? 1 : (onKerb ? 0.9 : 0.55); c.off = !onKerb;
      var thr = c.thr, brk = c.brk;
      if (c.tc) thr *= clamp(1.25 - (Math.abs(v) - 2) / 7, 0.4, 1);     // traction control trims power while sliding
      // ---- longitudinal
      var a = 0;
      if (u < -0.5 && thr > 0.1) a = 28 * thr;                           // driving forward while rolling back: brake first
      else if (brk > 0.1 && thr < 0.1 && u < 1.5) a = u > -12 ? -9 * brk : 0;   // standstill + brake = reverse
      else {
        a += thr * (24 * Math.max(0, 1 - u / 90) + (u < 12 ? 8 * (1 - u / 12) : 0));
        if (thr < 0.05) a -= 2.2;
        a -= brk * (u > 0.5 ? 38 : 0);
      }
      a -= Math.sign(u) * 0.0011 * u * u;                                  // air drag
      if (c.off) a -= Math.sign(u) * (3 + 0.3 * Math.abs(u));              // grass / gravel slowdown
      else if (!onRoad) a -= Math.sign(u) * 1.5;                           // kerb
      var grade = (tr.Y[(q.i + 1) % N] - tr.Y[q.i]) / tr.ds, align = fx * q.hx + fz * q.hz;
      a -= 9.81 * grade * align;                                           // climbing / descending
      a -= Math.min(10, 0.8 * Math.abs(v)) * Math.sign(u || 1);            // scrub from sliding
      // ---- steering / yaw
      var G = surf * (15 + 0.0022 * u * u);
      var delta = c.steerIn * maxDelta(u), yawT = (u / WB) * Math.tan(delta);
      var lim = 1.15 * G / Math.max(Math.abs(u), 1); yawT = clamp(yawT, -lim, lim);   // front tyres saturate -> understeer
      var Gr = G * (1 - 0.32 * brk * Math.min(1, Math.abs(c.steerIn) * 2));          // braking while turning unloads the rear
      if (!c.tc) Gr *= 1 - 0.22 * thr * Math.min(1, Math.abs(u) / 40);              // TC off: power oversteer
      var over = Gr < G * 0.97 ? 2 : 1;
      yawT += over === 2 ? -v * 0.07 : v * 0.12;                                   // reduced rear grip: tail swings the nose (drift); normal grip: weathervane stability
      c.yawRate += (yawT - c.yawRate) * Math.min(1, h * 9);
      c.yawRate = clamp(c.yawRate, -2.8, 2.8);
      // ---- lateral (tyre force clamped by grip) + banking
      var tyre = clamp(-9 * v, -Gr, Gr), r = c.yawRate;
      var gb = onRoad ? 9.81 * Math.sin(q.bank) * (q.rx * rx + q.rz * rz) : 0;
      var du = (a + v * r) * h, dv = (-u * r + tyre + gb) * h;
      u += du; v += dv;
      c.slip = clamp(Math.max(Math.abs(v) / 3.2, (brk > 0.85 && u > 25) ? 0.7 : 0, (thr > 0.9 && u > 3 && u < 22 && !c.tc) ? 0.55 : 0), 0, 1.5);
      // ---- integrate heading + position
      c.yaw = wrapA(c.yaw + r * h);
      fx = Math.cos(c.yaw); fz = Math.sin(c.yaw); rx = -fz; rz = fx;
      c.vx = u * fx + v * rx; c.vz = u * fz + v * rz; c.u = u; c.v = v; c.speed = u;
      c.x += c.vx * h; c.z += c.vz * h;
      // ---- track state + walls
      W.query(tr, c.x, c.z, c.hint, q); c.hint = q.i;
      var wl = q.wall - 1.0;
      if (Math.abs(q.lat) > wl) {
        var sd = q.lat > 0 ? 1 : -1, ov = Math.abs(q.lat) - wl;
        c.x -= q.rx * sd * ov; c.z -= q.rz * sd * ov;
        var vn = (c.vx * q.rx + c.vz * q.rz) * sd;                         // closing speed into the wall
        if (vn > 0) {
          c.vx -= 1.25 * vn * sd * q.rx; c.vz -= 1.25 * vn * sd * q.rz;
          var f = 1 - clamp(vn * 0.035, 0.02, 0.45); c.vx *= f; c.vz *= f; c.yawRate *= 0.55;
          onCollision(c, vn, c.x + q.rx * sd, q.gy, c.z + q.rz * sd);
        }
      }
      trackProgress(c);
      c.y = q.gy;
      // ---- body attitude (pitch from slope/accel, roll from bank/cornering), smoothing
      var kk = Math.min(1, h * 8), ep = Math.atan(grade * align) + clamp(a * 0.004, -0.05, 0.05);
      var er = (onRoad ? q.bank : -Math.sign(q.lat) * 0) + clamp(-0.012 * u * r, -0.09, 0.09);
      c.pitch += (ep - c.pitch) * kk; c.roll += (er - c.roll) * kk;
      c.steerVis += (c.steerIn * Math.min(0.5, maxDelta(u) * 3) - c.steerVis) * Math.min(1, h * 14);
      c.wheelAng = (c.wheelAng + (u / 0.34) * h) % (TAU * 1000);
      // ---- telemetry
      c.kmh = Math.abs(u) * 3.6;
      var TH = [0, 55, 95, 140, 185, 230, 999], g = 1; while (g < 6 && c.kmh >= TH[g]) g++;
      var frac = clamp((c.kmh - TH[g - 1]) / (TH[g] - TH[g - 1] || 1), 0, 1);
      c.gear = u < -0.8 ? -1 : (c.kmh < 2 && c.thr < 0.05 ? 0 : g);
      c.rpm += ((0.32 + 0.6 * frac + 0.08 * c.thr) - c.rpm) * Math.min(1, h * 12);
      c.shake = Math.max(0, c.shake - h * 1.8);
      if (c.respT > 0) c.respT -= h;
      c.wrongT = (u > 3 || u < -3) && (c.vx * q.hx + c.vz * q.hz) < -3 ? c.wrongT + h : 0;
      // ---- stuck / lost / long wrong way -> respawn on the road
      if (phase === 'race' && !c.finished) {
        var trying = c.thr > 0.2 || !c.human;
        if (Math.abs(u) < 1.5 && trying) c.stuckT += h; else c.stuckT = 0;
        if (c.stuckT > 4 || Math.abs(q.lat) > q.wall + 10 || c.wrongT > 8) respawn(c);
      }
    }

    /* Put a car back on the centre line 5 m behind where it was, pointing the right way. */
    function respawn(c) {
      var s = ((c.q.s - 5) % tr.L + tr.L) % tr.L, i = Math.floor(s / tr.ds) % tr.N, p = [0, 0, 0];
      W.pointAt(tr, i, 0, 0, p);
      c.x = p[0]; c.z = p[2]; c.y = p[1]; c.yaw = Math.atan2(tr.HZ[i], tr.HX[i]);
      c.u = c.v = c.vx = c.vz = c.yawRate = 0; c.speed = 0; c.stuckT = 0; c.wrongT = 0; c.respT = 1.5; c.pitch = c.roll = 0;
      W.query(tr, c.x, c.z, i, c.q); c.hint = c.q.i; trackProgress(c);
      if (c.human) stateDirty = true;
    }

    /* ---- car to car: 3 circles per car, impulse with yaw torque */
    var OFFS = [-1.4, 0, 1.4], CR = 0.98, INERTIA = 2.6;
    function collideCars(h) {
      var i, j, a, b, m, n;
      for (i = 0; i < cars.length; i++) for (j = i + 1; j < cars.length; j++) {
        a = cars[i]; b = cars[j];
        var dx0 = a.x - b.x, dz0 = a.z - b.z; if (dx0 * dx0 + dz0 * dz0 > 36) continue;
        if (a.respT > 0 || b.respT > 0) continue;                         // ghost while respawning
        var fax = Math.cos(a.yaw), faz = Math.sin(a.yaw), fbx = Math.cos(b.yaw), fbz = Math.sin(b.yaw);
        for (m = 0; m < 3; m++) for (n = 0; n < 3; n++) {
          var pax = a.x + fax * OFFS[m], paz = a.z + faz * OFFS[m], pbx = b.x + fbx * OFFS[n], pbz = b.z + fbz * OFFS[n];
          var dx = pax - pbx, dz = paz - pbz, d2 = dx * dx + dz * dz;
          if (d2 >= 4 * CR * CR || d2 < 1e-6) continue;
          var d = Math.sqrt(d2), nx = dx / d, nz = dz / d, pen = 2 * CR - d;
          a.x += nx * pen * 0.5; a.z += nz * pen * 0.5; b.x -= nx * pen * 0.5; b.z -= nz * pen * 0.5;
          var cx = (pax + pbx) / 2, cz = (paz + pbz) / 2, rax = cx - a.x, raz = cz - a.z, rbx = cx - b.x, rbz = cz - b.z;
          var vax = a.vx - a.yawRate * raz, vaz = a.vz + a.yawRate * rax, vbx = b.vx - b.yawRate * rbz, vbz = b.vz + b.yawRate * rbx;
          var vn = (vax - vbx) * nx + (vaz - vbz) * nz;
          if (vn >= 0) continue;
          var ca = rax * nz - raz * nx, cb = rbx * nz - rbz * nx, den = 2 + ca * ca / INERTIA + cb * cb / INERTIA, jn = -(1.25) * vn / den;
          a.vx += jn * nx; a.vz += jn * nz; b.vx -= jn * nx; b.vz -= jn * nz;
          a.yawRate = clamp(a.yawRate + jn * ca / INERTIA, -3, 3); b.yawRate = clamp(b.yawRate - jn * cb / INERTIA, -3, 3);
          onCollision(a, -vn, cx, a.y, cz); onCollision(b, -vn, cx, b.y, cz);
        }
      }
    }

    /* ---- bots (also drive finished cars and cars whose human left) */
    function botControl(c, h) {
      var N = tr.N, ds = tr.ds, q = c.q, u = Math.max(c.u, 0), i, o;
      var look = 8 + 0.35 * u, idx = (q.i + Math.round(look / ds)) % N;
      // lane choice with simple avoidance of cars just ahead
      var tgt = c.lane, hw = q.h - 1.9;
      for (i = 0; i < cars.length; i++) {
        o = cars[i]; if (o === c) continue;
        var dp = o.prog - c.prog;
        if (dp > 0 && dp < 14 + u * 0.35 && Math.abs(o.q.lat - q.lat) < 2.7) tgt = q.lat + (o.q.lat >= q.lat ? -3.4 : 3.4);
      }
      tgt = clamp(tgt, -hw, hw); c.laneCur = (c.laneCur == null ? q.lat : c.laneCur); c.laneCur += clamp(tgt - c.laneCur, -2.2 * h, 2.2 * h);
      var p = [0, 0, 0]; W.pointAt(tr, idx, c.laneCur, 0, p);
      var err = wrapA(Math.atan2(p[2] - c.z, p[0] - c.x) - c.yaw), md = maxDelta(u);
      var want = clamp(Math.atan(err * 1.4) / Math.max(md, 0.04), -1, 1);
      if (c.off) want = clamp(want + (q.lat > 0 ? -0.35 : 0.35), -1, 1);
      c.steerIn += (want - c.steerIn) * Math.min(1, h * 10);
      // speed plan: lowest corner limit over the braking horizon
      var vt = 99, horizon = u * u / 30 + u * 1.2 + 25, k;       // look as far as the braking distance needs
      for (k = 0; k * ds * 5 < horizon; k++) vt = Math.min(vt, Math.sqrt(Math.pow(tr.V[(q.i + k * 5) % N], 2) + 2 * 17 * k * ds * 5));   // v^2 = v_corner^2 + 2*a*d
      var skill = c.skill;
      if (c.human === false && !c.finished && leadProg > -1e8) skill *= 1 - clamp((c.prog - leadProg) / 500, -0.07, 0.07);   // gentle rubber band
      vt *= skill; if (c.finished || c.auto && c.human) vt = Math.min(vt, 38);
      if (phase !== 'race' && phase !== 'count') vt = Math.min(vt, 25);
      c.thr = clamp((vt - u) * 0.4, 0, 1); c.brk = u > vt + 1 ? clamp((u - vt) * 0.35, 0, 1) : 0;
    }

    /* ---- per-frame visual effects (skid marks, tyre smoke, dust). dt = frame time. */
    var WHEEL = [[1.35, -0.93], [1.35, 0.93], [-1.35, -0.93], [-1.35, 0.93]];
    function carEffects(dt) {
      if (!tr || !skid || !parts) return;
      for (var i = 0; i < cars.length; i++) {
        var c = cars[i], fx = Math.cos(c.yaw), fz = Math.sin(c.yaw), rx = -fz, rz = fx, run = released && phase !== 'paused';
        for (var w = 0; w < 4; w++) {
          var x = c.x + fx * WHEEL[w][0] + rx * WHEEL[w][1], z = c.z + fz * WHEEL[w][0] + rz * WHEEL[w][1];
          var slide = run && !c.off && c.speed > 4 && (w >= 2 ? c.slip > 0.4 : (c.slip > 0.9 || (c.brk > 0.8 && c.speed > 25)));
          skid.add(c.wk[w], x, c.y, z, rx, rz, slide);
          if (w >= 2 && run) {
            if (slide && Math.random() < dt * 55 * Math.min(1, c.slip))
              parts.emit(x, c.y + 0.2, z, -c.vx * 0.05 + (Math.random() - 0.5), 0.8 + Math.random(), -c.vz * 0.05 + (Math.random() - 0.5), 0.9 + Math.random() * 0.5, 0.7, 2.6, 0.35, [0.88, 0.88, 0.9], 1.6);
            if (c.off && c.speed > 8 && Math.random() < dt * 60)
              parts.emit(x, c.y + 0.15, z, -c.vx * 0.12 + (Math.random() - 0.5) * 2, 1 + Math.random() * 1.5, -c.vz * 0.12 + (Math.random() - 0.5) * 2, 0.8 + Math.random() * 0.5, 0.8, 3, 0.5, world.env.name === 'misty' ? [0.35, 0.3, 0.22] : [0.68, 0.58, 0.4], 1.8);
          }
        }
      }
      skid.flush();
    }

    /* =====================================================================
     * 3c  RENDERER, SPLIT SCREEN, CAMERAS, ADAPTIVE QUALITY
     * One WebGLRenderer + one shared scene; every pane = setViewport/setScissor + its own camera.
     * =================================================================== */
    var root = null, renderer = null, raf = 0, lastT = 0, panes = [], layoutKey = '', ro = null, fpsEma = 60, lowT = 0, highT = 0, coolT = 0, dead = false;
    var boxW = 1, boxH = 1, orbitA = 0, ovSig = '', ovT = 0, mapT = 0, lbT = 0, dprBase = 1, ovEl = null, gestureFn = null;

    var CSS = '.ax{position:absolute;inset:0;overflow:hidden;background:#05060a;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;user-select:none}' +
      '.ax canvas.gl{position:absolute;left:0;top:0}.ax-p{position:absolute;pointer-events:none;overflow:hidden}' +
      '.ax-g{position:absolute;background:linear-gradient(160deg,rgba(255,255,255,.17),rgba(255,255,255,.04));border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);border-radius:.6em;box-shadow:0 .3em 1.2em rgba(0,0,0,.45),inset 0 1px rgba(255,255,255,.18)}' +
      '.ax-pos{left:.6em;top:.5em;padding:.3em .7em;line-height:1}.ax-pos b{font-size:2.3em}.ax-pos small{font-size:1.1em;opacity:.7}.ax-pos span{display:block;font-size:.8em;letter-spacing:.12em;margin-top:.2em;opacity:.85}' +
      '.ax-tm{left:.6em;top:5.2em;padding:.3em .7em;font-variant-numeric:tabular-nums;font-size:.9em}.ax-tm small{display:block;opacity:.65}' +
      '.ax-lb{right:.6em;top:.5em;padding:.35em .55em;font-size:.72em;min-width:9em}.ax-lb div{display:flex;gap:.45em;align-items:center;padding:.12em 0;white-space:nowrap}.ax-lb i{width:.7em;height:.7em;border-radius:50%;flex:none}.ax-lb b{width:1.2em;opacity:.7}.ax-lb .me{font-weight:800;color:#fff}' +
      '.ax-map{position:absolute;left:.6em;bottom:.6em;width:9em;height:9em;border-radius:.6em;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.15)}' +
      '.ax-sp{right:.6em;bottom:.6em;padding:.35em .8em;text-align:right;min-width:8em}.ax-v{font-size:3em;line-height:1;font-variant-numeric:tabular-nums}.ax-sp small{opacity:.7;margin-left:.3em}' +
      '.ax-gr{display:inline-block;margin:.25em 0 .2em .6em;padding:0 .5em;border-radius:.3em;background:#fff;color:#000;font-weight:900;font-size:1.2em}.ax-rev{height:.45em;border-radius:1em;background:rgba(255,255,255,.14);overflow:hidden}.ax-rev i{display:block;height:100%;width:0;background:linear-gradient(90deg,#00e0a4,#ffb020,#ff3b5c)}' +
      '.ax-ban{position:absolute;left:0;right:0;top:26%;text-align:center;font-size:2.2em;font-weight:900;letter-spacing:.08em;text-shadow:0 0 .6em rgba(0,0,0,.8)}.ax-ban.w{color:#ff4d5e}.ax-ban.f{color:#ffb020}.ax-ban.d{color:#00e0a4}' +
      '.ax-str{position:absolute;inset:0;opacity:0;background:repeating-conic-gradient(from 0deg at 50% 50%,rgba(255,255,255,0) 0 3deg,rgba(255,255,255,.16) 3deg 3.4deg);-webkit-mask:radial-gradient(circle,transparent 38%,#000 85%);mask:radial-gradient(circle,transparent 38%,#000 85%)}' +
      '.ax-bd{left:1em;right:1em;top:1em;bottom:1em;padding:.8em 1em}.ax-bd h3{margin:0 0 .5em;letter-spacing:.14em;font-size:1em;opacity:.8}.ax-bd .ax-bl{font-size:.9em}.ax-bd .ax-bl div{display:flex;gap:.5em;align-items:center;padding:.18em 0}.ax-bd i{width:.8em;height:.8em;border-radius:50%}.ax-bd .ax-map{position:absolute;right:1em;bottom:1em;left:auto;width:42%;height:auto;aspect-ratio:1}' +
      '.ax-ov{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:5}.ax-ov .ax-card{position:relative;padding:1.2em 1.8em;text-align:center;min-width:22em;max-width:90%;font-size:1.4vw}' +
      '.ax-card h1{margin:0;font-size:3.2em;letter-spacing:.06em;text-shadow:0 0 .5em #8b6cff}.ax-card h2{margin:.2em 0 0;font-size:1.8em}.ax-card p{margin:.4em 0;opacity:.8}.ax-row{display:flex;gap:2em;justify-content:center;font-size:1.4em;margin:.6em 0}.ax-row b{color:#00e0a4}' +
      '.ax-chips span{display:inline-block;margin:.2em;padding:.3em .8em;border-radius:2em;border:1px solid var(--c);color:var(--c);font-weight:800}.ax-chips .ok{background:var(--c);color:#000}.ax-hint{font-size:.9em;opacity:.7}' +
      '.ax-big{font-size:min(30vh,14vw);font-weight:900;text-shadow:0 0 .4em rgba(139,108,255,.9);text-align:center}.ax-big.sm{font-size:min(9vh,5vw)}.ax-big small{display:block;font-size:.35em;letter-spacing:.3em;opacity:.8}' +
      '.ax-res{width:100%;margin-top:.6em;border-collapse:collapse;font-size:1.1em;font-variant-numeric:tabular-nums}.ax-res td{padding:.3em .5em;border-bottom:1px solid rgba(255,255,255,.12);text-align:left}.ax-res tr.p1 td{font-size:1.25em;color:#ffd35c;font-weight:800}.ax-res tr.p2 td{color:#dfe6ee;font-weight:700}.ax-res tr.p3 td{color:#e3a26b;font-weight:700}.ax-res i{display:inline-block;width:.8em;height:.8em;border-radius:50%;margin-right:.4em}';

    function boot() {
      if (!THREE || !W) { container.innerHTML = '<div style="padding:2em;color:#fff;font:16px system-ui">Apex Rush needs Three.js r128 and games/racing-world.js to be loaded.</div>'; return false; }
      root = document.createElement('div'); root.className = 'ax';
      var st = document.createElement('style'); st.textContent = CSS; root.appendChild(st);
      try { renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }); }
      catch (e) { root.insertAdjacentHTML('beforeend', '<div style="padding:2em">WebGL is not available on this device.</div>'); container.appendChild(root); return false; }
      renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.setClearColor(0x05060a, 1);
      renderer.domElement.className = 'gl'; root.appendChild(renderer.domElement);
      ovEl = document.createElement('div'); ovEl.className = 'ax-ov'; root.appendChild(ovEl);
      container.appendChild(root);
      scene = new THREE.Scene(); sfx = makeSfx();
      dprBase = Math.min(window.devicePixelRatio || 1, 1.5);
      Q.level = 3; applyQuality();
      onResize(); if (window.ResizeObserver) { ro = new ResizeObserver(onResize); ro.observe(container); } else window.addEventListener('resize', onResize);
      gestureFn = function () { if (sfx) sfx.resume(); }; window.addEventListener('pointerdown', gestureFn); window.addEventListener('keydown', gestureFn);
      return true;
    }
    function onResize() {
      if (!renderer) return; boxW = Math.max(2, container.clientWidth || window.innerWidth); boxH = Math.max(2, container.clientHeight || window.innerHeight);
      renderer.setPixelRatio(Q.pr); renderer.setSize(boxW, boxH, false); renderer.domElement.style.width = boxW + 'px'; renderer.domElement.style.height = boxH + 'px'; layoutKey = '';
    }
    /* quality levels 0..3: pixel ratio, tree density, shadows */
    function applyQuality() {
      var nh = Math.max(1, humanCars().length || players.length), l = Q.level;
      Q.pr = Math.max(0.5, dprBase * [0.5, 0.65, 0.82, 1][l]); Q.trees = [0.25, 0.45, 0.75, 1][l]; Q.shadow = (l >= 2 && nh <= 2) ? 1 : 0; Q.shadowSize = l >= 3 ? 2048 : 1024;
      if (renderer) { renderer.setPixelRatio(Q.pr); renderer.setSize(boxW, boxH, false); }
      if (world) { world.setTreeDensity(Q.trees); world.setShadow(Q.shadow > 0, Q.shadowSize, nh <= 1 ? 60 : 80); }
    }
    function adapt(dt) {
      fpsEma += (Math.min(120, 1 / Math.max(dt, 0.001)) - fpsEma) * 0.04; coolT -= dt;
      var nh = Math.max(1, humanCars().length), target = nh <= 2 ? 56 : 28;
      if (fpsEma < target - 5) { lowT += dt; highT = 0; } else if (fpsEma >= (nh <= 2 ? 58 : 35)) { highT += dt; lowT = 0; } else { lowT = highT = 0; }
      if (lowT > 2 && Q.level > 0) { Q.level--; applyQuality(); lowT = 0; coolT = 20; }
      else if (highT > 10 && Q.level < 3 && coolT <= 0) { Q.level++; applyQuality(); highT = 0; }
    }

    /* ---- pane layout: 1 = full, 2 = side by side, 3-4 = quad, 5 = 3x2 with the 6th pane = standings + map */
    function layoutPanes() {
      if (!root || !renderer) return;
      panes.forEach(function (p) { if (p.root && p.root.parentNode) p.root.parentNode.removeChild(p.root); }); panes = [];
      var hs = phase === 'setup' ? [] : humanCars(), n = hs.length, cols, rows, k;
      if (n <= 1) { cols = 1; rows = 1; } else if (n === 2) { cols = 2; rows = 1; } else if (n <= 4) { cols = 2; rows = 2; } else { cols = 3; rows = 2; }
      for (k = 0; k < cols * rows; k++) {
        var cw = boxW / cols, ch = boxH / rows, p = { x: (k % cols) * cw + 1, y: Math.floor(k / cols) * ch + 1, w: cw - 2, h: ch - 2, car: hs[k] || null, kind: 'cam', yawS: hs[k] ? hs[k].yaw : 0, fov: 60, cam: new THREE.PerspectiveCamera(60, 1, 0.3, 1600), e: null, root: null };
        if (n === 0 || (n > 1 && k >= n)) p.kind = n === 0 ? 'orbit' : 'board';
        p.root = document.createElement('div'); p.root.className = 'ax-p'; p.root.style.cssText = 'left:' + p.x + 'px;top:' + p.y + 'px;width:' + p.w + 'px;height:' + p.h + 'px;font-size:' + Math.max(9, p.h / 34) + 'px';
        p.root.innerHTML = p.kind === 'cam' ? '<div class="ax-str"></div><div class="ax-g ax-pos"><b>1</b><small>/1</small><span></span></div><div class="ax-g ax-tm"><div></div><small></small></div><div class="ax-g ax-lb"></div><canvas class="ax-map" width="160" height="160"></canvas><div class="ax-g ax-sp"><b class="ax-v">0</b><small>km/h</small><div class="ax-gr">N</div><div class="ax-rev"><i></i></div></div><div class="ax-ban"></div>'
          : (p.kind === 'board' ? '<div class="ax-g ax-bd"><h3>STANDINGS</h3><div class="ax-bl"></div><canvas class="ax-map" width="240" height="240"></canvas></div>' : '');
        root.insertBefore(p.root, ovEl);
        if (p.kind !== 'orbit') p.e = { str: p.root.querySelector('.ax-str'), pos: p.root.querySelector('.ax-pos b'), tot: p.root.querySelector('.ax-pos small'), lap: p.root.querySelector('.ax-pos span'), t: p.root.querySelector('.ax-tm div'), b: p.root.querySelector('.ax-tm small'), lb: p.root.querySelector('.ax-lb') || p.root.querySelector('.ax-bl'), map: p.root.querySelector('canvas'), v: p.root.querySelector('.ax-v'), gr: p.root.querySelector('.ax-gr'), rev: p.root.querySelector('.ax-rev i'), ban: p.root.querySelector('.ax-ban') };
        panes.push(p);
      }
      layoutKey = (phase === 'setup' ? 's' : hs.map(function (c) { return c.id; }).join(',')) + boxW + 'x' + boxH;
    }

    /* ---- cameras: chase / far / hood, speed FOV, shake; orbit in setup; fly-around on the grid */
    function updateCameras(dt) {
      orbitA += dt * 0.12;
      panes.forEach(function (p) {
        if (p.kind === 'board') return; var cam = p.cam, c = p.car;
        cam.aspect = p.w / p.h;
        if (!c || p.kind === 'orbit') {
          var b = tr.bounds, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, r = Math.max(b.x1 - b.x0, b.z1 - b.z0) * 0.62;
          cam.position.set(cx + Math.cos(orbitA) * r, tr.Y[0] + 75, cz + Math.sin(orbitA) * r); cam.lookAt(cx, tr.Y[0] - 5, cz); cam.fov = 52; cam.updateProjectionMatrix(); return;
        }
        var spd = c.kmh, d = wrapA(c.yaw - p.yawS); p.yawS += d * Math.min(1, dt * 7);
        var fx = Math.cos(p.yawS), fz = Math.sin(p.yawS), mode = c.cam, px, py, pz, lx, ly, lz;
        if (phase === 'grid') {
          var a = ct * 0.9 + c.grid, rr = 11; px = c.x + Math.cos(a) * rr; py = c.y + 3.4; pz = c.z + Math.sin(a) * rr; lx = c.x; ly = c.y + 1; lz = c.z;
        } else if (mode === 0) { var dist = 7 + spd * 0.006; px = c.x - fx * dist; py = c.y + 2.5; pz = c.z - fz * dist; lx = c.x + fx * 8; ly = c.y + 1.1; lz = c.z + fz * 8; }
        else if (mode === 1) { px = c.x - fx * 14; py = c.y + 5.8; pz = c.z - fz * 14; lx = c.x + fx * 10; ly = c.y + 0.8; lz = c.z + fz * 10; }
        else { var hx = Math.cos(c.yaw), hz = Math.sin(c.yaw); px = c.x + hx * 0.5; py = c.y + 1.2; pz = c.z + hz * 0.5; lx = c.x + hx * 30; ly = c.y + 1.15; lz = c.z + hz * 30; }
        var sh = c.shake * 0.35 + clamp(spd / 300, 0, 1) * 0.05;
        px += (Math.random() - 0.5) * sh; py += (Math.random() - 0.5) * sh; pz += (Math.random() - 0.5) * sh;
        cam.position.set(px, Math.max(py, c.y + 0.9), pz); cam.lookAt(lx, ly, lz);
        var fovT = (mode === 2 ? 72 : 60) + clamp(spd / 260, 0, 1) * 20; p.fov += (fovT - p.fov) * Math.min(1, dt * 4); cam.fov = p.fov; cam.updateProjectionMatrix();
      });
    }
    function renderAll() {
      renderer.setScissorTest(true);
      for (var i = 0; i < panes.length; i++) {
        var p = panes[i], vy = boxH - p.y - p.h;
        renderer.setViewport(p.x, vy, p.w, p.h); renderer.setScissor(p.x, vy, p.w, p.h);
        if (p.kind === 'board') { renderer.setClearColor(0x0a0c12, 1); renderer.clear(); continue; }
        world.followCamera(p.cam); parts.setView(p.h * renderer.getPixelRatio(), p.cam.fov);
        for (var k = 0; k < cars.length; k++) if (cars[k].model) cars[k].model.tag.visible = cars[k] !== p.car;
        if (world.shadowOn && p.car) world.updateShadow(p.car.x, p.car.y, p.car.z);
        renderer.render(scene, p.cam);
      }
      renderer.setScissorTest(false);
    }

    /* =====================================================================
     * 3d  HUD, TV OVERLAYS, AUDIO, MAIN LOOP, API
     * =================================================================== */
    function setT(el, v) { if (el._v !== v) { el._v = v; el.textContent = v; } }
    function leaderHtml(me, max) {
      var order = cars.slice().sort(function (a, b) { return a.pos - b.pos; }), h = '', i;
      for (i = 0; i < order.length && i < max; i++) h += '<div' + (order[i] === me ? ' class="me"' : '') + '><b>' + order[i].pos + '</b><i style="background:' + order[i].color + '"></i>' + order[i].name + '</div>';
      if (me && me.pos > max) h += '<div class="me"><b>' + me.pos + '</b><i style="background:' + me.color + '"></i>' + me.name + '</div>';
      return h;
    }
    function drawMap(p) {
      var cv = p.e.map, g = cv.getContext('2d'), s = cv.width, pts = world.outline.pts, i, pad = 14;
      g.clearRect(0, 0, s, s); g.lineJoin = 'round'; g.lineCap = 'round';
      function P(u, v) { return [pad + u * (s - 2 * pad), pad + v * (s - 2 * pad)]; }
      g.beginPath(); for (i = 0; i <= pts.length; i++) { var q = P(pts[i % pts.length][0], pts[i % pts.length][1]); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }
      g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = s * 0.07; g.stroke(); g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = s * 0.035; g.stroke();
      var sf = P(pts[0][0], pts[0][1]); g.fillStyle = '#fff'; g.fillRect(sf[0] - 3, sf[1] - 3, 6, 6);
      cars.forEach(function (c) { var m = world.outline.map(c.x, c.z), q = P(m[0], m[1]), me = c === p.car; g.beginPath(); g.arc(q[0], q[1], me ? s * 0.055 : s * 0.036, 0, TAU); g.fillStyle = c.color; g.fill(); if (me) { g.lineWidth = 2.5; g.strokeStyle = '#fff'; g.stroke(); } });
    }
    function updateHud(dt) {
      mapT += dt; lbT += dt; var doMap = mapT > 0.066, doLb = lbT > 0.25; if (doMap) mapT = 0; if (doLb) lbT = 0;
      panes.forEach(function (p) {
        if (!p.e) return;
        if (p.kind === 'board') { if (doLb) p.e.lb.innerHTML = leaderHtml(null, 8); if (doMap && world) drawMap(p); return; }
        var c = p.car, e = p.e; if (!c) return;
        setT(e.pos, String(c.pos)); setT(e.tot, '/' + cars.length); setT(e.lap, 'LAP ' + Math.max(1, Math.min(c.lap, cfg.laps)) + '/' + cfg.laps);
        var cur = released && c.maxLap >= 1 && !c.finished ? raceT - c.lapT0 : 0;
        setT(e.t, fmtTime(c.finished ? c.finishT : cur)); setT(e.b, 'BEST ' + (c.best < 1e8 ? fmtTime(c.best) : '--:--.---'));
        setT(e.v, String(Math.round(c.kmh))); setT(e.gr, c.gear < 0 ? 'R' : (c.gear === 0 ? 'N' : String(c.gear)));
        e.rev.style.width = Math.round(clamp(c.rpm, 0, 1) * 100) + '%'; e.str.style.opacity = clamp((c.kmh - 150) / 150, 0, 0.9).toFixed(2);
        var ban = '', cl = '';
        if (c.finished) { ban = 'FINISHED  P' + c.finPos; cl = 'd'; }
        else if (c.wrongT > 1) { ban = 'WRONG WAY'; cl = 'w'; }
        else if (released && c.lap === cfg.laps && raceT - c.lapT0 < 3.5) { ban = 'FINAL LAP'; cl = 'f'; }
        else if (c.respT > 0) { ban = ''; }
        if (e.ban._v !== ban) { e.ban._v = ban; e.ban.textContent = ban; e.ban.className = 'ax-ban ' + cl; }
        if (doLb) e.lb.innerHTML = leaderHtml(c, 5); if (doMap && world) drawMap(p);
      });
    }
    function ovHtml() {
      if (phase === 'setup') {
        return '<div class="ax-g ax-card"><h1>APEX RUSH</h1><h2>' + W.names[cfg.trk] + '</h2><p>' + W.moods[cfg.trk] + '</p><div class="ax-row"><span>LAPS <b>' + cfg.laps + '</b></span><span>BOTS <b>' + cfg.bots + '</b></span></div><div class="ax-chips">' +
          players.map(function (p) { var ok = isP1(p.id) || ready[p.id]; return '<span style="--c:' + colorOfSlot(p.slot) + '" class="' + (ok ? 'ok' : '') + '">P' + (p.slot + 1) + (isP1(p.id) ? ' HOST' : (ready[p.id] ? ' READY' : '')) + '</span>'; }).join('') +
          '</div><p class="ax-hint">Player 1: pick the track and laps on your phone, then press START RACE.<br>Everyone else: tap READY.</p></div>';
      }
      if (phase === 'grid') return '<div class="ax-big sm">' + W.names[cfg.trk] + '<small>GET READY</small></div>';
      if (phase === 'count') return '<div class="ax-big">' + (cdVal > 0 ? cdVal : 'GO!') + '</div>';
      if (phase === 'finish') return '<div class="ax-big sm">FINISH!</div>';
      if (phase === 'paused') return '<div class="ax-g ax-card"><h1>PAUSED</h1><p>Player 1 can resume from the phone menu.</p></div>';
      if (phase === 'results') {
        return '<div class="ax-g ax-card"><h1>RESULTS</h1><table class="ax-res"><tr><td></td><td>DRIVER</td><td>TIME</td><td>BEST LAP</td></tr>' + results.slice(0, 8).map(function (r) {
          return '<tr class="p' + r.pos + '"><td>' + r.pos + '</td><td><i style="background:' + r.color + '"></i>' + r.name + '</td><td>' + (r.t > 0 ? fmtTime(r.t) : 'DNF') + '</td><td>' + fmtTime(r.best) + '</td></tr>'; }).join('') +
          '</table><p class="ax-hint">Player 1: Race again or Menu on the phone.</p></div>';
      }
      return '';
    }
    /* ---- WebAudio (procedural): engine, squeal, collision, countdown beeps, lap, finish fanfare */
    function makeSfx() {
      var ac = null, master = null, eng = null, sq = null, nb = null, ok = true;
      function init() {
        if (ac || !ok) return;
        try {
          ac = new (window.AudioContext || window.webkitAudioContext)(); master = ac.createGain(); master.gain.value = 0.5; master.connect(ac.destination);
          var o1 = ac.createOscillator(), o2 = ac.createOscillator(), lp = ac.createBiquadFilter(), g = ac.createGain();
          o1.type = 'sawtooth'; o2.type = 'square'; lp.type = 'lowpass'; lp.frequency.value = 600; g.gain.value = 0; o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(master); o1.start(); o2.start(); eng = { o1: o1, o2: o2, lp: lp, g: g };
          var buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), d = buf.getChannelData(0), i; for (i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; nb = buf;
          var src = ac.createBufferSource(); src.buffer = buf; src.loop = true; var bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 5; var sg = ac.createGain(); sg.gain.value = 0;
          src.connect(bp); bp.connect(sg); sg.connect(master); src.start(); sq = { g: sg };
        } catch (e) { ok = false; }
      }
      function tone(f, t0, dur, type, vol) {
        if (!ac) return; var o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + t0; o.type = type || 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.25, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
      }
      return {
        resume: function () { init(); if (ac) { if (ac.state === 'suspended') ac.resume(); master.gain.setTargetAtTime(0.5, ac.currentTime, 0.05); } },
        silence: function () { if (ac) master.gain.setTargetAtTime(0, ac.currentTime, 0.05); },
        engine: function (rpm, thr, on) { if (!eng) return; var t = ac.currentTime; eng.o1.frequency.setTargetAtTime(38 + rpm * 150, t, 0.04); eng.o2.frequency.setTargetAtTime((38 + rpm * 150) * 0.5, t, 0.04); eng.lp.frequency.setTargetAtTime(350 + rpm * 1700 + thr * 700, t, 0.05); eng.g.gain.setTargetAtTime(on ? 0.04 + 0.07 * (0.3 + 0.7 * thr) : 0, t, 0.08); },
        squeal: function (l) { if (sq) sq.g.gain.setTargetAtTime(clamp(l, 0, 1) * 0.09, ac.currentTime, 0.05); },
        beep: function () { tone(660, 0, 0.22, 'sine', 0.3); }, go: function () { tone(1320, 0, 0.6, 'sine', 0.35); },
        lap: function () { tone(880, 0, 0.12, 'triangle', 0.25); tone(1175, 0.12, 0.18, 'triangle', 0.25); },
        finish: function () { [523, 659, 784, 1047, 784, 1047, 1319].forEach(function (f, i) { tone(f, i * 0.14, 0.3, 'square', 0.16); }); },
        collision: function (s) { if (!ac) return; var src = ac.createBufferSource(), g = ac.createGain(), lp = ac.createBiquadFilter(), t = ac.currentTime; src.buffer = nb; lp.type = 'lowpass'; lp.frequency.value = 900 + 2500 * s;
          g.gain.setValueAtTime(0.5 * s + 0.1, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3); src.connect(lp); lp.connect(g); g.connect(master); src.start(t, Math.random() * 0.5, 0.35); tone(70, 0, 0.2, 'sine', 0.35 * s + 0.1); },
        close: function () { try { if (ac) ac.close(); } catch (e) { /* ignore */ } ac = null; }
      };
    }

    /* ---- main loop ---- */
    function frame(now) {
      if (dead) return; raf = requestAnimationFrame(frame);
      var dt = Math.min(0.05, Math.max(0.0005, (now - lastT) / 1000)); lastT = now; if (!lastT) return;
      if (!tr) return;
      var key = (phase === 'setup' ? 's' : humanCars().map(function (c) { return c.id; }).join(',')) + boxW + 'x' + boxH; if (key !== layoutKey) layoutPanes();
      updateFlow(dt); stepPhysics(dt); carEffects(dt); if (parts && phase !== 'paused') parts.update(dt);
      cars.forEach(placeModel); updateCameras(dt); renderAll(); updateHud(dt); adapt(dt);
      ovT += dt; if (ovT > 0.1) { ovT = 0; var h = ovHtml(); if (h !== ovSig) { ovSig = h; ovEl.innerHTML = h; } }
      var lead = panes[0] && panes[0].car; if (sfx) { if (lead && phase !== 'paused') { sfx.engine(lead.rpm, lead.thr, phase === 'race' || phase === 'count' || phase === 'finish'); } else sfx.engine(0.2, 0, false);
        var sl = 0; cars.forEach(function (c) { if (c.human && c.speed > 8 && !c.off) sl = Math.max(sl, c.slip > 0.4 ? c.slip : 0); }); sfx.squeal(phase === 'paused' ? 0 : sl); }
    }
    function stop() {
      if (dead) return; dead = true; if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect(); window.removeEventListener('resize', onResize); if (gestureFn) { window.removeEventListener('pointerdown', gestureFn); window.removeEventListener('keydown', gestureFn); }
      stopped = true; if (sfx) sfx.close(); try { disposeWorld(); } catch (e) { /* ignore */ }
      if (renderer) { renderer.dispose(); if (renderer.forceContextLoss) renderer.forceContextLoss(); }
      if (root && root.parentNode) root.parentNode.removeChild(root);
    }

    /* ---- go ---- */
    if (boot()) {
      onPlayers(ctx.players || []); enterSetup(); layoutPanes(); lastT = performance.now(); raf = requestAnimationFrame(frame);
    } else stopped = true;
    return { stop: stop, onPlayers: onPlayers, onButton: onButton, onInput: onInput };
  }

  /* ---------------------------------------------------------------- PUBLIC CONTRACT */
  var inst = null;
  window.NovaGames.racing = {
    start: function (ctx) { if (inst) { try { inst.stop(); } catch (e) { /* ignore */ } } inst = createGame(ctx); },
    stop: function () { if (inst) { try { inst.stop(); } catch (e) { /* ignore */ } inst = null; } },
    onPlayers: function (list) { if (inst) inst.onPlayers(list); },
    onButton: function (slot, key) { if (inst) inst.onButton(slot, key); },
    onInput: function (slot, msg) { if (inst) inst.onInput(slot, msg); }
  };
})();
