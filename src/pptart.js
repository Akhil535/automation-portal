// Security illustrations for the Cyber Security presentation's alternative looks: one vector illustration per topic
// (password, e-mail, malware, layers of defence, internet use, privacy, assets, reporting, backup, people …), drawn
// here in each look's colours and turned into PNG tiles with the PC's Edge / Chrome (headless, nothing leaves the
// PC). The tiles are cached on disk. Original artwork – no third-party images.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { dir, loadGlobalConfig } from './config.js';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = () => BROWSERS.find(p => fs.existsSync(p));

/** The look of the tiles: background, panel, line and accent colours. */
export const ART_THEMES = {
  dark: { bg: '#0B1220', panel: '#16223A', line: '#22D3EE', soft: '#1E3A5F', accent: '#A78BFA', ink: '#E6F0FF' },
  minimal: { bg: '#FFFFFF', panel: '#F3F5FA', line: null, soft: '#DCE3F2', accent: '#94A3B8', ink: '#1F2937' }, // line: the brand accent
  official: { bg: '#FFFFFF', panel: '#EEF2F8', line: null, soft: '#D6DFEE', accent: '#C00000', ink: '#1F2937' },
};

// Each icon: SVG in a 64 × 64 box, drawn with the theme's colours (L line, A accent, S soft, I ink)
const ICONS = {
  password: c => `<rect x="14" y="28" width="36" height="24" rx="5" fill="${c.S}"/><path d="M22 28v-7a10 10 0 0 1 20 0v7" fill="none" stroke="${c.L}" stroke-width="4" stroke-linecap="round"/><g fill="${c.L}"><circle cx="24" cy="40" r="2.6"/><circle cx="32" cy="40" r="2.6"/><circle cx="40" cy="40" r="2.6"/></g>`,
  email: c => `<rect x="10" y="18" width="44" height="30" rx="5" fill="${c.S}"/><path d="M12 21l20 15 20-15" fill="none" stroke="${c.L}" stroke-width="3.5" stroke-linejoin="round"/><circle cx="50" cy="18" r="8" fill="${c.A}"/><path d="M50 14v5M50 21.5v.5" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>`,
  malware: c => `<ellipse cx="32" cy="36" rx="12" ry="15" fill="${c.S}"/><circle cx="32" cy="20" r="7" fill="${c.L}"/><path d="M32 23v28M20 30l-8-4M44 30l8-4M20 38h-9M44 38h9M21 46l-7 5M43 46l7 5" stroke="${c.L}" stroke-width="3.2" stroke-linecap="round"/><circle cx="29" cy="19" r="1.4" fill="${c.bg}"/><circle cx="35" cy="19" r="1.4" fill="${c.bg}"/>`,
  layers: c => `<path d="M32 8l18 7v13c0 13-8 21-18 26-10-5-18-13-18-26V15z" fill="${c.S}"/><path d="M32 16l11 4v8c0 8-5 13-11 16-6-3-11-8-11-16v-8z" fill="none" stroke="${c.L}" stroke-width="3.2"/><path d="M26 31l4 4 8-9" fill="none" stroke="${c.A}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  internet: c => `<circle cx="32" cy="32" r="20" fill="${c.S}"/><circle cx="32" cy="32" r="20" fill="none" stroke="${c.L}" stroke-width="3"/><path d="M12 32h40M32 12c7 8 7 32 0 40M32 12c-7 8-7 32 0 40" fill="none" stroke="${c.L}" stroke-width="2.6"/><circle cx="48" cy="48" r="8" fill="${c.A}"/><path d="M45 48l2.2 2.2 4-4.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`,
  privacy: c => `<rect x="16" y="28" width="32" height="24" rx="5" fill="${c.L}"/><path d="M22 28v-6a10 10 0 0 1 20 0v6" fill="none" stroke="${c.L}" stroke-width="4"/><circle cx="32" cy="38" r="3.4" fill="${c.bg}"/><path d="M32 41v5" stroke="${c.bg}" stroke-width="3" stroke-linecap="round"/>`,
  assets: c => `<path d="M10 20h16l4 5h24v25a3 3 0 0 1-3 3H13a3 3 0 0 1-3-3z" fill="${c.S}"/><path d="M10 26h44" stroke="${c.L}" stroke-width="3"/><rect x="34" y="34" width="16" height="10" rx="2" fill="${c.L}"/><circle cx="38" cy="39" r="1.6" fill="${c.bg}"/><path d="M41 39h6" stroke="${c.bg}" stroke-width="2"/>`,
  reporting: c => `<path d="M32 10a14 14 0 0 1 14 14v10l5 7H13l5-7V24a14 14 0 0 1 14-14z" fill="${c.S}"/><path d="M32 10a14 14 0 0 1 14 14v10l5 7H13l5-7V24a14 14 0 0 1 14-14z" fill="none" stroke="${c.L}" stroke-width="3"/><path d="M27 45a5 5 0 0 0 10 0" fill="none" stroke="${c.L}" stroke-width="3"/><path d="M32 20v9M32 33v.5" stroke="${c.A}" stroke-width="3.6" stroke-linecap="round"/>`,
  backup: c => `<path d="M20 44a10 10 0 0 1-1-20 13 13 0 0 1 25-3 10 10 0 0 1 2 23z" fill="${c.S}"/><path d="M20 44a10 10 0 0 1-1-20 13 13 0 0 1 25-3 10 10 0 0 1 2 23z" fill="none" stroke="${c.L}" stroke-width="3"/><path d="M32 30v16M26 40l6 6 6-6" fill="none" stroke="${c.A}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  people: c => `<circle cx="24" cy="24" r="7" fill="${c.L}"/><circle cx="42" cy="26" r="6" fill="${c.S}"/><path d="M12 48a12 12 0 0 1 24 0z" fill="${c.L}"/><path d="M33 48a10 10 0 0 1 20 0z" fill="${c.S}"/>`,
  attack: c => `<circle cx="32" cy="32" r="20" fill="${c.S}"/><circle cx="32" cy="32" r="13" fill="none" stroke="${c.L}" stroke-width="3"/><circle cx="32" cy="32" r="5" fill="${c.A}"/><path d="M32 6v10M32 48v10M6 32h10M48 32h10" stroke="${c.L}" stroke-width="3" stroke-linecap="round"/>`,
  device: c => `<rect x="12" y="14" width="40" height="26" rx="3" fill="${c.S}"/><rect x="12" y="14" width="40" height="26" rx="3" fill="none" stroke="${c.L}" stroke-width="3"/><path d="M8 46h48" stroke="${c.L}" stroke-width="3.6" stroke-linecap="round"/><path d="M32 20l7 3v5c0 5-3 7-7 9-4-2-7-4-7-9v-5z" fill="${c.A}"/>`,
  policy: c => `<path d="M18 10h20l10 10v32a2 2 0 0 1-2 2H18a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2z" fill="${c.S}"/><path d="M38 10v10h10" fill="none" stroke="${c.L}" stroke-width="3"/><path d="M22 28h18M22 35h18M22 42h11" stroke="${c.L}" stroke-width="3" stroke-linecap="round"/><circle cx="44" cy="46" r="7" fill="${c.A}"/><path d="M41 46l2 2 4-4" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`,
  question: c => `<circle cx="32" cy="32" r="20" fill="${c.S}"/><path d="M25 26a7 7 0 1 1 10 6c-2 1-3 2.5-3 5" fill="none" stroke="${c.L}" stroke-width="4" stroke-linecap="round"/><circle cx="32" cy="44" r="2.6" fill="${c.L}"/>`,
};
/** The topic of a slide from its text (the first matching rule wins). */
const TOPICS = [
  [/question|comment|practical training/i, 'question'],
  [/password|passphrase|credential/i, 'password'],
  [/e-?mail|phishing|spam|attachment/i, 'email'],
  [/layers? of defen[cs]e|defen[cs]e against|anti-?virus|firewall/i, 'layers'],
  [/malware|virus|worm|trojan|ransomware|spyware/i, 'malware'],
  [/backup|back up|restore/i, 'backup'],
  [/report(ing)?\s.*(event|incident)|incident/i, 'reporting'],
  [/asset|classification|handling/i, 'assets'],
  [/privacy|confidential|personal data|patient data/i, 'privacy'],
  [/internet|website|browse|download|social media|acceptable use|unacceptable use/i, 'internet'],
  [/who can attack|attacker|hacker|threat actor|social engineering/i, 'attack'],
  [/responsibilit|employee|staff|user awareness|training/i, 'people'],
  [/device|laptop|mobile|usb|workstation|screen lock|update/i, 'device'],
  [/policy|policies|procedure|control/i, 'policy'],
];
export const topicOf = text => TOPICS.find(([re]) => re.test(text))?.[1] || 'layers';

const artDir = () => { const d = path.join(path.resolve(dir(loadGlobalConfig(), 'data')), 'toolkit', 'art'); fs.mkdirSync(d, { recursive: true }); return d; };
function tileSvg(name, theme, accent) {
  const t = ART_THEMES[theme], c = { L: t.line || accent, A: t.accent, S: t.soft, I: t.ink, bg: t.panel };
  // the tile fills the whole picture (no transparent corners needed): the panel, a fine rim, the icon
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 80 80"><rect width="80" height="80" fill="${t.bg}"/><rect x="2" y="2" width="76" height="76" rx="14" fill="${t.panel}"/><rect x="2" y="2" width="76" height="76" rx="14" fill="none" stroke="${c.L}" stroke-opacity=".45" stroke-width="1.2"/><g transform="translate(8 8)">${ICONS[name](c)}</g></svg>`;
}
/** PNG tiles (320 × 320) for the topics, for a look; cached by their drawing. */
export async function artTiles(theme, accent, names = Object.keys(ICONS)) {
  const out = {}, exe = browser();
  for (const name of names) {
    const svg = tileSvg(name, theme, accent);
    const file = path.join(artDir(), `${name}-${crypto.createHash('sha256').update(svg).digest('hex').slice(0, 16)}.png`);
    if (!fs.existsSync(file)) {
      if (!exe) continue; // no browser on this PC: the look is made without the illustrations
      const html = file.replace(/\.png$/, '.html');
      fs.writeFileSync(html, `<!doctype html><html><body style="margin:0;overflow:hidden">${svg}</body></html>`);
      await new Promise(resolve => execFile(exe, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=320,320', `--screenshot=${file}`, `file:///${html.replace(/\\/g, '/')}`],
        { timeout: 60000, windowsHide: true }, () => resolve()));
      fs.rmSync(html, { force: true });
    }
    if (fs.existsSync(file)) out[name] = fs.readFileSync(file);
  }
  return out;
}
