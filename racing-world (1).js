/* ===========================================================================
 * Apex Rush  -  WORLD module  (tracks, scenery, cars, particles)
 * ---------------------------------------------------------------------------
 * Loaded BEFORE games/racing.js. Exposes window.Apex.World. Pure Three.js r128,
 * everything procedural (no models, textures, fonts or images). All names are
 * invented. Units: metres, seconds. Y is up. Heading vector h = (hx,hz),
 * right vector r = (-hz, hx). Positive lateral = right of the centre line.
 * Positive bank = right edge LOWER (banked into a right-hand turn).
 *
 * Chunks of this file: 2a helpers/tracks/sampling/road meshes,
 * 2b scenery (sky, hills, trees, stands, bridges, lights), 2c cars + particles.
 * ========================================================================= */
(function () {
  'use strict';
  var Apex = window.Apex = window.Apex || {};

  /* ---------------------------------------------------------------- helpers */
  var TAU = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rng(seed) {                       // small deterministic PRNG (mulberry32)
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function mod(a, n) { return ((a % n) + n) % n; }
  function hex3(h) { return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]; }
  function mix3(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  function blur(src, r) {                    // circular box blur
    var n = src.length, out = new Float32Array(n), i, k, s;
    for (i = 0; i < n; i++) { s = 0; for (k = -r; k <= r; k++) s += src[mod(i + k, n)]; out[i] = s / (2 * r + 1); }
    return out;
  }

  /* ----------------------------------------------------- TRACK DEFINITIONS
   * pts: [x, z, y, width, maxBankDeg]  (closed loop, start line at point 0,
   * heading towards point 1). Bank sign is automatic from the turn direction.
   * ro = run-off width beyond the kerbs (the barrier stands at its end).
   * base = height of the ground / sea far below the elevated road.        */
  var TRACKS = [
    { id: 0, name: 'Saltcliff Run', mood: 'Coastal hills at golden hour', base: -36, ro: 9,
      pal: { grass: 0x5f8f4a, dirt: 0xb59b6a, kerbA: 0xe8e8ee, kerbB: 0xd92b3a, wallA: 0xdfe3ea, wallB: 0x2b6cff },
      pts: [[0, 0, 10, 16, 0], [140, 0, 10, 16, 0], [230, -30, 8, 15, 4], [300, -110, 2, 14, 8], [310, -200, -6, 14, 6],
        [270, -250, -14, 13, 12], [210, -230, -20, 13, 12], [175, -280, -26, 13, 12], [110, -340, -26, 14, 6],
        [0, -350, -20, 15, 0], [-110, -320, -10, 15, 4], [-190, -250, 0, 14, 6], [-200, -150, 6, 14, 0],
        [-150, -60, 10, 15, 5], [-70, -10, 10, 16, 0]] },
    { id: 1, name: 'Meridian Park', mood: 'Bright midday park circuit', base: -3, ro: 11,
      pal: { grass: 0x58a64a, dirt: 0xc9b98a, kerbA: 0xffffff, kerbB: 0x1f9bff, wallA: 0xf2f2f2, wallB: 0xff7a1a },
      pts: [[-200, 0, 0, 18, 0], [0, 0, 1, 18, 0], [200, 0, 2, 18, 0], [300, 10, 3, 17, 6], [345, 70, 4, 16, 10],
        [320, 140, 4, 16, 10], [250, 180, 3, 16, 6], [170, 175, 2, 16, 0], [120, 150, 1, 15, 0], [80, 185, 1, 15, 0],
        [30, 150, 1, 15, 0], [-10, 185, 1, 15, 0], [-70, 160, 2, 16, 0], [-170, 170, 3, 17, 3], [-270, 160, 4, 16, 8],
        [-335, 100, 4, 16, 10], [-325, 30, 2, 17, 8], [-275, -5, 0, 18, 4]] },
    { id: 2, name: 'Pinewake Ring', mood: 'Misty evening forest ring', base: -4, ro: 10,
      pal: { grass: 0x2f6b3a, dirt: 0x7b6a4a, kerbA: 0xf4f4f4, kerbB: 0xf2b21a, wallA: 0xc9ced6, wallB: 0x1d9d6a },
      pts: [[-60, 175, 4, 16, 0], [60, 175, 4, 16, 0], [170, 160, 6, 16, 6], [260, 110, 8, 18, 22], [292, 10, 9, 18, 24],
        [262, -90, 8, 18, 22], [170, -150, 6, 16, 8], [60, -165, 4, 15, 0], [-30, -120, 3, 14, 5], [-110, -150, 2, 14, 8],
        [-200, -120, 4, 15, 8], [-262, -40, 6, 16, 6], [-250, 70, 6, 16, 6], [-180, 140, 5, 16, 4]] }
  ];

  /* ------------------------------------------------------ SPLINE SAMPLING */
  function catmull(p0, p1, p2, p3, t, out) {
    var t2 = t * t, t3 = t2 * t;
    for (var k = 0; k < 5; k++)
      out[k] = 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
  }
  /* Build the dense, arc-length uniform sample table for a track definition. */
  function buildTrack(def) {
    var P = def.pts, n = P.length, SUB = 48, dense = [], i, j, tmp = [0, 0, 0, 0, 0];
    for (i = 0; i < n; i++) for (j = 0; j < SUB; j++) {
      catmull(P[mod(i - 1, n)], P[i], P[(i + 1) % n], P[(i + 2) % n], j / SUB, tmp);
      dense.push(tmp.slice());
    }
    var m = dense.length, cum = new Float64Array(m + 1), d;
    for (i = 0; i < m; i++) {
      var a = dense[i], b = dense[(i + 1) % m];
      cum[i + 1] = cum[i] + Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]) + (b[2] - a[2]) * (b[2] - a[2]));
    }
    var L = cum[m], N = Math.round(L / 2), ds = L / N;
    var X = new Float32Array(N), Z = new Float32Array(N), Y = new Float32Array(N), W = new Float32Array(N), BM = new Float32Array(N);
    var k = 0;
    for (i = 0; i < N; i++) {
      var s = i * ds; while (k < m - 1 && cum[k + 1] < s) k++;
      var f = (s - cum[k]) / Math.max(1e-6, cum[k + 1] - cum[k]), A0 = dense[k], A1 = dense[(k + 1) % m];
      X[i] = lerp(A0[0], A1[0], f); Z[i] = lerp(A0[1], A1[1], f); Y[i] = lerp(A0[2], A1[2], f);
      W[i] = lerp(A0[3], A1[3], f); BM[i] = lerp(A0[4], A1[4], f);
    }
    var HX = new Float32Array(N), HZ = new Float32Array(N), RX = new Float32Array(N), RZ = new Float32Array(N), TH = new Float32Array(N), S = new Float32Array(N);
    for (i = 0; i < N; i++) {
      var p = mod(i - 1, N), q = (i + 1) % N, dx = X[q] - X[p], dz = Z[q] - Z[p], hl = Math.sqrt(dx * dx + dz * dz) || 1;
      HX[i] = dx / hl; HZ[i] = dz / hl; RX[i] = -HZ[i]; RZ[i] = HX[i]; TH[i] = Math.atan2(HZ[i], HX[i]); S[i] = i * ds;
    }
    // signed curvature dTheta/ds (right turn = positive), smoothed
    var K = new Float32Array(N);
    for (i = 0; i < N; i++) {
      d = TH[(i + 1) % N] - TH[mod(i - 1, N)]; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU;
      K[i] = d / (2 * ds);
    }
    K = blur(K, 4);
    var B = new Float32Array(N);
    for (i = 0; i < N; i++) B[i] = BM[i] * Math.PI / 180 * clamp(K[i] / 0.0035, -1, 1);
    B = blur(B, 8);
    // corner speed limits (m/s) with a backwards braking pass, used by the bots
    var V = new Float32Array(N), pass;
    for (i = 0; i < N; i++) {
      // grip model must match racing.js: lateral limit = 15 + 0.0022 v^2 (+ banking help)  =>  v^2 * (k - 0.0022) = 15 + g*tan(bank)
      var kk = Math.max(Math.abs(K[i]), 1e-4), lat = 15 + 9.8 * Math.tan(Math.abs(B[i]));
      V[i] = clamp(Math.sqrt(lat / Math.max(kk - 0.0022, 0.0004)), 16, 92);
    }
    for (pass = 0; pass < 3; pass++) for (i = N - 1; i >= 0; i--) {
      var nx = V[(i + 1) % N], lim = Math.sqrt(nx * nx + 2 * 21 * ds); if (V[i] > lim) V[i] = lim;
    }
    var minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (i = 0; i < N; i++) { minX = Math.min(minX, X[i]); maxX = Math.max(maxX, X[i]); minZ = Math.min(minZ, Z[i]); maxZ = Math.max(maxZ, Z[i]); }
    return { def: def, id: def.id, name: def.name, N: N, ds: ds, L: L, X: X, Y: Y, Z: Z, W: W, B: B, K: K, V: V, HX: HX, HZ: HZ, RX: RX, RZ: RZ, S: S,
      ro: def.ro, base: def.base, bounds: { x0: minX, x1: maxX, z0: minZ, z1: maxZ } };
  }

  /* Height of the driving surface at lateral offset `lat` of sample i. Beyond the kerbs the run-off is flat at the edge height. */
  function surfY(tr, i, lat) {
    var h = tr.W[i] * 0.5; return tr.Y[i] - clamp(lat, -h, h) * Math.tan(tr.B[i]);
  }
  /* Point on the track cross-section: writes [x,y,z] into out. */
  function pointAt(tr, i, lat, dy, out) {
    i = mod(i, tr.N); out[0] = tr.X[i] + tr.RX[i] * lat; out[1] = surfY(tr, i, lat) + (dy || 0); out[2] = tr.Z[i] + tr.RZ[i] * lat; return out;
  }

  /* Nearest-sample query for physics. `hint` = previous index (local search window; falls back to a global scan
   * after a teleport). Fills and returns `o`: i, t, s, lat, h(half width), wall(lat of barrier), y(centre y), gy(ground y at the
   * car), bank, hx, hz (interpolated heading), dist2 (squared distance to the centre line). */
  function query(tr, x, z, hint, o) {
    var N = tr.N, X = tr.X, Z = tr.Z, best = -1, bd = 1e30, bt = 0, R = 12, c, idx, t, ax, az, dx, dz, px, pz, d2, j, wide = (hint == null || hint < 0);
    for (c = wide ? 0 : -R; c <= (wide ? N - 1 : R); c++) {
      idx = wide ? c : mod(hint + c, N); j = (idx + 1) % N;
      ax = X[idx]; az = Z[idx]; dx = X[j] - ax; dz = Z[j] - az;
      t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
      px = ax + dx * t; pz = az + dz * t; d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 < bd) { bd = d2; best = idx; bt = t; }
    }
    var lim = tr.W[best] * 0.5 + tr.ro + 25;
    if (!wide && bd > lim * lim) return query(tr, x, z, -1, o);          // lost the track: global search
    var i = best, k = (i + 1) % N, rx = lerp(tr.RX[i], tr.RX[k], bt), rz = lerp(tr.RZ[i], tr.RZ[k], bt), rl = Math.sqrt(rx * rx + rz * rz) || 1;
    rx /= rl; rz /= rl;
    px = lerp(X[i], X[k], bt); pz = lerp(Z[i], Z[k], bt);
    o.i = i; o.t = bt; o.s = tr.S[i] + bt * tr.ds; o.lat = (x - px) * rx + (z - pz) * rz;
    o.h = lerp(tr.W[i], tr.W[k], bt) * 0.5; o.wall = o.h + tr.ro; o.y = lerp(tr.Y[i], tr.Y[k], bt);
    o.bank = lerp(tr.B[i], tr.B[k], bt); o.hx = rz; o.hz = -rx;           // heading = right rotated back
    o.gy = o.y - clamp(o.lat, -o.h, o.h) * Math.tan(o.bank); o.dist2 = bd; o.rx = rx; o.rz = rz;
    return o;
  }

  /* Starting grid slot k (0 = pole). Two staggered columns behind the start line, facing along the track. */
  function gridSlot(tr, k) {
    var row = Math.floor(k / 2), col = k % 2, s = tr.L - 9 - row * 8 - col * 3.5, i = Math.floor(s / tr.ds) % tr.N, lat = (col ? 3.3 : -3.3), p = [0, 0, 0];
    pointAt(tr, i, lat, 0, p);
    return { x: p[0], y: p[1], z: p[2], hx: tr.HX[i], hz: tr.HZ[i], i: i, s: s, lat: lat };
  }

  /* Down-sampled outline for the HUD minimap: array of [u,v] in 0..1 plus the aspect-preserving mapper. */
  function mapOutline(tr, count) {
    var b = tr.bounds, w = b.x1 - b.x0, h = b.z1 - b.z0, sc = Math.max(w, h), out = [], i;
    for (i = 0; i < count; i++) { var idx = Math.floor(i * tr.N / count); out.push([(tr.X[idx] - b.x0 + (sc - w) / 2) / sc, (tr.Z[idx] - b.z0 + (sc - h) / 2) / sc]); }
    return { pts: out, map: function (x, z) { return [(x - b.x0 + (sc - w) / 2) / sc, (z - b.z0 + (sc - h) / 2) / sc]; } };
  }

  /* ------------------------------------------------------------ MESH TOOLS
   * Tiny geometry builder: pushes positions / colours / uvs, builds indexed BufferGeometry with vertex colours. */
  function GeoBuf() { this.p = []; this.c = []; this.u = []; this.i = []; this.n = 0; }
  GeoBuf.prototype.v = function (x, y, z, col, u, v) { this.p.push(x, y, z); this.c.push(col[0], col[1], col[2]); this.u.push(u || 0, v || 0); return this.n++; };
  GeoBuf.prototype.tri = function (a, b, c) { this.i.push(a, b, c); };
  GeoBuf.prototype.quad = function (a, b, c, d) { this.i.push(a, b, c, b, d, c); };
  GeoBuf.prototype.build = function (THREE, normals) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeVertexNormals(); g.computeBoundingSphere(); return g;
  };
  /* Append a transformed THREE geometry (box, cone...) with a flat colour; m = THREE.Matrix4. */
  GeoBuf.prototype.addGeo = function (geo, m, col, jitter, rand) {
    var pos = geo.attributes.position, idx = geo.index, base = this.n, k, e = m.elements;
    var j = jitter ? (1 + (rand() - 0.5) * jitter) : 1;
    for (k = 0; k < pos.count; k++) {
      var x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
      this.v(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14], [col[0] * j, col[1] * j, col[2] * j], 0, 0);
    }
    if (idx) for (k = 0; k < idx.count; k++) this.i.push(base + idx.getX(k));
    else for (k = 0; k < pos.count; k++) this.i.push(base + k);
  };

  /* Ribbon along the whole (closed) track between two rings.
   * o.l0/o.l1: lateral offsets (number | fn(i)), o.y0/o.y1: height above the surface (number | fn(i)),
   * o.col(i,k) -> [r,g,b] for ring k (0|1), o.uv(i,k) -> [u,v]. i0..i1 optional sample range (open, not wrapped). */
  function ribbon(gb, tr, o) {
    var N = tr.N, i, k, p = [0, 0, 0], i0 = o.i0 || 0, i1 = (o.i1 == null ? N : o.i1), ring = [];
    function val(f, i) { return typeof f === 'function' ? f(i) : f; }
    var first = gb.n;
    for (i = i0; i <= i1; i++) {
      var ii = i % N;
      for (k = 0; k < 2; k++) {
        pointAt(tr, ii, val(k ? o.l1 : o.l0, ii), val(k ? o.y1 : o.y0, ii), p);
        var c = o.col ? o.col(ii, k) : [1, 1, 1], uv = o.uv ? o.uv(i, k) : [k, i * tr.ds];
        gb.v(p[0], p[1], p[2], c, uv[0], uv[1]);
      }
    }
    for (i = 0; i < i1 - i0; i++) { var a = first + i * 2; gb.quad(a, a + 1, a + 2, a + 3); }
  }
  Apex._ribbon = ribbon;

  /* ----------------------------------------------------- PROCEDURAL TEXTURES */
  function canvasTex(THREE, w, h, draw, rx, ry) {
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h; draw(cv.getContext('2d'), w, h);
    var t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx || 1, ry || 1);
    t.anisotropy = 4; return t;
  }
  function asphaltTexture(THREE) {            // u across the road (0..1), v along (one tile = 12 m)
    return canvasTex(THREE, 256, 256, function (g, w, h) {
      var r = rng(7), i;
      g.fillStyle = '#3a3b40'; g.fillRect(0, 0, w, h);
      for (i = 0; i < 5200; i++) { var v = 40 + r() * 46; g.fillStyle = 'rgba(' + v + ',' + v + ',' + (v + 4) + ',' + (0.25 + r() * 0.4) + ')'; g.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2); }
      g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(w * 0.30, 0, w * 0.14, h); g.fillRect(w * 0.56, 0, w * 0.14, h);   // rubbered-in racing lines
      g.fillStyle = 'rgba(255,255,255,.92)'; g.fillRect(w * 0.035, 0, 5, h); g.fillRect(w * 0.965 - 5, 0, 5, h);   // edge lines
      g.fillStyle = 'rgba(255,255,255,.55)'; for (i = 0; i < 2; i++) g.fillRect(w * 0.5 - 2, i * h * 0.5, 4, h * 0.22);  // dashed centre
    }, 1, 1);
  }
  function grassTexture(THREE) {
    return canvasTex(THREE, 128, 128, function (g, w, h) {
      var r = rng(11), i;
      g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, w, h);
      for (i = 0; i < 2600; i++) { var v = 120 + r() * 120; g.fillStyle = 'rgba(' + v + ',' + v + ',' + v + ',' + (0.25 + r() * 0.5) + ')'; g.fillRect(r() * w, r() * h, 2, 2 + r() * 3); }
    }, 1, 1);
  }
  Apex._tex = { canvasTex: canvasTex, asphalt: asphaltTexture, grass: grassTexture };

  /* ---------------------------------------------------- ROAD-LEVEL MESHES
   * Returns THREE.Group with road, kerbs, run-off, barriers and the embankment skirt. All Lambert, vertex coloured. */
  function buildRoad(THREE, tr, q) {
    var pal = tr.def.pal, g = new THREE.Group(), N = tr.N, ds = tr.ds, ro = tr.ro, KW = 1.5;
    var cG = hex3(pal.grass), cD = hex3(pal.dirt), cKA = hex3(pal.kerbA), cKB = hex3(pal.kerbB), cWA = hex3(pal.wallA), cWB = hex3(pal.wallB);
    var half = function (i) { return tr.W[i] * 0.5; };
    var tex = { road: asphaltTexture(THREE), grass: grassTexture(THREE) };
    // ---- road
    var gb = new GeoBuf();
    ribbon(gb, tr, { l0: function (i) { return -half(i); }, l1: half, y0: 0, y1: 0, uv: function (i, k) { return [k, i * ds / 12]; } });
    var road = new THREE.Mesh(gb.build(THREE), new THREE.MeshLambertMaterial({ map: tex.road, color: 0xffffff }));
    road.receiveShadow = true; g.add(road);
    // start / finish line (chequered strip) drawn as a thin ribbon slightly above the road
    var sf = new GeoBuf();
    for (var cx = 0; cx < 8; cx++) for (var cz = 0; cz < 2; cz++) {
      (function (cx, cz) {
        var c = ((cx + cz) % 2) ? [0.06, 0.06, 0.06] : [1, 1, 1];
        ribbon(sf, tr, { i0: cz, i1: cz + 1, l0: function (i) { return -half(0) + cx * tr.W[0] / 8; }, l1: function (i) { return -half(0) + (cx + 1) * tr.W[0] / 8; }, y0: 0.03, y1: 0.03, col: function () { return c; } });
      })(cx, cz);
    }
    g.add(new THREE.Mesh(sf.build(THREE), new THREE.MeshLambertMaterial({ vertexColors: true })));
    // ---- kerbs (alternating colour every 3 samples = 6 m), both sides
    var kb = new GeoBuf();
    [-1, 1].forEach(function (sd) {
      ribbon(kb, tr, { l0: function (i) { return sd * half(i); }, l1: function (i) { return sd * (half(i) + KW); }, y0: 0.05, y1: 0.05,
        col: function (i) { return (Math.floor(i / 3) % 2) ? cKA : cKB; } });
    });
    var kerb = new THREE.Mesh(kb.build(THREE), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })); kerb.receiveShadow = true; g.add(kerb);
    // ---- run-off: 3 m painted/gravel zone then grass, flat at the road-edge height
    var rf = new GeoBuf();
    [-1, 1].forEach(function (sd) {
      ribbon(rf, tr, { l0: function (i) { return sd * (half(i) + KW); }, l1: function (i) { return sd * (half(i) + KW + 3.5); }, y0: 0.02, y1: 0.02,
        col: function () { return cD; }, uv: function (i, k) { return [k, i * ds / 6]; } });
      ribbon(rf, tr, { l0: function (i) { return sd * (half(i) + KW + 3.5); }, l1: function (i) { return sd * (half(i) + ro); }, y0: 0.02, y1: 0.02,
        col: function (i, k) { var t = 0.9 + 0.12 * Math.sin(i * 0.21 + k); return [cG[0] * t, cG[1] * t, cG[2] * t]; }, uv: function (i, k) { return [k * 2, i * ds / 6]; } });
    });
    var runoff = new THREE.Mesh(rf.build(THREE), new THREE.MeshLambertMaterial({ vertexColors: true, map: tex.grass, side: THREE.DoubleSide })); runoff.receiveShadow = true; g.add(runoff);
    // ---- barriers: 1.1 m wall with a coloured stripe pattern + a dark top cap
    var bb = new GeoBuf();
    [-1, 1].forEach(function (sd) {
      ribbon(bb, tr, { l0: function (i) { return sd * (half(i) + ro); }, l1: function (i) { return sd * (half(i) + ro); }, y0: 0, y1: 1.1,
        col: function (i, k) { var c = (Math.floor(i / 10) % 2) ? cWA : cWB; return k ? [c[0] * 0.9, c[1] * 0.9, c[2] * 0.9] : c; } });
      ribbon(bb, tr, { l0: function (i) { return sd * (half(i) + ro); }, l1: function (i) { return sd * (half(i) + ro + 0.5); }, y0: 1.1, y1: 1.1, col: function () { return [0.16, 0.17, 0.2]; } });
    });
    var wall = new THREE.Mesh(bb.build(THREE), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })); wall.castShadow = false; wall.receiveShadow = true; g.add(wall);
    // ---- embankment skirt: slopes from the barrier foot down to the ground level (so elevated road never floats)
    var sk = new GeoBuf();
    [-1, 1].forEach(function (sd) {
      ribbon(sk, tr, { l0: function (i) { return sd * (half(i) + ro); }, y0: 0,
        l1: function (i) { return sd * (half(i) + ro + Math.max(3, (surfY(tr, i, sd * half(i)) - tr.base) * 1.15)); }, y1: function (i) { return tr.base - surfY(tr, i, sd * half(i)); },
        col: function (i, k) { var t = k ? 0.78 : 1; return [cG[0] * t, cG[1] * t, cG[2] * t]; }, uv: function (i, k) { return [k * 3, i * ds / 6]; } });
    });
    var skirt = new THREE.Mesh(sk.build(THREE), new THREE.MeshLambertMaterial({ vertexColors: true, map: tex.grass, side: THREE.DoubleSide })); skirt.receiveShadow = true; g.add(skirt);
    g.userData.textures = [tex.road, tex.grass];
    return g;
  }

  /* =====================================================================
   * 2b  SCENERY  (time of day, sky, sun + flare, hills, trees, stands...)
   * =================================================================== */
  var ENV = [
    { name: 'golden', top: 0x2f5fc4, hor: 0xffc08a, gnd: 0x6a5a48, sunAz: 2.4, sunEl: 0.26, sunCol: 0xffb067, sunI: 1.15, hemiS: 0xffd2a8, hemiG: 0x4b5a3a, hemiI: 0.75,
      fog: 0xf0b98c, near: 140, far: 950, exposure: 1.05, sea: 0x1c6fa6, trees: 900, pines: 0.15, spread: 60, slopeOnly: true, hillH: 95, hillCol: 0x7f8a5e, hillFar: 0xc79a7a, flare: 1 },
    { name: 'midday', top: 0x2d7be6, hor: 0xcfe6ff, gnd: 0x80907a, sunAz: 0.9, sunEl: 1.0, sunCol: 0xfff3dc, sunI: 1.3, hemiS: 0xbfdcff, hemiG: 0x5c7a45, hemiI: 0.8,
      fog: 0xcfe3f5, near: 200, far: 1200, exposure: 1.0, trees: 1500, pines: 0.3, spread: 90, hillH: 60, hillCol: 0x6b9a6a, hillFar: 0x9fbbd6, flare: 1 },
    { name: 'misty', top: 0x1f2f46, hor: 0x93a2ac, gnd: 0x39463c, sunAz: 4.0, sunEl: 0.13, sunCol: 0xff9a5c, sunI: 0.85, hemiS: 0x8fa3b8, hemiG: 0x2a3a2c, hemiI: 0.7,
      fog: 0x8a9aa2, near: 40, far: 520, exposure: 0.95, trees: 3000, pines: 0.85, spread: 120, hillH: 80, hillCol: 0x2c4a3a, hillFar: 0x6f8590, flare: 0.7 }
  ];

  function frameM(THREE, x, y, z, hx, hz, sx, sy, sz) {     // unit box -> oriented box (x = along heading, z = right)
    var m = new THREE.Matrix4();
    m.makeBasis(new THREE.Vector3(hx * sx, 0, hz * sx), new THREE.Vector3(0, sy, 0), new THREE.Vector3(-hz * sz, 0, hx * sz));
    m.setPosition(x, y, z); return m;
  }
  function radialTex(THREE, stops) {
    return canvasTex(THREE, 128, 128, function (g, w, h) {
      var gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      stops.forEach(function (s) { gr.addColorStop(s[0], s[1]); }); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    }, 1, 1);
  }

  /* ---- sky dome: gradient + sun glow (ShaderMaterial, centred on the camera) ---- */
  function buildSky(THREE, env, sunDir) {
    var mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(env.top) }, hor: { value: new THREE.Color(env.hor) }, gnd: { value: new THREE.Color(env.gnd) },
        sunDir: { value: sunDir.clone() }, sunCol: { value: new THREE.Color(env.sunCol) } },
      vertexShader: 'varying vec3 vD;void main(){vD=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: 'uniform vec3 top,hor,gnd,sunCol,sunDir;varying vec3 vD;void main(){vec3 d=normalize(vD);float h=d.y;' +
        'vec3 c=mix(hor,top,pow(clamp(h,0.0,1.0),0.55));c=mix(c,gnd,smoothstep(0.0,-0.18,h));' +
        'float s=max(dot(d,sunDir),0.0);c+=sunCol*(pow(s,900.0)*4.0+pow(s,48.0)*0.45+pow(s,6.0)*0.16);' +
        'c=mix(c,hor,exp(-abs(h)*9.0)*0.35);gl_FragColor=vec4(c,1.0);}'
    });
    var m = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), mat); m.frustumCulled = false; m.renderOrder = -10; return m;
  }

  /* ---- distant hills: jagged ridge rings around the circuit ---- */
  function ridge(THREE, cx, cz, baseY, radius, hmax, colTop, colBot, seed, mask) {
    var gb = new GeoBuf(), S = 120, r = rng(seed), p1 = r() * 6, p2 = r() * 6, p3 = r() * 6, k;
    for (k = 0; k <= S; k++) {
      var a = k / S * TAU, n = 0.5 + 0.28 * Math.sin(a * 3 + p1) + 0.16 * Math.sin(a * 7 + p2) + 0.1 * Math.sin(a * 17 + p3);
      var hh = hmax * clamp(n, 0.1, 1) * (mask ? mask(a) : 1), rr = radius * (1 + 0.05 * Math.sin(a * 5 + p2));
      var x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      gb.v(x, baseY - 30, z, colBot); gb.v(x, baseY + hh, z, colTop);
    }
    for (k = 0; k < S; k++) gb.quad(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 3);
    return new THREE.Mesh(gb.build(THREE), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  }

  /* ---- trees: two merged low-poly species drawn as InstancedMesh, density adjustable at runtime ---- */
  function treeGeometry(THREE, kind, rand) {
    var gb = new GeoBuf(), I = new THREE.Matrix4(), tr = hex3(0x5a3f26);
    function at(y, sx, sy, sz) { return new THREE.Matrix4().makeScale(sx, sy, sz).setPosition(0, y, 0); }
    gb.addGeo(new THREE.CylinderGeometry(0.25, 0.4, 2.4, 5), at(1.2, 1, 1, 1), tr);
    if (kind === 'pine') {
      var g = hex3(0x1f5a34);
      gb.addGeo(new THREE.ConeGeometry(2.3, 3.6, 7), at(3.6, 1, 1, 1), g);
      gb.addGeo(new THREE.ConeGeometry(1.8, 3.2, 7), at(5.6, 1, 1, 1), [g[0] * 1.1, g[1] * 1.15, g[2] * 1.1]);
      gb.addGeo(new THREE.ConeGeometry(1.2, 2.8, 7), at(7.5, 1, 1, 1), [g[0] * 1.25, g[1] * 1.3, g[2] * 1.2]);
    } else {
      var l = hex3(0x4f9a3c);
      gb.addGeo(new THREE.IcosahedronGeometry(2.3, 0), at(4.2, 1.1, 0.95, 1.1), l);
      gb.addGeo(new THREE.IcosahedronGeometry(1.5, 0), new THREE.Matrix4().makeScale(1, 1, 1).setPosition(1.2, 5.4, 0.5), [l[0] * 1.15, l[1] * 1.15, l[2] * 1.1]);
    }
    return gb.build(THREE);
  }
  function placeTrees(tr, count, env, rand) {
    var out = [], tries = 0, N = tr.N, j, ok;
    while (out.length < count && tries++ < count * 10) {
      var i = Math.floor(rand() * N), sd = rand() < 0.5 ? -1 : 1, h = tr.W[i] * 0.5, wall = h + tr.ro, eY = surfY(tr, i, sd * h);
      var sw = Math.max(3, (eY - tr.base) * 1.15), d = 2 + Math.pow(rand(), 1.5) * env.spread;
      if (env.slopeOnly && d >= sw * 0.9) continue;                       // coastal track: no trees in the sea
      var lat = sd * (wall + d), x = tr.X[i] + tr.RX[i] * lat, z = tr.Z[i] + tr.RZ[i] * lat;
      var y = d < sw ? eY - (eY - tr.base) * (d / sw) : tr.base;
      ok = true;
      for (j = 0; j < N; j += 2) { var dx = x - tr.X[j], dz = z - tr.Z[j], lim = tr.W[j] * 0.5 + tr.ro + 1.5; if (dx * dx + dz * dz < lim * lim) { ok = false; break; } }
      if (ok) out.push([x, y, z, 0.8 + rand() * 0.9, rand() * TAU, rand()]);
    }
    return out;
  }
  function buildTrees(THREE, tr, env, rand) {
    var list = placeTrees(tr, env.trees, env, rand), pineN = 0, i, objs = [];
    var kinds = { pine: [], leaf: [] };
    list.forEach(function (t) { (t[5] < env.pines ? kinds.pine : kinds.leaf).push(t); });
    var group = new THREE.Group(), meshes = [], dummy = new THREE.Object3D(), col = new THREE.Color();
    ['pine', 'leaf'].forEach(function (kind) {
      var arr = kinds[kind]; if (!arr.length) return;
      var im = new THREE.InstancedMesh(treeGeometry(THREE, kind, rand), new THREE.MeshLambertMaterial({ vertexColors: true }), arr.length);
      for (i = 0; i < arr.length; i++) {
        var t = arr[i]; dummy.position.set(t[0], t[1], t[2]); dummy.rotation.set(0, t[4], 0); dummy.scale.set(t[3], t[3] * (0.9 + 0.3 * t[5]), t[3]); dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        var tint = 0.78 + 0.4 * ((t[5] * 7.31) % 1); col.setRGB(tint, tint * (0.95 + 0.1 * ((t[5] * 3.7) % 1)), tint * 0.95); im.setColorAt(i, col);
      }
      im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.frustumCulled = false; im.userData.total = arr.length; group.add(im); meshes.push(im);
    });
    group.userData.setDensity = function (f) { meshes.forEach(function (m) { m.count = Math.max(0, Math.floor(m.userData.total * clamp(f, 0, 1))); }); };
    return group;
  }

  /* ---- grandstand: tiers, crowd riser texture, roof + pillars. Merged into 2 meshes. ---- */
  function crowdTexture(THREE) {
    return canvasTex(THREE, 128, 32, function (g, w, h) {
      var r = rng(5), i, pal = ['#e63946', '#f1c40f', '#2ec5ff', '#ffffff', '#8b6cff', '#00e0a4', '#ff7a1a', '#222'];
      g.fillStyle = '#2a2d34'; g.fillRect(0, 0, w, h);
      for (i = 0; i < 380; i++) { g.fillStyle = pal[Math.floor(r() * pal.length)]; g.fillRect(r() * w, r() * h, 2 + r() * 2, 3 + r() * 3); }
    }, 1, 1);
  }
  function addStand(THREE, bx, cr, tr, i, side, len, unit) {
    var h = tr.W[i] * 0.5, hx = tr.HX[i], hz = tr.HZ[i], eY = surfY(tr, i, side * h), tiers = 6, tw = 2.2, th = 1.0, d0 = 5, k;
    var rx = tr.RX[i] * side, rz = tr.RZ[i] * side, bx0 = tr.X[i] + tr.RX[i] * side * (h + tr.ro), bz0 = tr.Z[i] + tr.RZ[i] * side * (h + tr.ro);
    function P(u, d, y) { return [bx0 + hx * u + rx * d, eY + y, bz0 + hz * u + rz * d]; }
    var base = Math.max(0, eY - tr.base) + 1;
    bx.addGeo(unit, frameM(THREE, P(0, d0 + 4, 0)[0], eY - base / 2, P(0, d0 + 4, 0)[2], hx, hz, len, base, tiers * tw + 2), hex3(0x4a4d55));
    for (k = 0; k < tiers; k++) {
      var c = P(0, d0 + k * tw + tw / 2, (k + 1) * th / 2);
      bx.addGeo(unit, frameM(THREE, c[0], c[1], c[2], hx, hz, len, (k + 1) * th, tw), hex3(k % 2 ? 0x6b707c : 0x7d8290));
      var a = P(-len / 2, d0 + k * tw, th * k), b = P(len / 2, d0 + k * tw, th * k), a2 = P(-len / 2, d0 + k * tw, th * (k + 1)), b2 = P(len / 2, d0 + k * tw, th * (k + 1));
      var w = [1, 1, 1], q = cr.n;
      cr.v(a[0], a[1], a[2], w, 0, 1); cr.v(b[0], b[1], b[2], w, len / 3, 1); cr.v(a2[0], a2[1], a2[2], w, 0, 0); cr.v(b2[0], b2[1], b2[2], w, len / 3, 0);
      cr.quad(q, q + 1, q + 2, q + 3);
    }
    var rf = P(0, d0 + 6, tiers * th + 4.5);
    bx.addGeo(unit, frameM(THREE, rf[0], rf[1], rf[2], hx, hz, len + 2, 0.35, tiers * tw + 3), hex3(0xe8ebf0));
    [-1, 1].forEach(function (e) {
      [d0 + 0.5, d0 + tiers * tw].forEach(function (d) { var pc = P(e * (len / 2 - 0.5), d, (tiers * th + 4) / 2); bx.addGeo(unit, frameM(THREE, pc[0], pc[1], pc[2], hx, hz, 0.4, tiers * th + 4, 0.4), hex3(0xbfc4cc)); });
    });
  }
  /* ---- start gantry + footbridges (banner = canvas text; invented sponsors only) ---- */
  function bannerTexture(THREE, text, c1, c2) {
    return canvasTex(THREE, 1024, 128, function (g, w, h) {
      var gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, c1); gr.addColorStop(1, c2); g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,.9)'; g.font = '900 78px system-ui,Arial,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, w / 2, h / 2 + 4); g.fillStyle = 'rgba(0,0,0,.25)'; for (var i = 0; i < 12; i++) g.fillRect(i * 90 + 20, 0, 24, h);
    }, 1, 1);
  }
  function addGantry(THREE, bx, group, tr, i, text, c1, c2, unit) {
    var h = tr.W[i] * 0.5, hx = tr.HX[i], hz = tr.HZ[i], span = h + tr.ro + 1.6, y = surfY(tr, i, 0), k;
    [-1, 1].forEach(function (sd) {
      var x = tr.X[i] + tr.RX[i] * sd * span, z = tr.Z[i] + tr.RZ[i] * sd * span, ey = surfY(tr, i, sd * (h + tr.ro)), ph = 9 + (y - tr.base > 6 ? 0 : 0);
      bx.addGeo(unit, frameM(THREE, x, ey + ph / 2, z, hx, hz, 1.2, ph, 1.2), hex3(0x30343c));
    });
    bx.addGeo(unit, frameM(THREE, tr.X[i], y + 9, tr.Z[i], hx, hz, 1.4, 1.4, span * 2 + 1.2), hex3(0x20242b));
    var bm = new THREE.Mesh(new THREE.PlaneGeometry(2 * span - 1, 3.2), new THREE.MeshBasicMaterial({ map: bannerTexture(THREE, text, c1, c2), side: THREE.DoubleSide, fog: true }));
    bm.position.set(tr.X[i], y + 7.1, tr.Z[i]); bm.rotation.y = Math.atan2(-hx, hz) + 0;      // face along the track
    bm.lookAt(tr.X[i] + hx, y + 7.1, tr.Z[i] + hz); group.add(bm);
    group.userData.textures = (group.userData.textures || []).concat([bm.material.map]);
  }
  /* ---- support pillars + deck underside wherever the road is lifted well above the ground ---- */
  function addSupports(THREE, bx, deckGb, tr, unit) {
    var N = tr.N, i, run = null, runs = [];
    for (i = 0; i <= N; i++) {
      var hi = (tr.Y[i % N] - tr.base) > 7;
      if (hi && !run) run = i; if (!hi && run != null) { runs.push([run, i]); run = null; }
    }
    runs.forEach(function (r) {
      if (r[1] - r[0] < 6) return;
      ribbon(deckGb, tr, { i0: r[0], i1: r[1], l0: function (i) { return -tr.W[i] * 0.5 - 1.5; }, l1: function (i) { return tr.W[i] * 0.5 + 1.5; }, y0: -0.9, y1: -0.9, col: function () { return [0.55, 0.56, 0.6]; } });
      for (i = r[0]; i < r[1]; i += 14) {
        var ii = i % N, ey = surfY(tr, ii, 0), hh = ey - tr.base - 1;
        bx.addGeo(unit, frameM(THREE, tr.X[ii], tr.base + hh / 2, tr.Z[ii], tr.HX[ii], tr.HZ[ii], 2.2, hh, tr.W[ii] * 0.5), hex3(0x9aa0aa));
      }
    });
  }

  /* =====================================================================
   * 2c  SCENERY ASSEMBLY, CARS, SKID MARKS, PARTICLES
   * =================================================================== */
  /* Build the whole circuit into `scene`. Returns the world handle used by racing.js. */
  function buildScenery(THREE, scene, trackId, opts) {
    opts = opts || {};
    var def = TRACKS[trackId] || TRACKS[0], env = ENV[def.id], tr = buildTrack(def), rand = rng(1000 + def.id * 77), i;
    var group = new THREE.Group(), textures = [];
    var sunDir = new THREE.Vector3(Math.cos(env.sunEl) * Math.cos(env.sunAz), Math.sin(env.sunEl), Math.cos(env.sunEl) * Math.sin(env.sunAz)).normalize();
    scene.background = new THREE.Color(env.hor);
    scene.fog = new THREE.Fog(env.fog, env.near, env.far);
    // ---- lights
    var hemi = new THREE.HemisphereLight(env.hemiS, env.hemiG, env.hemiI), sun = new THREE.DirectionalLight(env.sunCol, env.sunI);
    sun.castShadow = false; sun.shadow.camera.near = 1; sun.shadow.camera.far = 420; sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.06;
    scene.add(hemi); scene.add(sun); scene.add(sun.target);
    // ---- sky + ground + hills
    var sky = buildSky(THREE, env, sunDir); scene.add(sky);
    var cx = (tr.bounds.x0 + tr.bounds.x1) / 2, cz = (tr.bounds.z0 + tr.bounds.z1) / 2, span = Math.max(tr.bounds.x1 - tr.bounds.x0, tr.bounds.z1 - tr.bounds.z0);
    var gTex = grassTexture(THREE); gTex.repeat.set(220, 220); textures.push(gTex);
    var gmat = env.sea ? new THREE.MeshPhongMaterial({ color: env.sea, specular: 0xffd9a8, shininess: 70 }) : new THREE.MeshLambertMaterial({ color: def.pal.grass, map: gTex });
    var ground = new THREE.Mesh(new THREE.CircleGeometry(1500, 40), gmat); ground.rotation.x = -Math.PI / 2; ground.position.set(cx, def.base - 0.05, cz); ground.receiveShadow = true; group.add(ground);
    var c1 = hex3(env.hillCol), c2 = hex3(env.hillFar), fogc = hex3(env.fog);
    var coastMask = env.sea ? function (a) { return clamp(Math.sin(a + 0.9) * 1.4 + 0.25, 0, 1); } : null;
    group.add(ridge(THREE, cx, cz, def.base, span * 0.85 + 330, env.hillH, mix3(c1, fogc, 0.25), mix3(c1, fogc, 0.6), 3 + def.id, coastMask));
    group.add(ridge(THREE, cx, cz, def.base, span * 0.85 + 520, env.hillH * 1.5, mix3(c2, fogc, 0.1), mix3(c2, fogc, 0.55), 9 + def.id, coastMask));
    // ---- road meshes
    var road = buildRoad(THREE, tr); group.add(road); textures = textures.concat(road.userData.textures);
    // ---- grandstands, gantry, footbridge, supports (merged geometry)
    var unit = new THREE.BoxGeometry(1, 1, 1), bx = new GeoBuf(), cr = new GeoBuf(), deck = new GeoBuf(), sg = new THREE.Group();
    var ic = tr.N - Math.round(70 / tr.ds);
    addStand(THREE, bx, cr, tr, ic, 1, 70, unit); addStand(THREE, bx, cr, tr, ic, -1, 70, unit);
    addStand(THREE, bx, cr, tr, Math.round(tr.N * 0.52), (def.id === 1 ? 1 : -1), 50, unit);
    addSupports(THREE, bx, deck, tr, unit);
    addGantry(THREE, bx, sg, tr, 0, 'APEX RUSH', '#3b2bd9', '#d9267a', unit);
    addGantry(THREE, bx, sg, tr, Math.round(tr.N * 0.34), 'ZENBYTE', '#0a7d6a', '#1b4fd1', unit);
    var structs = new THREE.Mesh(bx.build(THREE), new THREE.MeshLambertMaterial({ vertexColors: true })); structs.castShadow = true; structs.receiveShadow = true; group.add(structs);
    var crowdTex = crowdTexture(THREE); textures.push(crowdTex);
    group.add(new THREE.Mesh(cr.build(THREE), new THREE.MeshLambertMaterial({ map: crowdTex, side: THREE.DoubleSide })));
    if (deck.n) group.add(new THREE.Mesh(deck.build(THREE), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
    group.add(sg); textures = textures.concat(sg.userData.textures || []);
    // ---- trees
    var trees = buildTrees(THREE, tr, env, rand); group.add(trees); trees.userData.setDensity(opts.treeDensity == null ? 1 : opts.treeDensity);
    scene.add(group);
    // ---- sun flare sprites (additive, positioned per camera in followCamera)
    var coreTex = radialTex(THREE, [[0, 'rgba(255,255,255,1)'], [0.12, 'rgba(255,236,190,.95)'], [0.4, 'rgba(255,190,110,.25)'], [1, 'rgba(255,170,90,0)']]);
    var ringTex = radialTex(THREE, [[0, 'rgba(255,255,255,0)'], [0.7, 'rgba(255,255,255,.0)'], [0.86, 'rgba(255,220,170,.5)'], [1, 'rgba(255,255,255,0)']]);
    textures.push(coreTex, ringTex);
    function spr(tex, col) { var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: col, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false })); s.renderOrder = 6; s.frustumCulled = false; scene.add(s); return s; }
    var flare = [spr(coreTex, env.sunCol), spr(ringTex, 0xffd9a0), spr(coreTex, 0xffb070), spr(ringTex, 0xaad0ff)], tmpF = new THREE.Vector3(), tmpD = new THREE.Vector3();
    var world = {
      tr: tr, env: env, def: def, scene: scene, sun: sun, hemi: hemi, sky: sky, group: group, sunDir: sunDir, trees: trees, outline: mapOutline(tr, 140), shadowOn: false,
      /* centre sky + sun on the active camera and fade the flare by how directly it looks at the sun */
      followCamera: function (cam) {
        sky.position.copy(cam.position); cam.getWorldDirection(tmpF);
        var d = tmpF.dot(sunDir), k = clamp((d - 0.62) / 0.34, 0, 1) * (env.flare || 1);
        for (var f = 0; f < flare.length; f++) {
          var t = f === 0 ? 1 : (f === 1 ? 0.55 : (f === 2 ? 0.0 : -0.5));       // ghosts slide along the sun -> screen-centre line
          tmpD.copy(sunDir).lerp(tmpF, f === 0 ? 0 : 1 - t).normalize();
          flare[f].position.copy(cam.position).addScaledVector(tmpD, f === 0 ? 880 : 700);
          var sc = f === 0 ? 260 : (f === 1 ? 120 : (f === 2 ? 70 : 150)); flare[f].scale.set(sc, sc, 1);
          flare[f].material.opacity = f === 0 ? clamp(0.25 + k, 0, 1) * (d > 0 ? 1 : 0) : k * (f === 1 ? 0.5 : 0.28);
        }
      },
      setTreeDensity: function (f) { trees.userData.setDensity(f); },
      /* shadow map on/off + size; the light box follows (x,y,z) */
      setShadow: function (on, size, range) {
        sun.castShadow = !!on; world.shadowOn = !!on;
        if (on) { var s = size || 1024, r = range || 70; if (sun.shadow.mapSize.x !== s) { sun.shadow.mapSize.set(s, s); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
          var c = sun.shadow.camera; if (c.right !== r) { c.left = -r; c.right = r; c.top = r; c.bottom = -r; c.updateProjectionMatrix(); } }
      },
      updateShadow: function (x, y, z) { sun.target.position.set(x, y, z); sun.position.set(x + sunDir.x * 150, y + sunDir.y * 150, z + sunDir.z * 150); sun.target.updateMatrixWorld(); },
      dispose: function () {
        [group].forEach(function (g) { g.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); }); }); });
        unit.dispose(); textures.forEach(function (t) { if (t && t.dispose) t.dispose(); });
        sky.geometry.dispose(); sky.material.dispose(); flare.forEach(function (s) { scene.remove(s); s.material.dispose(); });
        scene.remove(group); scene.remove(sky); scene.remove(hemi); scene.remove(sun); scene.remove(sun.target);
        if (sun.shadow && sun.shadow.map) sun.shadow.map.dispose(); scene.fog = null;
      }
    };
    return world;
  }

  /* ----------------------------------------------------------- CARS */
  var glowTexCache = null, shadowTexCache = null, envCache = {};
  function glowTex(THREE) { return glowTexCache || (glowTexCache = radialTex(THREE, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,.55)'], [1, 'rgba(255,255,255,0)']])); }
  function shadowTex(THREE) { return shadowTexCache || (shadowTexCache = radialTex(THREE, [[0, 'rgba(0,0,0,.62)'], [0.6, 'rgba(0,0,0,.3)'], [1, 'rgba(0,0,0,0)']])); }
  /* Fake reflections: a 6-face gradient cube map built from the track's sky colours (no external images). */
  function envCube(THREE, env) {
    if (envCache[env.name]) return envCache[env.name];
    var faces = [], f, top = '#' + ('000000' + env.top.toString(16)).slice(-6), hor = '#' + ('000000' + env.hor.toString(16)).slice(-6), gnd = '#' + ('000000' + env.gnd.toString(16)).slice(-6);
    for (f = 0; f < 6; f++) {
      var cv = document.createElement('canvas'); cv.width = cv.height = 64; var g = cv.getContext('2d');
      if (f === 2) { g.fillStyle = top; g.fillRect(0, 0, 64, 64); }
      else if (f === 3) { g.fillStyle = gnd; g.fillRect(0, 0, 64, 64); }
      else { var gr = g.createLinearGradient(0, 0, 0, 64); gr.addColorStop(0, top); gr.addColorStop(0.46, hor); gr.addColorStop(0.5, '#ffffff'); gr.addColorStop(0.54, gnd); gr.addColorStop(1, gnd); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); }
      if (f === 0 || f === 4) { g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(8, 14, 30, 6); }          // soft "window" highlight
      faces.push(cv);
    }
    var cube = new THREE.CubeTexture(faces); cube.needsUpdate = true; return (envCache[env.name] = cube);
  }
  function nameTag(THREE, text, color) {
    var tex = canvasTex(THREE, 256, 64, function (g, w, h) {
      g.fillStyle = 'rgba(8,8,12,.72)'; g.beginPath(); g.moveTo(24, 6); g.lineTo(w - 24, 6); g.quadraticCurveTo(w - 4, 6, w - 4, 32); g.quadraticCurveTo(w - 4, 58, w - 24, 58);
      g.lineTo(24, 58); g.quadraticCurveTo(4, 58, 4, 32); g.quadraticCurveTo(4, 6, 24, 6); g.fill();
      g.strokeStyle = color; g.lineWidth = 4; g.stroke(); g.fillStyle = '#fff'; g.font = '800 30px system-ui,Arial,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2 + 2);
    }, 1, 1);
    var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false })); s.scale.set(3.4, 0.85, 1); s.position.set(0, 2.25, 0); s.renderOrder = 4; return s;
  }
  /* Procedural low-poly GT car. Local axes: +x forward, +y up, +z right. Origin = ground contact below the centre. */
  function makeCar(THREE, color, name, env) {
    var G = new THREE.Group(), toDispose = [];
    var paint = new THREE.MeshStandardMaterial({ color: color, metalness: 0.55, roughness: 0.3, envMap: envCube(THREE, env || ENV[1]), envMapIntensity: 1.15 });
    var dark = new THREE.MeshStandardMaterial({ color: 0x16171b, metalness: 0.3, roughness: 0.6 });
    var glass = new THREE.MeshStandardMaterial({ color: 0x0c1420, metalness: 0.9, roughness: 0.12, envMap: paint.envMap, envMapIntensity: 1.4 });
    var rimM = new THREE.MeshStandardMaterial({ color: 0xcfd3da, metalness: 0.8, roughness: 0.3 });
    var tireM = new THREE.MeshLambertMaterial({ color: 0x0d0d0f });
    // side profile (x forward, y up) -> extruded across the width
    var sh = new THREE.Shape(); [[2.12, 0.36], [2.16, 0.55], [1.55, 0.7], [0.55, 0.78], [0.2, 0.98], [-0.38, 1.12], [-1.1, 1.02], [-1.7, 0.88], [-2.13, 0.84], [-2.17, 0.62], [-2.1, 0.36]]
      .forEach(function (p, k) { k ? sh.lineTo(p[0], p[1]) : sh.moveTo(p[0], p[1]); });
    var bodyGeo = new THREE.ExtrudeGeometry(sh, { depth: 1.66, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 1, steps: 1 }); bodyGeo.translate(0, 0, -0.83);
    var body = new THREE.Mesh(bodyGeo, paint); body.castShadow = true; G.add(body);
    var gs = new THREE.Shape(); [[0.42, 0.8], [0.18, 0.99], [-0.36, 1.1], [-1.0, 1.01], [-1.15, 0.86]].forEach(function (p, k) { k ? gs.lineTo(p[0], p[1]) : gs.moveTo(p[0], p[1]); });
    var glassGeo = new THREE.ExtrudeGeometry(gs, { depth: 1.5, bevelEnabled: false }); glassGeo.translate(0, 0.005, -0.75);
    G.add(new THREE.Mesh(glassGeo, glass));
    function box(m, x, y, z, w, h, d, mat) { var b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); b.position.set(x, y, z); b.castShadow = true; m.add(b); return b; }
    box(G, 2.2, 0.3, 0, 0.5, 0.07, 1.95, dark);                                   // front splitter
    box(G, -2.1, 0.3, 0, 0.5, 0.12, 1.7, dark);                                   // rear diffuser
    box(G, 0, 0.3, 0, 3.4, 0.1, 1.9, dark);                                       // floor / side skirts
    box(G, -1.98, 1.2, 0, 0.55, 0.06, 1.95, dark);                                // spoiler wing
    box(G, -1.98, 1.28, 0.99, 0.8, 0.34, 0.05, paint); box(G, -1.98, 1.28, -0.99, 0.8, 0.34, 0.05, paint);
    box(G, -1.95, 0.98, 0.5, 0.12, 0.4, 0.1, dark); box(G, -1.95, 0.98, -0.5, 0.12, 0.4, 0.1, dark);
    box(G, 0.4, 0.84, 0, 0.9, 0.02, 0.1, dark);                                   // bonnet stripe accent
    // lights: head (emissive), tail (brake-reactive)
    var headM = new THREE.MeshBasicMaterial({ color: 0xfff4cc }), tailM = new THREE.MeshBasicMaterial({ color: 0x6b1015 });
    box(G, 2.14, 0.52, 0.62, 0.1, 0.1, 0.4, headM); box(G, 2.14, 0.52, -0.62, 0.1, 0.1, 0.4, headM);
    box(G, -2.19, 0.7, 0.62, 0.05, 0.1, 0.5, tailM); box(G, -2.19, 0.7, -0.62, 0.05, 0.1, 0.5, tailM);
    var gt = glowTex(THREE), glows = [];
    function glow(x, y, z, col, s) { var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: gt, color: col, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0, fog: false })); sp.position.set(x, y, z); sp.scale.set(s, s, 1); G.add(sp); glows.push(sp); return sp; }
    var hg = [glow(2.4, 0.55, 0.62, 0xfff0c0, 1.5), glow(2.4, 0.55, -0.62, 0xfff0c0, 1.5)], tg = [glow(-2.35, 0.7, 0.62, 0xff2a2a, 1.1), glow(-2.35, 0.7, -0.62, 0xff2a2a, 1.1)];
    // wheels: pivot (steer about y) -> spin (about z) -> tyre + rim + spokes
    var tireGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 16); tireGeo.rotateX(Math.PI / 2);
    var rimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.32, 12); rimGeo.rotateX(Math.PI / 2);
    var wheels = [], wp = [[1.35, -0.93], [1.35, 0.93], [-1.35, -0.93], [-1.35, 0.93]];
    wp.forEach(function (p, k) {
      var pivot = new THREE.Group(), spin = new THREE.Group(); pivot.position.set(p[0], 0.34, p[1]); pivot.add(spin);
      var t = new THREE.Mesh(tireGeo, tireM); t.castShadow = true; spin.add(t); spin.add(new THREE.Mesh(rimGeo, rimM));
      for (var s = 0; s < 3; s++) { var sp = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.05, 0.34), dark); sp.rotation.z = s * Math.PI / 3; spin.add(sp); }
      G.add(pivot); wheels.push({ pivot: pivot, spin: spin });
    });
    // blob shadow + name tag
    var shMesh = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 2.9), new THREE.MeshBasicMaterial({ map: shadowTex(THREE), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: true }));
    shMesh.rotation.x = -Math.PI / 2; shMesh.position.y = 0.05; shMesh.renderOrder = 1; G.add(shMesh);
    var tag = nameTag(THREE, name || 'CAR', typeof color === 'string' ? color : '#ffffff'); G.add(tag);
    var car = {
      group: G, paint: paint, wheels: wheels, tag: tag, shadow: shMesh, wheelR: 0.34,
      setSteer: function (a) { wheels[0].pivot.rotation.y = -a; wheels[1].pivot.rotation.y = -a; },   // a>0 = steering right
      setSpin: function (ang) { for (var k = 0; k < 4; k++) wheels[k].spin.rotation.z = -ang; },
      setBrake: function (b) { tailM.color.setHex(b ? 0xff2430 : 0x6b1015); tg[0].material.opacity = tg[1].material.opacity = b ? 0.95 : 0.18; },
      setHeadlights: function (a) { hg[0].material.opacity = hg[1].material.opacity = a; },
      dispose: function () {
        G.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); [paint, dark, glass, rimM, tireM, headM, tailM, shMesh.material, tag.material].forEach(function (m) { if (m.map && m !== shMesh.material.map) m.map.dispose(); m.dispose(); });
        glows.forEach(function (s) { s.material.dispose(); }); tireGeo.dispose(); rimGeo.dispose();
      }
    };
    return car;
  }
  /* Orient/position a car: heading (hx,hz), pitch (nose up +), roll (right side down +). */
  var _f = null, _u = null, _r = null, _m = null;
  function setCarPose(THREE, car, x, y, z, hx, hz, pitch, roll) {
    if (!_f) { _f = new THREE.Vector3(); _u = new THREE.Vector3(); _r = new THREE.Vector3(); _m = new THREE.Matrix4(); }
    var cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    _f.set(hx * cp, sp, hz * cp); _u.set(-sp * hx, cp, -sp * hz); _r.crossVectors(_f, _u);
    _u.multiplyScalar(cr).addScaledVector(_r, -sr).normalize(); _r.crossVectors(_f, _u).normalize();
    _m.makeBasis(_f, _u, _r); car.group.quaternion.setFromRotationMatrix(_m); car.group.position.set(x, y, z);
  }

  /* ------------------------------------------------------ SKID MARKS
   * Ring buffer of black quads laid on the road; one segment per wheel per frame while sliding. */
  function SkidMarks(THREE, scene, maxSegs) {
    this.max = maxSegs || 1400; this.n = 0; this.last = {};
    this.pos = new Float32Array(this.max * 12); var idx = new Uint16Array(this.max * 6), k;
    for (k = 0; k < this.max; k++) { var a = k * 4; idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], k * 6); }
    var g = new THREE.BufferGeometry(); this.attr = new THREE.BufferAttribute(this.pos, 3); this.attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.attr); g.setIndex(new THREE.BufferAttribute(idx, 1)); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
    this.mat = new THREE.MeshBasicMaterial({ color: 0x050505, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, fog: true });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 2; scene.add(this.mesh); this.scene = scene; this.dirty = false;
  }
  /* key identifies a wheel; (x,y,z) contact point, (rx,rz) unit right vector; on=false ends the streak. */
  SkidMarks.prototype.add = function (key, x, y, z, rx, rz, on) {
    var L = this.last[key];
    if (!on) { this.last[key] = null; return; }
    var w = 0.13;
    if (L) {
      var p = this.pos, o = (this.n % this.max) * 12;
      p[o] = L[0] - L[3] * w; p[o + 1] = L[1] + 0.06; p[o + 2] = L[2] - L[4] * w; p[o + 3] = L[0] + L[3] * w; p[o + 4] = L[1] + 0.06; p[o + 5] = L[2] + L[4] * w;
      p[o + 6] = x - rx * w; p[o + 7] = y + 0.06; p[o + 8] = z - rz * w; p[o + 9] = x + rx * w; p[o + 10] = y + 0.06; p[o + 11] = z + rz * w;
      this.n++; this.dirty = true;
    }
    this.last[key] = [x, y, z, rx, rz];
  };
  SkidMarks.prototype.flush = function () { if (this.dirty) { this.attr.needsUpdate = true; this.dirty = false; } };
  SkidMarks.prototype.clear = function () { this.pos.fill(0); this.n = 0; this.last = {}; this.attr.needsUpdate = true; };
  SkidMarks.prototype.dispose = function () { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); };

  /* ----------------------------------------------------- PARTICLES
   * One Points object with a per-particle size/alpha/colour shader (smoke, dust, sparks, speed streak dots). */
  function Particles(THREE, scene, max) {
    this.max = max || 700; this.p = []; this.next = 0; var m = this.max, k;
    this.pos = new Float32Array(m * 3); this.siz = new Float32Array(m); this.alp = new Float32Array(m); this.col = new Float32Array(m * 3);
    for (k = 0; k < m; k++) this.p.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s0: 1, s1: 1, a: 1, r: 1, g: 1, b: 1, drag: 1 });
    var g = new THREE.BufferGeometry();
    this.aP = new THREE.BufferAttribute(this.pos, 3); this.aS = new THREE.BufferAttribute(this.siz, 1); this.aA = new THREE.BufferAttribute(this.alp, 1); this.aC = new THREE.BufferAttribute(this.col, 3);
    [this.aP, this.aS, this.aA, this.aC].forEach(function (a) { a.setUsage(THREE.DynamicDrawUsage); });
    g.setAttribute('position', this.aP); g.setAttribute('aSize', this.aS); g.setAttribute('aAlpha', this.aA); g.setAttribute('aCol', this.aC);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
    this.tex = radialTex(THREE, [[0, 'rgba(255,255,255,1)'], [0.5, 'rgba(255,255,255,.5)'], [1, 'rgba(255,255,255,0)']]);
    this.mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, fog: false, uniforms: { map: { value: this.tex }, uScale: { value: 600 } },
      vertexShader: 'attribute float aSize;attribute float aAlpha;attribute vec3 aCol;uniform float uScale;varying float vA;varying vec3 vC;void main(){vA=aAlpha;vC=aCol;' +
        'vec4 mv=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mv;gl_PointSize=clamp(aSize*uScale/max(0.5,-mv.z),0.0,160.0);}',
      fragmentShader: 'uniform sampler2D map;varying float vA;varying vec3 vC;void main(){vec4 t=texture2D(map,gl_PointCoord);gl_FragColor=vec4(vC,t.a*vA);if(gl_FragColor.a<0.01)discard;}' });
    this.mesh = new THREE.Points(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 5; scene.add(this.mesh); this.scene = scene;
  }
  /* emit(x,y,z, vx,vy,vz, life, size0, size1, alpha, [r,g,b], drag) */
  Particles.prototype.emit = function (x, y, z, vx, vy, vz, life, s0, s1, a, c, drag) {
    var q = this.p[this.next]; this.next = (this.next + 1) % this.max;
    q.life = q.max = life; q.x = x; q.y = y; q.z = z; q.vx = vx; q.vy = vy; q.vz = vz; q.s0 = s0; q.s1 = s1; q.a = a; q.r = c[0]; q.g = c[1]; q.b = c[2]; q.drag = drag == null ? 1.5 : drag;
  };
  Particles.prototype.update = function (dt) {
    var k, q, t, dg;
    for (k = 0; k < this.max; k++) {
      q = this.p[k];
      if (q.life > 0) {
        q.life -= dt; t = 1 - Math.max(0, q.life) / q.max; dg = Math.max(0, 1 - q.drag * dt);
        q.vx *= dg; q.vy *= dg; q.vz *= dg; q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
        this.pos[k * 3] = q.x; this.pos[k * 3 + 1] = q.y; this.pos[k * 3 + 2] = q.z; this.siz[k] = lerp(q.s0, q.s1, t);
        this.alp[k] = q.a * (1 - t) * Math.min(1, t * 8); this.col[k * 3] = q.r; this.col[k * 3 + 1] = q.g; this.col[k * 3 + 2] = q.b;
      } else this.alp[k] = 0;
    }
    this.aP.needsUpdate = this.aS.needsUpdate = this.aA.needsUpdate = this.aC.needsUpdate = true;
  };
  /* call once per viewport before rendering it: heightPx = pane height in device pixels, fovDeg = vertical FOV */
  Particles.prototype.setView = function (heightPx, fovDeg) { this.mat.uniforms.uScale.value = heightPx * 0.5 / Math.tan(fovDeg * Math.PI / 360); };
  Particles.prototype.dispose = function () { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); this.tex.dispose(); };

  /* ------------------------------------------------------------ EXPORTS */
  Apex.World = {
    TRACKS: TRACKS, ENV: ENV, names: TRACKS.map(function (t) { return t.name; }), moods: TRACKS.map(function (t) { return t.mood; }),
    buildTrack: buildTrack, query: query, surfY: surfY, pointAt: pointAt, gridSlot: gridSlot, mapOutline: mapOutline,
    buildScenery: buildScenery, makeCar: makeCar, setCarPose: setCarPose, SkidMarks: SkidMarks, Particles: Particles,
    rng: rng, clamp: clamp, lerp: lerp, mod: mod
  };
})();
