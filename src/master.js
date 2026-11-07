// Master table ("LEGAL REGISTER" sheet), document-control header ("DOCUMENT CONTROLLER" sheet),
// workbook validation for uploaded/linked registers, and new facility registers from a template.
//
// Master table rules:
//   * the six federal laws/decrees (FIXED.coreLaws) are recognised by name wherever they sit in the
//     table and are never written by the portal;
//   * every other entry (departments, certifications, contracts) is facility-specific: name, issued /
//     expiry / due dates, responsible person and compliance are editable;
//   * compliance is restricted to "Fully Compliant" / "Not Applicable".
// Fixed document-control elements (title "LEGAL REGISTER", "A. Document Control" and its labels, the
// "<code> / LGL REGISTER" number format, Version 1.0, RESTRICTED / داخلي) are enforced, not configurable.
import fs from 'node:fs';
import path from 'node:path';
import { FIXED, documentNumber, isCoreLaw, lawKey, loadConfig, updateFacility, dir } from './config.js';
import { RegisterError, bulkReplaceInColumn, lockReason, patchCells, readMergedRanges, readRegister, readSheetCells } from './xlsx.js';
import { parseDate } from './normalize.js';

const isoFromSerial = n => new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 864e5).toISOString().slice(0, 10);
const asDate = v => (typeof v === 'number' ? isoFromSerial(v) : v === null || v === undefined ? '' : String(v).trim());
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const text = v => String(v ?? '').trim();

function masterItems(cells, m) {
  const col = m.columns, items = [];
  for (let row = m.firstRow; row < m.firstRow + (m.maxRows || 60); row++) {
    const v = c => cells[`${col[c]}${row}`]?.value;
    const name = text(v('name'));
    if (!name) break;
    items.push({
      row, sl: v('sl') ?? items.length + 1, name,
      issued: asDate(v('issued')), expiry: asDate(v('expiry')), due: asDate(v('due')),
      responsible: String(v('responsible') ?? ''), compliance: String(v('compliance') ?? ''),
      fixed: isCoreLaw(name),
    });
  }
  return items;
}

export async function readMaster(cfg = loadConfig()) {
  const items = masterItems(await readSheetCells(cfg.register.path, cfg.master.sheet), cfg.master);
  for (const i of items) i.status = entryStatus(i);
  return items;
}

/**
 * Malaffi certificate: a one-time (lifetime) connection certificate - it has no expiry date and no due date. Its
 * expiry and due cells are always left blank ("______") and it counts as valid once it has an issue date.
 */
export const LIFETIME_ENTRY = /MALAF+I/i;
export const isLifetime = name => LIFETIME_ENTRY.test(String(name || ''));

/**
 * Status of a register entry: fixed (federal law), expired, expiring (within 30 days), valid, no-expiry (issued only,
 * e.g. a certificate without an end date) or missing (no dates at all).
 */
export function entryStatus(i, now = new Date()) {
  if (i.fixed) return 'fixed';
  if (isLifetime(i.name)) return ISO.test(i.issued || '') || ISO.test(i.expiry || '') ? 'lifetime' : 'missing';
  const today = now.toISOString().slice(0, 10);
  const soon = new Date(now.getTime() + 30 * 864e5).toISOString().slice(0, 10);
  if (ISO.test(i.expiry || '')) return i.expiry < today ? 'expired' : i.expiry <= soon ? 'expiring' : 'valid';
  return ISO.test(i.issued || '') ? 'no-expiry' : 'missing';
}

/** Counts per status for a facility's entries (fixed laws excluded). */
export function registerHealth(items) {
  const h = { total: 0, valid: 0, expiring: 0, expired: 0, 'no-expiry': 0, missing: 0, lifetime: 0 };
  for (const i of items) if (!i.fixed) {
    const st = i.status || entryStatus(i);
    h.total++; h[st]++;
    if (st === 'lifetime') h.valid++; // a lifetime certificate is valid
  }
  return h;
}

function docValuesFromCells(cells, d) {
  const out = {};
  for (const [k, ref] of Object.entries(d.cells)) {
    const v = cells[ref]?.value;
    out[k] = k === 'releaseDate' && typeof v === 'number' ? isoFromSerial(v) : k === 'version' && typeof v === 'number' ? v.toFixed(1) : text(v);
  }
  out.classificationText = out.classification; // typed text in the badge cell (should be empty)
  if (!out.classification) out.classification = FIXED.classification; // shown by the badge image
  return out;
}

export async function readDocumentControl(cfg = loadConfig()) {
  const workbook = docValuesFromCells(await readSheetCells(cfg.register.path, cfg.documentControl.sheet), cfg.documentControl);
  return { values: cfg.documentControl.values, code: cfg.facility.code, workbook, fixed: { version: FIXED.version, classification: FIXED.classification, numberSuffix: FIXED.numberSuffix } };
}

/** Save edits to the facility-specific entries. items: [{ row, name?, issued, expiry, due, responsible, compliance }]. */
export async function saveMaster(items, facility, log = () => {}) {
  const cfg = loadConfig(facility);
  const m = cfg.master, col = m.columns;
  const allowed = [m.labels.compliant, m.labels.notApplicable];
  const current = await readMaster(cfg);
  const cells = {};
  for (const it of items || []) {
    const cur = current.find(c => c.row === Number(it.row));
    if (!cur) throw new RegisterError(`Row ${it.row} is not part of the master table`);
    if (cur.fixed) throw new RegisterError(`Entry ${cur.sl} (${cur.name}) is a fixed core regulation and cannot be changed`);
    if (it.name !== undefined && text(it.name) !== cur.name) {
      if (!text(it.name)) throw new RegisterError(`Entry ${cur.sl}: name is required`);
      if (isCoreLaw(it.name)) throw new RegisterError(`"${it.name}" is a fixed core regulation and cannot be used as a facility entry`);
      cells[`${col.name}${cur.row}`] = text(it.name);
    }
    const lifetime = isLifetime(it.name !== undefined ? it.name : cur.name);
    for (const k of ['issued', 'expiry', 'due']) {
      if (it[k] === undefined && !(lifetime && k !== 'issued')) continue;
      const v = lifetime && k !== 'issued' ? '' : text(it[k]); // Malaffi: never an expiry / due date
      if (v && !ISO.test(v)) throw new RegisterError(`${cur.name}: ${k} date must be YYYY-MM-DD`);
      if (v === cur[k] || (!v && !ISO.test(cur[k]))) continue;
      cells[`${col[k]}${cur.row}`] = v ? { date: v } : m.noDate;
    }
    if (it.responsible !== undefined && it.responsible !== cur.responsible) {
      if (!text(it.responsible)) throw new RegisterError(`${cur.name}: responsible person is required`);
      cells[`${col.responsible}${cur.row}`] = String(it.responsible);
    }
    if (it.compliance !== undefined && it.compliance !== cur.compliance) {
      if (!allowed.includes(it.compliance)) throw new RegisterError(`${cur.name}: compliance must be "${allowed.join('" or "')}"`);
      cells[`${col.compliance}${cur.row}`] = it.compliance;
    }
  }
  return patchCells(cfg.register.path, [{ sheet: m.sheet, cells }], dir(cfg, 'backups'), { ...cfg.safety, lockRetries: 1 }, log);
}

// Entry rows are moved by value only (the sheet's rows, styles, merged footer and pictures never move).
const ENTRY_COLS = ['name', 'issued', 'expiry', 'due', 'responsible', 'compliance'];
const rawValue = (cells, ref) => { const v = cells[ref]?.value; return v === null || v === undefined ? '' : v; };

/**
 * Delete one facility entry: the entries below move up one row, SL NO is renumbered and the last row of the
 * table is left empty (ready for "Add entry"). Fixed federal laws cannot be deleted.
 */
export async function deleteMasterEntry(row, facility, log = () => {}) {
  const cfg = loadConfig(facility);
  const m = cfg.master, col = m.columns;
  const cells = await readSheetCells(cfg.register.path, m.sheet);
  const items = masterItems(cells, m);
  const target = items.find(i => i.row === Number(row));
  if (!target) throw new RegisterError(`Row ${row} is not part of the master table`);
  if (target.fixed) throw new RegisterError(`${target.name} is a fixed core regulation and cannot be deleted`);
  if (items.filter(i => !i.fixed).length <= 1) throw new RegisterError('The register must keep at least one facility entry');
  const last = items.at(-1).row, edits = {};
  for (let r = target.row; r < last; r++) {
    for (const k of ENTRY_COLS) edits[`${col[k]}${r}`] = rawValue(cells, `${col[k]}${r + 1}`);
    edits[`${col.sl}${r}`] = r - m.firstRow + 1;
  }
  for (const k of ['sl', ...ENTRY_COLS]) edits[`${col[k]}${last}`] = '';
  const res = await patchCells(cfg.register.path, [{ sheet: m.sheet, cells: edits }], dir(cfg, 'backups'), { ...cfg.safety, lockRetries: 1 }, log);
  return { ...res, deleted: target.name };
}

/**
 * Add a facility entry after the last facility entry (before the fixed federal laws). Needs the free row that a
 * deleted entry leaves at the end of the table; the laws move down one row and SL NO is renumbered.
 * entry: { name, issued?, expiry?, due?, responsible?, compliance? }
 */
export async function addMasterEntry(entry, facility, log = () => {}) {
  const cfg = loadConfig(facility);
  const m = cfg.master, col = m.columns;
  const name = text(entry?.name);
  if (!name) throw new RegisterError('Entry name is required');
  if (isCoreLaw(name)) throw new RegisterError(`"${name}" is a fixed core regulation`);
  const allowed = [m.labels.compliant, m.labels.notApplicable];
  const compliance = entry.compliance || m.labels.compliant;
  if (!allowed.includes(compliance)) throw new RegisterError(`Compliance must be "${allowed.join('" or "')}"`);
  for (const k of ['issued', 'expiry', 'due']) if (entry[k] && !ISO.test(entry[k])) throw new RegisterError(`${k} date must be YYYY-MM-DD`);
  const cells = await readSheetCells(cfg.register.path, m.sheet);
  const items = masterItems(cells, m);
  if (items.some(i => key(i.name) === key(name))) throw new RegisterError(`"${name}" is already in the register`);
  const last = items.at(-1).row, free = last + 1;
  // A free row is a former entry row: styled cells, all empty, and not part of a merged area (e.g. the footer).
  const merged = (await readMergedRanges(cfg.register.path, m.sheet)).some(g => free >= g.r1 && free <= g.r2);
  const isFree = !merged && cells[`${col.name}${free}`]?.s !== undefined && ['sl', ...ENTRY_COLS].every(k => text(rawValue(cells, `${col[k]}${free}`)) === '');
  if (!isFree) throw new RegisterError('The register table has no free row. Delete an entry that is no longer needed first, or add the row in Excel.');
  const at = (items.filter(i => !i.fixed).at(-1)?.row ?? m.firstRow - 1) + 1;
  const edits = {};
  for (let r = free; r > at; r--) for (const k of ENTRY_COLS) edits[`${col[k]}${r}`] = rawValue(cells, `${col[k]}${r - 1}`);
  edits[`${col.name}${at}`] = name;
  for (const k of ['issued', 'expiry', 'due']) edits[`${col[k]}${at}`] = entry[k] && !(isLifetime(name) && k !== 'issued') ? { date: entry[k] } : m.noDate;
  edits[`${col.responsible}${at}`] = entry.responsible || cfg.branch.responsible;
  edits[`${col.compliance}${at}`] = compliance;
  for (let r = at; r <= free; r++) edits[`${col.sl}${r}`] = r - m.firstRow + 1;
  const res = await patchCells(cfg.register.path, [{ sheet: m.sheet, cells: edits }], dir(cfg, 'backups'), { ...cfg.safety, lockRetries: 1 }, log);
  return { ...res, row: at };
}
const key = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Cells the DOCUMENT CONTROLLER / LEGAL REGISTER sheets must hold for this facility (values + fixed elements). */
function standardCells(cfg, values) {
  const d = cfg.documentControl;
  const doc = { ...FIXED.docLabels };
  for (const [k, ref] of Object.entries(d.cells)) {
    const v = values[k];
    if (v === undefined) continue;
    if (k === 'releaseDate') { if (v) doc[ref] = { date: v }; }
    else if (k === 'version') doc[ref] = Number(FIXED.version);
    else if (k === 'classification') doc[ref] = ''; // the pre-formatted RESTRICTED / داخلي badge image is the classification; no typed text over it
    else if (k === 'approver') doc[ref] = v.startsWith(' ') ? v : ` ${v}`; // the template keeps a leading space here
    else doc[ref] = v;
  }
  return [{ sheet: d.sheet, cells: doc }, { sheet: cfg.master.sheet, cells: { ...FIXED.masterHeaders } }];
}

/** Only cells whose (trimmed) value differs, so formatting-only differences never trigger a write. */
async function differing(file, edits) {
  const out = [];
  for (const e of edits) {
    const cur = await readSheetCells(file, e.sheet);
    const cells = {};
    for (const [ref, v] of Object.entries(e.cells)) {
      const c = cur[ref]?.value;
      if (v === '' && (c === undefined || c === null || text(c) === '')) continue;
      if (typeof v === 'string' && text(c) === text(v)) continue;
      if (typeof v === 'number' && c === v) continue;
      cells[ref] = v;
    }
    if (Object.keys(cells).length) out.push({ sheet: e.sheet, cells });
  }
  return out;
}

const EDITABLE_DOC = ['facilityTitle', 'code', 'releaseDate', 'approver', 'authors'];

/** Save the facility's document-control details; optionally write them (and the fixed elements) to its workbook. */
export async function saveDocumentControl(values, writeWorkbook = true, facility, log = () => {}) {
  let cfg = loadConfig(facility);
  const v = values || {};
  if (v.version !== undefined && text(v.version) !== FIXED.version) throw new RegisterError(`Version No. is fixed at ${FIXED.version}`);
  if (v.classification !== undefined && text(v.classification) !== FIXED.classification) throw new RegisterError(`Document classification is fixed: ${FIXED.classification}`);
  if (v.documentNumber !== undefined && !text(v.documentNumber).endsWith(FIXED.numberSuffix.trim())) throw new RegisterError(`Document number must follow the format "<code>${FIXED.numberSuffix}"`);
  const fields = {};
  if (v.facilityTitle !== undefined) { if (!text(v.facilityTitle)) throw new RegisterError('Facility title is required'); fields.title = text(v.facilityTitle); }
  const code = v.code ?? (v.documentNumber !== undefined ? text(v.documentNumber).replace(/\s*\/\s*LGL REGISTER$/i, '') : undefined);
  if (code !== undefined) { if (!/^[A-Za-z0-9][A-Za-z0-9 .&-]{0,19}$/.test(text(code))) throw new RegisterError('Facility code: 1-20 letters/digits'); fields.code = text(code); }
  // Date of Release is not typed: it follows the most recent circular in the register (syncReleaseDate).
  for (const k of ['approver', 'authors']) if (v[k] !== undefined) { if (!text(v[k])) throw new RegisterError(`${k} is required`); fields[k] = text(v[k]); }
  updateFacility(cfg.facility.id, fields);
  if (!writeWorkbook) return { changed: [], backup: null };
  cfg = loadConfig(cfg.facility.id);
  const edits = await differing(cfg.register.path, standardCells(cfg, cfg.documentControl.values));
  if (!edits.length) return { changed: [], backup: null };
  return patchCells(cfg.register.path, edits, dir(cfg, 'backups'), { ...cfg.safety, lockRetries: 1 }, log);
}
export { EDITABLE_DOC };

/** Date (YYYY-MM-DD) of the most recent circular in a register, or null. */
export async function latestCircularDate(file, reg) {
  const snap = await readRegister(file, reg);
  const today = new Date(Date.now() + 864e5).toISOString().slice(0, 10); // ignore mistyped future dates
  return snap.records.map(r => parseDate(r.dateRaw)).filter(d => d && d <= today).sort().at(-1) || null;
}

/**
 * Date of Release = date of the most recent circular in the facility's register. Called after every monitoring
 * run (and when a facility is created); updates the facility profile and the DOCUMENT CONTROLLER sheet.
 * Returns the date, or null when the register holds no dated circular.
 */
export async function syncReleaseDate(facility, log = () => {}) {
  const cfg = loadConfig(facility);
  // Date of Release = the latest of: the most recent circular, the most recent facility document applied.
  const today = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const docDates = Object.values(cfg._facility.documents || {}).map(d => d.issued).filter(d => ISO.test(d || '') && d <= today);
  const latest = [await latestCircularDate(cfg.register.path, cfg.register), ...docDates].filter(Boolean).sort().at(-1) || null;
  if (!latest) return null;
  if (cfg._facility.releaseDate !== latest) {
    updateFacility(cfg.facility.id, { releaseDate: latest });
    log(`Date of Release set to ${latest} (most recent circular or facility document)`);
  }
  await saveDocumentControl({}, true, cfg.facility.id, log);
  return latest;
}

/**
 * Check that a workbook can serve as a facility's master register. Returns a preview:
 * { ok, problems[] (blocking), warnings[], circulars, latest, header{}, entries, coreLaws, nonStandard[] }
 */
export async function checkWorkbook(file, cfg = loadConfig()) {
  const out = { ok: false, problems: [], warnings: [], circulars: 0, latest: null, header: {}, entries: 0, coreLaws: 0, nonStandard: [], lock: null };
  if (!fs.existsSync(file)) { out.problems.push(`File not found: ${file}`); return out; }
  if (!/\.xlsx$/i.test(file)) out.problems.push('Only .xlsx workbooks are supported');
  out.lock = lockReason(file);
  try {
    const snap = await readRegister(file, cfg.register);
    out.circulars = snap.records.length;
    out.latest = snap.records.at(-1)?.number;
  } catch (e) { out.problems.push(`"${cfg.register.sheet}" sheet: ${e.message}`); }
  try {
    const cells = await readSheetCells(file, cfg.documentControl.sheet);
    out.header = docValuesFromCells(cells, cfg.documentControl);
    for (const [ref, label] of Object.entries(FIXED.docLabels)) if (text(cells[ref]?.value) !== label) out.nonStandard.push(`${cfg.documentControl.sheet}!${ref} should be "${label}"`);
    if (!out.header.documentNumber.endsWith(FIXED.numberSuffix.trim())) out.nonStandard.push(`Document number "${out.header.documentNumber}" does not follow "<code>${FIXED.numberSuffix}"`);
    if (out.header.version !== FIXED.version) out.nonStandard.push(`Version No. is "${out.header.version}" (standard: ${FIXED.version})`);
    if (out.header.classificationText) out.nonStandard.push(`Text typed over the classification badge ("${out.header.classificationText}") – it is cleared`);
  } catch (e) { out.problems.push(`"${cfg.documentControl.sheet}" sheet: ${e.message}`); }
  try {
    const cells = await readSheetCells(file, cfg.master.sheet);
    const items = masterItems(cells, cfg.master);
    out.entries = items.length;
    const found = new Set(items.filter(i => i.fixed).map(i => lawKey(i.name)));
    out.coreLaws = found.size;
    const missing = FIXED.coreLaws.filter(l => !found.has(lawKey(l)));
    if (missing.length) out.problems.push(`Fixed core regulations missing from "${cfg.master.sheet}": ${missing.join(', ')}`);
    for (const [ref, label] of Object.entries(FIXED.masterHeaders)) if (text(cells[ref]?.value) !== label) out.nonStandard.push(`${cfg.master.sheet}!${ref} should be "${label}"`);
  } catch (e) { out.problems.push(`"${cfg.master.sheet}" sheet: ${e.message}`); }
  if (out.lock) out.warnings.push(out.lock);
  if (out.nonStandard.length) out.warnings.push(`${out.nonStandard.length} standard element(s) differ; they are corrected when the document control is saved`);
  out.ok = !out.problems.length;
  return out;
}

/** Header values found in a workbook, mapped to facility fields (used when a facility adopts an uploaded workbook). */
export function facilityFieldsFromHeader(h) {
  const f = {};
  if (h.facilityTitle) f.title = h.facilityTitle;
  const code = text(h.documentNumber).replace(/\s*\/\s*LGL REGISTER$/i, '');
  if (code && code !== h.documentNumber) f.code = code;
  if (ISO.test(h.releaseDate || '')) f.releaseDate = h.releaseDate;
  if (h.approver) f.approver = h.approver;
  if (h.authors) f.authors = h.authors;
  return f;
}

/**
 * Create a new facility's register from another facility's workbook: header values replaced, facility-specific
 * entries reset (dates "______", responsible = new person), fixed laws kept, and the DoH circular history kept with
 * the old responsible person replaced by the new one (IT Department rows unchanged).
 */
export async function createFromTemplate(sourceFacility, dest, newFacilityId, log = () => {}) {
  const src = loadConfig(sourceFacility);
  if (fs.existsSync(dest)) throw new RegisterError(`${path.basename(dest)} already exists`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const srcLock = fs.readFileSync(src.register.path); // read once; never written
  fs.writeFileSync(dest, srcLock);
  try {
    const cfg = loadConfig(newFacilityId);
    const items = await masterItems(await readSheetCells(dest, cfg.master.sheet), cfg.master);
    const m = cfg.master, col = m.columns, master = {};
    for (const i of items) {
      // Facility entries start empty. The fixed federal laws keep their names, dates and compliance; only the
      // responsible person becomes this facility's (another facility's person must not appear in its register).
      if (!i.fixed) for (const k of ['issued', 'expiry', 'due']) master[`${col[k]}${i.row}`] = m.noDate;
      master[`${col.responsible}${i.row}`] = cfg.branch.responsible;
    }
    const edits = [...standardCells(cfg, cfg.documentControl.values), { sheet: m.sheet, cells: master }];
    const noBackup = fs.mkdtempSync(path.join(path.dirname(dest), '.tmpl-'));
    try {
      await patchCells(dest, await differing(dest, edits), noBackup, { lockRetries: 1, backupKeep: 1 }, log);
    } finally { fs.rmSync(noBackup, { recursive: true, force: true }); }
    const oldPerson = text(src.branch.responsible);
    const n = await bulkReplaceInColumn(dest, cfg.register.sheet, cfg.register.columns.responsible, cfg.register.headerRow + 1,
      v => text(v) === oldPerson, cfg.branch.responsible);
    log(`Template created from ${src.facility.code}: ${n} circular row(s) now assigned to ${text(cfg.branch.responsible)}`);
    return { replaced: n };
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
}
