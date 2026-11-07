// Configuration for a multi-facility deployment.
//
//   config.json      - global: DoH site, compliance rules, schedule, e-mail server, safety, workbook layout.
//                      Identical for every facility.
//   facilities.json  - one entry per facility: title, code, document-control people, responsible persons,
//                      its own master Excel register, e-mail recipients and working folder.
//
// loadConfig(facilityId) returns the global config merged with one facility, in the shape the rest of the
// code uses (cfg.register.path, cfg.branch, cfg.documentControl.values, ...). Per-facility working folders
// (data, reports, backups, logs) live in the facility's home folder; downloaded circulars and secrets are shared.
// DOH_PORTAL_CONFIG can point to another config file (the tests use this).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Replace dest with tmp. rename() is atomic; some redirected/virtualised folders refuse it
 * (EXDEV), in which case the file is copied over and the temp file removed.
 */
export function replaceFile(tmp, dest) {
  try { fs.renameSync(tmp, dest); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(tmp, dest);
    fs.rmSync(tmp, { force: true });
  }
}

const writeJson = (file, data) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n'); replaceFile(tmp, file); };

export function configPath() {
  return process.env.DOH_PORTAL_CONFIG ? path.resolve(process.env.DOH_PORTAL_CONFIG) : path.join(APP_DIR, 'config.json');
}
export const facilitiesPath = () => path.join(path.dirname(configPath()), 'facilities.json');

/** The IT Department entry is fixed and identical for every facility (not configurable). */
export const IT_DEPARTMENT = 'IT Department (3rd-Party IT Service Provider)';

/** Standard elements that are identical in every deployment and can never be edited. */
export const FIXED = Object.freeze({
  registerTitle: 'LEGAL REGISTER',
  docControlLabel: 'A. Document Control',
  numberSuffix: ' / LGL REGISTER',
  version: '1.0',
  classification: 'RESTRICTED / داخلي',
  docLabels: { B3: 'A. Document Control', B4: 'Document Number', B5: 'Date of Release', B6: 'Document Approver', B7: 'Document Author(s)', B8: 'Version No.', B9: 'Document Classification' },
  masterHeaders: { B2: 'LEGAL REGISTER', B3: 'SL NO', C3: 'NAME OF DEPARTMENT', D3: 'ISSUED DATE', E3: 'EXPIRY DATE', F3: 'DUE DATE', G3: 'RESPONSIBLE PERSON', H3: 'COMPLIANCE' },
  coreLaws: ['Federal Law No. (5) of 2019', 'FEDERAL LAW NO. 2', 'Federal Law No. (13) of 2020', 'FEDERAL DECREE LAW NO. 33', 'FEDERAL DECREE LAW NO. 45', 'FEDERAL DECREE-LAW NO. 18'],
});
export const documentNumber = code => `${code}${FIXED.numberSuffix}`;
export const lawKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const isCoreLaw = name => FIXED.coreLaws.some(l => lawKey(l) === lawKey(name));

/** Defaults for sections added later, so older config files keep working. */
const DEFAULTS = {
  master: {
    sheet: 'LEGAL REGISTER', firstRow: 4, maxRows: 60,
    columns: { sl: 'B', name: 'C', issued: 'D', expiry: 'E', due: 'F', responsible: 'G', compliance: 'H' },
    labels: { compliant: 'Fully Compliant', notApplicable: 'Not Applicable' }, noDate: '______',
  },
  documentControl: {
    sheet: 'DOCUMENT CONTROLLER',
    cells: { facilityTitle: 'B2', documentNumber: 'C4', releaseDate: 'C5', approver: 'C6', authors: 'C7', version: 'C8', classification: 'C9' },
  },
};
function fill(into, from) {
  for (const [k, v] of Object.entries(from)) {
    if (into[k] === undefined) into[k] = structuredClone(v);
    else if (v && typeof v === 'object' && !Array.isArray(v) && into[k] && typeof into[k] === 'object') fill(into[k], v);
  }
}

// Keys of config.json that belong to a facility (moved to facilities.json on first start).
function stripFacilityKeys(g) {
  const out = structuredClone(g);
  delete out.branch;
  if (out.register) { delete out.register.path; delete out.register.scopeStartDate; }
  if (out.documentControl) delete out.documentControl.values;
  if (out.master) { delete out.master.editableCount; delete out.master.fixedCount; }
  if (out.facility) { delete out.facility.id; delete out.facility.code; delete out.facility.name; }
  return out;
}

export function loadGlobalConfig() {
  const file = configPath();
  const g = JSON.parse(fs.readFileSync(file, 'utf8'));
  fill(g, DEFAULTS);
  g._file = file;
  g._globalDir = path.dirname(file);
  g._baseDir = g._globalDir;
  return g;
}

export const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'facility';

/** Facility registry. Created from the single-facility config.json on first use (that facility keeps its folders). */
export function loadFacilities() {
  const file = facilitiesPath();
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const g = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  const dc = g.documentControl?.values || {};
  const code = String(dc.documentNumber || 'MAIN').split('/')[0].trim() || 'MAIN';
  const responsible = g.branch?.responsible ?? g.compliance?.responsible ?? '';
  const fac = {
    id: slug(code), code, name: g.branch?.name || code,
    title: dc.facilityTitle || `${code} - ${FIXED.registerTitle}`,
    releaseDate: dc.releaseDate || '', approver: dc.approver || '', authors: dc.authors || '',
    responsible, responsibleOptions: g.branch?.responsibleOptions?.length ? g.branch.responsibleOptions : [responsible].filter(Boolean),
    register: { path: g.register?.path || '', scopeStartDate: g.register?.scopeStartDate || '2026-01-01' },
    emailTo: [], home: '.',
  };
  const data = { default: fac.id, list: [fac] };
  writeJson(file, data);
  writeJson(configPath(), stripFacilityKeys(g));
  return data;
}

export function saveFacilities(data) { writeJson(facilitiesPath(), data); }

export function facilityHome(fac) {
  const base = path.dirname(configPath());
  return fac.home ? path.resolve(base, fac.home) : path.join(base, 'facilities', fac.id);
}

export function getFacility(id) {
  const data = loadFacilities();
  const fac = data.list.find(f => f.id === (id || data.default)) || (!id ? data.list[0] : null);
  if (!fac) throw new Error(`Unknown facility: ${id}`);
  return fac;
}

/**
 * Files the portal created inside its own facilities/ folder (registers, logos, documents) are found again after the
 * whole portal folder has been moved or copied elsewhere: a stored absolute path that no longer exists is re-based
 * on the current portal folder. Paths outside the portal (e.g. a register on D:\ or a network share) are kept as is.
 */
function relocate(p, base) {
  if (!p) return p;
  const norm = String(p).replace(/\//g, path.sep);
  const at = norm.toLowerCase().lastIndexOf(`${path.sep}facilities${path.sep}`);
  if (at < 0) return p;
  // Always prefer this portal folder's own copy (the old folder may still exist after a copy).
  const here = path.join(base, norm.slice(at + 1));
  return fs.existsSync(here) ? here : p;
}
function relocateFacility(f, base) {
  const out = structuredClone(f);
  if (out.register?.path) out.register.path = relocate(out.register.path, base);
  if (out.logo) out.logo = relocate(out.logo, base);
  if (out.policyPath) out.policyPath = relocate(out.policyPath, base);
  for (const d of Object.values(out.documents || {})) if (d?.file) d.file = relocate(d.file, base);
  return out;
}

/** Global config merged with one facility (default facility when id is omitted). */
export function loadConfig(facilityId) {
  const fac = relocateFacility(getFacility(facilityId), path.dirname(configPath()));
  const g = loadGlobalConfig();
  const home = facilityHome(fac);
  fs.mkdirSync(home, { recursive: true });
  const cfg = structuredClone({ ...g, _file: undefined, _globalDir: undefined, _baseDir: undefined });
  cfg.register = { ...g.register, path: fac.register?.path ? path.resolve(home, fac.register.path) : '', scopeStartDate: fac.register?.scopeStartDate || g.register.scopeStartDate || '2026-01-01' };
  cfg.branch = { name: fac.name, responsible: fac.responsible, responsibleOptions: fac.responsibleOptions || [] };
  cfg.documentControl = {
    ...g.documentControl,
    values: {
      facilityTitle: fac.title, documentNumber: documentNumber(fac.code), releaseDate: fac.releaseDate || '',
      approver: fac.approver || '', authors: fac.authors || '', version: FIXED.version, classification: FIXED.classification,
    },
  };
  cfg.email = { ...g.email, to: fac.emailTo?.length ? fac.emailTo : g.email?.to || [] };
  cfg.facility = { ...g.facility, id: fac.id, code: fac.code, name: fac.name };
  cfg._facility = fac;
  cfg._file = g._file;
  cfg._globalDir = g._globalDir;
  cfg._baseDir = home;
  return cfg;
}

/** Save the global (shared) part of a config. Facility fields are ignored here; use updateFacility. */
export function saveConfig(cfg) {
  const { _file, _baseDir, _globalDir, _facility, ...data } = cfg;
  writeJson(_file, stripFacilityKeys(data));
}

/** Update one facility's entry in facilities.json. */
export function updateFacility(id, fields) {
  const data = loadFacilities();
  const fac = data.list.find(f => f.id === id);
  if (!fac) throw new Error(`Unknown facility: ${id}`);
  Object.assign(fac, fields);
  saveFacilities(data);
  return fac;
}

/** Working folders: data, reports, backups and logs per facility; downloaded circulars are shared. */
export function dir(cfg, name) {
  const base = name === 'downloads' ? (cfg._globalDir || cfg._baseDir) : cfg._baseDir;
  const p = path.join(base, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const secretsFile = cfg => { const d = path.join(cfg._globalDir || cfg._baseDir, 'data'); fs.mkdirSync(d, { recursive: true }); return path.join(d, 'secrets.json'); };
export function readSecrets(cfg) {
  try { return JSON.parse(fs.readFileSync(secretsFile(cfg), 'utf8')); }
  catch { return {}; }
}

export function writeSecrets(cfg, secrets) {
  fs.writeFileSync(secretsFile(cfg), JSON.stringify(secrets, null, 2));
}
