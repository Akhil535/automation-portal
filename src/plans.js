// Plans: free trial vs premium.
//   trial   – a taste of the portal: a few policies, a few HR / 3rd-party documents, one facility, and the LEGAL
//             REGISTER as a locked, read-only preview (no edits, no DoH updates, no register downloads).
//   premium – everything. Administrators are always premium.
// A trial user "claims" a document the first time they create, view or download it; the same documents can be
// opened again and again, new ones only while slots remain. Then the portal asks them to upgrade (HTTP 402).
import crypto from 'node:crypto';
import { loadUsers, saveUsers } from './auth.js';
import { loadFacilities, loadGlobalConfig, saveConfig } from './config.js';
import { HR_FORMS, installedForms } from './hrforms.js';
import { listTemplates } from './policyprep.js';

export const DEFAULT_LIMITS = Object.freeze({ policies: 2, hr: 2, thirdparty: 4 });
export const KIND_LABEL = { policies: 'policies', hr: 'HR documents', thirdparty: '3rd-party documents', facilities: 'facility' };
export const UPGRADE_TEXT = 'Get Premium to unlock full compliance packs';

/** The trial limits (an administrator can change them; the defaults above otherwise). */
export function trialLimits() {
  const set = loadGlobalConfig().plans?.trial || {};
  return Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([k, v]) => [k, Number.isInteger(set[k]) && set[k] >= 0 ? set[k] : v]));
}
/** Where Get Premium sends people (a subscription / payment page), or empty: the request goes to the administrators. */
export const upgradeUrl = () => loadGlobalConfig().plans?.upgradeUrl || '';
export function setTrialLimits(body = {}) {
  const cfg = loadGlobalConfig();
  const next = { ...trialLimits() };
  let url = upgradeUrl();
  if (body.upgradeUrl !== undefined) {
    url = String(body.upgradeUrl || '').trim();
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('Upgrade page: a web address starting with https://');
  }
  for (const k of Object.keys(DEFAULT_LIMITS)) {
    if (body[k] === undefined) continue;
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 0 || n > 999) throw new Error(`Trial limit for ${KIND_LABEL[k]}: a whole number from 0 to 999`);
    next[k] = n;
  }
  cfg.plans = { ...(cfg.plans || {}), trial: next, upgradeUrl: url };
  saveConfig(cfg);
  return next;
}

export const planOf = u => (!u ? 'trial' : u.role === 'admin' ? 'premium' : u.plan === 'trial' ? 'trial' : 'premium');
export const isTrial = u => planOf(u) === 'trial';

/** The error that opens the upgrade gateway in the portal. */
export function upgradeError(message, info = {}) {
  return Object.assign(new Error(`${message} – ${UPGRADE_TEXT}.`), { status: 402, upgrade: true, info });
}
/**
 * The documents a trial includes: the FIRST items of each module, always the same ones – policies PO01, PO02 (by
 * policy number), the first HR / training forms and the first vendor forms in the order the portal lists them.
 * Everything after them is locked (shown with a lock; opening or downloading it opens the upgrade gateway).
 */
export function includedIds(kind, limit = trialLimits()[kind]) {
  if (kind === 'policies') {
    const nos = listTemplates().map(t => t.no).sort((a, b) => a - b);
    return (nos.length ? nos : Array.from({ length: limit }, (_, i) => i + 1)).slice(0, limit).map(String);
  }
  const group = kind === 'thirdparty' ? 'thirdparty' : 'hr';
  const inGroup = d => (group === 'thirdparty' ? d.group === 'thirdparty' : d.group !== 'thirdparty');
  const installed = installedForms().filter(inGroup);
  return (installed.length ? installed : HR_FORMS.filter(inGroup)).slice(0, limit).map(d => d.key);
}

/** Facilities an account may create itself – on every plan 1, unless an administrator allows more. Admins: no limit. */
export const facilityAllowance = u => (u?.role === 'admin' ? Infinity : Number.isInteger(u?.facilityAllowance) ? u.facilityAllowance : 1);

/** What the trial includes (the same for every trial account), and the limits. */
export function planInfo(user) {
  const plan = planOf(user);
  if (plan === 'premium') return { plan, limits: null, usage: null, included: null, locked: [], upgradeUrl: upgradeUrl() };
  const limits = { ...trialLimits(), facilities: facilityAllowance(user) };
  const included = Object.fromEntries(['policies', 'hr', 'thirdparty'].map(k => [k, includedIds(k, limits[k])]));
  const usage = { ...included, facilities: createdFacilities(user.username).length, uploads: uploadsUsed(user) };
  limits.uploads = TRIAL_UPLOADS;
  return { plan, limits, usage, included, locked: ['register', 'doh', 'registerDownloads'], upgradeText: UPGRADE_TEXT, upgradeUrl: upgradeUrl() };
}

/** Facilities this user created (the master template never counts). */
export function createdFacilities(username) {
  const { list, templateId } = loadFacilities();
  return list.filter(f => f.id !== templateId && f.createdBy && f.createdBy === username);
}

const label = (kind, id) => (kind === 'policies' ? `PO${String(id).padStart(2, '0')}` : HR_FORMS.find(f => f.key === id)?.title || id);

/** Of the documents asked for, those the trial includes (premium: null = all). None included → the upgrade error. */
export function claim(user, kind, ids, { quiet = false } = {}) {
  if (!isTrial(user)) return null;
  const inc = new Set(includedIds(kind));
  const ok = new Set(ids.map(String).filter(id => inc.has(id)));
  if (!ok.size && !quiet) {
    const what = ids.length === 1 ? `${label(kind, String(ids[0]))} is part of Premium` : `These ${KIND_LABEL[kind]} are part of Premium`;
    throw upgradeError(`${what}. The free trial includes ${[...inc].map(i => label(kind, i)).join(' and ') || `${inc.size} ${KIND_LABEL[kind]}`}`, { kind, included: [...inc] });
  }
  return ok;
}

/**
 * Free trial: uploaded facility documents (licences, certificates…) – the first 2 different files are read and
 * previewed; the same files can be uploaded again, any further file is Premium. Files are remembered by a SHA-256
 * of their content (not by name), per account.
 */
export const TRIAL_UPLOADS = 2;
/** Checks the file may be read (throws the upgrade error if not) and returns a function that counts it – called
 *  only after the document was read successfully, so a file that cannot be read does not use up a preview. */
export function claimUpload(user, buffer) {
  if (!isTrial(user)) return () => {};
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const seen0 = new Set(loadUsers().users.find(x => x.id === user.id)?.usage?.uploads || []);
  if (!seen0.has(hash) && seen0.size >= TRIAL_UPLOADS) throw upgradeError(`The free trial previews ${TRIAL_UPLOADS} uploaded documents – further documents are part of Premium`, { kind: 'uploads', limit: TRIAL_UPLOADS });
  // token: the id of this reading – only documents read this way can be applied to the register on the trial
  // token: the id of this reading; row / confidence: the entry it was recognised as – a trial user can apply the
  // document only to that entry (a confident match is never moved to another row)
  return (token, row = null, confidence = 'none') => {
    const data = loadUsers();
    const u = data.users.find(x => x.id === user.id);
    if (!u) return;
    const seen = new Set(u.usage?.uploads || []);
    if (seen.size >= TRIAL_UPLOADS && !seen.has(hash)) return; // (another upload took the last preview meanwhile)
    seen.add(hash);
    const old = (u.usage?.uploadTokens || []).map(t => (typeof t === 'string' ? { t } : t));
    const tokens = [...old, ...(token ? [{ t: token, row: row ?? null, sure: ['high', 'medium'].includes(confidence) }] : [])].slice(-50);
    u.usage = { ...(u.usage || {}), uploads: [...seen], uploadTokens: tokens };
    saveUsers(data);
  };
}
/** Free trial: may these documents be applied to the LEGAL REGISTER? At most 2, only free previews of this user,
 *  and each one to the entry it was recognised as (only a reading without a sure match may be placed by hand). */
export function checkTrialApply(user, items) {
  if (!isTrial(user)) return;
  const recs = new Map((loadUsers().users.find(x => x.id === user.id)?.usage?.uploadTokens || []).map(t => (typeof t === 'string' ? [t, { t }] : [t.t, t])));
  if (items.length > TRIAL_UPLOADS || items.some(i => !recs.has(String(i.token || '')))) {
    throw upgradeError(`The free trial applies ${TRIAL_UPLOADS} documents to the LEGAL REGISTER – applying all documents is part of Premium`, { kind: 'uploads', limit: TRIAL_UPLOADS });
  }
  const moved = items.find(i => { const r = recs.get(String(i.token)); return r.sure && r.row != null && Number(i.row) !== Number(r.row); });
  if (moved) throw Object.assign(new Error(`${moved.file || 'This document'} was recognised as another LEGAL REGISTER entry – it can only be applied to that entry.`), { status: 400 });
}
export const uploadsUsed = user => (loadUsers().users.find(x => x.id === user?.id)?.usage?.uploads || []).length;

/**
 * ADHICS document checklist on the free trial: per section the first items are shown – 2, or 1 when the section has
 * 5 items or fewer; every other item is masked (no name, status, remark or link reaches the browser) and locked.
 */
export const checklistFree = n => (n <= 5 ? 1 : 2);
export function maskChecklist(user, c) {
  if (!isTrial(user) || !c?.sections) return c;
  return {
    ...c, trialMasked: true,
    sections: c.sections.map(s => {
      const free = checklistFree(s.items.length);
      return { ...s, free, items: s.items.map((it, i) => (i < free ? it : { id: it.id, locked: true, name: 'Premium document', status: '', remarks: '', form: null, formMissing: false, policy: null })) };
    }),
  };
}
/** Throws the upgrade error when a trial user changes a locked checklist item. */
export function checkChecklistItem(user, c, sectionId, itemId) {
  if (!isTrial(user)) return;
  const sec = c.sections.find(s => s.id === sectionId);
  const i = sec ? sec.items.findIndex(x => x.id === itemId) : -1;
  if (i >= checklistFree(sec?.items.length || 0)) throw upgradeError(`On the free trial the checklist shows the first ${checklistFree(sec?.items.length || 0)} document${checklistFree(sec?.items.length || 0) === 1 ? '' : 's'} of each section – this one is part of Premium`, { kind: 'checklist' });
}

/**
 * LEGAL REGISTER on the free trial: the first TRIAL_REGISTER_ROWS entries are shown and can be worked on; every
 * entry after them is masked (no name, dates, person, compliance or document reaches the browser) and locked.
 */
export const TRIAL_REGISTER_ROWS = 2;
export const freeRegisterRows = items => new Set((items || []).slice(0, TRIAL_REGISTER_ROWS).map(i => i.row));
export function maskMaster(user, data) {
  if (!isTrial(user) || !data?.items) return data;
  const free = freeRegisterRows(data.items);
  const names = new Set(data.items.filter(i => free.has(i.row)).map(i => i.name));
  return {
    ...data, trialMasked: true, trialRows: TRIAL_REGISTER_ROWS,
    items: data.items.map(i => (free.has(i.row) ? i : { row: i.row, sl: i.sl, fixed: !!i.fixed, locked: true, name: 'Premium entry', status: 'locked', issued: '', expiry: '', due: '', responsible: '', compliance: '' })),
    documents: Object.fromEntries(Object.entries(data.documents || {}).filter(([n]) => names.has(n))),
  };
}
/** Throws the upgrade error unless every row is one of the free register entries (trial only). */
export function checkFreeRows(user, items, rows) {
  if (!isTrial(user)) return;
  const free = freeRegisterRows(items);
  if (!rows.length || rows.some(r => !free.has(Number(r)))) throw upgradeError(`On the free trial you work on the first ${TRIAL_REGISTER_ROWS} entries of the LEGAL REGISTER – this entry is part of Premium`, { kind: 'register' });
}

/** The documents of a module the trial includes: null = premium (all). */
export function allowedSet(user, kind) {
  return isTrial(user) ? new Set(includedIds(kind)) : null;
}

/** A facility whose owner is on the trial is not monitored (its LEGAL REGISTER is a preview that is not updated). */
export function trialOnlyFacility(f) {
  if (!f?.createdBy) return false;
  const u = loadUsers().users.find(x => x.username === f.createdBy);
  return !!u && isTrial(u);
}
