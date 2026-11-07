// Facility document recognition: what kind of document is this (DOH licence, trade licence, ICA establishment card,
// Malaffi certificate, MCC certificate, waste / pest-control contract, JAWDA, ADHICS ...), which Legal Register entry
// does it belong to, and what are its issue and expiry dates. Works on the document's content, not its file name.
//
// Text comes from the PDF / Word text layer; scanned pages (no text layer) are read with the offline OCR engine built
// into Windows (scripts/ocr.ps1). Nothing is sent to an external service.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDocument, kindOf } from './docparse.js';
import { parseAnyDate } from './policy.js';
import { isLifetime } from './master.js';

const OCR_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ocr.ps1');

// ---------------------------------------------------------------------------------------------------
// Document types -> register entries
// ---------------------------------------------------------------------------------------------------
// strong: phrases that identify the document; weak: supporting words. entry: matches the register entry name.
export const DOC_TYPES = [
  { id: 'doh', label: 'DOH facility licence', entry: /DEPARTMENT OF HEALTH|\bDOH\b/i,
    strong: [/licen[cs]e for (center|centre|facility)/i, /health ?facility ?licen[cs]e/i, /tamm-doh/i, /department of health.{0,40}licensed/i], weak: [/department of health/i, /license no/i, /region/i] },
  { id: 'added', label: 'Trade licence (Department of Economic Development / ADDED)', entry: /ECONOMIC|ADDED|TRADE LICEN/i,
    strong: [/unified (registration|licen[cs]e) no/i, /adra\.gov\.ae/i, /economic development/i, /licen[cs]e activities/i, /\btrade licen[cs]e\b/i, /commercial licen[cs]e/i], weak: [/licen[cs]e type/i, /legal form/i, /partner/i] },
  { id: 'ica', label: 'ICA establishment card', entry: /\bICA\b|IDENTITY|CITIZENSHIP|ICP/i,
    strong: [/federal authority for\s*\|?\s*identity/i, /identity\s*&\s*citizenship/i, /establishment card/i, /\bICP\b/, /منشأة بطاقة/], weak: [/residence and foreign/i, /united arab of emirates/i] },
  { id: 'malaffi', label: 'Malaffi certificate', entry: /MALAF+I/i,
    strong: [/malaffi/i, /\bADHDS\b/i, /health information exchange/i, /certificate of connection/i], weak: [/abu dhabi health data/i] },
  { id: 'mcc', label: 'MCC compliance certificate', entry: /MONITORING AND CONTROL|\bMCC\b/i,
    strong: [/monitoring and control cent/i, /surveillance (devices|systems)/i, /supreme council for na.?tional security/i, /\bMCC ID\b/i], weak: [/compliance certificate/i] },
  { id: 'waste', label: 'Waste management contract', entry: /WASTE/i,
    strong: [/waste management/i, /hazardous waste/i, /medical waste/i, /waste treatment/i], weak: [/collection, transportation/i, /disposal/i] },
  { id: 'pest', label: 'Pest control contract', entry: /PEST|TADWEER/i,
    strong: [/pest control/i, /\bpest scope\b/i, /tadweer/i], weak: [/cockroach/i, /rodent/i, /premises/i] },
  { id: 'jawda', label: 'JAWDA Data Certification', entry: /JAWDA/i,
    strong: [/jawda data certification/i, /\bJDC\b/], weak: [/tasneef/i, /jawda/i] },
  { id: 'adhics', label: 'ADHICS certificate', entry: /ADHICS|CYBER SECURITY/i,
    strong: [/\bADHICS\b/i, /healthcare information and cyber security standard/i], weak: [/cyber ?security/i, /audit/i] },
];

function classify(text) {
  const scores = DOC_TYPES.map(t => ({
    t,
    score: t.strong.reduce((s, re) => s + (re.test(text) ? 5 : 0), 0) + t.weak.reduce((s, re) => s + (re.test(text) ? 1 : 0), 0),
    hits: t.strong.filter(re => re.test(text)).map(re => (text.match(re) || [''])[0]),
  })).sort((a, b) => b.score - a.score);
  const [best, next] = scores;
  if (!best || best.score < 5) return { type: null, confidence: 'none', scores };
  const confidence = best.score >= 10 && best.score - (next?.score || 0) >= 5 ? 'high' : best.score - (next?.score || 0) >= 3 ? 'medium' : 'low';
  return { type: best.t, confidence, hits: best.hits, scores };
}

// ---------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------
const DATE_SRC = [
  '\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b',
  '\\b\\d{1,2}\\s*[/.-]\\s*\\d{1,2}\\s*[/.-]\\s*\\d{2,4}\\b',
  '\\b\\d{1,2}(?:st|nd|rd|th)?(?:\\s+of)?[\\s-]+[A-Za-z]{3,9}\\.?,?[\\s-]+\\d{2,4}\\b',
  '\\b[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b',
].join('|');
const datesIn = s => [...String(s).matchAll(new RegExp(DATE_SRC, 'g'))]
  .map(m => parseAnyDate(m[0].replace(/\s*([/.-])\s*/g, '$1').replace(/(\d)(st|nd|rd|th)?\s+of\s+/i, '$1 ')))
  .filter(Boolean);

// A label must be followed by ':' or a table-cell break, so prose ("from 1st of January 2017") is not taken as a label.
// A label is followed by ':' or a table-cell break, or stands alone on its line (OCR often drops the colon).
const ISSUE_LABEL = /(date of issue|issue date|issuance date|issued (?:on|date)|compliance date|start date|from date|contract start|commencement date|certificate issued date|valid from)\s*(?:[:：|]|$)/i;
const EXPIRY_LABEL = /(date of expiry|expiry date|expiration date|end date|to date|contract end|valid (?:until|till|to))\s*(?:[:：|]|$)/i;
// Other dated labels that stand alone in an OCR label block ("Effective Date"): they take a value too, keeping the
// label -> value pairing aligned, but the value is not used.
const OTHER_LABEL = /^\s*(effective date|date of birth|establishment date|renewal date|audit date|inspection date)\s*[:：|]?\s*$/i;
// Bare "From :" / "To :" (contract periods) count only when a date follows directly - "To: Abu Dhabi, ..." is an address.
const BARE_FROM = new RegExp(`^\\s*from\\s*[:：|][\\s:：|]*(?=${DATE_SRC})`, 'i');
const BARE_TO = new RegExp(`^\\s*to\\s*[:：|][\\s:：|]*(?=${DATE_SRC})`, 'i');
const IGNORE_LABEL = /(establishment date|date of birth|incorporation)\s*[:：|]/i;

/**
 * Issue / expiry dates. Labels with their date on the same line are taken first; labels without a date on their line
 * (OCR often puts the labels and values in separate blocks) are queued, and the unlabelled dates that follow are given
 * to the queued labels in the same order. Fallback: the first date in the document is the issue date.
 */
function findDates(lines) {
  let issued = null, expiry = null;
  const queue = [], free = [], evidence = {};
  lines.forEach(line => {
    if (OTHER_LABEL.test(line)) { queue.push('other'); return; }
    if (IGNORE_LABEL.test(line)) return;
    const iL = line.match(ISSUE_LABEL) || line.match(BARE_FROM), eL = line.match(EXPIRY_LABEL) || line.match(BARE_TO);
    const after = (m) => datesIn(line.slice(m.index + m[0].length))[0];
    if (iL || eL) {
      if (iL) { const d = after(iL); if (d) { if (!issued) { issued = d; evidence.issued = line; } } else queue.push('issued'); }
      if (eL) { const d = after(eL); if (d) { if (!expiry) { expiry = d; evidence.expiry = line; } } else queue.push('expiry'); }
      return;
    }
    for (const d of datesIn(line)) free.push({ d, line });
  });
  // Each queued label takes the next value in order (even when it was already found inline, so the pairing stays aligned).
  for (const k of queue) {
    const next = free.shift();
    if (!next) break;
    if (k === 'issued' && !issued) { issued = next.d; evidence.issued = `${next.line} (value of a label above)`; }
    if (k === 'expiry' && !expiry) { expiry = next.d; evidence.expiry = `${next.line} (value of a label above)`; }
  }
  if (!issued) {
    const first = lines.map(l => ({ l, d: datesIn(l)[0] })).find(x => x.d);
    if (first) { issued = first.d; evidence.issued = `${first.l} (first date in the document)`; }
  }
  if (issued && expiry && expiry < issued) [issued, expiry] = [expiry, issued];
  return { issued, expiry, evidence };
}

const plusDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------
// OCR for scanned pages
// ---------------------------------------------------------------------------------------------------
/** OCR a PNG image or a whole PDF (pages rendered by Windows, so text inside pictures is read too). */
export function ocrImage(data, ext = 'png') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrp-ocr-'));
  const file = path.join(dir, `page.${ext}`);
  fs.writeFileSync(file, data);
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OCR_SCRIPT, file],
      { timeout: 120000, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, out, stderr) => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (err) return reject(new Error(`OCR failed: ${(stderr || err.message).split('\n')[0]}`));
        resolve(out.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
      });
  });
}

const latinChars = s => (String(s).match(/[A-Za-z0-9]/g) || []).length;

/**
 * Text lines of a document. The text layer is read first; a PDF whose text layer is thin (a scan, or a certificate
 * whose headings are pictures) is also OCR'd page by page. Returns { lines, textLines, ocrLines, ocr, kind }.
 * force: OCR a PDF even when it has a text layer (used when the text layer alone does not identify the document).
 */
export async function documentLines(buffer, name, { force = false } = {}) {
  // A photo or scan saved as a picture: the whole picture is read with OCR.
  const pic = kindOf(name, buffer);
  if (pic === 'jpg' || pic === 'png') {
    const ocrLines = await ocrImage(buffer, pic);
    return { lines: ocrLines, textLines: [], ocrLines, ocr: true, kind: pic };
  }
  const doc = await readDocument(buffer, name);
  const textLines = doc.rows.map(r => r.join(' | '));
  let ocrLines = [];
  if (doc.kind === 'pdf' && (force || latinChars(textLines.join(' ')) < 400)) {
    try { ocrLines = await ocrImage(buffer, 'pdf'); }
    catch {
      // Page rendering unavailable: fall back to OCR of the large pictures inside the PDF.
      for (const p of (doc.allImages || []).filter(i => i.width >= 800 && i.height >= 800).slice(0, 3)) {
        try { ocrLines = ocrLines.concat(await ocrImage(p.buffer)); } catch { /* OCR unavailable */ }
      }
    }
  }
  return { lines: textLines.concat(ocrLines), textLines, ocrLines, ocr: ocrLines.length > 0, kind: doc.kind };
}

/** Dates from the text layer first; anything missing is taken from the OCR text (kept apart so pairing stays aligned). */
function datesFrom(textLines, ocrLines) {
  const a = findDates(textLines), b = ocrLines.length ? findDates(ocrLines) : { evidence: {} };
  const firstOnly = e => /first date in the document/.test(e || '');
  const pick = k => (a[k] && !(firstOnly(a.evidence[k]) && b[k] && !firstOnly(b.evidence[k]))) ? [a[k], a.evidence[k]] : b[k] ? [b[k], `${b.evidence[k]} (OCR)`] : [a[k], a.evidence[k]];
  const [issued, ei] = pick('issued'), [expiry, ee] = pick('expiry');
  const out = { issued, expiry, evidence: {} };
  if (ei) out.evidence.issued = ei;
  if (ee) out.evidence.expiry = ee;
  if (out.issued && out.expiry && out.expiry < out.issued) [out.issued, out.expiry] = [out.expiry, out.issued];
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------
const key = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const NAME_STOP = new Set(['LLC', 'L', 'C', 'SOLE', 'PROPRIETORSHIP', 'THE', 'AND', 'OF', 'CENTER', 'CENTRE', 'MEDICAL', 'HEALTH', 'HEALTHCARE', 'PRIMARY', 'CARE', 'CLINIC', 'PHARMACY', 'OPC', 'HOME']);

/**
 * Recognise one facility document.
 * entries: the facility's register entries ([{ row, name, fixed }]); facilityName: for the "other facility?" check.
 * Returns { type, typeLabel, confidence, row, entryName, issued, expiry, due, evidence, ocr, warnings, documentDate }.
 */
export async function recognizeDocument(buffer, name, { entries = [], facilityName = '' } = {}) {
  let doc = await documentLines(buffer, name);
  let c = classify(doc.lines.join('\n'));
  // Not identified from the text layer alone (headings drawn as pictures): read the whole pages with OCR and retry.
  if (doc.kind === 'pdf' && !doc.ocr && (!c.type || c.confidence === 'low')) {
    doc = await documentLines(buffer, name, { force: true });
    c = classify(doc.lines.join('\n'));
  }
  const { ocr, kind } = doc;
  const text = doc.lines.join('\n');
  const warnings = [];
  if (!latinChars(text)) warnings.push('No readable text found (the scan may be too faint) - enter the dates manually');
  let { issued, expiry, evidence } = datesFrom(doc.textLines, doc.ocrLines);
  let row = null, entryName = null;
  if (c.type) {
    const e = entries.find(x => !x.fixed && c.type.entry.test(x.name));
    if (e) { row = e.row; entryName = e.name; } else warnings.push(`No "${c.type.label}" entry in this register - choose the entry or add one first`);
  } else warnings.push('Document type not recognised - choose the register entry');
  // Malaffi is a one-time (lifetime) connection certificate: no expiry and no due date, and no warning about it.
  const lifetime = c.type?.id === 'malaffi' || (entryName && isLifetime(entryName));
  if (lifetime) { expiry = null; delete evidence.expiry; }
  else if (!expiry) warnings.push('No expiry date found in the document');
  // Does the document name this facility?
  // The facility's name must appear: its distinctive words, or (for generic names such as "City Health Medical Center")
  // its first two words as a phrase.
  const all = key(facilityName).split(' ').filter(Boolean);
  const words = all.filter(w => w.length > 2 && !NAME_STOP.has(w));
  const T = ` ${key(text)} `;
  const named = words.length ? words.some(w => T.includes(` ${w} `)) : all.length >= 2 ? T.includes(` ${all.slice(0, 2).join(' ')} `) : true;
  if (facilityName && !named) warnings.push(`This document may belong to another facility (it does not mention "${facilityName}")`);
  return {
    file: name, kind, ocr, type: c.type?.id || null, typeLabel: c.type?.label || 'Not recognised', confidence: c.confidence,
    row, entryName, issued: issued || '', expiry: expiry || '', due: expiry ? plusDays(expiry, 1) : '',
    evidence, warnings, documentDate: issued || null, lifetime: !!lifetime,
  };
}

export { classify, findDates };
