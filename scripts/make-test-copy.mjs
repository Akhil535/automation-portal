// Creates a separate TEST copy of the portal for testers (e.g. shared through a tunnel), next to the real one:
//   <Legal Register Portal>\test-portal\  - its own config, users, facilities, registers and policies (port 8090)
// The real portal's data is never changed. Copied: settings (e-mail and schedule switched off), the master template
// facility (its register is COPIED, not linked) and the locked master policy templates. Not copied: users,
// passwords, SMTP credentials, signatures / stamps, other facilities, history and logs.
// Usage: node scripts/make-test-copy.mjs            (refuses to touch an existing test copy)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(APP, '..', 'test-portal');
if (fs.existsSync(path.join(OUT, 'config.json'))) { console.error(`A test copy already exists: ${OUT} - nothing changed.`); process.exit(1); }

const realCfg = JSON.parse(fs.readFileSync(path.join(APP, 'config.json'), 'utf8'));
const realFac = JSON.parse(fs.readFileSync(path.join(APP, 'facilities.json'), 'utf8'));
const tplId = realFac.templateId || realFac.default;
const tpl = realFac.list.find(f => f.id === tplId);
if (!tpl) throw new Error('No master template facility found in facilities.json');

fs.mkdirSync(OUT, { recursive: true });
const cfg = structuredClone(realCfg);
cfg.server = { host: '127.0.0.1', port: 8090 };
cfg.email = { ...cfg.email, enabled: false, to: [], user: '', host: '', from: '' };
if (cfg.schedule) cfg.schedule.enabled = false;
fs.writeFileSync(path.join(OUT, 'config.json'), JSON.stringify(cfg, null, 2));

// the master template facility: its register is copied into the test copy
const regDir = path.join(OUT, 'facilities', tpl.id, 'register');
fs.mkdirSync(regDir, { recursive: true });
let regPath = '';
if (tpl.register?.path && fs.existsSync(tpl.register.path)) {
  regPath = path.join(regDir, path.basename(tpl.register.path));
  fs.copyFileSync(tpl.register.path, regPath);
  fs.chmodSync(regPath, 0o666);
}
const { home, logo, policyPrep, emailTo, ...keep } = tpl;
const fac = { ...keep, emailTo: [], register: { ...tpl.register, path: regPath } };
fs.writeFileSync(path.join(OUT, 'facilities.json'), JSON.stringify({ default: tpl.id, templateId: tpl.id, list: [fac] }, null, 2));

// the locked master policy templates (no previews, no backups)
const src = path.join(APP, 'data', 'policy-templates'), dst = path.join(OUT, 'data', 'policy-templates');
fs.mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src)) {
  if (!/\.docx$/i.test(f) && !['templates.json', 'lock.json'].includes(f)) continue;
  fs.copyFileSync(path.join(src, f), path.join(dst, f)); n++;
}
fs.writeFileSync(path.join(OUT, 'README.txt'), 'TEST COPY of the Compliance Portal (port 8090). Safe to delete. The real portal is in ..\\doh-portal.\r\n');
console.log(`Test copy created: ${OUT}\n  template facility: ${tpl.code} (register copied: ${regPath ? 'yes' : 'no'})\n  master policy files: ${n}`);
