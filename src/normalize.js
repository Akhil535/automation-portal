// Text/number/date normalisation and duplicate detection against the register.
//
// A website circular is "already registered" when:
//  1. its document link is in the register AND the number digits or the title agree
//     (the register has a link pasted onto two rows, so a link alone is not enough);
//  2. the normalised number matches and the title is similar (US-06-2019 == US/6/2019);
//  3. the number digits match (US/ vs USO/ prefix typo), the title is near-identical and
//     the dates are within 5 days.
// Same number + different title => "conflict" (held for manual check; DoH has reused numbers).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function cleanText(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/<[^>]+>/g, ' ')
    .replace(/ /g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

function fold(s) {
  return cleanText(s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—‑]/g, '-')
    .normalize('NFKD').toLowerCase();
}

export function normNumber(n) {
  let s = fold(n).toUpperCase().replace(/\\/g, '/').replace(/[()[\]]/g, '').replace(/[\s\-_.]+/g, '/');
  s = s.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  const parts = s ? s.split('/').map(p => (/^\d+$/.test(p) ? String(parseInt(p, 10)) : p)) : [];
  if (parts.length && /^\d{2}$/.test(parts.at(-1))) parts[parts.length - 1] = '20' + parts.at(-1);
  return parts.join('/');
}

export const numberDigits = n => (normNumber(n).match(/\d+/g) || []).map(Number).join('/');

export function numberYear(n) {
  const m = normNumber(n).match(/(?:^|\/)((?:19|20)\d{2})$/);
  return m ? Number(m[1]) : null;
}

const STOP = new Set(['the', 'of', 'and', 'for', 'to', 'in', 'on', 'a', 'an', 'by', 'with', 'at', 'from']);
export const nameTokens = s => (fold(s).match(/[a-z0-9]+/g) || []).filter(t => !STOP.has(t));

function seqRatio(a, b) {
  // Similarity based on longest common subsequence of characters (like difflib ratio).
  if (!a.length || !b.length) return 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = tmp;
    }
  }
  return (2 * prev[b.length]) / (a.length + b.length);
}

export function nameSimilarity(a, b) {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  const sa = new Set(ta), sb = new Set(tb);
  const inter = [...sa].filter(x => sb.has(x)).length;
  const jacc = inter / new Set([...sa, ...sb]).size;
  const minLen = Math.min(sa.size, sb.size);
  const contain = minLen >= 3 ? (inter / minLen) * 0.95 : 0;
  const seq = Math.max(jacc, contain) >= 0.5 ? seqRatio(ta.join(' '), tb.join(' ')) : 0;
  return Math.max(jacc, contain, seq);
}

export function normUrl(u) {
  if (!u) return '';
  try { return decodeURIComponent(new URL(u, 'https://x').pathname).toLowerCase().replace(/\/$/, ''); }
  catch { return String(u).toLowerCase(); }
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Parse DoH / register date formats into 'YYYY-MM-DD' (or null). */
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
    return null;
  }
  const s = cleanText(v);
  let m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,.-]+(\d{2,4})/); // 14 Sep, 2026 / 14-Sep-26
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) return ymd(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/); // September 14, 2026
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) return ymd(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return ymd(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/); // 14/09/2026 (day first, UAE)
  if (m) return ymd(+m[3], +m[2] - 1, +m[1]);
  m = s.match(/^[A-Za-z]{3},\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/); // RSS pubDate
  if (m) return ymd(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

function ymd(y, mo, d) {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, mo, d));
  if (isNaN(dt) || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

const dayDiff = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

export class RegisterIndex {
  constructor(records) {
    this.byUrl = new Map(); this.byNumber = new Map(); this.byDigits = new Map();
    records.forEach(r => this.add(r));
  }

  add(r) {
    const push = (map, k) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(r); };
    push(this.byUrl, normUrl(r.url));
    push(this.byNumber, normNumber(r.number));
    push(this.byDigits, numberDigits(r.number));
  }

  match(c) {
    const digits = numberDigits(c.number);
    const urlHits = c.url ? this.byUrl.get(normUrl(c.url)) || [] : [];
    for (const r of urlHits) if (numberDigits(r.number) === digits || nameSimilarity(r.name, c.name) >= 0.6) return ['registered', r];
    const same = this.byNumber.get(normNumber(c.number)) || [];
    for (const r of same) if (nameSimilarity(r.name, c.name) >= 0.6) return ['registered', r];
    if (c.date && digits) {
      for (const r of this.byDigits.get(digits) || []) {
        if (r.date && dayDiff(r.date, c.date) <= 5 && nameSimilarity(r.name, c.name) >= 0.92) return ['registered', r];
      }
    }
    if (same.length) return ['conflict', same[0]];
    if (urlHits.length) return ['conflict', urlHits[0]];
    return ['new', null];
  }
}

export const circularKey = c => `${normNumber(c.number)}|${nameTokens(c.name).join(' ').slice(0, 120)}`;
