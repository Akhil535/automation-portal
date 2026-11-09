// Professional flat illustrations that stand in for the master presentation's stick-figure cartoons in looks 2-4.
// Each scene tells the same story as the cartoon it replaces and keeps any words the cartoon carries ("GIMME YER
// PASSWORDS!!!", "Phone Book"), so no content is lost. Original artwork, drawn in the look's colours (1366 × 768).

const SKIN = ['#F1C27D', '#C68A5E', '#E0AC69', '#8D5524'];
const FONT = `font-family="Segoe UI, Arial, sans-serif"`;

/** A standing person, feet at (x, y). pose: down | hold | phone | type; hood: an attacker in a hoodie. */
function person(x, y, { s = 1, shirt, pants = '#334155', skin = SKIN[0], hair = '#2B2B2B', pose = 'down', hood = false, flip = false } = {}) {
  const arm = (d, col = shirt) => `<path d="${d}" fill="none" stroke="${col}" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>`;
  const hand = (cx, cy) => `<circle cx="${cx}" cy="${cy}" r="14" fill="${skin}"/>`;
  const arms = {
    down: arm('M-60 -268 L-74 -168') + arm('M60 -268 L74 -168') + hand(-75, -160) + hand(75, -160),
    hold: arm('M-60 -268 L-62 -205 L-22 -200') + arm('M60 -268 L62 -205 L22 -200') + hand(-18, -200) + hand(18, -200),
    phone: arm('M-60 -268 L-74 -168') + hand(-75, -160) + arm('M60 -268 L74 -310 L40 -338') + hand(36, -340),
    type: arm('M-60 -268 L-50 -190 L-5 -185') + arm('M60 -268 L50 -190 L5 -185') + hand(0, -185) + hand(14, -183),
  }[pose];
  const head = hood
    ? `<path d="M-58 -318 Q-60 -405 0 -408 Q60 -405 58 -318 Q40 -290 0 -290 Q-40 -290 -58 -318 Z" fill="${shirt}"/><ellipse cx="0" cy="-334" rx="34" ry="38" fill="#0F172A"/><circle cx="-12" cy="-338" r="4.5" fill="#F87171"/><circle cx="12" cy="-338" r="4.5" fill="#F87171"/>`
    : `<rect x="-13" y="-305" width="26" height="24" fill="${skin}"/><circle cx="0" cy="-338" r="40" fill="${skin}"/><path d="M-41 -340 Q-44 -386 0 -388 Q44 -386 41 -340 Q30 -366 0 -364 Q-24 -364 -41 -340 Z" fill="${hair}"/>`;
  return `<g transform="translate(${x} ${y}) scale(${flip ? -s : s} ${s})">
    <rect x="-44" y="-150" width="38" height="150" rx="17" fill="${pants}"/><rect x="6" y="-150" width="38" height="150" rx="17" fill="${pants}"/>
    <ellipse cx="-28" cy="-2" rx="30" ry="12" fill="#1E293B"/><ellipse cx="28" cy="-2" rx="30" ry="12" fill="#1E293B"/>
    <path d="M-70 -138 Q-74 -292 0 -294 Q74 -292 70 -138 Z" fill="${shirt}"/>${head}${arms}</g>`;
}
/** A person seen behind a table (upper body only), base of the torso at (x, y). */
function seated(x, y, o = {}) { return `<g clip-path="url(#upper)">${person(x, y + 140, o)}</g>`; }
function laptop(x, y, w, c, { glow = false, lines = true } = {}) {
  const h = w * 0.62;
  return `<g transform="translate(${x} ${y})">${glow ? `<rect x="${-w / 2 - 14}" y="${-h - 14}" width="${w + 28}" height="${h + 28}" rx="18" fill="${c.L}" opacity=".18"/>` : ''}
    <rect x="${-w / 2}" y="${-h}" width="${w}" height="${h}" rx="9" fill="#1E293B"/><rect x="${-w / 2 + 8}" y="${-h + 8}" width="${w - 16}" height="${h - 18}" rx="4" fill="${c.screen}"/>
    ${lines ? [0, 1, 2].map(i => `<rect x="${-w / 2 + 22}" y="${-h + 26 + i * 18}" width="${(w - 44) * [0.8, 0.55, 0.68][i]}" height="7" rx="3.5" fill="${c.L}" opacity=".75"/>`).join('') : ''}
    <path d="M${-w / 2 - 16} 0 L${w / 2 + 16} 0 L${w / 2 + 6} 12 L${-w / 2 - 6} 12 Z" fill="#475569"/></g>`;
}
const badge = (x, y, r, fill, inner) => `<g transform="translate(${x} ${y})"><circle r="${r + 8}" fill="${fill}" opacity=".18"/><circle r="${r}" fill="${fill}"/>${inner}</g>`;
const warn = (x, y, s, col) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M0 -46 L44 32 L-44 32 Z" fill="${col}" stroke="${col}" stroke-width="10" stroke-linejoin="round"/><rect x="-5" y="-18" width="10" height="30" rx="5" fill="#fff"/><circle cy="22" r="6" fill="#fff"/></g>`;
const lock = (x, y, s, col, open = false) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-22 -8 V-30 a22 22 0 0 1 44 0 ${open ? 'V-38' : 'V-8'}" fill="none" stroke="${col}" stroke-width="9" stroke-linecap="round"/><rect x="-34" y="-10" width="68" height="52" rx="10" fill="${col}"/><circle cy="12" r="7" fill="#fff"/><rect x="-3" y="12" width="6" height="16" rx="3" fill="#fff"/></g>`;
const bubble = (x, y, w, h, fill, tailX, tailY, content) => `<g><path d="M${x + 24} ${y} H${x + w - 24} Q${x + w} ${y} ${x + w} ${y + 24} V${y + h - 24} Q${x + w} ${y + h} ${x + w - 24} ${y + h} H${tailX + 34} L${tailX} ${tailY} L${tailX + 4} ${y + h} H${x + 24} Q${x} ${y + h} ${x} ${y + h - 24} V${y + 24} Q${x} ${y} ${x + 24} ${y} Z" fill="${fill}"/>${content}</g>`;
const waves = (x, y, col, n = 3, dir = 1) => Array.from({ length: n }, (_, i) => `<path d="M${x} ${y - 22 - i * 22} Q${x + dir * (30 + i * 22)} ${y} ${x} ${y + 22 + i * 22}" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round" opacity="${1 - i * 0.25}"/>`).join('');
function backdrop(c) {
  const dots = [];
  for (let gx = 40; gx < 1366; gx += 56) for (let gy = 40; gy < 768; gy += 56) dots.push(`<circle cx="${gx}" cy="${gy}" r="2.2"/>`);
  return `<rect width="1366" height="768" fill="${c.panel}"/><g fill="${c.S}" opacity=".9">${dots.join('')}</g>
    <circle cx="1180" cy="120" r="230" fill="${c.S}" opacity=".45"/><circle cx="150" cy="690" r="190" fill="${c.S}" opacity=".4"/>
    <rect x="0" y="668" width="1366" height="100" fill="${c.S}" opacity=".55"/>`;
}

export const SCENES = {
  // "Who can attack ?!!" – an attacker at a laptop reaching out to the organisation through e-mail, malware and the web
  attacker: c => `${backdrop(c)}
    ${person(420, 690, { shirt: '#1F2937', pants: '#111827', pose: 'type', hood: true, s: 1.05 })}${laptop(430, 520, 230, c, { glow: true })}
    <g stroke="${c.L}" stroke-width="6" stroke-dasharray="4 16" stroke-linecap="round" fill="none" opacity=".8"><path d="M560 380 Q760 160 980 210"/><path d="M570 420 Q780 400 980 400"/><path d="M560 460 Q760 650 980 590"/></g>
    ${badge(1040, 200, 58, c.A, `<rect x="-30" y="-20" width="60" height="40" rx="6" fill="#fff"/><path d="M-30 -18 L0 4 L30 -18" fill="none" stroke="${c.A}" stroke-width="6" stroke-linejoin="round"/>`)}
    ${badge(1040, 400, 58, c.L, `<ellipse rx="18" ry="24" cy="6" fill="#fff"/><circle cy="-22" r="12" fill="#fff"/><path d="M-18 0 H-34 M18 0 H34 M-16 18 L-30 30 M16 18 L30 30 M-16 -10 L-30 -22 M16 -10 L30 -22" stroke="#fff" stroke-width="6" stroke-linecap="round"/>`)}
    ${badge(1040, 600, 58, c.A, `<circle r="28" fill="none" stroke="#fff" stroke-width="6"/><path d="M-28 0 H28 M0 -28 Q18 0 0 28 M0 -28 Q-18 0 0 28" fill="none" stroke="#fff" stroke-width="5"/>`)}
    ${warn(220, 200, 1.1, c.A)}`,
  // User disclosure – a colleague says a password out loud; someone overhears it
  disclosure: c => `${backdrop(c)}
    ${person(480, 690, { shirt: c.L, pose: 'down', skin: SKIN[0] })}${person(860, 690, { shirt: c.A, pose: 'down', skin: SKIN[1], hair: '#3B2A20', flip: true })}
    ${bubble(250, 90, 420, 150, '#FFFFFF', 470, 300, [0, 1, 2, 3, 4, 5].map(i => `<circle cx="${335 + i * 50}" cy="165" r="15" fill="${c.I2}"/>`).join(''))}
    ${lock(1120, 240, 1.6, c.A, true)}${warn(250, 470, 1.15, '#F59E0B')}`,
  // Social engineering – a caller on a headset pressing a victim for passwords (the cartoon's words kept)
  gimme: c => `${backdrop(c)}
    ${person(380, 690, { shirt: '#1F2937', pants: '#111827', pose: 'phone', hood: true })}
    ${person(1000, 690, { shirt: c.L, pose: 'hold', skin: SKIN[2], flip: true })}
    <g transform="translate(1000 515)"><rect x="-26" y="-44" width="52" height="88" rx="10" fill="#1E293B"/><rect x="-20" y="-36" width="40" height="66" rx="4" fill="${c.screen}"/></g>
    ${bubble(80, 70, 620, 170, '#FFFFFF', 400, 300, `<text x="390" y="140" ${FONT} font-size="54" font-weight="800" text-anchor="middle" fill="#B91C1C">GIMME YER</text><text x="390" y="205" ${FONT} font-size="54" font-weight="800" text-anchor="middle" fill="#B91C1C">PASSWORDS!!!</text>`)}
    <g stroke="${c.L}" stroke-width="7" fill="none" stroke-linecap="round" opacity=".85">${waves(500, 330, c.L, 3, 1)}</g>
    ${warn(1000, 180, 1.2, '#F59E0B')}`,
  // Wireless sniffing – a router serving a user's laptop while an attacker captures the radio traffic
  wifi: c => `${backdrop(c)}
    <g transform="translate(683 250)"><rect x="-90" y="-30" width="180" height="60" rx="16" fill="${c.L}"/><rect x="-60" y="-80" width="10" height="56" rx="5" fill="${c.L}"/><rect x="50" y="-80" width="10" height="56" rx="5" fill="${c.L}"/>${[-50, -20, 10, 40].map(dx => `<circle cx="${dx}" cy="0" r="7" fill="#fff"/>`).join('')}</g>
    <g stroke="${c.L}" stroke-width="7" fill="none" stroke-linecap="round" opacity=".7">${[70, 120, 170].map(r => `<path d="M${683 - r} ${250 - r * 0.25} A${r} ${r} 0 0 1 ${683 + r} ${250 - r * 0.25}"/>`).join('')}</g>
    ${person(300, 690, { shirt: c.L, pose: 'type', skin: SKIN[0] })}${laptop(310, 515, 200, c)}
    ${person(1080, 690, { shirt: '#1F2937', pants: '#111827', pose: 'type', hood: true, flip: true })}${laptop(1070, 515, 200, c, { glow: true })}
    <g fill="${c.A}">${[[470, 330], [560, 290], [800, 290], [890, 330]].map(([x, y]) => `<rect x="${x - 26}" y="${y - 16}" width="52" height="32" rx="7"/>`).join('')}</g>
    <path d="M760 330 Q900 420 990 380" fill="none" stroke="${c.A}" stroke-width="7" stroke-dasharray="6 14" stroke-linecap="round"/>
    <g transform="translate(1180 160)"><circle r="48" fill="none" stroke="${c.A}" stroke-width="12"/><path d="M34 34 L74 74" stroke="${c.A}" stroke-width="16" stroke-linecap="round"/></g>`,
  // Dictionary attacks – an attacker reading candidate passwords from a phone book (the book's title kept)
  phonebook: c => `${backdrop(c)}
    ${person(560, 690, { shirt: '#1F2937', pants: '#111827', pose: 'hold', hood: true, s: 1.05 })}
    <g transform="translate(560 470)"><path d="M0 -10 L-150 -40 L-150 110 L0 140 Z" fill="#FBBF24"/><path d="M0 -10 L150 -40 L150 110 L0 140 Z" fill="#F59E0B"/><path d="M0 -10 V140" stroke="#B45309" stroke-width="6"/>
      <text x="75" y="35" ${FONT} font-size="34" font-weight="800" text-anchor="middle" fill="#1F2937" transform="rotate(-11 75 35)">Phone</text><text x="75" y="76" ${FONT} font-size="34" font-weight="800" text-anchor="middle" fill="#1F2937" transform="rotate(-11 75 76)">Book</text>
      ${[0, 1, 2, 3].map(i => `<rect x="-130" y="${-10 + i * 28}" width="${[100, 80, 110, 70][i]}" height="9" rx="4.5" fill="#92400E" opacity=".55" transform="rotate(11 -130 ${-10 + i * 28})"/>`).join('')}</g>
    <g transform="translate(1000 330)"><rect x="-190" y="-60" width="380" height="120" rx="22" fill="#FFFFFF"/><text x="-150" y="22" ${FONT} font-size="62" font-weight="700" fill="${c.I2}" letter-spacing="8">●●●●●●</text></g>
    ${lock(1000, 520, 1.5, c.A, true)}
    <g stroke="${c.L}" stroke-width="7" stroke-dasharray="4 14" stroke-linecap="round" fill="none"><path d="M720 420 Q780 330 800 330"/></g>
    ${[0, 1, 2].map(i => `<g transform="translate(${1210} ${470 + i * 70})"><circle r="24" fill="${i < 2 ? '#EF4444' : '#22C55E'}"/>${i < 2 ? '<path d="M-9 -9 L9 9 M9 -9 L-9 9" stroke="#fff" stroke-width="6" stroke-linecap="round"/>' : '<path d="M-10 0 L-3 8 L11 -8" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>'}</g>`).join('')}`,
  // Eavesdropping – two colleagues talking at a table while a stranger at the next table listens and watches
  eavesdrop: c => `${backdrop(c)}<defs><clipPath id="upper"><rect x="0" y="0" width="1366" height="560"/></clipPath></defs>
    ${seated(330, 560, { shirt: c.L, pose: 'type', skin: SKIN[0] })}${seated(640, 560, { shirt: c.A, pose: 'type', skin: SKIN[3], hair: '#111', flip: true })}
    ${seated(1060, 560, { shirt: '#1F2937', pants: '#111827', pose: 'down', hood: true, flip: true })}
    <rect x="200" y="540" width="580" height="26" rx="10" fill="#8B5E3C"/><rect x="230" y="566" width="22" height="120" fill="#6B4528"/><rect x="728" y="566" width="22" height="120" fill="#6B4528"/>
    <rect x="930" y="540" width="300" height="26" rx="10" fill="#8B5E3C"/><rect x="960" y="566" width="22" height="120" fill="#6B4528"/><rect x="1178" y="566" width="22" height="120" fill="#6B4528"/>
    ${laptop(400, 540, 170, c)}${laptop(570, 540, 170, c)}<g transform="translate(1110 540)"><path d="M-22 0 L-18 -48 H18 L22 0 Z" fill="#E5E7EB"/><path d="M20 -38 Q44 -34 20 -16" fill="none" stroke="#E5E7EB" stroke-width="7"/></g>
    <g stroke="${c.A}" stroke-width="8" fill="none" stroke-linecap="round">${waves(910, 250, c.A, 3, -1)}</g>
    <g transform="translate(860 120)"><path d="M-70 0 Q0 -60 70 0 Q0 60 -70 0 Z" fill="#FFFFFF"/><circle r="26" fill="${c.A}"/><circle r="11" fill="#0F172A"/></g>`,
};

/** The stick-figure cartoons of the master presentation (by the SHA-256 of their picture) and the scene for each. */
export const CARTOONS = {
  '1d8f3fbd410519f9': 'attacker', // slide 4 – who can attack
  '2aff024dadcf8230': 'disclosure', // slide 6 – user disclosure
  '65b7647432cf6cda': 'gimme', // slide 7 – social engineering
  'cab421bb1866806b': 'wifi', // slide 9 – wireless sniffing
  'ffd022dcf4eff095': 'phonebook', // slide 11 – dictionary attacks
  '9728092f8d22025d': 'eavesdrop', // slide 16 – eavesdropping
  '38b15dbbbd65f21b': 'wifi', // slide 16 – sniffing on the wireless network
};

/** A scene's SVG at a picture's own pixel size (the 16:9 drawing is centred). */
export function sceneSvg(name, colors, w, h) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1366 768" preserveAspectRatio="xMidYMid slice">${SCENES[name](colors)}</svg>`;
}
