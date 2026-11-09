// Sign-in page: the same 5-step showcase as the dashboard's "How it works" (public/hiw-art.js) –
// 1 Policies · 2 HR documents · 3 3rd-party · 4 LEGAL REGISTER · 5 Checklist – with an animated preview of what each
// step produces and a short caption. Plays by itself; pauses when the tab is hidden; a still picture (and the step
// buttons) for people who prefer less motion.
(() => {
  const H = window.HiwArt;
  const track = document.getElementById('hiw-track');
  if (!H || !track) return;
  const { STEPS, ART } = H;
  const $ = id => document.getElementById(id);
  const N = STEPS.length, STEP_MS = 5600;
  const st = { k: -1, t0: performance.now(), playing: true, raf: 0 };
  const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  track.innerHTML = STEPS.map((s, k) => `<li role="presentation"><button type="button" role="tab" class="hiw-node" data-k="${k}" aria-label="Step ${k + 1}: ${esc(s.label)}">
    <span class="hiw-ic"><i class="i-${s.icon}"></i><em>${k + 1}</em></span><span class="hiw-meta"><b>${esc(s.label)}</b></span></button></li>`).join('');
  const nodes = [...track.querySelectorAll('.hiw-node')];

  function show(k) {
    if (k === st.k) return;
    st.k = k;
    nodes.forEach((b, i) => { const on = i === k; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
    $('hiw-step').textContent = `Step ${k + 1} of ${N}`;
    $('la-title').textContent = STEPS[k].title; $('la-sub').textContent = STEPS[k].sub;
    const art = $('hiw-art'); art.innerHTML = ART[k]; art.dataset.k = k;
    const stage = $('hiw-stage'); stage.classList.remove('enter'); void stage.offsetWidth; stage.classList.add('enter');
    $('hiw-fill').style.setProperty('--f', (k / (N - 1)).toFixed(3));
    $('la-ai').classList.toggle('show', k === 3); // the assistant speaks up on the LEGAL REGISTER step
  }
  // A plain timer drives the show (it keeps running even where animation frames are throttled)
  function tick() {
    if (!st.playing || document.hidden) return;
    const el = performance.now() - st.t0, k = Math.floor(el / STEP_MS) % N;
    show(k);
    $('la-bar').style.width = `${(((el % STEP_MS) / STEP_MS) * 100).toFixed(2)}%`;
  }
  setInterval(tick, 80);
  const run = tick;
  const setPlaying = on => {
    st.playing = on;
    document.querySelector('.hiw-login')?.classList.toggle('paused', !on);
    $('la-play').textContent = on ? '❚❚ Pause' : '▶ Play';
    if (on) st.t0 = performance.now() - Math.max(0, st.k) * STEP_MS; else $('la-bar').style.width = '100%';
  };
  // A click on a step shows it at once and the show carries on from there (only Pause stops it)
  const jump = k => { st.k = -1; show(k); st.t0 = performance.now() - k * STEP_MS; };
  nodes.forEach((b, i) => { b.onclick = () => jump(i); });
  track.onkeydown = e => {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    e.preventDefault(); jump((Math.max(0, st.k) + d + N) % N); nodes[st.k].focus();
  };
  $('la-play').onclick = () => setPlaying(!st.playing);
  document.addEventListener('visibilitychange', run);
  // Always plays by itself (with "reduce motion" the steps still change; only the movement inside is kept short)
  show(0); run();
})();
