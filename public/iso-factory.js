// One isometric scene for the whole portal (sign-in page and dashboard): a compliance "factory".
// Four stations stand on glowing pads joined by a moving conveyor belt; documents ride the belt from station to
// station by themselves (SVG animation, no video file):
//   policies – a printer that prints sheets and a stamp that presses down
//   hr       – a desk with a screen and a person, ID cards next to it
//   register – a filing cabinet whose drawer slides, a calendar with a tick
//   doh      – the DoH building sending signal rings
// IsoFactory.create({ stations, labels, nums, pkgId }) → { svg, P, centre(k) } – the caller moves its own package
// (pkgId) with P / centre and lights a station with the classes on / now / done / warn on .iso-isle[data-k].
window.IsoFactory = (() => {
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
  const pad = k => ({ x: k * G, y: -k * G });
  const centre = k => [pad(k).x + T / 2, pad(k).y + T / 2, 12];
  const ellipse = (x, y, z, r, cls) => { const [cx, cy] = P(x, y, z); return `<ellipse class="${cls}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(r * 1.22).toFixed(1)}" ry="${(r * 0.7).toFixed(1)}"/>`; };

  /** The belt between two pads: a raised strip along the diagonal with moving rollers. */
  function belt(k) {
    const a = centre(k), b = centre(k + 1), w = 13, z = 12, h = 6;
    const off = (p, s) => [p[0] + s * w, p[1] + s * w];
    const A1 = off(a, -1), A2 = off(a, 1), B1 = off(b, -1), B2 = off(b, 1);
    const top = [P(...A1, z + h), P(...B1, z + h), P(...B2, z + h), P(...A2, z + h)];
    const side = [P(...A2, z), P(...B2, z), P(...B2, z + h), P(...A2, z + h)];
    const mid = [P(a[0], a[1], z + h + .5), P(b[0], b[1], z + h + .5)];
    return `<g class="belt"><polygon class="belt-side" points="${pts(side)}"/><polygon class="belt-top" points="${pts(top)}"/>` +
      `<line class="belt-run" x1="${mid[0][0].toFixed(1)}" y1="${mid[0][1].toFixed(1)}" x2="${mid[1][0].toFixed(1)}" y2="${mid[1][1].toFixed(1)}"/></g>`;
  }

  /** What stands on each pad. */
  const STATION = {
    policies: (x, y) => {
      let s = box(x + 26, y + 34, 12, 70, 52, 34, 'mach') + box(x + 30, y + 38, 46, 62, 44, 6, 'mach-top');
      s += box(x + 34, y + 28, 22, 54, 8, 6, 'tray');
      // a sheet printing out of the front, again and again
      s += `<g class="print-sheet">${box(x + 40, y + 20, 26, 42, 18, 2, 'sheet')}</g>`;
      s += `<g class="stamp-press">${box(x + 92, y + 86, 46, 16, 16, 18, 'stamp')}${box(x + 97, y + 91, 64, 6, 6, 16, 'stamp-h')}</g>`;
      s += box(x + 88, y + 82, 12, 24, 24, 3, 'sheet');
      return s;
    },
    hr: (x, y) => {
      let s = box(x + 30, y + 30, 12, 70, 44, 26, 'desk') + box(x + 46, y + 40, 38, 36, 4, 28, 'screen') + box(x + 58, y + 44, 38, 12, 8, 4, 'desk');
      // a person: body + head
      s += box(x + 52, y + 88, 12, 18, 14, 30, 'person');
      const head = P(x + 61, y + 95, 52);
      s += `<circle class="person-head" cx="${head[0].toFixed(1)}" cy="${head[1].toFixed(1)}" r="8"/>`;
      // ID cards
      s += box(x + 92, y + 40, 12, 4, 26, 34, 'idcard') + box(x + 100, y + 56, 12, 4, 26, 34, 'idcard alt');
      return s;
    },
    register: (x, y) => {
      let s = box(x + 24, y + 30, 12, 36, 66, 80, 'cabinet');
      for (const z of [22, 46, 70]) s += box(x + 60, y + 38, z, 3, 50, 16, 'drawer');
      s += `<g class="drawer-slide">${box(x + 60, y + 38, 22, 16, 50, 16, 'drawer open')}</g>`;
      s += box(x + 80, y + 80, 12, 32, 32, 30, 'calendar') + box(x + 80, y + 80, 42, 32, 32, 7, 'calendar-top');
      const t = P(x + 96, y + 96, 26);
      s += `<path class="cal-tick" d="M${(t[0] - 7).toFixed(1)} ${(t[1]).toFixed(1)} l5 5 l9 -10"/>`;
      return s;
    },
    doh: (x, y) => {
      let s = box(x + 22, y + 22, 12, 86, 86, 8, 'plinth');
      for (const c of [30, 52, 74, 96]) s += box(x + c, y + 98, 20, 8, 8, 40, 'column');
      s += box(x + 30, y + 30, 20, 74, 66, 40, 'hall') + box(x + 18, y + 18, 60, 94, 94, 8, 'eave');
      const apex = P(x + 65, y + 65, 98);
      s += `<polygon class="roof-l" points="${pts([P(x + 18, y + 112, 68), P(x + 112, y + 112, 68), apex])}"/><polygon class="roof-r" points="${pts([P(x + 112, y + 18, 68), P(x + 112, y + 112, 68), apex])}"/>`;
      s += `<line class="mast" x1="${apex[0].toFixed(1)}" y1="${apex[1].toFixed(1)}" x2="${apex[0].toFixed(1)}" y2="${(apex[1] - 22).toFixed(1)}"/>`;
      s += `<g class="signal">${[0, 1, 2].map(i => `<circle cx="${apex[0].toFixed(1)}" cy="${(apex[1] - 22).toFixed(1)}" r="10" style="animation-delay:${i * 0.6}s"/>`).join('')}</g>`;
      return s;
    },
  };

  function create({ stations = ['policies', 'hr', 'register', 'doh'], labels = ['Policies', 'HR forms', 'Register', 'DoH'], nums = ['1', '2', '3', '↻'], pkgId = 'iso-pkg', gradId = 'isoGlow' } = {}) {
    const n = stations.length;
    let s = '';
    // pads with a soft glow ring
    for (let k = 0; k < n; k++) { const { x, y } = pad(k); s += `<g class="pad-under">${ellipse(x + T / 2, y + T / 2, 0, 96, 'pad-glow')}</g>`; }
    for (let k = 0; k < n - 1; k++) s += belt(k);
    // the belt route, for the documents that ride it
    const route = Array.from({ length: n }, (_, k) => P(...centre(k).slice(0, 2), 19));
    s += `<path id="${pkgId}-route" class="route" d="M${route.map(p => p.map(v => v.toFixed(1)).join(' ')).join(' L')}"/>`;
    for (let k = 0; k < n; k++) {
      const { x, y } = pad(k);
      s += `<g class="iso-isle station-${stations[k]}" data-k="${k}">${box(x, y, 0, T, T, 12, 'slab')}${box(x + 6, y + 6, 12, T - 12, T - 12, 1, 'slab-inset')}`;
      s += STATION[stations[k]](x, y);
      const [bx, by] = P(...centre(k).slice(0, 2), stations[k] === 'doh' ? 150 : stations[k] === 'register' ? 120 : 108);
      s += `<g class="iso-badge" transform="translate(${bx.toFixed(1)},${by.toFixed(1)})"><rect x="-58" y="-15" width="116" height="30" rx="15"/><text class="b-num" x="-40" y="5">${nums[k]}</text><text class="b-txt" x="-26" y="5">${labels[k]}</text></g>`;
      s += '</g>';
    }
    // documents riding the belt (independent of the caller's package)
    for (let i = 0; i < 4; i++) {
      s += `<g class="rider"><g transform="translate(${-O.x},${-O.y})">${box(-8, -6, 0, 16, 12, 2, 'sheet')}</g><animateMotion dur="9s" repeatCount="indefinite" begin="-${(i * 2.25).toFixed(2)}s" rotate="0"><mpath href="#${pkgId}-route"/></animateMotion></g>`;
    }
    s += `<g class="iso-pkg" id="${pkgId}">${box(-9, -9, 0, 18, 18, 18, 'pkg')}</g>`;
    const svg = `<svg viewBox="12 156 1122 238" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="How the Compliance Portal works">
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f766e"/><stop offset=".55" stop-color="#14b8a6"/><stop offset="1" stop-color="#5eead4"/></linearGradient>
      <radialGradient id="${gradId}-pad"><stop offset="0" stop-color="#14b8a6" stop-opacity=".45"/><stop offset="1" stop-color="#14b8a6" stop-opacity="0"/></radialGradient></defs>
      <g class="iso-world iso-factory">${s}</g></svg>`;
    return { svg, P, centre, pts, box };
  }

  /** The box around the stations (pads, machines, badges) – riders and the package are left out. */
  function bounds(svg) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    svg.querySelectorAll('.iso-isle').forEach(g => { const b = g.getBBox(); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); });
    return x1 > x0 ? { x: x0 - 12, y: y0 - 14, w: x1 - x0 + 24, h: y1 - y0 + 28 } : null;
  }
  const cam = new WeakMap();
  /** Fit the frame to the drawing. On a narrow screen the camera shows about two stations and pans (smoothly) to
   *  station k, so the scene stays big enough to read on a phone. */
  function fit(svg, k) {
    let b;
    try { b = bounds(svg); } catch { return; }
    if (!b) return;
    const st = cam.get(svg) || { k: 0 };
    if (k != null) st.k = k;
    cam.set(svg, st);
    const narrow = svg.parentElement && svg.parentElement.clientWidth < 640;
    let to;
    if (!narrow) to = [b.x, b.y, b.w, b.h];
    else {
      const w = Math.min(b.w, 470), cx = P(...centre(st.k).slice(0, 2))[0];
      to = [Math.max(b.x, Math.min(b.x + b.w - w, cx - w / 2)), b.y, w, b.h];
    }
    const cur = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
    cancelAnimationFrame(st.raf);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (cur.length !== 4 || cur.some(isNaN) || reduce || !narrow || Math.abs(cur[2] - to[2]) > 1) { svg.setAttribute('viewBox', to.map(v => v.toFixed(1)).join(' ')); return; }
    const t0 = performance.now(), from = cur;
    const step = now => {
      const f = Math.min(1, (now - t0) / 700), e = 1 - (1 - f) ** 3;
      svg.setAttribute('viewBox', from.map((v, i) => (v + (to[i] - v) * e).toFixed(1)).join(' '));
      if (f < 1) st.raf = requestAnimationFrame(step);
    };
    st.raf = requestAnimationFrame(step);
  }
  /** Keep the frame right when the screen size changes. */
  function watch(svg) {
    let t = 0;
    const again = () => { clearTimeout(t); t = setTimeout(() => fit(svg), 120); };
    if ('ResizeObserver' in window && svg.parentElement) new ResizeObserver(again).observe(svg.parentElement);
    else window.addEventListener('resize', again);
  }
  return { create, fit, watch };
})();
