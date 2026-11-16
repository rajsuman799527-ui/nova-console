/* ===========================================================================
 * Smash Court  -  venues, court, net, stands, crowd, painterly backdrops   (file 3 of 4)
 * Needs badminton-chars.js first (shares window.SmashWorld and its lib()).
 * Venue index: 0 = sunny street, 1 = neon sunset, 2 = palm beach.  All art is procedural.
 * ========================================================================= */
(function () {
  'use strict';
  var SW = window.SmashWorld = window.SmashWorld || {};
  var TAU = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function hex(n) { return '#' + ('000000' + n.toString(16)).slice(-6); }
  function rnd(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  SW.VENUES = [
    { id: 'street', name: 'Sunny Street', court: 0x1fb8a8, apron: 0x168f86, edge: 0x2fd0c0, line: 0xffffff, floor: 0xb98a80, stand: 0xe8a0a0, standD: 0xb86a75, pillar: 0xeaa9a2, sky: 0x9fd8ff, hemiG: 0xe0a090, sun: 0xfff2d6, banner: [0xff5a7a, 0x3b8cff, 0xffd21f],
      pal: { sky: ['#8fd3ff', '#cfeeff', '#ffe9c8'], bld: ['#e9a58f', '#f3c98b', '#a9c4e6', '#d98fa5', '#9fd0a8'], tower: '#8ea0c8', foliage: ['#4fb35a', '#76cf62', '#2f9a58'], sun: '#fff4c4' }, tower: 'lumen' },
    { id: 'neon', name: 'Neon Sunset', court: 0x7b5cf0, apron: 0x5a40c8, edge: 0x9a82ff, line: 0xffffff, floor: 0xe07a4a, stand: 0xd4706a, standD: 0x8e3f55, pillar: 0xe5917e, sky: 0xff9a6a, hemiG: 0xffa070, sun: 0xffc48a, banner: [0xff3b9a, 0x2ee6d0, 0xffd21f],
      pal: { sky: ['#3b2a8f', '#e8508a', '#ffb25a'], bld: ['#3a2a78', '#5a3590', '#c2487a', '#ff7a4a', '#2a2160'], tower: '#2b1d66', foliage: ['#6a2d8a', '#9a3a8a'], sun: '#ffd08a' }, tower: 'sky' },
    { id: 'beach', name: 'Palm Beach', court: 0x2f93f0, apron: 0x2272c4, edge: 0x5db4ff, line: 0xffffff, floor: 0xf1d8a0, stand: 0xc98a52, standD: 0x8a5a34, pillar: 0xe8c69a, sky: 0x7fd0ff, hemiG: 0xf3d9a0, sun: 0xfff0c8, banner: [0xff6a3d, 0x2ee6d0, 0xffd21f],
      pal: { sky: ['#5ec4ff', '#b8ecff', '#fff1cf'], bld: ['#ffffff'], tower: '#ffffff', foliage: ['#2fb36a', '#5ad07a'], sun: '#fff7d0' }, tower: 'none' }
  ];

  /* Painterly, blurred background billboard. Drawn small with many brush strokes, then blurred and scaled up. */
  function painterly(L, v, w, h) {
    var T = L.THREE, big = L.canvas(w, h), g = big.getContext('2d'), sm = L.canvas(w / 4, h / 4), s = sm.getContext('2d'), R = rnd(v.id.length * 977 + 11), p = v.pal, i, W = sm.width, H = sm.height;
    var gr = s.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, p.sky[0]); gr.addColorStop(0.55, p.sky[1]); gr.addColorStop(1, p.sky[2]); s.fillStyle = gr; s.fillRect(0, 0, W, H);
    var sg = s.createRadialGradient(W * 0.62, H * 0.5, 4, W * 0.62, H * 0.5, H * 0.7); sg.addColorStop(0, p.sun); sg.addColorStop(1, 'rgba(255,255,255,0)'); s.fillStyle = sg; s.fillRect(0, 0, W, H);
    if (v.id === 'beach') {                                                  // sea band + sun + distant islands
      var sea = s.createLinearGradient(0, H * 0.52, 0, H); sea.addColorStop(0, '#46d6e8'); sea.addColorStop(1, '#1a8fd0'); s.fillStyle = sea; s.fillRect(0, H * 0.52, W, H * 0.48);
      s.fillStyle = 'rgba(255,255,255,.35)'; for (i = 0; i < 40; i++) s.fillRect(R() * W, H * 0.55 + R() * H * 0.4, 8 + R() * 22, 1.5);
      s.fillStyle = '#4aa57a'; s.beginPath(); s.ellipse(W * 0.2, H * 0.52, W * 0.12, H * 0.07, 0, Math.PI, 0); s.fill();
      s.beginPath(); s.ellipse(W * 0.82, H * 0.52, W * 0.1, H * 0.05, 0, Math.PI, 0); s.fill();
    } else {
      for (i = 0; i < 30; i++) {                                              // city blocks, two depth rows
        var row = i % 2, bw = W * (0.04 + R() * 0.06), bx = (i / 30) * W * 1.1 - 10, bh = H * (0.25 + R() * 0.4) * (row ? 0.8 : 1), col = p.bld[(R() * p.bld.length) | 0];
        s.globalAlpha = row ? 0.6 : 0.95; s.fillStyle = col; s.fillRect(bx, H - bh - (row ? 0 : 0), bw, bh);
        s.globalAlpha = 0.35; s.fillStyle = '#fff6c8'; for (var wy = 0; wy < bh - 6; wy += 7) for (var wx = 2; wx < bw - 3; wx += 6) if (R() > 0.45) s.fillRect(bx + wx, H - bh + wy + 2, 2.5, 3.5);
      }
      s.globalAlpha = 1;
      var cx = W * 0.5;
      if (v.tower === 'lumen') {                                              // original tapering lattice tower with ring decks
        s.fillStyle = p.tower; s.beginPath(); s.moveTo(cx - W * 0.075, H); s.quadraticCurveTo(cx - W * 0.02, H * 0.55, cx - 3, H * 0.12); s.lineTo(cx + 3, H * 0.12); s.quadraticCurveTo(cx + W * 0.02, H * 0.55, cx + W * 0.075, H); s.closePath(); s.fill();
        s.fillStyle = '#b9c6e8'; [0.62, 0.42, 0.26].forEach(function (y, k) { s.fillRect(cx - W * (0.045 - k * 0.012), H * y, W * (0.09 - k * 0.024), 3); }); s.fillRect(cx - 1, H * 0.04, 2, H * 0.1);
        s.fillStyle = 'rgba(0,0,0,.18)'; s.beginPath(); s.moveTo(cx - W * 0.03, H); s.quadraticCurveTo(cx, H * 0.7, cx + W * 0.03, H); s.fill();
      } else if (v.tower === 'sky') {                                         // tall tower with two glowing pods
        s.fillStyle = p.tower; s.fillRect(cx - 3, H * 0.1, 6, H * 0.9); s.beginPath(); s.moveTo(cx - W * 0.05, H); s.lineTo(cx - 4, H * 0.5); s.lineTo(cx + 4, H * 0.5); s.lineTo(cx + W * 0.05, H); s.fill();
        s.fillStyle = '#ff7ab8'; s.beginPath(); s.arc(cx, H * 0.46, W * 0.03, 0, TAU); s.fill(); s.fillStyle = '#ffd08a'; s.beginPath(); s.arc(cx, H * 0.27, W * 0.018, 0, TAU); s.fill(); s.fillRect(cx - 1, 2, 2, H * 0.13);
      }
      for (i = 0; i < 26; i++) { s.globalAlpha = 0.85; s.fillStyle = p.foliage[(R() * p.foliage.length) | 0]; s.beginPath(); s.arc(R() * W, H * (0.78 + R() * 0.3), 6 + R() * 16, 0, TAU); s.fill(); }
      s.globalAlpha = 1;
    }
    for (i = 0; i < 320; i++) { s.strokeStyle = 'rgba(' + ((R() * 255) | 0) + ',' + ((R() * 255) | 0) + ',' + ((R() * 255) | 0) + ',.07)'; s.lineWidth = 2 + R() * 4; s.beginPath(); var bx2 = R() * W, by2 = R() * H; s.moveTo(bx2, by2); s.lineTo(bx2 + (R() - 0.5) * 22, by2 + (R() - 0.5) * 10); s.stroke(); }
    g.imageSmoothingEnabled = true; try { g.filter = 'blur(4px)'; } catch (e) { /* older browsers: still soft because of the 4x upscale */ }
    g.drawImage(sm, 0, 0, w, h); try { g.filter = 'none'; } catch (e2) { /* ignore */ }
    var t = new T.CanvasTexture(big); t.minFilter = T.LinearFilter; t.generateMipmaps = false; L.tex(t); return t;
  }

  /* Court surface texture: colour, white lines, service boxes, big faint shuttle logo on each half.
   * 128 px per metre; canvas row y corresponds to world z = (y - 1024) / 128, so the far side is at the top. */
  function courtTexture(L, v) {
    var T = L.THREE, c = L.canvas(1024, 2048), g = c.getContext('2d'), PPM = 128, cx = 512, cy = 1024;
    g.fillStyle = hex(v.apron); g.fillRect(0, 0, 1024, 2048);
    var gr = g.createLinearGradient(0, 0, 0, 2048); gr.addColorStop(0, 'rgba(255,255,255,.05)'); gr.addColorStop(0.5, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(255,255,255,.07)');
    g.fillStyle = hex(v.court); g.fillRect(cx - 3.55 * PPM, cy - 7.1 * PPM, 7.1 * PPM, 14.2 * PPM); g.fillStyle = gr; g.fillRect(cx - 3.55 * PPM, cy - 7.1 * PPM, 7.1 * PPM, 14.2 * PPM);
    // faint logo: cork + three feathers pointing away from the net (drawn for z>0 then mirrored for z<0)
    function logo(sign) {
      g.save(); g.translate(cx, cy + sign * 4.35 * PPM); g.scale(1, sign); g.fillStyle = 'rgba(255,255,255,.12)';
      g.beginPath(); g.arc(0, -0.55 * PPM, 0.5 * PPM, 0, TAU); g.fill();
      [[-0.95, -0.25], [0.95, -0.25], [0, 0]].forEach(function (f, i) { g.save(); g.translate(f[0] * PPM, f[1] * PPM + 0.9 * PPM); g.rotate(f[0] * 0.4); g.beginPath(); g.ellipse(0, 0, 0.42 * PPM, (i === 2 ? 1.25 : 1.0) * PPM, 0, 0, TAU); g.fill(); g.restore(); });
      g.restore();
    }
    logo(1); logo(-1);
    g.strokeStyle = '#fff'; g.lineWidth = 6; g.lineCap = 'butt';
    function line(x0, z0, x1, z1) { g.beginPath(); g.moveTo(cx + x0 * PPM, cy + z0 * PPM); g.lineTo(cx + x1 * PPM, cy + z1 * PPM); g.stroke(); }
    line(-3.05, -6.7, 3.05, -6.7); line(-3.05, 6.7, 3.05, 6.7); line(-3.05, -6.7, -3.05, 6.7); line(3.05, -6.7, 3.05, 6.7);   // doubles outline
    line(-2.59, -6.7, -2.59, 6.7); line(2.59, -6.7, 2.59, 6.7);                                                                   // singles side lines
    line(-3.05, -1.98, 3.05, -1.98); line(-3.05, 1.98, 3.05, 1.98);                                                               // short service lines
    line(0, -6.7, 0, -1.98); line(0, 1.98, 0, 6.7);                                                                               // centre lines
    line(-3.05, -5.94, 3.05, -5.94); line(-3.05, 5.94, 3.05, 5.94);                                                               // doubles long service lines
    g.lineWidth = 3; g.setLineDash([10, 10]); line(-3.4, 0, 3.4, 0); g.setLineDash([]);
    var t = new T.CanvasTexture(c); t.anisotropy = 4; t.minFilter = T.LinearMipMapLinearFilter; L.tex(t); return t;
  }
  function floorTexture(L, v) {
    var T = L.THREE, c = L.canvas(512, 512), g = c.getContext('2d'), R = rnd(5), i;
    g.fillStyle = hex(v.floor); g.fillRect(0, 0, 512, 512);
    if (v.id === 'neon') { for (i = 0; i < 16; i++) { g.fillStyle = i % 2 ? 'rgba(120,50,10,.12)' : 'rgba(255,200,140,.12)'; g.fillRect(0, i * 32, 512, 32); g.fillStyle = 'rgba(80,30,5,.25)'; g.fillRect(0, i * 32, 512, 2); } for (i = 0; i < 40; i++) { g.fillStyle = 'rgba(80,30,5,.2)'; g.fillRect(R() * 512, ((R() * 16) | 0) * 32, 2, 32); } }
    else if (v.id === 'beach') { for (i = 0; i < 1800; i++) { g.fillStyle = R() > 0.5 ? 'rgba(255,255,255,.35)' : 'rgba(170,120,50,.25)'; g.fillRect(R() * 512, R() * 512, 2, 2); } }
    else { for (i = 0; i < 8; i++) for (var j = 0; j < 8; j++) { g.fillStyle = (i + j) % 2 ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.07)'; g.fillRect(i * 64, j * 64, 64, 64); } }
    var t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(14, 14); t.anisotropy = 2; L.tex(t); return t;
  }
  function netTexture(L) {
    var T = L.THREE, c = L.canvas(512, 64), g = c.getContext('2d'), i; g.clearRect(0, 0, 512, 64); g.strokeStyle = 'rgba(30,40,60,.85)'; g.lineWidth = 2;
    for (i = 0; i <= 512; i += 8) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 64); g.stroke(); } for (i = 0; i <= 64; i += 8) { g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke(); }
    var t = new T.CanvasTexture(c); t.anisotropy = 4; L.tex(t); return t;
  }

  /* ------------------------------------------------------------ BUILD VENUE */
  SW.buildVenue = function (L, scene, idx, quality) {
    var T = L.THREE, v = SW.VENUES[idx % SW.VENUES.length], G = new T.Group(), V = { group: G, v: v, idx: idx }, R = rnd(100 + idx * 31), i, j;
    scene.add(G);
    scene.background = new T.Color(v.sky);
    // lights
    var hemi = new T.HemisphereLight(0xffffff, v.hemiG, 0.95); G.add(hemi);
    var sun = new T.DirectionalLight(v.sun, 0.85); sun.position.set(-6, 14, 7); sun.target.position.set(0, 0, 0); G.add(sun); G.add(sun.target);
    sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = -9; sun.shadow.camera.right = 9; sun.shadow.camera.top = 10; sun.shadow.camera.bottom = -10; sun.shadow.camera.near = 1; sun.shadow.camera.far = 40; sun.shadow.bias = -0.0008;
    V.sun = sun;
    // ground
    var floor = new T.Mesh(new T.PlaneGeometry(120, 120), new T.MeshToonMaterial({ map: floorTexture(L, v), gradientMap: null, color: 0xffffff })); floor.rotation.x = -Math.PI / 2; floor.position.y = -0.36; G.add(floor);
    // raised glossy court slab
    var ct = courtTexture(L, v);
    var top = new T.MeshPhongMaterial({ map: ct, shininess: 70, specular: 0x556677 }), side = new T.MeshToonMaterial({ color: v.edge });
    var slab = new T.Mesh(new T.BoxGeometry(8.0, 0.36, 16.0), [side, side, top, side, side, side]); slab.position.y = -0.18; slab.receiveShadow = true; G.add(slab);
    V.slab = slab;
    // net: posts with metal caps and a yellow dot, white tape, mesh
    var postM = L.toon(0x6f7bb8), baseM = L.toon(0x2b2f3c), capM = L.toon(0xdfe6f2), dotM = L.toon(0xffd21f, { rim: 0 });
    V.net = new T.Group(); G.add(V.net);
    [-1, 1].forEach(function (s) {
      var p = new T.Group(); p.position.set(s * 3.4, 0, 0); V.net.add(p);
      var b = new T.Mesh(L.cyl(), baseM); b.scale.set(0.2, 0.34, 0.2); b.position.y = 0.17; p.add(b);
      var c1 = new T.Mesh(L.cyl(), postM); c1.scale.set(0.06, 1.6, 0.06); c1.position.y = 0.8; p.add(c1);
      var cap = new T.Mesh(L.sphere(), capM); cap.scale.set(0.085, 0.085, 0.085); cap.position.y = 1.6; p.add(cap);
      var dot = new T.Mesh(L.sphere(), dotM); dot.scale.set(0.03, 0.03, 0.03); dot.position.set(-s * 0.04, 1.4, 0.052); p.add(dot);
      var guard = new T.Mesh(L.box(), baseM); guard.scale.set(0.13, 0.5, 0.13); guard.position.set(0, 0.25, 0); p.add(guard);
    });
    var nm = new T.MeshBasicMaterial({ map: netTexture(L), transparent: true, side: T.DoubleSide, depthWrite: false });
    var mesh = new T.Mesh(new T.PlaneGeometry(6.8, 0.76), nm); mesh.position.set(0, 1.16, 0); mesh.renderOrder = 3; V.net.add(mesh); V.netMesh = mesh;
    var tape = new T.Mesh(L.box(), L.toon(0xfff3dc, { rim: 0 })); tape.scale.set(6.8, 0.075, 0.03); tape.position.set(0, 1.5, 0); V.net.add(tape);
    var bt = new T.Mesh(L.box(), L.toon(0xe8e8f0, { rim: 0 })); bt.scale.set(6.8, 0.03, 0.02); bt.position.set(0, 0.78, 0); V.net.add(bt);
    V.netShake = 0;
    // painterly backdrops (far + two angled sides)
    var bgT = painterly(L, v, 1024, 512), bgM = new T.MeshBasicMaterial({ map: bgT, fog: false });
    var bg = new T.Mesh(new T.PlaneGeometry(120, 52), bgM); bg.position.set(0, 20, -44); G.add(bg);
    var bgL = new T.Mesh(new T.PlaneGeometry(90, 40), bgM); bgL.position.set(-42, 15, -8); bgL.rotation.y = Math.PI / 2.4; G.add(bgL);
    var bgR = new T.Mesh(new T.PlaneGeometry(90, 40), bgM); bgR.position.set(42, 15, -8); bgR.rotation.y = -Math.PI / 2.4; G.add(bgR);
    // tiered stands (far end + sides), pillars, banners
    var standM = L.toon(v.stand), standD = L.toon(v.standD), pilM = L.toon(v.pillar), seats = [];
    function stand(cxx, czz, w, tiers, dirZ, dirX) {
      for (var t = 0; t < tiers; t++) {
        var bw = dirX ? 3.2 : w, bd = dirX ? w : 3.2, off = t * 1.45;
        var m = new T.Mesh(L.box(), t % 2 ? standD : standM); m.scale.set(bw, 0.9 + t * 0.85, bd);
        m.position.set(cxx + (dirX ? dirX * off : 0), (0.9 + t * 0.85) / 2 - 0.36, czz + (dirZ ? dirZ * off : 0)); G.add(m);
        for (var k = 0; k < (dirX ? 14 : 26); k++) {
          var p = (k / ((dirX ? 14 : 26) - 1) - 0.5) * (w - 2);
          seats.push({ x: dirX ? m.position.x + (R() - 0.5) * 1.0 : cxx + p, y: (0.9 + t * 0.85) - 0.36, z: dirX ? czz + p : m.position.z + (R() - 0.5) * 1.0, ph: R() * TAU });
        }
      }
    }
    stand(0, -13.5, 36, 4, -1, 0); stand(-12.8, -2, 24, 3, 0, -1); stand(12.8, -2, 24, 3, 0, 1);
    [-1, 1].forEach(function (s) {
      var pl = new T.Mesh(L.box(), pilM); pl.scale.set(2.4, 14, 2.4); pl.position.set(s * 10.5, 6.6, -11); G.add(pl);
      var cp = new T.Mesh(L.box(), L.toon(0xffffff)); cp.scale.set(3.0, 0.5, 3.0); cp.position.set(s * 10.5, 13.8, -11); G.add(cp);
    });
    var beam = new T.Mesh(L.box(), pilM); beam.scale.set(24, 1.2, 2.4); beam.position.set(0, 13.2, -11); G.add(beam);
    // banners along the front of the far stands (flat coloured cloth with stripes)
    for (i = 0; i < 9; i++) {
      var bc = v.banner[i % 3], cb = L.canvas(64, 128), cg = cb.getContext('2d'); cg.fillStyle = hex(bc); cg.fillRect(0, 0, 64, 128); cg.fillStyle = 'rgba(255,255,255,.85)'; cg.fillRect(0, 40, 64, 10); cg.fillRect(0, 70, 64, 10); cg.beginPath(); cg.arc(32, 100, 12, 0, TAU); cg.fill();
      var bn = new T.Mesh(new T.PlaneGeometry(1.5, 2.6), new T.MeshBasicMaterial({ map: L.tex(new T.CanvasTexture(cb)), side: T.DoubleSide })); bn.position.set(-13 + i * 3.25, 4.4, -10.4); G.add(bn);
    }
    // scenery per venue
    function tree(x, z, s) { var tr = new T.Mesh(L.cyl(), L.toon(0x8a5a34)); tr.scale.set(0.18 * s, 1.6 * s, 0.18 * s); tr.position.set(x, 0.8 * s - 0.36, z); G.add(tr); for (var q = 0; q < 3; q++) { var lf = new T.Mesh(L.sphere(), L.toon([0x4fb35a, 0x76cf62, 0x2f9a58][q])); lf.scale.set((1.2 - q * 0.2) * s, (1.0 - q * 0.1) * s, (1.2 - q * 0.2) * s); lf.position.set(x + (q - 1) * 0.3 * s, 2.0 * s - 0.36 + q * 0.4 * s, z); G.add(lf); } }
    function palm(x, z, s) {
      var trunk = new T.Mesh(L.cyl(), L.toon(0xb07a45)); trunk.scale.set(0.13 * s, 3.4 * s, 0.13 * s); trunk.position.set(x, 1.7 * s - 0.36, z); trunk.rotation.z = 0.12; G.add(trunk);
      for (var q = 0; q < 7; q++) { var a = q / 7 * TAU, lf = new T.Mesh(L.cone(), L.toon(q % 2 ? 0x2fb36a : 0x58d27a, { side: 1 })); lf.scale.set(0.34 * s, 1.8 * s, 0.05 * s); lf.position.set(x + 0.4 * s + Math.cos(a) * 0.8 * s, 3.5 * s - 0.36, z + Math.sin(a) * 0.8 * s); lf.rotation.set(Math.sin(a) * 1.2, 0, -Math.cos(a) * 1.2); G.add(lf); }
    }
    function umbrella(x, z, c) { var po = new T.Mesh(L.cyl(), L.toon(0xffffff)); po.scale.set(0.04, 2.2, 0.04); po.position.set(x, 1.1 - 0.36, z); G.add(po); var cn = new T.Mesh(new T.ConeGeometry(1.3, 0.55, 12), L.toon(c, { side: 1 })); cn.position.set(x, 2.3 - 0.36, z); G.add(cn); }
    if (v.id === 'street') { tree(-9, -8.5, 1.3); tree(9, -8.5, 1.3); tree(-12, 2, 1.1); tree(12, 3, 1.1); tree(-9.5, 8.5, 1.0); tree(9.5, 9, 1.0); }
    else if (v.id === 'neon') {
      for (i = -2; i <= 2; i++) { var nb = new T.Mesh(L.box(), L.basic([0xff3b9a, 0x2ee6d0, 0xffd21f, 0xff3b9a, 0x2ee6d0][i + 2])); nb.scale.set(5, 0.2, 0.12); nb.position.set(i * 6, 9.5, -10.2); G.add(nb); }
      [-1, 1].forEach(function (s) { var lp = new T.Mesh(L.cyl(), L.toon(0x2b2f3c)); lp.scale.set(0.1, 7, 0.1); lp.position.set(s * 8, 3.2, 6); G.add(lp); var lh = new T.Mesh(L.sphere(), L.basic(0xffe1a8)); lh.scale.set(0.35, 0.35, 0.35); lh.position.set(s * 8, 6.9, 6); G.add(lh); });
    } else { palm(-9, -8.5, 1.3); palm(9.5, -8.8, 1.4); palm(-12, 3, 1.2); palm(12, 5, 1.2); umbrella(-10.5, 8, 0xff6a3d); umbrella(10.5, 9, 0x2ee6d0); umbrella(-11, -3, 0xffd21f); }
    // crowd: one InstancedMesh pair (head + body) per shirt colour, so no per-instance colour support is needed
    var cols = [0xff5a7a, 0x3b8cff, 0xffd21f, 0x4de8b4, 0xa04dff, 0xffffff], sets = [], dm = new T.Object3D();
    cols.forEach(function (c, k) {
      var mine = seats.filter(function (s, n) { return n % cols.length === k; });
      var body = new T.InstancedMesh(L.sphere(), L.toon(c, { rim: 0 }), mine.length), head = new T.InstancedMesh(L.sphere(), L.toon([0xffd2ab, 0xc98a5a, 0x8c5532, 0xf2b88c][k % 4], { rim: 0 }), mine.length);
      body.frustumCulled = head.frustumCulled = false; G.add(body); G.add(head); sets.push({ body: body, head: head, seats: mine });
    });
    V.crowd = sets; V.excite = 0; V.cheerT = 0; V.crowdAcc = 0; V.crowdN = 1;
    function placeCrowd(t) {
      sets.forEach(function (S) {
        var n = Math.max(1, Math.floor(S.seats.length * V.crowdN));
        for (var q = 0; q < S.seats.length; q++) {
          var s = S.seats[q], vis = q < n, jump = vis ? Math.max(0, Math.sin(t * 9 + s.ph)) * (0.06 + V.excite * 0.3) : 0, sc = vis ? 1 : 0;
          dm.position.set(s.x, s.y + 0.32 + jump, s.z); dm.scale.set(0.3 * sc, 0.34 * sc, 0.26 * sc); dm.rotation.set(0, 0, 0); dm.updateMatrix(); S.body.setMatrixAt(q, dm.matrix);
          dm.position.y = s.y + 0.78 + jump; dm.scale.set(0.2 * sc, 0.2 * sc, 0.2 * sc); dm.updateMatrix(); S.head.setMatrixAt(q, dm.matrix);
        }
        S.body.instanceMatrix.needsUpdate = true; S.head.instanceMatrix.needsUpdate = true;
      });
    }
    V.update = function (dt, t) {
      V.excite = Math.max(0, V.excite - dt * 0.35); V.crowdAcc += dt;
      if (V.crowdAcc > (V.lowFx ? 0.12 : 0.05)) { V.crowdAcc = 0; placeCrowd(t); }
      V.netShake = Math.max(0, V.netShake - dt * 3); V.netMesh.rotation.x = Math.sin(t * 40) * V.netShake * 0.06; V.net.position.z = Math.sin(t * 30) * V.netShake * 0.04;
    };
    V.cheer = function (amt) { V.excite = Math.min(1, V.excite + amt); };
    V.setQuality = function (q, level) {
      V.crowdN = [0.3, 0.55, 0.8, 1][level]; V.lowFx = level < 2; V.sun.castShadow = q.shadow > 0;
      if (V.sun.castShadow) { V.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize); if (V.sun.shadow.map) { V.sun.shadow.map.dispose(); V.sun.shadow.map = null; } }
    };
    placeCrowd(0); V.setQuality({ shadow: 0, shadowSize: 1024 }, quality == null ? 3 : quality);
    V.dispose = function () { scene.remove(G); scene.background = null; G.traverse(function (o) { if (o.geometry && !L.isShared(o.geometry)) o.geometry.dispose(); }); sets.forEach(function (S) { S.body.dispose(); S.head.dispose(); }); };
    return V;
  };
})();
