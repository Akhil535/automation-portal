// Sign-in page: an animated isometric "video" of what the portal does – drawn as SVG here (no video file, works
// offline, sharp at any size). Four islands: 1 Policies · 2 HR & vendor forms · 3 LEGAL REGISTER · 4 DoH updates;
// a package travels from island to island, the active island lights up, a caption explains each step, and an AI
// assistant bubble answers on the way. Pauses when hidden; a still picture for people who prefer less motion.
(() => {
  const stage = document.getElementById('la-stage');
  if (!stage) return;
  const O = { x: 140, y: 250 };
  const P = (x, y, z = 0) => [O.x + (x - y) * 0.866, O.y + (x + y) * 0.5 - z];
  const pts = a => a.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
  const box = (x, y, z, w, d, h, cls = '') => {
    const top = [P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)];
    const left = [P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)];
    const right = [P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h)];
    return `<g class="${cls}"><polygon class="f-l" points="${pts(left)}"/><polygon class="f-r" points="${pts(right)}"/><polygon class="f-t" points="${pts(top)}"/></g>`;
  };
  const G = 170, T = 130;
  const isle = k => ({ x: k * G, y: -k * G });
  const centre = k => [isle(k).x + T / 2, isle(k).y + T / 2, 14];
  const STEPS = [
    { tag: 'Step 1 · Policies', title: 'Your 33 ADHICS policies – written for you', sub: 'Add your logo, signature and stamp once. Every policy is filled with your facility’s name, dates and Policy IDs, as Word and PDF.' },
    { tag: 'Step 2 · HR & vendor forms', title: 'HR, training and 3rd-party forms in seconds', sub: 'NDA, orientation, background checks, exit clearance, training records, vendor NDAs – each with your logo and its own Ref. No.' },
    { tag: 'Step 3 · LEGAL REGISTER', title: 'Every licence and certificate, always in date', sub: 'Upload a document or a photo – the dates are read for you. Renewals are flagged before anything lapses.' },
    { tag: 'Always on · DoH updates', title: 'New DoH circulars added every week', sub: 'The portal checks the Department of Health, adds each new circular to your register and tells you what applies to you.' },
  ];
  const BADGE = ['Policies', 'HR forms', 'Register', 'DoH'];

  function scene() {
    let s = `<polyline class="iso-path" points="${pts([0, 1, 2, 3].map(k => P(...centre(k))))}"/>`;
    for (let k = 0; k < 4; k++) {
      const { x, y } = isle(k);
      s += `<g class="iso-isle" data-k="${k}">${box(x, y, 0, T, T, 14, 'slab')}`;
      if (k === 0) { // policies: a stack of documents and a stamp
        s += box(x + 28, y + 40, 14, 62, 44, 4, 'paper') + box(x + 32, y + 36, 18, 62, 44, 4, 'paper') + box(x + 36, y + 32, 22, 62, 44, 4, 'paper top-sheet');
        s += box(x + 86, y + 84, 14, 20, 20, 16, 'stamp') + box(x + 92, y + 90, 30, 8, 8, 14, 'stamp-h');
      } else if (k === 1) { // HR & vendor forms: a person and two ID cards
        s += box(x + 30, y + 70, 14, 22, 22, 34, 'cabinet') + box(x + 33, y + 73, 48, 16, 16, 16, 'paper');
        s += box(x + 70, y + 30, 14, 40, 4, 52, 'paper top-sheet') + box(x + 84, y + 50, 14, 40, 4, 52, 'calendar');
        s += box(x + 84, y + 50, 58, 40, 4, 8, 'calendar-top');
      } else if (k === 2) { // LEGAL REGISTER: a cabinet and a calendar
        s += box(x + 24, y + 30, 14, 34, 70, 78, 'cabinet') + box(x + 58, y + 38, 22, 3, 54, 14, 'drawer') + box(x + 58, y + 38, 44, 3, 54, 14, 'drawer') + box(x + 58, y + 38, 66, 3, 54, 14, 'drawer');
        s += box(x + 78, y + 80, 14, 30, 30, 30, 'calendar') + box(x + 78, y + 80, 44, 30, 30, 6, 'calendar-top');
      } else { // DoH: a government building with columns, a roof and signals
        s += box(x + 22, y + 22, 14, 86, 86, 8, 'plinth');
        for (const c of [30, 52, 74, 96]) s += box(x + c, y + 98, 22, 8, 8, 40, 'column');
        s += box(x + 30, y + 30, 22, 74, 66, 40, 'hall') + box(x + 18, y + 18, 62, 94, 94, 8, 'eave');
        const apex = P(x + 65, y + 65, 100);
        s += `<polygon class="roof-l" points="${pts([P(x + 18, y + 112, 70), P(x + 112, y + 112, 70), apex])}"/><polygon class="roof-r" points="${pts([P(x + 112, y + 18, 70), P(x + 112, y + 112, 70), apex])}"/>`;
        s += `<g class="signal">${[0, 1, 2].map(i => `<circle cx="${apex[0].toFixed(1)}" cy="${(apex[1] - 6).toFixed(1)}" r="10" style="animation-delay:${i * 0.6}s"/>`).join('')}</g>`;
      }
      const [bx, by] = P(...centre(k).slice(0, 2), k === 3 ? 128 : 116);
      s += `<g class="iso-badge" transform="translate(${bx.toFixed(1)},${by.toFixed(1)})"><rect x="-58" y="-15" width="116" height="30" rx="15"/><text class="b-num" x="-40" y="5">${['1', '2', '3', '↻'][k]}</text><text class="b-txt" x="-26" y="5">${BADGE[k]}</text></g>`;
      s += '</g>';
    }
    s += `<g class="iso-pkg" id="la-pkg">${box(-9, -9, 0, 18, 18, 18, 'pkg')}</g>`;
    return `<svg viewBox="12 156 1122 238" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="How the Compliance Portal works">
      <defs><linearGradient id="isoGlow" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f766e"/><stop offset=".5" stop-color="#14b8a6"/><stop offset="1" stop-color="#5eead4"/></linearGradient></defs>
      <g class="iso-world">${s}</g></svg>`;
  }

  stage.innerHTML = scene();
  const svg = stage.querySelector('svg');
  const fit = () => { try { const b = svg.querySelector('.iso-world').getBBox(); if (b.width > 0) svg.setAttribute('viewBox', `${(b.x - 14).toFixed(0)} ${(b.y - 14).toFixed(0)} ${(b.width + 28).toFixed(0)} ${(b.height + 28).toFixed(0)}`); } catch { /* not drawn yet */ } };
  requestAnimationFrame(fit); setTimeout(fit, 400); window.addEventListener('load', fit);

  const $ = id => document.getElementById(id);
  const dots = [...document.querySelectorAll('#la-dots button')];
  const STEP_MS = 4200, MOVE_MS = 900;
  const st = { k: -1, t0: performance.now(), playing: true, raf: 0 };
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const lerp = (a, b, f) => a.map((v, i) => v + (b[i] - v) * f);
  const ease = f => (f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2);
  function place(k, f) {
    const from = centre(k === 0 ? 3 : k - 1), to = centre(k);
    const g = k === 0 && f >= 1 ? to : lerp(from, to, ease(Math.min(1, f)));
    const hop = f < 1 ? Math.sin(Math.PI * Math.min(1, f)) * (k === 0 ? 70 : 40) : 0;
    const [sx, sy] = P(g[0], g[1], g[2] + 6 + hop), [ox, oy] = P(0, 0, 0);
    $('la-pkg')?.setAttribute('transform', `translate(${(sx - ox).toFixed(1)},${(sy - oy).toFixed(1)})`);
  }
  function show(k) {
    if (k === st.k) return;
    st.k = k;
    stage.querySelectorAll('.iso-isle').forEach(g => { const on = Number(g.dataset.k) === k; g.classList.toggle('on', on); g.classList.toggle('now', on); });
    dots.forEach((b, i) => { b.classList.toggle('on', i === k); b.setAttribute('aria-selected', i === k); });
    const cap = $('la-caption');
    cap.classList.remove('in'); void cap.offsetWidth; cap.classList.add('in');
    $('la-tag').textContent = STEPS[k].tag; $('la-title').textContent = STEPS[k].title; $('la-sub').textContent = STEPS[k].sub;
    $('la-ai').classList.toggle('show', k === 2 || k === 3);
  }
  function frame(now) {
    st.raf = 0;
    if (!st.playing || document.hidden) return;
    const el = now - st.t0, k = Math.floor(el / STEP_MS) % 4, f = (el % STEP_MS) / MOVE_MS;
    show(k); place(k, f);
    $('la-bar').style.width = `${(((el % (STEP_MS * 4)) / (STEP_MS * 4)) * 100).toFixed(2)}%`;
    st.raf = requestAnimationFrame(frame);
  }
  const run = () => { if (!st.raf && st.playing) st.raf = requestAnimationFrame(frame); };
  function jump(k) { st.playing = false; cancelAnimationFrame(st.raf); st.raf = 0; show(k); place(k, 1); $('la-bar').style.width = `${((k + 1) / 4) * 100}%`; $('la-play').textContent = '▶ Play'; st.t0 = performance.now() - k * STEP_MS - MOVE_MS; }
  dots.forEach((b, i) => { b.onclick = () => jump(i); });
  $('la-play').onclick = () => {
    st.playing = !st.playing;
    $('la-play').textContent = st.playing ? '❚❚ Pause' : '▶ Play';
    if (st.playing) { st.t0 = performance.now() - Math.max(0, st.k) * STEP_MS - MOVE_MS; run(); }
  };
  document.addEventListener('visibilitychange', run);
  if (reduce) { jump(0); } else { show(0); run(); }
})();
