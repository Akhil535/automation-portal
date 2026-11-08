// Sign-in page: the animated isometric "compliance factory" (public/iso-factory.js) – four stations on a moving
// conveyor belt: 1 Policies · 2 HR & vendor forms · 3 LEGAL REGISTER · DoH updates. Documents ride the belt, a
// glowing package hops to the active station, a caption explains each step, and an AI assistant bubble answers on
// the way. Pauses when hidden; a still picture for people who prefer less motion.
(() => {
  const stage = document.getElementById('la-stage');
  if (!stage || !window.IsoFactory) return;
  const F = IsoFactory.create({ labels: ['Policies', 'HR forms', 'Register', 'DoH'], pkgId: 'la-pkg', gradId: 'laGlow' });
  stage.innerHTML = F.svg;
  const svg = stage.querySelector('svg');
  const fit = () => IsoFactory.fit(svg, Math.max(0, st.k));
  requestAnimationFrame(fit); setTimeout(fit, 400); window.addEventListener('load', fit); IsoFactory.watch(svg);

  const STEPS = [
    { tag: 'Step 1 · Policies', title: 'Your 33 ADHICS policies – printed for you', sub: 'Add your logo, signature and stamp once. Every policy is filled with your facility’s name, dates and Policy IDs, as Word and PDF.' },
    { tag: 'Step 2 · HR & vendor forms', title: 'HR, training and 3rd-party forms in seconds', sub: 'NDA, orientation, background checks, exit clearance, training records, vendor NDAs – each with your logo and its own Ref. No.' },
    { tag: 'Step 3 · LEGAL REGISTER', title: 'Every licence and certificate, always in date', sub: 'Upload a document or a photo – the dates are read for you. Renewals are flagged before anything lapses.' },
    { tag: 'Always on · DoH updates', title: 'New DoH circulars added every week', sub: 'The portal checks the Department of Health, adds each new circular to your register and tells you what applies to you.' },
  ];
  const $ = id => document.getElementById(id);
  const dots = [...document.querySelectorAll('#la-dots button')];
  const STEP_MS = 4200, MOVE_MS = 900;
  const st = { k: -1, t0: performance.now(), playing: true, raf: 0 };
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const lerp = (a, b, f) => a.map((v, i) => v + (b[i] - v) * f);
  const ease = f => (f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2);
  function place(k, f) {
    const from = F.centre(k === 0 ? 3 : k - 1), to = F.centre(k);
    const g = lerp(from, to, ease(Math.min(1, f)));
    const hop = f < 1 ? Math.sin(Math.PI * Math.min(1, f)) * (k === 0 ? 70 : 42) : 0;
    const [sx, sy] = F.P(g[0], g[1], g[2] + 8 + hop), [ox, oy] = F.P(0, 0, 0);
    $('la-pkg')?.setAttribute('transform', `translate(${(sx - ox).toFixed(1)},${(sy - oy).toFixed(1)})`);
  }
  function show(k) {
    if (k === st.k) return;
    st.k = k;
    IsoFactory.fit(svg, k);
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
  const paused = on => stage.classList.toggle('paused', on);
  function jump(k) { st.playing = false; paused(true); cancelAnimationFrame(st.raf); st.raf = 0; show(k); place(k, 1); $('la-bar').style.width = `${((k + 1) / 4) * 100}%`; $('la-play').textContent = '▶ Play'; st.t0 = performance.now() - k * STEP_MS - MOVE_MS; }
  dots.forEach((b, i) => { b.onclick = () => jump(i); });
  $('la-play').onclick = () => {
    st.playing = !st.playing; paused(!st.playing);
    $('la-play').textContent = st.playing ? '❚❚ Pause' : '▶ Play';
    if (st.playing) { st.t0 = performance.now() - Math.max(0, st.k) * STEP_MS - MOVE_MS; run(); }
  };
  document.addEventListener('visibilitychange', run);
  if (reduce) { jump(0); } else { show(0); run(); }
})();
