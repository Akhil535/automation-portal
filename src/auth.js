// Authentication & access control: user accounts (BCrypt password hashes), roles, facility scoping, two-factor
// authentication (TOTP authenticator apps, RFC 6238 - or a one-time code by e-mail), login lockout and sessions.
//
// Roles:  admin   - everything: users, shared settings, add / remove facilities
//         manager - work on the facilities assigned to them: register, documents, monitoring, exports
//         viewer  - read-only access to the assigned facilities, exports
// Every account must complete 2FA at every login. New accounts set their own password and enrol an authenticator
// app at their first login.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { dir, loadGlobalConfig, replaceFile } from './config.js';

export const ROLES = ['admin', 'manager', 'viewer'];
const RANK = { viewer: 1, manager: 2, admin: 3 };
const BCRYPT_COST = 12;
const MAX_FAILS = 5, LOCK_MINUTES = 15;
const SESSION_HOURS = 12, PENDING_MINUTES = 10, EMAIL_OTP_MINUTES = 5;
const ISSUER = 'Legal Register Portal';
let dummy = null;
const DUMMY_HASH = () => (dummy ||= bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST));

// ---------------------------------------------------------------------------------------------------
// User store (data/users.json, next to the global config)
// ---------------------------------------------------------------------------------------------------
const usersFile = () => path.join(dir(loadGlobalConfig(), 'data'), 'users.json');
export function loadUsers() {
  try { return JSON.parse(fs.readFileSync(usersFile(), 'utf8')); } catch { return { users: [] }; }
}
export function saveUsers(data) {
  const f = usersFile(), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  replaceFile(tmp, f);
}
export const hasUsers = () => loadUsers().users.length > 0;
const findUser = (data, username) => data.users.find(u => u.username.toLowerCase() === String(username || '').trim().toLowerCase());
export const publicUser = u => u && ({
  id: u.id, username: u.username, role: u.role, facilities: u.facilities, email: u.email || '', twoFactor: !!u.totp?.enabled,
  mustChangePassword: !!u.mustChangePassword, lastLogin: u.lastLogin || null, createdAt: u.createdAt, locked: !!(u.lockedUntil && u.lockedUntil > Date.now()),
  status: u.status || 'active', fullName: u.fullName || '', requestNote: u.requestNote || '',
  // plan: administrators are never limited; accounts made before plans existed stay premium (nobody is locked out)
  plan: u.role === 'admin' ? 'premium' : u.plan === 'trial' ? 'trial' : 'premium',
  premiumRequest: u.premiumRequest || null,
  welcomeSeen: Number(u.welcomeSeen) || 0, // the version of the welcome message this user chose not to see again
  usage: { policies: u.usage?.policies?.length || 0, hr: u.usage?.hr?.length || 0, thirdparty: u.usage?.thirdparty?.length || 0 },
});
export const PLANS = ['trial', 'premium'];

export function checkPassword(pw) {
  const p = String(pw || '');
  if (p.length < 10) return 'Password must be at least 10 characters';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Password must contain letters and numbers';
  return null;
}
const USERNAME = /^[A-Za-z0-9._@-]{3,40}$/;

/** Create a user. role: admin | manager | viewer; facilities: ['*'] or facility ids. */
export function createUser({ username, password, role = 'viewer', facilities = ['*'], email = '', plan = 'trial' }, { mustChangePassword = true } = {}) {
  if (!PLANS.includes(plan)) throw new Error('Unknown plan');
  if (!USERNAME.test(username || '')) throw new Error('Username: 3-40 letters, digits or . _ @ -');
  if (!ROLES.includes(role)) throw new Error('Unknown role');
  const bad = checkPassword(password);
  if (bad) throw new Error(bad);
  const data = loadUsers();
  if (findUser(data, username)) throw new Error(`User "${username}" already exists`);
  const u = {
    id: crypto.randomUUID(), username: username.trim(), hash: bcrypt.hashSync(password, BCRYPT_COST), role,
    facilities: role === 'admin' ? ['*'] : facilityScope(facilities), email: String(email || '').trim(),
    totp: null, mustChangePassword, failed: 0, lockedUntil: 0, createdAt: new Date().toISOString(), plan: role === 'admin' ? 'premium' : plan,
  };
  data.users.push(u);
  saveUsers(data);
  return publicUser(u);
}

/**
 * Self sign-up from the sign-in page. The account is created as 'pending': it cannot sign in until an administrator
 * approves it and chooses its role and facilities. 2FA is enrolled at the first sign-in, as for every account.
 */
const MAX_PENDING = 30;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function registerUser({ username, password, email, fullName, note } = {}) {
  if (!USERNAME.test(username || '')) throw new Error('Username: 3-40 letters, digits or . _ @ -');
  if (!EMAIL.test(String(email || '').trim())) throw new Error('Enter a valid e-mail address');
  const name = String(fullName || '').trim();
  if (name.length < 2 || name.length > 80) throw new Error('Enter your full name');
  const bad = checkPassword(password);
  if (bad) throw new Error(bad);
  const data = loadUsers();
  if (findUser(data, username)) throw new Error(`The username "${username}" is taken - choose another`);
  if (data.users.filter(u => u.status === 'pending').length >= MAX_PENDING) throw Object.assign(new Error('Too many requests are waiting for approval - ask an administrator'), { status: 429 });
  const u = {
    id: crypto.randomUUID(), username: username.trim(), hash: bcrypt.hashSync(password, BCRYPT_COST), role: 'viewer', facilities: [], plan: 'trial',
    email: String(email).trim(), fullName: name, requestNote: String(note || '').trim().slice(0, 300), status: 'pending',
    totp: null, mustChangePassword: false, failed: 0, lockedUntil: 0, createdAt: new Date().toISOString(),
  };
  data.users.push(u);
  saveUsers(data);
  return publicUser(u);
}

/**
 * The facilities an account may open: '*' (all) only when chosen explicitly; otherwise exactly the ones listed –
 * an empty list means none (the user sees "no facility assigned" until an administrator gives access).
 */
export function facilityScope(list) {
  const ids = [...new Set((Array.isArray(list) ? list : []).map(String).filter(v => v === '*' || /^[a-z0-9-]{1,40}$/.test(v)))];
  return ids.includes('*') ? ['*'] : ids;
}

export function updateUser(id, fields) {
  const data = loadUsers();
  const u = data.users.find(x => x.id === id);
  if (!u) throw new Error('User not found');
  if (fields.approve) u.status = 'active';
  if (fields.role !== undefined) {
    if (!ROLES.includes(fields.role)) throw new Error('Unknown role');
    if (u.role === 'admin' && fields.role !== 'admin' && data.users.filter(x => x.role === 'admin').length === 1) throw new Error('The last administrator cannot be demoted');
    u.role = fields.role;
  }
  if (fields.facilities !== undefined || fields.role !== undefined) u.facilities = u.role === 'admin' ? ['*'] : facilityScope(fields.facilities ?? u.facilities);
  if (fields.plan !== undefined) {
    if (!PLANS.includes(fields.plan)) throw new Error('Unknown plan');
    u.plan = fields.plan;
  }
  if (fields.resetUsage) u.usage = {};
  if (fields.premiumRequest !== undefined) u.premiumRequest = fields.premiumRequest;
  if (fields.welcomeSeen !== undefined) u.welcomeSeen = Math.max(0, Math.floor(Number(fields.welcomeSeen) || 0));
  if (fields.plan === 'premium') u.premiumRequest = null;
  if (fields.email !== undefined) u.email = String(fields.email).trim();
  if (fields.password !== undefined) {
    const bad = checkPassword(fields.password);
    if (bad) throw new Error(bad);
    u.hash = bcrypt.hashSync(fields.password, BCRYPT_COST);
    u.mustChangePassword = !!fields.mustChangePassword;
    revokeSessions(u.id);
  }
  if (fields.resetTwoFactor) { u.totp = null; revokeSessions(u.id); }
  if (fields.unlock) { u.failed = 0; u.lockedUntil = 0; }
  saveUsers(data);
  return publicUser(u);
}

export function deleteUser(id, actingId) {
  const data = loadUsers();
  const u = data.users.find(x => x.id === id);
  if (!u) throw new Error('User not found');
  if (u.id === actingId) throw new Error('You cannot delete your own account');
  if (u.role === 'admin' && data.users.filter(x => x.role === 'admin').length === 1) throw new Error('The last administrator cannot be deleted');
  data.users = data.users.filter(x => x.id !== id);
  saveUsers(data);
  revokeSessions(id);
}

// ---------------------------------------------------------------------------------------------------
// TOTP (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits) - Google / Microsoft Authenticator compatible
// ---------------------------------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { value = (value << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = mac[mac.length - 1] & 15;
  const code = ((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
  return code;
}
const stepNow = (t = Date.now()) => Math.floor(t / 30000);
/** Returns the matching step (±1 for clock drift) or null. */
export function verifyTotp(secret, code, t = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  for (const d of [0, -1, 1]) {
    const s = stepNow(t) + d;
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, s)), Buffer.from(c))) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Login flow: password -> (change password) -> (enrol authenticator) -> one-time code -> session
// ---------------------------------------------------------------------------------------------------
const pending = new Map();   // token -> { userId, stage, expires, enrolSecret?, emailOtp? }
/**
 * Signed-in sessions, kept on disk (data/sessions.json) so a portal restart – an update, or Windows restarting the
 * service – does not sign everyone out. Only a SHA-256 of each session id is stored: the file cannot be used to
 * sign in. Expired sessions are dropped when the file is read and written.
 */
const sessions = (() => {
  const file = () => path.join(dir(loadGlobalConfig(), 'data'), 'sessions.json');
  const h = sid => crypto.createHash('sha256').update(String(sid)).digest('hex');
  let map = null, timer = null;
  const load = () => {
    if (map) return map;
    map = new Map();
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file(), 'utf8')))) if (v?.expires > Date.now()) map.set(k, v); } catch { /* none yet */ }
    return map;
  };
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const now = Date.now(), f = file(), tmp = `${f}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries([...load()].filter(([, v]) => v.expires > now))));
        replaceFile(tmp, f);
      } catch (e) { console.log(`sessions not saved: ${e.message}`); }
    }, 50);
  };
  return {
    get: sid => load().get(h(sid)),
    set: (sid, v) => { load().set(h(sid), v); save(); },
    delete: sid => { const r = load().delete(h(sid)); if (r) save(); return r; },
    revokeUser: userId => { let n = 0; for (const [k, s] of load()) if (s.userId === userId) { load().delete(k); n++; } if (n) save(); },
    flush: () => { clearTimeout(timer); timer = null; },
  };
})();
const newToken = () => crypto.randomBytes(32).toString('base64url');

function nextStage(u) {
  if (u.mustChangePassword) return 'change-password';
  if (!u.totp?.enabled) return 'enrol';
  return 'otp';
}

async function stageInfo(token, p, u) {
  const info = { token, stage: p.stage, username: u.username, emailOtp: !!u.email };
  if (p.stage === 'enrol') {
    p.enrolSecret ||= base32Encode(crypto.randomBytes(20));
    const uri = `otpauth://totp/${encodeURIComponent(ISSUER)}:${encodeURIComponent(u.username)}?secret=${p.enrolSecret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
    info.enrol = { secret: p.enrolSecret.replace(/(.{4})/g, '$1 ').trim(), qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }), uri };
  }
  return info;
}

/** Step 1: username + password. Returns the next stage (never a session directly - 2FA is always required). */
export async function loginPassword(username, password) {
  const data = loadUsers();
  const u = findUser(data, username);
  const fail = () => { throw Object.assign(new Error('Wrong username or password'), { status: 401 }); };
  if (!u) { bcrypt.compareSync(String(password || ''), DUMMY_HASH()); fail(); } // same timing for unknown users
  if (u.lockedUntil && u.lockedUntil > Date.now()) throw Object.assign(new Error(`Account locked after ${MAX_FAILS} failed attempts - try again in ${Math.ceil((u.lockedUntil - Date.now()) / 60000)} min or ask an administrator`), { status: 423 });
  if (!bcrypt.compareSync(String(password || ''), u.hash)) {
    u.failed = (u.failed || 0) + 1;
    if (u.failed >= MAX_FAILS) { u.lockedUntil = Date.now() + LOCK_MINUTES * 60000; u.failed = 0; }
    saveUsers(data);
    fail();
  }
  u.failed = 0; saveUsers(data);
  if (u.status === 'pending') throw Object.assign(new Error('Your account is waiting for administrator approval. You can sign in once it is approved.'), { status: 403 });
  const token = newToken();
  const p = { userId: u.id, stage: nextStage(u), expires: Date.now() + PENDING_MINUTES * 60000 };
  pending.set(token, p);
  return stageInfo(token, p, u);
}

function pendingFor(token) {
  const p = pending.get(token);
  if (!p || p.expires < Date.now()) { pending.delete(token); throw Object.assign(new Error('Sign-in expired - start again'), { status: 401 }); }
  const data = loadUsers();
  const u = data.users.find(x => x.id === p.userId);
  if (!u) throw Object.assign(new Error('Account not found'), { status: 401 });
  return { p, u, data };
}

/** First login / reset: choose a new password. */
export async function loginChangePassword(token, password) {
  const { p, u, data } = pendingFor(token);
  if (p.stage !== 'change-password') throw new Error('Not expected now');
  const bad = checkPassword(password);
  if (bad) throw new Error(bad);
  if (bcrypt.compareSync(String(password), u.hash)) throw new Error('Choose a different password from the temporary one');
  u.hash = bcrypt.hashSync(password, BCRYPT_COST);
  u.mustChangePassword = false;
  saveUsers(data);
  p.stage = nextStage(u);
  return stageInfo(token, p, u);
}

/** Send a one-time code by e-mail (alternative to the authenticator app at login). */
export async function sendEmailCode(token, sendMail) {
  const { p, u } = pendingFor(token);
  if (p.stage !== 'otp') throw new Error('Not expected now');
  if (!u.email) throw new Error('No e-mail address on this account - use the authenticator app');
  const code = crypto.randomInt(0, 1e6).toString().padStart(6, '0');
  p.emailOtp = { hash: crypto.createHash('sha256').update(code).digest('hex'), expires: Date.now() + EMAIL_OTP_MINUTES * 60000, tries: 0 };
  await sendMail(u.email, 'Your Legal Register Portal sign-in code',
    `<p>Your one-time sign-in code is <b style="font-size:20px;letter-spacing:3px">${code}</b></p><p>It expires in ${EMAIL_OTP_MINUTES} minutes. If you did not try to sign in, tell your administrator.</p>`);
  return { sentTo: u.email.replace(/^(.).*(@.*)$/, '$1•••$2') };
}

/** Final step: the 6-digit code (authenticator app, or the e-mailed code). Enrolment confirms the new authenticator. */
export function loginCode(token, code) {
  const { p, u, data } = pendingFor(token);
  const c = String(code || '').replace(/\s/g, '');
  let ok = false;
  if (p.stage === 'enrol') {
    const step = verifyTotp(p.enrolSecret, c);
    if (step !== null) { u.totp = { secret: p.enrolSecret, enabled: true, lastStep: step, enrolledAt: new Date().toISOString() }; ok = true; }
  } else if (p.stage === 'otp') {
    const step = u.totp?.enabled ? verifyTotp(u.totp.secret, c) : null;
    if (step !== null && step > (u.totp.lastStep ?? -1)) { u.totp.lastStep = step; ok = true; } // a code is accepted once
    else if (p.emailOtp && p.emailOtp.expires > Date.now() && p.emailOtp.tries < 5) {
      p.emailOtp.tries++;
      if (crypto.createHash('sha256').update(c).digest('hex') === p.emailOtp.hash) ok = true;
    }
  } else throw new Error('Not expected now');
  if (!ok) {
    u.failed = (u.failed || 0) + 1;
    if (u.failed >= MAX_FAILS) { u.lockedUntil = Date.now() + LOCK_MINUTES * 60000; u.failed = 0; pending.delete(token); }
    saveUsers(data);
    throw Object.assign(new Error('Wrong or expired code'), { status: 401 });
  }
  u.failed = 0; u.lastLogin = new Date().toISOString();
  saveUsers(data);
  pending.delete(token);
  const sid = newToken();
  sessions.set(sid, { userId: u.id, expires: Date.now() + SESSION_HOURS * 3600e3 });
  return { sid, user: publicUser(u) };
}

/** Create the first administrator (only while no account exists). */
export function setupFirstAdmin({ username, password, email }) {
  if (hasUsers()) throw Object.assign(new Error('Setup is already complete'), { status: 403 });
  createUser({ username, password, role: 'admin', email }, { mustChangePassword: false });
}

// ---------------------------------------------------------------------------------------------------
// Sessions and access checks
// ---------------------------------------------------------------------------------------------------
export function sessionUser(sid) {
  const s = sid && sessions.get(sid);
  if (!s || s.expires < Date.now()) { if (sid) sessions.delete(sid); return null; }
  const u = loadUsers().users.find(x => x.id === s.userId);
  return u && u.status !== 'pending' ? publicUser(u) : null;
}
export const endSession = sid => sessions.delete(sid);
export function revokeSessions(userId) { sessions.revokeUser(userId); }
export const roleAtLeast = (user, role) => (RANK[user?.role] || 0) >= RANK[role];
export const canFacility = (user, id) => !!user && (user.role === 'admin' || user.facilities?.includes('*') || user.facilities?.includes(id));

/** Change one's own password (requires the current password). */
export function changeOwnPassword(userId, current, next) {
  const data = loadUsers();
  const u = data.users.find(x => x.id === userId);
  if (!u || !bcrypt.compareSync(String(current || ''), u.hash)) throw new Error('Current password is wrong');
  const bad = checkPassword(next);
  if (bad) throw new Error(bad);
  u.hash = bcrypt.hashSync(next, BCRYPT_COST);
  saveUsers(data);
}

export const SESSION_COOKIE = 'lrp_sid';
export const SESSION_MAX_AGE = SESSION_HOURS * 3600;
