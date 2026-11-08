// Plans: free trial vs premium.
//   trial   – a taste of the portal: a few policies, a few HR / 3rd-party documents, one facility, and the LEGAL
//             REGISTER as a locked, read-only preview (no edits, no DoH updates, no register downloads).
//   premium – everything. Administrators are always premium.
// A trial user "claims" a document the first time they create, view or download it; the same documents can be
// opened again and again, new ones only while slots remain. Then the portal asks them to upgrade (HTTP 402).
import { loadUsers, saveUsers } from './auth.js';
import { loadFacilities, loadGlobalConfig, saveConfig } from './config.js';

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
const usedOf = (u, kind) => new Set((u?.usage?.[kind] || []).map(String));

/** What a trial user has used so far, and the limits. */
export function planInfo(user) {
  const plan = planOf(user);
  if (plan === 'premium') return { plan, limits: null, usage: null, locked: [], upgradeUrl: upgradeUrl() };
  const u = loadUsers().users.find(x => x.id === user.id);
  const limits = trialLimits();
  const usage = Object.fromEntries(['policies', 'hr', 'thirdparty'].map(k => [k, [...usedOf(u, k)]]));
  usage.facilities = createdFacilities(user.username).length;
  return { plan, limits, usage, locked: ['register', 'doh', 'registerDownloads'], upgradeText: UPGRADE_TEXT, upgradeUrl: upgradeUrl() };
}

/** Facilities this user created (the master template never counts). */
export function createdFacilities(username) {
  const { list, templateId } = loadFacilities();
  return list.filter(f => f.id !== templateId && f.createdBy && f.createdBy === username);
}

/** Documents a trial user may get now: those already claimed, plus new ones (in the order given) while slots remain.
 *  Premium: everything (null). Throws the upgrade error when nothing is left. */
export function claim(user, kind, ids, { quiet = false } = {}) {
  if (!isTrial(user)) return null;
  const data = loadUsers();
  const u = data.users.find(x => x.id === user.id);
  if (!u) throw upgradeError('Unknown account');
  const used = usedOf(u, kind), limit = trialLimits()[kind];
  const ok = [];
  for (const id of ids.map(String)) {
    if (used.has(id)) ok.push(id);
    else if (used.size < limit) { used.add(id); ok.push(id); }
  }
  u.usage = { ...(u.usage || {}), [kind]: [...used] };
  saveUsers(data);
  if (!ok.length && !quiet) throw upgradeError(`The free trial includes ${limit} ${KIND_LABEL[kind]} (${[...used].join(', ') || 'none'} used)`, { kind, limit, used: [...used] });
  return new Set(ok);
}

/** Documents a trial user already has (no new claims): null = premium (all). */
export function allowedSet(user, kind) {
  if (!isTrial(user)) return null;
  return usedOf(loadUsers().users.find(x => x.id === user.id), kind);
}

/** A facility whose owner is on the trial is not monitored (its LEGAL REGISTER is a preview that is not updated). */
export function trialOnlyFacility(f) {
  if (!f?.createdBy) return false;
  const u = loadUsers().users.find(x => x.username === f.createdBy);
  return !!u && isTrial(u);
}
