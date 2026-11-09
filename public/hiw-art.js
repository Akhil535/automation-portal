// The 5 portal steps and their animated preview pictures – shared by the dashboard ("How it works") and the
// sign-in page, so both always show the same thing. Plain data + inline SVG; coloured and animated by style.css.
window.HiwArt = (() => {
  const STEPS = [
    { label: 'Policies', icon: 'doc', tab: 'policies', title: 'Prepare the ADHICS policies',
      sub: 'Every ADHICS policy is created as Word and PDF – with your logo, signature, stamp and facility details already filled in.',
      points: ['Your logo, signature & stamp on every page', 'Policy ID, issue and review dates set for you', 'Download as Word, PDF or one ZIP'] },
    { label: 'HR documents', icon: 'user', tab: 'hr', title: 'HR & training documents',
      sub: 'NDA, orientation, exit clearance, training report and policy acknowledgement – branded for your facility.',
      points: ['Each document gets its own Ref. No.', 'One training date fills every form', 'Ready to print and sign'] },
    { label: '3rd-party', icon: 'handshake', tab: 'thirdparty', title: '3rd-party & vendor documents',
      sub: 'Forms your vendors and service providers sign – NDA and acceptable-usage acknowledgement with your branding.',
      points: ['Same logo and layout as your policies', 'Vendor Ref. No. on every form', 'Word + PDF in one click'] },
    { label: 'LEGAL REGISTER', icon: 'book', tab: 'master', title: 'Your LEGAL REGISTER',
      sub: 'Every licence, certificate, contract and law in one register – with issue, expiry and due dates tracked for you.',
      points: ['Upload a document – its dates are read for you', 'Expiring items stand out early', 'Linked to your policies'] },
    { label: 'Checklist', icon: 'target', tab: 'checklist', title: 'The compliance checklist',
      sub: 'One overview of everything: each ADHICS document marked Completed, Pending or Not applicable, with remarks.',
      points: ['See your readiness at a glance', 'Track every section to 100 %', 'Master checklist as one Excel workbook'] },
  ];
  // The preview pictures (inline SVG, coloured by the theme; animated with CSS)
  const lines = (x, y, n, w = 120, gap = 11) => Array.from({ length: n }, (_, i) => `<rect class="ln" x="${x}" y="${y + i * gap}" width="${i % 3 === 2 ? w * 0.6 : w}" height="5" rx="2.5"/>`).join('');
  const doc = (x, y, cls = '', inner = '') => `<g class="hd ${cls}" transform="translate(${x} ${y})"><rect class="paper" width="150" height="190" rx="12"/>${inner}</g>`;
  const head = (w = 78) => `<rect class="logo" x="14" y="14" width="32" height="21" rx="5"/><rect class="ttl" x="54" y="18" width="${w}" height="7" rx="3.5"/>`;
  const stamp = (x, y) => `<g class="stamp" transform="translate(${x} ${y})"><circle r="17"/><circle r="11"/></g>`;
  const sig = y => `<path class="sig" d="M16 ${y} q10 -18 18 -2 t18 -4 t16 2"/>`;
  const chip = (x, y, w, t, c) => `<g class="chip ${c}" transform="translate(${x} ${y})"><rect width="${w}" height="26" rx="13"/><text x="${w / 2}" y="17">${t}</text></g>`;
  const ART = [
    // 1 · policies: a fanned stack, the front page with logo, title, text, signature and stamp
    `<svg viewBox="0 0 340 240">${doc(66, 42, 'back b2')}${doc(83, 31, 'back b1')}${doc(100, 20, 'front', `${head()}<rect class="ln" x="54" y="30" width="50" height="5" rx="2.5"/>${lines(14, 52, 7)}${sig(168)}${stamp(116, 160)}`)}
      ${chip(244, 54, 76, 'Word', 'c1')}${chip(244, 88, 76, 'PDF', 'c2')}</svg>`,
    // 2 · HR: an onboarding form with a person, filled fields and ticks
    `<svg viewBox="0 0 340 240">${doc(95, 22, 'front', `${head(84)}
      <circle class="face" cx="36" cy="66" r="15"/><rect class="ln" x="60" y="58" width="74" height="5" rx="2.5"/><rect class="ln" x="60" y="70" width="52" height="5" rx="2.5"/>
      ${[0, 1, 2].map(i => `<g class="row r${i}" transform="translate(14 ${98 + i * 24})"><rect class="box" width="14" height="14" rx="4"/><path class="tick" d="M3 7 l3 3 l6 -6"/><rect class="ln" x="22" y="4" width="${96 - i * 14}" height="6" rx="3"/></g>`).join('')}${sig(178)}`)}
      ${chip(238, 40, 92, 'HR-FORM-01', 'c1')}${chip(14, 150, 70, 'Signed', 'c2')}</svg>`,
    // 3 · 3rd-party: two branded agreements joined, with a seal
    `<svg viewBox="0 0 340 240">${doc(36, 34, 'front', `${head()}${lines(14, 50, 8)}${sig(174)}`)}${doc(154, 24, 'front f2', `${head()}${lines(14, 50, 8)}${stamp(116, 164)}`)}
      <g class="link-ring" transform="translate(170 128)"><circle r="20"/><path d="M-8 0 h16 M-3 -6 l-6 6 l6 6 M3 -6 l6 6 l-6 6"/></g>
      ${chip(10, 6, 92, 'TP-FORM-01', 'c1')}</svg>`,
    // 4 · register: a table with dated rows and status pills
    `<svg viewBox="0 0 340 240"><g class="hd front" transform="translate(30 22)"><rect class="paper" width="280" height="196" rx="14"/>
      <rect class="ttl" x="18" y="18" width="120" height="8" rx="4"/><rect class="logo" x="230" y="13" width="34" height="19" rx="5"/>
      ${[['ok', 'Valid'], ['ok', 'Valid'], ['warn', 'Expiring'], ['bad', 'Expired'], ['ok', 'Valid']].map(([c, t], i) => `<g class="row r${i}" transform="translate(18 ${46 + i * 29})"><rect class="cell" width="244" height="23" rx="7"/><rect class="ln" x="10" y="9" width="${88 - (i % 2) * 18}" height="5" rx="2.5"/><rect class="ln dim" x="112" y="9" width="44" height="5" rx="2.5"/><g class="pill ${c}" transform="translate(176 4)"><rect width="60" height="15" rx="7.5"/><text x="30" y="11">${t}</text></g></g>`).join('')}
      </g></svg>`,
    // 5 · checklist: items ticked one after the other and the readiness ring filling up
    `<svg viewBox="0 0 340 240"><g class="hd front" transform="translate(22 26)"><rect class="paper" width="190" height="188" rx="14"/>
      <rect class="ttl" x="16" y="18" width="96" height="8" rx="4"/>
      ${[0, 1, 2, 3, 4].map(i => `<g class="row r${i}" transform="translate(16 ${44 + i * 28})"><rect class="box" width="16" height="16" rx="5"/><path class="tick" d="M4 8 l3 3 l6 -6"/><rect class="ln" x="26" y="5" width="${120 - (i % 3) * 22}" height="6" rx="3"/></g>`).join('')}
      </g><g class="ring" transform="translate(272 118)"><circle class="trk" r="40"/><circle class="val" r="40" pathLength="100"/><text y="7">100%</text></g></svg>`,
  ];
  return { STEPS, ART };
})();
