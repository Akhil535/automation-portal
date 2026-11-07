// Read and safely update the Excel Legal Register.
//
// The workbook is never re-saved by a spreadsheet library (that would drop the logo
// images and other features). Instead only the target worksheet XML (and its hyperlink
// relationships) inside the .xlsx package is patched; every other part is kept as is.
// Existing rows are never edited, except blank F-J cells of rows this system added
// (or rows explicitly passed in `updates`).
//
// Update sequence: lock check -> backup -> patch into a temp file -> re-open and
// validate -> atomic rename. Any failure leaves the master workbook untouched.
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { replaceFile } from './config.js';

export class RegisterError extends Error {}
export class RegisterLockedError extends RegisterError {}

const HYPERLINK_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const ROW_RE = n => new RegExp(`<row\\b[^>]*\\br="${n}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`);
const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const esc = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const colIndex = c => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
export const colLetter = n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const excelSerial = iso => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000);

// ---------------------------------------------------------------------------
// Lock detection
// ---------------------------------------------------------------------------
export function lockReason(file) {
  if (!fs.existsSync(file)) return `Register not found: ${file}`;
  const owner = path.join(path.dirname(file), '~$' + path.basename(file));
  if (fs.existsSync(owner)) return `The workbook is open in Excel (lock file ${path.basename(owner)} exists)`;
  try { fs.closeSync(fs.openSync(file, 'r+')); }
  catch (e) { return `The workbook is in use by another program (${e.code})`; }
  return null;
}

// ---------------------------------------------------------------------------
// Package access
// ---------------------------------------------------------------------------
async function openPackage(file, sheetName) {
  let buf;
  try { buf = fs.readFileSync(file); }
  catch (e) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw new RegisterLockedError(`The workbook is locked and cannot be read (${e.code})`);
    throw new RegisterError(`Cannot read register: ${e.message}`);
  }
  const zip = await JSZip.loadAsync(buf);
  const wb = await zip.file('xl/workbook.xml').async('string');
  const wbRels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  let rid = null;
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = m[0].match(/\bname="([^"]*)"/);
    if (name && decode(name[1]) === sheetName) rid = m[0].match(/\br:id="([^"]+)"/)[1];
  }
  if (!rid) throw new RegisterError(`Sheet "${sheetName}" not found in the workbook`);
  const rel = [...wbRels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(t => t.includes(`Id="${rid}"`));
  const target = rel.match(/\bTarget="([^"]+)"/)[1];
  const sheetPart = target.startsWith('/') ? target.slice(1) : path.posix.join('xl', target);
  const relsPart = path.posix.join(path.posix.dirname(sheetPart), '_rels', path.posix.basename(sheetPart) + '.rels');
  const sheet = await zip.file(sheetPart).async('string');
  const rels = zip.file(relsPart) ? await zip.file(relsPart).async('string') : null;
  let shared = [];
  if (zip.file('xl/sharedStrings.xml')) {
    const sst = await zip.file('xl/sharedStrings.xml').async('string');
    shared = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
      decode([...m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  }
  return { zip, buf, sheetPart, relsPart, sheet, rels, shared };
}

function parseCells(rowXml, shared) {
  const cells = {};
  for (const m of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1];
    const ref = attrs.match(/\br="([A-Z]+)(\d+)"/);
    if (!ref) continue;
    const s = attrs.match(/\bs="(\d+)"/)?.[1];
    const t = attrs.match(/\bt="(\w+)"/)?.[1];
    const inner = m[2] || '';
    let value = null;
    const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
    if (t === 's' && v !== undefined) value = shared[+v] ?? '';
    else if (t === 'inlineStr') value = decode([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
    else if (t === 'str' || t === 'e') value = v !== undefined ? decode(v) : null;
    else if (t === 'b') value = v === '1';
    else if (v !== undefined) value = Number(v);
    cells[ref[1]] = { s, t, value, numeric: typeof value === 'number' };
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
export async function readRegister(file, reg) {
  const pkg = await openPackage(file, reg.sheet);
  const col = reg.columns;
  const links = {};
  const relTargets = {};
  if (pkg.rels) for (const m of pkg.rels.matchAll(/<Relationship\b[^>]*>/g)) {
    relTargets[m[0].match(/\bId="([^"]+)"/)[1]] = decode(m[0].match(/\bTarget="([^"]*)"/)?.[1] || '');
  }
  for (const m of pkg.sheet.matchAll(/<hyperlink\b[^>]*\/>/g)) {
    const ref = m[0].match(/\bref="([A-Z]+\d+)"/)?.[1];
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1];
    if (ref && rid && relTargets[rid]) links[ref] = relTargets[rid];
  }
  const records = [];
  let lastDataRow = reg.headerRow, lastSerial = 0, templateRow = null, dateStyleH = null;
  for (const m of pkg.sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(m[1].match(/\br="(\d+)"/)?.[1]);
    if (!r || r <= reg.headerRow || !m[2]) continue;
    const cells = parseCells(m[2], pkg.shared);
    const val = c => cells[col[c]]?.value;
    const number = String(val('number') ?? '').trim(), name = String(val('name') ?? '').trim();
    if (!number && !name) continue;
    const h = cells[col.targetDate];
    if (h?.numeric && h.s) dateStyleH = h.s;
    const serial = val('serial');
    records.push({
      row: r, serial, number, name, dateRaw: val('date'), category: String(val('category') ?? '').trim(),
      url: links[`${col.name}${r}`] || links[`${col.number}${r}`] || '',
      meta: Object.fromEntries(['compliance', 'responsible', 'targetDate', 'frequency', 'authority'].map(k => [k, val(k) ?? null])),
    });
    lastDataRow = r;
    templateRow = m[0];
    if (typeof serial === 'number') lastSerial = Math.max(lastSerial, serial);
  }
  if (!records.length) throw new RegisterError('No circular records found in the register sheet');
  return { records, lastDataRow, lastSerial: lastSerial || records.length, templateRow, dateStyleH };
}

// ---------------------------------------------------------------------------
// Cell / row XML
// ---------------------------------------------------------------------------
function cellXml(ref, s, value) {
  const sa = s ? ` s="${s}"` : '';
  if (value === null || value === undefined || value === '') return `<c r="${ref}"${sa}/>`;
  if (typeof value === 'number') return `<c r="${ref}"${sa}><v>${value}</v></c>`;
  if (value && typeof value === 'object' && value.date) return `<c r="${ref}"${value.style ? ` s="${value.style}"` : sa}><v>${excelSerial(value.date)}</v></c>`;
  return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function styleMap(rowXml) {
  const out = {};
  for (const m of rowXml.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*>/g)) {
    const s = m[0].match(/\bs="(\d+)"/);
    if (s) out[m[1]] = s[1];
  }
  return out;
}

function setCellInRow(rowXml, ref, newCell) {
  const re = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
  if (re.test(rowXml)) return rowXml.replace(re, newCell);
  const col = colIndex(ref.match(/[A-Z]+/)[0]);
  for (const m of rowXml.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"/g)) {
    if (colIndex(m[1]) > col) return rowXml.slice(0, m.index) + newCell + rowXml.slice(m.index);
  }
  if (rowXml.endsWith('/>')) return rowXml.replace(/\/>$/, `>${newCell}</row>`);
  return rowXml.replace(/<\/row>$/, `${newCell}</row>`);
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------
/**
 * append:  [{ values: {A:..,B:..}, links: {B:url, C:url} }]   (values may be {date:'YYYY-MM-DD'})
 * updates: [{ row, values: {F:.., H:{date}} }]                  (only the given cells change)
 */
async function buildPatched(file, reg, snapshot, { append = [], updates = [] }) {
  const pkg = await openPackage(file, reg.sheet);
  let { sheet } = pkg;
  let rels = pkg.rels ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const tmpl = snapshot.templateRow;
  const styles = styleMap(tmpl);
  const openTag = tmpl.match(/^<row\b[^>]*?>/)[0];
  const baseHt = Number(openTag.match(/\bht="([\d.]+)"/)?.[1]) || null;
  const spans = openTag.match(/\bspans="([^"]+)"/)?.[1];
  const dy = openTag.match(/\bx14ac:dyDescent="([^"]+)"/)?.[1];
  let nextRid = Math.max(0, ...[...rels.matchAll(/\bId="rId(\d+)"/g)].map(m => +m[1])) + 1;
  const lastCol = colIndex(reg.lastColumn || 'J');
  const newLinks = [], newRels = [], appended = [];

  // Updates to existing (system-added) rows
  for (const u of updates) {
    const m = sheet.match(ROW_RE(u.row));
    if (!m) throw new RegisterError(`Row ${u.row} not found for update`);
    let rowXml = m[0];
    const rowStyles = styleMap(rowXml);
    for (const [c, v] of Object.entries(u.values)) {
      rowXml = setCellInRow(rowXml, `${c}${u.row}`, cellXml(`${c}${u.row}`, rowStyles[c] || styles[c], v));
    }
    sheet = sheet.replace(m[0], () => rowXml);
  }

  // Appended rows
  let rowNo = snapshot.lastDataRow;
  for (const a of append) {
    rowNo++;
    const existing = sheet.match(ROW_RE(rowNo));
    if (existing && /<v>|<is>|<f>/.test(existing[0])) throw new RegisterError(`Row ${rowNo} below the last record unexpectedly contains data`);
    const cells = [];
    for (let i = 1; i <= lastCol; i++) {
      const c = colLetter(i);
      cells.push(cellXml(`${c}${rowNo}`, styles[c], a.values[c]));
    }
    const name = String(a.values[reg.columns.name] || ''), cat = String(a.values[reg.columns.category] || '');
    let attrs = `r="${rowNo}"` + (spans ? ` spans="${spans}"` : '');
    if (baseHt) attrs += ` ht="${Math.max(baseHt, 16.5 * Math.max(1, Math.ceil(name.length / 130), Math.ceil(cat.length / 85)) + 3)}" customHeight="1"`;
    if (dy) attrs += ` x14ac:dyDescent="${dy}"`;
    const rowXml = `<row ${attrs}>${cells.join('')}</row>`;
    if (existing) sheet = sheet.replace(existing[0], () => rowXml);
    else {
      let pos = -1;
      for (const m of sheet.matchAll(/<row\b[^>]*\br="(\d+)"/g)) if (+m[1] > rowNo) { pos = m.index; break; }
      if (pos < 0) {
        sheet = sheet.replace('<sheetData/>', '<sheetData></sheetData>');
        pos = sheet.indexOf('</sheetData>');
      }
      sheet = sheet.slice(0, pos) + rowXml + sheet.slice(pos);
    }
    for (const [c, url] of Object.entries(a.links || {})) {
      if (!url) continue;
      const rid = `rId${nextRid++}`;
      newLinks.push(`<hyperlink ref="${c}${rowNo}" r:id="${rid}" display="${esc(url)}"/>`);
      newRels.push(`<Relationship Id="${rid}" Type="${HYPERLINK_REL}" Target="${esc(url)}" TargetMode="External"/>`);
    }
    appended.push(rowNo);
  }

  if (newLinks.length) {
    if (sheet.includes('</hyperlinks>')) sheet = sheet.replace('</hyperlinks>', () => newLinks.join('') + '</hyperlinks>');
    else {
      const after = ['printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches',
        'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];
      let pos = -1;
      for (const t of after) { const i = sheet.search(new RegExp(`<${t}\\b`)); if (i >= 0) { pos = i; break; } }
      if (pos < 0) pos = sheet.indexOf('</worksheet>');
      sheet = sheet.slice(0, pos) + `<hyperlinks>${newLinks.join('')}</hyperlinks>` + sheet.slice(pos);
    }
    if (!/xmlns:r="/.test(sheet.slice(0, 3000))) sheet = sheet.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
    rels = rels.replace(/<\/Relationships>\s*$/, () => newRels.join('') + '</Relationships>');
  }

  if (appended.length) {
    const last = appended.at(-1);
    sheet = sheet.replace(/<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"\s*\/>/, (m, a, b, n) => (+n < last ? `<dimension ref="${a}:${b}${last}"/>` : m));
  }

  pkg.zip.file(pkg.sheetPart, sheet);
  if (newLinks.length || pkg.rels !== null) pkg.zip.file(pkg.relsPart, rels);
  const out = await pkg.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { out, appended, sheetPart: pkg.sheetPart, relsPart: pkg.relsPart };
}

async function validate(original, patchedBuf, reg, snapshot, { append, updates }, appendedRows) {
  const zo = await JSZip.loadAsync(fs.readFileSync(original));
  const zn = await JSZip.loadAsync(patchedBuf);
  const before = await openPackage(original, reg.sheet);
  for (const name of Object.keys(zo.files)) {
    if (!zn.file(name) && !zo.files[name].dir) throw new RegisterError(`Patched workbook lost part ${name}`);
    if (name === before.sheetPart || name === before.relsPart || zo.files[name].dir) continue;
    const [a, b] = await Promise.all([zo.file(name).async('nodebuffer'), zn.file(name).async('nodebuffer')]);
    if (!a.equals(b)) throw new RegisterError(`Unexpected change in package part ${name}`);
  }
  const newSheet = await zn.file(before.sheetPart).async('string');
  const touched = new Set([...updates.map(u => u.row), ...appendedRows]);
  for (const m of before.sheet.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
    if (touched.has(+m[1])) continue;
    if (!newSheet.includes(m[0])) throw new RegisterError(`Existing row ${m[1]} would change`);
  }
  for (const m of before.sheet.matchAll(/<hyperlink\b[^>]*\/>/g)) {
    if (!newSheet.includes(m[0])) throw new RegisterError('An existing hyperlink would change');
  }
  // Re-read and compare the written values.
  const tmp = original + '.validate.tmp';
  fs.writeFileSync(tmp, patchedBuf);
  try {
    const after = await readRegister(tmp, reg);
    const byRow = new Map(after.records.map(r => [r.row, r]));
    for (const u of updates) {
      const was = snapshot.records.find(r => r.row === u.row), now = byRow.get(u.row);
      if (!now || now.number !== was.number || now.name !== was.name || now.category !== was.category) throw new RegisterError(`Row ${u.row}: A-E changed during update`);
    }
    append.forEach((a, i) => {
      const r = byRow.get(appendedRows[i]);
      if (!r || r.number !== String(a.values[reg.columns.number]) || r.name !== String(a.values[reg.columns.name])) throw new RegisterError(`Row ${appendedRows[i]} not written correctly`);
      if (a.links?.[reg.columns.name] && r.url !== a.links[reg.columns.name]) throw new RegisterError(`Row ${appendedRows[i]} hyperlink missing`);
    });
  } finally { fs.rmSync(tmp, { force: true }); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function waitUntilUnlocked(file, safety, log = () => {}) {
  const tries = Math.max(1, safety.lockRetries ?? 5);
  for (let i = 1; i <= tries; i++) {
    const reason = lockReason(file);
    if (!reason) return;
    if (i === tries) throw new RegisterLockedError(reason);
    log(`${reason}. Retrying in ${safety.lockRetryDelaySeconds}s (${i}/${tries})`);
    await sleep((safety.lockRetryDelaySeconds ?? 60) * 1000);
  }
}

export function backup(file, backupsDir, keep = 60) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const ext = path.extname(file), stem = path.basename(file, ext);
  const dest = path.join(backupsDir, `${stem}_backup_${stamp}${ext}`);
  fs.copyFileSync(file, dest);
  const all = fs.readdirSync(backupsDir).filter(f => f.startsWith(`${stem}_backup_`)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(backupsDir, old), { force: true });
  return dest;
}

/** Apply appends/updates to the master register safely. Returns { rows, backup }. */
export async function applyChanges(file, reg, changes, backupsDir, safety, log = () => {}) {
  const append = changes.append || [], updates = changes.updates || [];
  if (!append.length && !updates.length) return { rows: [], backup: null };
  await waitUntilUnlocked(file, safety, log);
  const snapshot = await readRegister(file, reg);
  const bak = backup(file, backupsDir, safety.backupKeep);
  const { out, appended } = await buildPatched(file, reg, snapshot, { append, updates });
  await validate(file, out, reg, snapshot, { append, updates }, appended);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.updating`);
  fs.writeFileSync(tmp, out);
  try {
    const reason = lockReason(file);
    if (reason) throw new RegisterLockedError(reason);
    try { replaceFile(tmp, file); }
    catch (e) { throw new RegisterLockedError(`Workbook became locked while saving (${e.code})`); }
  } finally { fs.rmSync(tmp, { force: true }); }
  return { rows: appended, backup: bak };
}

// ---------------------------------------------------------------------------
// Cell-level access to other sheets (LEGAL REGISTER master table, DOCUMENT CONTROLLER)
// ---------------------------------------------------------------------------
/** Merged ranges of a sheet: [{ c1, r1, c2, r2 }] (column numbers, row numbers). */
export async function readMergedRanges(file, sheetName) {
  const pkg = await openPackage(file, sheetName);
  return [...pkg.sheet.matchAll(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\s*\/>/g)]
    .map(m => ({ c1: colIndex(m[1]), r1: +m[2], c2: colIndex(m[3]), r2: +m[4] }));
}

/** Read every cell of a sheet: { 'C4': {value, s, t}, ... } */
export async function readSheetCells(file, sheetName) {
  const pkg = await openPackage(file, sheetName);
  const cells = {};
  for (const m of pkg.sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = m[1].match(/\br="(\d+)"/)?.[1];
    if (!r || !m[2]) continue;
    for (const [c, v] of Object.entries(parseCells(m[2], pkg.shared))) cells[`${c}${r}`] = v;
  }
  return cells;
}

const sameValue = (cur, v) => {
  if (v && typeof v === 'object' && v.date) return cur?.numeric && cur.value === excelSerial(v.date);
  if (v === null || v === undefined || v === '') return cur?.value === null || cur?.value === undefined || cur?.value === '';
  return cur?.value === v;
};

/**
 * Write individual cells on one or more sheets. edits: [{ sheet, cells: { 'D4': value | {date} } }].
 * Cells keep their existing style (a new cell copies the style of the cell above it).
 * Only cells whose value really changes are written. Every other part of the package, every
 * other row, and every other cell of the touched rows stays byte-identical (validated).
 * Returns { changed: ['Sheet!D4', ...], backup }.
 */
export async function patchCells(file, edits, backupsDir, safety, log = () => {}) {
  await waitUntilUnlocked(file, safety, log);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const changed = [], parts = new Map();
  for (const e of edits) {
    const pkg = await openPackage(file, e.sheet);
    let sheet = parts.get(pkg.sheetPart)?.xml ?? pkg.sheet;
    const current = {};
    for (const m of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = m[1].match(/\br="(\d+)"/)?.[1];
      if (r && m[2]) for (const [c, v] of Object.entries(parseCells(m[2], pkg.shared))) current[`${c}${r}`] = v;
    }
    const rows = new Set();
    for (const [ref, v] of Object.entries(e.cells)) {
      if (sameValue(current[ref], v)) continue;
      const [, col, r] = ref.match(/^([A-Z]+)(\d+)$/);
      const m = sheet.match(ROW_RE(r));
      if (!m) throw new RegisterError(`${e.sheet}: row ${r} not found`);
      const s = current[ref]?.s ?? current[`${col}${+r - 1}`]?.s;
      const val = v && typeof v === 'object' && v.date ? { date: v.date } : v;
      let rowXml = m[0];
      if (rowXml.endsWith('/>')) rowXml = rowXml.replace(/\/>$/, '></row>');
      sheet = sheet.replace(m[0], () => setCellInRow(rowXml, ref, cellXml(ref, s, val)));
      rows.add(+r);
      changed.push(`${e.sheet}!${ref}`);
    }
    parts.set(pkg.sheetPart, { xml: sheet, before: pkg.sheet, sheetName: e.sheet, cells: { ...(parts.get(pkg.sheetPart)?.cells || {}), ...e.cells }, rows: new Set([...(parts.get(pkg.sheetPart)?.rows || []), ...rows]) });
  }
  if (!changed.length) return { changed, backup: null };

  for (const [part, p] of parts) zip.file(part, p.xml);
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });

  // Validate: untouched parts identical, untouched rows identical, untouched cells in touched rows identical, values re-read.
  const zo = await JSZip.loadAsync(fs.readFileSync(file)), zn = await JSZip.loadAsync(out);
  for (const name of Object.keys(zo.files)) {
    if (zo.files[name].dir) continue;
    if (!zn.file(name)) throw new RegisterError(`Patched workbook lost part ${name}`);
    if (parts.has(name)) continue;
    const [a, b] = await Promise.all([zo.file(name).async('nodebuffer'), zn.file(name).async('nodebuffer')]);
    if (!a.equals(b)) throw new RegisterError(`Unexpected change in package part ${name}`);
  }
  const tmpCheck = file + '.validate.tmp';
  fs.writeFileSync(tmpCheck, out);
  try {
    for (const [part, p] of parts) {
      const now = await zn.file(part).async('string');
      for (const m of p.before.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
        if (p.rows.has(+m[1])) {
          const cellsOf = x => [...x.matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)].filter(c => !(c[1] in p.cells)).map(c => c[0]).join('');
          const after = now.match(ROW_RE(m[1]))?.[0];
          if (!after || cellsOf(m[0]) !== cellsOf(after)) throw new RegisterError(`${p.sheetName}: other cells of row ${m[1]} would change`);
        } else if (!now.includes(m[0])) throw new RegisterError(`${p.sheetName}: row ${m[1]} would change`);
      }
      const reread = await readSheetCells(tmpCheck, p.sheetName);
      for (const [ref, v] of Object.entries(p.cells)) {
        if (!sameValue(reread[ref], v)) throw new RegisterError(`${p.sheetName}!${ref} not written correctly`);
      }
    }
  } finally { fs.rmSync(tmpCheck, { force: true }); }

  const bak = backup(file, backupsDir, safety.backupKeep);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.updating`);
  fs.writeFileSync(tmp, out);
  try {
    const reason = lockReason(file);
    if (reason) throw new RegisterLockedError(reason);
    try { replaceFile(tmp, file); }
    catch (e) { throw new RegisterLockedError(`Workbook became locked while saving (${e.code})`); }
  } finally { fs.rmSync(tmp, { force: true }); }
  log(`Workbook cells updated: ${changed.join(', ')}`);
  return { changed, backup: bak };
}

export { excelSerial };

/**
 * Replace every value in one column (from firstRow down) for which match(value) is true, in a single pass.
 * Used when a new facility register is created from a template (responsible person in column G).
 * Cell styles are kept; every other part of the package is untouched. Returns the number of cells replaced.
 */
export async function bulkReplaceInColumn(file, sheetName, col, firstRow, match, newValue) {
  const pkg = await openPackage(file, sheetName);
  let n = 0;
  const re = new RegExp(`<c\\b[^>]*?\\br="${col}(\\d+)"[^>]*?(?:/>|>[\\s\\S]*?</c>)`, 'g');
  const sheet = pkg.sheet.replace(re, (whole, row) => {
    if (+row < firstRow) return whole;
    const cur = parseCells(whole, pkg.shared)[col];
    if (!cur || !match(cur.value)) return whole;
    n++;
    return cellXml(`${col}${row}`, cur.s, newValue);
  });
  if (!n) return 0;
  pkg.zip.file(pkg.sheetPart, sheet);
  const out = await pkg.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.updating`);
  fs.writeFileSync(tmp, out);
  try {
    const cells = await readSheetCells(tmp, sheetName);
    const now = Object.entries(cells).filter(([ref, c]) => new RegExp(`^${col}\\d+$`).test(ref) && +ref.slice(col.length) >= firstRow && c.value === newValue).length;
    if (now < n) throw new RegisterError(`Column ${col} not written correctly (${now}/${n})`);
    replaceFile(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
  return n;
}

// ---------------------------------------------------------------------------
// Facility logo (the picture anchored in the top row of a sheet)
// ---------------------------------------------------------------------------
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };
const ANCHOR_RE = /<xdr:(twoCellAnchor|oneCellAnchor)\b[^>]*>[\s\S]*?<\/xdr:\1>/g;

/** Drawings of the given sheets and their top-row picture anchors (the logo). */
async function logoAnchors(zip, sheetNames) {
  const wb = await zip.file('xl/workbook.xml').async('string');
  const wbRels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const out = [];
  for (const name of sheetNames) {
    const tag = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(m => m[0]).find(t => decode(t.match(/\bname="([^"]*)"/)?.[1] || '') === name);
    if (!tag) continue;
    const rid = tag.match(/\br:id="([^"]+)"/)[1];
    const target = [...wbRels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(t => t.includes(`Id="${rid}"`)).match(/Target="([^"]+)"/)[1];
    const sheetPart = target.startsWith('/') ? target.slice(1) : path.posix.join('xl', target);
    const sheetRels = await zip.file(path.posix.join(path.posix.dirname(sheetPart), '_rels', path.posix.basename(sheetPart) + '.rels'))?.async('string');
    const drawId = (await zip.file(sheetPart).async('string')).match(/<drawing r:id="([^"]+)"/)?.[1];
    if (!drawId || !sheetRels) continue;
    const dTarget = [...sheetRels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(t => t.includes(`Id="${drawId}"`)).match(/Target="([^"]+)"/)[1];
    const drawingPart = path.posix.normalize(path.posix.join(path.posix.dirname(sheetPart), dTarget));
    const relsPart = path.posix.join(path.posix.dirname(drawingPart), '_rels', path.posix.basename(drawingPart) + '.rels');
    const xml = await zip.file(drawingPart).async('string');
    const anchors = [...xml.matchAll(ANCHOR_RE)].map(m => m[0])
      .filter(a => /r:embed=/.test(a) && a.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/)?.[1] === '0');
    if (anchors.length) out.push({ sheet: name, drawingPart, relsPart, anchors });
  }
  return out;
}

/** Media bytes of the current logo picture (first sheet that has one), or null. */
export async function readLogo(file, sheetNames) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const [d] = await logoAnchors(zip, sheetNames);
  if (!d) return null;
  const rid = d.anchors[0].match(/r:embed="([^"]+)"/)[1];
  const rels = await zip.file(d.relsPart).async('string');
  const t = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(r => r.includes(`Id="${rid}"`))?.match(/Target="([^"]+)"/)?.[1];
  const media = t && zip.file(path.posix.normalize(path.posix.join(path.posix.dirname(d.drawingPart), t)));
  return media ? media.async('nodebuffer') : null;
}

/**
 * Replace the facility logo on the given sheets with `image` ({ buffer, ext, width, height }). The new picture
 * keeps the old one's position and is fitted inside its box without distortion. Only [Content_Types].xml, the
 * drawing parts and a new media file change. Backup + validation + atomic swap, as for every register write.
 * Returns { sheets: [...], backup } (sheets empty when no logo position was found).
 */
export async function replaceLogo(file, sheetNames, image, backupsDir, safety, log = () => {}) {
  if (!MIME[image.ext] || !image.width || !image.height) throw new RegisterError('Unsupported logo image (PNG, JPEG or GIF needed)');
  await waitUntilUnlocked(file, safety, log);
  const original = fs.readFileSync(file);
  const zip = await JSZip.loadAsync(original);
  const targets = await logoAnchors(zip, sheetNames);
  if (!targets.length) return { sheets: [], backup: null };

  const ext = image.ext === 'jpeg' ? 'jpg' : image.ext;
  let n = 1;
  while (zip.file(`xl/media/logo${n}.${ext}`)) n++;
  const media = `xl/media/logo${n}.${ext}`;
  zip.file(media, image.buffer);
  let ct = await zip.file('[Content_Types].xml').async('string');
  if (!new RegExp(`<Default Extension="${ext}"`, 'i').test(ct)) ct = ct.replace('<Default ', `<Default Extension="${ext}" ContentType="${MIME[ext]}"/><Default `);
  zip.file('[Content_Types].xml', ct);

  const changed = new Set(['[Content_Types].xml', media]);
  for (const d of targets) {
    let rels = await zip.file(d.relsPart).async('string');
    const rid = `rId${Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map(m => +m[1])) + 1}`;
    rels = rels.replace(/<\/Relationships>\s*$/, `<Relationship Id="${rid}" Type="${IMAGE_REL}" Target="../media/${path.posix.basename(media)}"/></Relationships>`);
    let xml = await zip.file(d.drawingPart).async('string');
    for (const a of d.anchors) {
      const box = a.match(/<a:xfrm\b[^>]*>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"\/>/);
      const [bw, bh] = box ? [+box[1], +box[2]] : [3600000, 600000];
      const scale = Math.min(bw / image.width, bh / image.height);
      const cx = Math.round(image.width * scale), cy = Math.round(image.height * scale);
      const from = a.match(/<xdr:from>[\s\S]*?<\/xdr:from>/)[0];
      // New image fill (no crop / effects carried over from the old picture); same name, position and frame.
      const pic = a.match(/<xdr:pic>[\s\S]*?<\/xdr:pic>/)[0]
        .replace(/<xdr:blipFill\b[^>]*>[\s\S]*?<\/xdr:blipFill>/, () => `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`)
        .replace(/(<a:xfrm\b[^>]*>[\s\S]*?<a:ext )cx="\d+" cy="\d+"/, `$1cx="${cx}" cy="${cy}"`);
      xml = xml.replace(a, () => `<xdr:oneCellAnchor>${from}<xdr:ext cx="${cx}" cy="${cy}"/>${pic}<xdr:clientData/></xdr:oneCellAnchor>`);
    }
    zip.file(d.drawingPart, xml);
    zip.file(d.relsPart, rels);
    changed.add(d.drawingPart).add(d.relsPart);
  }
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });

  // Validate: every other part byte-identical; each logo anchor now points at the new picture.
  const zo = await JSZip.loadAsync(original), zn = await JSZip.loadAsync(out);
  for (const name of Object.keys(zo.files)) {
    if (zo.files[name].dir || changed.has(name)) continue;
    const [a, b] = await Promise.all([zo.file(name).async('nodebuffer'), zn.file(name)?.async('nodebuffer')]);
    if (!b || !a.equals(b)) throw new RegisterError(`Unexpected change in package part ${name}`);
  }
  const check = await logoAnchors(zn, sheetNames);
  for (const d of check) {
    const rels = await zn.file(d.relsPart).async('string');
    for (const a of d.anchors) {
      const rid = a.match(/r:embed="([^"]+)"/)[1];
      if (!rels.includes(`Id="${rid}" Type="${IMAGE_REL}" Target="../media/${path.posix.basename(media)}"`)) throw new RegisterError(`Logo not placed on ${d.sheet}`);
    }
  }

  const bak = backup(file, backupsDir, safety.backupKeep);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.updating`);
  fs.writeFileSync(tmp, out);
  try {
    const reason = lockReason(file);
    if (reason) throw new RegisterLockedError(reason);
    try { replaceFile(tmp, file); }
    catch (e) { throw new RegisterLockedError(`Workbook became locked while saving (${e.code})`); }
  } finally { fs.rmSync(tmp, { force: true }); }
  log(`Logo placed on: ${targets.map(t => t.sheet).join(', ')}`);
  return { sheets: targets.map(t => t.sheet), backup: bak };
}
