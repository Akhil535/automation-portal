// Facility lifecycle: create a facility (from a facility document + template, an uploaded workbook or a linked
// path), attach / replace its master Excel register, re-read a facility document (PDF / DOCX / DOC) into it,
// and remove a facility. Every workbook is validated before it is used; every register write takes a backup.
import fs from 'node:fs';
import path from 'node:path';
import { dir, facilityHome, loadConfig, loadFacilities, loadGlobalConfig, saveFacilities, slug, updateFacility } from './config.js';
import { checkWorkbook, createFromTemplate, facilityFieldsFromHeader, latestCircularDate, readMaster, saveDocumentControl, saveMaster, syncReleaseDate } from './master.js';
import { recognizeDocument } from './recognize.js';
import { parseFacilityDocument } from './policy.js';
import { kindOf } from './docparse.js';
import { backup, lockReason, readLogo, replaceLogo } from './xlsx.js';

const CODE = /^[A-Za-z0-9][A-Za-z0-9 .&-]{0,19}$/;
const DOC_EXTS = ['pdf', 'docx', 'doc'];
/** Licences / certificates / contracts may also be photos or scans (read with OCR). */
export const ENTRY_DOC_EXTS = [...DOC_EXTS, 'jpg', 'png'];

export const uploadsDir = () => { const d = path.join(dir(loadGlobalConfig(), 'data'), 'uploads'); fs.mkdirSync(d, { recursive: true }); return d; };

/** Uploaded file for a token. ext: one extension, or a list to search. */
export function uploadFile(token, ext = 'xlsx') {
  if (!/^[0-9a-f-]{36}$/.test(token || '')) throw new Error('Upload expired - choose the file again');
  for (const e of [].concat(ext)) {
    const file = path.join(uploadsDir(), `${token}.${e}`);
    if (fs.existsSync(file)) return file;
  }
  throw new Error('Upload expired - choose the file again');
}

/** Store an uploaded facility document (PDF / DOCX / DOC). Returns { token, file, kind }. */
export function storeUpload(buffer, name, token, exts = DOC_EXTS) {
  const kind = kindOf(name, buffer);
  if (!exts.includes(kind)) throw new Error(exts.includes('jpg') ? 'Upload a PDF, Word document or a photo (JPG / PNG)' : 'Upload a PDF, Word (.docx) or Word 97-2003 (.doc) document');
  const file = path.join(uploadsDir(), `${token}.${kind}`);
  fs.writeFileSync(file, buffer);
  return { token, file, kind };
}

/** Point a facility at an uploaded (token) or linked (path) workbook after validating it. Returns the path. */
export async function attachRegister(id, { source, token, path: linked, name, importHeader }) {
  const cfg = loadConfig(id);
  let target;
  if (source === 'upload') {
    const up = uploadFile(token);
    const preview = await checkWorkbook(up, cfg);
    if (!preview.ok) throw new Error(`Workbook not accepted: ${preview.problems.join('; ')}`);
    const base = path.basename(name || 'LEGAL REGISTER.xlsx').replace(/\.xlsx$/i, '').replace(/[^\w .()-]+/g, '_');
    target = path.join(facilityHome(cfg._facility), 'register', `${cfg.facility.code.replace(/[^\w.-]+/g, '_')}_${base}.xlsx`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      const lock = lockReason(target);
      if (lock) throw new Error(`${lock} - close it first`);
      backup(target, dir(cfg, 'backups'), cfg.safety.backupKeep);
    }
    fs.copyFileSync(up, target);
    fs.rmSync(up, { force: true });
    if (importHeader) updateFacility(id, facilityFieldsFromHeader(preview.header));
  } else if (source === 'link') {
    target = path.resolve(String(linked || '').trim());
    const preview = await checkWorkbook(target, cfg);
    if (!preview.ok) throw new Error(`Workbook not accepted: ${preview.problems.join('; ')}`);
    if (importHeader) updateFacility(id, facilityFieldsFromHeader(preview.header));
  } else throw new Error('Choose how to provide the workbook (template, upload or link)');
  updateFacility(id, { register: { ...loadConfig(id)._facility.register, path: target } });
  return target;
}

// ---------------------------------------------------------------------------------------------------
// Facility documents (policy or legal register; PDF / DOCX / DOC)
// ---------------------------------------------------------------------------------------------------
/** Read a facility document given as an upload token or a linked path. Returns { file, parsed }. */
export async function readPolicy({ policyToken, policyPath }, opts = {}) {
  const file = policyToken ? uploadFile(policyToken, ENTRY_DOC_EXTS) : path.resolve(String(policyPath || '').trim());
  if (!fs.existsSync(file)) throw new Error(`Document not found: ${file}`);
  const buf = fs.readFileSync(file);
  if (!ENTRY_DOC_EXTS.includes(kindOf(file, buf))) throw new Error('The document must be a PDF, Word (.docx / .doc) file or a photo of it (PNG / JPG)');
  return { file, parsed: await parseFacilityDocument(buf, file, opts) };
}

/** Names of a facility's editable register entries (the fixed federal laws are never imported). */
async function entryNames(id) {
  const cfg = loadConfig(id);
  if (!cfg.register.path || !fs.existsSync(cfg.register.path)) return [];
  return (await readMaster(cfg)).filter(i => !i.fixed).map(i => i.name);
}

/** Keep a facility's reference document: uploads are copied into its folder, linked paths are recorded as is. */
function keepPolicy(id, { policyToken, policyName }, file) {
  if (!policyToken) return updateFacility(id, { policyPath: file });
  const fac = loadConfig(id)._facility;
  const ext = path.extname(file);
  const base = path.basename(policyName || `document${ext}`).replace(/\.(pdf|docx?)$/i, '').replace(/[^\w .()-]+/g, '_');
  const dest = path.join(facilityHome(fac), 'policy', `${base}${ext}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  fs.rmSync(file, { force: true });
  return updateFacility(id, { policyPath: dest });
}

/** Match document entries to register rows: [{ row, name, issued, expiry, due, responsible, compliance, current }] */
async function matchEntries(id, entries) {
  if (!entries?.length) return [];
  const items = await readMaster(loadConfig(id));
  return entries.map(e => {
    const cur = items.find(i => !i.fixed && i.name === e.name);
    return cur ? { ...e, row: cur.row, current: { issued: cur.issued, expiry: cur.expiry, due: cur.due, responsible: cur.responsible, compliance: cur.compliance } } : null;
  }).filter(Boolean);
}

/** Write imported entries to the register; only values found in the document change. */
async function writeEntries(id, entries, log) {
  const items = [];
  for (const e of entries || []) {
    const it = { row: e.row };
    for (const k of ['issued', 'expiry', 'due']) if (e[k] !== undefined && e[k] !== null) it[k] = e[k];
    if (e.responsible) it.responsible = e.responsible;
    if (e.compliance) it.compliance = e.compliance;
    if (Object.keys(it).length > 1) items.push(it);
  }
  if (!items.length) return { changed: [] };
  return saveMaster(items, id, log);
}

/**
 * Preview what a facility document would change for an existing facility (nothing is written).
 * Returns { parsed, entries } - entries already matched to register rows, with the current values.
 */
export async function previewDocument(id, src) {
  const { parsed } = await readPolicy(src, { entryNames: await entryNames(id) });
  return { parsed, entries: await matchEntries(id, parsed.entries) };
}

/**
 * Apply a facility document to an existing facility: header details (name, title, approver, author, responsible),
 * logo, and register entries. opts: { header = true, logo = true, entries: [...] | undefined (= all found) }.
 */
export async function applyPolicy(id, src, log = () => {}, opts = {}) {
  const { file, parsed } = await readPolicy(src, { entryNames: await entryNames(id) });
  const f = parsed.fields;
  if (opts.header !== false) {
    const fields = {};
    if (f.name) { fields.name = f.name; fields.title = f.title; }
    for (const k of ['approver', 'authors', 'responsible']) if (f[k]) fields[k] = f[k];
    if (f.responsible) fields.responsibleOptions = [...new Set([f.responsible, ...(loadConfig(id)._facility.responsibleOptions || [])])];
    updateFacility(id, fields);
  }
  keepPolicy(id, src, file);
  const cfg = loadConfig(id);
  if (cfg.register.path) {
    const latest = await latestCircularDate(cfg.register.path, cfg.register);
    if (latest) updateFacility(id, { releaseDate: latest });
    if (opts.header !== false) await saveDocumentControl({}, true, id, log);
    const entries = opts.entries ?? await matchEntries(id, parsed.entries);
    parsed.applied = await writeEntries(id, entries, log);
  }
  if (opts.logo !== false) await applyLogo(id, parsed.logo, log);
  return parsed;
}

/**
 * Create a facility. b: { code?, name?, title?, approver?, authors?, responsible?, policyToken? | policyPath?,
 *   source: 'template'|'upload'|'link', templateFrom?, token?, path?, fileName?, writeHeader? }
 * Missing details are taken from the facility document. The register gets the facility's header, logo and (from a
 * legal register document) its entry dates. On any failure the facility entry is removed again.
 */
export async function createFacility(b, log = () => {}) {
  let policy = null;
  if (b.policyToken || b.policyPath) {
    policy = await readPolicy(b);
    const p = policy.parsed.fields;
    b = { ...b };
    for (const k of ['code', 'name', 'title', 'approver', 'authors', 'responsible']) if (!String(b[k] || '').trim() && p[k]) b[k] = p[k];
  }
  const code = String(b.code || '').trim();
  if (!CODE.test(code)) throw new Error('Facility code: 1-20 letters/digits (e.g. ABC)');
  for (const k of ['name', 'title', 'responsible']) if (!String(b[k] || '').trim()) throw new Error(`${k} is required`);
  const data = loadFacilities();
  const id = slug(code);
  if (data.list.some(f => f.id === id || f.code.toLowerCase() === code.toLowerCase())) throw new Error(`A facility with code ${code} already exists`);
  const entry = {
    id, code, name: String(b.name).trim(), title: String(b.title).trim(), releaseDate: '',
    approver: String(b.approver || '').trim(), authors: String(b.authors || '').trim(),
    responsible: String(b.responsible), responsibleOptions: [...new Set([b.responsible, ...(b.responsibleOptions || [])].filter(Boolean))],
    register: { path: '', scopeStartDate: b.scopeStartDate || loadConfig().register.scopeStartDate }, emailTo: b.emailTo || [],
  };
  data.list.push(entry);
  saveFacilities(data);
  let created = null;
  try {
    if (b.source === 'template' || !b.source) {
      created = path.join(facilityHome(entry), 'register', `${code.replace(/[^\w.-]+/g, '_')}_LEGAL REGISTER.xlsx`);
      updateFacility(id, { register: { ...entry.register, path: created } });
      await createFromTemplate(b.templateFrom || data.default, created, id, log);
    } else {
      await attachRegister(id, { ...b, name: b.fileName || b.name, importHeader: false });
    }
    const reg = loadConfig(id).register;
    updateFacility(id, { releaseDate: (await latestCircularDate(reg.path, reg)) || '' }); // Date of Release = latest circular
    await saveDocumentControl({}, b.writeHeader !== false, id, log);
    if (policy) {
      await applyLogo(id, policy.parsed.logo, log);
      // A legal register document also carries the entries' dates: re-read with this register's entry names.
      const again = await parseFacilityDocument(fs.readFileSync(policy.file), policy.file, { entryNames: await entryNames(id) });
      await writeEntries(id, await matchEntries(id, again.entries), log);
      keepPolicy(id, b, policy.file);
    }
  } catch (e) {
    const d = loadFacilities(); d.list = d.list.filter(f => f.id !== id); saveFacilities(d);
    if (created) fs.rmSync(created, { force: true });
    throw e;
  }
  return id;
}

/**
 * Remove a facility from the portal. Its folder (register created by the portal, history, backups, logo, documents)
 * is moved to facilities/_removed/<id>-<timestamp> - nothing is erased, and a linked register elsewhere is untouched.
 */
export function deleteFacility(id) {
  const data = loadFacilities();
  const fac = data.list.find(f => f.id === id);
  if (!fac) throw new Error(`Unknown facility: ${id}`);
  if (data.list.length === 1) throw new Error('The last facility cannot be removed');
  if (data.templateId === id) throw new Error('This is the master template - every new facility is copied from it, so it cannot be removed');
  if (data.default === id) throw new Error('This is the default facility - make another facility the default first (Settings → This facility)');
  data.list = data.list.filter(f => f.id !== id);
  saveFacilities(data);
  let archived = null;
  const home = facilityHome(fac);
  const base = facilitiesBase();
  if (fac.home === undefined && fs.existsSync(home) && path.resolve(home).startsWith(path.resolve(base) + path.sep)) {
    archived = path.join(base, '_removed', `${id}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`);
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    try { fs.renameSync(home, archived); }
    catch { fs.cpSync(home, archived, { recursive: true }); fs.rmSync(home, { recursive: true, force: true }); }
    // the facility's settings go with its folder, so a removal made by mistake can be undone (Restore)
    fs.writeFileSync(path.join(archived, 'facility.json'), JSON.stringify({ ...fac, removedAt: new Date().toISOString() }, null, 2));
  }
  return { removed: id, archived, restorable: !!archived };
}
const facilitiesBase = () => path.join(path.dirname(loadGlobalConfig()._file), 'facilities');

/** Removed facilities that can be restored (newest first). */
export function removedFacilities() {
  const dirR = path.join(facilitiesBase(), '_removed');
  if (!fs.existsSync(dirR)) return [];
  const live = loadFacilities().list;
  return fs.readdirSync(dirR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => {
    const meta = path.join(dirR, d.name, 'facility.json');
    if (!fs.existsSync(meta)) return null; // removed before restore existed: kept on disk, not restorable here
    try {
      const f = JSON.parse(fs.readFileSync(meta, 'utf8'));
      const clash = live.some(x => x.id === f.id || x.code.toLowerCase() === String(f.code).toLowerCase());
      return { archive: d.name, id: f.id, code: f.code, name: f.name, removedAt: f.removedAt || null, clash };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.removedAt).localeCompare(String(a.removedAt)));
}

/** Put a removed facility back: its folder (register, policies, history) and its settings. */
export function restoreFacility(archive) {
  if (!/^[\w.-]+$/.test(String(archive || ''))) throw new Error('Unknown removed facility');
  const from = path.join(facilitiesBase(), '_removed', archive);
  const meta = path.join(from, 'facility.json');
  if (!fs.existsSync(meta)) throw new Error('This removed facility cannot be restored');
  const { removedAt, ...fac } = JSON.parse(fs.readFileSync(meta, 'utf8'));
  const data = loadFacilities();
  if (data.list.some(f => f.id === fac.id || f.code.toLowerCase() === String(fac.code).toLowerCase())) {
    throw new Error(`A facility with code ${fac.code} exists again - remove or rename it first`);
  }
  const to = path.join(facilitiesBase(), fac.id);
  if (fs.existsSync(to)) throw new Error(`The folder facilities/${fac.id} is in use`);
  fs.rmSync(meta, { force: true });
  try { fs.renameSync(from, to); }
  catch { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
  data.list.push(fac);
  saveFacilities(data);
  return { restored: fac.id, name: fac.name };
}

/**
 * Keep the facility logo (from its document) in the facility folder and place it at the top of the
 * DOCUMENT CONTROLLER and LEGAL REGISTER sheets of its register.
 */
export async function applyLogo(id, logo, log = () => {}) {
  if (!logo?.buffer) return null;
  const cfg = loadConfig(id);
  const home = facilityHome(cfg._facility);
  fs.mkdirSync(home, { recursive: true });
  const dest = path.join(home, `logo.${logo.ext}`);
  for (const f of fs.readdirSync(home)) if (/^logo\.(png|jpe?g|gif)$/i.test(f) && path.join(home, f) !== dest) fs.rmSync(path.join(home, f), { force: true });
  fs.writeFileSync(dest, logo.buffer);
  updateFacility(id, { logo: dest });
  if (!cfg.register.path) return dest;
  const current = await readLogo(cfg.register.path, [cfg.documentControl.sheet, cfg.master.sheet]);
  if (current && current.equals(logo.buffer)) return dest; // already the facility's logo
  await replaceLogo(cfg.register.path, [cfg.documentControl.sheet, cfg.master.sheet], logo, dir(cfg, 'backups'), { ...cfg.safety, lockRetries: 1 }, log);
  return dest;
}

// ---------------------------------------------------------------------------------------------------
// Facility documents for register entries (DOH licence, trade licence, ICA card, Malaffi, MCC, contracts ...)
// ---------------------------------------------------------------------------------------------------
/** Store an uploaded document and recognise it: type, register entry, issue / expiry / due dates. */
export async function analyzeDocument(id, buffer, name, token) {
  const cfg = loadConfig(id);
  const up = storeUpload(buffer, name, token, ENTRY_DOC_EXTS);
  try {
    const entries = cfg.register.path ? await readMaster(cfg) : [];
    const r = await recognizeDocument(buffer, name, { entries, facilityName: cfg.facility.name });
    const cur = entries.find(e => e.row === r.row);
    return { token: up.token, ...r, current: cur ? { issued: cur.issued, expiry: cur.expiry, due: cur.due } : null };
  } catch (e) { fs.rmSync(up.file, { force: true }); throw e; }
}

/**
 * Apply recognised documents (after the user's review): items [{ token, file, row, issued, expiry, due }].
 * Dates are written to the register (backup first), each document is kept in the facility folder and linked to its
 * entry, and the Date of Release is brought up to date.
 */
export async function applyDocuments(id, items, log = () => {}) {
  const cfg = loadConfig(id);
  const entries = await readMaster(cfg);
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const rows = new Set();
  const updates = (items || []).filter(it => it.row).map(it => {
    const e = entries.find(x => x.row === Number(it.row));
    if (!e) throw new Error(`Row ${it.row} is not a register entry`);
    if (e.fixed) throw new Error(`${e.name} is a fixed core regulation`);
    if (rows.has(e.row)) throw new Error(`Two documents were mapped to "${e.name}" - keep one`);
    rows.add(e.row);
    for (const k of ['issued', 'expiry', 'due']) if (it[k] && !ISO.test(it[k])) throw new Error(`${e.name}: ${k} date must be YYYY-MM-DD`);
    return { it, e };
  });
  if (!updates.length) throw new Error('Nothing to apply - map at least one document to a register entry');
  const res = await saveMaster(updates.map(({ it, e }) => ({ row: e.row, issued: it.issued || '', expiry: it.expiry || '', due: it.due || '' })), id, log);
  const docs = { ...(cfg._facility.documents || {}) };
  for (const { it, e } of updates) {
    let kept = null;
    try {
      const src = uploadFile(it.token, ENTRY_DOC_EXTS);
      const dir2 = path.join(facilityHome(cfg._facility), 'documents');
      fs.mkdirSync(dir2, { recursive: true });
      kept = path.join(dir2, `${e.name.replace(/[^\w .()&-]+/g, '_').slice(0, 60)}${path.extname(src)}`);
      fs.copyFileSync(src, kept);
      fs.rmSync(src, { force: true });
    } catch { /* upload already cleaned up - the dates are still applied */ }
    docs[e.name] = { file: kept || docs[e.name]?.file || null, original: it.file || null, issued: it.issued || '', expiry: it.expiry || '', appliedAt: new Date().toISOString() };
  }
  updateFacility(id, { documents: docs });
  const releaseDate = await syncReleaseDate(id, log);
  return { ...res, applied: updates.map(u => u.e.name), releaseDate };
}

/** Parse result without the logo bytes (for the browser): logo -> { ext, width, height, dataUrl }. */
export function parsedForClient(parsed) {
  const { logo, ...rest } = parsed;
  return { ...rest, logo: logo ? { ext: logo.ext, width: logo.width, height: logo.height, dataUrl: `data:image/${logo.ext === 'jpg' ? 'jpeg' : logo.ext};base64,${logo.buffer.toString('base64')}` } : null };
}
