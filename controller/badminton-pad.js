/* ===========================================================================
 * Smash Court  -  PHONE CONTROLLER (pad 'badminton')          controller/badminton-pad.js
 * ---------------------------------------------------------------------------
 * Loaded by controller/index.html BEFORE its main inline script.  It builds its own
 * <section id="badminton"> and CSS, so the controller page only needs a few marked one-line edits.
 *
 * Page API:  BM.init({out, buzz, slot:()=>n, id, colors})   once, after `out` exists
 *            BM.onShow(newView, oldView)                    from show()
 *            BM.state(payload)                              from the 'gstate' handler (g === 'badminton')
 *
 * Phone -> screen (all {t:'g', ...}):  mv {x,y} | shot {k,n,x,y} | dive | setup | char | assist | team {pid?,tm} | ready | start | again | tosetup | pause
 * Lesson from the other games: gstate is stored the moment it arrives, EVEN BEFORE this view is shown, and is
 * never cleared by show(); the screen re-sends it every 700 ms in every phase, so "Connecting..." resolves by itself.
 * ========================================================================= */
(function () {
  'use strict';
  var BM = window.BM = {}, A = null, S = { g: null, t: 0 }, E = {}, view = '', sig = '', seq = 0, lastCount = { pf: 0, ht: 0 }, menuOpen = false, localAssist = null;
  var CH = [   // character look-up for the preview avatars (names + colours match the screen)
    { n: 'Zap', skin: '#ffd2ab', hair: '#ffd23f', shirt: '#1fc7b6', short: '#ff8a1f', kind: 'spiky' },
    { n: 'Rusty', skin: '#f7c9a4', hair: '#ff4a1c', shirt: '#252a36', short: '#e5282b', kind: 'swoop' },
    { n: 'Kai', skin: '#f2b88c', hair: '#2b2547', shirt: '#ffffff', short: '#1c1d26', kind: 'short' },
    { n: 'Sol', skin: '#a8683c', hair: '#2b1a14', shirt: '#ffd21f', short: '#2d3a4a', kind: 'band' },
    { n: 'Mina', skin: '#ffdcc2', hair: '#ff6fb5', shirt: '#4de8b4', short: '#1d6fd6', kind: 'buns' },
    { n: 'Bruno', skin: '#8c5532', hair: '#3b2316', shirt: '#8a4dff', short: '#ffffff', kind: 'afro' }
  ];
  var TEAM = ['#2e8bff', '#ff4a5a'], TEAMN = ['BLUE', 'RED'];
  var SHOTS = [
    { k: 'drop', n: 'DROP', c: '#34d399', c2: '#0e9f6e', ic: '<path d="M10 70 Q50 10 90 62" fill="none"/><path d="M80 52l12 12-17 3" fill="none"/>' },
    { k: 'smash', n: 'SMASH', c: '#ff6a3d', c2: '#d9261c', ic: '<path d="M20 12l56 62" fill="none"/><path d="M52 74h26V48" fill="none"/><path d="M14 26l12-6M22 40l14-8" fill="none"/>' },
    { k: 'clear', n: 'CLEAR', c: '#3b9cff', c2: '#1d4fd8', ic: '<path d="M8 76 Q40 -14 92 76" fill="none"/><path d="M78 62l14 14 8-18" fill="none"/>' },
    { k: 'drive', n: 'DRIVE', c: '#b06cff', c2: '#6b2bd9', ic: '<path d="M8 50h70" fill="none"/><path d="M62 32l22 18-22 18" fill="none"/><path d="M14 34h34M14 66h34" fill="none" opacity=".6"/>' },
    { k: 'super', n: 'SUPER', c: '#ffd21f', c2: '#ff8a00', ic: '<path d="M58 6L22 56h26l-8 38 40-54H52z" fill="currentColor" stroke="none"/>' }
  ];

  /* ---------------------------------------------------------------- CSS */
  var CSS = '' +
    '#badminton{position:absolute;inset:0;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;font-family:ui-rounded,"SF Pro Rounded","Nunito","Trebuchet MS",system-ui,sans-serif;font-weight:800;color:#fff;' +
    'background:radial-gradient(120% 90% at 50% 0%,#2aa9ff 0%,#1458d8 45%,#0a1f6b 100%);--u:min(5vh,2.9vw)}#badminton.hide{display:none!important}' +
    '#badminton:before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(115deg,rgba(255,255,255,.05) 0 2.2vh,transparent 2.2vh 5vh);pointer-events:none}' +
    '#badminton button{font:inherit;color:inherit;border:0;background:none;touch-action:none}' +
    '.bmtop{position:absolute;left:0;right:0;top:0;height:calc(var(--u)*2.7 + env(safe-area-inset-top));padding:env(safe-area-inset-top) 1.2vw 0;display:flex;align-items:center;gap:1.2vw;z-index:5}' +
    '.bmtop .badge{padding:.5em .9em;font-size:12px;flex:none}.bmmn{width:calc(var(--u)*2);height:calc(var(--u)*2);border-radius:50%;background:rgba(0,0,0,.35)!important;border:2px solid rgba(255,255,255,.55)!important;display:grid;place-items:center;flex:none}.bmmn svg{width:55%;height:55%;stroke:#fff;stroke-width:3;fill:none;stroke-linecap:round}' +
    '.bmsc{flex:1;display:flex;align-items:center;justify-content:center;gap:1.4vw;font-size:calc(var(--u)*1.7);text-shadow:0 2px 0 rgba(0,0,0,.35)}.bmsc b{font-size:calc(var(--u)*2.5);line-height:1;padding:0 .25em;min-width:1.4em;text-align:center;border-radius:.35em}.bmsc .t0{background:#2e8bff}.bmsc .t1{background:#ff4a5a}.bmsc small{display:block;font-size:calc(var(--u)*.8);opacity:.85;text-align:center;letter-spacing:.06em}' +
    '.bmen{width:22vw;display:flex;align-items:center;flex:none}.bmen i{width:calc(var(--u)*1.9);height:calc(var(--u)*1.9);border-radius:50%;background:radial-gradient(circle at 35% 30%,#4a7bff,#12288a);border:3px solid #0a1030;display:grid;place-items:center;margin-right:-.9em;z-index:2}.bmen i svg{width:55%;height:55%}' +
    '.bmen div{flex:1;height:calc(var(--u)*1.1);border-radius:1em;background:#0b1740;border:3px solid #0a1030;overflow:hidden}.bmen u{display:block;height:100%;width:0;background:linear-gradient(#5dff4a,#0fbf1c);transition:width .12s}.bmen.full u{background:linear-gradient(#e8ff5a,#4de01c);animation:bmpulse .5s infinite alternate}@keyframes bmpulse{to{filter:brightness(1.7)}}' +
    '.bmstat{position:absolute;left:0;right:0;top:calc(var(--u)*2.8 + env(safe-area-inset-top));text-align:center;font-size:calc(var(--u)*1.25);pointer-events:none;z-index:4;text-shadow:0 2px 0 rgba(0,0,0,.4)}.bmstat span{display:inline-block;padding:.12em .8em;border-radius:1em;background:rgba(0,0,0,.35);margin:0 .2em}.bmstat .sv{background:#ffd21f;color:#3a2a00;text-shadow:none}.bmstat .mp{background:#ff3b5c}' +
    '#bmzone{position:absolute;left:0;top:calc(var(--u)*3);bottom:0;width:48%;z-index:2}#bmring{position:absolute;width:calc(var(--u)*7.6);height:calc(var(--u)*7.6);margin:calc(var(--u)*-3.8) 0 0 calc(var(--u)*-3.8);border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.14),rgba(255,255,255,.04) 70%);border:3px solid rgba(255,255,255,.55);box-shadow:0 0 0 calc(var(--u)*.5) rgba(255,255,255,.07),inset 0 0 20px rgba(255,255,255,.18);pointer-events:none}#bmring.on{border-color:#fff;background:radial-gradient(circle,rgba(255,255,255,.26),rgba(255,255,255,.08) 70%)}' +
    '#bmknob{position:absolute;left:50%;top:50%;width:46%;height:46%;margin:-23% 0 0 -23%;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff,#bcd7ff 55%,#6f9bff);box-shadow:0 6px 14px rgba(0,0,40,.5),inset 0 -4px 8px rgba(0,40,120,.35)}' +
    '#bmdive{position:absolute;left:calc(var(--u)*0.8 + 34%);bottom:calc(var(--u)*0.8);width:calc(var(--u)*3.4);height:calc(var(--u)*3.4);border-radius:50%;z-index:3}' +
    '.bmb{position:absolute;border-radius:50%;display:grid;place-items:center;color:#fff;border:calc(var(--u)*.16) solid rgba(255,255,255,.85);box-shadow:0 calc(var(--u)*.35) 0 rgba(0,0,0,.3),inset 0 calc(var(--u)*-.4) 0 rgba(0,0,0,.18),inset 0 calc(var(--u)*.3) calc(var(--u)*.5) rgba(255,255,255,.35);transition:transform .06s,filter .06s;z-index:3}' +
    '.bmb svg{width:46%;height:46%;stroke:#fff;stroke-width:9;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 3px 0 rgba(0,0,0,.3));overflow:visible}.bmb span{position:absolute;bottom:9%;font-size:calc(var(--u)*.95);letter-spacing:.05em;text-shadow:0 2px 0 rgba(0,0,0,.45)}' +
    '.bmb.on{transform:translateY(calc(var(--u)*.3)) scale(.93);filter:brightness(1.25);box-shadow:0 calc(var(--u)*.05) 0 rgba(0,0,0,.3),0 0 calc(var(--u)*2) var(--g)}' +
    '.bmb .cd{position:absolute;inset:-3px;border-radius:50%;background:conic-gradient(rgba(0,0,0,.55) var(--p,0deg),transparent 0);pointer-events:none;-webkit-mask:radial-gradient(circle,transparent 58%,#000 60%);mask:radial-gradient(circle,transparent 58%,#000 60%)}' +
    '.bmb.sup{overflow:visible}.bmb.sup .ch{position:absolute;inset:-9px;border-radius:50%;background:conic-gradient(#fff6a0 var(--p,0deg),rgba(255,255,255,.18) 0);-webkit-mask:radial-gradient(circle,transparent 62%,#000 64%);mask:radial-gradient(circle,transparent 62%,#000 64%);pointer-events:none}' +
    '.bmb.sup.rdy{animation:bmglow .6s ease-in-out infinite alternate}@keyframes bmglow{from{box-shadow:0 0 calc(var(--u)*1) #ffd21f}to{box-shadow:0 0 calc(var(--u)*3.2) #fff176,0 0 calc(var(--u)*5) #ff9d00}}.bmb.sup.no{filter:saturate(.35) brightness(.8)}' +
    '.bmb.shake{animation:bmshake .25s}@keyframes bmshake{25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}' +
    '#bmpad{position:absolute;right:2vw;bottom:calc(var(--u)*.6);width:calc(var(--u)*20.5);height:calc(var(--u)*14.8);z-index:3}' +
    '#bmpad.spec,#bmzone.spec,#bmdive.spec{opacity:.25;pointer-events:none}' +
    '#bmpanel{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(5,12,50,.72);padding:calc(env(safe-area-inset-top) + 2vh) 3vw 2vh;touch-action:pan-y}#bmpanel.hide{display:none}' +
    '.bmcard{width:min(100%,860px);max-height:96%;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:calc(var(--u)*1) calc(var(--u)*1.4);border-radius:calc(var(--u)*1.2);background:linear-gradient(160deg,#1f6fff,#102d96);border:3px solid rgba(255,255,255,.8);box-shadow:0 10px 40px rgba(0,0,0,.5);text-align:center;touch-action:pan-y}' +
    '.bmcard h2{margin:0 0 .3em;font-size:calc(var(--u)*2.1);font-style:italic;text-shadow:0 3px 0 rgba(0,0,0,.35)}.bmcard p{margin:.3em 0;font-size:calc(var(--u)*1.15);opacity:.92}' +
    '.bmrow{display:flex;align-items:center;gap:.6em;margin:.45em 0;flex-wrap:wrap}.bmrow>label{width:5.6em;text-align:left;font-size:calc(var(--u)*.95);opacity:.8;letter-spacing:.08em;flex:none}.bmrow .ch{display:flex;gap:.4em;flex-wrap:wrap;flex:1}' +
    '.bmc{padding:.45em .9em;border-radius:2em;background:rgba(255,255,255,.14);border:2px solid rgba(255,255,255,.35);font-size:calc(var(--u)*1.1);touch-action:manipulation}.bmc.on{background:#ffd21f;color:#3a2a00;border-color:#fff}.bmc.dis{opacity:.35;pointer-events:none}.bmc.t0.on{background:#2e8bff;color:#fff}.bmc.t1.on{background:#ff4a5a;color:#fff}' +
    '.bmchars{display:grid;grid-template-columns:repeat(6,1fr);gap:.5em;flex:1}.bmav{border-radius:1em;background:rgba(255,255,255,.12);border:2px solid rgba(255,255,255,.3);padding:.3em .1em .2em;font-size:calc(var(--u)*.85);touch-action:manipulation}.bmav.on{background:rgba(255,210,31,.95);color:#3a2a00;border-color:#fff}.bmav svg{width:70%;height:auto;display:block;margin:0 auto}' +
    '.bmgo{display:block;width:100%;margin:.6em 0 .2em;padding:.7em;border-radius:1em;font-size:calc(var(--u)*1.7);font-style:italic;background:linear-gradient(#ffe45e,#ffa800);color:#3a2a00!important;box-shadow:0 .25em 0 #a85f00;touch-action:manipulation}.bmgo:active{transform:translateY(.15em);box-shadow:0 .1em 0 #a85f00}.bmgo.alt{background:linear-gradient(#5db4ff,#2263e6);color:#fff!important;box-shadow:0 .25em 0 #0f3aa6}.bmgo.half{display:inline-block;width:48%;margin:.5em 1%}' +
    '.bmtable{width:100%;border-collapse:collapse;font-size:calc(var(--u)*1.05);margin:.3em 0}.bmtable td,.bmtable th{padding:.25em;border-bottom:1px solid rgba(255,255,255,.2)}' +
    '.bmbig{font-size:calc(var(--u)*3.6);line-height:1}.bmtoast{position:absolute;left:0;right:0;top:calc(var(--u)*5);text-align:center;font-size:calc(var(--u)*2.2);font-style:italic;text-shadow:0 3px 0 rgba(0,0,0,.4);pointer-events:none;z-index:6;opacity:0}.bmtoast.go{animation:bmtoast 1.6s ease-out forwards}@keyframes bmtoast{0%{opacity:0;transform:scale(.6)}12%{opacity:1;transform:none}80%{opacity:1}100%{opacity:0}}' +
    '.bmrot{position:absolute;inset:0;background:#000;z-index:40;display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center}@media(orientation:portrait){#badminton:not(.hide) .bmrot{display:flex}}';

  /* ---------------------------------------------------------------- BUILD DOM */
  function icon(n) { return '<svg viewBox="0 0 100 100">' + n + '</svg>'; }
  function avatar(c) {
    var d = CH[c] || CH[0], hair = '';
    if (d.kind === 'spiky') hair = '<path d="M22 34 L26 10 L38 26 L46 6 L54 26 L66 8 L74 34 Z" fill="' + d.hair + '"/>';
    else if (d.kind === 'swoop') hair = '<path d="M20 38 Q22 10 54 10 Q82 12 80 38 Q60 22 34 30Z" fill="' + d.hair + '"/>';
    else if (d.kind === 'short') hair = '<path d="M22 36 Q22 12 50 12 Q78 12 78 36 Q66 24 50 24 Q34 24 22 36Z" fill="' + d.hair + '"/>';
    else if (d.kind === 'band') hair = '<path d="M22 36 Q22 12 50 12 Q78 12 78 36Z" fill="' + d.hair + '"/><rect x="20" y="26" width="60" height="8" fill="#fff"/><rect x="20" y="29" width="60" height="2" fill="#e5282b"/>';
    else if (d.kind === 'buns') hair = '<circle cx="24" cy="14" r="10" fill="' + d.hair + '"/><circle cx="76" cy="14" r="10" fill="' + d.hair + '"/><path d="M22 36 Q22 12 50 12 Q78 12 78 36Z" fill="' + d.hair + '"/>';
    else hair = '<circle cx="50" cy="26" r="30" fill="' + d.hair + '"/>';
    return '<svg viewBox="0 0 100 110"><rect x="26" y="66" width="48" height="30" rx="14" fill="' + d.shirt + '"/><rect x="30" y="92" width="40" height="14" rx="6" fill="' + d.short + '"/>' + (d.kind === 'afro' ? hair : '') +
      '<circle cx="50" cy="44" r="28" fill="' + d.skin + '"/>' + (d.kind === 'afro' ? '' : hair) + '<ellipse cx="39" cy="46" rx="6" ry="8" fill="#fff"/><ellipse cx="61" cy="46" rx="6" ry="8" fill="#fff"/><circle cx="40" cy="47" r="3.6" fill="#1b2a60"/><circle cx="60" cy="47" r="3.6" fill="#1b2a60"/><path d="M42 60 Q50 67 58 60" stroke="#7a2a2a" stroke-width="3" fill="none" stroke-linecap="round"/>' +
      (d.kind === 'band' ? '<ellipse cx="39" cy="46" rx="9" ry="9" fill="none" stroke="#ffd21f" stroke-width="3"/><ellipse cx="61" cy="46" rx="9" ry="9" fill="none" stroke="#ffd21f" stroke-width="3"/>' : '') + '</svg>';
  }
  function build() {
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var s = document.createElement('section'); s.id = 'badminton'; s.className = 'hide';
    var btns = '', pos = { drop: [7.6, 3.4, 4.1], smash: [11.2, 7.4, 5.6], clear: [5.6, 9.4, 4.2], drive: [16.2, 2.6, 4.1], super: [10.6, -0.4, 4.4] };
    SHOTS.forEach(function (b) {
      var p = pos[b.k];
      btns += '<button class="bmb' + (b.k === 'super' ? ' sup no' : '') + '" data-k="' + b.k + '" style="left:calc(var(--u)*' + p[0] + ');top:calc(var(--u)*' + p[1] + ');width:calc(var(--u)*' + p[2] + ');height:calc(var(--u)*' + p[2] + ');background:radial-gradient(circle at 35% 28%,' + b.c + ',' + b.c2 + ');--g:' + b.c + '">' +
        (b.k === 'super' ? '<i class="ch"></i>' : '<i class="cd"></i>') + icon(b.ic) + '<span>' + b.n + '</span></button>';
    });
    s.innerHTML = '<div class="bmtop"><button class="bmmn" id="bmmn" aria-label="Menu"><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button><div id="bbadge" class="badge glass"></div>' +
      '<div class="bmsc" id="bmsc"></div><div class="bmen" id="bmen"><i><svg viewBox="0 0 24 24"><path d="M13.5 2L5 13.5h5.5L9.5 22 19 9.5h-5.8z" fill="#fff"/></svg></i><div><u id="bmenu"></u></div></div></div>' +
      '<div class="bmstat" id="bmstat"></div><div class="bmtoast" id="bmtoast"></div>' +
      '<div id="bmzone"><div id="bmring"><div id="bmknob"></div></div></div>' +
      '<button class="bmb" id="bmdive" data-k="dive" style="background:radial-gradient(circle at 35% 28%,#7be0ff,#1c8ad6);--g:#7be0ff">' + icon('<path d="M10 62l60-26" fill="none"/><path d="M52 24l24 10-10 22" fill="none"/><path d="M12 84h76" fill="none" opacity=".6"/>') + '<span>DIVE</span></button>' +
      '<div id="bmpad">' + btns + '</div><div id="bmpanel" class="hide"></div>' +
      '<div class="bmrot"><div style="font-size:54px">&#8635;</div><p>Rotate your phone to play</p></div>';
    document.body.appendChild(s); E.root = s; E.zone = s.querySelector('#bmzone'); E.ring = s.querySelector('#bmring'); E.knob = s.querySelector('#bmknob'); E.panel = s.querySelector('#bmpanel');
    E.sc = s.querySelector('#bmsc'); E.en = s.querySelector('#bmen'); E.enu = s.querySelector('#bmenu'); E.stat = s.querySelector('#bmstat'); E.toast = s.querySelector('#bmtoast'); E.pad = s.querySelector('#bmpad'); E.dive = s.querySelector('#bmdive'); E.mn = s.querySelector('#bmmn');
    E.btn = {}; s.querySelectorAll('.bmb[data-k]').forEach(function (b) { E.btn[b.dataset.k] = b; });
    wire();
  }

  /* ---------------------------------------------------------------- INPUT */
  var stick = { x: 0, y: 0, id: null, ox: 0, oy: 0, last: 0, sent: 0 }, R = 58;
  function sendMv(force) {
    var n = performance.now(); if (!force && n - stick.sent < 30) return; stick.sent = n;
    A.out({ t: 'g', a: 'mv', x: +stick.x.toFixed(2), y: +stick.y.toFixed(2) });
  }
  function setRingAt(px, py) { var r = E.zone.getBoundingClientRect(); E.ring.style.left = (px - r.left) + 'px'; E.ring.style.top = (py - r.top) + 'px'; }
  function homeRing() { var r = E.zone.getBoundingClientRect(); E.ring.style.left = (r.width * 0.46) + 'px'; E.ring.style.top = (r.height * 0.68) + 'px'; E.knob.style.transform = ''; E.ring.classList.remove('on'); }
  function wire() {
    var z = E.zone;
    function move(e) {
      var rr = E.ring.getBoundingClientRect(), R2 = rr.width / 2, cx = rr.left + R2, cy = rr.top + R2, dx = e.clientX - cx, dy = e.clientY - cy, m = Math.hypot(dx, dy), lim = R2 * 0.95;
      if (m > lim) { dx *= lim / m; dy *= lim / m; }
      E.knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; stick.x = dx / lim; stick.y = dy / lim; sendMv(false);
    }
    z.addEventListener('pointerdown', function (e) {
      if (stick.id !== null) return; e.preventDefault(); stick.id = e.pointerId; try { z.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      var r = z.getBoundingClientRect(), px = Math.min(Math.max(e.clientX, r.left + 70), r.right - 70), py = Math.min(Math.max(e.clientY, r.top + 70), r.bottom - 70);
      setRingAt(px, py); E.ring.classList.add('on'); move(e);
    });
    z.addEventListener('pointermove', function (e) { if (e.pointerId === stick.id) { e.preventDefault(); move(e); } });
    function up(e) { if (e.pointerId !== stick.id) return; stick.id = null; stick.x = stick.y = 0; homeRing(); sendMv(true); }
    z.addEventListener('pointerup', up); z.addEventListener('pointercancel', up); z.addEventListener('lostpointercapture', up);
    // shot buttons: discrete messages, sequence number, aim = stick at the moment of the press
    var cd = {};
    function press(b, e) {
      e.preventDefault(); var k = b.dataset.k; try { b.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      if (k === 'dive') { b.classList.add('on'); A.buzz(18); A.out({ t: 'g', a: 'dive' }); return; }
      if (k === 'super' && !(S.g && myEnergy() >= 0.999)) { b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake'); A.buzz([8, 30, 8]); return; }
      b.classList.add('on'); A.buzz(k === 'smash' || k === 'super' ? 24 : 12);
      A.out({ t: 'g', a: 'shot', k: k, n: ++seq, x: +stick.x.toFixed(2), y: +stick.y.toFixed(2) });
      if (k !== 'super') { cd[k] = performance.now(); }
    }
    function release(b) { b.classList.remove('on'); }
    Object.keys(E.btn).concat(['dive']).forEach(function (k) {
      var b = k === 'dive' ? E.dive : E.btn[k];
      b.addEventListener('pointerdown', function (e) { press(b, e); });
      b.addEventListener('pointerup', function () { release(b); }); b.addEventListener('pointercancel', function () { release(b); }); b.addEventListener('lostpointercapture', function () { release(b); });
    });
    // cooldown rings are visual only (0.25 s); they never block a tap
    setInterval(function () {
      var n = performance.now();
      for (var k in cd) { var p = clamp01(1 - (n - cd[k]) / 250), b = E.btn[k]; if (b) b.firstChild.style.setProperty('--p', (p * 360) + 'deg'); }
    }, 40);
    E.mn.addEventListener('click', function () { menuOpen = !menuOpen; sig = ''; render(); });
    E.panel.addEventListener('click', onPanel);
    window.addEventListener('resize', homeRing);
    setInterval(function () { if (view === 'badminton' && A) sendMv(true); }, 120);        // heartbeat: the screen never thinks we vanished
  }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* ---------------------------------------------------------------- STATE / RENDER */
  function myId() { return A.id; }
  function seatOf(g) { if (!g) return null; for (var i = 0; i < g.pl.length; i++) if (g.pl[i].id === myId()) return g.pl[i]; return null; }
  function myEnergy() { return S.g && S.g.en ? (S.g.en[myId()] || 0) : 0; }
  function isHost() { return A.slot() === 0; }
  function setupMsg(o) {
    var g = S.g, m = { t: 'g', a: 'setup', mode: g.mode, diff: g.diff, ven: g.ven, pts: g.pts, bo: g.bo, lad: g.lad };
    for (var k in o) { m[k] = o[k]; g[k] = o[k]; }
    A.out(m); sig = ''; render();
  }
  function onPanel(e) {
    var t = e.target.closest('[data-a]'); if (!t || !S.g) return; var a = t.dataset.a, v = t.dataset.v, g = S.g;
    A.buzz(10);
    if (a === 'mode' || a === 'diff' || a === 'ven' || a === 'lad' || a === 'pts' || a === 'bo') { var o = {}; o[a] = a === 'mode' ? v : +v; setupMsg(o); }
    else if (a === 'char') { A.out({ t: 'g', a: 'char', c: +v }); g.pl.forEach(function (s) { if (s.id === myId()) s.c = +v; }); sig = ''; render(); }
    else if (a === 'assist') { var on = g.as && g.as[myId()] === 0 ? 1 : 0; g.as = g.as || {}; g.as[myId()] = on; A.out({ t: 'g', a: 'assist', on: on }); sig = ''; render(); }
    else if (a === 'team') { var pid = t.dataset.pid; A.out({ t: 'g', a: 'team', pid: isHost() ? pid : undefined, tm: +v }); g.tp = g.tp || {}; g.tp[pid] = +v; sig = ''; render(); }
    else if (a === 'ready') A.out({ t: 'g', a: 'ready' });
    else if (a === 'start') A.out({ t: 'g', a: 'start' });
    else if (a === 'again') A.out({ t: 'g', a: 'again' });
    else if (a === 'tosetup') A.out({ t: 'g', a: 'tosetup' });
    else if (a === 'pause') { A.out({ t: 'g', a: 'pause' }); menuOpen = false; sig = ''; }
    else if (a === 'closemenu') { menuOpen = false; sig = ''; render(); }
    else if (a === 'quit') { menuOpen = false; A.out({ t: 'btn', k: 'select', d: 1 }); A.out({ t: 'btn', k: 'select', d: 0 }); }
  }
  function chips(act, vals, labels, cur, dis) {
    return vals.map(function (v, i) { return '<button class="bmc' + (String(cur) === String(v) ? ' on' : '') + (dis && dis(v) ? ' dis' : '') + '" data-a="' + act + '" data-v="' + v + '">' + labels[i] + '</button>'; }).join('');
  }
  function charGrid(g, cur) { return '<div class="bmchars">' + CH.map(function (c, i) { return '<button class="bmav' + (i === cur ? ' on' : '') + '" data-a="char" data-v="' + i + '">' + avatar(i) + c.n + '</button>'; }).join('') + '</div>'; }
  function assistRow(g) { var on = !(g.as && g.as[myId()] === 0); return '<div class="bmrow"><label>ASSIST</label><div class="ch"><button class="bmc' + (on ? ' on' : '') + '" data-a="assist">' + (on ? 'AUTO STEP ON' : 'AUTO STEP OFF') + '</button></div></div>'; }
  function teamRows(g) {
    if (g.mode !== '2v2') return '';
    var rows = g.pl.filter(function (s) { return !s.ai; }).map(function (s) {
      var mine = s.id === myId(); if (!isHost() && !mine) return '';
      return '<div class="bmrow"><label>' + (mine ? 'YOU' : 'P' + (g.pl.indexOf(s) + 1)) + '</label><div class="ch"><button class="bmc t0' + (s.t === 0 ? ' on' : '') + '" data-a="team" data-pid="' + s.id + '" data-v="0">BLUE</button><button class="bmc t1' + (s.t === 1 ? ' on' : '') + '" data-a="team" data-pid="' + s.id + '" data-v="1">RED</button></div></div>';
    }).join('');
    return rows ? '<div style="text-align:left;font-size:calc(var(--u)*.95);opacity:.8;margin-top:.5em">TEAMS (2 vs 2, empty seats are CPU)</div>' + rows : '';
  }
  function panelHtml(g) {
    var ph = g.ph, seat = seatOf(g), host = isHost(), me = seat ? seat.c : 0, html = '';
    if (menuOpen) {
      return '<div class="bmcard" style="width:min(100%,420px)"><h2>MENU</h2>' + (host ? '<button class="bmgo" data-a="pause">' + (ph === 'paused' ? 'RESUME' : 'PAUSE') + '</button><button class="bmgo alt" data-a="quit">QUIT TO MENU</button>' : '<p>Only Player 1 can pause or quit.</p>') + '<button class="bmgo alt" data-a="closemenu">BACK</button></div>';
    }
    if (ph === 'setup') {
      if (!seat) return '<div class="bmcard"><h2>SMASH COURT</h2><p>All four seats are taken.<br>You will watch this match, and play the next one.</p></div>';
      if (host) {
        html = '<div class="bmcard"><h2>MATCH SETUP</h2>' +
          '<div class="bmrow"><label>MODE</label><div class="ch">' + chips('mode', ['solo', '1v1', '2v2'], ['SOLO vs CPU', '1 vs 1', 'DOUBLES'], g.mode, function (v) { return v === '1v1' && g.np < 2; }) + '</div></div>' +
          '<div class="bmrow"><label>LEVEL</label><div class="ch">' + chips('diff', [0, 1, 2], ['EASY', 'NORMAL', 'HARD'], g.diff) + '</div></div>' +
          (g.mode === 'solo' ? '<div class="bmrow"><label>RIVAL</label><div class="ch">' + chips('lad', [0, 1, 2, 3, 4], g.on.map(function (n, i) { return (i + 1) + '. ' + n; }), g.lad) + '</div></div>' : '') +
          '<div class="bmrow"><label>VENUE</label><div class="ch">' + chips('ven', [0, 1, 2], g.vn, g.ven) + '</div></div>' +
          '<div class="bmrow"><label>POINTS</label><div class="ch">' + chips('pts', [7, 11, 21], ['7', '11', '21'], g.pts) + '</div><label style="width:auto">BEST OF</label><div class="ch" style="flex:none">' + chips('bo', [1, 3], ['1', '3'], g.bo) + '</div></div>' +
          '<p style="font-size:calc(var(--u)*.95)">Rally scoring: first to ' + g.pts + ', win by 2, cap ' + (g.pts + 4) + ', best of ' + g.bo + '</p>' +
          '<div class="bmrow"><label>PLAYER</label>' + charGrid(g, me) + '</div>' + assistRow(g) + teamRows(g) + '<button class="bmgo" data-a="start">START MATCH</button></div>';
      } else {
        var rd = g.rd.indexOf(myId()) >= 0;
        html = '<div class="bmcard"><h2>GET READY</h2><p>Player 1 is setting up: ' + ({ solo: 'solo vs CPU', '1v1': '1 vs 1', '2v2': 'doubles' }[g.mode] || '') + ', first to ' + g.pts + ', best of ' + g.bo + ' on ' + g.vn[g.ven] + '</p>' +
          '<div class="bmrow"><label>PLAYER</label>' + charGrid(g, me) + '</div>' + assistRow(g) + teamRows(g) + '<button class="bmgo' + (rd ? ' alt' : '') + '" data-a="ready">' + (rd ? 'READY! (tap to undo)' : 'I AM READY') + '</button></div>';
      }
      return html;
    }
    if (ph === 'paused') return '<div class="bmcard" style="width:min(100%,420px)"><h2>PAUSED</h2>' + (host ? '<button class="bmgo" data-a="pause">RESUME</button><button class="bmgo alt" data-a="quit">QUIT TO MENU</button>' : '<p>Player 1 paused the game</p>') + '</div>';
    if (ph === 'gameover') return '<div class="bmcard" style="width:min(100%,460px);background:linear-gradient(160deg,#1f6fff,#102d96)"><h2>GAME ' + (g.gm[0] + g.gm[1]) + ' DONE</h2><div class="bmbig">' + g.sc[0] + ' - ' + g.sc[1] + '</div><p>Games ' + g.gm[0] + ' - ' + g.gm[1] + '</p><p>Switching ends... next game starts by itself</p></div>';
    if (ph === 'results' && g.res) {
      var r = g.res, mine = r.players.filter(function (p) { return p.id === myId(); })[0], won = seat && seat.t === r.winner;
      html = '<div class="bmcard"><h2>' + (seat ? (won ? 'YOU WIN!' : 'GOOD MATCH') : (TEAMN[r.winner] + ' TEAM WINS')) + '</h2><div class="bmbig">' + r.games[0] + ' - ' + r.games[1] + '</div><p>' + r.log.map(function (s, i) { return 'G' + (i + 1) + ' ' + s[0] + '-' + s[1]; }).join('  ') + '  Longest rally ' + r.longest + '</p>';
      if (mine) html += '<table class="bmtable"><tr><th>POINTS</th><th>WINNERS</th><th>SMASHES</th><th>PERFECT</th><th>ERRORS</th></tr><tr><td>' + mine.pts + '</td><td>' + mine.winners + '</td><td>' + mine.smashes + '</td><td>' + mine.perfects + '</td><td>' + mine.errors + '</td></tr></table>';
      html += host ? '<button class="bmgo half" data-a="again">' + (r.ladderUp ? 'NEXT RIVAL' : 'REMATCH') + '</button><button class="bmgo half alt" data-a="tosetup">SETUP</button><button class="bmgo alt" data-a="quit" style="font-size:calc(var(--u)*1.2)">QUIT TO MENU</button>' : '<p>Waiting for Player 1...</p>';
      return html + '</div>';
    }
    return '';
  }
  function render() {
    if (!E.root) return;
    var g = S.g, ph = g ? g.ph : 'wait';
    if (!g) { E.panel.classList.remove('hide'); E.panel.innerHTML = '<div class="bmcard" style="width:min(100%,380px)"><h2>CONNECTING...</h2><p>Waiting for the screen</p></div>'; E.pad.classList.add('spec'); E.zone.classList.add('spec'); E.dive.classList.add('spec'); return; }
    var seat = seatOf(g), spec = !seat;
    // live readouts (cheap, every state)
    var my = seat ? seat.t : (g.sc[0] >= g.sc[1] ? 0 : 1), en = seat ? myEnergy() : 0;
    E.sc.innerHTML = '<div><b class="t0">' + g.sc[0] + '</b></div><div style="opacity:.8">:</div><div><b class="t1">' + g.sc[1] + '</b></div>' + (g.bo === 3 ? '<small>GAMES ' + g.gm[0] + '-' + g.gm[1] + '</small>' : '');
    E.enu.style.width = Math.round(en * 100) + '%'; E.en.classList.toggle('full', en >= 0.999); E.en.style.visibility = spec ? 'hidden' : '';
    var sup = E.btn['super']; sup.classList.toggle('rdy', en >= 0.999); sup.classList.toggle('no', en < 0.999); sup.querySelector('.ch').style.setProperty('--p', Math.round(clamp01(en) * 360) + 'deg');
    var stat = '';
    if (spec) stat = '<span>WATCHING</span>'; else if (ph === 'serve' || ph === 'rally' || ph === 'intro') { if (g.sv === myId()) stat += '<span class="sv">YOUR SERVE: tap a shot</span>'; else if (g.st === seat.t) stat += '<span class="sv">YOUR TEAM SERVES</span>'; }
    if (g.mp >= 0 && (ph === 'serve' || ph === 'rally')) stat += '<span class="mp">MATCH POINT ' + TEAMN[g.mp] + '</span>';
    if (g.ra >= 4 && ph === 'rally') stat += '<span>RALLY ' + g.ra + '</span>';
    if (E.stat._h !== stat) { E.stat._h = stat; E.stat.innerHTML = stat; }
    E.pad.classList.toggle('spec', spec || ph === 'setup'); E.zone.classList.toggle('spec', spec || ph === 'setup'); E.dive.classList.toggle('spec', spec || ph === 'setup');
    E.root.style.setProperty('--tc', TEAM[my]);
    // toast: reason of the last point
    if (ph === 'point' && g.msg && E.toast._m !== g.msg + g.sc) { E.toast._m = g.msg + g.sc; E.toast.textContent = g.msg; E.toast.classList.remove('go'); void E.toast.offsetWidth; E.toast.classList.add('go'); }
    // haptics from counters
    if (seat) { var pf = (g.pf && g.pf[myId()]) || 0, ht = (g.ht && g.ht[myId()]) || 0; if (pf > lastCount.pf) A.buzz([30, 25, 70]); else if (ht > lastCount.ht) A.buzz(16); lastCount.pf = pf; lastCount.ht = ht; }
    // panel (rebuilt only when something it shows changes: never while the player is playing)
    var showP = menuOpen || ph === 'setup' || ph === 'paused' || ph === 'gameover' || ph === 'results';
    var ns = JSON.stringify([showP, menuOpen, ph, g.mode, g.diff, g.ven, g.pts, g.bo, g.lad, g.rd, g.pl, g.tp, g.as, seat && seat.c, g.np, ph === 'results' ? (g.res && g.res.games) : 0, g.gm, ph === 'gameover' ? g.sc : 0, isHost()]);
    if (ns !== sig) { sig = ns; if (showP) { E.panel.innerHTML = panelHtml(g); E.panel.classList.remove('hide'); } else { E.panel.classList.add('hide'); E.panel.innerHTML = ''; } }
  }

  /* ---------------------------------------------------------------- PAGE API */
  BM.init = function (api) { A = api; build(); homeRing(); };
  BM.state = function (p) { S.g = p; S.t = Date.now(); if (view === 'badminton') render(); };   // stored even before the view is shown
  BM.onShow = function (nv, ov) {
    view = nv;
    if (nv === 'badminton' && ov !== 'badminton') {
      if (S.g && Date.now() - S.t > 3000) S.g = null;                 // stale state from an earlier game: wait for the next 700 ms heartbeat
      sig = ''; menuOpen = false; lastCount.pf = S.g && S.g.pf ? (S.g.pf[myId()] || 0) : 0; lastCount.ht = S.g && S.g.ht ? (S.g.ht[myId()] || 0) : 0;
      setTimeout(function () { homeRing(); render(); }, 30);
    } else if (ov === 'badminton' && nv !== 'badminton') { S.g = null; stick.x = stick.y = 0; stick.id = null; sig = ''; }
  };
})();
