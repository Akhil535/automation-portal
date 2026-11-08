// Plans: free trial vs premium.
//   trial   – a taste of the portal: a few policies, a few HR / 3rd-party documents, one facility, and the LEGAL
//             REGISTER as a locked, read-only preview (no edits, no DoH updates, no register downloads).
//   premium – everything. Administrators are always premium.
// A trial user "claims" a document the first time they create, view or download it; the same documents can be
// opened again and again, new ones only while slots remain. Then the portal asks them to upgrade (HTTP 402).
import { loadUsers } from './auth.js';
import { loadFacilities, loadGlobalConfig, saveConfig } from './config.js';
import { HR_FORMS, installedForms } from './hrforms.js';
import { listTemplates } from './policyprep.js';

export const DEFAULT_LIMITS = Object.freeze({ policies: 2, hr: 2, thirdparty: 2, facilities: 2 });
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
  if (next.facilities < 1) throw new Error('A trial account needs at least one facility');
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

/** What the trial includes (the same for every trial account), and the limits. */
export function planInfo(user) {
  const plan = planOf(user);
  if (plan === 'premium') return { plan, limits: null, usage: null, included: null, locked: [], upgradeUrl: upgradeUrl() };
  const limits = trialLimits();
  const included = Object.fromEntries(['policies', 'hr', 'thirdparty'].map(k => [k, includedIds(k, limits[k])]));
  const usage = { ...included, facilities: createdFacilities(user.username).length };
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
