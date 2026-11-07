// Facility details from a facility document - a policy or a legal register - in PDF, Word .docx or .doc form.
//
// Facility documents share a document-control table, for example:
//   Policy ID / Document Number | IHHC / ADHICS - PO01        -> facility code  "IHHC"
//   Prepared by / Document Author(s) | Mr. Ashraf Said        -> Document Author(s)
//   Approved by / Document Approver | Mr. Hamdan Almazrouei   -> Document Approver
//   Facility Name               | ISHRAQ HOME HEALTH CARE     -> facility name and title
// A legal register document also lists its entries (department / certification / contract, issued, expiry
// and due dates, responsible person, compliance); those are matched to the facility's register entries.
// The logo is the largest picture in the page header (Word) or on page 1 (PDF).
import { readDocument } from './docparse.js';
import { cleanLogo, pickLogo } from './logoclean.js';

export { imageSize } from './imagesize.js';

// label patterns -> field
const LABELS = [
  ['name', /^(facility|centre|center|branch|clinic|pharmacy|group|entity|company|organi[sz]ation|establishment|hospital)\s*(name)?$|^name of (the )?(facility|centre|center|entity|establishment|organi[sz]ation)$/i],
  ['approver', /^(document\s+)?approv(ed|er)(\s+by)?$|^approval$/i],
  ['authors', /^(document\s+)?(prepared|authored|written)(\s+by)?$|^(document\s+)?author(s|\(s\))?$/i],
  ['responsible', /^responsible(\s+person)?$|^(policy\s+)?owner$|^facility\s+manager$/i],
  ['policyId', /^(policy|document)\s*(id|no\.?|number|ref(erence)?)$/i],
  ['issuedOn', /^issued\s+on$|^(date\s+of\s+)?(issue|release)(\s+date)?$/i],
  ['version', /^version(\s+no\.?)?$/i],
  ['classification', /^(document\s+)?classification$/i],
];
const norm = s => String(s || '').replace(/[:：]\s*$/, '').replace(/\s+/g, ' ').trim();
const fieldFor = label => LABELS.find(([, re]) => re.test(norm(label)))?.[0];
// "Approved by Mr. X" on one PDF line (no column gap): label at the start of the text
const PREFIX = /^(policy id|document number|prepared by|approved by|document approver|document author\(s\)|document authors?|facility name|group name|entity name|responsible person)\s*[:：]?\s+(.+)$/i;

// ---------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const ymd = (y, m, d) => {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d && y > 1950 && y < 2100 ? dt.toISOString().slice(0, 10) : null;
};
const DATE_RE = new RegExp([
  '\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b',                                   // 2026-09-14
  '\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b',                         // 14/09/2026 (UAE: day first)
  '\\b\\d{1,2}(?:st|nd|rd|th)?[\\s-]+[A-Za-z]{3,9}\\.?,?[\\s-]+\\d{2,4}\\b', // 14 September 2026, 14-Sep-26
  '\\b[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b',     // September 14, 2026
].join('|'), 'g');

/** Parse one date string (day-first for numeric dates, as used in the UAE). Returns YYYY-MM-DD or null. */
export function parseAnyDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return ymd(+m[1], +m[2] - 1, +m[3]);
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    let [d, mo] = [+m[1], +m[2]];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d]; // clearly month-first (e.g. 9/14/2026)
    return ymd(+m[3], mo - 1, d);
  }
  m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{2,4})$/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) return ymd(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) return ymd(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  return null;
}

/** Date-or-blank slots in order of appearance ("______", "-", "N/A" count as a blank slot). */
function dateSlots(text) {
  const out = [];
  const re = new RegExp(`${DATE_RE.source}|_{2,}|(?<![\\w-])(?:-{1,}|n\\/a|nil)(?![\\w-])`, 'gi');
  for (const m of String(text).matchAll(re)) {
    const d = parseAnyDate(m[0]);
    if (d) out.push(d);
    else if (/^(_{2,}|-+|n\/a|nil)$/i.test(m[0])) out.push('');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Register entries
// ---------------------------------------------------------------------------------------------------
const key = s => String(s || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim();
const tokens = s => new Set(key(s).split(' ').filter(w => w.length > 1 && !['THE', 'OF', 'AND', 'FOR'].includes(w)));
function nameScore(text, name) {
  const t = key(text), n = key(name);
  if (!n) return 0;
  if (t.includes(n)) return 1;
  const a = tokens(text), b = tokens(name);
  if (!b.size) return 0;
  let hit = 0; for (const w of b) if (a.has(w)) hit++;
  return hit / b.size;
}

function extractEntries(rows, names) {
  if (!names?.length) return [];
  const found = new Map();
  let cols = null;
  for (const r of rows) {
    const up = r.join(' | ').toUpperCase();
    if (/ISSUED/.test(up) && /EXPIRY/.test(up)) {               // table header row -> column positions
      cols = {};
      r.forEach((c, i) => {
        const u = c.toUpperCase();
        if (/NAME|DEPARTMENT|DESCRIPTION/.test(u)) cols.name = i;
        else if (/ISSUE/.test(u)) cols.issued = i;
        else if (/EXPIR/.test(u)) cols.expiry = i;
        else if (/DUE|RENEW/.test(u)) cols.due = i;
        else if (/RESPONSIB/.test(u)) cols.responsible = i;
        else if (/COMPLIAN|STATUS/.test(u)) cols.compliance = i;
      });
      continue;
    }
    let best = null, score = 0;
    for (const n of names) { const s = nameScore(r.slice(0, 3).join(' '), n); if (s > score) { score = s; best = n; } }
    if (!best || score < 0.75 || found.has(best)) continue;
    const e = { name: best, matchedText: r.join(' | ') };
    if (cols && r.length >= 4 && cols.issued !== undefined) {
      for (const k of ['issued', 'expiry', 'due']) if (cols[k] !== undefined) {
        const v = r[cols[k]] ?? '';
        e[k] = parseAnyDate(v) ?? (/^(_{2,}|-+|n\/a|nil)?$/i.test(v.trim()) ? '' : undefined);
      }
      if (cols.responsible !== undefined && r[cols.responsible]) e.responsible = r[cols.responsible];
      if (cols.compliance !== undefined && r[cols.compliance]) e.compliance = r[cols.compliance];
    } else {
      const rest = r.join(' ');
      const slots = dateSlots(rest.slice(Math.max(0, key(rest).indexOf(key(best)))));
      ['issued', 'expiry', 'due'].forEach((k, i) => { if (slots[i] !== undefined) e[k] = slots[i]; });
      const person = rest.match(/\b(?:Dr|Mr|Ms|Mrs|Eng)\.?\s+[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4}/);
      if (person) e.responsible = person[0].trim();
    }
    const comp = (e.compliance || r.join(' ')).match(/fully\s*compl\w*|not\s*applicable|\bN\/?A\b/i)?.[0];
    e.compliance = comp ? (/^n/i.test(comp) ? 'Not Applicable' : 'Fully Compliant') : undefined;
    found.set(best, e);
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------------------------------
// Facility document -> fields, entries, logo
// ---------------------------------------------------------------------------------------------------
/**
 * Parse a facility document (PDF, .docx or .doc).
 * options.entryNames: the facility's register entry names, to pick up their dates from a legal register document.
 * Returns { kind, fields, found, policyTitle, warnings, logo, entries, header }.
 */
export async function parseFacilityDocument(buffer, name = '', { entryNames = [] } = {}) {
  if (!buffer?.length) throw new Error('No file received');
  const doc = await readDocument(buffer, name);
  const found = {};
  let policyTitle = '';
  for (const r of doc.rows) {
    if (r.length >= 2) {
      const f = fieldFor(r[0]);
      if (f && !found[f] && norm(r[1])) { found[f] = norm(r[1]); continue; }
    }
    const text = r.join(' ');
    if (!policyTitle && r.length === 1 && /polic|procedure|register|standard/i.test(text) && text.length < 120 && !/[.:]$/.test(text)) policyTitle = text;
    const colon = text.match(/^([A-Za-z ()./]{3,40})\s*[:：]\s*(.{2,120})$/);
    const f1 = colon && fieldFor(colon[1]);
    if (f1 && !found[f1]) { found[f1] = norm(colon[2]); continue; }
    const pre = text.match(PREFIX);
    const f2 = pre && fieldFor(pre[1]);
    if (f2 && !found[f2]) found[f2] = norm(pre[2]);
  }
  // Header of a legal register document: "<FACILITY> - LEGAL REGISTER"
  if (!found.name) {
    const t = doc.rows.map(r => r.join(' ')).find(s => /^(.{3,80}?)\s*[-–]\s*LEGAL REGISTER$/i.test(s));
    if (t) found.name = t.replace(/\s*[-–]\s*LEGAL REGISTER$/i, '').trim();
  }

  // Facility named only in the text ("... undertaken by HEALTHY OUTFIT MEDICAL CENTER"): the most frequent
  // upper-case name that ends like a healthcare facility.
  if (!found.name) {
    const FAC = /\b([A-Z][A-Z0-9&'.\- ]{1,60}?\b(?:MEDICAL CENT(?:ER|RE)|POLYCLINIC|CLINIC|PHARMACY|HOSPITAL|HOME HEALTH ?CARE|HEALTH ?CARE(?: CENT(?:ER|RE))?|DIAGNOSTIC CENT(?:ER|RE)|DENTAL CENT(?:ER|RE)|DAY SURGERY CENT(?:ER|RE)|LABORATORY|REHABILITATION CENT(?:ER|RE))(?:\s*[-–]?\s*(?:L\.?L\.?C|O\.?P\.?C)\.?)*)(?![A-Za-z])/g;
    const seen = new Map();
    for (const r of doc.rows) for (const m of r.join(' ').matchAll(FAC)) {
      const n = m[1].replace(/\s+/g, ' ').replace(/^(?:THE|OF|FOR|BY|AT|AND|ALL|TO|IN)\s+/, '').trim();
      if (n.split(' ').length < 2 || /\b(POLICY|PROCEDURES?|ADHICS|DOH|DEPARTMENT)\b/.test(n)) continue;
      seen.set(n, (seen.get(n) || 0) + 1);
    }
    const best = [...seen].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0];
    if (best) found.name = best[0];
  }

  const warnings = [];
  const fields = {};
  if (found.name) { fields.name = found.name; fields.title = `${found.name.toUpperCase()} - LEGAL REGISTER`; }
  else warnings.push('Facility name not found');
  if (found.policyId) {
    const code = found.policyId.split('/')[0].trim().replace(/[^A-Za-z0-9 .&-]/g, '').slice(0, 20).trim();
    if (code) fields.code = code;
  }
  if (!fields.code && found.name) fields.code = found.name.split(/\s+/).filter(w => /^[A-Za-z]/.test(w) && !/^(LLC|OPC|L\.?L\.?C)$/i.test(w)).map(w => w[0]).join('').toUpperCase().slice(0, 8);
  if (!fields.code) warnings.push('Facility code not found');
  if (found.approver) fields.approver = found.approver; else warnings.push('Approver not found');
  if (found.authors) fields.authors = found.authors; else warnings.push('Author not found');
  fields.responsible = found.responsible || found.approver || '';
  if (!found.responsible && found.approver) warnings.push('No "Responsible person" entry - the approver is used');
  if (!fields.responsible) warnings.push('Responsible person not found');

  // The logo: the most logo-like picture, cropped to its content with the plain background removed.
  const logo = await cleanLogo(pickLogo([...(doc.images || []), ...((doc.images || []).length ? [] : doc.allImages || [])]));
  if (!logo) warnings.push(doc.kind === 'pdf' ? 'No logo picture found on page 1' : 'No logo found in the page header');
  const entries = extractEntries(doc.rows, entryNames);
  const releaseRaw = found.issuedOn && parseAnyDate(found.issuedOn);
  return { kind: doc.kind, fields, found, policyTitle, warnings, logo, entries, documentDate: releaseRaw || null };
}

/** Backwards-compatible name used by earlier code. */
export const parsePolicyDocx = (buffer, opts) => parseFacilityDocument(buffer, 'policy.docx', opts);
