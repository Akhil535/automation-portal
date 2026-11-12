// Annual renewal from last year's policy: an uploaded PDF / Word policy of the facility is read on this PC and its
// details are taken over for this year's pack – facility name and code, prepared / approved by, the incident contact,
// last year's dates, which policy it is with its version and amendment history, and the logo (kept as it is),
// signature and stamp. New dates are proposed (issue date kept, reviewed today, due in a year); everything is shown
// for review and only saved when the user applies it.
import { readDocument } from './docparse.js';
import { parseAnyDate, parseFacilityDocument } from './policy.js';
import { detectPictures, listTemplates, prepSettings, saveAsset, saveSettings } from './policyprep.js';
import { loadConfig } from './config.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const plusOneYear = iso => { if (!ISO.test(iso || '')) return ''; const d = new Date(`${iso}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + 1); return d.toISOString().slice(0, 10); };
export const todayDubai = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });

const LABEL = {
  issuedOn: /^(issued\s+on|issue\s+date|date\s+of\s+(issue|release)|release\s+date|effective\s+date)$/i,
  reviewedOn: /^(reviewed\s+on|review\s+date|last\s+review(ed)?(\s+on|\s+date)?|date\s+of\s+review)$/i,
  dueOn: /^(due\s+for\s+revision(\s+on|\s+by|\s+date)?|next\s+review(\s+date|\s+on)?|revision\s+due(\s+date|\s+on)?|due\s+for\s+review(\s+on)?)$/i,
  version: /^version(\s+no\.?)?$/i,
  ref: /^(doc(ument)?\.?\s*ref(\.|erence)?\.?|policy\s+id|document\s+(number|no\.?)|ref(erence)?\.?\s*no\.?)$/i,
  preparedBy: /^(prepared|authored|written)\s+by$|^document\s+author\(?s?\)?$/i,
  approvedBy: /^(approved\s+by|document\s+approver|approver)$/i,
};
const labelOf = s => Object.keys(LABEL).find(k => LABEL[k].test(norm(s).replace(/[:：.]\s*$/, '')));

/** label → value pairs from a document's rows: neighbouring cells, and "Label: value" inside one cell. */
const HEADING = /^(name|signature|sign|date|designation|title|position|remarks?|n\/?a|-+)$/i;
/** A value that fits its field: real dates for dates, a number for the version, a person – not a heading – for names. */
const fits = (k, v) => {
  if (!v || labelOf(v) || HEADING.test(v.replace(/[:：.]\s*$/, ''))) return false;
  if (['issuedOn', 'reviewedOn', 'dueOn'].includes(k)) return !!parseAnyDate(v);
  if (k === 'version') return /\d/.test(v);
  if (k === 'preparedBy' || k === 'approvedBy') return !parseAnyDate(v) && /[A-Za-z]{2}/.test(v) && v.length <= 80;
  return /[A-Za-z0-9]/.test(v);
};
function pairsOf(rows) {
  const out = {};
  const take = (k, v) => { v = norm(v); if (k && !out[k] && fits(k, v)) out[k] = v; };
  for (const r of rows) {
    for (let i = 0; i < r.length; i++) {
      const cell = norm(r[i]);
      const m = cell.match(/^([A-Za-z .()/]{3,40}?)\s*[:：]\s*(.+)$/);
      if (m) take(labelOf(m[1]), m[2]);
      if (i + 1 < r.length) take(labelOf(cell), r[i + 1]);
    }
  }
  return out;
}
/** The version history table (Version No. / Amendments – or Description of Changes – / dates). */
function historyOf(rows) {
  for (let h = 0; h < rows.length; h++) {
    const head = rows[h].map(norm);
    const vc = head.findIndex(c => /^version(\s*no\.?|\s*number)?$/i.test(c));
    const ac = head.findIndex(c => /amend|description|changes|remarks/i.test(c));
    if (vc < 0 || ac < 0) continue;
    const dc = head.findIndex(c => /date of implementation|review date|approval date|^date$/i.test(c));
    const list = [];
    for (const r of rows.slice(h + 1, h + 15)) {
      const v = norm(r[vc]);
      if (!/^\d+(\.\d+)?$/.test(v)) { if (list.length) break; continue; }
      list.push({ version: v, change: norm(r[ac]), date: dc >= 0 ? norm(r[dc]) : '' });
    }
    if (list.length) return list;
  }
  return looseHistory(rows);
}
/**
 * The same table read from a PDF whose cells wrap over several lines: the rows "<n> <version> …" are the entries, and
 * the one-cell lines around them (the wrapped amendment text) belong to the nearest entry.
 */
function looseHistory(rows) {
  const h = rows.findIndex(r => r.some(c => /^version$/i.test(norm(c))) && rows.slice(rows.indexOf(r), rows.indexOf(r) + 3).some(x => x.some(c => /amend|description|changes/i.test(norm(c)))));
  if (h < 0) return [];
  const isEntry = r => r.length >= 3 && /^\d{1,2}$/.test(norm(r[0])) && /^\d+\.\d+$/.test(norm(r[1]));
  const entries = [];
  let end = h;
  for (let i = h + 1; i < Math.min(rows.length, h + 60); i++) {
    if (isEntry(rows[i])) { entries.push(i); end = i; }
    else if (entries.length && (i - end > 4 || /restricted|issued on|objectives?$/i.test(rows[i].join(' ')))) break;
  }
  if (!entries.length) return [];
  const dateLike = s => /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}$/i.test(s) || !!parseAnyDate(s);
  const parts = new Map(entries.map(i => [i, { before: [], after: [] }]));
  for (let i = h + 1; i <= Math.min(rows.length - 1, end + 3); i++) {
    const r = rows[i].map(norm).filter(Boolean);
    if (r.length !== 1 || /^\d+$/.test(r[0]) || dateLike(r[0]) || isEntry(rows[i])) continue;
    // the nearest entry (a tie goes to the next one: wrapped text sits above and below the middle line)
    const near = entries.slice().sort((a, b) => Math.abs(a - i) - Math.abs(b - i) || b - a)[0];
    parts.get(near)[i < near ? 'before' : 'after'].push(r[0]);
  }
  return entries.map(i => {
    const r = rows[i].map(norm), mid = r.slice(2).filter(c => c && !dateLike(c));
    const date = r.slice(2).reverse().find(dateLike) || '';
    const words = [...parts.get(i).before, ...mid, ...parts.get(i).after];
    return { version: r[1], change: [...new Set(words)].join(' ').replace(/\s+/g, ' ').trim(), date };
  });
}
const versionKey = v => { const n = Number(String(v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n >= 1 ? `${Math.floor(n)}.0` : ''; };
/** Which master policy this is: "PO07" in its ID, otherwise its title compared with the master titles. */
function policyOf(ref, title, text) {
  const id = /\bPO\s?(\d{1,2})\b/i.exec(ref || '') || /\bPO\s?(\d{1,2})\b/.exec(text.slice(0, 600));
  const tpls = listTemplates();
  if (id && tpls.some(t => t.no === Number(id[1]))) return tpls.find(t => t.no === Number(id[1]));
  const words = s => new Set(norm(s).toUpperCase().replace(/^ADHICS\s*[-–]\s*/, '').replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !['THE', 'AND', 'FOR', 'POLICY', 'PROCEDURE', 'PROCEDURES'].includes(w)));
  const want = words(title);
  if (!want.size) return null;
  let best = null, score = 0;
  for (const t of tpls) {
    const have = words(t.title), common = [...want].filter(w => have.has(w)).length;
    const s = common / Math.max(want.size, have.size);
    if (s > score) { score = s; best = t; }
  }
  return score >= 0.6 ? best : null;
}

/** Read last year's policy: details, dates, version history and pictures, with this year's proposal. */
export async function extractRenewal(buffer, name = 'policy.pdf', { facilityId = null } = {}) {
  if (!buffer?.length) throw new Error('No file received');
  const doc = await readDocument(buffer, name);
  const base = await parseFacilityDocument(buffer, name).catch(() => ({ fields: {}, found: {}, warnings: [] }));
  const p = pairsOf(doc.rows || []);
  const text = (doc.rows || []).map(r => r.join(' ')).join('\n');
  const warnings = [];

  // contacts: the facility's own e-mail / phone (not the DoH's)
  const emails = [...new Set((text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || []).filter(e => !/@(doh\.gov\.ae|example\.com)$/i.test(e)))];
  const phones = [...new Set((text.match(/(?:\+971|00971|0)\s?\d{1,2}[\s-]?\d{3}[\s-]?\d{4}\b/g) || []).map(norm).filter(t => !/^\+?971\s?2\s?419/.test(t.replace(/[\s-]/g, ''))))];

  const date = s => (s ? parseAnyDate(s) || '' : '');
  const history = historyOf(doc.rows || []);
  const last = history.at(-1) || null;
  const issuedOn = date(p.issuedOn) || base.documentDate || '';
  // last year's review: as written, else the latest history entry, else a year before the revision date
  const dueWritten = date(p.dueOn);
  const reviewedOn = date(p.reviewedOn) || date(last?.date) || (dueWritten ? plusOneYear(dueWritten).replace(/^(\d{4})/, y => String(Number(y) - 2)) : '');
  const dueOn = dueWritten || (reviewedOn ? plusOneYear(reviewedOn) : '');
  const version = versionKey(p.version || last?.version || base.found?.version || '');
  const tpl = policyOf(p.ref || base.found?.policyId, base.policyTitle || '', text);
  const change = last && versionKey(last.version) === version && !/^(new|initial|nil+|none|-+)$/i.test(last.change) ? last.change : '';

  const today = todayDubai();
  const facility = { name: norm(base.fields?.name || ''), code: norm(base.fields?.code || '') };
  if (!facility.name) warnings.push('The facility name was not found – type it in');
  const details = {
    preparedBy: [p.preparedBy, base.fields?.authors].map(norm).find(v => fits('preparedBy', v)) || '',
    approvedBy: [p.approvedBy, base.fields?.approver].map(norm).find(v => fits('approvedBy', v)) || '',
    contactEmail: emails[0] || '', contactPhone: phones[0] || '',
  };
  if (!details.preparedBy) warnings.push('"Prepared by" was not found');
  if (!details.approvedBy) warnings.push('"Approved by" was not found');
  if (!issuedOn) warnings.push('The original issue date was not found');

  let pictures = { logo: null, signature: null, stamp: null };
  try {
    const d = await detectPictures([{ name, buffer }]);
    for (const k of Object.keys(pictures)) if (d[k]) pictures[k] = { dataUrl: d[k].dataUrl, ext: d[k].ext, width: d[k].width, height: d[k].height, source: d[k].source };
  } catch (e) { warnings.push(`Pictures: ${e.message}`); }
  for (const k of Object.keys(pictures)) if (!pictures[k]) warnings.push(`No ${k} found in the document`);

  // the current facility: does the document belong to it?
  let current = null;
  if (facilityId) {
    try {
      const cfg = loadConfig(facilityId), s = prepSettings(cfg);
      const same = a => norm(a).toUpperCase().replace(/[^A-Z0-9]/g, '');
      current = { id: facilityId, name: cfg._facility.name, code: cfg._facility.code, matches: !!facility.name && (same(facility.name) === same(cfg._facility.name) || same(facility.name) === same(s.facilityName)) || (!!facility.code && same(facility.code) === same(cfg._facility.code)) };
    } catch { current = null; }
  }

  return {
    file: name, facility, details, current,
    previous: { issuedOn, reviewedOn, dueOn, version, ref: norm(p.ref || base.found?.policyId || '') },
    policy: tpl ? { no: tpl.no, title: String(tpl.title).replace(/^ADHICS\s*[-–]\s*/i, ''), version: version || '1.0', change } : null,
    history,
    // this year's cycle: the original issue date stays, reviewed today, due for revision in a year
    proposed: { issuedOn: issuedOn || today, reviewedOn: today, dueOn: plusOneYear(today) },
    pictures, warnings,
  };
}

/** Apply reviewed renewal details to a facility (dates, names, contacts, a policy's version / change, pictures). */
export async function applyRenewal(id, body = {}) {
  const s = prepSettings(loadConfig(id));
  const next = {};
  for (const k of ['issuedOn', 'reviewedOn']) if (body[k]) { if (!ISO.test(body[k])) throw Object.assign(new Error(`${k}: use a date`), { status: 400 }); next[k] = body[k]; }
  for (const k of ['preparedBy', 'approvedBy', 'contactEmail', 'contactPhone']) if (body[k] !== undefined && String(body[k]).trim()) next[k] = String(body[k]).trim();
  const pol = body.policy;
  if (pol?.no && pol.version) {
    const v = versionKey(pol.version);
    if (!v) throw Object.assign(new Error('Version: use 1.0, 2.0, 3.0 …'), { status: 400 });
    next.versions = { ...s.versions, [pol.no]: v };
    next.descriptions = { ...s.descriptions };
    if (Number(v) >= 2 && String(pol.change || '').trim()) next.descriptions[pol.no] = String(pol.change).trim().slice(0, 300);
    // a different version than before needs its own change – the old version's description does not carry over
    else if (v !== (s.versions?.[pol.no] || '')) delete next.descriptions[pol.no];
  }
  saveSettings(id, next);
  const saved = [];
  for (const k of ['logo', 'signature', 'stamp']) {
    const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(body.pictures?.[k] || '');
    if (!m) continue;
    await saveAsset(id, k, Buffer.from(m[2], 'base64'), `renewal.${m[1] === 'png' ? 'png' : 'jpg'}`);
    saved.push(k);
  }
  return { settings: prepSettings(loadConfig(id)), pictures: saved };
}
