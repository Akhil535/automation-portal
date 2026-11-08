// HR & onboarding forms and the ADHICS document checklist of each facility.
//
// HR forms (NDA, orientation checklist, background verification, IT/EMR new user form, disciplinary process,
// acceptable usage acknowledgement, IT quiz, IT awareness training, exit clearance) are master Word files that belong
// to the master template. They may come from different facilities: each master is cross-checked when it is added -
// the facility names, Ref No codes, people and logo it carries are recorded - and every one of them is replaced with
// the facility's own name, code and centred logo whenever a form is viewed or downloaded. Nothing of another facility
// may remain: each filled form is read back and checked.
//
// The Acceptable Usage Acknowledgement follows the Acceptable Usage Policy (PO11): its Policy ID, Issued on,
// Reviewed on, Due for revision, Prepared / Approved by, facility name and version come from exactly the same
// settings as PO11, and are compared with the generated PO11 policy.
//
// Masters are never changed; filled forms are made fresh from the current settings every time.
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { dir, facilityHome, loadConfig, loadGlobalConfig } from './config.js';
import { docToDocx } from './docparse.js';
import { imageSize } from './imagesize.js';
import { STATUSES, buildChecklistXlsx, countStatuses, parseChecklistXlsx } from './checklistxlsx.js';
import {
  MAJOR_REVISION, _internal, fillPolicy, generatedFiles, inspectTemplate, outputDirs, plusOneYear, prepSettings, printPics, templateLock, wordToPdf,
} from './policyprep.js';

const { tables, textOf, labelOf, squash, replaceInParagraphs, sha256, cellWithText } = _internal;

// ---------------------------------------------------------------------------------------------------
// The HR forms and the checklist items they belong to
// ---------------------------------------------------------------------------------------------------
/** Document groups: each has its own page section, reference series and date settings. */
export const GROUPS = {
  hr: { title: 'HR & onboarding', series: 'HR' },
  training: { title: 'Employee training', series: 'HR' },
  thirdparty: { title: '3rd-party documents', series: 'TP' },
};
// group: where the document belongs; dates: which date setting fills its date fields (one date for all by default)
export const HR_FORMS = [
  { key: 'nda', no: 1, group: 'hr', title: 'NDA / Confidentiality Agreement', match: /confidential|non[-\s]?disclosure|\bnda\b/i },
  { key: 'orientation', no: 2, group: 'hr', title: 'Orientation Checklist', match: /orientation/i },
  { key: 'background', no: 3, group: 'hr', title: 'Background Verification Form', match: /background\s*verification/i },
  { key: 'user', no: 4, group: 'hr', title: 'IT / EMR New User Form', match: /user\s*creation|new\s*user/i },
  { key: 'disciplinary', no: 5, group: 'hr', title: 'Disciplinary Process Acknowledgement', match: /disciplin/i },
  { key: 'aup', no: 6, group: 'hr', title: 'Acceptable Usage Acknowledgement', match: /acceptable\s*us(ag)?e/i, policy: 11 },
  { key: 'quiz', no: 7, group: 'hr', title: 'IT Quiz', match: /\bquiz\b/i },
  { key: 'awareness', no: 8, group: 'hr', title: 'IT Awareness Training – Onboarding', match: /awareness\s*training/i },
  { key: 'exit', no: 9, group: 'hr', title: 'Exit Clearance Form', match: /exit\s*clearance|staff\s*clearance|clearance\s*form/i },
  { key: 'trainingreport', no: 10, group: 'training', dates: 'training', fields: true, title: 'Employee Training Report', match: /training\s*report/i },
  { key: 'policyack', no: 11, group: 'training', dates: 'training', title: 'Policy Acknowledgement', match: /policy\s*acknowledg/i },
  { key: 'tpnda', no: 1, group: 'thirdparty', dates: 'thirdparty', title: 'Third-Party NDA / Confidentiality Agreement', match: /third\s*party[\s\S]*(nda|confiden)|(\bnda\b|confiden)[\s\S]*third\s*party/i },
  { key: 'tpaup', no: 2, group: 'thirdparty', dates: 'thirdparty', title: 'Third-Party Acceptable Usage Acknowledgement', match: /third\s*party[\s\S]*acceptable|acceptable[\s\S]*third\s*party/i, policy: 11 },
];
const formDef = key => HR_FORMS.find(f => f.key === key);
const seriesOf = def => GROUPS[def.group]?.series || 'HR';
/** Which document a name or heading means (third-party and training documents are recognised first). */
export const matchForm = text => [...HR_FORMS.filter(f => f.group !== 'hr'), ...HR_FORMS.filter(f => f.group === 'hr')].find(f => f.match.test(text)) || null;
/** The form a checklist item of the HR section refers to. */
export const formForItem = name => (/calend[ae]r/i.test(name) ? null : matchForm(name)?.key || null);
const policyForItem = name => Number(String(name).match(/^\s*PO\s*0*(\d{1,2})\b/i)?.[1] || 0) || null;

/** The default checklist (from ADHICS CHECKLIST.xlsx); the master template can replace it with an uploaded workbook. */
const DEFAULT_CHECKLIST = [
  { id: 'hr', sheet: 'ADHICS CHECKLIST_FACILITY', heading: 'ADHICS CHECK LIST - FACILITY SIDE', title: 'HR & facility', items: [
    'EMPLOYEE REGISTER ACTIVE LIST', 'EMPLOYEE REGISTER INACTIVE LIST', 'NDA / CONFIDENTIALITY AGREEMENT', 'ORIENTATION CHECK LIST',
    'BACKGROUND VERIFICATION', 'IT/EMR NEW USER FORM', 'DISCIPLINARY PROCESS', 'ACCEPTABLE USAGE ACKNOWLEDGEMENT', 'IT QUIZ',
    'IT AWARENESS TRAINING - ONBOARDING', 'ADHICS POLICY ACKNOWLEDGEMENT - VERSION 2', 'EMPLOYEE TRAINING REPORT', 'EXIT CLEARANCE FORM (STAFF CLEARANCE)',
    'CYBER LEARNING CERTIFICATES FOR MEDICAL STAFFS', 'DATA FLOW OF MEDICAL STAFFS', 'POLICE CLEARANCE CERTIFICATES FOR NON - MEDICAL STAFFS',
    "WHO DOESN'T HAVE RECENT DATAFLOW, THOSE MEDICAL STAFFS ADDITIONALLY REQUIRE A POLICE CLEARANCE CERTIFICATE.",
    'MEDICAL EQUIPMENT LIST', 'MEDICAL DEVICES PPM REPORT', 'LEGAL DOCUMENTS', 'THIRD PARTY NDA / CONFIDENTIALITY AGREEMENT - INDIVIDUAL',
    'THIRD PARTY ACCEPTABLE USAGE ACKNOWLEDGEMENT', 'VISITOR LOG BOOK', 'SERVER/CCTV LOG BOOK'] },
  { id: 'it', sheet: 'ADHICS CHECKLIST_IT', heading: 'ADHICS CHECK LIST - IT DOCUMENTS', title: 'IT documents', items: [
    'IT INFRASTRUCTURE ACCESS REVIEW REPORT', 'SECURED AREA', 'KEY INVENTORY', 'IT/ADHICS CONTRACT', 'AWARENESS TRAINING CALENDER', 'LEGAL REGISTER',
    'MEDICAL ASSET INVENTORY', 'DOCUMENT TRACKER', 'CYBER SECURITY PPT', 'CHANGE REQUEST FORM', 'INCIDENT REPORT', 'IT ASSET INVENTORY', 'NETWORK DIAGRAM', 'RISK REGISTER'] },
  { id: 'emr', sheet: 'ADHICS CHECKLIST_EMR', heading: 'ADHICS CHECK LIST - EMR DOCUMENTS & OTHERS', title: 'EMR & others', items: [
    'EMR ACCESS REVIEW REPORT', 'EMR ACCESS PREVILEGE EVIDENCE', 'DATA PRIVACY CONSENT COLLECTION', 'EMR CONTRACT - NDA & SLA AGREEMENT',
    'DATA BACKUP RESTORATION TEST EVIDENCES', 'VAPT REPORT', 'BACKGROUND VERIFICATION FORM / PCC CERTIFICATE', 'EMR CONFIGURATION - ADHICS STANDARD'] },
  { id: 'policies', sheet: 'ADHICS CHECKLIST_POLICIES', heading: 'ADHICS CHECK LIST- POLICY', title: 'Policies', items: [
    'PO01-INFORMATION SECURITY HIGH LEVEL POLICY', 'PO02-HUMAN RESOURCE SECURITY POLICY', 'PO03-INFORMATION ASSET MANAGEMENT POLICY', 'PO04-OPERATION SECURITY POLICY',
    'PO05-ELECRONIC COMMUNICATION USAGE POLICY', 'PO06-CLEAR DESK AND CLEAR SCREEN POLICY', 'PO07-ACCESS CONTROL POLICY',
    'PO08-INFORMATION SYSTEMS ACQUISITION DEVELOPMENT MAINTENANCE SECURITY POLICY', 'PO09-REMOTE ACCESS SECURITY POLICY', 'PO10-HEALTH INFORMATION AND SECURITY POLICY',
    'PO11-ACCEPTABLE USAGE POLICY', 'PO12-THIRD PARTY SECURITY POLICY', 'PO13-PHYSICAL AND ENVIRONMENTAL POLICY', 'PO14-INFORMATION SYSTEM CONTINUITY POLICY',
    'PO15-CRYPTOGRAPH ENCRYPTION KEY MANAGEMENT POLICY', 'PO16-PATCH MANAGEMENT POLICY AND PROCEDURE', 'PO17-ACCEPTABLE USE OF IT EQUIPMENTS POLICY',
    'PO18-INFORMATION SECURITY INCIDENTS MANAGEMENTS POLICY', 'PO19-RISK MANAGEMENT POLICY AND PROCEDURES', 'PO20-DOWNTIME POLICY', 'PO21-RETENTION AND DISPOSAL POLICY',
    'PO22-CHANGE MANAGEMENT POLICY', 'PO23-INFORMATION DATA BACKUP POLICY', 'PO24-ASSET DISPOSAL PROCEDURE', 'PO25-PASSWORD SECURITY POLICY', 'PO26-ANTIVIRUS POLICY',
    'PO27-COMPLAINCE POLICY', 'PO28-INTERNET USAGE POLICY', 'PO29-DATA PRIVACY AND PROTECTION POLICY', 'PO30-CLOUD SECURITY POLICY', 'PO31-BASELINE SECURITY POLICY',
    'PO32-DOCUMENT CONTROLLER PROCEDURE POLICY'] },
];

// ---------------------------------------------------------------------------------------------------
// Storage: masters (global, part of the master template) and each facility's checklist
// ---------------------------------------------------------------------------------------------------
const mastersDir = () => { const d = path.join(dir(loadGlobalConfig(), 'data'), 'hr-templates'); fs.mkdirSync(d, { recursive: true }); return d; };
const indexFile = () => path.join(mastersDir(), 'forms.json');
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => { const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); };
const loadIndex = () => readJson(indexFile(), {});
const hrHome = cfg => { const d = path.join(facilityHome(cfg._facility), 'hr'); fs.mkdirSync(d, { recursive: true }); return d; };

// ---------------------------------------------------------------------------------------------------
// Cross-checking a master: which facility it was written for
// ---------------------------------------------------------------------------------------------------
const TYPE = '(?:(?:MEDICAL|DENTAL|SPECIALI[SZ]ED|SPECIALTY|DIAGNOSTIC|SURGICAL|DAY\\s+SURGERY|ONE\\s+DAY\\s+SURGERY|HOME\\s+HEALTH\\s*CARE|HEALTH\\s*CARE|REHABILITATION|PHYSIOTHERAPY|FAMILY|MULTI\\s*SPECIALITY)\\s+(?:CENTRE|CENTER|CLINIC|CLINICS)|POLY\\s?CLINIC|HOSPITAL|HOME\\s+HEALTH\\s*CARE|PHARMACY|LABORATORY|MEDICAL\\s+CLINIC)';
const NAME_RE = () => new RegExp(`\\b((?:[A-Za-z][A-Za-z0-9&'.-]*[ \\t\\u00a0]+){1,6})${TYPE}(?:\\s+L\\.?\\s?L\\.?\\s?C\\b\\.?|\\s+O\\.?P\\.?C\\b\\.?)?`, 'gi');
const STOP = new Set(['THE', 'OF', 'AT', 'TO', 'IN', 'BY', 'FOR', 'AND', 'WITH', 'FROM', 'ALL', 'ON', 'AS', 'IS', 'A', 'AN', 'OR', 'YOUR', 'OUR', 'THIS', 'THAT', 'ANY',
  'EACH', 'EVERY', 'OTHER', 'NEW', 'EMPLOYMENT', 'INFORMATION', 'PATIENT', 'PATIENTS', 'STAFF', 'EMPLOYEE', 'EMPLOYEES', 'USERS', 'USER', 'DOH', 'ABU', 'DHABI', 'UAE',
  'ENTITY', 'FACILITY', 'NAME', 'NAMES', 'PREMISES', 'WITHIN', 'OUTSIDE', 'INSIDE', 'VISIT', 'VISITING', 'BELONGING', 'PROVIDED', 'ISSUED', 'WHEN', 'WHILE', 'AWAY', 'ABOUT']);
/** Facility names in a text, e.g. "PURECARE MEDICAL CENTRE", "GENET DENTAL CENTER LLC", "DR ATIQUR RAHMAN POLYCLINIC LLC". */
export function facilityNamesIn(text) {
  const out = new Map();
  for (const m of String(text || '').matchAll(NAME_RE())) {
    const words = m[1].trim().split(/\s+/);
    // the name starts after the last lowercase / generic word ("information PURECARE ...", "OF THE GENET ...")
    let k = words.length;
    while (k > 0 && /^[A-Z0-9&]/.test(words[k - 1]) && !STOP.has(words[k - 1].toUpperCase().replace(/[^A-Z]/g, ''))) k--;
    const own = words.slice(k);
    if (!own.length) continue;
    const name = squash(`${own.join(' ')} ${m[0].slice(m[1].length)}`).replace(/[.,]$/, '').toUpperCase();
    if (name.length > 4) out.set(name.replace(/[^A-Z0-9]/g, ''), name);
  }
  return [...out.values()];
}
const REF_RE = () => /Ref\.?\s*No\.?\s*[:.]?\s*([A-Z]{2,8})\s*-\s*HR\s*-\s*((?:\d\s*){1,3})/gi;
const allText = async zip => {
  const parts = Object.keys(zip.files).filter(f => /^word\/(document|header\d*|footer\d*)\.xml$/.test(f));
  const out = [];
  for (const p of parts) out.push(((await zip.file(p).async('string')).match(/<w:p(?=[\s>])(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g) || []).map(textOf).join('\n'));
  return out.join('\n');
};

// ---------------------------------------------------------------------------------------------------
// Dates and details inside the documents
// ---------------------------------------------------------------------------------------------------
const DATE_RE = () => /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
const PARA_RE = () => /<w:p(?=[\s>])(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g;
/** The table row (innermost) around a position, and whether it is a policy field (Policy ID, Issued on ...). */
function rowAt(rows, at) { return rows.filter(r => r.s <= at && r.e >= at).sort((a, b) => b.s - a.s)[0] || null; }
/**
 * Date fields of a document: every paragraph with a date (dd/mm/yyyy), in document order - e.g. "Date of Training",
 * each training module's date, each policy's acknowledgement date. Policy fields (Issued on, Reviewed on, Due for
 * revision) are not included: they always follow the policy. Each field has a label to show in the dates panel.
 */
export function dateSlots(xml) {
  const rows = tables(xml).flatMap(t => t.rows);
  const slots = [];
  for (const m of xml.matchAll(PARA_RE())) {
    const t = textOf(m[0]);
    if (!DATE_RE().test(t)) continue;
    const row = rowAt(rows, m.index);
    let label;
    if (row) {
      const cells = row.cells.map(c => squash(textOf(xml.slice(c.s, c.e))));
      if (labelOf(cells[0])) continue;
      label = cells.filter(c => c && !DATE_RE().test(c) && !/^[\d.]+$/.test(c)).slice(0, 2).join(' · ') || cells[0];
    } else label = squash(t.replace(DATE_RE(), '')).replace(/[:\s–-]+$/, '') || 'Date';
    label = label.replace(/\b[A-Z]{2,8}\s*\/\s*ADHICS\s*[-–]\s*/g, '');
    slots.push({ i: slots.length, label: label.slice(0, 90), value: t.match(DATE_RE())[0] });
  }
  return slots;
}
/** Put the dates in: valueOf(i) gives dd/mm/yyyy for date field i (or null to keep it). */
function setDates(xml, valueOf) {
  const rows = tables(xml).flatMap(t => t.rows);
  let i = 0, count = 0;
  const out = xml.replace(PARA_RE(), (para, at) => {
    if (!DATE_RE().test(textOf(para))) return para;
    const row = rowAt(rows, at);
    if (row && labelOf(squash(textOf(xml.slice(row.cells[0].s, row.cells[0].e))))) return para;
    const v = valueOf(i++);
    if (!v) return para;
    const r = replaceInParagraphs(para, DATE_RE(), v); count += r.count;
    return r.xml;
  });
  return { xml: out, count };
}
/** Editable details of the training report (the training company and trainer of the master). */
const FIELD_RES = {
  provider: [/Training Provided by\s+(?!:)(.+?)\.?\s*$/im, 'Training company'],
  trainer: [/Training Provided By:\s*(.+?)(?:\s{2,}|$)/im, 'Trainer'],
  designation: [/^Designation:\s*(.+?)\s*$/im, 'Trainer designation'],
  location: [/^Location:\s*(.+?)\s*$/im, 'Location'],
};
const detailsIn = text => Object.fromEntries(Object.entries(FIELD_RES).map(([k, [re]]) => [k, squash(text.match(re)?.[1] || '')]).filter(([, v]) => v && !/^_+$/.test(v)));
const infoMemo = new Map();
/** Date fields and details of a master (kept per master fingerprint). */
async function masterInfo(master) {
  if (infoMemo.has(master.sha)) return infoMemo.get(master.sha);
  const z = await JSZip.loadAsync(fs.readFileSync(path.join(mastersDir(), master.file)));
  const xml = await z.file('word/document.xml').async('string');
  const text = (xml.match(PARA_RE()) || []).map(textOf).join('\n');
  const info = { slots: dateSlots(xml), details: detailsIn(text) };
  infoMemo.set(master.sha, info);
  return info;
}
/** Per facility: the date of each date setting, per-document manual dates, and edited details. */
const docSettingsFile = cfg => path.join(hrHome(cfg), 'documents.json');
export function docSettings(id) { return readJson(docSettingsFile(loadConfig(id)), { groups: {}, docs: {}, details: {} }); }
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Save date / detail settings. body: { group, date } - one date for every document of that group (global sync);
 * { key, date } - one date for this document only (all its date fields), '' = follow the group date again;
 * { key, details: { provider, trainer, designation, location } }.
 */
export function saveDocSettings(id, body = {}) {
  const cfg = loadConfig(id);
  const ds = readJson(docSettingsFile(cfg), { groups: {}, docs: {}, details: {} });
  const day = v => { if (v && !ISO_DAY.test(v)) throw new Error('Use a date'); return v || ''; };
  if (body.group) { if (!['training', 'thirdparty'].includes(body.group)) throw new Error('Unknown date setting'); ds.groups[body.group] = day(body.date); }
  if (body.key) {
    if (!formDef(body.key)) throw new Error('No such document');
    if (body.date !== undefined) { const d = day(body.date); if (d) ds.docs[body.key] = { date: d }; else delete ds.docs[body.key]; }
    if (body.details) ds.details[body.key] = Object.fromEntries(Object.entries(body.details).filter(([k]) => FIELD_RES[k]).map(([k, v]) => [k, String(v || '').trim().slice(0, 120)]));
  }
  writeJson(docSettingsFile(cfg), ds);
  return ds;
}
/** The date (YYYY-MM-DD) of a document: its own date, else the group date (3rd-party: else the policy review date). */
const docDate = (def, ds, s) => ds.docs?.[def.key]?.date || ds.groups?.[def.dates] || (def.dates === 'thirdparty' ? s.reviewedOn : '') || '';
/** Every date field of the document gets the document's one date. */
function datesFor(def, ds, s, count) {
  if (!def.dates) return null;
  const d = docDate(def, ds, s);
  return Array.from({ length: count }, () => d);
}

/** In a table of policies ("CODE / ADHICS - PO03 | name | 2.0 | date"), the version is the one used for this facility. */
function policyVersions(xml, s) {
  const edits = [];
  for (const t of tables(xml)) for (const r of t.rows) {
    const cells = r.cells.map(c => squash(textOf(xml.slice(c.s, c.e))));
    const po = cells.map(c => c.match(/ADHICS\s*[-–]\s*PO\s*0*(\d{1,2})\b/i)).find(Boolean);
    const vc = cells.findIndex(c => /^\d+\.\d$/.test(c));
    if (!po || vc < 0) continue;
    const n = Number(po[1]);
    const want = s.versions?.[n] || (MAJOR_REVISION.includes(n) ? '2.0' : '1.0');
    if (cells[vc] !== want) edits.push({ s: r.cells[vc].s, e: r.cells[vc].e, xml: cellWithText(xml.slice(r.cells[vc].s, r.cells[vc].e), want, { center: true }) });
  }
  for (const ed of edits.sort((a, b) => b.s - a.s)) xml = xml.slice(0, ed.s) + ed.xml + xml.slice(ed.e);
  return xml;
}

/** Standard reference number of an HR form: Ref. No.: CODE/HR/FORM-01. */
export const refNumber = (code, no, series = 'HR') => `${code}/${series}/FORM-${String(no).padStart(2, '0')}`;

/**
 * The Ref. No. line in the header, under the logo: right-aligned, small, no extra spacing (the body does not move
 * down a page). Added to every header that carries the logo - or, without a logo, to the default / first-page headers.
 */
async function addHeaderRef(buffer, refNo) {
  const zip = await JSZip.loadAsync(buffer);
  const doc = await zip.file('word/document.xml').async('string');
  const rels = await zip.file('word/_rels/document.xml.rels').async('string');
  const used = [...doc.matchAll(/<w:headerReference\b[^>]*w:type="(default|first|even)"[^>]*r:id="([^"]+)"|<w:headerReference\b[^>]*r:id="([^"]+)"[^>]*w:type="(default|first|even)"/g)]
    .map(m => ({ type: m[1] || m[4], rid: m[2] || m[3] }))
    .map(h => ({ ...h, part: 'word/' + (rels.match(new RegExp(`Id="${h.rid}"[^>]*Target="([^"]+)"`))?.[1] || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${h.rid}"`))?.[1] || '') }))
    .filter(h => zip.file(h.part));
  const xmls = await Promise.all(used.map(h => zip.file(h.part).async('string')));
  let targets = used.filter((h, i) => /<w:drawing|<w:pict/.test(xmls[i]));
  if (!targets.length) targets = used.filter(h => h.type !== 'even');
  const para = `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:b/><w:color w:val="1F3864"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">Ref. No.: ${refNo.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`;
  for (const part of [...new Set(targets.map(t => t.part))]) {
    const x = await zip.file(part).async('string');
    zip.file(part, x.replace(/<\/w:hdr>\s*$/, `${para}</w:hdr>`));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/**
 * Centre the header logo on the PAGE, not just between the margins: masters with unequal left / right margins
 * (e.g. 2.2 cm / 1.2 cm) would otherwise show the logo several millimetres to one side. The logo paragraph gets an
 * indent of the margin difference on the narrow side.
 */
async function centreLogoOnPage(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const doc = await zip.file('word/document.xml').async('string');
  const mar = [...doc.matchAll(/<w:pgMar\b[^>]*>/g)].pop()?.[0] || '';
  const L = Number(mar.match(/w:left="(-?\d+)"/)?.[1] || 0), R = Number(mar.match(/w:right="(-?\d+)"/)?.[1] || 0);
  const d = L - R;
  if (Math.abs(d) < 30) return buffer; // already symmetric (within 0.5 mm)
  const ind = `<w:ind w:left="${d < 0 ? -d : 0}" w:right="${d > 0 ? d : 0}"/>`;
  for (const part of Object.keys(zip.files).filter(f => /^word\/header\d*\.xml$/.test(f))) {
    const x = await zip.file(part).async('string');
    if (!/<w:drawing/.test(x)) continue;
    const y = x.replace(/<w:p(?=[\s>])(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g, p => {
      if (!/<w:drawing/.test(p)) return p;
      if (/<w:pPr>/.test(p)) return p.replace(/<w:pPr>([\s\S]*?)<\/w:pPr>/, (m, inner) => {
        const clean = inner.replace(/<w:ind\b[^>]*\/>/g, '');
        const at = clean.search(/<w:(contextualSpacing|mirrorIndents|suppressOverlap|jc|textDirection|textAlignment|textboxTightWrap|outlineLvl|divId|cnfStyle|rPr|sectPr|pPrChange)\b/);
        return `<w:pPr>${at >= 0 ? clean.slice(0, at) + ind + clean.slice(at) : clean + ind}</w:pPr>`;
      });
      return p.replace(/^<w:p(\s[^>]*)?>/, m => `${m}<w:pPr>${ind}<w:jc w:val="center"/></w:pPr>`);
    });
    zip.file(part, y);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** What a master HR form contains and which facility it was written for. */
export async function inspectForm(buffer, name = '') {
  const zip = await JSZip.loadAsync(buffer);
  const doc = await zip.file('word/document.xml')?.async('string');
  if (!doc) throw new Error(`${name}: not a Word document`);
  const text = await allText(zip);
  const heading = (doc.match(/<w:p(?=[\s>])(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g) || []).map(p => squash(textOf(p))).find(Boolean) || '';
  const base = path.basename(name, path.extname(name)).replace(/^\d+[_\s.-]*/, '');
  const def = matchForm(base) || matchForm(heading);
  const refs = [...text.matchAll(REF_RE())];
  const info = await inspectTemplate(buffer, name).catch(() => ({}));
  const names = new Set(facilityNamesIn(text));
  for (const v of info.nameVariants || []) names.add(v.replace(/\.$/, ''));
  // codes of the master's facility: Ref No, the Policy ID cell, and policy IDs in the text ("CMC / ADHICS - PO01")
  const idCodes = [...text.matchAll(/\b([A-Z]{2,8})\s*\/\s*ADHICS\s*[-–]\s*PO\s*\d+/g)].map(m => m[1]);
  const codes = [...new Set([...refs.map(r => r[1].toUpperCase()), info.labels?.includes('policyId') ? info.oldCode : '', ...idCodes].filter(c => /^[A-Z0-9]{2,12}$/.test(c || '') && c !== 'ADHICS'))];
  let hasLogo = false;
  for (const h of Object.keys(zip.files).filter(f => /^word\/header\d*\.xml$/.test(f))) if (/<w:drawing|<w:pict/.test(await zip.file(h).async('string'))) hasLogo = true;
  const labels = [];
  for (const t of tables(doc)) for (const r of t.rows) { if (r.cells.length < 2) continue; const k = labelOf(textOf(doc.slice(r.cells[0].s, r.cells[0].e))); if (k && !labels.includes(k)) labels.push(k); }
  return {
    key: def?.key || null, heading, original: name, names: [...names].sort((a, b) => b.length - a.length), codes,
    refNo: refs[0] ? squash(refs[0][0]) : '', no: Number(refs[0]?.[2]?.replace(/\s/g, '') || name.match(/^(\d+)/)?.[1] || def?.no || 0),
    people: info.people || {}, labels, hasLogo,
  };
}

/** Add / replace master HR forms. files: [{ name, buffer }], key: force the form (when the name does not say). */
export async function addForms(files, { key: forced } = {}) {
  const index = loadIndex();
  const added = [], problems = [];
  for (const f of files) {
    try {
      const ext = path.extname(f.name).toLowerCase();
      if (!['.docx', '.doc'].includes(ext)) throw new Error('Word documents only (.docx or .doc)');
      const buffer = ext === '.doc' ? await docToDocx(f.buffer) : f.buffer;
      const info = await inspectForm(buffer, f.name);
      const key = forced && formDef(forced) ? forced : info.key;
      if (!key) throw new Error('could not tell which HR form this is – choose the form it replaces');
      const file = `${key}.docx`;
      const target = path.join(mastersDir(), file);
      if (fs.existsSync(target)) { // the previous master is kept, never overwritten
        const bdir = path.join(mastersDir(), 'previous'); fs.mkdirSync(bdir, { recursive: true });
        fs.copyFileSync(target, path.join(bdir, `${key}-${new Date().toISOString().replace(/[:.]/g, '-')}.docx`));
      }
      fs.writeFileSync(target, buffer);
      index[key] = { ...info, key, file, uploadedAt: new Date().toISOString(), sha: sha256(buffer) };
      added.push(key);
    } catch (e) { problems.push(`${f.name}: ${e.message}`); }
  }
  writeJson(indexFile(), index);
  return { forms: listForms(), added, problems, crossCheck: crossCheck() };
}

export function removeForm(key) {
  const index = loadIndex();
  if (!index[key]) throw new Error('No such HR form');
  const f = path.join(mastersDir(), index[key].file);
  if (fs.existsSync(f)) { const bdir = path.join(mastersDir(), 'previous'); fs.mkdirSync(bdir, { recursive: true }); fs.renameSync(f, path.join(bdir, `${key}-removed-${Date.now()}.docx`)); }
  delete index[key];
  writeJson(indexFile(), index);
  return listForms();
}

export function listForms() {
  const index = loadIndex();
  return HR_FORMS.map(({ match, ...d }) => ({ ...d, installed: !!index[d.key], master: index[d.key] ? (({ sha, ...m }) => m)(index[d.key]) : null }));
}

/** Cross-check of the masters: the facilities they were written for (all of them are replaced per facility). */
export function crossCheck() {
  const index = loadIndex();
  const sources = new Map();
  for (const m of Object.values(index)) for (const n of m.names || []) sources.set(n, [...(sources.get(n) || []), formDef(m.key)?.title || m.key]);
  const missing = HR_FORMS.filter(f => !index[f.key]).map(f => f.title);
  return {
    sources: [...sources].map(([name, forms]) => ({ name, forms })),
    codes: [...new Set(Object.values(index).flatMap(m => m.codes || []))],
    withoutLogo: Object.values(index).filter(m => !m.hasLogo).map(m => formDef(m.key)?.title || m.key),
    missing,
  };
}

// ---------------------------------------------------------------------------------------------------
// Filling a form for a facility
// ---------------------------------------------------------------------------------------------------
const dmy = iso => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const policyVersion = (s, no) => s.versions?.[no] || (MAJOR_REVISION.includes(no) ? '2.0' : '1.0');
/** The values the Acceptable Usage Acknowledgement shares with the Acceptable Usage Policy (PO11). */
export function policyValues(s, no = 11) {
  const nn = String(no).padStart(2, '0');
  return {
    policyId: `${s.code} / ${s.standard || 'ADHICS'} - PO${nn}`, issued: dmy(s.issuedOn), reviewed: dmy(s.reviewedOn), due: dmy(plusOneYear(s.reviewedOn)),
    prepared: s.preparedBy, approved: s.approvedBy, facility: s.facilityName, version: policyVersion(s, no),
  };
}

/** What still blocks a form for this facility. */
function formNeeds(def, master, s, pics, dates = null) {
  const need = [];
  if (!master) need.push('the master form is not uploaded yet');
  if (dates?.some(d => !d)) need.push(def.dates === 'training' ? 'the training date' : 'the document date');
  if (master?.hasLogo && !pics.logo) need.push('the facility logo (otherwise another facility’s logo would stay)');
  if (def.policy) {
    if (!s.issuedOn) need.push('Issued on date');
    if (!s.reviewedOn) need.push('Reviewed on date');
    if (!s.preparedBy) need.push('Prepared by');
    if (!s.approvedBy) need.push('Approved by');
  }
  return need;
}

/** Read the labelled values of a Word document (Policy ID, Issued on, ...). */
async function labelledValues(buffer) {
  const xml = await (await JSZip.loadAsync(buffer)).file('word/document.xml').async('string');
  const out = {};
  for (const t of tables(xml)) for (const r of t.rows) {
    if (r.cells.length < 2 || r.cells.length > 3) continue;
    const k = labelOf(textOf(xml.slice(r.cells[0].s, r.cells[0].e)));
    if (k && out[k] === undefined) out[k] = squash(textOf(xml.slice(r.cells.at(-1).s, r.cells.at(-1).e)));
  }
  return out;
}

/** The generated PO11 Word file of the facility (if the policies were created). */
function generatedPolicy(cfg, no) {
  const { word } = generatedFiles(cfg);
  const f = word.find(x => new RegExp(`PO${String(no).padStart(2, '0')}\\b`).test(x));
  return f ? path.join(outputDirs(cfg).word, f) : null;
}

/**
 * One form filled for a facility. Returns { buffer, file, report: { replaced, leftovers, mismatches, sync } }.
 * The facility name replaces every facility name the master carries, the Ref No becomes CODE-HR-NN, the logo in
 * the header is the facility logo (centred), and the policy fields follow PO11 (Acceptable Usage).
 */
/** Every HR form shows the logo in the same box: at most 11 cm wide and 1.8 cm high, centred on the page at the top
 * (1.8 cm fits the lowest header of the masters, so no form gets an extra page). */
export const HR_LOGO_BOX = { cx: Math.round(11 * 360000), cy: Math.round(1.8 * 360000) };
const fillMemo = new Map(); // same master + settings + logo -> the same filled form (no work twice)
export async function fillForm(id, key, opts = {}) {
  const cfg = opts.cfg || loadConfig(id);
  const def = formDef(key);
  if (!def) throw new Error('No such HR form');
  const master = loadIndex()[key];
  const s = { ...prepSettings(cfg), baseline: templateLock()?.baseline || null };
  const pics = opts.pics || await printPics(cfg);
  const ds = readJson(docSettingsFile(cfg), { groups: {}, docs: {}, details: {} });
  const info = master ? await masterInfo(master) : { slots: [], details: {} };
  const dates = datesFor(def, ds, s, info.slots.length);
  const need = formNeeds(def, master, s, pics, dates);
  if (need.length) throw Object.assign(new Error(`Still needed for the ${def.title}: ${need.join(', ')}`), { status: 409, need });
  const generated = def.policy ? generatedPolicy(cfg, def.policy) : null;
  const memoKey = sha256(Buffer.from(JSON.stringify([id, key, master.sha, s, pics.logo ? sha256(pics.logo.buffer) : '', generated && fs.statSync(generated).mtimeMs, dates, ds.details?.[key] || null])));
  if (!fillMemo.has(memoKey)) {
    const r = await fillFresh(cfg, def, master, s, pics, { dates, details: { ...info.details, ...(ds.details?.[key] || {}) }, masterDetails: info.details });
    const z = await JSZip.loadAsync(r.buffer); // content fingerprint: the same content always gives the same PDF
    const parts = await Promise.all(Object.keys(z.files).sort().filter(f => !z.files[f].dir).map(async f => `${f}:${sha256(await z.file(f).async('nodebuffer'))}`));
    r.hash = sha256(Buffer.from(parts.join('|')));
    if (fillMemo.size > 300) fillMemo.clear();
    fillMemo.set(memoKey, r);
  }
  return { ...fillMemo.get(memoKey) }; // a copy: callers add their own file paths
}
async function fillFresh(cfg, def, master, s, pics, extra = {}) {
  let buffer = fs.readFileSync(path.join(mastersDir(), master.file));
  if (master.sha && sha256(buffer) !== master.sha) throw new Error(`The master ${def.title} was changed on disk – upload it again`);
  const nn = String(def.no).padStart(2, '0');
  const refNo = refNumber(s.code, def.no, seriesOf(def));

  // 1. Ref No "PMC -HR-0 2" -> "CODE-HR-02", and every other code of the master's facility -> this facility's code.
  const zip = await JSZip.loadAsync(buffer);
  let codesReplaced = 0, datesSet = 0;
  for (const part of Object.keys(zip.files).filter(f => /^word\/(document|header\d*|footer\d*)\.xml$/.test(f))) {
    let x = await zip.file(part).async('string');
    let r = replaceInParagraphs(x, REF_RE(), ''); x = r.xml; codesReplaced += r.count;
    for (const c of (master.codes || []).filter(c => c !== s.code)) { r = replaceInParagraphs(x, new RegExp(`\\b${c}\\b`, 'g'), s.code); x = r.xml; codesReplaced += r.count; }
    if (part === 'word/document.xml') {
      // dates: one date for all date fields, or the document's own dates
      if (extra.dates) { const d = setDates(x, i => (extra.dates[i] ? `${extra.dates[i].slice(8, 10)}/${extra.dates[i].slice(5, 7)}/${extra.dates[i].slice(0, 4)}` : null)); x = d.xml; datesSet = d.count; }
      // details of the training report (training company, trainer ...) when they were changed
      for (const [k, v] of Object.entries(extra.details || {})) {
        const old = extra.masterDetails?.[k];
        if (old && v && v !== old) { r = replaceInParagraphs(x, new RegExp(old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), v); x = r.xml; }
      }
      // policy lists (policy acknowledgement): each policy's version as set for this facility
      x = policyVersions(x, s);
    }
    zip.file(part, x);
  }
  buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  // 2. Names, people, labelled policy fields and the logo: the policy engine (same rules as the 33 policies).
  const tpl = {
    no: def.policy || 0, nameVariants: master.names || [], oldName: master.names?.[0] || '', oldCode: (master.codes || [])[0] || '',
    people: def.policy ? master.people || {} : {}, labels: master.labels || [], emails: [], phones: [],
  };
  const sForm = def.policy ? s : { ...s, versions: {} };
  const filled = await fillPolicy(buffer, tpl, sForm, { logo: pics.logo || null }, { logoBox: HR_LOGO_BOX });
  filled.buffer = await addHeaderRef(await centreLogoOnPage(filled.buffer), refNo);

  // 3. Read back: no facility name other than this facility's may remain.
  const out = await JSZip.loadAsync(filled.buffer);
  const text = await allText(out);
  const own = String(s.facilityName || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const others = facilityNamesIn(text).filter(n => { const k = n.replace(/[^A-Z0-9]/g, ''); return k !== own && !own.includes(k) && !k.includes(own); });
  const leftovers = [...new Set([...filled.report.leftovers, ...others])];
  for (const c of (master.codes || []).filter(c => c !== s.code)) if (new RegExp(`\\b${c}\\b`).test(text)) leftovers.push(c);
  const refs = (text.match(/Ref\.?\s*No\.?\s*:?\s*\S+/gi) || []).map(squash);
  if (refs.length !== 1 || !text.includes(refNo)) leftovers.push(`Ref. No. should be "${refNo}" once (found: ${refs.join(', ') || 'none'})`);

  // 4. Acceptable Usage: the same values as PO11 - checked in the form and against the generated PO11 policy.
  let sync = null;
  if (def.policy) {
    const want = policyValues(s, def.policy);
    const got = await labelledValues(filled.buffer);
    const fields = Object.keys(want).filter(k => got[k] !== undefined);
    const diffs = fields.filter(k => squash(got[k]) !== squash(want[k])).map(k => `${k}: "${got[k]}" instead of "${want[k]}"`);
    const pf = generatedPolicy(cfg, def.policy);
    let policy = null;
    if (pf) {
      const pv = await labelledValues(fs.readFileSync(pf));
      const pdiffs = fields.filter(k => pv[k] !== undefined && squash(pv[k]) !== squash(got[k])).map(k => `${k}: policy "${pv[k]}", form "${got[k]}"`);
      policy = { file: path.basename(pf), ok: !pdiffs.length, diffs: pdiffs };
    }
    sync = { policy: `PO${String(def.policy).padStart(2, '0')}`, values: Object.fromEntries(fields.map(k => [k, got[k]])), ok: !diffs.length, diffs, generated: policy };
  }
  // plain ASCII file names: Word's PDF conversion (PowerShell) must find the file by exactly this name
  const file = `${s.code} - ${seriesOf(def)}-FORM-${nn} - ${def.title.replace(/[–—]/g, '-').replace(/[\\/:*?"<>|]+/g, '-').replace(/[^\x20-\x7e]/g, '')}`;
  return {
    buffer: filled.buffer, file,
    report: { form: def.title, refNo, datesSet, replaced: filled.report.nameReplaced + codesReplaced, logo: filled.report.filled.includes('logo'), leftovers, mismatches: filled.report.mismatches, sync },
  };
}

// PDF: made with Microsoft Word, kept until the filled form changes (same content -> same PDF).
const queue = new Map(); // one Word conversion at a time per facility
const stateFile = cfg => path.join(hrHome(cfg), 'state.json');
const pdfCurrent = (state, it, pdf) => state[it.file]?.hash === it.hash && fs.existsSync(pdf);
/**
 * Word -> PDF for filled forms. A PDF made earlier from the same content is used at once (no Word). Missing ones are
 * made in ONE Word run (Word starts once for all of them), then each PDF's layout is checked (logo centred at the top).
 */
async function toPdf(cfg, items) {
  const home = hrHome(cfg);
  const wdir = path.join(home, 'Word'), pdir = path.join(home, 'PDF');
  fs.mkdirSync(wdir, { recursive: true }); fs.mkdirSync(pdir, { recursive: true });
  for (const it of items) {
    it.word = path.join(wdir, `${it.file}.docx`); it.pdf = path.join(pdir, `${it.file}.pdf`);
    try { if (!fs.existsSync(it.word) || !fs.readFileSync(it.word).equals(it.buffer)) fs.writeFileSync(it.word, it.buffer); } catch { /* open in Word: kept */ }
  }
  const fresh = state => items.filter(it => !pdfCurrent(state, it, it.pdf));
  if (!fresh(readJson(stateFile(cfg), {})).length) { // all ready: instant
    const st = readJson(stateFile(cfg), {});
    for (const it of items) it.layout = st[it.file]?.layout || null;
    return items;
  }
  const id = cfg._facility.id;
  let converted = [];
  const run = (queue.get(id) || Promise.resolve()).then(async () => {
    const state = readJson(stateFile(cfg), {}); // re-read: a conversion that just finished may have made them
    const todo = fresh(state);
    if (!todo.length) return;
    const started = Date.now() - 2000;
    const r = await wordToPdf(todo.map(t => ({ in: t.word, out: t.pdf })));
    for (const t of todo) {
      if (fs.existsSync(t.pdf) && fs.statSync(t.pdf).mtimeMs >= started) { state[t.file] = { hash: t.hash, at: new Date().toISOString() }; converted.push(t); }
      else t.pdfError = r.results.find(x => x.in === t.word)?.error || r.error || 'Microsoft Word is needed to create PDF files';
    }
    writeJson(stateFile(cfg), state);
  });
  // the layout check runs after the PDFs are handed out (it never makes anyone wait)
  const tail = run.then(async () => {
    if (!converted.length) return;
    const layout = await checkLayout(converted.map(t => t.pdf));
    const state = readJson(stateFile(cfg), {});
    for (const t of converted) if (state[t.file]?.hash === t.hash) state[t.file].layout = layout.get(t.pdf) || null;
    writeJson(stateFile(cfg), state);
  });
  queue.set(id, tail.catch(() => {}));
  await run;
  if (items.some(it => it.wantLayout)) await tail.catch(() => {});
  const state = readJson(stateFile(cfg), {});
  for (const it of items) {
    it.layout = state[it.file]?.layout || null;
    if (!it.pdfError && !pdfCurrent(state, it, it.pdf)) it.pdfError = 'PDF not created – Microsoft Word is needed';
  }
  return items;
}

const LAYOUT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'scripts', 'layout-check.ps1');
/** Where the logo really sits on page 1 of each PDF (rendered and measured on this PC): centred = within 3 mm. */
async function checkLayout(pdfs) {
  const out = new Map();
  if (!pdfs.length || process.platform !== 'win32') return out;
  const list = path.join(path.dirname(pdfs[0]), '..', '_layout.json');
  fs.writeFileSync(list, JSON.stringify(pdfs));
  const { execFile } = await import('node:child_process');
  const res = await new Promise(resolve => execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', decodeURIComponent(LAYOUT), list],
    { timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(stdout || '')));
  fs.rmSync(list, { force: true });
  try {
    for (const r of [].concat(JSON.parse(res.trim().split(/\r?\n/).pop()))) {
      out.set(r.pdf, r.found ? { centred: Math.abs(r.offsetMm) <= 3, offsetMm: r.offsetMm, topMm: r.topMm, widthMm: r.widthMm, heightMm: r.heightMm, pages: r.pages } : { centred: null, pages: r.pages });
    }
  } catch { /* the check is optional */ }
  return out;
}

/**
 * Make every PDF ahead of time (in the background, one Word run), so View / PDF open instantly. Started when the HR
 * page is opened and after settings change; does nothing when all PDFs are current.
 */
const prewarming = new Map();
export function prewarmPdfs(id) {
  if (prewarming.get(id) || hrJobs.get(id)?.running) return false;
  const p = (async () => {
    const cfg = loadConfig(id);
    const pics = await printPics(cfg);
    const items = [];
    for (const d of HR_FORMS) { if (!loadIndex()[d.key]) continue; try { items.push(await fillForm(id, d.key, { cfg, pics })); } catch { /* not ready yet */ } }
    if (items.length) await toPdf(cfg, items);
  })().catch(() => {}).finally(() => prewarming.delete(id));
  prewarming.set(id, p);
  return true;
}

/** Which forms' PDFs are ready to open at once, and their layout check. */
export async function pdfState(id) {
  const cfg = loadConfig(id);
  const pics = await printPics(cfg);
  const state = readJson(stateFile(cfg), {});
  const pdir = path.join(hrHome(cfg), 'PDF');
  const forms = {};
  for (const d of HR_FORMS) {
    if (!loadIndex()[d.key]) continue;
    try {
      const it = await fillForm(id, d.key, { cfg, pics });
      forms[d.key] = { ready: pdfCurrent(state, it, path.join(pdir, `${it.file}.pdf`)), layout: state[it.file]?.layout || null };
    } catch { forms[d.key] = { ready: false, blocked: true }; }
  }
  return { building: prewarming.has(id) || !!hrJobs.get(id)?.running, forms };
}

/** One form as Word or PDF. */
export async function formFile(id, key, format = 'pdf') {
  const cfg = loadConfig(id);
  const r = await fillForm(id, key, { cfg });
  if (format === 'docx') return { ...r, type: 'docx', name: `${r.file}.docx` };
  const [it] = await toPdf(cfg, [{ ...r }]);
  if (!fs.existsSync(it.pdf) || it.pdfError) throw new Error(`PDF not created: ${it.pdfError || 'Microsoft Word is needed'}`);
  return { ...r, report: { ...r.report, layout: it.layout || null }, buffer: fs.readFileSync(it.pdf), type: 'pdf', name: `${r.file}.pdf` };
}

/** Every installed form of the facility (Word + PDF) as one ZIP; forms that cannot be made yet are listed. */
/** Kind of a form for the plans: HR + training count as 'hr', vendor forms as 'thirdparty'. */
export const formKind = key => (HR_FORMS.find(f => f.key === key)?.group === 'thirdparty' ? 'thirdparty' : 'hr');
export const installedForms = (group = null) => HR_FORMS.filter(d => loadIndex()[d.key] && (!group || d.group === group || (group === 'hr' && d.group === 'training')));

/** The filled forms of a facility (Word buffer, and the PDF file unless type is 'word'). only: keys to include. */
export async function formItems(id, { type = 'all', group = null, only = null } = {}) {
  const cfg = loadConfig(id);
  const pics = await printPics(cfg);
  const items = [], problems = [];
  for (const d of installedForms(group).filter(f => !only || only.has(f.key))) {
    try { items.push({ ...(await fillForm(id, d.key, { cfg, pics })), key: d.key, group: d.group }); } catch (e) { problems.push(e.message); }
  }
  if (items.length && type !== 'word') await toPdf(cfg, items);
  return { cfg, items, problems };
}

export async function formsZip(id, type = 'all', group = null, only = null) {
  const { cfg, items, problems } = await formItems(id, { type, group, only });
  if (!items.length) throw new Error(problems[0] || 'No HR forms uploaded yet');
  const zip = new JSZip();
  for (const it of items) {
    if (type !== 'pdf') zip.file(`Word/${it.file}.docx`, it.buffer);
    if (type !== 'word' && it.pdf && fs.existsSync(it.pdf)) zip.file(`PDF/${it.file}.pdf`, fs.readFileSync(it.pdf));
    else if (type !== 'word') problems.push(`${it.report.form}: ${it.pdfError || 'no PDF'}`);
  }
  if (problems.length) zip.file('READ ME - not included.txt', problems.join('\r\n'));
  return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), problems, code: cfg._facility.code };
}

/**
 * Step 2 of the generation sequence (after the policies, before the Legal Register): every installed HR form is
 * filled for the facility and saved as Word + PDF in its hr/Word and hr/PDF folders. Runs in the background; the
 * job (progress, results, problems) is read with hrJobState.
 */
const hrJobs = new Map();
export const hrJobState = id => hrJobs.get(id) || null;
export function generateForms(id, { pdf = true, group = null, only = null } = {}) {
  if (hrJobs.get(id)?.running) throw new Error('The HR documents are already being created');
  const index = loadIndex();
  const defs = HR_FORMS.filter(d => index[d.key] && (!group || d.group === group || (group === 'hr' && d.group === 'training')) && (!only || only.has(d.key)));
  if (!defs.length) throw new Error('No master HR forms are uploaded yet – an administrator adds them on the HR & checklist page');
  const job = { running: true, started: new Date().toISOString(), total: defs.length, done: 0, step: 'Preparing…', results: [], problems: [] };
  hrJobs.set(id, job);
  (async () => {
    const cfg = loadConfig(id);
    const pics = await printPics(cfg);
    const items = [];
    for (const d of defs) {
      job.step = `Filling FORM-${String(d.no).padStart(2, '0')} – ${d.title}`;
      try {
        const it = await fillForm(id, d.key, { cfg, pics });
        items.push(it);
        const bad = [...it.report.leftovers.map(x => `still mentions ${x}`), ...it.report.mismatches, ...(it.report.sync && !it.report.sync.ok ? it.report.sync.diffs : [])];
        if (bad.length) job.problems.push(`${d.title}: ${bad.join('; ')}`);
        job.results.push({ key: d.key, title: d.title, file: it.file, ok: !bad.length });
      } catch (e) { job.problems.push(`${d.title}: ${e.message}`); job.results.push({ key: d.key, title: d.title, ok: false }); }
      job.done++;
    }
    if (items.length) {
      job.step = pdf ? `Creating ${items.length} PDF files with Microsoft Word…` : 'Saving the Word files…';
      if (pdf) { items.forEach(it => { it.wantLayout = true; }); await toPdf(cfg, items); job.step = 'Checking the layout (logo centred at the top)…'; }
      else { const w = path.join(hrHome(cfg), 'Word'); fs.mkdirSync(w, { recursive: true }); for (const it of items) fs.writeFileSync(path.join(w, `${it.file}.docx`), it.buffer); }
      const st = readJson(stateFile(cfg), {});
      for (const it of items) {
        const r = job.results.find(x => x.file === it.file);
        r.pdf = !!(it.pdf && fs.existsSync(it.pdf) && !it.pdfError);
        if (pdf && !r.pdf) { r.ok = false; job.problems.push(`${r.title} PDF: ${it.pdfError || 'not created'}`); }
        const lay = st[it.file]?.layout;
        if (lay) r.layout = lay;
        if (lay && lay.centred === false) { r.ok = false; job.problems.push(`${r.title}: the logo is ${Math.abs(lay.offsetMm)} mm off centre`); }
      }
    }
    const finished = new Date().toISOString();
    const meta = { at: finished, count: items.length, total: defs.length, passed: job.results.filter(r => r.ok).length, pdf: job.results.filter(r => r.pdf).length };
    writeJson(path.join(hrHome(cfg), 'generated.json'), meta);
    Object.assign(job, { running: false, finished, step: 'Done', validation: meta });
  })().catch(e => Object.assign(job, { running: false, finished: new Date().toISOString(), step: 'Failed', problems: [...job.problems, e.message] }));
  return job;
}

/** Last creation of the HR documents (for the dashboard and the assistant). */
export const hrGenerated = id => readJson(path.join(hrHome(loadConfig(id)), 'generated.json'), null);

/** The state of every form for a facility: ready / what is missing, and the PO11 synchronisation. */
export async function formsStatus(id) {
  const cfg = loadConfig(id);
  const s = { ...prepSettings(cfg) };
  const pics = await printPics(cfg);
  const index = loadIndex();
  const aup = policyValues(s, 11);
  const ds = readJson(docSettingsFile(cfg), { groups: {}, docs: {}, details: {} });
  return {
    facility: { name: s.facilityName, code: s.code, logo: !!pics.logo },
    forms: await Promise.all(HR_FORMS.map(async d => {
      const info = index[d.key] ? await masterInfo(index[d.key]).catch(() => ({ slots: [], details: {} })) : { slots: [], details: {} };
      const dates = datesFor(d, ds, s, info.slots.length);
      return {
        key: d.key, no: d.no, group: d.group, series: seriesOf(d), title: d.title, policy: d.policy || null, installed: !!index[d.key],
        sources: index[d.key]?.names || [], need: formNeeds(d, index[d.key], s, pics, dates),
        dates: d.dates && info.slots.length ? { setting: d.dates, fields: info.slots.length, own: ds.docs?.[d.key]?.date || '', date: docDate(d, ds, s), labels: info.slots.slice(0, 3).map(x => x.label) } : null,
        details: d.fields ? Object.entries(FIELD_RES).filter(([k]) => info.details[k]).map(([k, [, label]]) => ({ key: k, label, master: info.details[k], value: ds.details?.[d.key]?.[k] || info.details[k] })) : null,
      };
    })),
    groups: Object.fromEntries(Object.entries(GROUPS).map(([k, g]) => [k, { ...g, count: HR_FORMS.filter(f => f.group === k).length }])),
    dateSettings: { training: ds.groups?.training || '', thirdparty: ds.groups?.thirdparty || '', thirdpartyDefault: s.reviewedOn || '' },
    aupSync: { policy: 'PO11', values: aup, generatedPolicy: !!generatedPolicy(cfg, 11) },
    crossCheck: crossCheck(),
    job: hrJobState(id), generated: readJson(path.join(hrHome(cfg), 'generated.json'), null),
  };
}

// ---------------------------------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------------------------------
const checklistMasterFile = () => path.join(mastersDir(), 'checklist.json');
const newId = () => Math.random().toString(36).slice(2, 10);
/** The master checklist (sections with item names) every facility starts from. */
export function masterChecklist() {
  const m = readJson(checklistMasterFile(), null);
  return m?.sections?.length ? m.sections : DEFAULT_CHECKLIST;
}
/** Replace the master checklist with an uploaded workbook (e.g. a new "ADHICS CHECKLIST.xlsx"). */
export async function importMasterChecklist(buffer) {
  const parsed = await parseChecklistXlsx(buffer);
  const ids = ['hr', 'it', 'emr', 'policies'];
  const sections = parsed.map((p, i) => {
    const known = DEFAULT_CHECKLIST.find(d => d.sheet.toUpperCase() === p.sheet.toUpperCase());
    return { id: known?.id || ids[i] || `s${i + 1}`, sheet: p.sheet, heading: p.heading, title: known?.title || p.heading.replace(/^ADHICS CHECK ?LIST\s*-?\s*/i, '') || p.sheet,
      items: p.items.map(it => (/STAFF CLEARANCE FORM/i.test(it.name) && !/EXIT/i.test(it.name) ? 'EXIT CLEARANCE FORM (STAFF CLEARANCE)' : it.name)) };
  });
  // the HR section always lists the Exit Clearance Form
  const hr = sections.find(s => s.id === 'hr');
  if (hr && !hr.items.some(n => formForItem(n) === 'exit')) hr.items.push('EXIT CLEARANCE FORM');
  writeJson(checklistMasterFile(), { sections, importedAt: new Date().toISOString() });
  return sections;
}

const checklistFile = cfg => path.join(hrHome(cfg), 'checklist.json');
function fromMaster() {
  return masterChecklist().map(sec => ({ id: sec.id, sheet: sec.sheet, heading: sec.heading, title: sec.title,
    items: sec.items.map(n => ({ id: newId(), name: n, status: 'Pending', remarks: '' })) }));
}
function loadChecklist(cfg) {
  const c = readJson(checklistFile(cfg), null);
  if (c?.sections?.length) {
    // the HR section always has the Exit Clearance Form (added for checklists made before it existed)
    const hr = c.sections.find(s => s.id === 'hr');
    if (hr && !hr.items.some(i => formForItem(i.name) === 'exit')) {
      hr.items.push({ id: newId(), name: 'EXIT CLEARANCE FORM', status: 'Pending', remarks: '' });
      writeJson(checklistFile(cfg), c);
    }
    return c;
  }
  // first use: the facility's own copy of the master checklist (saved, so its items keep their ids)
  const fresh = { sections: fromMaster(), createdAt: new Date().toISOString() };
  writeJson(checklistFile(cfg), fresh);
  return fresh;
}
const saveChecklist = (cfg, c) => writeJson(checklistFile(cfg), { ...c, updatedAt: new Date().toISOString() });

/** The facility checklist with links: HR items -> their form, policy items -> the generated policy files. */
export function getChecklist(id) {
  const cfg = loadConfig(id);
  const c = loadChecklist(cfg);
  const files = generatedFiles(cfg);
  const index = loadIndex();
  const sections = c.sections.map(sec => {
    const items = sec.items.map(it => {
      const form = sec.id === 'hr' ? formForItem(it.name) : null;
      const po = sec.id === 'policies' ? policyForItem(it.name) : null;
      const nn = po ? `PO${String(po).padStart(2, '0')}` : '';
      return {
        ...it, form: form && index[form] ? form : null, formMissing: !!form && !index[form],
        policy: po ? { no: po, word: files.word.find(f => new RegExp(`${nn}\\b`).test(f)) || null, pdf: files.pdf.find(f => new RegExp(`${nn}\\b`).test(f)) || null } : null,
      };
    });
    return { ...sec, items, counts: countStatuses(items) };
  });
  const all = sections.flatMap(s => s.items);
  return { sections, counts: countStatuses(all), updatedAt: c.updatedAt || null, statuses: STATUSES };
}

/** Change one item: status, remarks or name. */
export function updateItem(id, sectionId, itemId, body = {}, user = '') {
  const cfg = loadConfig(id);
  const c = loadChecklist(cfg);
  const it = c.sections.find(s => s.id === sectionId)?.items.find(i => i.id === itemId);
  if (!it) throw Object.assign(new Error('Checklist item not found'), { status: 404 });
  if (body.status !== undefined) { if (!STATUSES.includes(body.status)) throw new Error(`Status must be ${STATUSES.join(', ')}`); it.status = body.status; }
  if (body.remarks !== undefined) it.remarks = String(body.remarks).slice(0, 1000);
  if (body.name !== undefined) { const n = squash(String(body.name)).slice(0, 300); if (!n) throw new Error('The document name cannot be empty'); it.name = n; }
  Object.assign(it, { updatedAt: new Date().toISOString(), updatedBy: user });
  saveChecklist(cfg, c);
  return getChecklist(id);
}
export function addItem(id, sectionId, name, user = '') {
  const cfg = loadConfig(id);
  const c = loadChecklist(cfg);
  const sec = c.sections.find(s => s.id === sectionId);
  if (!sec) throw Object.assign(new Error('Checklist section not found'), { status: 404 });
  const n = squash(String(name || '')).slice(0, 300);
  if (!n) throw new Error('Enter the document name');
  sec.items.push({ id: newId(), name: n, status: 'Pending', remarks: '', custom: true, updatedAt: new Date().toISOString(), updatedBy: user });
  saveChecklist(cfg, c);
  return getChecklist(id);
}
export function removeItem(id, sectionId, itemId) {
  const cfg = loadConfig(id);
  const c = loadChecklist(cfg);
  const sec = c.sections.find(s => s.id === sectionId);
  const k = sec?.items.findIndex(i => i.id === itemId) ?? -1;
  if (k < 0) throw Object.assign(new Error('Checklist item not found'), { status: 404 });
  sec.items.splice(k, 1);
  saveChecklist(cfg, c);
  return getChecklist(id);
}
/** Start again from the master checklist (statuses and remarks are kept for items with the same name). */
export function resetChecklist(id) {
  const cfg = loadConfig(id);
  const old = loadChecklist(cfg);
  const prev = new Map(old.sections.flatMap(s => s.items.map(i => [`${s.id}|${i.name.toUpperCase()}`, i])));
  const sections = fromMaster().map(s => ({ ...s, items: s.items.map(i => { const p = prev.get(`${s.id}|${i.name.toUpperCase()}`); return p ? { ...i, status: p.status, remarks: p.remarks } : i; }) }));
  saveChecklist(cfg, { sections });
  return getChecklist(id);
}

/** The checklist as Excel, with the facility name, code and logo. sections: ids to include (all by default). */
export async function checklistXlsx(id, only = null, trim = null) { // trim: sections → sections (free trial: the first items only)
  const cfg = loadConfig(id);
  const s = prepSettings(cfg);
  const c = getChecklist(id);
  const pics = await printPics(cfg).catch(() => ({}));
  let logo = pics.logo?.buffer || null;
  if (logo && !['png', 'jpg'].includes(imageSize(logo)?.ext)) logo = null;
  let sections = c.sections.filter(sec => !only || only.includes(sec.id));
  if (trim) sections = trim(sections);
  if (!sections.length) throw new Error('Nothing to export');
  const buffer = await buildChecklistXlsx({ sections, facility: { name: s.facilityName, code: s.code }, logo });
  return { buffer, name: `${s.code} - ${only ? 'ADHICS CHECKLIST' : 'MASTER CHECKLIST'}${only?.length === 1 ? ` - ${sections[0].title.toUpperCase()}` : ''}.xlsx` };
}
