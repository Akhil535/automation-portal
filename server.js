// Legal Register Portal - multi-facility web dashboard + REST API + nightly scheduler, in one process.
//   node --use-system-ca server.js [--config path\to\config.json] [--no-scheduler]
// Facility-scoped API calls take ?f=<facility id>; without it the default facility is used.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import './src/args.js';
import cron from 'node-cron';
import {
  APP_DIR, FIXED, IT_DEPARTMENT, dir, loadConfig, loadFacilities, loadGlobalConfig, readSecrets,
  saveConfig, saveFacilities, updateFacility, writeSecrets,
} from './src/config.js';
import { addMasterEntry, checkWorkbook, deleteMasterEntry, latestCircularDate, readDocumentControl, readMaster, registerHealth, saveDocumentControl, saveMaster } from './src/master.js';
import { ENTRY_DOC_EXTS, analyzeDocument, applyDocuments, applyLogo, applyPolicy, attachRegister, createFacility, deleteFacility, parsedForClient, removedFacilities, restoreFacility, previewDocument, readPolicy, storeUpload, uploadsDir } from './src/facilities.js';
import { Store } from './src/store.js';
import { ASSISTANT_MODEL, ask, assistantConfigured, setAssistantKey } from './src/assistant.js';
import { applyReview, currentRun, runAll, runMonitor } from './src/monitor.js';
import { startScheduler } from './src/scheduler.js';
import { addForms, addItem, checklistXlsx, crossCheck, formFile, formsStatus, formsZip, generateForms, getChecklist, pdfState, prewarmPdfs, saveDocSettings, GROUPS, importMasterChecklist, listForms, masterChecklist, removeForm, removeItem, resetChecklist, updateItem } from './src/hrforms.js';
import { documentHeader, sendMail } from './src/mailer.js';
import { lockReason, readLogo, readRegister } from './src/xlsx.js';
import { imageSize } from './src/policy.js';
import { htmlToPdf, logoDataUrl, reportHtml } from './src/report.js';
import {
  MAJOR_REVISION, addTemplates, assetFile, generatePolicies, generatedFile, generatedFiles, jobState, listTemplates,
  prepSettings, readiness, registerSourcePolicy, removeAsset, removeTemplate, saveAsset, saveSettings, zipGenerated,
  detectPictures, lockTemplates, masterFile, masterParagraphs, picturePreview, previewPolicy, saveMasterEdits, templateLock, unlockTemplates,
} from './src/policyprep.js';
import {
  ROLES, SESSION_COOKIE, SESSION_MAX_AGE, canFacility, changeOwnPassword, createUser, deleteUser, endSession, hasUsers, loadUsers, registerUser,
  loginChangePassword, loginCode, loginPassword, publicUser, roleAtLeast, sendEmailCode, sessionUser, setupFirstAdmin, updateUser,
} from './src/auth.js';

const app = express();
app.disable('x-powered-by');
const jsonSmall = express.json({ limit: '1mb' });
app.use((req, res, next) => (['/api/policies/preview', '/api/policies/picture-detect'].includes(req.path) ? next() : jsonSmall(req, res, next))); // these carry pictures

// ===================================================================================================
// Security: sign-in with username + password + 2FA, sessions, roles (RBAC), facility scoping
// ===================================================================================================
app.use((req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
  next();
});
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim()).filter(Boolean)
  .map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
// A tunnel (e.g. Cloudflare) runs on this PC, so its visitors arrive from 127.0.0.1 - they carry forwarding headers.
const forwarded = req => LOOPBACK.includes(req.socket.remoteAddress) && (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['cf-ray']);
const viaHttps = req => req.secure || (forwarded(req) && /https/i.test(String(req.headers['x-forwarded-proto'] || req.headers['cf-visitor'] || '')));
const secureFlag = req => (viaHttps(req) ? '; Secure' : '');
const setSession = (req, res, sid) => res.set('Set-Cookie', `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}${secureFlag(req)}`);
const clearSession = (req, res) => res.set('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureFlag(req)}`);
/** Truly on the portal PC (not a visitor coming through a tunnel). */
const isLocal = req => LOOPBACK.includes(req.socket.remoteAddress) && !forwarded(req);
/** The visitor's address: behind a local tunnel, the address it reports; otherwise the connection's. */
const clientIp = req => (forwarded(req) ? String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for']).split(',')[0]).trim() : req.socket.remoteAddress) || '?';

// Sign-in attempts per address: at most 30 per 10 minutes (on top of the per-account lockout).
const attempts = new Map();
function throttle(req) {
  const ip = clientIp(req), now = Date.now();
  const a = (attempts.get(ip) || []).filter(t => now - t < 600000);
  if (a.length >= 30) throw Object.assign(new Error('Too many sign-in attempts - wait a few minutes'), { status: 429 });
  a.push(now); attempts.set(ip, a);
}

// Pages and files anyone may load (the sign-in screen); everything else needs a session.
const PUBLIC = new Set(['/login.html', '/login.js', '/style.css', '/favicon.ico']);
app.use((req, res, next) => {
  if (PUBLIC.has(req.path) || req.path.startsWith('/api/auth/')) return next();
  const user = sessionUser(cookies(req)[SESSION_COOKIE]);
  if (!user) {
    if (req.path.startsWith('/api/') || req.path.startsWith('/reports/')) return res.status(401).json({ error: 'Please sign in', login: true });
    return res.redirect(302, '/login.html');
  }
  req.user = user;
  next();
});

// Role required for each kind of request, and the facility it concerns.
function requiredRole(req) {
  const p = req.path, m = req.method;
  if (p.startsWith('/api/account/') || p === '/api/me') return 'viewer';
  if (p === '/api/assistant/ask') return 'viewer'; // everyone may ask (read-only answers)
  if (p === '/api/assistant/key') return 'admin';
  if (p.startsWith('/api/users')) return 'admin';
  if (p === '/api/settings' && m !== 'GET') return 'admin';
  if (p === '/api/settings' || p === '/api/email/test') return p === '/api/email/test' ? 'admin' : 'manager';
  if (p === '/api/facilities' && m === 'POST') return 'manager'; // managers create their own facilities (they get access to them)
  if (m === 'DELETE' && /^\/api\/facilities\/[^/]+$/.test(p)) return 'admin';
  // portal-wide: the activity log of every facility, the masters (they show the template facility's documents)
  if (p === '/api/log' || p === '/api/hr/templates' || /^\/api\/policies\/templates\/[^/]+\/(view|paragraphs)$/.test(p)) return 'admin';
  if (p.startsWith('/api/policies/templates') && m !== 'GET') return 'admin'; // master policy templates are locked
  if ((p.startsWith('/api/hr/templates') && m !== 'GET') || p === '/api/hr/checklist-master') return 'admin'; // HR master forms belong to the master template
  if (m === 'GET') return 'viewer';
  return 'manager';
}
app.use((req, res, next) => {
  if (!req.user) return next();
  const need = requiredRole(req);
  if (!roleAtLeast(req.user, need)) return res.status(403).json({ error: `Your role (${req.user.role}) cannot do this - ${need} access needed` });
  // Requests that are not about one facility (pages, own account, the facility list, users) need no facility.
  const p = req.path;
  if (!(p.startsWith('/api/') || p.startsWith('/reports/')) || p === '/api/me' || p.startsWith('/api/account/') || p.startsWith('/api/users')
    || (p === '/api/facilities' && (req.method === 'GET' || req.method === 'POST'))) return next(); // listing / creating: no facility needed (the creator gets access)
  const facs = loadFacilities();
  // The master template facility (the baseline every new facility is copied from) is for administrators only.
  const allowed = fid => canFacility(req.user, fid) && (fid !== facs.templateId || req.user.role === 'admin');
  const m = p.match(/^\/api\/facilities\/([^/]+)(\/|$)/);
  const id = req.query.f || (m && !['upload', 'check-path'].includes(m[1]) ? m[1] : null);
  if (id && !allowed(id)) return res.status(403).json({ error: 'You do not have access to this facility' });
  if (!id && !allowed(facs.default)) {
    // A user limited to some facilities works on the first of them when no facility is named.
    req.facOverride = facs.list.find(f => f.id !== facs.templateId && allowed(f.id))?.id;
    if (!req.facOverride) return res.status(403).json({ error: 'No facility is assigned to your account yet - ask an administrator', noFacility: true });
  }
  next();
});

app.use(express.static(path.join(APP_DIR, 'public')));
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(e.status || 400).json({ error: e.message }));
const fac = req => req.query.f || req.facOverride || undefined;

// --- sign-in API (public) ---
app.get('/api/auth/state', wrap(async (req, res) => {
  res.json({ setup: !hasUsers(), setupAllowed: !hasUsers() && isLocal(req), user: sessionUser(cookies(req)[SESSION_COOKIE]) });
}));
app.post('/api/auth/setup', wrap(async (req, res) => {
  if (!isLocal(req)) throw Object.assign(new Error('The first administrator can only be created on the portal PC itself'), { status: 403 });
  const { username, password, email } = req.body || {};
  setupFirstAdmin({ username, password, email });
  res.json(await loginPassword(username, password)); // continue with 2FA enrolment
}));
/** Self sign-up: the account waits for an administrator's approval (role + facilities) before it can sign in. */
app.post('/api/auth/signup', wrap(async (req, res) => {
  throttle(req);
  if (!hasUsers()) throw new Error('The portal is not set up yet');
  const user = registerUser(req.body || {});
  console.log(`${new Date().toISOString()} sign-up request: ${user.username} <${user.email}>`);
  // Tell the administrators (best effort - the request is kept even when e-mail is not configured).
  const admins = loadUsers().users.filter(x => x.role === 'admin' && x.email && x.status !== 'pending').map(x => x.email);
  if (admins.length) {
    const h = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    sendMail(loadConfig(), `New portal account request: ${user.fullName}`,
      `<p><b>${h(user.fullName)}</b> (${h(user.username)}, ${h(user.email)}) asked for access to the compliance portal.</p>${user.requestNote ? `<p>Note: ${h(user.requestNote)}</p>` : ''}<p>Approve or decline it in Admin console → Users &amp; security.</p>`, admins)
      .catch(e => console.log(`sign-up notice not sent: ${e.message}`));
  }
  res.json({ ok: true, pending: true });
}));
app.post('/api/auth/login', wrap(async (req, res) => { throttle(req); res.json(await loginPassword(req.body?.username, req.body?.password)); }));
app.post('/api/auth/password', wrap(async (req, res) => { throttle(req); res.json(await loginChangePassword(req.body?.token, req.body?.password)); }));
app.post('/api/auth/email-code', wrap(async (req, res) => {
  throttle(req);
  res.json(await sendEmailCode(req.body?.token, (to, subject, html) => sendMail(loadConfig(), subject, html, [to])));
}));
app.post('/api/auth/verify', wrap(async (req, res) => {
  throttle(req);
  const { sid, user } = loginCode(req.body?.token, req.body?.code);
  setSession(req, res, sid);
  console.log(`${new Date().toISOString()} sign-in: ${user.username} (${user.role})`);
  res.json({ user });
}));
app.post('/api/auth/logout', wrap(async (req, res) => { endSession(cookies(req)[SESSION_COOKIE]); clearSession(req, res); res.json({ ok: true }); }));

// --- own account ---
app.get('/api/me', wrap(async (req, res) => res.json(req.user)));
app.post('/api/account/password', wrap(async (req, res) => {
  changeOwnPassword(req.user.id, req.body?.current, req.body?.next);
  res.json({ ok: true });
}));

// --- user administration (admin) ---
app.get('/api/users', wrap(async (req, res) => res.json({ users: loadUsers().users.map(publicUser), roles: ROLES })));
app.post('/api/users', wrap(async (req, res) => res.json(createUser(req.body || {}))));
app.put('/api/users/:id', wrap(async (req, res) => res.json(updateUser(req.params.id, req.body || {}))));
app.delete('/api/users/:id', wrap(async (req, res) => { deleteUser(req.params.id, req.user.id); res.json({ ok: true }); }));
const cfgOf = req => loadConfig(fac(req));
const notWhileRunning = () => { if (currentRun()) throw new Error('A monitoring run is in progress; try again in a moment'); };
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Facilities -------------------------------------------------------------------------------------
function facilitySummary(f, def) {
  const cfg = loadConfig(f.id);
  const store = new Store(cfg);
  const last = store.data.runs[0];
  return {
    id: f.id, code: f.code, name: f.name, title: f.title, isDefault: f.id === def, registerPath: cfg.register.path, createdBy: f.createdBy || null, createdAt: f.createdAt || null,
    lastSuccess: store.meta.lastSuccess || null, lastStatus: last?.statusLabel || null, lastStatusCode: last?.status || null,
    lock: cfg.register.path ? lockReason(cfg.register.path) : 'No master register linked',
  };
}

app.get('/api/facilities', wrap(async (req, res) => {
  const { default: def, list, templateId } = loadFacilities();
  const withHealth = async f => {
    const s = facilitySummary(f, def);
    try { const c = loadConfig(f.id); if (c.register.path && fs.existsSync(c.register.path)) s.health = registerHealth(await readMaster(c)); }
    catch { /* register unreadable (e.g. locked) - shown without health */ }
    return s;
  };
  // The master template is not a facility to work on: it is listed apart, and only for administrators.
  const out = [];
  for (const f of list.filter(x => x.id !== templateId && canFacility(req.user, x.id))) out.push(await withHealth(f));
  const tpl = templateId && req.user.role === 'admin' ? list.find(f => f.id === templateId) : null;
  res.json({
    default: out.some(f => f.id === def) ? def : (out[0]?.id || null), list: out,
    template: tpl ? { ...(await withHealth(tpl)), isTemplate: true } : null,
  });
}));

/** Mark a facility as the master template (hidden from the facility lists), or clear it. Admin only. */
app.put('/api/facilities-template', wrap(async (req, res) => {
  if (req.user.role !== 'admin') throw Object.assign(new Error('Administrators only'), { status: 403 });
  const d = loadFacilities(), id = req.body?.id || null;
  if (id && !d.list.some(f => f.id === id)) throw new Error(`Unknown facility: ${id}`);
  if (id) d.templateId = id; else delete d.templateId;
  saveFacilities(d);
  res.json({ templateId: d.templateId || null });
}));

/** Facility profile (everything except the document-control header, which is saved via /api/document-control). */
app.put('/api/facilities/:id', wrap(async (req, res) => {
  const b = req.body || {};
  const fields = {};
  if (b.name !== undefined) { if (!String(b.name).trim()) throw new Error('Centre / branch name is required'); fields.name = String(b.name).trim(); }
  if (b.responsible !== undefined) { if (!String(b.responsible).trim()) throw new Error('Responsible person is required'); fields.responsible = String(b.responsible); }
  if (b.responsibleOptions !== undefined) fields.responsibleOptions = [...new Set([b.responsible, ...b.responsibleOptions].filter(x => String(x || '').trim()))];
  if (b.emailTo !== undefined) fields.emailTo = b.emailTo.filter(Boolean);
  if (b.scopeStartDate !== undefined) {
    if (!ISO.test(b.scopeStartDate)) throw new Error('Monitoring scope must be YYYY-MM-DD');
    fields.register = { ...loadConfig(req.params.id)._facility.register, scopeStartDate: b.scopeStartDate };
  }
  if (b.makeDefault) { const d = loadFacilities(); d.default = req.params.id; saveFacilities(d); }
  updateFacility(req.params.id, fields);
  res.json({ saved: true });
}));

/** Upload a workbook for preview/validation. Body: the .xlsx bytes. Returns { token, preview }. */
app.post('/api/facilities/upload', express.raw({ type: () => true, limit: '100mb' }), wrap(async (req, res) => {
  if (!req.body?.length) throw new Error('No file received');
  if (req.body.subarray(0, 2).toString() !== 'PK') throw new Error('Not an .xlsx workbook');
  const token = crypto.randomUUID();
  const file = path.join(uploadsDir(), `${token}.xlsx`);
  fs.writeFileSync(file, req.body);
  res.json({ token, name: req.query.name || 'register.xlsx', preview: await checkWorkbook(file, loadConfig()) });
}));

/** Validate a linked path (local or network) without changing anything. */
app.post('/api/facilities/check-path', wrap(async (req, res) => {
  const p = String(req.body?.path || '').trim();
  if (!p) throw new Error('Enter the full path of the .xlsx workbook');
  res.json({ path: path.resolve(p), preview: await checkWorkbook(path.resolve(p), loadConfig()) });
}));

// Facility documents (policy or legal register; PDF / DOCX / DOC) ---------------------------------------
async function releasePreview(templateFrom) {
  try { const c = loadConfig(templateFrom || undefined); return c.register.path ? await latestCircularDate(c.register.path, c.register) : null; }
  catch { return null; }
}
async function templateEntryNames(templateFrom) {
  try { const c = loadConfig(templateFrom || undefined); return c.register.path ? (await readMaster(c)).filter(i => !i.fixed).map(i => i.name) : []; }
  catch { return []; }
}

/** Upload a facility document and read it (nothing is changed yet). */
app.post('/api/policy/parse', express.raw({ type: () => true, limit: '50mb' }), wrap(async (req, res) => {
  if (!req.body?.length) throw new Error('No file received');
  const { token, file } = storeUpload(req.body, req.query.name || '', crypto.randomUUID(), ENTRY_DOC_EXTS);
  try {
    const { parsed } = await readPolicy({ policyToken: token }, { entryNames: await templateEntryNames(req.query.template) });
    res.json({ policyToken: token, policyName: req.query.name || path.basename(file), parsed: parsedForClient(parsed), releaseDate: await releasePreview(req.query.template) });
  } catch (e) { fs.rmSync(file, { force: true }); throw e; }
}));

// --- Policy Document Preparation (master templates -> filled Word + PDF per facility) ---
const facId = req => loadConfig(fac(req))._facility.id;
app.get('/api/policies', wrap(async (req, res) => {
  const cfg = loadConfig(fac(req));
  res.json({
    templates: listTemplates(), settings: prepSettings(cfg), job: jobState(cfg._facility.id), files: generatedFiles(cfg),
    need: readiness(cfg), lastGenerated: cfg._facility.policyPrep?.lastGenerated || null, majorRevision: MAJOR_REVISION,
    linked: cfg._facility.policyPrep?.linkedAt || null,
    lock: (({ hashes, ...l }) => l)(templateLock() || { locked: false }),
  });
}));
/** Preview one policy with the values in the form (fresh every time, nothing saved). */
app.post('/api/policies/preview', express.json({ limit: '40mb' }), wrap(async (req, res) => {
  const b = req.body || {};
  const r = await previewPolicy(fac(req), { no: b.no, form: b.form || {}, pics: b.pics || {}, newFacility: !!b.newFacility, format: b.format });
  res.set({
    'Content-Type': r.type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': `inline; filename="${r.file}"`, 'Cache-Control': 'no-store',
    'X-Policy-Report': encodeURIComponent(JSON.stringify(r.report)),
  }).send(r.buffer);
}));
app.post('/api/policies/templates/lock', wrap(async (req, res) => res.json(await lockTemplates(req.user?.username))));
app.post('/api/policies/templates/unlock', wrap(async (req, res) => res.json(unlockTemplates(req.user?.username, req.body?.confirm))));
app.post('/api/policies/templates', express.raw({ type: () => true, limit: '50mb' }), wrap(async (req, res) => {
  if (!req.body?.length) throw new Error('No file received');
  // ?version=2.0 stores the file as that version; &keepPreviousAs=1.0 keeps the current master of that version as v1.0
  res.json(await addTemplates([{ name: path.basename(String(req.query.name || 'policy.docx')), buffer: req.body }], { version: req.query.version, keepPreviousAs: req.query.keepPreviousAs }));
}));
app.delete('/api/policies/templates/:no', wrap(async (req, res) => res.json({ templates: removeTemplate(req.params.no, req.query.version) })));
/** A master as it is: PDF to view, or the Word file to edit in Word. */
app.get('/api/policies/templates/:no/view', wrap(async (req, res) => {
  const r = await masterFile(req.params.no, req.query.version, req.query.format === 'docx' ? 'docx' : 'pdf');
  res.set({ 'Content-Type': r.type === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': `${r.type === 'pdf' ? 'inline' : 'attachment'}; filename="${r.name.replace(/"/g, '')}"`, 'Cache-Control': 'no-store' }).send(r.buffer);
}));
/** In-portal editing of a master: its paragraphs, and saving edits / new clauses / deletions (administrator). */
app.get('/api/policies/templates/:no/paragraphs', wrap(async (req, res) => res.json(await masterParagraphs(req.params.no, req.query.version))));
app.put('/api/policies/templates/:no/paragraphs', wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await saveMasterEdits(req.params.no, b.version, { edits: b.edits || [], inserts: b.inserts || [], deletes: b.deletes || [] }, req.user?.username));
}));
app.put('/api/policies/settings', wrap(async (req, res) => { const r = saveSettings(facId(req), req.body || {}); prewarmPdfs(facId(req)); res.json(r); }));
/** One drop for all pictures (any mix of photos, PDF, Word): each found picture goes to its slot - logo, signature, stamp. */
app.post('/api/policies/picture-detect', express.json({ limit: '60mb' }), wrap(async (req, res) => {
  const files = (req.body?.files || []).map(f => { const m = /^data:[^;]*;base64,(.+)$/.exec(f.data || ''); return m ? { name: String(f.name || 'upload'), buffer: Buffer.from(m[1], 'base64') } : null; }).filter(Boolean);
  if (!files.length) throw new Error('No file received');
  res.json(await detectPictures(files));
}));
/** Wizard upload preview: the picture cleaned (cropped, background removed, print size) - nothing is saved. */
app.post('/api/policies/picture-preview', express.raw({ type: () => true, limit: '30mb' }), wrap(async (req, res) => {
  if (!req.body?.length) throw new Error('No file received');
  res.json(await picturePreview(req.body, String(req.query.name || ''), String(req.query.kind || 'logo')));
}));
app.post('/api/policies/assets/:kind', express.raw({ type: () => true, limit: '30mb' }), wrap(async (req, res) => {
  if (!req.body?.length) throw new Error('No file received');
  const saved = await saveAsset(facId(req), req.params.kind, req.body, String(req.query.name || ''));
  if (req.params.kind === 'logo') prewarmPdfs(facId(req));
  res.json(saved);
}));
app.delete('/api/policies/assets/:kind', wrap(async (req, res) => res.json(removeAsset(facId(req), req.params.kind))));
app.get('/api/policies/assets/:kind', wrap(async (req, res) => {
  const f = assetFile(facId(req), req.params.kind);
  if (!f) return res.status(404).end();
  res.sendFile(path.resolve(f));
}));
app.post('/api/policies/generate', wrap(async (req, res) => {
  const job = generatePolicies(facId(req), { pdf: req.body?.pdf !== false });
  res.json({ started: true, total: job.total });
}));
app.get('/api/policies/file', wrap(async (req, res) => {
  const f = generatedFile(loadConfig(fac(req)), req.query.type, req.query.name);
  if (req.query.inline && f.endsWith('.pdf')) { res.type('application/pdf'); return res.sendFile(path.resolve(f)); }
  res.download(f);
}));
app.get('/api/policies/zip', wrap(async (req, res) => {
  const cfg = loadConfig(fac(req));
  const type = ['word', 'pdf'].includes(req.query.type) ? req.query.type : 'all';
  const buf = await zipGenerated(cfg, type);
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${cfg._facility.code} POLICIES ${type === 'all' ? 'Word + PDF' : type.toUpperCase()}.zip"` }).send(buf);
}));
/** Step 3: link the prepared policies to the Legal Register (facility details, approver, author from PO01). */
app.post('/api/policies/link-register', wrap(async (req, res) => {
  const id = facId(req);
  const file = registerSourcePolicy(loadConfig(id));
  const parsed = await applyPolicy(id, { policyPath: file }, m => console.log(m), { header: true, logo: false, entries: [] });
  // The logo used in the policies becomes the register's logo too.
  const lf = assetFile(id, 'logo');
  if (lf) { const b = fs.readFileSync(lf); const z = imageSize(b); if (z) await applyLogo(id, { buffer: b, ...z }, m => console.log(m)); }
  updateFacility(id, { policyPrep: { ...(loadConfig(id)._facility.policyPrep || {}), linkedAt: new Date().toISOString() } });
  res.json({ ok: true, policy: path.basename(file), fields: parsed.fields });
}));

// --- HR & onboarding forms and the ADHICS document checklist ---
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const dispo = (kind, name) => `${kind}; filename="${String(name).replace(/[^\x20-\x7e]/g, '-').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
app.get('/api/hr', wrap(async (req, res) => {
  const id = facId(req);
  prewarmPdfs(id); // PDFs are made ahead in the background, so View / PDF open at once
  res.json({ ...(await formsStatus(id)), checklist: getChecklist(id), pdf: await pdfState(id) });
}));
/** One HR form filled for the facility (name, code, logo; Acceptable Usage follows PO11) - PDF to view or Word. */
app.get('/api/hr/forms/:key', wrap(async (req, res) => {
  const r = await formFile(facId(req), req.params.key, req.query.format === 'docx' ? 'docx' : 'pdf');
  res.set({ 'Content-Type': r.type === 'pdf' ? 'application/pdf' : DOCX, 'Content-Disposition': dispo(req.query.inline && r.type === 'pdf' ? 'inline' : 'attachment', r.name),
    'Cache-Control': 'no-store', 'X-HR-Report': encodeURIComponent(JSON.stringify(r.report)) }).send(r.buffer);
}));
/** Step 2 of the sequence: all HR & onboarding documents as Word + PDF in the facility folder (background job). */
app.post('/api/hr/generate', wrap(async (req, res) => { const g = GROUPS[req.body?.group] ? req.body.group : null; const job = generateForms(facId(req), { pdf: req.body?.pdf !== false, group: g }); res.json({ started: true, total: job.total }); }));
/** Dates in the training / 3rd-party documents: one date for all (default) or own dates per document; editable details. */
app.put('/api/hr/documents', wrap(async (req, res) => { const id = facId(req); const r = saveDocSettings(id, req.body || {}); prewarmPdfs(id); res.json(r); }));
app.get('/api/hr/zip', wrap(async (req, res) => {
  const type = ['word', 'pdf'].includes(req.query.type) ? req.query.type : 'all';
  const g = GROUPS[req.query.group] ? req.query.group : null;
  const r = await formsZip(facId(req), type, g);
  const what = g === 'thirdparty' ? '3RD-PARTY DOCUMENTS' : g ? 'HR & TRAINING DOCUMENTS' : 'HR DOCUMENTS';
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': dispo('attachment', `${r.code} ${what} ${type === 'all' ? 'Word + PDF' : type.toUpperCase()}.zip`) }).send(r.buffer);
}));
app.get('/api/hr/templates', wrap(async (req, res) => res.json({ forms: listForms(), crossCheck: crossCheck(), checklist: masterChecklist() })));
app.post('/api/hr/templates', express.raw({ type: () => true, limit: '50mb' }), wrap(async (req, res) => {
  if (!req.body?.length) throw new Error('No file received');
  res.json(await addForms([{ name: path.basename(String(req.query.name || 'form.docx')), buffer: req.body }], { key: req.query.key }));
}));
app.delete('/api/hr/templates/:key', wrap(async (req, res) => res.json({ forms: removeForm(req.params.key), crossCheck: crossCheck() })));
app.post('/api/hr/checklist-master', express.raw({ type: () => true, limit: '20mb' }), wrap(async (req, res) => {
  if (!req.body?.length) throw new Error('No file received');
  res.json({ checklist: await importMasterChecklist(req.body) });
}));
app.get('/api/hr/checklist.xlsx', wrap(async (req, res) => {
  const only = req.query.sections ? String(req.query.sections).split(',').filter(Boolean) : null;
  const r = await checklistXlsx(facId(req), only);
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': dispo('attachment', r.name), 'Cache-Control': 'no-store' }).send(r.buffer);
}));
app.post('/api/hr/checklist/reset', wrap(async (req, res) => res.json(resetChecklist(facId(req)))));
app.post('/api/hr/checklist/:section', wrap(async (req, res) => res.json(addItem(facId(req), req.params.section, req.body?.name, req.user?.username))));
app.patch('/api/hr/checklist/:section/:item', wrap(async (req, res) => res.json(updateItem(facId(req), req.params.section, req.params.item, req.body || {}, req.user?.username))));
app.delete('/api/hr/checklist/:section/:item', wrap(async (req, res) => res.json(removeItem(facId(req), req.params.section, req.params.item))));

app.post('/api/policy/parse-path', wrap(async (req, res) => {
  const { file, parsed } = await readPolicy({ policyPath: req.body?.path }, { entryNames: await templateEntryNames(req.body?.template) });
  res.json({ policyPath: file, parsed: parsedForClient(parsed), releaseDate: await releasePreview(req.body?.template) });
}));

/** What a document would change for an existing facility: details, logo and register entries (nothing is written). */
app.post('/api/facilities/:id/document/preview', wrap(async (req, res) => {
  const { parsed, entries } = await previewDocument(req.params.id, req.body || {});
  res.json({ parsed: parsedForClient(parsed), entries });
}));

/** Apply a facility document: { policyToken|policyPath, policyName, header, logo, entries }. */
app.post('/api/facilities/:id/policy', wrap(async (req, res) => {
  notWhileRunning();
  const b = req.body || {};
  const parsed = await applyPolicy(req.params.id, b, m => console.log(m), { header: b.header, logo: b.logo, entries: b.entries });
  res.json({ parsed: parsedForClient(parsed), facility: loadConfig(req.params.id)._facility });
}));

/** Remove a facility (its folder is archived, nothing is erased). */
app.delete('/api/facilities/:id', wrap(async (req, res) => {
  notWhileRunning();
  res.json(deleteFacility(req.params.id));
}));
/** Removed facilities (kept in facilities/_removed) and putting one back. Administrators only. */
const adminOnly = req => { if (req.user.role !== 'admin') throw Object.assign(new Error('Administrators only'), { status: 403 }); };
app.get('/api/facilities-removed', wrap(async (req, res) => { adminOnly(req); res.json({ list: removedFacilities() }); }));
app.post('/api/facilities-removed/:archive/restore', wrap(async (req, res) => { adminOnly(req); notWhileRunning(); res.json(restoreFacility(req.params.archive)); }));

// Register entry documents (licences, certificates, contracts): recognise -> review -> apply -------------
app.post('/api/facilities/:id/documents/analyze', express.raw({ type: () => true, limit: '50mb' }), wrap(async (req, res) => {
  if (!req.body?.length) throw new Error('No file received');
  res.json(await analyzeDocument(req.params.id, req.body, String(req.query.name || 'document.pdf'), crypto.randomUUID()));
}));

app.post('/api/facilities/:id/documents/apply', wrap(async (req, res) => {
  notWhileRunning();
  res.json(await applyDocuments(req.params.id, req.body?.items || [], m => console.log(m)));
}));

/** The stored source document of a register entry (opens in the browser). */
app.get('/api/facility-document', wrap(async (req, res) => {
  const d = cfgOf(req)._facility.documents?.[String(req.query.entry || '')];
  if (!d?.file || !fs.existsSync(d.file)) return res.status(404).send('Document not found');
  res.type(path.extname(d.file)).set('Content-Disposition', `inline; filename="${path.basename(d.file).replace(/"/g, '')}"`).sendFile(d.file);
}));

app.post('/api/facilities/:id/register', wrap(async (req, res) => {
  notWhileRunning();
  loadConfig(req.params.id);
  const target = await attachRegister(req.params.id, req.body || {});
  res.json({ path: target });
}));

/** Create a facility: from another facility's workbook (template), an upload, or a linked path. */
app.post('/api/facilities', wrap(async (req, res) => {
  notWhileRunning();
  const b = { ...(req.body || {}) };
  // Managers: a new facility is copied from the master template or from a facility they can open – never from
  // someone else's facility, and never from a file path on this PC (attaching an existing register is for admins).
  if (req.user.role !== 'admin') {
    const facs0 = loadFacilities();
    if (b.source && b.source !== 'template') throw Object.assign(new Error('Only an administrator can add a facility from an existing register'), { status: 403 });
    if (b.policyPath) throw Object.assign(new Error('Only an administrator can read documents from a path on this PC'), { status: 403 });
    if (!b.templateFrom) b.templateFrom = facs0.templateId || facs0.default;
    if (b.templateFrom !== facs0.templateId && !canFacility(req.user, b.templateFrom)) throw Object.assign(new Error('You do not have access to that facility'), { status: 403 });
  }
  const id = await createFacility(b, m => console.log(m));
  // the creator owns it: recorded on the facility, and a manager limited to some facilities gets access to it
  updateFacility(id, { createdBy: req.user.username, createdAt: new Date().toISOString() });
  if (req.user.role !== 'admin' && !req.user.facilities?.includes('*')) updateUser(req.user.id, { facilities: [...(req.user.facilities || []), id] });
  const { default: def, list } = loadFacilities();
  res.json({ id, facility: facilitySummary(list.find(f => f.id === id), def) });
}));

/** The facility logo for the portal header: the stored policy logo, otherwise the picture in its register. */
app.get('/api/facility-logo', wrap(async (req, res) => {
  const cfg = cfgOf(req);
  let buf = cfg._facility.logo && fs.existsSync(cfg._facility.logo) ? fs.readFileSync(cfg._facility.logo) : null;
  if (!buf && cfg.register.path && fs.existsSync(cfg.register.path)) buf = await readLogo(cfg.register.path, [cfg.documentControl.sheet, cfg.master.sheet]).catch(() => null);
  const size = buf && imageSize(buf);
  if (!size || size.width < 16 || size.height < 8) return res.status(404).end(); // none, or the blank placeholder
  res.type(size.ext === 'jpg' ? 'image/jpeg' : `image/${size.ext}`).set('Cache-Control', 'no-cache').send(buf);
}));

// Status / runs -------------------------------------------------------------------------------------
app.get('/api/status', wrap(async (req, res) => {
  const cfg = cfgOf(req);
  const store = new Store(cfg);
  let register = { path: cfg.register.path };
  if (!cfg.register.path) register.error = 'No master register linked - add one in Settings';
  else {
    try {
      const snap = await readRegister(cfg.register.path, cfg.register);
      register = { ...register, records: snap.records.length, lastRow: snap.lastDataRow, latest: snap.records.at(-1)?.number,
        blankMetadata: snap.records.filter(r => Object.values(r.meta).every(v => v === null || v === '')).length };
    } catch (e) { register.error = e.message; }
    register.lock = lockReason(cfg.register.path);
  }
  const circulars = store.circulars();
  const run = currentRun();
  // Workflow tracker: documents ingested, register health, facilities, next nightly check.
  const docs = Object.values(cfg._facility.documents || {});
  let health = null;
  try { if (cfg.register.path && !register.error) health = registerHealth(await readMaster(cfg)); } catch { /* locked / unreadable */ }
  const workflow = {
    facilities: loadFacilities().list.length, documents: docs.length,
    lastDocumentAt: docs.map(d => d.appliedAt).filter(Boolean).sort().at(-1) || null,
    policy: !!cfg._facility.policyPath, logo: !!cfg._facility.logo, health, nextRun: nextDailyRun(cfg.schedule),
  };
  res.json({
    workflow,
    facility: cfg.facility, running: run ? { mode: run.mode, started: run.started, facility: run.facility, facilityName: run.facilityName, log: run.log.slice(-40) } : null,
    lastSuccess: store.meta.lastSuccess || null, lastRun: store.data.runs[0] || null, register,
    itItems: circulars.filter(c => (c.decision === 'it_related' || c.decision === 'it_review') && c.excelRow).length,
    documentControl: cfg.documentControl.values, branch: cfg.branch, itDepartment: IT_DEPARTMENT, fixed: FIXED,
    complianceOptions: [cfg.compliance.labels.compliant, cfg.compliance.labels.notApplicable],
    awaitingApproval: circulars.filter(c => c.status === 'awaiting_approval' || c.status === 'pending_excel').length,
    conflicts: circulars.filter(c => c.status === 'conflict').length,
    schedule: cfg.schedule, emailEnabled: cfg.email.enabled, emailMode: cfg.email.mode,
    emailReady: !!(cfg.email.enabled && cfg.email.host && cfg.email.to?.length), emailTo: roleAtLeast(req.user, 'manager') ? cfg.email.to : undefined,
  });
}));

/**
 * Next time of a daily "m h * * *" or weekly "m h * * d" schedule (Asia/Dubai, UTC+4, no daylight saving) as an
 * ISO date-time, or null.
 */
function nextDailyRun(schedule) {
  const m = /^(\d+) (\d+) \* \* (\*|[0-6])$/.exec(schedule?.nightlyCron || '');
  if (!m || !schedule.enabled) return null;
  const offset = 4 * 3600e3, now = Date.now();
  const local = new Date(now + offset);
  let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), +m[2], +m[1]) - offset;
  if (m[3] === '*') { if (t <= now) t += 864e5; }
  else { while (t <= now || new Date(t + offset).getUTCDay() !== +m[3]) t += 864e5; }
  return new Date(t).toISOString();
}

app.post('/api/run', wrap(async (req, res) => {
  if (currentRun()) return res.status(409).json({ error: 'A run is already in progress' });
  const { mode = 'update', force = false, all = false } = req.body || {};
  if (all && req.user.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can check all facilities at once' });
  const m = mode === 'check' ? 'check' : 'update';
  (all ? runAll(m, { force: !!force, trigger: 'portal' }) : runMonitor(m, { force: !!force, trigger: 'portal', facility: fac(req) })).catch(() => {});
  res.status(202).json({ started: true });
}));

app.get('/api/circulars', wrap(async (req, res) => res.json(new Store(cfgOf(req)).circulars().map(({ text, ...c }) => c))));
/** Brief for the dashboard: the newest circulars in the register and this year's totals (read-only). */
const briefCache = new Map();
app.get('/api/circulars/brief', wrap(async (req, res) => {
  const cfg = cfgOf(req);
  const file = cfg.register.path;
  if (!file || !fs.existsSync(file)) return res.json({ total: 0, latest: [], year: null });
  const key = `${file}|${fs.statSync(file).mtimeMs}`;
  if (!briefCache.has(key)) {
    const { records } = await readRegister(file, cfg.register);
    const iso = r => (typeof r.dateRaw === 'number' ? new Date(Date.UTC(1899, 11, 30) + r.dateRaw * 86400000).toISOString().slice(0, 10) : /^\d{4}-\d{2}-\d{2}$/.test(r.dateRaw || '') ? r.dateRaw : '');
    const rows = records.map(r => ({ number: r.number || '', name: r.name || '', date: iso(r), category: r.category || '', url: /^https:\/\/(www\.)?doh\.gov\.ae\//i.test(r.url || '') ? r.url : '',
      compliance: r.meta?.compliance || '', responsible: r.meta?.responsible || '', target: r.meta?.targetDate || '' }));
    const year = new Date().getUTCFullYear();
    const thisYear = rows.filter(r => r.date.startsWith(String(year)));
    const na = cfg.compliance?.labels?.notApplicable || 'Not Applicable';
    const brief = {
      total: rows.length,
      year: { year, count: thisYear.length, applicable: thisYear.filter(r => r.compliance && r.compliance !== na).length,
        notApplicable: thisYear.filter(r => r.compliance === na).length, it: thisYear.filter(r => /IT Department/i.test(r.responsible)).length,
        recalls: thisYear.filter(r => /recall|withdraw|suspension/i.test(r.name)).length },
      latest: rows.slice(-4).reverse(),
    };
    briefCache.clear(); briefCache.set(key, brief);
  }
  res.json(briefCache.get(key));
}));

app.post('/api/circulars/:key/review', wrap(async (req, res) => {
  const { values, reviewer, note } = req.body || {};
  const { text, ...rest } = await applyReview(req.params.key, values || {}, reviewer, note, fac(req));
  res.json(rest);
}));

// Master table (LEGAL REGISTER sheet) and document-control header --------------------------------
app.get('/api/master', wrap(async (req, res) => {
  const cfg = cfgOf(req);
  if (!cfg.register.path) throw new Error('No master register linked for this facility - add one in Settings');
  res.json({ documents: Object.fromEntries(Object.entries(cfg._facility.documents || {}).map(([k, d]) => [k, { issued: d.issued, expiry: d.expiry, appliedAt: d.appliedAt, original: d.original, hasFile: !!(d.file && fs.existsSync(d.file)) }])), items: await readMaster(cfg), labels: cfg.master.labels, documentControl: await readDocumentControl(cfg), branch: cfg.branch, lock: lockReason(cfg.register.path) });
}));

app.post('/api/master/entries', wrap(async (req, res) => {
  notWhileRunning();
  const r = await addMasterEntry(req.body?.entry || {}, fac(req), x => console.log(x));
  res.json({ ...r, items: await readMaster(cfgOf(req)) });
}));

app.delete('/api/master/entries/:row', wrap(async (req, res) => {
  notWhileRunning();
  const r = await deleteMasterEntry(Number(req.params.row), fac(req), x => console.log(x));
  res.json({ ...r, items: await readMaster(cfgOf(req)) });
}));

app.put('/api/master', wrap(async (req, res) => {
  notWhileRunning();
  const r = await saveMaster(req.body?.items || [], fac(req), m => console.log(m));
  res.json({ ...r, items: await readMaster(cfgOf(req)) });
}));

app.get('/api/document-control', wrap(async (req, res) => res.json(await readDocumentControl(cfgOf(req)))));

app.put('/api/document-control', wrap(async (req, res) => {
  notWhileRunning();
  const r = await saveDocumentControl(req.body?.values || {}, req.body?.writeWorkbook !== false, fac(req), m => console.log(m));
  res.json({ ...r, documentControl: await readDocumentControl(cfgOf(req)) });
}));

/** Data for the compliance snapshot (print view and PDF). */
async function snapshot(req, printButton) {
  const cfg = cfgOf(req);
  const items = await readMaster(cfg);
  let buf = cfg._facility.logo && fs.existsSync(cfg._facility.logo) ? fs.readFileSync(cfg._facility.logo) : null;
  if (!buf) buf = await readLogo(cfg.register.path, [cfg.documentControl.sheet, cfg.master.sheet]).catch(() => null);
  const store = new Store(cfg);
  let circulars = {};
  try { const snap = await readRegister(cfg.register.path, cfg.register); circulars = { total: snap.records.length, latest: snap.records.at(-1)?.number }; } catch { /* locked */ }
  if (store.meta.lastSuccess) circulars.lastCheck = new Date(store.meta.lastSuccess).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return { cfg, html: reportHtml({ cfg, items, logo: logoDataUrl(buf), circulars, printButton }) };
}
const exportName = (cfg, ext) => `${cfg.facility.code} LEGAL REGISTER ${new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10)}.${ext}`;

/** Print view (opens in the browser; Print / Save as PDF). */
app.get('/api/master/export', wrap(async (req, res) => { res.type('html').send((await snapshot(req, true)).html); }));

/** PDF compliance snapshot (download). */
app.get('/api/export/pdf', wrap(async (req, res) => {
  const { cfg, html } = await snapshot(req, false);
  const pdf = await htmlToPdf(html);
  res.type('application/pdf').set('Content-Disposition', `attachment; filename="${exportName(cfg, 'pdf')}"`).send(pdf);
}));

app.get('/api/runs', wrap(async (req, res) => res.json(new Store(cfgOf(req)).data.runs.slice(0, 200))));

app.get('/api/log', wrap(async (req, res) => {
  const file = path.join(dir(cfgOf(req), 'logs'), 'portal.log');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-300) : [];
  res.json(lines);
}));

app.get('/reports/:file', (req, res) => {
  const file = path.join(dir(cfgOf(req), 'reports'), path.basename(req.params.file));
  fs.existsSync(file) ? res.sendFile(file) : res.status(404).send('Report not found');
});

app.get('/api/register/download', (req, res) => {
  const cfg = cfgOf(req);
  if (!cfg.register.path || !fs.existsSync(cfg.register.path)) return res.status(404).send('No register');
  res.download(cfg.register.path, exportName(cfg, 'xlsx')); // the live master workbook (logo, formatting, all sheets)
});

// AI assistant (read-only answers about this facility) ------------------------------------------
const askLog = new Map(); // per user: at most 20 questions a minute
app.get('/api/assistant/status', wrap(async (req, res) => res.json({ configured: assistantConfigured(), model: ASSISTANT_MODEL })));
app.post('/api/assistant/ask', wrap(async (req, res) => {
  const now = Date.now(), recent = (askLog.get(req.user.id) || []).filter(t => now - t < 60000);
  if (recent.length >= 20) throw Object.assign(new Error('Too many questions in a minute – wait a moment'), { status: 429 });
  recent.push(now); askLog.set(req.user.id, recent);
  res.json(await ask(facId(req), req.body?.question, Array.isArray(req.body?.history) ? req.body.history : []));
}));
app.put('/api/assistant/key', wrap(async (req, res) => res.json(setAssistantKey(req.body?.key))));

// Global settings (identical for every facility) -------------------------------------------------
app.get('/api/settings', wrap(async (req, res) => {
  const g = loadGlobalConfig();
  const { _file, _baseDir, _globalDir, ...cfg } = g;
  const secrets = readSecrets(g);
  const f = cfgOf(req)._facility;
  res.json({ ...cfg, facilityProfile: { ...f, registerPath: loadConfig(f.id).register.path }, itDepartment: IT_DEPARTMENT, fixed: FIXED,
    hasSmtpPassword: !!(secrets.smtpPassword || process.env.DOH_PORTAL_SMTP_PASSWORD), hasPortalPassword: !!secrets.portalPassword });
}));

app.put('/api/settings', wrap(async (req, res) => {
  const cfg = loadGlobalConfig();
  const body = req.body || {};
  const merge = (into, from) => {
    for (const [k, v] of Object.entries(from)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && into[k] && typeof into[k] === 'object') merge(into[k], v);
      else into[k] = v;
    }
  };
  for (const section of ['schedule', 'email', 'compliance', 'safety', 'facility']) if (body[section]) merge(cfg[section], body[section]);
  if (body.compliance?.labels) throw new Error('Compliance statuses are fixed');
  for (const k of ['nightlyCron', 'summaryCron']) {
    if (cfg.schedule[k] && !cron.validate(cfg.schedule[k])) throw new Error(`Invalid schedule: ${cfg.schedule[k]}`);
  }
  saveConfig(cfg);
  if (body.smtpPassword !== undefined || body.portalPassword !== undefined) {
    const secrets = readSecrets(cfg);
    if (body.smtpPassword !== undefined) secrets.smtpPassword = body.smtpPassword;
    if (body.portalPassword !== undefined) secrets.portalPassword = body.portalPassword;
    writeSecrets(cfg, secrets);
  }
  startScheduler();
  res.json({ saved: true });
}));

app.post('/api/email/test', wrap(async (req, res) => {
  await sendMail(cfgOf(req), '[DoH Monitor] Test e-mail', '<p>This is a test message from the Legal Register Portal.</p>');
  res.json({ sent: true });
}));

loadFacilities(); // creates facilities.json from a single-facility config on first start
const cfg = loadGlobalConfig();
const host = process.env.DOH_PORTAL_HOST || cfg.server.host || '127.0.0.1';
const port = Number(process.env.DOH_PORTAL_PORT || cfg.server.port || 8080);
app.listen(port, host, () => {
  console.log(`Legal Register Portal running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port} (${loadFacilities().list.length} facility(ies))`);
  if (!process.env.DOH_PORTAL_NO_SCHEDULER) startScheduler();
  else console.log('Scheduler disabled (--no-scheduler)');
});
