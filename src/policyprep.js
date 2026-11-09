// Policy Document Preparation: master policy templates (e.g. the 33 ADHICS policies) are filled for a facility -
// Policy ID, dates, prepared / approved by, facility name, logo, version history, signature and stamp - and saved
// as Word and PDF files in the facility folder (Word/ and PDF/). Templates are never modified.
//
// Documents are edited at the XML level (like the Excel register): only the labelled cells, the facility name in
// the text, the logo picture and the signature block change; layout, styles and the RESTRICTED badge stay as they are.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { dir, facilityHome, loadConfig, loadGlobalConfig, updateFacility } from './config.js';
import { docToDocx, kindOf, readDocument } from './docparse.js';
import { imageSize } from './imagesize.js';
import { cleanLogo, isPageScan, pickLogo, resizeImage, splitSignStamp } from './logoclean.js';
import { parseFacilityDocument } from './policy.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PDF_SCRIPT = path.join(APP, 'scripts', 'word-to-pdf.ps1');
/** Policies with a major revision: version 2.0 by default. */
export const MAJOR_REVISION = [3, 18, 19, 25];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------------------------------
// Small XML helpers (WordprocessingML)
// ---------------------------------------------------------------------------------------------------
const dec = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const enc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textOf = xml => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(m => dec(m[1])).join('');
const squash = s => s.replace(/\s+/g, ' ').trim();

/** All elements <tag ...>...</tag> in xml (any depth), as { s, e } ranges; nesting of the same tag is respected. */
function elements(xml, tag) {
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*?(/?)>`, 'g');
  const out = [], stack = [];
  for (let m; (m = re.exec(xml));) {
    if (m[2] === '/') { out.push({ s: m.index, e: re.lastIndex }); continue; } // <tag/>
    if (m[1] !== '/') stack.push(m.index);
    else if (stack.length) out.push({ s: stack.pop(), e: re.lastIndex });
  }
  return out.sort((a, b) => a.s - b.s);
}
const inside = (r, outer) => r.s > outer.s && r.e < outer.e;
/** Direct children <child> of the element range `parent` (not those inside a nested table). */
function children(xml, parent, child) {
  const nested = elements(xml.slice(parent.s, parent.e), 'w:tbl').map(r => ({ s: r.s + parent.s, e: r.e + parent.s })).filter(r => r.s > parent.s);
  return elements(xml, child).filter(r => inside(r, parent) && !nested.some(n => inside(r, n)));
}

/** Tables -> rows -> cells (ranges), outermost first. */
function tables(xml) {
  return elements(xml, 'w:tbl').map(t => ({ ...t, rows: children(xml, t, 'w:tr').map(r => ({ ...r, cells: children(xml, r, 'w:tc') })) }));
}

/** Paragraph and run formatting of a cell's text ({ pPr, rPr }). */
function cellStyle(tcXml) {
  const paras = tcXml.match(/<w:p(?=[\s>])[\s\S]*?<\/w:p>/g) || [];
  const p0 = paras.find(p => textOf(p).trim()) || paras[0] || '<w:p></w:p>';
  const runs = p0.match(/<w:r(?=[\s>])[\s\S]*?<\/w:r>/g) || [];
  const r0 = runs.find(r => /<w:t[\s>]/.test(r) && textOf(r).trim()) || runs[0] || '';
  return { p0, pPr: p0.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || '', rPr: r0.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] || '', hasText: !!textOf(p0).trim() };
}
/** Centre a paragraph (w:jc goes before these pPr children, per the schema order). */
function centred(pPr) {
  if (!pPr) return '<w:pPr><w:jc w:val="center"/></w:pPr>';
  if (/<w:jc\b[^>]*\/>/.test(pPr)) return pPr.replace(/<w:jc\b[^>]*\/>/, '<w:jc w:val="center"/>');
  const at = pPr.search(/<w:(textDirection|textAlignment|textboxTightWrap|outlineLvl|divId|cnfStyle|rPr|sectPr|pPrChange)\b/);
  return at > 0 ? `${pPr.slice(0, at)}<w:jc w:val="center"/>${pPr.slice(at)}` : pPr.replace('</w:pPr>', '<w:jc w:val="center"/></w:pPr>');
}

/**
 * Replace the text of a table cell, keeping its paragraph and run formatting. like: formatting to use when the cell
 * is empty (e.g. from the first filled row of the same column); center: centre the text.
 */
function cellWithText(tcXml, text, { like = null, center = false } = {}) {
  const tcPr = tcXml.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/)?.[0] || '';
  const own = cellStyle(tcXml);
  const p0 = own.p0;
  const pOpen = p0.match(/^<w:p(?:\s[^>]*)?>/)[0];
  let pPr = own.hasText || !like ? own.pPr : like.pPr;
  const rPr = own.hasText || !like ? (own.rPr || like?.rPr || '') : like.rPr;
  if (center) pPr = centred(pPr);
  const tcOpen = tcXml.match(/^<w:tc(?:\s[^>]*)?>/)[0];
  const lines = String(text ?? '').split('\n');
  const body = lines.map((l, k) => `${k ? '<w:br/>' : ''}<w:t xml:space="preserve">${enc(l)}</w:t>`).join('');
  const newP = `${pOpen}${pPr}<w:r>${rPr}${body}</w:r></w:p>`;
  // Keep the cell's empty spacer paragraphs (masters use them to line a value up with its label); only the text
  // paragraph is replaced. Cells with a nested table keep the simple form.
  const paras = /<w:tbl[\s>]/.test(tcXml) ? [] : (tcXml.match(/<w:p(?=[\s>])[\s\S]*?<\/w:p>|<w:p\/>/g) || []);
  const at = own.hasText ? paras.indexOf(p0) : -1;
  if (at >= 0) {
    const spacer = p => !textOf(p).trim() && !/<w:drawing|<w:pict|<w:object/.test(p);
    return `${tcOpen}${tcPr}${paras.map((p, i) => (i === at ? newP : spacer(p) ? p : '')).join('')}</w:tc>`;
  }
  return `${tcOpen}${tcPr}${newP}</w:tc>`;
}

/** Apply edits [{ s, e, xml }] (non-overlapping) from the end backwards. */
function applyEdits(xml, edits) {
  for (const ed of edits.sort((a, b) => b.s - a.s)) xml = xml.slice(0, ed.s) + ed.xml + xml.slice(ed.e);
  return xml;
}

/** Regular expression for a facility name, tolerant of spacing, dashes and dotted abbreviations (L.L.C). */
function nameRegex(name) {
  const chunks = String(name || '').toUpperCase().match(/[A-Z0-9]+/g) || [];
  if (!chunks.length) return null;
  const part = c => (c.length <= 4 ? c.split('').join('\\.?\\s?') : c);
  // A final dot belongs to the name only for an abbreviation (L.L.C. / O.P.C.); otherwise it ends the sentence.
  const abbr = /^(LLC|OPC|CO|INC|LTD)$/.test(chunks.at(-1));
  return new RegExp(`\\[?\\b${chunks.map(part).join('[\\s\\-–.,&]*')}\\b${abbr ? '\\.?' : ''}\\]?`, 'gi');
}

/** Replace a phrase in every paragraph's text, even when Word split it over several runs. */
function replaceInParagraphs(xml, re, replacement) {
  if (!re) return { xml, count: 0 };
  let count = 0;
  const out = xml.replace(/<w:p(?=[\s>])(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g, p => {
    const nodes = [...p.matchAll(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g)].map(m => ({ m, text: dec(m[2]) }));
    if (!nodes.length) return p;
    const full = nodes.map(n => n.text).join('');
    const hits = [...full.matchAll(re)];
    if (!hits.length) return p;
    // character offsets of each node
    let pos = 0;
    for (const n of nodes) { n.a = pos; pos += n.text.length; n.b = pos; n.out = n.text; }
    for (const h of hits.reverse()) {
      const a = h.index, b = h.index + h[0].length;
      const keepBrackets = h[0].startsWith('[') ? `[${replacement}]` : replacement;
      for (const n of nodes.slice().reverse()) {
        if (n.b <= a || n.a >= b) continue;
        const s = Math.max(a, n.a) - n.a, e = Math.min(b, n.b) - n.a;
        n.out = n.out.slice(0, s) + (a >= n.a && a < n.b ? keepBrackets : '') + n.out.slice(e);
      }
      count++;
    }
    let k = 0;
    return p.replace(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g, () => `<w:t xml:space="preserve">${enc(nodes[k++].out)}</w:t>`);
  });
  return { xml: out, count };
}

const ddmmyyyy = iso => (ISO.test(iso || '') ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
/** Due for revision: one year after the review date. */
export const plusOneYear = iso => {
  if (!ISO.test(iso || '')) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y + 1, m - 1, d));
  if (t.getUTCDate() !== d) t.setUTCDate(0); // 29 Feb -> 28 Feb
  return t.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------------------------------
// Templates (global, locked)
// ---------------------------------------------------------------------------------------------------
const templatesDir = () => { const d = path.join(dir(loadGlobalConfig(), 'data'), 'policy-templates'); fs.mkdirSync(d, { recursive: true }); return d; };
const indexFile = () => path.join(templatesDir(), 'templates.json');
/** "2.0", "2", "v2.0" -> "2.0" (major version of a master). */
export const versionKey = v => `${Math.max(1, Math.floor(Number(String(v || '1').replace(/[^\d.]/g, '')) || 1))}.0`;
export function listTemplates() {
  let list;
  try { list = JSON.parse(fs.readFileSync(indexFile(), 'utf8')); } catch { return []; }
  return list.map(t => (t.variants ? t : { // older index: one file = the master of its own version
    ...t, variants: { [versionKey(t.version)]: { file: t.file, original: t.original, uploadedAt: t.uploadedAt, labels: t.labels, hasRevisionTable: t.hasRevisionTable, oldName: t.oldName, oldCode: t.oldCode, title: t.title } },
  })).sort((a, b) => a.no - b.no);
}
/** Every master file (all versions). */
const allFiles = list => list.flatMap(t => Object.values(t.variants || { x: t }).map(v => v.file));
/** The master to use for a policy at a version: that version's file when uploaded, otherwise the main one. */
export function masterFor(t, version) {
  const key = versionKey(version);
  const v = t.variants?.[key];
  return v ? { ...t, ...v, usedVersion: key, exact: true } : { ...t, usedVersion: versionKey(t.version), exact: !t.variants || Object.keys(t.variants).length <= 1 && versionKey(t.version) === key };
}
const saveIndex = list => fs.writeFileSync(indexFile(), JSON.stringify(list.sort((a, b) => a.no - b.no), null, 2));

const LABEL = {
  policyId: /^(policy|document)\s*(id|no\.?|number|ref(erence)?)$/i,
  issued: /^(issued on|date of issue|issue date|date of release|release date|effective date)$/i,
  reviewed: /^(reviewed on|review date|last review(ed)?( on| date)?|date of review)$/i,
  due: /^(due for revision( on| date)?|next review( date| on)?|revision due( date| on)?|due for review( on)?)$/i,
  prepared: /^(prepared by|document author\s*\(?s?\)?|authors?\s*\(?s?\)?|written by)$/i,
  approved: /^(approved by|document approver|approver)$/i,
  facility: /^((facility|group|entity|company|organi[sz]ation|centre|center|establishment) name|name of (the )?(facility|entity|establishment))$/i,
  version: /^version( no\.?| number)?$/i,
};
const labelOf = t => Object.keys(LABEL).find(k => LABEL[k].test(squash(t).replace(/[:：]\s*$/, '')));

/** What a template contains: number, title, standard, old facility name / code, labelled fields found. */
export async function inspectTemplate(buffer, originalName) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error(`${originalName}: not a Word document`);
  const fields = {};
  for (const t of tables(xml)) for (const r of t.rows) {
    if (r.cells.length < 2) continue;
    const k = labelOf(textOf(xml.slice(r.cells[0].s, r.cells[0].e)));
    if (k && !fields[k]) fields[k] = squash(textOf(xml.slice(r.cells.at(-1).s, r.cells.at(-1).e)));
  }
  const id = fields.policyId || '';
  const num = Number(id.match(/PO\s*[-–]?\s*0*(\d{1,3})\b/i)?.[1] || originalName.match(/PO\s*[-–_]?\s*0*(\d{1,3})/i)?.[1] || 0);
  const standard = squash(id.split('/')[1]?.split(/[-–]/)[0] || '') || 'ADHICS';
  const oldCode = squash(id.split('/')[0] || '');
  const firstTable = tables(xml)[0];
  const heading = firstTable ? squash(textOf(xml.slice(firstTable.rows[0]?.s ?? 0, firstTable.rows[0]?.e ?? 0))) : '';
  let parsed = {};
  try { parsed = await parseFacilityDocument(buffer, originalName); } catch { /* optional */ }
  const title = (/polic|procedure/i.test(heading) && heading.length < 160 ? heading : parsed.policyTitle) ||
    path.basename(originalName, path.extname(originalName)).replace(/^PO\s*\d+\s*[-–_]\s*/i, '');
  const oldName = fields.facility || parsed.found?.name || '';
  // Everything that belongs to the facility this master was written for: the spellings of its name in the text
  // (e.g. "... HOME HEALTH CARE" and "... HOME HEALTH CARE CENTER"), its own contact e-mail / phone, its people.
  const all = [xml, ...await Promise.all(Object.keys(zip.files).filter(f => /^word\/(header|footer)\d*\.xml$/.test(f)).map(f => zip.file(f).async('string')))]
    .map(x => (x.match(/<w:p(?=[\s>])(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g) || []).map(textOf).join('\n')).join('\n');
  const nameVariants = new Set(oldName ? [oldName.toUpperCase()] : []);
  if (oldName) {
    const re = new RegExp(`${nameRegex(oldName).source.replace(/\\\]\?$/, '')}(?:\\s*(?:CENTER|CENTRE|CLINIC|L\\.?L\\.?C\\.?|O\\.?P\\.?C\\.?))*`, 'gi');
    for (const m of all.matchAll(re)) nameVariants.add(squash(m[0].replace(/^\[|\]$/g, '')).replace(/\.$/, '').toUpperCase());
  }
  const emails = [...new Set([...all.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map(m => m[0]).filter(e => !/@doh\.gov\.ae$|@(?:facility|example)\./i.test(e)))];
  const phones = new Set();
  for (const line of all.split('\n')) if (/@|phone|mobile|tel\b|contact|secondary/i.test(line) && !/@doh\.gov\.ae/i.test(line)) {
    for (const m of line.matchAll(/(?:\+?971[\s-]?)?\b0?5\d[\s-]?\d{3}[\s-]?\d{4}\b|(?:\+?971[\s-]?)?\b0?[234679][\s-]?\d{3}[\s-]?\d{4}\b/g)) phones.add(m[0].trim());
  }
  return {
    no: num, title, standard, oldCode, oldName,
    nameVariants: [...nameVariants].sort((a, b) => b.length - a.length), emails, phones: [...phones],
    people: { prepared: fields.prepared || '', approved: fields.approved || '' },
    labels: Object.keys(fields), version: fields.version || '1.0', hasRevisionTable: !!revisionTable(xml),
  };
}

/** Add / replace master policy templates. files: [{ name, buffer }]. Returns the updated list. */
export async function addTemplates(files, opts = {}) {
  assertUnlocked();
  const list = listTemplates();
  const added = [], problems = [];
  for (const f of files) {
    try {
      const ext = path.extname(f.name).toLowerCase();
      if (!['.docx', '.doc'].includes(ext)) throw new Error('Word documents only (.docx or .doc) - a PDF cannot be edited');
      const buffer = ext === '.doc' ? await docToDocx(f.buffer) : f.buffer;
      const info = await inspectTemplate(buffer, f.name);
      if (!info.no) info.no = Math.max(0, ...list.map(t => t.no)) + 1;
      // Each policy keeps one master per version (e.g. PO03 v1.0 and v2.0): a file with another version is
      // added next to the existing one; a file with the same version replaces it.
      // opts.version: store as this version whatever the file says; opts.keepPreviousAs: the master currently held
      // for that version is kept as this other version (e.g. new v2.0 in, current file kept as v1.0).
      const key = versionKey(opts.version || info.version);
      const k = list.findIndex(t => t.no === info.no);
      const prev = k >= 0 ? list[k] : null;
      const prevVariants = { ...(prev?.variants || {}) };
      const keepKey = opts.keepPreviousAs && versionKey(opts.keepPreviousAs);
      if (keepKey && keepKey !== key && prevVariants[key] && !prevVariants[keepKey]) { prevVariants[keepKey] = prevVariants[key]; delete prevVariants[key]; }
      const file = prevVariants[key]?.file || `PO${String(info.no).padStart(2, '0')}${Object.keys(prevVariants).length ? `-v${key}` : ''}.docx`;
      fs.writeFileSync(path.join(templatesDir(), file), buffer);
      const variant = {
        file, original: f.name, uploadedAt: new Date().toISOString(), labels: info.labels, hasRevisionTable: info.hasRevisionTable,
        oldName: info.oldName, oldCode: info.oldCode, title: info.title, nameVariants: info.nameVariants, emails: info.emails, phones: info.phones, people: info.people,
      };
      const variants = { ...prevVariants, [key]: variant };
      const top = variants[Object.keys(variants).sort((a, b) => Number(b) - Number(a))[0]]; // highest version = main
      const entry = { ...info, ...top, version: Object.keys(variants).sort((a, b) => Number(b) - Number(a))[0], variants };
      if (k >= 0) list[k] = entry; else list.push(entry);
      added.push({ ...entry, addedVersion: key });
    } catch (e) { problems.push(`${f.name}: ${e.message}`); }
  }
  saveIndex(list);
  // A baseline that was locked before is locked again as soon as the replacement is in (unlocking is one-off).
  const prev = templateLock();
  let relocked = false;
  if (prev && !prev.locked && added.length) { await lockTemplates(prev.unlockedBy || prev.by || ''); relocked = true; }
  return { templates: listTemplates(), added, problems, relocked };
}

// ---------------------------------------------------------------------------------------------------
// Template lock: the uploaded set becomes the master template (e.g. 33 ADHICS policies written for one facility).
// While locked, templates cannot be replaced or removed, and each file is checked against its fingerprint before
// every generation, so the baseline stays exactly as uploaded.
// ---------------------------------------------------------------------------------------------------
const lockFile = () => path.join(templatesDir(), 'lock.json');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
export function templateLock() { try { return JSON.parse(fs.readFileSync(lockFile(), 'utf8')); } catch { return null; } }
const assertUnlocked = () => {
  if (templateLock()?.locked) throw Object.assign(new Error('The master policy templates are locked – an administrator must unlock them before replacing or removing a policy'), { status: 409 });
};

/** The baseline facility of the templates: its name, code and contact details that must be replaced for others. */
export async function detectBaseline(list) {
  const most = arr => Object.entries(arr.filter(Boolean).reduce((m, v) => ((m[v] = (m[v] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const emails = new Set(), phones = new Set();
  // the baseline facility = the facility most masters were written for; only ITS masters give its contacts
  const allVariants = list.flatMap(t => Object.values(t.variants || { x: t }));
  const baseName = most(allVariants.map(v => v.oldName));
  for (const t of allVariants.filter(v => !baseName || v.oldName === baseName)) {
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(templatesDir(), t.file)));
    for (const part of Object.keys(zip.files).filter(f => /^word\/(document|header\d*|footer\d*)\.xml$/.test(f))) {
      const x = await zip.file(part).async('string');
      for (const p of x.match(/<w:p(?=[\s>])(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g) || []) {
        const text = textOf(p);
        for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
          if (/@doh\.gov\.ae$|@(?:facility|example)\./i.test(m[0])) continue; // DoH's own address / placeholders stay
          emails.add(m[0]);
        }
        // phone numbers on the same line as a contact e-mail, or labelled as phone / mobile / tel
        if (/@|phone|mobile|tel\b|contact|secondary/i.test(text)) for (const m of text.matchAll(/(?:\+?971[\s-]?)?\b0?5\d[\s-]?\d{3}[\s-]?\d{4}\b|(?:\+?971[\s-]?)?\b0?[234679][\s-]?\d{3}[\s-]?\d{4}\b/g)) phones.add(m[0].trim());
      }
    }
  }
  return { name: baseName, code: most(allVariants.filter(v => v.oldName === baseName).map(v => v.oldCode)), emails: [...emails], phones: [...phones] };
}

/** Lock the current templates as the master baseline. */
export async function lockTemplates(user = '') {
  await refreshTemplateInfo();
  const list = listTemplates();
  if (!list.length) throw new Error('Upload the master policies first');
  const hashes = Object.fromEntries(allFiles(list).map(f => [f, sha256(fs.readFileSync(path.join(templatesDir(), f)))]));
  const lock = { locked: true, at: new Date().toISOString(), by: user, count: list.length, baseline: await detectBaseline(list), hashes };
  setReadOnly(list, true);
  fs.writeFileSync(lockFile(), JSON.stringify(lock, null, 2));
  return lock;
}
/** Re-read what each master contains (facility name spellings, contacts, people, labels) – the files are unchanged. */
export async function refreshTemplateInfo() {
  const list = listTemplates();
  for (const t of list) {
    for (const [k, v] of Object.entries(t.variants)) {
      try {
        const info = await inspectTemplate(fs.readFileSync(path.join(templatesDir(), v.file)), v.original || v.file);
        Object.assign(v, { labels: info.labels, hasRevisionTable: info.hasRevisionTable, oldName: info.oldName, oldCode: info.oldCode, title: info.title, nameVariants: info.nameVariants, emails: info.emails, phones: info.phones, people: info.people });
        t.variants[k] = v;
      } catch { /* unreadable file: keep what is known */ }
    }
    const top = Object.keys(t.variants).sort((a, b) => Number(b) - Number(a))[0];
    Object.assign(t, t.variants[top], { version: top });
  }
  saveIndex(list);
  return list;
}

// ---------------------------------------------------------------------------------------------------
// Viewing and editing a master in the portal (paragraph by paragraph – layout, tables, headers stay as they are)
// ---------------------------------------------------------------------------------------------------
const historyDir = () => { const d = path.join(templatesDir(), '_history'); fs.mkdirSync(d, { recursive: true }); return d; };
function variantOf(no, version) {
  const t = listTemplates().find(x => x.no === Number(no));
  if (!t) throw new Error(`Policy PO${no} is not in the masters`);
  // The policy version (1.0 / 2.0 / 3.0…) is the number a facility issues the policy as; it uses the master stored
  // for that version, or – when there is none – the master the policy has (the newest), like policy generation does.
  let key = versionKey(version || t.version);
  if (!t.variants[key]) key = versionKey(t.version);
  const v = t.variants[key] || Object.values(t.variants)[0];
  if (!v) throw new Error(`PO${String(no).padStart(2, '0')} has no master file`);
  return { t, key, v, file: path.join(templatesDir(), v.file) };
}
/** Top-level body paragraphs (not inside tables or text boxes) as ranges. */
function bodyParagraphs(xml) {
  const tbls = elements(xml, 'w:tbl');
  const ps = elements(xml, 'w:p');
  const bodyStart = xml.indexOf('<w:body>');
  return ps.filter(p => p.s > bodyStart && !tbls.some(t => inside(p, t)) && !ps.some(o => o !== p && inside(p, o)));
}
const paragraphKind = px => (/<w:drawing|<w:pict/.test(px) ? 'picture'
  : /<w:pStyle w:val="(Heading|Title|Subtitle)[^"]*"/i.test(px) || (/<w:b\/>|<w:b w:val="(1|true)"/.test(px) && textOf(px).trim().length < 80) ? 'heading'
    : /<w:numPr>/.test(px) ? 'list' : textOf(px).trim() ? 'text' : 'empty');

/** The paragraphs of a master for the editor. */
export async function masterParagraphs(no, version) {
  const { t, key, v, file } = variantOf(no, version);
  const xml = await (await JSZip.loadAsync(fs.readFileSync(file))).file('word/document.xml').async('string');
  const paragraphs = bodyParagraphs(xml).map((p, i) => { const px = xml.slice(p.s, p.e); return { i, kind: paragraphKind(px), text: textOf(px) }; });
  return { no: t.no, version: key, title: v.title || t.title, original: v.original, editedAt: v.editedAt || null, editedBy: v.editedBy || null, paragraphs };
}

/** A paragraph with new text: its own paragraph formatting and the formatting of its first word. */
function paragraphWithText(px, text) {
  const open = px.match(/^<w:p(?:\s[^>]*)?>/)[0];
  const pPr = px.match(/^<w:p(?:\s[^>]*)?>\s*(<w:pPr>[\s\S]*?<\/w:pPr>)/)?.[1] || '';
  const runs = px.match(/<w:r(?=[\s>])[\s\S]*?<\/w:r>/g) || [];
  const r0 = runs.find(r => /<w:t[\s>]/.test(r) && textOf(r).trim()) || runs[0] || '';
  const rPr = r0.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] || '';
  const body = String(text).split('\n').map((l, k) => `${k ? '<w:br/>' : ''}<w:t xml:space="preserve">${enc(l)}</w:t>`).join('');
  return `${open.replace(/\sw14:paraId="[^"]*"|\sw14:textId="[^"]*"/g, '')}${pPr}<w:r>${rPr}${body}</w:r></w:p>`;
}

/**
 * Save edits to a master: { edits: [{ i, text }], inserts: [{ after, text, like }], deletes: [i] }. The previous file
 * is kept in _history, the edited master becomes the source for every generation, and the set is locked again.
 */
export async function saveMasterEdits(no, version, { edits = [], inserts = [], deletes = [] } = {}, user = '') {
  const { t, key, v, file } = variantOf(no, version);
  const buf = fs.readFileSync(file);
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml').async('string');
  const ps = bodyParagraphs(xml);
  const at = i => { const p = ps[Number(i)]; if (!p) throw new Error(`Paragraph ${i} does not exist`); return p; };
  const del = new Set(deletes.map(Number));
  const ops = [];
  for (const e of edits) { if (del.has(Number(e.i))) continue; const p = at(e.i); const px = xml.slice(p.s, p.e); if (paragraphKind(px) === 'picture') continue; if (textOf(px) !== e.text) ops.push({ s: p.s, e: p.e, xml: paragraphWithText(px, e.text) }); }
  for (const i of del) { const p = at(i); if (paragraphKind(xml.slice(p.s, p.e)) !== 'picture') ops.push({ s: p.s, e: p.e, xml: '' }); }
  // new clauses: formatted like a chosen paragraph (default: the next normal text paragraph after the position)
  const byPos = new Map();
  for (const ins of inserts) {
    if (!String(ins.text || '').trim()) continue;
    const p = at(ins.after);
    const like = ins.like !== undefined ? at(ins.like) : ps.slice(Number(ins.after)).find(q => paragraphKind(xml.slice(q.s, q.e)) === 'text') || p;
    const add = paragraphWithText(xml.slice(like.s, like.e), ins.text);
    byPos.set(p.e, (byPos.get(p.e) || '') + add);
  }
  // inserts go right after their paragraph (an edit / delete of the same paragraph keeps its own range)
  for (const [pos, add] of byPos) ops.push({ s: pos, e: pos, xml: add, insert: true });
  if (!ops.length) return masterParagraphs(no, key);
  let out = xml;
  for (const o of ops.sort((a, b) => b.s - a.s || (a.insert ? -1 : 1))) out = out.slice(0, o.s) + o.xml + out.slice(o.e);
  zip.file('word/document.xml', out);
  const next = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  // keep the previous master, then replace it (the lock is renewed with the new fingerprint)
  fs.copyFileSync(file, path.join(historyDir(), `${path.basename(v.file, '.docx')}-${new Date().toISOString().replace(/[:.]/g, '-')}.docx`));
  try { fs.chmodSync(file, 0o644); } catch { /* not read-only */ }
  fs.writeFileSync(file, next);
  const list = listTemplates();
  const tt = list.find(x => x.no === t.no);
  Object.assign(tt.variants[key], { editedAt: new Date().toISOString(), editedBy: user, edits: (tt.variants[key].edits || 0) + ops.length });
  saveIndex(list);
  if (templateLock()) await lockTemplates(user || templateLock()?.by || '');
  return masterParagraphs(no, key);
}

/**
 * Page count of masters as Word lays them out (PDF made once per master version and cached in _view, the
 * missing ones converted together in one Word run). Returns Map(master file -> pages).
 */
async function masterPageCounts(masters) {
  const viewDir = path.join(templatesDir(), '_view');
  fs.mkdirSync(viewDir, { recursive: true });
  const pdfOf = m => { const buf = fs.readFileSync(path.join(templatesDir(), m.file)); return path.join(viewDir, `${path.basename(m.file, '.docx')}-${sha256(buf).slice(0, 16)}.pdf`); };
  const missing = [...new Map(masters.map(m => [m.file, m])).values()].filter(m => !fs.existsSync(pdfOf(m)));
  if (missing.length) {
    const tmp = fs.mkdtempSync(path.join(viewDir, 'src-'));
    fs.mkdirSync(path.join(tmp, 'w'));
    const pairs = missing.map((m, i) => { const src = path.join(tmp, 'w', `m${i}.docx`); fs.copyFileSync(path.join(templatesDir(), m.file), src); fs.chmodSync(src, 0o644); return { in: src, out: pdfOf(m) }; });
    try { await wordToPdf(pairs); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  const { getDocumentProxy } = await import('unpdf');
  const out = new Map();
  for (const m of masters) {
    const f = pdfOf(m);
    if (!fs.existsSync(f) || out.has(m.file)) continue;
    try { out.set(m.file, (await getDocumentProxy(new Uint8Array(fs.readFileSync(f)), { verbosity: 0 })).numPages); } catch { /* unreadable: not compared */ }
  }
  return out;
}

/** A master as it is (Word file, or PDF made by Word) – for viewing and for editing in Word. */
export async function masterFile(no, version, format = 'pdf') {
  const { v, file } = variantOf(no, version);
  if (format === 'docx') return { buffer: fs.readFileSync(file), name: v.original || v.file, type: 'docx' };
  const viewDir = path.join(templatesDir(), '_view');
  fs.mkdirSync(viewDir, { recursive: true });
  const hash = sha256(fs.readFileSync(file)).slice(0, 16);
  const pdfFile = path.join(viewDir, `${path.basename(v.file, '.docx')}-${hash}.pdf`);
  if (!fs.existsSync(pdfFile)) {
    const tmp = path.join(viewDir, `src-${hash}`);
    fs.mkdirSync(path.join(tmp, 'w'), { recursive: true });
    const src = path.join(tmp, 'w', 'master.docx');
    fs.writeFileSync(src, fs.readFileSync(file));
    await wordToPdf([{ in: src, out: pdfFile }]);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(pdfFile)) throw new Error('The master could not be shown as PDF (Microsoft Word is needed)');
  }
  return { buffer: fs.readFileSync(pdfFile), name: `${path.basename(v.file, '.docx')}.pdf`, type: 'pdf' };
}

/** Read-only files on disk while locked (Windows "Read-only" attribute), writable again only while unlocked. */
function setReadOnly(list, on) {
  for (const f of allFiles(list)) { try { fs.chmodSync(path.join(templatesDir(), f), on ? 0o444 : 0o644); } catch { /* missing file */ } }
}
export function unlockTemplates(user = '', confirm = '') {
  const lock = templateLock();
  if (!lock?.locked) return lock;
  if (String(confirm).trim().toUpperCase() !== 'UNLOCK') throw new Error('Type UNLOCK to confirm – the master templates are protected');
  setReadOnly(listTemplates(), false);
  const next = { ...lock, locked: false, unlockedAt: new Date().toISOString(), unlockedBy: user };
  fs.writeFileSync(lockFile(), JSON.stringify(next, null, 2));
  return next;
}

/** Remove a policy's master – one version only (version given) or the policy with all its versions. */
export function removeTemplate(no, version) {
  assertUnlocked();
  const list = listTemplates();
  const t = list.find(x => x.no === Number(no));
  if (!t) throw new Error(`Policy PO${no} is not in the templates`);
  const keys = version ? [versionKey(version)] : Object.keys(t.variants);
  for (const k of keys) if (t.variants[k]) { fs.rmSync(path.join(templatesDir(), t.variants[k].file), { force: true }); delete t.variants[k]; }
  if (!Object.keys(t.variants).length) saveIndex(list.filter(x => x !== t));
  else {
    const top = Object.keys(t.variants).sort((a, b) => Number(b) - Number(a))[0];
    Object.assign(t, t.variants[top], { version: top });
    saveIndex(list);
  }
  return listTemplates();
}

// ---------------------------------------------------------------------------------------------------
// Facility settings and pictures (logo, signature, stamp)
// ---------------------------------------------------------------------------------------------------
export function prepSettings(cfg) {
  const p = cfg._facility.policyPrep || {};
  const dc = cfg.documentControl?.values || {};
  return {
    issuedOn: p.issuedOn || '', reviewedOn: p.reviewedOn || '',
    dueOn: p.reviewedOn ? plusOneYear(p.reviewedOn) : '',
    preparedBy: p.preparedBy ?? dc.authors ?? '', approvedBy: p.approvedBy ?? dc.approver ?? '',
    // the baseline facility keeps its own contacts unless others are entered (they replace those of other masters)
    contactEmail: p.contactEmail || (isBaselineFacility(cfg) ? templateLock()?.baseline?.emails?.[0] || '' : ''),
    contactPhone: p.contactPhone || (isBaselineFacility(cfg) ? templateLock()?.baseline?.phones?.[0] || '' : ''),
    standard: p.standard || 'ADHICS', versions: p.versions || {}, descriptions: p.descriptions || {},
    facilityName: facilityDisplayName(cfg), code: cfg._facility.code,
    assets: Object.fromEntries(['logo', 'signature', 'stamp', 'combined'].map(k => [k, !!assetPath(cfg, k)])),
    usesFacilityLogo: !p.logo && !!cfg._facility.logo,
  };
}
const isBaselineFacility = cfg => { const b = templateLock()?.baseline; return !!b?.name && b.name.toUpperCase() === facilityDisplayName(cfg).toUpperCase(); };
const facilityDisplayName = cfg => (cfg.documentControl?.values?.facilityTitle || '').replace(/\s*[-–]\s*LEGAL REGISTER\s*$/i, '').trim() || String(cfg._facility.name || '').toUpperCase();

export function saveSettings(id, body = {}) {
  const cfg = loadConfig(id);
  const cur = cfg._facility.policyPrep || {};
  const next = { ...cur };
  for (const k of ['issuedOn', 'reviewedOn']) if (body[k] !== undefined) {
    if (body[k] && !ISO.test(body[k])) throw new Error(`${k}: use a date`);
    next[k] = body[k];
  }
  for (const k of ['preparedBy', 'approvedBy', 'standard', 'contactPhone']) if (body[k] !== undefined) next[k] = String(body[k]).trim();
  if (body.contactEmail !== undefined) {
    const e = String(body.contactEmail).trim();
    if (e && !/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(e)) throw new Error('Contact e-mail is not a valid address');
    next.contactEmail = e;
  }
  if (body.versions) next.versions = Object.fromEntries(Object.entries(body.versions).filter(([, v]) => /^\d+\.\d$/.test(v)));
  if (body.descriptions) next.descriptions = Object.fromEntries(Object.entries(body.descriptions).map(([k, v]) => [k, String(v).slice(0, 300)]));
  updateFacility(id, { policyPrep: next });
  return prepSettings(loadConfig(id));
}

const assetDir = cfg => { const d = path.join(facilityHome(cfg._facility), 'policies', 'assets'); fs.mkdirSync(d, { recursive: true }); return d; };
function assetPath(cfg, kind) {
  if (kind === 'logo' && !cfg._facility.policyPrep?.logo) return cfg._facility.logo && fs.existsSync(cfg._facility.logo) ? cfg._facility.logo : null;
  for (const e of PIC_EXTS) { const f = path.join(assetDir(cfg), `${kind}.${e}`); if (fs.existsSync(f)) return f; }
  return null;
}
const PIC_EXTS = ['png', 'jpg', 'gif'];
export const assetFile = (id, kind) => assetPath(loadConfig(id), kind);

/** Store a logo / signature / stamp / combined picture: image or PDF, cropped with its background made transparent. */
/** Longest side in pixels: sharp at 300 dpi for the printed size, small Word / PDF / ZIP files. */
export const PRINT_MAX = { logo: 1000, signature: 800, stamp: 700, combined: 1200 };
/** Hard ceiling for one picture inside a policy: anything larger would be copied into every one of the ~33 files. */
export const PRINT_MAX_BYTES = 1.5 * 1024 * 1024;
const LOGO_SOFT_BYTES = 300 * 1024; // above this a logo is tried as JPEG
const fitsPrint = (kind, p) => Math.max(p.width, p.height) <= PRINT_MAX[kind] * 1.25 && p.buffer.length <= PRINT_MAX_BYTES;
const printCache = new Map(); // sha256 of the stored picture + kind -> print-ready picture (preview and generation reuse it)
const uploadCache = new Map(); // preview uploads (not yet saved): sha256 + kind -> cleaned picture (promise)

/**
 * A picture made print-ready: cropped / background removed when `clean`, never larger than PRINT_MAX (pixels) and
 * PRINT_MAX_BYTES. When the clean-up cannot run, a plain resize is used; when even that fails the picture is refused,
 * so a pack can never be bloated by one huge logo (e.g. a 13 MB 3000 px logo repeated in 33 policies = 425 MB).
 */
export async function printReady(kind, pic, { clean = false } = {}) {
  if (!pic) return null;
  const key = `${kind}:${clean}:${sha256(pic.buffer)}`;
  if (printCache.has(key)) return printCache.get(key);
  let out = pic;
  if (clean || !fitsPrint(kind, out)) {
    const c = await cleanLogo(out, { max: PRINT_MAX[kind] });
    if (c.ext === 'png') out = c;
  }
  if (!fitsPrint(kind, out)) out = await resizeImage(out, PRINT_MAX[kind]);
  // A photo-like logo stays heavy as PNG (e.g. 1.4 MB at 1000 px): as JPEG on white it is a fraction of that.
  if (kind === 'logo' && out.buffer.length > LOGO_SOFT_BYTES) {
    const j = await resizeImage(out, PRINT_MAX[kind], { jpeg: true });
    if (j.ext === 'jpg' && j.buffer.length < out.buffer.length * 0.7) out = j;
  }
  if (!fitsPrint(kind, out)) {
    throw new Error(`The ${KIND_LABEL[kind]} picture is too large (${out.width}×${out.height} px, ${(out.buffer.length / 1048576).toFixed(1)} MB) and could not be reduced – upload a smaller PNG or JPG (under 2000 px)`);
  }
  if (printCache.size > 40) printCache.clear();
  printCache.set(key, out);
  return out;
}
/** The facility's stored pictures, print-ready. The facility logo (from its documents) is also cleaned. */
export async function printPics(cfg) {
  const load = k => { const f = assetPath(cfg, k); if (!f) return null; const b = fs.readFileSync(f); const z = imageSize(b); return z ? { buffer: b, ...z } : null; };
  const out = {};
  for (const k of ['logo', 'signature', 'stamp', 'combined']) out[k] = await printReady(k, load(k), { clean: k === 'logo' && !cfg._facility.policyPrep?.logo });
  return out;
}

const KIND_LABEL = { logo: 'logo', signature: 'signature', stamp: 'stamp', combined: 'signature + stamp' };
// ---------------------------------------------------------------------------------------------------
// Telling pictures apart: logo / signature / stamp (local image analysis on this PC - nothing is sent out)
// ---------------------------------------------------------------------------------------------------
const FEATURES = path.join(APP, 'scripts', 'picture-features.ps1');
/** Shape, ink and colour measurements of cleaned pictures (see scripts/picture-features.ps1). */
async function measurePictures(pics) {
  if (process.platform !== 'win32' || !pics.length) return pics.map(() => null);
  const tmp = fs.mkdtempSync(path.join(path.resolve(dir(loadGlobalConfig(), 'data')), 'feat-'));
  try {
    const files = pics.map((p, i) => { const f = path.join(tmp, `p${i}.${p.ext || imageSize(p.buffer)?.ext || 'png'}`); fs.writeFileSync(f, p.buffer); return f; });
    fs.writeFileSync(path.join(tmp, 'list.json'), JSON.stringify(files));
    const stdout = await new Promise(resolve => execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FEATURES, '-List', path.join(tmp, 'list.json')],
      { timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, so) => resolve(err ? '' : so)));
    const res = JSON.parse(stdout.trim().replace(/^﻿/, '') || '[]');
    return pics.map((_, i) => (res[i]?.ok ? res[i] : null));
  } catch { return pics.map(() => null); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
/**
 * How much a picture looks like each kind. Round with a border ring and one or two colours: a stamp. Wide, thin pen
 * strokes in one colour: a signature. Several colours / solid artwork, or the letterhead: a logo. Where it sat in a
 * document counts too (letterhead = logo; the approval table = signature or stamp).
 */
export function pictureScores(m, where = '') {
  const sc = { logo: 0, signature: 0, stamp: 0 };
  if (m) {
    sc.stamp += m.aspect >= 0.75 && m.aspect <= 1.35 ? 3 : m.aspect < 1.6 ? 1 : -2;
    sc.stamp += m.ring >= 0.4 ? 2 : m.ring >= 0.34 ? 0.5 : 0;
    sc.stamp += m.colours <= 2 ? 1 : -1;
    sc.stamp += m.dark < 0.15 ? 1 : 0;
    sc.signature += m.aspect >= 2 ? 2 : m.aspect >= 1.5 ? 1 : -2;
    sc.signature += m.ink <= 0.22 ? 2 : m.ink <= 0.3 ? 0 : -2;
    sc.signature += m.colours <= 2 ? 1 : -1;
    sc.signature += m.dark < 0.4 ? 0.5 : 0;
    sc.logo += m.colours >= 3 ? 3 : 0;
    sc.logo += m.ink >= 0.3 && m.aspect > 1.3 ? 1 : 0;
    sc.logo += m.dark >= 0.3 ? 1 : 0;
    sc.logo += m.aspect >= 4 ? 1 : 0;
    sc.logo += m.ink >= 0.5 ? 1 : 0;   // solid filled artwork
    if (m.families >= 2) { sc.logo += 2; sc.signature -= 2; sc.stamp -= 1; } // separate colours: a signature or stamp is one ink
    sc.stamp += m.ink >= 0.6 ? -1 : 0; // stamps are rings and lettering, not solid shapes
  }
  if (where === 'header') { sc.logo += 4; sc.signature -= 2; sc.stamp -= 2; }
  if (where === 'approval') { sc.signature += 1.5; sc.stamp += 1.5; sc.logo -= 3; }
  return sc;
}
const KIND_REASON = { logo: 'colours / letterhead', signature: 'thin pen strokes, wide', stamp: 'round with a border ring' };
const bestKind = sc => Object.entries(sc).sort((a, b) => b[1] - a[1])[0];

/**
 * The pictures inside a PDF / Word file (or the file itself when it is a picture), with where they sat. Badges and
 * footer pictures (e.g. RESTRICTED) are left out. A picture holding a signature AND a stamp side by side is also
 * split: its two parts become candidates of their own (the whole stays available for "signature + stamp in one").
 */
async function candidatesOf(buffer, name) {
  const direct = imageSize(buffer);
  let label = 'picture', list;
  if (direct) list = [{ buffer, ...direct, where: 'file' }];
  else {
    const k = kindOf(name, buffer);
    if (!['pdf', 'docx', 'doc'].includes(k)) throw new Error('Upload a picture (PNG / JPG), or a PDF or Word file that contains it');
    const doc = await readDocument(buffer, `upload.${k}`);
    label = k === 'pdf' ? 'PDF' : 'Word file';
    const useful = i => i.where !== 'footer' && i.where !== 'badge';
    const header = (doc.images || []).filter(useful).map(i => ({ ...i, where: i.where === 'header' ? 'header' : (i.where || 'body') }));
    const others = (doc.allImages || []).filter(i => useful(i) && !header.some(h => h.buffer.equals(i.buffer)) && !isPageScan(i));
    const big = others.filter(i => i.width * i.height >= 40 * 40); // icons and decorations ignored when real pictures exist
    const rest = big.length || header.length ? big : others;
    // the biggest few are enough
    list = [...header, ...rest].sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 6);
    if (!list.length) throw new Error(`No picture found in this ${label} – only page decorations such as the RESTRICTED badge`);
  }
  // signature + stamp in one picture (the approval cell, or an uploaded picture): split into the two
  for (const c of [...list]) {
    if (c.where !== 'approval' && c.where !== 'file' && c.where !== 'body') continue;
    const aspect = c.width / c.height;
    if (aspect < 1.05 || aspect > 4.5) continue;
    const parts = await splitSignStamp(c);
    if (!parts) continue;
    c.whole = true; // kept for the "signature + stamp in one" box only
    list.push({ ...parts.signature, where: c.where, part: 'signature' }, { ...parts.stamp, where: c.where, part: 'stamp' });
  }
  return { label, list };
}
/** Clean (crop, transparent background) and measure candidates; each gets scores for logo / signature / stamp. */
async function judged(list, max = 1000) {
  const clean = [];
  for (const c of list) clean.push({ ...(await cleanLogo(c, { max })), where: c.where, part: c.part, whole: c.whole });
  const feats = await measurePictures(clean);
  return clean.map((c, i) => {
    const scores = pictureScores(feats[i], c.where);
    if (c.part) { scores[c.part] += 3; scores.logo -= 3; } // a part of a split signature + stamp picture
    return { ...c, features: feats[i], scores };
  });
}

/**
 * A picture from an upload for one slot (logo, signature, stamp, combined): an image, or the best matching picture
 * inside a PDF / Word file (the letterhead logo; the signature or the stamp from the approval table - taken apart
 * when they are one picture). Returns the cleaned picture plus what it looks like, so a wrong slot is noticed.
 */
export async function pictureFrom(buffer, name = '', kind = 'logo') {
  const { label, list } = await candidatesOf(buffer, name);
  const all = await judged(list, PRINT_MAX[kind] || 1000);
  let pool, pick;
  if (kind === 'combined') {
    // both in one: the whole picture that was split, otherwise the most stamp-like one
    pool = all.filter(c => !c.part);
    pick = pool.find(c => c.whole) || pool.slice().sort((a, b) => b.scores.stamp - a.scores.stamp)[0];
  } else {
    pool = all.filter(c => !c.whole);
    pick = pool.slice().sort((a, b) => b.scores[kind] - a.scores[kind])[0];
  }
  pick ||= all[0];
  const [looksLike, score] = bestKind(pick.scores);
  const place = pick.where === 'header' ? ' (letterhead)' : pick.where === 'approval' ? ' (approval table)' : '';
  const split = pick.part ? ` – ${pick.part} taken from the signature + stamp picture` : '';
  const source = label === 'picture' ? `picture${split}` : `${label}${place}${split}`;
  // a clear mismatch (e.g. a round stamp uploaded as the signature): said, never silently swapped
  const mismatch = pick.features && kind !== 'combined' && !pick.part && looksLike !== kind && score - pick.scores[kind] >= 2.5 ? looksLike : null;
  return { ...pick, source, looksLike: pick.features ? looksLike : null, mismatch };
}

/** Upload preview (wizard): the picture as it will be used - cropped, background removed, print size. Nothing saved. */
export async function picturePreview(buffer, name = '', kind = 'logo') {
  if (!PRINT_MAX[kind]) throw new Error('Unknown picture type');
  const raw = await pictureFrom(buffer, name, kind);
  const pic = await printReady(kind, raw);
  return { ...asData(pic), source: raw.source || 'picture', cropped: !!raw.cleaned?.cropped, transparent: !!raw.cleaned?.transparent, looksLike: raw.looksLike, mismatch: raw.mismatch };
}
const asData = pic => ({ dataUrl: `data:${pic.ext === 'jpg' ? 'image/jpeg' : 'image/png'};base64,${pic.buffer.toString('base64')}`, ext: pic.ext || 'png', width: pic.width, height: pic.height, bytes: pic.buffer.length });

/**
 * One drop for all pictures: any mix of pictures, PDFs and Word files. Every picture found is cleaned and measured,
 * then the best one is chosen for each slot (logo, signature, stamp) - one picture per slot, never twice.
 * Returns { logo, signature, stamp } (each { dataUrl, reason, source } or null) and the files not used.
 */
export async function detectPictures(files) {
  const all = [];
  for (const f of files.slice(0, 6)) {
    const { label, list } = await candidatesOf(f.buffer, f.name);
    for (const j of await judged(list, 1200)) if (!j.whole) all.push({ ...j, file: f.name, label });
  }
  if (!all.length) throw new Error('No pictures found');
  // best assignment: every combination of distinct pictures for the three slots (a slot may stay empty)
  const roles = ['logo', 'signature', 'stamp'], MIN = 1.5;
  let best = { total: -1e9, pick: {} };
  const walk = (r, used, pick, total) => {
    if (r === roles.length) { if (total > best.total) best = { total, pick: { ...pick } }; return; }
    walk(r + 1, used, pick, total); // leave this slot empty
    all.forEach((c, i) => {
      if (used.has(i) || c.scores[roles[r]] < MIN) return;
      used.add(i); pick[roles[r]] = i;
      walk(r + 1, used, pick, total + c.scores[roles[r]] + 10);
      used.delete(i); delete pick[roles[r]];
    });
  };
  walk(0, new Set(), {}, 0);
  const out = {};
  for (const r of roles) {
    const i = best.pick[r];
    if (i === undefined) { out[r] = null; continue; }
    const c = all[i];
    const pic = await printReady(r, c);
    const where = c.where === 'header' ? 'letterhead' : c.where === 'approval' ? 'approval table' : 'inside the document';
    out[r] = { ...asData(pic), file: c.file, source: c.label === 'picture' ? c.file : `${c.file} – ${where}`, reason: KIND_REASON[r] };
  }
  const usedIdx = new Set(Object.values(best.pick));
  out.unused = [...new Set(all.filter((_, i) => !usedIdx.has(i)).map(c => c.file))];
  return out;
}

export async function saveAsset(id, kind, buffer, name = '') {
  if (!['logo', 'signature', 'stamp', 'combined'].includes(kind)) throw new Error('Unknown picture type');
  const cfg = loadConfig(id);
  const clean = await pictureFrom(buffer, name, kind);
  for (const e of PIC_EXTS) fs.rmSync(path.join(assetDir(cfg), `${kind}.${e}`), { force: true });
  fs.writeFileSync(path.join(assetDir(cfg), `${kind}.${clean.ext || 'png'}`), clean.buffer);
  if (kind === 'logo') updateFacility(id, { policyPrep: { ...(cfg._facility.policyPrep || {}), logo: true } });
  const drop = k => PIC_EXTS.forEach(e => fs.rmSync(path.join(assetDir(cfg), `${k}.${e}`), { force: true }));
  if (kind === 'combined') { drop('signature'); drop('stamp'); }
  if (kind === 'signature' || kind === 'stamp') drop('combined');
  return prepSettings(loadConfig(id));
}
export function removeAsset(id, kind) {
  const cfg = loadConfig(id);
  PIC_EXTS.forEach(e => fs.rmSync(path.join(assetDir(cfg), `${kind}.${e}`), { force: true }));
  if (kind === 'logo') updateFacility(id, { policyPrep: { ...(cfg._facility.policyPrep || {}), logo: false } });
  return prepSettings(loadConfig(id));
}

// ---------------------------------------------------------------------------------------------------
// Filling one policy
// ---------------------------------------------------------------------------------------------------
/** The revision / version-history table at the end: header with Version, Description and Review / Approved. */
function revisionTable(xml) {
  for (const t of tables(xml).reverse()) {
    for (let h = 0; h < Math.min(2, t.rows.length); h++) {
      const heads = t.rows[h].cells.map(c => squash(textOf(xml.slice(c.s, c.e))).toLowerCase());
      if (heads.length >= 4 && heads.some(x => /version/.test(x)) && heads.some(x => /description|changes/.test(x)) && heads.some(x => /review|approv/.test(x))) {
        const col = re => heads.findIndex(x => re.test(x));
        return { t, header: h, cols: { sno: col(/s\.?\s*no|sl/), version: col(/version/), desc: col(/description|changes/), by: col(/reviewed|approved by|approv/), date: col(/date/), sign: col(/signature/) } };
      }
    }
  }
  return null;
}

/** Version-history rows for a policy. */
function historyRows(v, s, desc) {
  const by = s.approvedBy;
  if (Number(v) >= 2) return [
    { version: '1.0', desc: 'Initial release', by, date: ddmmyyyy(s.issuedOn) },
    { version: v, desc: desc || 'Major revision – policy updated', by, date: ddmmyyyy(s.reviewedOn) },
  ];
  return [{ version: v, desc: desc || 'Reviewed No Changes', by, date: ddmmyyyy(s.reviewedOn) }];
}

const EMU_CM = 360000;
function inlinePicture(rid, id, name, w, h, side = 114300) { // side: space left and right (EMU)
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="${Math.round(side)}" distR="${Math.round(side)}"><wp:extent cx="${w}" cy="${h}"/><wp:docPr id="${id}" name="${name}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="${name}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
}
const fit = (img, maxW, maxH) => { const k = Math.min(maxW / img.width, maxH / img.height); return [Math.round(img.width * k), Math.round(img.height * k)]; };

async function addMedia(zip, relsPath, buffer, base) {
  const ext = imageSize(buffer)?.ext || 'png';
  let n = 1;
  while (zip.file(`word/media/${base}${n}.${ext}`)) n++;
  const media = `${base}${n}.${ext}`;
  zip.file(`word/media/${media}`, buffer);
  let rels = (await zip.file(relsPath)?.async('string')) || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const rid = `rIdLrp${Math.max(0, ...[...rels.matchAll(/Id="rIdLrp(\d+)"/g)].map(m => +m[1])) + 1}`;
  rels = rels.replace(/<\/Relationships>\s*$/, `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${media}"/></Relationships>`);
  zip.file(relsPath, rels);
  return rid;
}

/** Replace the logo picture (page header, or the top of the first page) with the facility logo. */
async function replaceLogo(zip, logo, box = null) { // box: { cx, cy } standard logo box (EMU) instead of the master's
  const parts = Object.keys(zip.files).filter(f => /^word\/header\d*\.xml$/.test(f));
  const candidates = [];
  const collect = async (part, limit) => {
    const xml = await zip.file(part).async('string');
    for (const d of elements(xml, 'w:drawing')) {
      if (limit !== undefined && d.s > limit) continue;
      const dx = xml.slice(d.s, d.e);
      const ext = dx.match(/<wp:extent cx="(\d+)" cy="(\d+)"/);
      if (!ext || !/r:embed="/.test(dx)) continue;
      candidates.push({ part, d, area: +ext[1] * +ext[2], cx: +ext[1], cy: +ext[2] });
    }
  };
  for (const p of parts) await collect(p);
  if (!candidates.length) { // logo in the body above / inside the first table, not the RESTRICTED badge
    const xml = await zip.file('word/document.xml').async('string');
    const t0 = tables(xml)[0];
    const badgeRows = (t0?.rows || []).filter(r => /classification/i.test(textOf(xml.slice(r.s, r.e))));
    await collect('word/document.xml', t0 ? t0.e : 20000);
    for (let k = candidates.length - 1; k >= 0; k--) if (badgeRows.some(r => inside(candidates[k].d, r))) candidates.splice(k, 1);
  }
  // Ignore small pictures (e.g. the RESTRICTED badge in a header) - the logo is the largest.
  const target = candidates.sort((a, b) => b.area - a.area)[0];
  if (!target) return false;
  const xml = await zip.file(target.part).async('string');
  const relsPath = target.part.replace(/^word\/(.*)$/, 'word/_rels/$1.rels');
  const rid = await addMedia(zip, relsPath, logo.buffer, 'lrp-logo');
  const [w, h] = box ? fit(logo, box.cx, box.cy) : fit(logo, target.cx, target.cy);
  let dx = xml.slice(target.d.s, target.d.e)
    .replace(/r:embed="[^"]+"/, `r:embed="${rid}"`)
    .replace(/<wp:extent cx="\d+" cy="\d+"/, `<wp:extent cx="${w}" cy="${h}"`)
    .replace(/(<a:xfrm\b[^>]*>[\s\S]*?<a:ext )cx="\d+" cy="\d+"/, `$1cx="${w}" cy="${h}"`)
    .replace(/<a:srcRect[^>]*\/>/, ''); // drop any crop of the old picture
  // Centred on the page: a floating picture is aligned to the centre of the margins (the masters place their
  // wide banner at a fixed offset from the left, which would push a narrower logo to the left); vertically it
  // stays in the middle of the old picture's box.
  if (/<wp:anchor\b/.test(dx)) {
    dx = dx.replace(/<wp:positionH\b[^>]*>[\s\S]*?<\/wp:positionH>/, '<wp:positionH relativeFrom="margin"><wp:align>center</wp:align></wp:positionH>')
      .replace(/(<wp:positionV\b[^>]*>\s*<wp:posOffset>)(-?\d+)(<\/wp:posOffset>)/, (m, a, v, b) => `${a}${Number(v) + Math.round((target.cy - h) / 2)}${b}`);
  }
  let out = xml.slice(0, target.d.s) + dx + xml.slice(target.d.e);
  // The paragraph that holds the picture is centred too (inline pictures, and anchors positioned by paragraph).
  const paras = elements(out, 'w:p').filter(p => p.s < target.d.s && p.e > target.d.s);
  const p = paras.sort((a, b) => (b.s - a.s))[0];
  if (p) {
    const px = out.slice(p.s, p.e);
    const open = px.match(/^<w:p(?:\s[^>]*)?>/)[0];
    const pPr = px.match(/^<w:p(?:\s[^>]*)?>\s*(<w:pPr>[\s\S]*?<\/w:pPr>)/)?.[1];
    // with a standard box the paragraph is centred exactly: indents and tab stops of the master are dropped
    const exact = p => (box ? p.replace(/<w:ind\b[^>]*\/>/g, '').replace(/<w:tabs>[\s\S]*?<\/w:tabs>/g, '') : p);
    let fixed = pPr ? px.replace(pPr, exact(centred(pPr))) : px.replace(open, `${open}${centred('')}`);
    // ...and runs that only hold tabs / spaces before or after the logo (they would push it sideways) are dropped
    if (box) fixed = fixed.replace(/<w:r(?=[\s>])(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g, r => (/<w:drawing|<w:pict|<w:object/.test(r) || /<w:t(?:\s[^>]*)?>[^<]*\S/.test(r) ? r : /<w:tab\/>|<w:t[\s>]/.test(r) ? '' : r));
    out = out.slice(0, p.s) + fixed + out.slice(p.e);
  }
  zip.file(target.part, out);
  return true;
}

/**
 * Fill one template for a facility. s = settings; pics = { logo, signature, stamp, combined } as { buffer, width, height }.
 * Returns { buffer, report: { filled: [...], missing: [...], nameReplaced } }.
 */
export async function fillPolicy(templateBuffer, tpl, s, pics = {}, opts = {}) {
  const zip = await JSZip.loadAsync(templateBuffer);
  let xml = await zip.file('word/document.xml').async('string');
  const nn = String(tpl.no).padStart(2, '0');
  const version = s.versions?.[tpl.no] || (MAJOR_REVISION.includes(tpl.no) ? '2.0' : '1.0');
  const values = {
    policyId: `${s.code} / ${s.standard || tpl.standard || 'ADHICS'} - PO${nn}`,
    issued: ddmmyyyy(s.issuedOn), reviewed: ddmmyyyy(s.reviewedOn), due: ddmmyyyy(plusOneYear(s.reviewedOn)),
    prepared: s.preparedBy, approved: s.approvedBy, facility: s.facilityName, version,
  };
  const filled = new Set();

  // 1. Labelled cells (Document Control and key-value Version History tables)
  const edits = [];
  let versionSeen = 0;
  for (const t of tables(xml)) for (const r of t.rows) {
    if (r.cells.length < 2 || r.cells.length > 3) continue;
    const k = labelOf(textOf(xml.slice(r.cells[0].s, r.cells[0].e)));
    if (!k) continue;
    let v = values[k];
    if (k === 'version') v = versionSeen++ ? (Number(version) >= 2 ? '1.0' : version) : version;
    if (k === 'issued' && versionSeen > 1) v = values.issued; // history table: original release
    if (!v) continue;
    const c = r.cells.at(-1);
    if (/<w:drawing|<w:pict/.test(xml.slice(c.s, c.e))) continue; // pictures (badges) stay
    edits.push({ s: c.s, e: c.e, xml: cellWithText(xml.slice(c.s, c.e), v, { center: true }) });
    filled.add(k);
  }
  xml = applyEdits(xml, edits);

  // 2. Revision table at the end
  const rev = revisionTable(xml);
  if (rev) {
    const rows = historyRows(version, s, s.descriptions?.[tpl.no]);
    const redits = [];
    const data = rev.t.rows.slice(rev.header + 1);
    // Formatting per column: the first data row that has text in that column (the template's own entry).
    const like = col => { for (const r of data) { const c = r.cells[col]; if (c) { const st = cellStyle(xml.slice(c.s, c.e)); if (st.hasText) return st; } } return null; };
    const likes = Object.fromEntries(Object.entries(rev.cols).map(([k, col]) => [k, col >= 0 ? like(col) : null]));
    data.forEach((r, k) => {
      const set = (col, v) => {
        const c = r.cells[col]; if (col < 0 || !c) return;
        const key = Object.keys(rev.cols).find(x => rev.cols[x] === col);
        redits.push({ s: c.s, e: c.e, xml: cellWithText(xml.slice(c.s, c.e), v, { like: likes[key], center: key !== 'sno' }) });
      };
      const h = rows[k];
      set(rev.cols.sno, String(k + 1));
      set(rev.cols.version, h?.version || '');
      set(rev.cols.desc, h?.desc || '');
      set(rev.cols.by, h?.by || '');
      set(rev.cols.date, h?.date || '');
      if (rev.cols.sign >= 0) set(rev.cols.sign, ''); // the template facility's signatures are removed
    });
    xml = applyEdits(xml, redits);
    filled.add('history');
  }

  // 3. Every reference to the baseline facility in the text -> this facility: its name, its code (whole word),
  //    and its contact e-mail / phone (e.g. the incident contacts in PO18).
  //    A master can come from any facility (the master template, or e.g. an updated v2.0 policy written for another
  //    facility): its own name spellings, code, contacts and people are replaced as well.
  let nameReplaced = 0, contactsReplaced = 0;
  const base = s.baseline || {};
  const UP = v => String(v || '').toUpperCase();
  const olds = [...new Set([...(tpl.nameVariants || []), tpl.oldName, base.name].filter(Boolean).map(n => UP(n).replace(/\.$/, '')))]
    .filter(n => n.length > 4 && n !== UP(s.facilityName) && !UP(s.facilityName).startsWith(`${n} `))
    .sort((a, b) => b.length - a.length); // longest spelling first ("... HOME HEALTH CARE CENTER" before "... HOME HEALTH CARE")
  const sameFacility = !olds.length;
  const esc = v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const people = [[tpl.people?.prepared, s.preparedBy], [tpl.people?.approved, s.approvedBy]].filter(([o, n]) => o && n && squash(o) !== squash(n));
  const swaps = [
    ...olds.map(o => [nameRegex(o), s.facilityName, 'name']),
    ...[...new Set([tpl.oldCode, base.code])].filter(c => c && /^[A-Z0-9]{2,12}$/.test(c) && c !== s.code).map(c => [new RegExp(`\\b${esc(c)}\\b`, 'g'), s.code, 'name']),
    ...people.map(([o, n]) => [new RegExp(squash(o).split(' ').map(esc).join('\\s+'), 'gi'), n, 'name']),
  ];
  // Contacts (e.g. PO18's Information Security Incident Reporting Matrix): only cells / lines that hold the old
  // facility's OWN e-mail are changed - that e-mail and the facility phone next to it. Cells of DoH (soc@doh.gov.ae,
  // +971 2 4193 777) or of anyone else are never touched.
  const oldEmails = [...new Set([...(base.emails || []), ...(tpl.emails || [])])].filter(e => e.toLowerCase() !== String(s.contactEmail || '').toLowerCase());
  const oldPhones = [...new Set([...(base.phones || []), ...(tpl.phones || [])])].filter(p => p.replace(/\D/g, '') !== String(s.contactPhone || '').replace(/\D/g, ''));
  const contactSwaps = [
    ...(s.contactEmail ? oldEmails.map(e => [new RegExp(esc(e), 'gi'), s.contactEmail]) : []),
    ...(s.contactPhone ? oldPhones.map(p => [new RegExp(`(?<!\\d)${esc(p)}(?!\\d)`, 'g'), s.contactPhone]) : []),
  ];
  const facilityEmail = new RegExp(oldEmails.map(esc).join('|') || '(?!)', 'i');
  const contactPass = x => {
    if (!contactSwaps.length) return x;
    const own = c => facilityEmail.test(textOf(c)) && !/@doh\.gov\.ae/i.test(textOf(c));
    const swapIn = c => { for (const [re, to] of contactSwaps) { const r = replaceInParagraphs(c, re, to); c = r.xml; contactsReplaced += r.count; } return c; };
    const cells = elements(x, 'w:tc').filter(c => !elements(x.slice(c.s + 1, c.e), 'w:tc').length); // innermost cells
    x = applyEdits(x, cells.filter(c => own(x.slice(c.s, c.e))).map(c => ({ s: c.s, e: c.e, xml: swapIn(x.slice(c.s, c.e)) })));
    // outside tables: a paragraph that names the facility e-mail
    return x.replace(/<w:p(?=[\s>])(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g, p => (own(p) ? swapIn(p) : p));
  };
  const swapAll = x => {
    x = contactPass(x); // first: the e-mail domain must not be touched by the name / code swaps
    for (const [re, to] of swaps) { const r = replaceInParagraphs(x, re, to); x = r.xml; nameReplaced += r.count; }
    return x;
  };
  xml = swapAll(xml);
  // e-mail links (mailto:) point to the new address too
  if (s.contactEmail) for (const relsPath of Object.keys(zip.files).filter(f => /^word\/_rels\/.*\.rels$/.test(f))) {
    let rels = await zip.file(relsPath).async('string');
    for (const e of oldEmails) rels = rels.replace(new RegExp(`mailto:${esc(e)}`, 'gi'), `mailto:${s.contactEmail}`);
    zip.file(relsPath, rels);
  }

  // 4. Signature and stamp go directly BELOW the version / revision table, at their natural size (side by side,
  //    centred), so they look signed and stamped by hand – not squeezed into the narrow Approval Signature cell.
  //    They stay on the table's page: when they would push the document onto an extra page, the policy is made again
  //    with them smaller (opts.signatureScale), see generatePolicies. The template's old signature / stamp pictures
  //    after the table, and the empty lines that held them, are removed.
  const rev2 = revisionTable(xml);
  if (rev2) {
    const before = xml.slice(0, rev2.t.e);
    let after = xml.slice(rev2.t.e)
      .replace(/<w:r(?=[\s>])(?:(?!<\/w:r>)[\s\S])*?<w:drawing>[\s\S]*?<\/w:drawing>[\s\S]*?<\/w:r>/g, '')
      .replace(/<w:r(?=[\s>])(?:(?!<\/w:r>)[\s\S])*?<w:pict>[\s\S]*?<\/w:pict>[\s\S]*?<\/w:r>/g, '');
    // empty paragraphs after the closing table (they can push a blank page); one tiny one stays before the section
    // properties because Word needs a paragraph after a table at the end of a document
    after = after.replace(/<w:p(?=[\s>])(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>|<w:p\/>/g, p => (textOf(p).trim() || /<w:sectPr|w:type="page"|<w:drawing|<w:pict|<w:tbl/.test(p) ? p : ''));
    const tiny = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>';
    if (!/^\s*<w:p[\s>]/.test(after)) after = tiny + after;
    xml = before + after;

    // Signature and stamp side by side (never on top of each other) under the table, natural proportions:
    // [name, picture, max height cm, max width cm]. opts.signatureScale < 1: smaller (only to avoid an extra page).
    const k = Math.min(1, Math.max(0.3, opts.signatureScale || 1));
    const sig = pics.combined ? [['Signature and stamp', pics.combined, 3.0 * k, 9 * k]]
      : [pics.signature && ['Signature', pics.signature, 1.8 * k, 6 * k], pics.stamp && ['Stamp', pics.stamp, 2.8 * k, 3.4 * k]].filter(Boolean);
    if (sig.length) {
      const r3 = revisionTable(xml);
      let id = 9001;
      // one line of pictures under the table: signature then stamp, a clear space between them, centred
      const runs = [];
      const gap = 1.0 * EMU_CM;
      for (const [name, img, hCm, wCm] of sig) {
        const rid = await addMedia(zip, 'word/_rels/document.xml.rels', img.buffer, `lrp-${name.split(' ')[0].toLowerCase()}`);
        const [w, h] = fit(img, wCm * EMU_CM, hCm * EMU_CM);
        runs.push(inlinePicture(rid, id++, name, w, h, sig.length > 1 ? gap / 2 : 0));
      }
      const para = `<w:p><w:pPr><w:keepLines/><w:spacing w:before="${k < 1 ? 40 : 160}" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>${runs.join('')}</w:p>`;
      if (r3) {
        // the table's last row keeps with the pictures (they never start a page of their own)
        xml = xml.slice(0, r3.t.e) + para + xml.slice(r3.t.e);
        filled.add('signature');
      }
    }
  }
  zip.file('word/document.xml', xml);

  // Headers / footers: facility name in the text, then the logo picture.
  for (const part of Object.keys(zip.files).filter(f => /^word\/(header|footer)\d*\.xml$/.test(f))) {
    let hx = await zip.file(part).async('string');
    zip.file(part, swapAll(hx));
  }
  if (pics.logo && await replaceLogo(zip, pics.logo, opts.logoBox || null)) filled.add('logo');

  // Content types of the added pictures
  let ct = await zip.file('[Content_Types].xml').async('string');
  for (const [e, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['gif', 'image/gif']]) {
    if (Object.keys(zip.files).some(f => f.startsWith('word/media/lrp-') && f.endsWith(`.${e}`)) && !new RegExp(`Extension="${e}"`, 'i').test(ct)) ct = ct.replace('<Default ', `<Default Extension="${e}" ContentType="${mime}"/><Default `);
  }
  zip.file('[Content_Types].xml', ct);

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const wanted = ['policyId', 'issued', 'reviewed', 'due', 'prepared', 'approved', 'facility', 'version'].filter(k => tpl.labels?.includes(k));
  // Safety check: nothing of the baseline facility may remain in the text.
  const leftovers = new Set();
  {
    const checks = [...olds.map(o => [nameRegex(o), o])];
    for (const c of [tpl.oldCode, base.code].filter(c => c && c !== s.code)) checks.push([new RegExp(`\\b${esc(c)}\\b`), c]);
    for (const e of oldEmails) checks.push([new RegExp(esc(e), 'i'), e]);
    for (const p of oldPhones) checks.push([new RegExp(`(?<!\\d)${esc(p)}(?!\\d)`), p]);
    for (const [o] of people) checks.push([new RegExp(squash(o).split(' ').map(esc).join('\\s+'), 'i'), o]);
    // DoH contacts must still be there wherever the template had them (they are never changed)
    const tz = await JSZip.loadAsync(templateBuffer);
    const dohIn = async z => ((await z.file('word/document.xml').async('string')).match(/soc@doh\.gov\.ae|\+971 2 4193 777/gi) || []).length;
    const dohBefore = await dohIn(tz), dohAfter = await dohIn(await JSZip.loadAsync(buffer));
    if (dohAfter !== dohBefore) leftovers.add(`DoH contacts changed (${dohBefore} → ${dohAfter})`);
    const out = await JSZip.loadAsync(buffer);
    for (const part of Object.keys(out.files).filter(f => /^word\/(document|header\d*|footer\d*)\.xml$/.test(f))) {
      const x = await out.file(part).async('string');
      const text = (x.match(/<w:p(?=[\s>])(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g) || []).map(textOf).join('\n');
      for (const [re, label] of checks) { re.lastIndex = 0; if (re.test(text)) leftovers.add(label); }
    }
  }
  // Consistency check: read the generated document back – every labelled cell must hold exactly what was entered.
  const mismatches = [];
  {
    const dx = await (await JSZip.loadAsync(buffer)).file('word/document.xml').async('string');
    let vSeen = 0;
    for (const t of tables(dx)) for (const r of t.rows) {
      if (r.cells.length < 2 || r.cells.length > 3) continue;
      const k = labelOf(textOf(dx.slice(r.cells[0].s, r.cells[0].e)));
      if (!k || !values[k]) continue;
      const got = squash(textOf(dx.slice(r.cells.at(-1).s, r.cells.at(-1).e)));
      let want = values[k];
      if (k === 'version') want = vSeen++ ? (Number(version) >= 2 ? '1.0' : version) : version;
      if (/<w:drawing|<w:pict/.test(dx.slice(r.cells.at(-1).s, r.cells.at(-1).e))) continue;
      if (got !== squash(want)) mismatches.push(`${k}: "${got}" instead of "${want}"`);
    }
    // Structure check: the filled policy keeps the master's layout - the same tables with the same rows and columns.
    const shape = x => tables(x).map(t => `${t.rows.length}x${Math.max(0, ...t.rows.map(r => r.cells.length))}`);
    const before = shape(await (await JSZip.loadAsync(templateBuffer)).file('word/document.xml').async('string')), after = shape(dx);
    if (before.length !== after.length) mismatches.push(`layout: ${after.length} tables instead of the master's ${before.length}`);
    else before.forEach((b, i) => { if (b !== after[i]) mismatches.push(`layout: table ${i + 1} is ${after[i]} (rows x columns) instead of the master's ${b}`); });
  }
  return { buffer, version, report: { filled: [...filled], missing: wanted.filter(k => !filled.has(k)), nameReplaced, contactsReplaced, leftovers: [...leftovers], mismatches } };
}

// ---------------------------------------------------------------------------------------------------
// Generating all policies for a facility (Word + PDF)
// ---------------------------------------------------------------------------------------------------
const jobs = new Map();
export const jobState = id => jobs.get(id) || null;
const safeName = s => String(s).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 110);
export const outputDirs = cfg => {
  const base = path.join(facilityHome(cfg._facility), 'policies');
  return { base, word: path.join(base, 'Word'), pdf: path.join(base, 'PDF') };
};

/**
 * Preview one policy exactly as it will be generated, with the values typed in the form (nothing is saved).
 * form: { name, code, standard, issuedOn, reviewedOn, preparedBy, approvedBy, contactEmail, contactPhone }
 * pics: { logo|signature|stamp|combined: data URL } - for a new facility; otherwise the facility's saved pictures.
 * Returns { buffer, type: 'pdf'|'docx', report, file }.
 */
export async function previewPolicy(id, { no, form = {}, pics = {}, newFacility = false, format = 'pdf' } = {}) {
  const cfg = loadConfig(id);
  const lock = templateLock();
  const t = listTemplates().find(x => x.no === Number(no)) || listTemplates()[0];
  if (!t) throw new Error('Upload the master policies first');
  const saved = prepSettings(cfg);
  const pick = k => (form[k] !== undefined && String(form[k]).trim() !== '' ? String(form[k]).trim() : newFacility ? '' : saved[k]);
  const s = {
    ...saved, baseline: lock?.baseline || null,
    facilityName: newFacility || form.name ? String(form.name || '').trim().toUpperCase() || 'NEW FACILITY' : saved.facilityName,
    code: (newFacility || form.code ? String(form.code || '').trim().toUpperCase() : saved.code) || 'CODE',
    standard: pick('standard') || 'ADHICS',
    ...Object.fromEntries(['issuedOn', 'reviewedOn', 'preparedBy', 'approvedBy', 'contactEmail', 'contactPhone'].map(k => [k, pick(k)])),
  };
  const fromData = async (k, url) => {
    const m = /^data:([^;]+);base64,(.+)$/.exec(url || '');
    if (!m) return null;
    const buf = Buffer.from(m[2], 'base64'), key = `${k}:${sha256(buf)}`;
    if (!uploadCache.has(key)) { // the same upload previewed again (other policy, PDF then Word) is not cleaned again
      if (uploadCache.size > 24) uploadCache.clear();
      uploadCache.set(key, pictureFrom(buf, m[1].includes('pdf') ? 'upload.pdf' : 'upload', k).catch(e => { uploadCache.delete(key); throw e; }));
    }
    return uploadCache.get(key);
  };
  const stored = newFacility ? {} : await printPics(cfg);
  const p = {};
  for (const k of ['logo', 'signature', 'stamp', 'combined']) p[k] = pics[k] ? await printReady(k, await fromData(k, pics[k])) : (stored[k] || null);
  const m = masterFor(t, s.versions?.[t.no] || (MAJOR_REVISION.includes(t.no) ? '2.0' : '1.0'));
  const { buffer, report } = await fillPolicy(fs.readFileSync(path.join(templatesDir(), m.file)), m, s, p);
  report.master = m.usedVersion;
  const file = `${s.code} - PO${String(t.no).padStart(2, '0')} - PREVIEW`;
  if (format === 'docx') return { buffer, type: 'docx', report, file: `${file}.docx` };
  const tmp = fs.mkdtempSync(path.join(path.resolve(dir(loadGlobalConfig(), 'data')), 'preview-'));
  try {
    fs.mkdirSync(path.join(tmp, 'w'));
    const w = path.join(tmp, 'w', 'preview.docx'), out = path.join(tmp, 'w', 'preview.pdf');
    fs.writeFileSync(w, buffer);
    const r = await wordToPdf([{ in: w, out }]);
    if (!fs.existsSync(out)) throw new Error(`Preview PDF not created: ${r.results?.[0]?.error || r.error || 'Microsoft Word is needed'}`);
    return { buffer: fs.readFileSync(out), type: 'pdf', report, file: `${file}.pdf` };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function wordToPdf(pairs) {
  const listFile = path.join(path.dirname(pairs[0].out), '..', '_pdf-jobs.json');
  fs.writeFileSync(listFile, JSON.stringify(pairs));
  return new Promise(resolve => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PDF_SCRIPT, listFile],
      { timeout: 30 * 60000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        fs.rmSync(listFile, { force: true });
        let res = [];
        try { res = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '[]'); } catch { /* below */ }
        resolve({ ok: !err, results: [].concat(res), error: err && (stdout.trim().split(/\r?\n/).pop() || err.message) });
      });
  });
}

/** Missing settings that block generation. */
export function readiness(cfg) {
  const s = prepSettings(cfg), t = listTemplates();
  const need = [];
  if (!t.length) need.push('Upload the master policy templates');
  if (!s.issuedOn) need.push('Issued on date');
  if (!s.reviewedOn) need.push('Reviewed on date');
  if (!s.preparedBy) need.push('Prepared by');
  if (!s.approvedBy) need.push('Approved by');
  const base = templateLock()?.baseline;
  const other = base?.name && base.name.toUpperCase() !== String(s.facilityName).toUpperCase();
  if (other && !s.assets.logo) need.push(`Facility logo (otherwise the ${base.name} logo would stay)`);
  if (other && base.emails?.length && !s.contactEmail) need.push(`Contact e-mail (replaces ${base.emails.join(', ')})`);
  if (other && base.phones?.length && !s.contactPhone) need.push(`Contact phone (replaces ${base.phones.join(', ')})`);
  return need;
}

export function generatePolicies(id, { pdf = true, only } = {}) {
  if (jobs.get(id)?.running) throw new Error('Policies are already being generated');
  const cfg = loadConfig(id);
  const need = readiness(cfg);
  if (need.length) throw new Error(`Still needed: ${need.join(', ')}`);
  const lock = templateLock();
  const s = { ...prepSettings(cfg), baseline: lock?.baseline || null };
  const templates = listTemplates().filter(t => !only || only.includes(t.no));
  const job = { running: true, started: new Date().toISOString(), total: templates.length, done: 0, step: 'Preparing…', results: [], problems: [] };
  jobs.set(id, job);
  (async () => {
    const dirs = outputDirs(cfg);
    fs.mkdirSync(dirs.word, { recursive: true }); fs.mkdirSync(dirs.pdf, { recursive: true });
    let pics;
    try { pics = await printPics(cfg); }
    catch (e) { job.running = false; job.step = 'Stopped'; job.problems.push(e.message); job.error = e.message; return; }
    const pairs = [];
    for (const t of templates) {
      job.step = `Filling PO${String(t.no).padStart(2, '0')} – ${t.title}`;
      try {
        // the master of the chosen version (e.g. PO03 v1.0 or v2.0), checked against the lock fingerprint
        const m = masterFor(t, s.versions?.[t.no] || (MAJOR_REVISION.includes(t.no) ? '2.0' : '1.0'));
        const tbuf = fs.readFileSync(path.join(templatesDir(), m.file));
        if (lock?.locked && lock.hashes?.[m.file] && lock.hashes[m.file] !== sha256(tbuf)) throw new Error('the locked master template was changed on disk – not used');
        const { buffer, version, report } = await fillPolicy(tbuf, m, s, pics);
        report.master = m.usedVersion;
        if (report.leftovers.length) job.problems.push(`PO${String(t.no).padStart(2, '0')}: still mentions ${report.leftovers.join(', ')} – check this policy`);
        const base = safeName(`${s.code} - PO${String(t.no).padStart(2, '0')} - ${t.title.replace(/^ADHICS\s*[-–]\s*/i, '')}`);
        const word = path.join(dirs.word, `${base}.docx`);
        fs.writeFileSync(word, buffer);
        if (buffer.length > 5 * 1048576) job.problems.push(`PO${String(t.no).padStart(2, '0')}: the Word file is ${(buffer.length / 1048576).toFixed(1)} MB – larger than expected`);
        const out = path.join(dirs.pdf, `${base}.pdf`);
        pairs.push({ in: word, out });
        job.results.push({ no: t.no, title: t.title, version, word: path.basename(word), pdf: null, report });
      } catch (e) { job.problems.push(`PO${t.no}: ${e.message}`); }
      job.done++;
    }
    if (pdf && pairs.length) {
      job.step = `Creating ${pairs.length} PDF files with Microsoft Word…`;
      const r = await wordToPdf(pairs);
      for (const x of r.results) {
        const res = job.results.find(j => path.join(dirs.word, j.word) === x.in);
        if (res && x.ok) res.pdf = path.basename(x.out);
        else if (res) job.problems.push(`PO${res.no} PDF: ${x.error || 'not created'}`);
      }
      if (!r.results.length) job.problems.push(`PDF files were not created: ${r.error || 'Microsoft Word is needed on this PC'}`);
    }
    const finished = new Date().toISOString();
    updateFacility(id, { policyPrep: { ...(loadConfig(id)._facility.policyPrep || {}), lastGenerated: { at: finished, count: job.results.length, pdf: job.results.filter(r => r.pdf).length } } });
    // PDF checks: the last page must carry the document's end (version table / signature) – never a blank or
    // signature-only page – and files must stay small.
    if (pdf) {
      job.step = 'Checking the PDF files…';
      const { getDocumentProxy } = await import('unpdf');
      const check = async r => {
        try {
          const file = path.join(dirs.pdf, r.pdf);
          const doc = await getDocumentProxy(new Uint8Array(fs.readFileSync(file)), { verbosity: 0 });
          const last = await doc.getPage(doc.numPages);
          const text = (await last.getTextContent()).items.map(i => i.str).join(' ').replace(/RESTRICTED|Page \d+ of \d+|[؀-ۿ/]+/g, '').replace(/\s+/g, ' ').trim();
          r.pages = doc.numPages;
          r.bytes = fs.statSync(file).size;
          r.lastPageOk = text.length >= 30;
        } catch (e) { r.checkError = e.message; }
      };
      for (const r of job.results.filter(x => x.pdf)) await check(r);
      // Never longer than the master: each policy must have exactly the master's number of pages.
      const withPdf = job.results.filter(x => x.pdf);
      const usedMasters = withPdf.map(r => { const t = templates.find(x => x.no === r.no); return masterFor(t, s.versions?.[t.no] || (MAJOR_REVISION.includes(t.no) ? '2.0' : '1.0')); });
      job.step = 'Comparing the page counts with the masters…';
      let masterPages = new Map();
      try { masterPages = await masterPageCounts(usedMasters); } catch { /* Word unavailable: only the last-page check */ }
      withPdf.forEach((r, i) => { r.masterPages = masterPages.get(usedMasters[i].file) || null; });
      const tooLong = r => r.pdf && (r.lastPageOk === false || (r.masterPages && r.pages > r.masterPages));
      // Automatic fit: when the signature + stamp would push the end of the table onto a page of its own, the
      // policy is made again with them smaller and side by side, until the document ends on its own last page.
      for (const scale of [0.65, 0.45]) {
        const spill = job.results.filter(tooLong);
        if (!spill.length) break;
        job.step = `Fitting the signature and stamp on the last page (${spill.map(r => `PO${String(r.no).padStart(2, '0')}`).join(', ')})…`;
        const redo = [];
        for (const r of spill) {
          const t = templates.find(x => x.no === r.no);
          const m = masterFor(t, s.versions?.[t.no] || (MAJOR_REVISION.includes(t.no) ? '2.0' : '1.0'));
          const again = await fillPolicy(fs.readFileSync(path.join(templatesDir(), m.file)), m, s, pics, { signatureScale: scale });
          again.report.master = m.usedVersion;
          again.report.compactSignature = scale;
          fs.writeFileSync(path.join(dirs.word, r.word), again.buffer);
          r.report = again.report;
          redo.push({ in: path.join(dirs.word, r.word), out: path.join(dirs.pdf, r.pdf) });
        }
        await wordToPdf(redo);
        for (const r of spill) await check(r);
      }
      for (const r of job.results.filter(x => x.pdf)) {
        const issues = [];
        if (r.checkError) issues.push(`could not be checked (${r.checkError})`);
        if (r.lastPageOk === false) issues.push('the last page is empty or holds only the end of the table – check the layout');
        if (r.masterPages && r.pages > r.masterPages) issues.push(`${r.pages} pages – the master has ${r.masterPages} (extra page)`);
        if (r.bytes > 5e6) issues.push(`large file (${(r.bytes / 1e6).toFixed(1)} MB)`);
        if (issues.length) r.report.pdfIssues = issues;
      }
    }
    // Validation before export: every policy filled and read back correctly, nothing of the master facility left,
    // DoH contacts intact, PDF made with no extra page.
    const bad = r => r.report.leftovers.length || r.report.missing.length || r.report.mismatches?.length || r.report.pdfIssues?.length || (pdf && !r.pdf);
    for (const r of job.results.filter(bad)) {
      const why = [...r.report.leftovers, ...r.report.missing.map(m => `${m} not found`), ...(r.report.mismatches || []), ...(r.report.pdfIssues || []), ...(pdf && !r.pdf ? ['no PDF'] : [])];
      const line = `PO${String(r.no).padStart(2, '0')}: ${why.join('; ')}`;
      if (!job.problems.some(p => p.startsWith(line.slice(0, 5)) && p.includes(why[0]))) job.problems.push(line);
    }
    const validation = {
      total: templates.length,
      passed: job.results.filter(r => !bad(r)).length,
      failed: job.results.filter(bad).map(r => `PO${String(r.no).padStart(2, '0')}`),
      pages: job.results.reduce((n, r) => n + (r.pages || 0), 0),
      megabytes: Number((job.results.reduce((n, r) => n + (r.bytes || 0), 0) / 1e6).toFixed(1)),
    };
    validation.failed.push(...templates.filter(t => !job.results.some(r => r.no === t.no)).map(t => `PO${String(t.no).padStart(2, '0')}`));
    Object.assign(job, { running: false, finished, step: 'Done', validation });
  })().catch(e => Object.assign(job, { running: false, finished: new Date().toISOString(), step: 'Failed', problems: [...job.problems, e.message] }));
  return job;
}

/** Generated files of a facility (from the folders). */
export function generatedFiles(cfg) {
  const d = outputDirs(cfg);
  const list = f => (fs.existsSync(f) ? fs.readdirSync(f).filter(x => !x.startsWith('~$')) : []);
  return { folder: d.base, word: list(d.word).filter(f => f.endsWith('.docx')), pdf: list(d.pdf).filter(f => f.endsWith('.pdf')) };
}
export function generatedFile(cfg, type, name) {
  const d = outputDirs(cfg)[type === 'pdf' ? 'pdf' : 'word'];
  const f = path.join(d, path.basename(String(name || '')));
  if (!fs.existsSync(f)) throw new Error('File not found - generate the policies first');
  return f;
}
/** The policy number in a generated file name ("CODE - PO07 - …"). */
export const policyNoOf = name => Number(/\bPO(\d{2})\b/.exec(name)?.[1]) || null;
export async function zipGenerated(cfg, type, keep = null) {
  const d = outputDirs(cfg);
  const zip = new JSZip();
  for (const t of type === 'all' ? ['word', 'pdf'] : [type]) {
    const folder = t === 'pdf' ? d.pdf : d.word;
    if (!fs.existsSync(folder)) continue;
    for (const f of fs.readdirSync(folder).filter(x => !x.startsWith('~$') && (!keep || keep(x)))) zip.file(`${t === 'pdf' ? 'PDF' : 'Word'}/${f}`, fs.readFileSync(path.join(folder, f)));
  }
  if (!Object.keys(zip.files).length) throw new Error('Nothing generated yet');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** The generated PO01 (or first) Word file, for linking the policies to the Legal Register. */
export function registerSourcePolicy(cfg) {
  const { word } = generatedFiles(cfg);
  const f = word.find(x => /PO01\b/.test(x)) || word[0];
  if (!f) throw new Error('Generate the policies first');
  return path.join(outputDirs(cfg).word, f);
}

/** For checks and tests only. */
export const _internal = { revisionTable, tables, textOf, labelOf, squash, nameRegex, replaceInParagraphs, sha256, cellWithText };
