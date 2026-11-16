/* ===========================================================================
 * Smash Court  -  characters, racket, shuttle, effects   (file 2 of 4)
 * Needs Three.js r128 (global THREE). Exposes window.SmashWorld (shared with badminton-world.js).
 * Everything is procedural (no external assets). Optional rigged GLB characters
 * from assets/characters/<id>.glb are used when present (format documented near the end of this file).
 * ========================================================================= */
(function () {
  'use strict';
  var SW = window.SmashWorld = window.SmashWorld || {};
  var TAU = Math.PI * 2;
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function sstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

  /* The six original characters.  eye = iris colour; kind = hair style. */
  SW.CHARS = [
    { id: 'zap',   name: 'Zap',   skin: 0xffd2ab, hair: 0xffd23f, kind: 'spiky',  shirt: 0x1fc7b6, trim: 0xffa62b, shorts: 0xff8a1f, shoe: 0xffffff, shoeA: 0x2ec5ff, eye: 0x2f9bff, racket: 0xff7a1a, glass: 0, band: 0, tank: 0 },
    { id: 'rusty', name: 'Rusty', skin: 0xf7c9a4, hair: 0xff4a1c, kind: 'swoop',  shirt: 0x252a36, trim: 0xe5282b, shorts: 0xe5282b, shoe: 0x8a6bff, shoeA: 0xffffff, eye: 0x7a4a2a, racket: 0x2e6bff, glass: 0, band: 0, tank: 0 },
    { id: 'kai',   name: 'Kai',   skin: 0xf2b88c, hair: 0x2b2547, kind: 'short',  shirt: 0xffffff, trim: 0xe5282b, shorts: 0x1c1d26, shoe: 0xe5282b, shoeA: 0xffffff, eye: 0x1fb7c9, racket: 0x9b6bff, glass: 0, band: 0, tank: 1 },
    { id: 'sol',   name: 'Sol',   skin: 0xa8683c, hair: 0x2b1a14, kind: 'dreads', shirt: 0xffd21f, trim: 0xff4b2b, shorts: 0x2d3a4a, shoe: 0xe5282b, shoeA: 0xffffff, eye: 0x38c6ff, racket: 0xff3b3b, glass: 1, band: 1, tank: 0 },
    { id: 'mina',  name: 'Mina',  skin: 0xffdcc2, hair: 0xff6fb5, kind: 'buns',   shirt: 0x4de8b4, trim: 0xffffff, shorts: 0x1d6fd6, shoe: 0xffffff, shoeA: 0xff6fb5, eye: 0xa04dff, racket: 0x4de8b4, glass: 0, band: 0, tank: 0 },
    { id: 'bruno', name: 'Bruno', skin: 0x8c5532, hair: 0x3b2316, kind: 'afro',   shirt: 0x8a4dff, trim: 0xffd21f, shorts: 0xffffff, shoe: 0xff8a1f, shoeA: 0xffffff, eye: 0x4a2a14, racket: 0xffd21f, glass: 0, band: 1, tank: 0 }
  ];

  /* ------------------------------------------------------------------ LIB */
  /* Per-game helper that owns shared geometries, toon materials and the gradient map; dispose() frees them. */
  SW.lib = function (THREE) {
    var L = { THREE: THREE, mats: {}, geos: {}, texs: [], rim: 0xbfe8ff }, grad = null;
    function gradient() {
      if (grad) return grad;
      var d = new Uint8Array([105, 165, 215, 255]);
      grad = new THREE.DataTexture(d, 4, 1, THREE.LuminanceFormat); grad.minFilter = grad.magFilter = THREE.NearestFilter; grad.generateMipmaps = false; grad.needsUpdate = true;
      L.texs.push(grad); return grad;
    }
    /* toon material with a soft rim light patched in */
    L.toon = function (color, o) {
      o = o || {}; var key = color + '|' + (o.rim === 0 ? 0 : 1) + '|' + (o.side ? 1 : 0) + '|' + (o.em || 0) + '|' + (o.op || 1);
      if (L.mats[key]) return L.mats[key];
      var m = new THREE.MeshToonMaterial({ color: color, gradientMap: gradient(), side: o.side ? THREE.DoubleSide : THREE.FrontSide, transparent: (o.op || 1) < 1, opacity: o.op || 1 });
      if (o.em) { m.emissive = new THREE.Color(color); m.emissiveIntensity = o.em; }
      if (o.rim !== 0) {
        m.onBeforeCompile = function (sh) {
          sh.uniforms.rimC = { value: new THREE.Color(L.rim) };
          sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 rimC;')
            .replace('#include <dithering_fragment>', 'float rf=1.0-clamp(dot(normalize(vNormal),normalize(vViewPosition)),0.0,1.0);\ngl_FragColor.rgb+=rimC*pow(rf,2.6)*0.4;\n#include <dithering_fragment>');
        };
      }
      L.mats[key] = m; return m;
    };
    L.basic = function (color, o) {
      o = o || {}; var key = 'b' + color + '|' + (o.add ? 1 : 0) + '|' + (o.op == null ? 1 : o.op) + '|' + (o.side ? 1 : 0);
      if (L.mats[key]) return L.mats[key];
      var m = new THREE.MeshBasicMaterial({ color: color, transparent: o.op != null || !!o.add, opacity: o.op == null ? 1 : o.op, blending: o.add ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: !o.add, side: o.side ? THREE.DoubleSide : THREE.FrontSide });
      L.mats[key] = m; return m;
    };
    L.geo = function (name, f) { return L.geos[name] || (L.geos[name] = f()); };
    L.sphere = function () { return L.geo('sph', function () { return new THREE.SphereGeometry(1, 14, 10); }); };
    L.cyl = function () { return L.geo('cyl', function () { return new THREE.CylinderGeometry(1, 1, 1, 10, 1); }); };
    L.box = function () { return L.geo('box', function () { return new THREE.BoxGeometry(1, 1, 1); }); };
    L.cone = function () { return L.geo('cone', function () { return new THREE.ConeGeometry(1, 1, 8, 1); }); };
    L.tex = function (t) { L.texs.push(t); return t; };
    L.isShared = function (g) { for (var k in L.geos) if (L.geos[k] === g) return true; return false; };
    L.canvas = function (w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    L.dispose = function () {
      var k; for (k in L.geos) L.geos[k].dispose(); for (k in L.mats) L.mats[k].dispose(); L.texs.forEach(function (t) { t.dispose(); }); L.geos = {}; L.mats = {}; L.texs = [];
    };
    return L;
  };
  function mesh(L, geo, mat, parent, x, y, z, sx, sy, sz) {
    var m = new L.THREE.Mesh(geo, mat); m.position.set(x || 0, y || 0, z || 0); m.scale.set(sx == null ? 1 : sx, sy == null ? (sx == null ? 1 : sx) : sy, sz == null ? (sx == null ? 1 : sx) : sz);
    if (parent) parent.add(m); return m;
  }
  function glowTex(L, inner, outer) {
    var c = L.canvas(64, 64), g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, inner || 'rgba(255,255,255,1)'); gr.addColorStop(0.35, outer || 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return L.tex(new L.THREE.CanvasTexture(c));
  }
  function ringTex(L, col) {
    var c = L.canvas(128, 128), g = c.getContext('2d'); g.strokeStyle = col || '#5dff6a'; g.lineWidth = 12; g.shadowColor = col || '#5dff6a'; g.shadowBlur = 14; g.beginPath(); g.arc(64, 64, 46, 0, TAU); g.stroke();
    return L.tex(new L.THREE.CanvasTexture(c));
  }
  function starTex(L) {
    var c = L.canvas(128, 128), g = c.getContext('2d'), i; g.translate(64, 64); g.fillStyle = '#fff'; g.shadowColor = '#fff'; g.shadowBlur = 10; g.beginPath();
    for (i = 0; i < 16; i++) { var r = i % 2 ? 22 : 56, a = i / 16 * TAU; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); g.fill();
    return L.tex(new L.THREE.CanvasTexture(c));
  }
  SW.glowTex = glowTex; SW.ringTex = ringTex; SW.starTex = starTex;
  function blobMat(L) { var T = L.THREE; return new T.MeshBasicMaterial({ map: L.blobT || (L.blobT = glowTex(L, 'rgba(0,0,0,.55)', 'rgba(0,0,0,.28)')), transparent: true, depthWrite: false }); }

  /* --------------------------------------------------------------- RACKET */
  /* origin = grip centre, +y towards the head. head centre at y = 0.37. */
  SW.makeRacket = function (L, color) {
    var T = L.THREE, g = new T.Group(), frame = L.toon(color, { rim: 1 }), dark = L.toon(0x20232d), silver = L.toon(0xd9e2ef, { rim: 0 });
    mesh(L, L.cyl(), dark, g, 0, -0.01, 0, 0.024, 0.22, 0.024);
    mesh(L, L.cyl(), silver, g, 0, 0.16, 0, 0.011, 0.14, 0.011);
    mesh(L, L.cyl(), frame, g, -0.045, 0.2, 0, 0.011, 0.12, 0.011).rotation.z = -0.35;
    mesh(L, L.cyl(), frame, g, 0.045, 0.2, 0, 0.011, 0.12, 0.011).rotation.z = 0.35;
    var head = new T.Mesh(L.geo('torus', function () { return new T.TorusGeometry(0.115, 0.017, 8, 30); }), frame); head.position.y = 0.37; head.scale.y = 1.22; g.add(head);
    var sc = L.canvas(96, 96), c = sc.getContext('2d'), i; c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 2.2;
    for (i = 4; i < 96; i += 9) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 96); c.stroke(); c.beginPath(); c.moveTo(0, i); c.lineTo(96, i); c.stroke(); }
    var st = L.tex(new T.CanvasTexture(sc)), sm = new T.MeshBasicMaterial({ map: st, transparent: true, opacity: 0.85, side: T.DoubleSide, depthWrite: false });
    var strings = new T.Mesh(L.geo('circ', function () { return new T.CircleGeometry(1, 28); }), sm); strings.position.set(0, 0.37, 0); strings.scale.set(0.112, 0.136, 1); g.add(strings);
    // timing ring + glow (sprites always face the camera)
    var ring = new T.Sprite(new T.SpriteMaterial({ map: L.ringT || (L.ringT = ringTex(L)), transparent: true, depthWrite: false, depthTest: false, blending: T.AdditiveBlending, opacity: 0 }));
    ring.position.set(0, 0.37, 0.02); ring.scale.set(0.5, 0.5, 1); ring.renderOrder = 20; g.add(ring);
    var glow = new T.Sprite(new T.SpriteMaterial({ map: L.glowT || (L.glowT = glowTex(L)), transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0, color: 0xfff1a0 }));
    glow.position.set(0, 0.37, 0.02); glow.scale.set(0.9, 0.9, 1); glow.renderOrder = 19; g.add(glow);
    g.userData.ring = ring; g.userData.glow = glow;
    return g;
  };

  /* ------------------------------------------------------------ CHARACTER */
  /* Procedural cartoon character.  Local space: faces +z, feet at y = 0, racket hand at local -x.
   * update(dt, info): info = {state,t,clock,runPh,vf,vs,sw:{k,side,t,dur,contact,wait,type},jumpH,look,timing,flash} */
  SW.makeCharacter = function (L, def, teamColor, label) {
    var T = L.THREE, root = new T.Group(), J = {}, cur = {}, tgt = {}, mt = L.toon, i;
    var skin = mt(def.skin), shirt = mt(def.shirt), trim = mt(def.trim), shorts = mt(def.shorts), hairM = mt(def.hair), shoeM = mt(def.shoe), shoeA = mt(def.shoeA), white = mt(0xffffff, { rim: 0 }), team = mt(teamColor || 0x3b8cff);
    var S = L.sphere(), Cy = L.cyl(), Bx = L.box(), Co = L.cone();
    J.body = new T.Group(); J.body.position.y = 0.64; root.add(J.body);
    J.torso = new T.Group(); J.body.add(J.torso);
    mesh(L, S, shirt, J.torso, 0, 0.22, 0, 0.215, 0.27, 0.17);
    mesh(L, Cy, shirt, J.torso, 0, 0.12, 0, 0.2, 0.3, 0.16);
    if (def.tank) { mesh(L, S, skin, J.torso, 0.17, 0.34, 0, 0.07, 0.1, 0.07); mesh(L, S, skin, J.torso, -0.17, 0.34, 0, 0.07, 0.1, 0.07); }
    mesh(L, Cy, trim, J.torso, 0, 0.36, 0, 0.12, 0.05, 0.1);
    mesh(L, S, trim, J.torso, 0, 0.22, 0.155, 0.07, 0.07, 0.025);
    mesh(L, Cy, shorts, J.body, 0, -0.02, 0, 0.21, 0.2, 0.165);
    // head
    J.head = new T.Group(); J.head.position.set(0, 0.58, 0); J.torso.add(J.head);
    mesh(L, Cy, skin, J.head, 0, -0.06, 0, 0.07, 0.12, 0.07);
    mesh(L, S, skin, J.head, 0, 0.18, 0, 0.27, 0.26, 0.25);
    mesh(L, S, skin, J.head, 0.265, 0.17, 0, 0.05, 0.06, 0.04); mesh(L, S, skin, J.head, -0.265, 0.17, 0, 0.05, 0.06, 0.04);
    var browMat = mt(def.hair, { rim: 0 }), brows = [];
    [-1, 1].forEach(function (s) {
      var eg = new T.Group(); eg.position.set(s * 0.1, 0.19, 0.205); J.head.add(eg);
      mesh(L, S, white, eg, 0, 0, 0, 0.078, 0.092, 0.05);
      mesh(L, S, mt(def.eye, { rim: 0 }), eg, 0, -0.005, 0.03, 0.054, 0.066, 0.03);
      mesh(L, S, mt(0x12141c, { rim: 0 }), eg, 0, -0.005, 0.05, 0.03, 0.04, 0.02);
      mesh(L, S, white, eg, s * -0.018, 0.026, 0.065, 0.016, 0.016, 0.01);
      var br = mesh(L, Bx, browMat, J.head, s * 0.1, 0.31, 0.2, 0.1, 0.022, 0.03); br.rotation.z = s * 0.1; brows.push(br);
    });
    J.brows = brows;
    J.mouth = new T.Mesh(L.geo('mouth', function () { return new T.TorusGeometry(0.05, 0.011, 6, 12, Math.PI); }), mt(0x7a2a2a, { rim: 0 })); J.mouth.position.set(0, 0.07, 0.235); J.mouth.rotation.z = Math.PI; J.head.add(J.mouth);
    mesh(L, S, mt(0xff9aa0, { rim: 0, op: 0.5 }), J.head, 0.15, 0.1, 0.2, 0.04, 0.025, 0.02); mesh(L, S, mt(0xff9aa0, { rim: 0, op: 0.5 }), J.head, -0.15, 0.1, 0.2, 0.04, 0.025, 0.02);
    // hair
    var h = new T.Group(); J.head.add(h);
    mesh(L, S, hairM, h, 0, 0.27, -0.02, 0.285, 0.2, 0.27);
    if (def.kind === 'spiky') { for (i = 0; i < 9; i++) { var a = i / 9 * TAU, sp = mesh(L, Co, hairM, h, Math.cos(a) * 0.17, 0.42 + (i % 2) * 0.05, Math.sin(a) * 0.15 - 0.02, 0.09, 0.26 - (i % 2) * 0.05, 0.09); sp.rotation.z = -Math.cos(a) * 0.5; sp.rotation.x = Math.sin(a) * 0.5; } mesh(L, Co, hairM, h, 0, 0.55, 0.05, 0.1, 0.3, 0.1); }
    else if (def.kind === 'swoop') { mesh(L, S, hairM, h, 0, 0.4, 0.02, 0.26, 0.15, 0.25); mesh(L, Co, hairM, h, 0.1, 0.38, 0.2, 0.2, 0.22, 0.12).rotation.z = -1.3; for (i = 0; i < 4; i++) mesh(L, Co, hairM, h, -0.18 + i * 0.1, 0.5, -0.02, 0.08, 0.18, 0.08).rotation.x = -0.3; }
    else if (def.kind === 'short') { mesh(L, S, hairM, h, 0, 0.36, 0.0, 0.275, 0.16, 0.26); mesh(L, S, hairM, h, 0, 0.44, 0.13, 0.2, 0.08, 0.1); for (i = 0; i < 5; i++) mesh(L, Co, hairM, h, -0.14 + i * 0.07, 0.47, 0.05, 0.06, 0.12, 0.06); }
    else if (def.kind === 'dreads') { mesh(L, S, hairM, h, 0, 0.38, -0.02, 0.28, 0.16, 0.27); for (i = 0; i < 6; i++) mesh(L, Cy, hairM, h, -0.2 + i * 0.08, 0.2, -0.2, 0.035, 0.28, 0.035).rotation.x = 0.25; mesh(L, S, hairM, h, 0.26, 0.28, -0.02, 0.05, 0.12, 0.05); }
    else if (def.kind === 'buns') { mesh(L, S, hairM, h, 0, 0.36, 0.01, 0.285, 0.18, 0.27); mesh(L, S, hairM, h, 0.2, 0.52, -0.02, 0.12, 0.12, 0.12); mesh(L, S, hairM, h, -0.2, 0.52, -0.02, 0.12, 0.12, 0.12); mesh(L, S, hairM, h, 0, 0.42, 0.18, 0.22, 0.1, 0.08); }
    else if (def.kind === 'afro') { mesh(L, S, hairM, h, 0, 0.42, -0.04, 0.4, 0.34, 0.36); }
    if (def.band) { mesh(L, Cy, white, J.head, 0, 0.36, 0, 0.275, 0.05, 0.26); mesh(L, Cy, mt(0xe5282b, { rim: 0 }), J.head, 0, 0.36, 0, 0.278, 0.012, 0.263); }
    if (def.glass) {
      var gm = mt(0xffd21f, { rim: 0 }), lens = new T.MeshBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.42 });
      [-1, 1].forEach(function (s) {
        var lg = new T.Mesh(L.geo('lens', function () { return new T.TorusGeometry(0.085, 0.014, 6, 16); }), gm); lg.position.set(s * 0.1, 0.19, 0.245); J.head.add(lg);
        var ln = new T.Mesh(L.geo('lensd', function () { return new T.CircleGeometry(0.082, 14); }), lens); ln.position.set(s * 0.1, 0.19, 0.243); J.head.add(ln);
      });
      mesh(L, Bx, gm, J.head, 0, 0.2, 0.25, 0.06, 0.016, 0.016);
    }
    // arms
    function arm(side) {
      var sh = new T.Group(); sh.position.set(side * 0.255, 0.38, 0); J.torso.add(sh);
      var sl = def.tank ? skin : shirt;
      mesh(L, S, sl, sh, 0, 0, 0, 0.085, 0.085, 0.085); mesh(L, Cy, sl, sh, 0, -0.1, 0, 0.065, 0.14, 0.065);
      var el = new T.Group(); el.position.y = -0.23; sh.add(el);
      mesh(L, S, skin, el, 0, 0, 0, 0.058, 0.058, 0.058); mesh(L, Cy, skin, el, 0, -0.12, 0, 0.053, 0.14, 0.053);
      var wr = new T.Group(); wr.position.y = -0.25; el.add(wr);
      mesh(L, Cy, team, wr, 0, 0.03, 0, 0.062, 0.05, 0.062);
      mesh(L, S, skin, wr, 0, -0.04, 0, 0.065, 0.065, 0.065);
      return { sh: sh, el: el, wr: wr };
    }
    var aR = arm(-1), aL = arm(1); J.shR = aR.sh; J.elR = aR.el; J.wrR = aR.wr; J.shL = aL.sh; J.elL = aL.el;
    J.racket = SW.makeRacket(L, def.racket); J.racket.rotation.x = Math.PI; J.racket.position.y = -0.03; J.wrR.add(J.racket);
    // legs
    function leg(side) {
      var hip = new T.Group(); hip.position.set(side * 0.11, -0.04, 0); J.body.add(hip);
      mesh(L, Cy, skin, hip, 0, -0.14, 0, 0.065, 0.26, 0.065); mesh(L, Cy, shorts, hip, 0, -0.03, 0, 0.1, 0.13, 0.1);
      var kn = new T.Group(); kn.position.y = -0.27; hip.add(kn);
      mesh(L, S, skin, kn, 0, 0, 0, 0.062, 0.062, 0.062); mesh(L, Cy, white, kn, 0, -0.14, 0, 0.07, 0.15, 0.07); mesh(L, Cy, team, kn, 0, -0.1, 0, 0.073, 0.03, 0.073);
      var sg = new T.Group(); sg.position.set(0, -0.27, 0.03); kn.add(sg);
      mesh(L, S, shoeM, sg, 0, -0.01, 0.03, 0.085, 0.07, 0.14); mesh(L, Bx, white, sg, 0, -0.065, 0.03, 0.15, 0.03, 0.27); mesh(L, S, shoeA, sg, 0, 0.0, 0.1, 0.06, 0.04, 0.05);
      return { hip: hip, kn: kn };
    }
    var lR = leg(-1), lL = leg(1); J.hipR = lR.hip; J.knR = lR.kn; J.hipL = lL.hip; J.knL = lL.kn;
    // blob shadow, team ring, name tag
    var sh = new T.Mesh(L.geo('blobg', function () { return new T.CircleGeometry(1, 20); }), blobMat(L));
    sh.rotation.x = -Math.PI / 2; sh.position.y = 0.012; sh.scale.set(0.62, 0.62, 1); root.add(sh);
    var tr = new T.Mesh(L.geo('tring', function () { return new T.RingGeometry(0.5, 0.58, 24); }), new T.MeshBasicMaterial({ color: teamColor || 0x3b8cff, transparent: true, opacity: 0.8, depthWrite: false }));
    tr.rotation.x = -Math.PI / 2; tr.position.y = 0.016; root.add(tr);
    var tag = null;
    if (label) {
      var cv = L.canvas(128, 64), g = cv.getContext('2d'); g.fillStyle = '#' + ('000000' + (teamColor || 0x3b8cff).toString(16)).slice(-6);
      g.beginPath(); g.moveTo(14, 4); g.lineTo(114, 4); g.quadraticCurveTo(124, 4, 124, 14); g.lineTo(124, 36); g.quadraticCurveTo(124, 46, 114, 46); g.lineTo(76, 46); g.lineTo(64, 60); g.lineTo(52, 46); g.lineTo(14, 46); g.quadraticCurveTo(4, 46, 4, 36); g.lineTo(4, 14); g.quadraticCurveTo(4, 4, 14, 4); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 4; g.stroke(); g.fillStyle = '#fff'; g.font = '800 30px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, 64, 26);
      tag = new T.Sprite(new T.SpriteMaterial({ map: L.tex(new T.CanvasTexture(cv)), transparent: true, depthWrite: false })); tag.scale.set(0.62, 0.31, 1); tag.position.set(0, 2.02, 0); root.add(tag);
    }
    var ch = { group: root, J: J, def: def, shadow: sh, tag: tag, isGLB: false, tring: tr };
    // ---------------------------------------------------------- pose solver
    var KEYS = ['by', 'brx', 'bry', 'brz', 'tx', 'ty', 'tz', 'hx', 'hy', 'rsx', 'rsy', 'rsz', 'rex', 'rwx', 'lsx', 'lsy', 'lsz', 'lex', 'hrx', 'hrz', 'krx', 'hlx', 'hlz', 'klx', 'mouth', 'brow'];
    KEYS.forEach(function (k) { cur[k] = 0; }); cur.by = 0.64;
    function ready(P, t) {
      P.by = 0.60 + Math.sin(t * 7) * 0.022; P.brx = -0.08; P.hrx = -0.25; P.krx = 0.5; P.hlx = 0.2; P.klx = 0.45; P.hrz = 0.1; P.hlz = -0.1;
      P.rsx = -1.0; P.rsz = -0.3; P.rex = -1.25; P.rwx = -0.4; P.lsx = -0.5; P.lsz = 0.5; P.lex = -0.5; P.mouth = 0.4;
    }
    ch.update = function (dt, info) {
      var P = tgt, st = info.state, t = info.t || 0, k, j, run = clamp(Math.hypot(info.vf || 0, info.vs || 0) / 5, 0, 1), sw = info.sw;
      for (k = 0; k < KEYS.length; k++) P[KEYS[k]] = 0;
      ready(P, info.clock || t);
      var rate = 16;
      if (st === 'run' || run > 0.12) {
        var ph = info.runPh || 0, s1 = Math.sin(ph * 1.8), k1 = Math.max(0, Math.sin(ph * 1.8 + 1.6)), k2 = Math.max(0, Math.sin(ph * 1.8 + 1.6 + Math.PI));
        var fw = clamp((info.vf || 0) / 5, -1, 1), sd = clamp((info.vs || 0) / 5, -1, 1);
        P.hrx = -0.3 + s1 * 0.75 * Math.abs(fw); P.hlx = 0.2 - s1 * 0.75 * Math.abs(fw); P.krx = 0.4 + k1 * run; P.klx = 0.4 + k2 * run;
        P.hrz = 0.1 + s1 * 0.5 * Math.abs(sd); P.hlz = -0.1 - s1 * 0.5 * Math.abs(sd);
        P.by = 0.58 + Math.abs(Math.sin(ph * 1.8)) * 0.045 * run; P.brx = -0.1 - fw * 0.12; P.brz = sd * 0.1; P.lsx = -0.6 - s1 * 0.5;
      }
      if (st === 'dive') {
        P.by = 0.3; P.brx = -1.25; P.hrx = 0.7; P.krx = 0.4; P.hlx = 0.9; P.klx = 0.3; P.rsx = -2.7; P.rsz = -0.2; P.rex = -0.2; P.rwx = -0.3; P.lsx = -2.2; P.lsz = 0.5; P.lex = -0.3; P.hx = 0.9; P.mouth = 0.9; rate = 22;
      } else if (st === 'win') {
        var b = Math.abs(Math.sin(t * 7)); P.by = 0.6 + b * 0.18; P.rsx = -2.9; P.rsz = -0.25 + Math.sin(t * 9) * 0.2; P.rex = -0.3; P.lsx = -2.9; P.lsz = 0.25; P.lex = -0.3; P.hrx = -0.15; P.hlx = -0.15; P.krx = 0.3 + b * 0.3; P.klx = 0.3 + b * 0.3; P.mouth = 1.4; P.brow = 1; P.hx = -0.15; P.ty = Math.sin(t * 5) * 0.2;
      } else if (st === 'lose') {
        P.by = 0.58; P.brx = 0.22; P.hx = 0.55; P.rsx = -0.25; P.rsz = -0.12; P.rex = -0.15; P.rwx = 0.4; P.lsx = -0.1; P.lsz = 0.1; P.lex = -0.1; P.mouth = -1; P.brow = -1; P.krx = 0.1; P.klx = 0.1; P.ty = Math.sin(t * 2) * 0.1; rate = 8;
      } else if ((st === 'swing' || st === 'serve') && sw && sw.wait <= 0) {
        var u = clamp(sw.t / sw.dur, 0, 1), uc = clamp(sw.contact / sw.dur, 0.05, 0.9), w = u < uc ? u / uc : 1 + (u - uc) / (1 - uc), e = sstep(Math.min(w, 1)), f = sstep(Math.max(0, w - 1));
        var kind = sw.k, side = sw.side; rate = 34;
        if (sw.type === 'serve') {
          P.rsx = lerp(0.5, -1.15, e) + f * 0.5; P.rsz = -0.4; P.rex = lerp(-0.2, -0.4, e); P.lsx = -1.3 + f * 0.8; P.lsz = 0.25; P.lex = -0.2; P.ty = lerp(-0.35, 0.4, e); P.by = lerp(0.56, 0.6, e); P.hx = -0.15 + e * 0.1;
        } else if (side === 'over' || kind === 'smash' || kind === 'super') {
          P.rsx = lerp(-3.05, -2.75, e) + f * 1.9; P.rsz = -0.45 + f * 0.5; P.rex = lerp(-1.5, -0.1, e) + f * -0.5; P.rwx = lerp(0.3, -0.6, e); P.lsx = lerp(-2.3, -0.7, e); P.lsz = 0.5; P.lex = -0.3;
          P.brx = lerp(0.3, -0.35, e); P.tx = lerp(-0.3, 0.2, e); P.ty = lerp(-0.5, 0.55, e) + f * 0.2; P.by = 0.62; P.hrx = lerp(0.3, -0.2, e); P.krx = lerp(0.9, 0.6, e) + f * 0.3; P.hlx = 0.5 - e * 0.2; P.klx = 0.6; P.mouth = 1.2;
          if (kind === 'smash' || kind === 'super') P.hx = -0.25;
        } else if (kind === 'lift' || kind === 'netdrop') {
          P.by = 0.42; P.hrx = -1.15; P.krx = 1.25; P.hlx = 0.55; P.klx = 0.95; P.brx = -0.45; P.rsx = lerp(-0.7, -1.4, e); P.rsz = -0.3; P.rex = lerp(-0.9, -0.3, e) + f * -0.4; P.lsx = -0.3; P.lsz = 0.9; P.hx = 0.35;
        } else if (side === 'bh') {
          P.rsx = lerp(-1.1, -1.35, e) + f * 0.1; P.rsz = lerp(0.55, -0.3, e) + f * -0.9; P.rex = lerp(-1.1, -0.35, e); P.ty = lerp(0.5, -0.45, e) - f * 0.2; P.lsx = -0.5; P.lsz = lerp(0.2, 1.1, e); P.by = 0.57;
        } else {
          var soft = kind === 'drop' ? 0.45 : 1;
          P.rsx = lerp(-1.0, -1.45, e) + f * 0.2; P.rsz = lerp(-1.3 * soft, -0.5, e) + f * 0.9; P.rex = lerp(-0.8, -0.3, e) - f * 0.4; P.ty = lerp(-0.7 * soft, 0.7 * soft, e) + f * 0.2; P.lsx = -0.5; P.lsz = lerp(0.9, 0.3, e); P.by = 0.57;
        }
        if (info.jumpH > 0.05) { P.hrx = Math.min(P.hrx, 0.4); P.krx = 0.9; P.klx = 0.9; P.hlx = 0.5; }
      }
      if (info.look != null) P.hy = clamp(info.look, -0.7, 0.7);
      var a2 = clamp(dt * rate, 0, 1);
      for (k = 0; k < KEYS.length; k++) { j = KEYS[k]; cur[j] += (P[j] - cur[j]) * a2; }
      J.body.position.y = cur.by; J.body.rotation.set(cur.brx, cur.bry, cur.brz);
      J.torso.rotation.set(cur.tx, cur.ty, cur.tz); J.head.rotation.set(cur.hx, cur.hy, 0);
      J.shR.rotation.set(cur.rsx, cur.rsy, cur.rsz); J.elR.rotation.set(cur.rex, 0, 0); J.wrR.rotation.set(cur.rwx, 0, 0);
      J.shL.rotation.set(cur.lsx, cur.lsy, cur.lsz); J.elL.rotation.set(cur.lex, 0, 0);
      J.hipR.rotation.set(cur.hrx, 0, cur.hrz); J.knR.rotation.set(cur.krx, 0, 0); J.hipL.rotation.set(cur.hlx, 0, cur.hlz); J.knL.rotation.set(cur.klx, 0, 0);
      J.mouth.rotation.z = cur.mouth >= 0 ? Math.PI : 0; J.mouth.scale.set(1, 0.4 + Math.abs(cur.mouth) * 0.7, 1); J.mouth.position.y = cur.mouth >= 0 ? 0.075 : 0.05;
      J.brows[0].position.y = J.brows[1].position.y = 0.31 + cur.brow * 0.03;
      var rd = J.racket.userData, tm = info.timing || 0; rd.ring.material.opacity = tm > 0 ? 0.35 + tm * 0.65 : 0; rd.ring.material.color.setHex(tm > 0.7 ? 0x5dff6a : 0xb6ffb8);
      var rs = 0.7 - clamp(tm, 0, 1) * 0.38; rd.ring.scale.set(rs, rs, 1);
      var fl = info.flash || 0; rd.glow.material.opacity = clamp(fl * 2.4, 0, 0.95); rd.glow.scale.set(0.9 + fl * 1.6, 0.9 + fl * 1.6, 1);
      sh.scale.setScalar(0.62 - (info.jumpH || 0) * 0.35); sh.material.opacity = 1 - (info.jumpH || 0) * 0.8;
    };
    ch.dispose = function () { /* shared geometries/materials are released by lib.dispose() */ };
    return ch;
  };

  /* --------------------------------------------------------------- SHUTTLE */
  SW.makeShuttle = function (L) {
    var T = L.THREE, g = new T.Group(), inner = new T.Group(), i; g.add(inner);
    var white = L.toon(0xfafcff, { side: 1, rim: 1 }), cork = L.toon(0xffd62e), band = L.toon(0xff5a3c, { rim: 0 });
    var skirt = new T.Mesh(new T.CylinderGeometry(0.2, 0.52, 1.0, 16, 1, true), white); skirt.position.y = -0.2; inner.add(skirt);
    var rib = L.toon(0xc8d4e8, { rim: 0 });
    for (i = 0; i < 8; i++) { var a = i / 8 * TAU, r = mesh(L, L.cyl(), rib, inner, Math.cos(a) * 0.36, -0.2, Math.sin(a) * 0.36, 0.012, 1.0, 0.012); r.rotation.set(Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3); }
    var bd = new T.Mesh(new T.CylinderGeometry(0.33, 0.37, 0.07, 14, 1, true), band); bd.position.y = -0.62; inner.add(bd);
    mesh(L, L.sphere(), cork, inner, 0, 0.36, 0, 0.23, 0.2, 0.23);
    g.scale.setScalar(0.34);
    var sh = new T.Mesh(L.geo('blobg', function () { return new T.CircleGeometry(1, 20); }), blobMat(L));
    sh.rotation.x = -Math.PI / 2; sh.scale.set(0.22, 0.22, 1);
    var glow = new T.Sprite(new T.SpriteMaterial({ map: L.glowT || (L.glowT = glowTex(L)), transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0.0, color: 0xffffff })); glow.scale.set(1.1, 1.1, 1);
    // ribbon trail (additive, tapered)
    var N = 20, pos = new Float32Array(N * 2 * 3), col = new Float32Array(N * 2 * 3), idx = [], hist = [];
    for (i = 0; i < N - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    var tg = new T.BufferGeometry(); tg.setAttribute('position', new T.BufferAttribute(pos, 3)); tg.setAttribute('color', new T.BufferAttribute(col, 3)); tg.setIndex(idx);
    var trail = new T.Mesh(tg, new T.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide })); trail.frustumCulled = false; trail.renderOrder = 5;
    var up = new T.Vector3(0, 1, 0), dir = new T.Vector3(0, 1, 0), tq = new T.Quaternion(), cp = new T.Vector3(), sd = new T.Vector3(), tmp = new T.Vector3();
    var S = { group: g, shadow: sh, trail: trail, glow: glow, boost: 0 };
    /* interpolated position, velocity (orientation), camera position, dt, visibility, power 0..1 */
    S.update = function (x, y, z, vx, vy, vz, cam, dt, show, power) {
      g.visible = sh.visible = show; if (!show) { trail.visible = false; glow.visible = false; hist.length = 0; return; }
      g.position.set(x, y, z); sh.position.set(x, 0.015, z); glow.position.set(x, y, z);
      var sp = Math.sqrt(vx * vx + vy * vy + vz * vz); if (sp > 0.5) dir.set(vx / sp, vy / sp, vz / sp); else dir.set(0, -1, 0);
      tq.setFromUnitVectors(up, dir); g.quaternion.slerp(tq, clamp(dt * 22, 0, 1));
      inner.rotation.y += dt * (3 + sp * 0.35);
      sh.scale.setScalar(0.2 + Math.max(0, 0.18 - y * 0.018));
      glow.visible = true; S.boost = Math.max(0, S.boost - dt * 3); glow.material.opacity = clamp(0.2 + S.boost * 0.7 + sp * 0.004, 0, 0.9);
      hist.unshift([x, y, z]); if (hist.length > N) hist.pop();
      trail.visible = hist.length > 2 && sp > 6;
      if (trail.visible) {
        var n = hist.length, p, w, k, al, base = 0.05 + clamp(sp / 80, 0, 1) * 0.07;
        for (k = 0; k < N; k++) {
          p = hist[Math.min(k, n - 1)]; var nx = hist[Math.min(k + 1, n - 1)], pv = hist[Math.max(k - 1, 0)];
          tmp.set(pv[0] - nx[0], pv[1] - nx[1], pv[2] - nx[2]); if (tmp.lengthSq() < 1e-8) tmp.set(0, 1, 0); tmp.normalize();
          cp.set(cam.x - p[0], cam.y - p[1], cam.z - p[2]); sd.crossVectors(tmp, cp).normalize();
          w = base * (1 - k / N); al = (1 - k / N); al = al * al * (power > 0.6 ? 1 : 0.65);
          pos[k * 6] = p[0] + sd.x * w; pos[k * 6 + 1] = p[1] + sd.y * w; pos[k * 6 + 2] = p[2] + sd.z * w; pos[k * 6 + 3] = p[0] - sd.x * w; pos[k * 6 + 4] = p[1] - sd.y * w; pos[k * 6 + 5] = p[2] - sd.z * w;
          col[k * 6] = col[k * 6 + 3] = al; col[k * 6 + 1] = col[k * 6 + 4] = al; col[k * 6 + 2] = col[k * 6 + 5] = al;
        }
        tg.attributes.position.needsUpdate = true; tg.attributes.color.needsUpdate = true;
      }
    };
    S.reset = function () { hist.length = 0; };
    return S;
  };

  /* ------------------------------------------------------------ EFFECTS */
  /* Soft point sprites (sparks / dust / confetti) rendered with one draw call each. */
  SW.makePoints = function (L, scene, n, square) {
    var T = L.THREE, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), siz = new Float32Array(n), alp = new Float32Array(n), vel = new Float32Array(n * 3), life = new Float32Array(n), max = new Float32Array(n), grav = new Float32Array(n), i, head = 0;
    var geo = new T.BufferGeometry(); geo.setAttribute('position', new T.BufferAttribute(pos, 3)); geo.setAttribute('pcol', new T.BufferAttribute(col, 3)); geo.setAttribute('psize', new T.BufferAttribute(siz, 1)); geo.setAttribute('palpha', new T.BufferAttribute(alp, 1));
    var mat = new T.ShaderMaterial({ transparent: true, depthWrite: false, blending: square ? T.NormalBlending : T.AdditiveBlending, uniforms: { uScale: { value: 400 } },
      vertexShader: 'attribute vec3 pcol;attribute float psize;attribute float palpha;varying vec3 vC;varying float vA;uniform float uScale;void main(){vC=pcol;vA=palpha;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_PointSize=psize*uScale/max(0.1,-mv.z);gl_Position=projectionMatrix*mv;}',
      fragmentShader: 'varying vec3 vC;varying float vA;void main(){vec2 d=gl_PointCoord-0.5;' + (square ? 'float a=1.0;' : 'float a=smoothstep(0.5,0.1,length(d));') + 'if(vA<=0.01)discard;gl_FragColor=vec4(vC,a*vA);}' });
    for (i = 0; i < n; i++) pos[i * 3 + 1] = -50;
    var pts = new T.Points(geo, mat); pts.frustumCulled = false; scene.add(pts);
    var P = { obj: pts, setView: function (h, fov) { mat.uniforms.uScale.value = h * 0.5 / Math.tan(fov * Math.PI / 360); } };
    P.emit = function (x, y, z, vx, vy, vz, lifeS, size, r, g, b, gv) {
      var k = head; head = (head + 1) % n;
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z; vel[k * 3] = vx; vel[k * 3 + 1] = vy; vel[k * 3 + 2] = vz; life[k] = max[k] = lifeS; siz[k] = size; col[k * 3] = r; col[k * 3 + 1] = g; col[k * 3 + 2] = b; grav[k] = gv; alp[k] = 1;
    };
    P.update = function (dt) {
      for (var k = 0; k < n; k++) {
        if (life[k] <= 0) { if (alp[k] !== 0) { alp[k] = 0; pos[k * 3 + 1] = -50; } continue; }
        life[k] -= dt; vel[k * 3 + 1] -= grav[k] * dt; vel[k * 3] *= 1 - dt * 0.6; vel[k * 3 + 2] *= 1 - dt * 0.6;
        pos[k * 3] += vel[k * 3] * dt; pos[k * 3 + 1] += vel[k * 3 + 1] * dt; pos[k * 3 + 2] += vel[k * 3 + 2] * dt;
        if (pos[k * 3 + 1] < 0.02 && grav[k] > 0) { pos[k * 3 + 1] = 0.02; vel[k * 3 + 1] *= -0.25; vel[k * 3] *= 0.6; vel[k * 3 + 2] *= 0.6; }
        alp[k] = clamp(life[k] / max[k] * 1.6, 0, 1);
      }
      geo.attributes.position.needsUpdate = true; geo.attributes.palpha.needsUpdate = true; geo.attributes.psize.needsUpdate = true; geo.attributes.pcol.needsUpdate = true;
    };
    P.clear = function () { for (var k = 0; k < n; k++) { life[k] = 0; alp[k] = 0; pos[k * 3 + 1] = -50; } geo.attributes.position.needsUpdate = true; geo.attributes.palpha.needsUpdate = true; };
    P.dispose = function () { scene.remove(pts); geo.dispose(); mat.dispose(); };
    return P;
  };

  /* Impact stars, rings, speed lines. Pools, no allocation during play. */
  SW.makeFX = function (L, scene) {
    var T = L.THREE, FX = { stars: [], lines: [], rings: [] }, i, starT = starTex(L), ringT = ringTex(L, '#ffffff');
    for (i = 0; i < 6; i++) { var s = new T.Sprite(new T.SpriteMaterial({ map: starT, transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0 })); s.visible = false; s.renderOrder = 15; scene.add(s); FX.stars.push({ s: s, t: 9, d: 0.3, size: 1 }); }
    for (i = 0; i < 4; i++) { var r = new T.Sprite(new T.SpriteMaterial({ map: ringT, transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0 })); r.visible = false; r.renderOrder = 14; scene.add(r); FX.rings.push({ s: r, t: 9, d: 0.4, size: 1 }); }
    for (i = 0; i < 12; i++) { var m = new T.Mesh(L.geo('lineq', function () { return new T.PlaneGeometry(1, 1); }), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide })); m.visible = false; scene.add(m); FX.lines.push({ m: m, t: 9, d: 0.3 }); }
    var nx = 0, nr = 0, v1 = new T.Vector3(), v2 = new T.Vector3(), v3 = new T.Vector3();
    FX.star = function (x, y, z, color, size) { var o = FX.stars[nx++ % FX.stars.length]; o.s.position.set(x, y, z); o.s.material.color.setHex(color); o.t = 0; o.d = 0.32; o.size = size; o.s.visible = true; };
    FX.ring = function (x, y, z, color, size) { var o = FX.rings[nr++ % FX.rings.length]; o.s.position.set(x, y, z); o.s.material.color.setHex(color); o.t = 0; o.d = 0.45; o.size = size; o.s.visible = true; };
    /* speed lines behind a smash: (dx,dy,dz) = unit travel direction */
    FX.speed = function (x, y, z, dx, dy, dz, cam) {
      for (var k = 0; k < FX.lines.length; k++) {
        var o = FX.lines[k], off = (k / FX.lines.length) * TAU, rr = 0.2 + (k % 3) * 0.16, len = 1.3 + (k % 4) * 0.6;
        v1.set(dx, dy, dz); v2.set(cam.x - x, cam.y - y, cam.z - z).normalize(); v3.crossVectors(v1, v2).normalize();
        var ox = v3.x * Math.cos(off) * rr, oy = v3.y * Math.cos(off) * rr + Math.sin(off) * rr * 0.6, oz = v3.z * Math.cos(off) * rr;
        o.m.position.set(x - dx * (len * 0.5 + 0.2) + ox, y - dy * (len * 0.5 + 0.2) + oy, z - dz * (len * 0.5 + 0.2) + oz);
        o.m.up.set(dx, dy, dz); o.m.lookAt(cam.x, cam.y, cam.z); o.m.scale.set(0.03 + (k % 2) * 0.02, len, 1); o.t = 0; o.d = 0.28; o.m.visible = true;
      }
    };
    FX.update = function (dt) {
      var k, o, u;
      for (k = 0; k < FX.stars.length; k++) { o = FX.stars[k]; if (o.t < o.d) { o.t += dt; u = o.t / o.d; var sz = o.size * (0.4 + u * 1.2); o.s.scale.set(sz, sz, 1); o.s.material.opacity = 1 - u; o.s.material.rotation = u * 1.2; if (u >= 1) o.s.visible = false; } }
      for (k = 0; k < FX.rings.length; k++) { o = FX.rings[k]; if (o.t < o.d) { o.t += dt; u = o.t / o.d; var rz = o.size * (0.3 + u * 1.6); o.s.scale.set(rz, rz, 1); o.s.material.opacity = (1 - u) * 0.9; if (u >= 1) o.s.visible = false; } }
      for (k = 0; k < FX.lines.length; k++) { o = FX.lines[k]; if (o.t < o.d) { o.t += dt; u = o.t / o.d; o.m.material.opacity = (1 - u) * 0.7; if (u >= 1) o.m.visible = false; } }
    };
    FX.dispose = function () { FX.stars.forEach(function (o) { scene.remove(o.s); o.s.material.dispose(); }); FX.rings.forEach(function (o) { scene.remove(o.s); o.s.material.dispose(); }); FX.lines.forEach(function (o) { scene.remove(o.m); o.m.material.dispose(); }); };
    return FX;
  };

  /* Aim / landing ring painted on the court (glowing green target like the reference). */
  SW.makeTarget = function (L, color) {
    var T = L.THREE, g = new T.Group(), mat = new T.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }), i;
    var ring = new T.Mesh(new T.RingGeometry(0.5, 0.6, 36), mat); ring.rotation.x = -Math.PI / 2; g.add(ring);
    for (i = 0; i < 4; i++) { var tk = new T.Mesh(new T.PlaneGeometry(0.28, 0.1), mat); tk.rotation.x = -Math.PI / 2; tk.rotation.z = i * Math.PI / 2; tk.position.set(Math.cos(i * Math.PI / 2) * 0.78, 0, Math.sin(i * Math.PI / 2) * -0.78); g.add(tk); }
    var dot = new T.Mesh(new T.CircleGeometry(0.1, 14), mat); dot.rotation.x = -Math.PI / 2; g.add(dot);
    var fill = new T.Mesh(new T.CircleGeometry(0.5, 28), new T.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.16, blending: T.AdditiveBlending, depthWrite: false })); fill.rotation.x = -Math.PI / 2; g.add(fill);
    g.position.y = 0.03; g.visible = false;
    return { group: g, set: function (x, z, t, on) { g.visible = on; if (!on) return; g.position.x = x; g.position.z = z; g.rotation.y = t * 0.9; var s = 1 + Math.sin(t * 6) * 0.05; g.scale.set(s, 1, s); mat.opacity = 0.75 + Math.sin(t * 6) * 0.15; } };
  };

  /* ------------------------------------------------------- OPTIONAL GLB PATH */
  /* assets/characters/<id>.glb   (ids: zap, rusty, kai, sol, mina, bruno)
   *   - rigged skinned mesh, metres, feet at y=0, ~1.65 m tall, FACING +Z, racket hand on the -X side
   *   - a node named "RacketSocket" (child of the right hand bone): the procedural racket is attached there
   *   - animation clips named exactly: idle, run, serve, forehand, backhand, smash, drop, dive, win, lose
   *     (idle + run loop; the others are one shots of 0.35-0.8 s with the ball contact at about 40 % of the clip)
   * Matching build: Three.js r128 -> examples/js/loaders/GLTFLoader.js of the same release (loaded on demand, only if a file exists). */
  var GLB = { state: 'idle', buffers: {} };
  SW.GLB_CLIPS = ['idle', 'run', 'serve', 'forehand', 'backhand', 'smash', 'drop', 'dive', 'win', 'lose'];
  SW.glbProbe = function (ids, done) {
    if (GLB.state === 'done' || GLB.state === 'busy') { done(GLB.buffers); return; }
    GLB.state = 'busy'; var left = ids.length, any = false;
    if (!window.fetch || !left) { GLB.state = 'done'; done(GLB.buffers); return; }
    ids.forEach(function (id) {
      fetch('../assets/characters/' + id + '.glb').then(function (r) { if (!r.ok) throw 0; return r.arrayBuffer(); }).then(function (b) { GLB.buffers[id] = b; any = true; }).catch(function () {}).then(function () {
        if (--left === 0) {
          if (!any || (window.THREE && THREE.GLTFLoader)) { GLB.state = 'done'; done(GLB.buffers); return; }
          var s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js';
          s.onload = function () { GLB.state = 'done'; done(GLB.buffers); }; s.onerror = function () { GLB.buffers = {}; GLB.state = 'done'; done(GLB.buffers); }; document.head.appendChild(s);
        }
      });
    });
  };
  /* Build a character from a cached GLB buffer. cb(ch|null). Same interface as makeCharacter(). */
  SW.makeGLBCharacter = function (L, def, teamColor, label, cb) {
    var T = L.THREE, buf = GLB.buffers[def.id];
    if (!buf || !T.GLTFLoader) { cb(null); return; }
    try {
      new T.GLTFLoader().parse(buf.slice(0), '', function (gltf) {
        try {
          var root = new T.Group(), model = gltf.scene, mixer = new T.AnimationMixer(model), acts = {}, curName = '', socket = null;
          root.add(model);
          gltf.animations.forEach(function (c) { var a = mixer.clipAction(c); acts[c.name] = a; if (c.name === 'idle' || c.name === 'run') a.setLoop(T.LoopRepeat); else { a.setLoop(T.LoopOnce); a.clampWhenFinished = true; } });
          model.traverse(function (o) { if (o.name === 'RacketSocket') socket = o; });
          var racket = SW.makeRacket(L, def.racket); if (socket) socket.add(racket); else racket.visible = false;
          var sh = new T.Mesh(L.geo('blobg', function () { return new T.CircleGeometry(1, 20); }), blobMat(L)); sh.rotation.x = -Math.PI / 2; sh.position.y = 0.012; sh.scale.set(0.62, 0.62, 1); root.add(sh);
          var tr = new T.Mesh(L.geo('tring', function () { return new T.RingGeometry(0.5, 0.58, 24); }), new T.MeshBasicMaterial({ color: teamColor, transparent: true, opacity: 0.8, depthWrite: false })); tr.rotation.x = -Math.PI / 2; tr.position.y = 0.016; root.add(tr);
          var tag = null;
          if (label) { var cv = L.canvas(128, 64), g = cv.getContext('2d'); g.fillStyle = '#' + ('000000' + teamColor.toString(16)).slice(-6); g.fillRect(4, 4, 120, 44); g.fillStyle = '#fff'; g.font = '800 30px system-ui'; g.textAlign = 'center'; g.fillText(label, 64, 38); tag = new T.Sprite(new T.SpriteMaterial({ map: L.tex(new T.CanvasTexture(cv)), transparent: true, depthWrite: false })); tag.scale.set(0.62, 0.31, 1); tag.position.set(0, 2.02, 0); root.add(tag); }
          var lastSwing = null;
          var play = function (name, fade) { var a = acts[name]; if (!a || curName === name) return; var prev = acts[curName]; a.reset().setEffectiveWeight(1).play(); if (prev) prev.crossFadeTo(a, fade, false); curName = name; };
          var ch = { group: root, def: def, isGLB: true, shadow: sh, tag: tag, tring: tr, J: {} };
          ch.update = function (dt, info) {
            var st = info.state, sw = info.sw, run = Math.hypot(info.vf || 0, info.vs || 0), name = 'idle';
            if (st === 'dive') name = 'dive'; else if (st === 'win') name = 'win'; else if (st === 'lose') name = 'lose';
            else if ((st === 'swing' || st === 'serve') && sw && sw.wait <= 0) {
              if (sw.type === 'serve') name = 'serve'; else if (sw.side === 'over' || sw.k === 'smash' || sw.k === 'super') name = 'smash'; else if (sw.k === 'drop' || sw.k === 'netdrop') name = 'drop'; else name = sw.side === 'bh' ? 'backhand' : 'forehand';
              if (lastSwing !== sw) { lastSwing = sw; if (acts[name]) { acts[name].stop(); curName = ''; } }
            } else { lastSwing = null; name = run > 0.8 ? 'run' : 'idle'; }
            play(name, name === 'run' || name === 'idle' ? 0.15 : 0.06);
            if (acts.run) acts.run.timeScale = clamp(run / 4.2, 0.5, 1.6);
            mixer.update(dt);
            var rd = racket.userData, tm = info.timing || 0; rd.ring.material.opacity = tm > 0 ? 0.35 + tm * 0.65 : 0; var rs = 0.7 - clamp(tm, 0, 1) * 0.38; rd.ring.scale.set(rs, rs, 1); rd.glow.material.opacity = clamp((info.flash || 0) * 2.4, 0, 0.95);
            sh.scale.setScalar(0.62 - (info.jumpH || 0) * 0.35);
          };
          ch.dispose = function () { mixer.stopAllAction(); model.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) { var ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach(function (m) { if (m.map) m.map.dispose(); m.dispose(); }); } }); };
          play('idle', 0); cb(ch);
        } catch (e) { if (window.console) console.warn('[badminton] GLB setup failed for', def.id, e); cb(null); }
      }, function () { cb(null); });
    } catch (e) { cb(null); }
  };
})();
