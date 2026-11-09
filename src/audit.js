// Audit trail: what each user did in the portal – sign-ins, facility details changes, policies / HR documents
// created, downloads, checklist and LEGAL REGISTER edits, uploads, change requests – with the exact time, the user,
// the facility and the result. One JSON line per action in data/audit.jsonl (rotated at about 5 MB; the previous file
// is kept as audit.1.jsonl). Administrators read it, e.g. to check a user's activity before allowing a facility change.
// Never stores passwords, codes or document contents: only a short, fixed description of the action.
import fs from 'node:fs';
import path from 'node:path';
import { dir, loadGlobalConfig } from './config.js';

const MAX_BYTES = 5 * 1024 * 1024;
const file = (n = '') => path.join(dir(loadGlobalConfig(), 'data'), `audit${n}.jsonl`);
const clip = (v, n = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const q = (req, k) => clip(req.query?.[k], 160);
const b = (req, k) => clip(req.body?.[k], 160);

/** [method, path pattern, area, (req, match) => description] – the first match wins. */
const RULES = [
  ['POST', /^\/api\/auth\/login$/, 'account', () => 'Signed in'],
  ['POST', /^\/api\/account\/password$/, 'account', () => 'Changed own password'],
  ['POST', /^\/api\/plan\/request$/, 'account', () => 'Asked for Premium'],
  ['POST', /^\/api\/facilities$/, 'facility', req => `Created the facility${b(req, 'name') ? ` “${b(req, 'name')}”` : ''}`],
  ['PUT', /^\/api\/facilities\/[^/]+$/, 'facility', req => `Changed facility details (${Object.keys(req.body || {}).slice(0, 8).join(', ') || 'details'})`],
  ['POST', /^\/api\/facilities\/[^/]+\/change-request$/, 'facility', req => `Asked to change the facility details: “${b(req, 'note')}”`],
  ['POST', /^\/api\/facilities\/[^/]+\/unlock$/, 'facility', req => `Allowed edits of the facility details (${Number(req.body?.hours) || 24} h)`],
  ['POST', /^\/api\/facilities\/[^/]+\/lock$/, 'facility', () => 'Locked the facility details'],
  ['POST', /^\/api\/facilities\/[^/]+\/policy$/, 'facility', () => 'Read the facility details from a policy'],
  ['POST', /^\/api\/facilities\/[^/]+\/register$/, 'register', () => 'Attached / created the LEGAL REGISTER'],
  ['DELETE', /^\/api\/facilities\/[^/]+$/, 'facility', () => 'Removed the facility'],
  ['PUT', /^\/api\/policies\/settings$/, 'facility', req => `Changed policy details (${Object.keys(req.body || {}).slice(0, 8).join(', ') || 'details'})`],
  ['POST', /^\/api\/policies\/assets\/([^/]+)$/, 'facility', (req, m) => `Uploaded the ${clip(m[1], 30)}`],
  ['DELETE', /^\/api\/policies\/assets\/([^/]+)$/, 'facility', (req, m) => `Removed the ${clip(m[1], 30)}`],
  ['PUT', /^\/api\/document-control$/, 'facility', () => 'Changed document control (dates & people)'],
  ['POST', /^\/api\/policies\/generate$/, 'policies', () => 'Created the policies'],
  ['GET', /^\/api\/policies\/file$/, 'download', req => `Downloaded policy ${q(req, 'name')}${q(req, 'inline') ? ' (viewed)' : ''}`],
  ['GET', /^\/api\/policies\/zip$/, 'download', req => `Downloaded the policies ZIP${q(req, 'type') ? ` (${q(req, 'type')})` : ''}`],
  ['POST', /^\/api\/policies\/link-register$/, 'register', () => 'Linked the policies to the LEGAL REGISTER'],
  ['GET', /^\/api\/hr\/forms\/([^/]+)$/, 'download', (req, m) => `${q(req, 'format') ? 'Downloaded' : 'Opened'} HR / vendor form ${clip(m[1], 40)}${q(req, 'format') ? ` (${q(req, 'format')})` : ''}`],
  ['POST', /^\/api\/hr\/generate$/, 'hr', req => `Created the ${b(req, 'group') === 'thirdparty' ? '3rd-party' : 'HR'} documents`],
  ['PUT', /^\/api\/hr\/documents$/, 'hr', req => `Changed document dates / details${b(req, 'group') ? ` (${b(req, 'group')})` : b(req, 'key') ? ` (${b(req, 'key')})` : ''}`],
  ['GET', /^\/api\/hr\/zip$/, 'download', req => `Downloaded the ${q(req, 'group') === 'thirdparty' ? '3rd-party' : 'HR'} documents ZIP`],
  ['GET', /^\/api\/hr\/checklist\.xlsx$/, 'download', () => 'Downloaded the checklist (Excel)'],
  ['POST', /^\/api\/hr\/checklist\/reset$/, 'checklist', () => 'Reset the checklist to the master list'],
  ['POST', /^\/api\/hr\/checklist\/([^/]+)$/, 'checklist', (req, m) => `Checklist ${clip(decodeURIComponent(m[1]), 30)}: added “${b(req, 'name')}”`],
  ['PATCH', /^\/api\/hr\/checklist\/([^/]+)\/([^/]+)$/, 'checklist', (req, m) => `Checklist ${clip(decodeURIComponent(m[1]), 30)}: ${req.body?.status ? `status → ${b(req, 'status')}` : req.body?.remarks !== undefined ? `remark → “${b(req, 'remarks')}”` : req.body?.name ? `renamed → “${b(req, 'name')}”` : 'changed'}`],
  ['DELETE', /^\/api\/hr\/checklist\/([^/]+)\/([^/]+)$/, 'checklist', (req, m) => `Checklist ${clip(decodeURIComponent(m[1]), 30)}: removed a document`],
  ['POST', /^\/api\/facilities\/[^/]+\/documents\/analyze$/, 'register', req => `Uploaded a document for the LEGAL REGISTER${q(req, 'name') ? ` (${q(req, 'name')})` : ''}`],
  ['POST', /^\/api\/facilities\/[^/]+\/documents\/apply$/, 'register', req => `Applied ${Array.isArray(req.body?.items) ? req.body.items.length : ''} document(s) to the LEGAL REGISTER`.replace('  ', ' ')],
  ['POST', /^\/api\/master\/entries$/, 'register', req => `Added a LEGAL REGISTER entry${b(req, 'name') ? ` “${b(req, 'name')}”` : ''}`],
  ['DELETE', /^\/api\/master\/entries\/([^/]+)$/, 'register', (req, m) => `Removed LEGAL REGISTER row ${clip(m[1], 10)}`],
  ['PUT', /^\/api\/master$/, 'register', () => 'Edited the LEGAL REGISTER'],
  ['GET', /^\/api\/package\.zip$/, 'download', () => 'Downloaded the facility pack (ZIP)'],
  ['GET', /^\/api\/export\/pdf$/, 'download', () => 'Downloaded the compliance snapshot (PDF)'],
  ['GET', /^\/api\/master\/export$/, 'download', () => 'Opened the LEGAL REGISTER print view'],
  ['GET', /^\/api\/register\/download$/, 'download', () => 'Downloaded the LEGAL REGISTER (Excel)'],
  ['GET', /^\/api\/facility-document$/, 'download', () => 'Opened a LEGAL REGISTER document'],
  ['POST', /^\/api\/circulars\/[^/]+\/review$/, 'register', () => 'Reviewed a DoH circular'],
  ['POST', /^\/api\/run$/, 'register', () => 'Ran the DoH check'],
  ['POST', /^\/api\/assistant\/ask$/, 'account', () => 'Asked the AI assistant'],
  ['PUT', /^\/api\/settings$/, 'admin', () => 'Changed portal settings'],
  ['POST', /^\/api\/users$/, 'admin', req => `Created user ${b(req, 'username')}`],
  ['PUT', /^\/api\/users\/([^/]+)$/, 'admin', req => `Changed a user (${Object.keys(req.body || {}).filter(k => !/pass|secret|code|token/i.test(k)).slice(0, 6).join(', ')})`],
  ['DELETE', /^\/api\/users\/([^/]+)$/, 'admin', () => 'Removed a user'],
];
const SKIP = /^\/api\/(auth\/(state|email-code|verify|password|logout|setup|signup)|policies\/(preview|picture-detect|picture-preview)|account\/welcome|policy\/parse|facilities\/(upload|check-path))/;

/** The description of a request, or null when it is not worth recording (page loads, lists, previews). */
export function describe(req) {
  const p = req.path, m = req.method;
  for (const [meth, re, area, fn] of RULES) {
    const mm = m === meth && p.match(re);
    if (mm) return { area, action: fn(req, mm) };
  }
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || SKIP.test(p) || !p.startsWith('/api/')) return null;
  return { area: 'other', action: `${m} ${clip(p, 80)}` }; // any other change is still recorded
}

/** Append one entry. Never throws (the audit must not break the portal). */
export function record(entry) {
  try {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try { if (fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, file('.1')); } catch { /* new file */ }
    fs.appendFileSync(f, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (e) { console.log(`audit not written: ${e.message}`); }
}

/** Newest first. Filters: facility id, username, since (ISO), limit. */
export function readAudit({ facility = null, user = null, since = null, limit = 200 } = {}) {
  const out = [];
  for (const f of [file(), file('.1')]) {
    let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').trimEnd().split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      if (since && e.at < since) return out;
      if (facility && e.facility !== facility) continue;
      if (user && e.user !== user) continue;
      out.push(e);
    }
    if (out.length >= limit) break;
  }
  return out;
}
