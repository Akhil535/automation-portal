// The facility's compliance pack as one ZIP, in a fixed folder structure:
//   [Facility Name]/
//     Policies/                       Word/ PDF/
//     HR & Onboarding Documents/      Word/ PDF/  + ADHICS Document Checklist.xlsx
//     3rd-Party Vendor Documents/     Word/ PDF/
//     Legal Register & Reports/       LEGAL REGISTER.xlsx, Compliance Report.pdf
// The same structure is used for the full pack and for a single module, so files always land in the same place.
// Files come from what was generated (policies) or are filled on the spot from the masters (HR / vendor forms –
// quick, the PDFs are made ahead). allow: per module, the documents this user may have (null = all, plans.js).
import fs from 'node:fs';
import JSZip from 'jszip';
import { loadConfig } from './config.js';
import { HR_FORMS, checklistXlsx, formItems, installedForms, refNumber } from './hrforms.js';
import { generatedFiles, outputDirs, policyNoOf, prepSettings } from './policyprep.js';

export const MODULES = {
  policies: 'Policies',
  hr: 'HR & Onboarding Documents',
  thirdparty: '3rd-Party Vendor Documents',
  register: 'Legal Register & Reports',
};
export const MODULE_KEYS = Object.keys(MODULES);
const safe = s => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Facility';
export const rootName = cfg => safe(cfg._facility.name || prepSettings(cfg).facilityName || cfg._facility.code);

/**
 * What the pack holds, without building it: folder → files, each with its own download link (for the Downloads
 * page). Locked files (free trial) are listed with locked: true.
 */
export function packageTree(id, allow = {}) {
  const cfg = loadConfig(id);
  const q = `f=${encodeURIComponent(id)}`;
  const pol = generatedFiles(cfg);
  const polOk = n => !allow.policies || allow.policies.has(String(policyNoOf(n)));
  const files = { policies: [], hr: [], thirdparty: [], register: [] };
  for (const [type, list] of [['word', pol.word], ['pdf', pol.pdf]]) {
    for (const name of list) files.policies.push({ name, type, sub: type === 'pdf' ? 'PDF' : 'Word', locked: !polOk(name), url: `/api/policies/file?${q}&type=${type}&name=${encodeURIComponent(name)}` });
  }
  const code = cfg._facility.code;
  for (const d of installedForms()) {
    const kind = d.group === 'thirdparty' ? 'thirdparty' : 'hr';
    const locked = !!allow[kind] && !allow[kind].has(d.key);
    const title = `${refNumber(code, d.no, d.group === 'thirdparty' ? 'TP' : 'HR')} ${d.title}`;
    files[kind].push({ name: `${title}.docx`, type: 'word', sub: 'Word', key: d.key, locked, url: `/api/hr/forms/${d.key}?${q}&format=docx` });
    files[kind].push({ name: `${title}.pdf`, type: 'pdf', sub: 'PDF', key: d.key, locked, url: `/api/hr/forms/${d.key}?${q}&format=pdf` });
  }
  files.hr.push({ name: 'ADHICS Document Checklist.xlsx', type: 'xlsx', sub: '', locked: false, url: `/api/hr/checklist.xlsx?${q}` });
  const regLocked = allow.register === false;
  if (cfg.register.path && fs.existsSync(cfg.register.path)) files.register.push({ name: `${code} LEGAL REGISTER.xlsx`, type: 'xlsx', sub: '', locked: regLocked, url: `/api/register/download?${q}` });
  files.register.push({ name: `${code} Compliance Report.pdf`, type: 'pdf', sub: '', locked: regLocked, url: `/api/export/pdf?${q}` });
  return {
    root: rootName(cfg),
    folders: MODULE_KEYS.map(k => ({ key: k, name: MODULES[k], files: files[k], count: files[k].filter(f => !f.locked).length, locked: files[k].length > 0 && files[k].every(f => f.locked) })),
    hrInstalled: HR_FORMS.length,
  };
}

/**
 * Build the ZIP. modules: keys of MODULES (all by default); type: all | word | pdf.
 * extras.reportPdf: async () => Buffer – the compliance report (made by the server, it needs the register snapshot).
 */
export async function buildPackage(id, { modules = MODULE_KEYS, type = 'all', allow = {}, extras = {} } = {}) {
  const cfg = loadConfig(id);
  const root = rootName(cfg);
  const zip = new JSZip();
  const notes = [];
  const want = t => type === 'all' || type === t;
  const put = (folder, sub, name, data) => zip.file([root, folder, sub, name].filter(Boolean).join('/'), data);

  if (modules.includes('policies')) {
    const d = outputDirs(cfg), g = generatedFiles(cfg);
    const ok = n => !allow.policies || allow.policies.has(String(policyNoOf(n)));
    let n = 0, held = 0;
    for (const [t, list, folder, sub] of [['word', g.word, d.word, 'Word'], ['pdf', g.pdf, d.pdf, 'PDF']]) {
      if (!want(t)) continue;
      for (const f of list) {
        if (!ok(f)) { held++; continue; }
        put(MODULES.policies, sub, f, fs.readFileSync(`${folder}/${f}`)); n++;
      }
    }
    if (!g.word.length && !g.pdf.length) notes.push('Policies: not created yet – create them on the "Prepare policies" page.');
    else if (!n) notes.push('Policies: none included.');
    if (held) notes.push(`Policies: ${held} file(s) not included on the free trial.`);
  }

  for (const kind of ['hr', 'thirdparty']) {
    if (!modules.includes(kind)) continue;
    const group = kind === 'hr' ? 'hr' : 'thirdparty';
    const all = installedForms(group);
    const only = allow[kind] ? new Set(all.map(d => d.key).filter(k => allow[kind].has(k))) : null;
    if (!all.length) { notes.push(`${MODULES[kind]}: no master forms uploaded yet.`); continue; }
    if (only && only.size < all.length) notes.push(`${MODULES[kind]}: ${all.length - only.size} document(s) not included on the free trial.`);
    if (only && !only.size) continue;
    const { items, problems } = await formItems(id, { type, group, only });
    for (const it of items) {
      if (want('word')) put(MODULES[kind], 'Word', `${it.file}.docx`, it.buffer);
      if (want('pdf')) {
        if (it.pdf && fs.existsSync(it.pdf) && !it.pdfError) put(MODULES[kind], 'PDF', `${it.file}.pdf`, fs.readFileSync(it.pdf));
        else notes.push(`${it.file}: PDF not made (${it.pdfError || 'Microsoft Word is needed'}) – the Word file is included.`);
      }
    }
    for (const p of problems) notes.push(`${MODULES[kind]}: ${p}`);
    if (kind === 'hr') {
      try { const c = await checklistXlsx(id); put(MODULES.hr, '', 'ADHICS Document Checklist.xlsx', c.buffer); } catch (e) { notes.push(`Checklist: ${e.message}`); }
    }
  }

  if (modules.includes('register')) {
    if (allow.register === false) {
      put(MODULES.register, '', 'LOCKED - Get Premium.txt', 'The LEGAL REGISTER and the compliance report are part of Premium.\r\nGet Premium to unlock full compliance packs.\r\n');
    } else {
      const reg = cfg.register.path;
      if (reg && fs.existsSync(reg)) put(MODULES.register, '', `${cfg._facility.code} LEGAL REGISTER.xlsx`, fs.readFileSync(reg));
      else notes.push('LEGAL REGISTER: no register linked to this facility yet.');
      if (extras.reportPdf && want('pdf')) {
        try { put(MODULES.register, '', `${cfg._facility.code} Compliance Report.pdf`, await extras.reportPdf()); } catch (e) { notes.push(`Compliance report: ${e.message}`); }
      }
    }
  }

  const fileCount = Object.values(zip.files).filter(f => !f.dir).length;
  if (!fileCount) throw new Error(notes[0] || 'Nothing to download yet');
  if (notes.length) zip.file(`${root}/READ ME.txt`, ['Not included in this download:', '', ...notes.map(n => `- ${n}`)].join('\r\n'));
  const label = modules.length === MODULE_KEYS.length ? '' : ` - ${modules.map(m => MODULES[m]).join(' + ')}`;
  return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), name: `${root}${label}.zip`, files: fileCount, notes };
}
