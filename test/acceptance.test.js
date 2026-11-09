// Acceptance tests on a COPY of the real Legal Register against a local stand-in for the DoH site.
//   npm test                      (register path from config.json, or DOH_TEST_REGISTER=...)
// The real register is only read; all writes go to test/_work.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { startMock } from './mock-doh.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const WORK = path.join(os.tmpdir(), 'doh-portal-test');
// The app's global config.json + its default facility (facilities.json, once migrated) give the single-facility
// config the test starts from; the test then migrates that into its own facilities.json in the work folder.
const rawCfg = JSON.parse(fs.readFileSync(path.join(APP, 'config.json'), 'utf8'));
const realFacs = fs.existsSync(path.join(APP, 'facilities.json')) ? JSON.parse(fs.readFileSync(path.join(APP, 'facilities.json'), 'utf8')) : null;
const defFac = realFacs?.list.find(f => f.id === realFacs.default);
const realCfg = structuredClone(rawCfg);
if (defFac) {
  realCfg.register = { ...rawCfg.register, path: defFac.register.path, scopeStartDate: defFac.register.scopeStartDate };
  realCfg.branch = { name: defFac.name, responsible: defFac.responsible, responsibleOptions: defFac.responsibleOptions };
  realCfg.documentControl = { ...rawCfg.documentControl, values: { facilityTitle: defFac.title, documentNumber: `${defFac.code} / LGL REGISTER`, releaseDate: defFac.releaseDate, approver: defFac.approver, authors: defFac.authors } };
}
let br2File, lnkFile, ihhcFile;
const SOURCE = process.env.DOH_TEST_REGISTER || realCfg.register.path;
const REG = path.join(WORK, 'LEGAL REGISTER_MHMC.xlsx');
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sheetXml = async f => (await JSZip.loadAsync(fs.readFileSync(f))).file('xl/worksheets/sheet3.xml').async('string');
const rowXml = (xml, n) => xml.match(new RegExp(`<row\\b[^>]*\\br="${n}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`))?.[0];
const cellXml = (row, ref) => row.match(new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`))?.[0];

let mock, M, X, sourceHash, original, cfgPath, firstBlankRow, lastOrigRow, legacyRows = new Set();
const IT_DEPT = 'IT Department (3rd-Party IT Service Provider)';
const ALLOWED = [realCfg.compliance.labels.compliant, realCfg.compliance.labels.notApplicable];

const extra = (num, name, date, cats, text, opts = {}) => ({
  CircularNo: num, CircularName: name, Date: new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/ (\d{4})$/, ', $1'),
  PDF: `/-/media/test/${num.replace(/\W+/g, '-')}.ashx`, lstCategories: cats, _date: date, _text: text, ...opts,
});

const NEW = [
  extra('USO/220/2026', 'Mandatory Compliance with ADHICS Standard Version 2.0', '2026-11-02', ['Healthcare Facilities'],
    'All healthcare facilities shall comply with ADHICS. Facilities must submit the ADHICS compliance report quarterly to DoH, no later than 31 December 2026. Multi-factor authentication and backup are required.'),
  extra('USO/221/2026', 'Recall of Specific Lots of Panadol Extra Tablets', '2026-11-03', ['All Healthcare and Pharmaceutical Facilities', 'Pharmaceutical Facilities'],
    'Precautionary recall of lots 1234 and 5678. Pharmacies must quarantine stock immediately.'),
  extra('USO/222/2026', 'Updated Requirements for Home Healthcare Services Licensing', '2026-11-03', ['Healthcare Facilities'], 'Licensing requirements.'),
  extra('USO/223/2026', 'Antimicrobial Stewardship Reporting Requirements', '2026-11-04', ['Healthcare Facilities'],
    'Facilities shall submit the antimicrobial consumption report monthly to the Department. This circular is effective from 1 January 2027.'),
  extra('USO/224/2026', 'Guidance for Insurers on Claims Adjudication Timelines', '2026-11-04', ['Health Insurance Companies', 'Third Party Administrators TPA'], 'Insurers only.'),
];

before(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  sourceHash = sha(SOURCE);
  fs.copyFileSync(SOURCE, REG);
  original = path.join(WORK, 'original.xlsx');
  fs.copyFileSync(SOURCE, original);

  X = await import('../src/xlsx.js');
  const snap = await X.readRegister(REG, realCfg.register);
  const blank = snap.records.filter(r => Object.values(r.meta).every(v => v === null));
  firstBlankRow = blank[0]?.row;
  legacyRows = new Set(snap.records.filter(r => r.meta.compliance && !ALLOWED.includes(r.meta.compliance)).map(r => r.row));
  lastOrigRow = (firstBlankRow || snap.lastDataRow + 1) - 1;
  const { parseDate } = await import('../src/normalize.js');
  const site = snap.records.map((r, i) => {
    const d = parseDate(r.dateRaw) || '2019-01-01';
    const url = r.url && r.url.includes('/-/media/') ? '/-/media/' + r.url.split('/-/media/')[1] : `/-/media/reg/${r.row}.ashx`;
    const it = blank.find(b => b.row === r.row);
    return {
      CircularNo: i % 7 === 0 ? r.number.replace(/-/g, '/') : r.number, CircularName: r.name, PDF: url, _date: d,
      Date: d, lstCategories: r.category.split(/;\s*/).filter(Boolean),
      _text: it && /cloud|backup/i.test(r.name) ? 'Facilities shall adopt a multi-cloud approach and keep an on-site physical backup of patient data. Hosting providers must comply with ADHICS.' : `${r.name}.`,
    };
  });
  site.push(...NEW, { ...NEW[1] },
    extra('USO/300/2025', 'Circular Before Register Scope', '2025-12-01', ['Healthcare Facilities'], 'Old.'),
    extra('USO/170/2026', 'Completely Different Subject Sharing an Existing Number', '2026-09-01', ['Healthcare Facilities'], 'x'));
  mock = await startMock(site);

  const cfg = structuredClone(realCfg);
  cfg.register.path = REG;
  Object.assign(cfg.site, { baseUrl: mock.base, itemId: '{00000000-0000-0000-0000-000000000000}', delayMs: 0, retries: 0, timeoutSeconds: 20 });
  Object.assign(cfg.safety, { lockRetries: 1, lockRetryDelaySeconds: 1 });
  cfg.email.enabled = false;
  cfgPath = path.join(WORK, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  process.env.DOH_PORTAL_CONFIG = cfgPath;
  M = await import('../src/monitor.js');
});

after(() => mock?.server.close());
// Test servers are stopped part-way: hidden Word / PowerPoint copies they started are closed at the end of the run
// (only automation copies started during this run – never Office windows a person has open).
const RUN_STARTED = new Date();
after(() => {
  if (process.platform !== 'win32') return;
  const since = RUN_STARTED.toISOString();
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(WINWORD|POWERPNT)\\.EXE$' -and $_.CommandLine -match '/Automation' -and $_.CreationDate -ge [datetime]'${since}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { windowsHide: true, timeout: 60000 });
  } catch { /* best effort */ }
});

test('1. check-only run detects exactly the new in-scope circulars and changes nothing', async () => {
  const h = sha(REG);
  const run = await M.runMonitor('check');
  assert.equal(run.status, 'check_only', run.errors.join('; '));
  assert.deepEqual(run.newCount, 5);
  assert.deepEqual(run.conflicts.map(c => c.number), ['USO/170/2026']);
  assert.ok(run.totalChecked > 1300, `listing collected across capped pages: ${run.totalChecked}`);
  assert.equal(sha(REG), h);
});

test('2. update run appends new circulars and completes blank F-J of earlier rows', async () => {
  const run = await M.runMonitor('update');
  assert.equal(run.status, 'success', run.errors.join('; '));
  assert.equal(run.added, 5);
  assert.equal(run.filled, (firstBlankRow ? 20 : 0) + legacyRows.size, 'blank rows completed + retired statuses corrected');
  assert.ok(fs.existsSync(run.backup) && sha(run.backup) === sha(original));

  const zo = await JSZip.loadAsync(fs.readFileSync(original)), zn = await JSZip.loadAsync(fs.readFileSync(REG));
  for (const name of Object.keys(zo.files)) {
    if (zo.files[name].dir || name.startsWith('xl/worksheets/sheet3.xml') || name.startsWith('xl/worksheets/_rels/sheet3')) continue;
    if (name === 'xl/worksheets/sheet1.xml') { // DOCUMENT CONTROLLER: only C5 (Date of Release) may change
      const [a, b] = await Promise.all([zo.file(name).async('string'), zn.file(name).async('string')]);
      // only C5 (Date of Release) and C9 (any text typed over the classification badge is cleared) may change
      for (let r = 1; r <= 12; r++) if (r !== 5 && r !== 9 && rowXml(a, r)) assert.equal(rowXml(b, r), rowXml(a, r), `DOCUMENT CONTROLLER row ${r} unchanged`);
      assert.equal(cellXml(rowXml(b, 5), 'B5'), cellXml(rowXml(a, 5), 'B5'));
      assert.equal(cellXml(rowXml(b, 9), 'B9'), cellXml(rowXml(a, 9), 'B9'));
      assert.match(cellXml(rowXml(b, 9), 'C9'), /^<c r="C9" s="\d+"\/>$/, 'badge cell holds no text');
      continue;
    }
    assert.ok((await zo.file(name).async('nodebuffer')).equals(await zn.file(name).async('nodebuffer')), `part ${name} unchanged`);
  }
  const before = await sheetXml(original), now = await sheetXml(REG);
  for (let r = 1; r <= lastOrigRow; r++) {
    if (!rowXml(before, r)) continue;
    if (legacyRows.has(r)) {
      for (const c of 'ABCDEGHIJ') assert.equal(cellXml(rowXml(now, r), `${c}${r}`), cellXml(rowXml(before, r), `${c}${r}`), `${c}${r} unchanged (legacy status row)`);
    } else assert.equal(rowXml(now, r), rowXml(before, r), `row ${r} unchanged`);
  }
  for (const l of before.match(/<hyperlink [^>]*\/>/g)) assert.ok(now.includes(l), 'existing hyperlink kept');
  if (firstBlankRow) for (let r = firstBlankRow; r < firstBlankRow + 20; r++) {
    for (const c of 'ABCDE') assert.equal(cellXml(rowXml(now, r), `${c}${r}`), cellXml(rowXml(before, r), `${c}${r}`), `${c}${r} unchanged`);
  }
});

test('3. F-J follow the DoH / facility rules', async () => {
  const snap = await X.readRegister(REG, realCfg.register);
  const by = n => snap.records.find(r => r.number === n);
  const L = realCfg.compliance.labels;
  const it = by('USO/220/2026');
  assert.equal(it.meta.compliance, L.compliant, 'IT items use one of the two statuses');
  assert.equal(it.meta.responsible, IT_DEPT, 'IT Department is fixed');
  assert.equal(it.meta.frequency, '3 Months');
  assert.equal(it.meta.targetDate, 46387, 'H = 31 Dec 2026 as a real date');
  assert.deepEqual([by('USO/221/2026').meta.compliance, by('USO/221/2026').meta.targetDate], [L.compliant, 'Immediate']);
  assert.equal(by('USO/222/2026').meta.compliance, L.notApplicable, 'home healthcare -> not applicable');
  const ams = by('USO/223/2026').meta;
  assert.deepEqual([ams.compliance, ams.frequency, ams.targetDate, ams.authority, ams.responsible], [L.compliant, 'Monthly', 46388, 'DOH', realCfg.branch.responsible]);
  assert.equal(by('USO/224/2026').meta.compliance, L.notApplicable, 'insurer-only categories -> not applicable');
  assert.ok(!snap.records.some(r => r.number === 'USO/300/2025'), 'out of scope not added');
  for (const r of snap.records.filter(r => r.row > lastOrigRow - 40)) assert.ok(ALLOWED.includes(r.meta.compliance), `row ${r.row}: only the two statuses (${r.meta.compliance})`);
  assert.equal(snap.records.filter(r => r.number === 'USO/221/2026').length, 1, 'duplicate listing added once');
  if (firstBlankRow) {
    assert.equal(snap.records.filter(r => Object.values(r.meta).every(v => v === null)).length, 0, 'no blank F-J left');
    assert.equal(by('USO/110/2026')?.meta.compliance, L.notApplicable, 'ambulance (ADEMSIS) -> not applicable');
    assert.equal(by('USO/191/2026')?.meta.responsible, IT_DEPT, 'multi-cloud/backup -> IT Department');
    assert.deepEqual([by('USO/213/2026')?.meta.compliance, by('USO/213/2026')?.meta.targetDate], [L.compliant, 'Immediate'], 'recall');
  }
  const last = snap.records.at(-1), tmpl = await sheetXml(REG);
  const styles = r => [...rowXml(tmpl, r).matchAll(/<c r="([A-E])\d+" s="(\d+)"/g)].map(m => m[2]).join();
  assert.equal(styles(last.row), styles(lastOrigRow), 'new rows use the existing row style');
  assert.ok(last.url && new RegExp(`<hyperlink ref="B${last.row}"`).test(tmpl), 'B and C hyperlinked');
  assert.equal(last.serial, snap.records.at(-2).serial + 1, 'S.No continues');
});

test('4. re-run adds nothing', async () => {
  const h = sha(REG);
  const run = await M.runMonitor('update');
  assert.equal(run.status, 'no_changes', run.errors.join('; '));
  assert.equal(sha(REG), h);
});

test('5. reviewer override is written to the same row only', async () => {
  const { Store } = await import('../src/store.js');
  const { loadConfig } = await import('../src/config.js');
  const c = new Store(loadConfig()).circulars().find(x => x.number === 'USO/220/2026');
  const before = await sheetXml(REG);
  await assert.rejects(M.applyReview(c.key, { compliance: 'Under Review' }, 'Tester', ''), /Fully Complaince" or "Not Applicable/);
  await M.applyReview(c.key, { compliance: 'Not Applicable', responsible: IT_DEPT }, 'Tester', 'Not provided at this centre');
  const snap = await X.readRegister(REG, realCfg.register);
  assert.equal(snap.records.find(r => r.number === 'USO/220/2026').meta.compliance, 'Not Applicable');
  const now = await sheetXml(REG);
  const changed = snap.records.filter(r => rowXml(before, r.row) !== rowXml(now, r.row)).map(r => r.row);
  assert.deepEqual(changed, [c.excelRow]);
});

test('6. locked workbook is not modified and is reported', async () => {
  mock.state.items.push(extra('USO/230/2026', 'Infection Control Guidance Update', '2026-11-05', ['Healthcare Facilities'], 'Guidance.'));
  const h = sha(REG);
  const ps = spawn('powershell', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${REG}','Open','Read','Read'); Start-Sleep 25; $f.Close()`]);
  await new Promise(r => setTimeout(r, 3000));
  try {
    const run = await M.runMonitor('update');
    assert.equal(run.status, 'register_locked', run.statusLabel);
    assert.equal(sha(REG), h);
  } finally { ps.kill(); }
  await new Promise(r => setTimeout(r, 1500));
  const owner = path.join(WORK, '~$LEGAL REGISTER_MHMC.xlsx');
  fs.writeFileSync(owner, 'x');
  const run2 = await M.runMonitor('update');
  fs.rmSync(owner);
  assert.equal(run2.status, 'register_locked');
  assert.equal(sha(REG), h);
  const run3 = await M.runMonitor('update');
  assert.equal(run3.status, 'success', run3.errors.join('; '));
  assert.equal(run3.added, 1);
});

test('7. website failure is reported without touching the workbook', async () => {
  const h = sha(REG);
  mock.state.fail = 'all';
  const run = await M.runMonitor('update');
  mock.state.fail = '';
  assert.equal(run.status, 'failed');
  assert.ok(run.errors.length);
  assert.equal(sha(REG), h);
});

test('8. safety limit holds a large batch until approved', async () => {
  for (let i = 0; i < 3; i++) mock.state.items.push(extra(`USO/24${i}/2026`, `Clinical Practice Update Number ${i + 1}`, `2026-11-0${6 + i}`, ['Healthcare Facilities'], 'Update.'));
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.safety.maxNewPerRun = 2;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const h = sha(REG);
  const run = await M.runMonitor('update');
  assert.equal(run.status, 'awaiting_approval');
  assert.equal(sha(REG), h);
  const run2 = await M.runMonitor('update', { force: true });
  assert.equal(run2.added, 3);
});

test('9. master table: entries 1-9 editable, 10-15 fixed; document control written', async () => {
  const MA = await import('../src/master.js');
  const zBefore = await JSZip.loadAsync(fs.readFileSync(REG));
  const items = await MA.readMaster();
  assert.equal(items.length, 15);
  assert.deepEqual(items.filter(i => i.fixed).map(i => i.sl), [10, 11, 12, 13, 14, 15]);
  assert.match(items[0].name, /DEPARTMENT OF HEALTH/);
  const fixed = items.find(i => i.fixed);
  await assert.rejects(MA.saveMaster([{ row: fixed.row, expiry: '2030-01-01' }]), /fixed core regulation/);
  await assert.rejects(MA.saveMaster([{ row: items[0].row, compliance: 'Under Review' }]), /Fully Compliant" or "Not Applicable/);
  const r = await MA.saveMaster([{ row: items[0].row, expiry: '2027-03-31', due: '2027-04-01', responsible: 'Dr. Branch Manager', compliance: 'Fully Compliant' },
    { row: items[3].row, issued: items[3].issued, expiry: '', compliance: 'Not Applicable' }]);
  assert.deepEqual(r.changed.sort(), ['LEGAL REGISTER!E4', 'LEGAL REGISTER!F4', 'LEGAL REGISTER!G4', 'LEGAL REGISTER!H7'].sort());
  const after = await MA.readMaster();
  assert.deepEqual([after[0].expiry, after[0].due, after[0].responsible, after[3].compliance, after[3].expiry], ['2027-03-31', '2027-04-01', 'Dr. Branch Manager', 'Not Applicable', '______']);
  assert.deepEqual(after.slice(9), items.slice(9), 'fixed entries unchanged');

  await assert.rejects(MA.saveDocumentControl({ version: '2.0' }), /Version No\. is fixed/);
  await assert.rejects(MA.saveDocumentControl({ classification: 'PUBLIC' }), /classification is fixed/);
  await assert.rejects(MA.saveDocumentControl({ documentNumber: 'MHMC / OTHER' }), /LGL REGISTER/);
  const d = await MA.saveDocumentControl({ classification: 'RESTRICTED / داخلي', releaseDate: '2026-09-14', version: '1.0', approver: 'Dr. Mohamed Aboelkhair' });
  const dc = await MA.readDocumentControl();
  assert.equal(dc.workbook.classification, 'RESTRICTED / داخلي');
  const latest = await MA.latestCircularDate(REG, realCfg.register);
  assert.ok(latest && latest !== '2026-09-14', `latest circular date ${latest}`);
  assert.equal(dc.workbook.releaseDate, latest, 'Date of Release follows the most recent circular (set by the monitoring runs)');
  assert.equal(dc.workbook.version, '1.0');
  assert.ok(!d.changed.includes('DOCUMENT CONTROLLER!C5') && !d.changed.includes('DOCUMENT CONTROLLER!C8') && !d.changed.includes('DOCUMENT CONTROLLER!C6'), d.changed.join());

  const zAfter = await JSZip.loadAsync(fs.readFileSync(REG));
  for (const name of Object.keys(zBefore.files)) {
    if (zBefore.files[name].dir || /sheet[12].xml$/.test(name)) continue;
    assert.ok((await zBefore.file(name).async('nodebuffer')).equals(await zAfter.file(name).async('nodebuffer')), `part ${name} unchanged`);
  }
});

test('10. multi-facility: template, link, fixed elements, one DoH check for all', async () => {
  const F = await import('../src/facilities.js');
  const C = await import('../src/config.js');
  const MA = await import('../src/master.js');
  const regHash = sha(REG);
  const mainCfg = C.loadConfig();
  const src = await X.readRegister(REG, mainCfg.register);

  // a) new facility from the template of the main facility
  const id = await F.createFacility({ code: 'BR2', name: 'Branch 2', title: 'MY HEALTH MEDICAL CENTER BRANCH 2 - LEGAL REGISTER', approver: 'Dr. Branch Approver',
    authors: 'Ms. Branch Author', releaseDate: '2026-11-01', responsible: 'Dr. Branch Two', source: 'template' });
  assert.equal(id, 'br2');
  const b = C.loadConfig('br2');
  br2File = b.register.path;
  assert.ok(br2File.includes(path.join('facilities', 'br2')), br2File);
  assert.equal(sha(REG), regHash, 'template source untouched');
  const dc = await MA.readDocumentControl(b);
  assert.deepEqual([dc.workbook.facilityTitle, dc.workbook.documentNumber, dc.workbook.releaseDate, dc.workbook.approver, dc.workbook.authors, dc.workbook.version, dc.workbook.classification],
    ['MY HEALTH MEDICAL CENTER BRANCH 2 - LEGAL REGISTER', 'BR2 / LGL REGISTER', await MA.latestCircularDate(br2File, b.register), 'Dr. Branch Approver', 'Ms. Branch Author', '1.0', 'RESTRICTED / داخلي']);
  const items = await MA.readMaster(b), mainItems = await MA.readMaster(mainCfg);
  for (const i of items.filter(i => !i.fixed)) assert.deepEqual([i.expiry, i.due, i.responsible], ['______', '______', 'Dr. Branch Two'], i.name);
  const noPerson = list => list.filter(i => i.fixed).map(({ responsible, ...rest }) => rest);
  assert.deepEqual(noPerson(items), noPerson(mainItems), 'fixed core regulations identical (name, dates, compliance)');
  assert.ok(items.filter(i => i.fixed).every(i => i.responsible === 'Dr. Branch Two'), 'fixed laws assigned to this facility\'s responsible person');
  const snap = await X.readRegister(br2File, b.register);
  assert.equal(snap.records.length, src.records.length, 'circular history kept');
  const g = snap.records.map(r => String(r.meta.responsible).trim());
  assert.ok(g.every(v => v === 'Dr. Branch Two' || v === C.IT_DEPARTMENT || v === 'null'), [...new Set(g)].join(' | '));
  assert.ok(g.includes(C.IT_DEPARTMENT), 'IT Department rows unchanged');

  // b) duplicate code and invalid workbook are refused
  await assert.rejects(F.createFacility({ code: 'br2', name: 'x', title: 'x', responsible: 'x', source: 'template' }), /already exists/);
  const broken = path.join(WORK, 'broken.xlsx');
  fs.copyFileSync(REG, broken);
  const law = mainItems.find(i => i.fixed);
  await X.patchCells(broken, [{ sheet: 'LEGAL REGISTER', cells: { [`C${law.row}`]: 'Some Other Law' } }], WORK, { lockRetries: 1, backupKeep: 50 });
  const pv = await MA.checkWorkbook(broken, mainCfg);
  assert.equal(pv.ok, false);
  assert.match(pv.problems.join(), /Fixed core regulations missing/);
  await assert.rejects(F.createFacility({ code: 'BAD', name: 'Bad', title: 'Bad', responsible: 'x', source: 'link', path: broken }), /not accepted/);
  assert.ok(!C.loadFacilities().list.some(f => f.id === 'bad'), 'failed facility not kept');

  // c) linked workbook: header + fixed elements written into it
  lnkFile = path.join(WORK, 'linked.xlsx');
  fs.copyFileSync(REG, lnkFile);
  await F.createFacility({ code: 'LNK', name: 'Linked Centre', title: 'LINKED CENTRE - LEGAL REGISTER', approver: 'Dr. L', authors: 'Mr. L', releaseDate: '2026-10-01', responsible: 'Dr. Link', source: 'link', path: lnkFile });
  const ldc = await MA.readDocumentControl(C.loadConfig('lnk'));
  assert.deepEqual([ldc.workbook.facilityTitle, ldc.workbook.documentNumber, ldc.workbook.releaseDate], ['LINKED CENTRE - LEGAL REGISTER', 'LNK / LGL REGISTER', await MA.latestCircularDate(lnkFile, mainCfg.register)]);

  // d) one nightly run updates every facility, each with its own responsible person
  mock.state.items.push(extra('USO/250/2026', 'Guidance on Prescription Labelling', '2026-11-10', ['Healthcare Facilities'], 'Labelling guidance.'));
  const runs = await M.runAll('update', { trigger: 'test' });
  assert.deepEqual(runs.map(r => [r.facility, r.status, r.added]), [['mhmc', 'success', 1], ['br2', 'success', 1], ['lnk', 'success', 1]]);
  for (const [fid, person] of [['mhmc', realCfg.branch.responsible], ['br2', 'Dr. Branch Two'], ['lnk', 'Dr. Link']]) {
    const c = C.loadConfig(fid);
    const last = (await X.readRegister(c.register.path, c.register)).records.at(-1);
    assert.deepEqual([last.number, String(last.meta.responsible)], ['USO/250/2026', person], fid);
  }
  assert.ok(fs.existsSync(path.join(C.facilityHome(C.getFacility('br2')), 'data', 'db.json')), 'facility history kept separately');
  for (const fid of ['mhmc', 'br2', 'lnk']) {
    const c = C.loadConfig(fid);
    assert.equal((await MA.readDocumentControl(c)).workbook.releaseDate, await MA.latestCircularDate(c.register.path, c.register), `${fid}: Date of Release = most recent circular`);
  }
});

const SAMPLE_POLICY = 'D:/sanan/MLCD POLICIES/IHHC POLICIES/PO01-INFORMATION SECURITY HIGH LEVEL POLICY.docx';
test('10b. a facility is created from its reference policy document alone', { skip: !fs.existsSync(SAMPLE_POLICY) && 'sample policy not available' }, async () => {
  const F = await import('../src/facilities.js');
  const C = await import('../src/config.js');
  const MA = await import('../src/master.js');
  const P = await import('../src/policy.js');
  const policyHash = sha(SAMPLE_POLICY);
  const parsed = await P.parsePolicyDocx(fs.readFileSync(SAMPLE_POLICY));
  assert.deepEqual(parsed.fields, { name: 'ISHRAQ HOME HEALTH CARE', title: 'ISHRAQ HOME HEALTH CARE - LEGAL REGISTER', code: 'IHHC',
    approver: 'Mr. Hamdan Almazrouei', authors: 'Mr. Ashraf Said', responsible: 'Mr. Hamdan Almazrouei' });
  await assert.rejects(P.parsePolicyDocx(Buffer.from('not a word file')), /Word/);

  const id = await F.createFacility({ source: 'template', policyPath: SAMPLE_POLICY }); // no typed fields at all
  const c = C.loadConfig(id);
  assert.deepEqual([id, c.facility.code, c.facility.name, c._facility.approver, c._facility.authors, c._facility.responsible, c._facility.policyPath],
    ['ihhc', 'IHHC', 'ISHRAQ HOME HEALTH CARE', 'Mr. Hamdan Almazrouei', 'Mr. Ashraf Said', 'Mr. Hamdan Almazrouei', path.resolve(SAMPLE_POLICY)]);
  const dc = await MA.readDocumentControl(c);
  assert.deepEqual([dc.workbook.facilityTitle, dc.workbook.documentNumber, dc.workbook.approver, dc.workbook.authors, dc.workbook.releaseDate],
    ['ISHRAQ HOME HEALTH CARE - LEGAL REGISTER', 'IHHC / LGL REGISTER', 'Mr. Hamdan Almazrouei', 'Mr. Ashraf Said', await MA.latestCircularDate(c.register.path, c.register)]);
  assert.equal((await MA.readMaster(c)).find(i => !i.fixed).responsible, 'Mr. Hamdan Almazrouei');
  // logo from the policy header placed at the top of the DOCUMENT CONTROLLER and LEGAL REGISTER sheets
  const placed = await X.readLogo(c.register.path, ['DOCUMENT CONTROLLER', 'LEGAL REGISTER']);
  assert.ok(placed && placed.equals(parsed.logo.buffer), 'policy logo placed in the workbook');
  const z = await JSZip.loadAsync(fs.readFileSync(c.register.path));
  for (const d of ['xl/drawings/drawing1.xml', 'xl/drawings/drawing2.xml']) {
    const xml = await z.file(d).async('string');
    assert.equal((xml.match(/<xdr:oneCellAnchor>/g) || []).length, 1, `${d}: one logo anchor`);
    assert.equal((xml.match(/<xdr:twoCellAnchor/g) || []).length, d.endsWith('1.xml') ? 1 : 2, `${d}: badge (and shape) anchors untouched`);
  }
  assert.ok(fs.existsSync(c._facility.logo), 'logo kept with the facility');
  assert.equal((await X.readSheetCells(c.register.path, 'DOCUMENT CONTROLLER')).C9?.value ?? null, null, 'no text typed over the classification badge');
  assert.equal(sha(SAMPLE_POLICY), policyHash, 'policy document only read');
  ihhcFile = c.register.path;
});

const MHMC_PDF = 'D:/sanan/my health medical centre/MHMC POLICIES/PO03-INFORMATION ASSET MANAGEMENT POLICY.pdf';
test('10c. PDF / DOC documents, register import, add & delete entries, remove facility', { skip: process.platform !== 'win32' }, async () => {
  const F = await import('../src/facilities.js');
  const C = await import('../src/config.js');
  const MA = await import('../src/master.js');
  const P = await import('../src/policy.js');

  // a) PDF policy: details + logo
  if (fs.existsSync(MHMC_PDF)) {
    const p = await P.parseFacilityDocument(fs.readFileSync(MHMC_PDF), MHMC_PDF);
    assert.equal(p.kind, 'pdf');
    assert.deepEqual([p.fields.code, p.fields.name, p.fields.approver, p.fields.authors], ['MHMC', 'MY HEALTH MEDICAL CENTER', 'Dr. Mohamed Aboelkhair', 'Mr. Faisal Abdelrahman']);
    assert.ok(p.logo && p.logo.ext === 'png' && p.logo.width > 300, 'logo picture extracted from the PDF');
  }
  // b) Word 97-2003 .doc (converted by Word on this PC)
  if (fs.existsSync(SAMPLE_POLICY)) {
    const doc = path.join(WORK, 'sample.doc');
    execFileSync('powershell', ['-NoProfile', '-Command', `$w=New-Object -ComObject Word.Application;$w.DisplayAlerts=0;try{$d=$w.Documents.Open('${path.resolve(SAMPLE_POLICY)}',$false,$true);$d.SaveAs2('${doc}',0);$d.Close($false)}finally{$w.Quit()}`], { timeout: 180000 });
    const p = await P.parseFacilityDocument(fs.readFileSync(doc), doc);
    assert.equal(p.kind, 'doc');
    assert.deepEqual([p.fields.code, p.fields.approver], ['IHHC', 'Mr. Hamdan Almazrouei']);
    assert.ok(p.logo, 'logo from the .doc header');
  }
  // c) legal register PDF -> entry dates imported into a facility whose entries are empty (BR2, created from template)
  const regPdf = path.join(WORK, 'register.pdf');
  const mainCfg = C.loadConfig();
  const copy = path.join(os.tmpdir(), 'doh_portal_reg_for_pdf.xlsx');
  fs.copyFileSync(mainCfg.register.path, copy);
  execFileSync('powershell', ['-NoProfile', '-Command', `$x=New-Object -ComObject Excel.Application;$x.DisplayAlerts=$false;try{$wb=$x.Workbooks.Open('${copy}',0,$true);$wb.Worksheets.Item('LEGAL REGISTER').ExportAsFixedFormat(0,'${regPdf}');$wb.Close($false)}finally{$x.Quit()}`], { timeout: 180000 });
  const source = (await MA.readMaster(mainCfg)).filter(i => !i.fixed);
  const pv = await F.previewDocument('br2', { policyPath: regPdf });
  assert.ok(pv.entries.length >= source.length - 1, `entries matched: ${pv.entries.length}/${source.length}`);
  await F.applyPolicy('br2', { policyPath: regPdf }, () => {}, { header: false, logo: false, entries: pv.entries });
  const b = C.loadConfig('br2');
  const after = await MA.readMaster(b);
  for (const s of source.filter(s => /^\d{4}-/.test(s.expiry))) {
    const a = after.find(x => x.name === s.name);
    assert.deepEqual([a.issued, a.expiry, a.due], [s.issued, s.expiry, s.due], `${s.name} dates imported`);
  }
  assert.equal((await MA.readDocumentControl(b)).workbook.documentNumber, 'BR2 / LGL REGISTER', 'header unchanged when not selected');

  // d) delete + add entries (the merged footer row is never used)
  await assert.rejects(MA.addMasterEntry({ name: 'TEST ENTRY' }, 'br2'), /no free row/);
  const victim = after.find(x => !x.fixed && x.sl === 2);
  await MA.deleteMasterEntry(victim.row, 'br2');
  let now = await MA.readMaster(b);
  assert.equal(now.length, after.length - 1);
  assert.ok(!now.some(x => x.name === victim.name));
  assert.deepEqual(now.map(x => x.sl), now.map((_, k) => k + 1), 'SL NO renumbered');
  await assert.rejects(MA.deleteMasterEntry(now.find(x => x.fixed).row, 'br2'), /fixed core regulation/);
  const added = await MA.addMasterEntry({ name: 'CIVIL DEFENCE CERTIFICATE', issued: '2026-01-10', expiry: '2027-01-09', due: '2027-01-10' }, 'br2');
  now = await MA.readMaster(b);
  const civ = now.find(x => x.name === 'CIVIL DEFENCE CERTIFICATE');
  assert.deepEqual([civ.row, civ.expiry, civ.fixed, now.filter(x => x.fixed).length, now.length], [added.row, '2027-01-09', false, 6, after.length]);
  assert.ok(now.findIndex(x => x.fixed) > now.indexOf(civ), 'new entry before the fixed laws');
  const foot = (await X.readSheetCells(b.register.path, 'LEGAL REGISTER'));
  assert.equal(String(foot.C19?.value ?? ''), '', 'footer row untouched');

  // e) remove a facility: archived, not erased; a linked register outside its folder is untouched
  const lnkHash = sha(lnkFile);
  assert.throws(() => F.deleteFacility('mhmc'), /default facility/);
  const r = F.deleteFacility('lnk');
  assert.ok(!C.loadFacilities().list.some(f => f.id === 'lnk'));
  assert.equal(sha(lnkFile), lnkHash, 'linked register untouched');
  if (r.archived) assert.ok(fs.existsSync(r.archived), 'facility folder archived');
});

const LEGAL_DOCS = 'C:/Users/HP/Downloads/legal documents/legal documents';
test('10d. facility documents are recognised and fill the register (incl. a scanned PDF via OCR)', { skip: (process.platform !== 'win32' || !fs.existsSync(LEGAL_DOCS)) && 'sample documents not available' }, async () => {
  const F = await import('../src/facilities.js');
  const C = await import('../src/config.js');
  const MA = await import('../src/master.js');
  const id = await F.createFacility({ code: 'RPHC', name: 'RAYHAN PRIMARY HEALTHCARE CENTRE', title: 'RAYHAN PRIMARY HEALTHCARE CENTRE - LEGAL REGISTER',
    approver: 'Dr. Test Approver', authors: 'Mr. Test Author', responsible: 'Dr. Test Approver', source: 'template' });
  const expected = {
    'DOH License.pdf': ['DEPARTMENT OF HEALTH (DOH)', '2023-07-10', '2026-12-17'],
    'federal.pdf': ['ICA FEDERAL AUTHORITY FOR IDENTITY & CITIZENSHIP / ABUDHABI', '2023-07-03', '2026-07-03'],
    'Malaffi Certificate.pdf': ['MALAFI CERTIFICATION', '2024-06-14', ''],
    'MCC Approval20230524_0186.pdf': ['MONITORING AND CONTROL CENTER (MCC)', '2022-12-27', '2025-12-26'],
    'New Trade License Partners.pdf': ['DEPARTMENT OF ECONOMIC DEPARTMENT (ADDED)', '2025-12-10', '2026-12-09'],
    'Pest Control Contract Till 2026.pdf': ['TADWEER PEST CONTROL CONTRACT', '2025-07-10', '2026-07-09'],
    'RAYHAN PRIMARY HEALTHCARE CENTRE - L.L.C-2.pdf': ['WASTE MANAGEMENT CONTRACT', '2025-12-17', '2026-12-16'],
  };
  const results = [];
  const present = Object.entries(expected).filter(([f]) => fs.existsSync(path.join(LEGAL_DOCS, f)));
  assert.ok(present.length >= 3, `sample documents present: ${present.length}`);
  for (const [f, [entry, issued, expiry]] of present) {
    const r = await F.analyzeDocument(id, fs.readFileSync(path.join(LEGAL_DOCS, f)), f, crypto.randomUUID());
    assert.equal(r.entryName, entry, `${f}: entry`);
    assert.deepEqual([r.issued, r.expiry], [issued, expiry], `${f}: dates`);
    if (f.startsWith('MCC')) assert.equal(r.ocr, true, 'MCC certificate is a scan - read with OCR');
    assert.ok(!r.warnings.some(w => /another facility/.test(w)), `${f}: belongs to Rayhan`);
    results.push(r);
  }
  // the same document checked against another facility is flagged
  const other = await F.analyzeDocument('br2', fs.readFileSync(path.join(LEGAL_DOCS, 'DOH License.pdf')), 'DOH License.pdf', crypto.randomUUID());
  assert.ok(other.warnings.some(w => /another facility/.test(w)), 'document of another facility is flagged');

  const applied = await F.applyDocuments(id, results.map(r => ({ token: r.token, file: r.file, row: r.row, issued: r.issued, expiry: r.expiry, due: r.due })));
  assert.equal(applied.applied.length, present.length);
  const c = C.loadConfig(id);
  const items = await MA.readMaster(c);
  for (const [, [entry, issued, expiry]] of present) {
    const it = items.find(i => i.name === entry);
    const due = expiry ? new Date(Date.parse(expiry + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10) : '______';
    assert.deepEqual([it.issued, it.expiry || '', it.due], [issued, expiry || '______', due], entry);
    assert.ok(fs.existsSync(c._facility.documents[entry].file), `${entry}: source document kept`);
  }
  // Date of Release = the latest of the newest circular and the newest document
  const latest = [await MA.latestCircularDate(c.register.path, c.register), ...present.map(([, [, i]]) => i)].sort().at(-1);
  assert.equal(applied.releaseDate, latest);
  assert.equal((await MA.readDocumentControl(C.loadConfig(id))).workbook.releaseDate, latest);
  await assert.rejects(F.applyDocuments(id, [{ row: results[0].row }, { row: results[0].row }]), /Two documents/);
});

const CERTS = {
  'C:/Users/HP/Downloads/ADHICS CERTIFICATE.pdf': ['ABUDHABI HEALTH CARE INFORMATION AND CYBER SECURITY STANDARD (ADHICS)', '2022-11-23', '2025-11-22', true],
  'C:/Users/HP/Downloads/JDC CERTIFICATE_MF2452.pdf': ['JAWDA DATA CERTIFICATION', '2025-12-23', '2026-08-15', false],
  'C:/Users/HP/Downloads/5 DMCC Compliance Certificate 2027.pdf': ['MONITORING AND CONTROL CENTER (MCC)', '2023-07-07', '2027-02-23', false],
};
test('10e. certificates are recognised from their content (headings drawn as pictures read by whole-page OCR)', { skip: (process.platform !== 'win32' || !Object.keys(CERTS).every(f => fs.existsSync(f))) && 'certificates not available' }, async () => {
  const R = await import('../src/recognize.js');
  const MA = await import('../src/master.js');
  const C = await import('../src/config.js');
  const entries = await MA.readMaster(C.loadConfig());
  for (const [f, [entry, issued, expiry, ocr]] of Object.entries(CERTS)) {
    const r = await R.recognizeDocument(fs.readFileSync(f), 'renamed-file.pdf', { entries }); // file name deliberately meaningless
    assert.deepEqual([r.entryName, r.issued, r.expiry], [entry, issued, expiry], path.basename(f));
    if (ocr) assert.equal(r.ocr, true, `${path.basename(f)}: needed OCR`);
  }
  assert.deepEqual(['expired', 'expiring', 'valid', 'no-expiry', 'missing', 'fixed'].map(s => s), ['expired', 'expiring', 'valid', 'no-expiry', 'missing', 'fixed']);
  const now = new Date('2026-11-06T00:00:00Z');
  assert.equal(MA.entryStatus({ expiry: '2026-11-01' }, now), 'expired');
  assert.equal(MA.entryStatus({ expiry: '2026-11-20' }, now), 'expiring');
  assert.equal(MA.entryStatus({ expiry: '2027-03-01' }, now), 'valid');
  assert.equal(MA.entryStatus({ issued: '2024-06-14', expiry: '______' }, now), 'no-expiry');
  assert.equal(MA.entryStatus({ issued: '______', expiry: '______' }, now), 'missing');
});

test('10f. weekly runs read recent circulars only; full sweep when forced; PDF snapshot export', async () => {
  const C = await import('../src/config.js');
  const MA = await import('../src/master.js');
  const { Store } = await import('../src/store.js');
  const cfg = C.loadConfig();
  const st = new Store(cfg);
  assert.ok(st.meta.lastFullScan, 'the first run was a full sweep');
  mock.state.items.push(extra('USO/260/2026', 'Update on Controlled Medicines Dispensing', '2026-11-11', ['Healthcare Facilities'], 'Pharmacies shall comply.'));
  const recent = await M.runMonitor('update', { trigger: 'test' });
  assert.equal(recent.status, 'success', recent.errors.join('; '));
  assert.equal(recent.recentOnly, true, 'regular run = recent circulars only');
  assert.ok(recent.totalChecked < 200, `only recent pages read: ${recent.totalChecked} circulars`);
  assert.equal(recent.added, 1, 'the new circular is found');
  const full = await M.runMonitor('check', { trigger: 'test', force: true });
  assert.equal(full.recentOnly, false, 'forced run = full sweep');
  assert.ok(full.totalChecked > 1300);
  if (process.platform === 'win32') {
    const R = await import('../src/report.js');
    const html = R.reportHtml({ cfg, items: await MA.readMaster(cfg), circulars: { total: 1, latest: 'USO/260/2026' } });
    // the master's structure only: Document Control + the 7 columns of the LEGAL REGISTER, nothing added
    assert.ok(html.includes('A. Document Control') && html.includes('RESTRICTED'));
    assert.ok(html.includes('<th>SL NO</th><th>NAME OF DEPARTMENT</th><th>ISSUED DATE</th><th>EXPIRY DATE</th><th>DUE DATE</th><th>RESPONSIBLE PERSON</th><th>COMPLIANCE</th>'), 'the master\'s 7 columns');
    assert.doesNotMatch(html, /Compliance status|Total entries|class="tile|class="pill|DoH circulars/, 'no summary tiles, scores, status labels or circular statistics');
    const pdf = await R.htmlToPdf(html);
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF', 'PDF created');
  }
});

test('10g. security: sign-in with password + 2FA, lockout, roles and facility access (separate test server)', async () => {
  const A = await import('../src/auth.js');
  const port = 18000 + Math.floor(Math.random() * 1000);
  let srv = spawn(process.execPath, ['--use-system-ca', path.join(APP, 'server.js'), '--no-scheduler'],
    { env: { ...process.env, DOH_PORTAL_CONFIG: cfgPath, DOH_PORTAL_PORT: String(port), DOH_PORTAL_HOST: '127.0.0.1' }, stdio: process.env.SHOW_SRV ? 'inherit' : 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/auth/state`); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
    const post = (p, body, cookie) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    const totpNow = secret => A.totpAt(secret.replace(/\s/g, ''), Math.floor(Date.now() / 30000));

    // other sites cannot frame the portal, but its own document viewers can (DENY made the master policies blank)
    const hs = (await fetch(`${base}/api/auth/state`)).headers;
    assert.equal(hs.get('x-frame-options'), 'SAMEORIGIN'); assert.equal(hs.get('content-security-policy'), "frame-ancestors 'self'");

    // nothing is reachable without signing in
    assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).status, 302);
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/register/download`)).status, 401);
    assert.deepEqual((await (await fetch(`${base}/api/auth/state`)).json()).setup, true);

    // a visitor coming through a tunnel on this PC is not "local": it cannot create the first administrator
    const viaTunnel = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify({ username: 'intruder', password: 'Intruder-Pass-1' }) });
    assert.equal(viaTunnel.status, 403, 'setup refused through a tunnel');
    assert.equal((await (await fetch(`${base}/api/auth/state`, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).json()).setupAllowed, false);

    // first administrator + authenticator enrolment
    let r =await (await post('/api/auth/setup', { username: 'admin', password: 'Admin-Pass-2026', email: '' })).json();
    assert.equal(r.stage, 'enrol');
    assert.match(r.enrol.qr, /^data:image\/png;base64,/);
    assert.match(r.enrol.uri, /^otpauth:\/\/totp\/.*secret=[A-Z2-7]+/);
    assert.equal((await post('/api/auth/verify', { token: r.token, code: '000000' })).status, 401, 'wrong code refused');
    const enrolSecret = r.enrol.secret;
    const firstCode = totpNow(enrolSecret); // reused below: the replay check must not depend on the 30 s window
    let v = await post('/api/auth/verify', { token: r.token, code: firstCode });
    assert.equal(v.status, 200);
    const adminCookie = v.headers.get('set-cookie').split(';')[0];
    assert.match(v.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: adminCookie } })).status, 200);
    assert.equal((await post('/api/auth/setup', { username: 'x2', password: 'Another-Pass-1' })).status, 403, 'setup only once');
    const stored = A.loadUsers().users[0];
    assert.match(stored.hash, /^\$2[aby]\$12\$/, 'BCrypt hash (cost 12), no plain password stored');
    assert.ok(!JSON.stringify(A.loadUsers()).includes('Admin-Pass-2026'));

    // the same code cannot be used twice; password alone never gives a session
    r = await (await post('/api/auth/login', { username: 'admin', password: 'Admin-Pass-2026' })).json();
    assert.equal(r.stage, 'otp');
    assert.equal((await post('/api/auth/verify', { token: r.token, code: firstCode })).status, 401, 'replayed code refused');

    // a viewer limited to one facility; must choose a password and enrol at first sign-in
    const mk = await post('/api/users', { username: 'viewer1', password: 'Temp-Pass-12345', role: 'viewer', facilities: ['br2'] }, adminCookie);
    assert.equal(mk.status, 200);
    r = await (await post('/api/auth/login', { username: 'viewer1', password: 'Temp-Pass-12345' })).json();
    assert.equal(r.stage, 'change-password');
    r = await (await post('/api/auth/password', { token: r.token, password: 'Viewer-Own-Pass-9' })).json();
    assert.equal(r.stage, 'enrol');
    v = await post('/api/auth/verify', { token: r.token, code: totpNow(r.enrol.secret) });
    const viewerCookie = v.headers.get('set-cookie').split(';')[0];
    const fl = await (await fetch(`${base}/api/facilities`, { headers: { Cookie: viewerCookie } })).json();
    assert.deepEqual(fl.list.map(f => f.id), ['br2'], 'viewer sees only their facility');
    assert.equal((await fetch(`${base}/api/status?f=mhmc`, { headers: { Cookie: viewerCookie } })).status, 403, 'other facility refused');
    assert.equal((await fetch(`${base}/api/status?f=br2`, { headers: { Cookie: viewerCookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/master?f=br2`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: viewerCookie }, body: '{"items":[]}' })).status, 403, 'viewer cannot edit');
    assert.equal((await fetch(`${base}/api/users`, { headers: { Cookie: viewerCookie } })).status, 403, 'viewer cannot manage users');
    assert.equal((await fetch(`${base}/api/export/pdf?f=br2`, { headers: { Cookie: viewerCookie } })).status !== 403, true, 'viewer may export');
    // nothing of another facility, whatever the route: documents, HR, downloads, logo, portal-wide log and masters
    for (const p of ['/api/hr?f=mhmc', '/api/hr/zip?f=mhmc', '/api/policies?f=mhmc', '/api/policies/zip?f=mhmc', '/api/register/download?f=mhmc', '/api/facility-logo?f=mhmc',
      '/api/master?f=mhmc', '/api/hr/checklist.xlsx?f=mhmc', '/api/facility-document?f=mhmc&entry=x', '/api/log', '/api/hr/templates', '/api/policies/templates/1/paragraphs'])
      assert.equal((await fetch(base + p, { headers: { Cookie: viewerCookie } })).status, 403, `viewer refused: ${p}`);

    // self sign-up: the account waits for approval, then the administrator chooses role and facilities
    const put = (p, body, cookie) => fetch(base + p, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    assert.equal((await post('/api/auth/signup', { username: 'newbie', password: 'short', email: 'n@example.test', fullName: 'New Person' })).status, 400, 'weak password refused');
    assert.equal((await post('/api/auth/signup', { username: 'newbie', password: 'Newbie-Pass-2026', email: 'n@example.test', fullName: 'New Person', note: 'Branch 2' })).status, 200);
    assert.equal((await post('/api/auth/signup', { username: 'NEWBIE', password: 'Newbie-Pass-2026', email: 'x@example.test', fullName: 'Copy' })).status, 400, 'username taken');
    assert.equal((await post('/api/auth/login', { username: 'newbie', password: 'Newbie-Pass-2026' })).status, 403, 'pending account cannot sign in');
    const pend = (await (await fetch(`${base}/api/users`, { headers: { Cookie: adminCookie } })).json()).users.find(x => x.username === 'newbie');
    assert.equal(pend.status, 'pending'); assert.equal(pend.role, 'viewer'); assert.equal(pend.requestNote, 'Branch 2');
    assert.equal((await put(`/api/users/${pend.id}`, { approve: true, role: 'manager', facilities: ['*'] }, adminCookie)).status, 200);
    r = await (await post('/api/auth/login', { username: 'newbie', password: 'Newbie-Pass-2026' })).json();
    assert.equal(r.stage, 'enrol', 'approved: straight to 2FA enrolment');
    v = await post('/api/auth/verify', { token: r.token, code: totpNow(r.enrol.secret) });
    const newbieCookie = v.headers.get('set-cookie').split(';')[0];

    // the master template facility is hidden from lists and closed to everyone but administrators
    assert.equal((await put('/api/facilities-template', { id: 'mhmc' }, newbieCookie)).status, 403, 'only admins set the template');
    assert.equal((await put('/api/facilities-template', { id: 'mhmc' }, adminCookie)).status, 200);
    const asAdmin = await (await fetch(`${base}/api/facilities`, { headers: { Cookie: adminCookie } })).json();
    assert.ok(!asAdmin.list.some(f => f.id === 'mhmc'), 'template not in the facility list');
    assert.equal(asAdmin.template.id, 'mhmc'); assert.equal(asAdmin.default, asAdmin.list[0].id);
    const asUser = await (await fetch(`${base}/api/facilities`, { headers: { Cookie: newbieCookie } })).json();
    assert.ok(asUser.list.length && !asUser.list.some(f => f.id === 'mhmc')); assert.equal(asUser.template, null);
    assert.equal((await fetch(`${base}/api/status?f=mhmc`, { headers: { Cookie: newbieCookie } })).status, 403, 'template closed to users');
    assert.equal((await (await fetch(`${base}/api/status`, { headers: { Cookie: newbieCookie } })).json()).facility.id, asUser.list[0].id, 'no facility named: first real facility');
    assert.equal((await fetch(`${base}/api/status?f=mhmc`, { headers: { Cookie: adminCookie } })).status, 200, 'admins can open the template');
    assert.equal((await put('/api/facilities-template', { id: null }, adminCookie)).status, 200);

    // facility isolation between users: nothing ticked = no facility (never "all")
    assert.equal((await put(`/api/users/${pend.id}`, { facilities: [] }, adminCookie)).status, 200);
    const none = await (await fetch(`${base}/api/facilities`, { headers: { Cookie: newbieCookie } })).json();
    assert.deepEqual(none.list, [], 'no facility ticked: sees no facility');
    assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: newbieCookie } })).status, 403, 'and cannot open any');
    // …but can start the New facility wizard: the master policy list only, nothing of any facility
    const np = await fetch(`${base}/api/policies`, { headers: { Cookie: newbieCookie } });
    assert.equal(np.status, 200, 'the wizard opens without a facility');
    const npd = await np.json();
    assert.equal(npd.newPackOnly, true); assert.deepEqual(npd.settings, {}); assert.deepEqual(npd.files.word, []);
    assert.ok(Array.isArray(npd.templates));
    assert.equal((await fetch(`${base}/api/policies/picture-preview?kind=logo&name=x.png`, { method: 'POST', headers: { Cookie: newbieCookie, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('not a picture') })).status !== 403, true, 'picture checks are not blocked');
    assert.equal((await fetch(`${base}/api/policies/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: newbieCookie }, body: '{}' })).status, 403, 'nothing else without a facility');
    assert.equal((await fetch(`${base}/api/hr`, { headers: { Cookie: newbieCookie } })).status, 403);
    // a manager may create a facility (from the master template) and it becomes theirs – only theirs
    assert.equal((await put('/api/facilities-template', { id: 'mhmc' }, adminCookie)).status, 200);
    assert.equal((await post('/api/facilities', { source: 'excel', path: 'C:/Windows/win.ini', code: 'XX', name: 'X' }, newbieCookie)).status, 403, 'no registers from a path on the PC');
    assert.equal((await post('/api/facilities', { code: 'MGR', name: 'Manager Clinic', templateFrom: 'br2' }, newbieCookie)).status, 403, 'cannot copy a facility they cannot open');
    const made = await post('/api/facilities', { source: 'template', code: 'MGR', name: 'Manager Clinic', title: 'MANAGER CLINIC - LEGAL REGISTER', approver: 'Dr. Test', authors: 'Mr. Test', responsible: 'Dr. Test' }, newbieCookie);
    assert.equal(made.status, 200, await made.clone().text());
    const mgrId = (await made.json()).id;
    const mine = await (await fetch(`${base}/api/facilities`, { headers: { Cookie: newbieCookie } })).json();
    assert.deepEqual(mine.list.map(f => f.id), [mgrId], 'the manager sees only the facility they created');
    assert.equal(mine.list[0].createdBy, 'newbie');
    assert.equal((await fetch(`${base}/api/status?f=br2`, { headers: { Cookie: newbieCookie } })).status, 403, 'and not the others');
    assert.equal((await fetch(`${base}/api/facilities?f=${mgrId}`, { headers: { Cookie: viewerCookie } })).status !== 403 &&
      !(await (await fetch(`${base}/api/facilities`, { headers: { Cookie: viewerCookie } })).json()).list.some(f => f.id === mgrId), true, 'another user does not see it');
    assert.equal((await fetch(`${base}/api/status?f=${mgrId}`, { headers: { Cookie: viewerCookie } })).status, 403, 'another user cannot open it');
    assert.equal((await post('/api/run', { all: true }, newbieCookie)).status, 403, 'only admins check all facilities at once');
    assert.equal((await fetch(`${base}/api/facilities/${mgrId}`, { method: 'DELETE', headers: { Cookie: newbieCookie } })).status, 403, 'managers cannot delete facilities');
    // free trial (self sign-ups start on it): hard limits, the upgrade gateway (402), a locked LEGAL REGISTER preview
    const { default: JSZip } = await import('jszip');
    const P = await import('../src/plans.js');
    const nb = { headers: { Cookie: newbieCookie } }, q = `?f=${mgrId}`;
    const plan = await (await fetch(`${base}/api/plan`, nb)).json();
    assert.equal(plan.plan, 'trial'); assert.deepEqual(plan.limits, { policies: 2, hr: 2, thirdparty: 0, facilities: 1, uploads: 2 });
    assert.equal(plan.usage.facilities, 1, 'facilities are counted by who created them');
    for (const [m, p] of [['PUT', '/api/master'], ['POST', '/api/run'], ['GET', '/api/register/download'], ['GET', '/api/export/pdf'], ['GET', '/api/master/export'], ['POST', '/api/policies/link-register'], ['PUT', '/api/document-control']]) {
      const x = await fetch(base + p + q, { method: m, headers: { 'Content-Type': 'application/json', Cookie: newbieCookie }, body: m === 'GET' ? undefined : '{}' });
      assert.equal(x.status, 402, `trial: ${m} ${p} is locked`);
      const d = await x.json(); assert.equal(d.upgrade, true); assert.match(d.error, /Get Premium to unlock full compliance packs/);
    }
    assert.notEqual((await fetch(`${base}/api/master${q}`, nb)).status, 402, 'the register can still be looked at (preview)');
    // one facility per account, on every plan – only an administrator can allow more
    const facBody = c => ({ source: 'template', code: c, name: `${c} Clinic`, title: `${c} - LEGAL REGISTER`, approver: 'Dr. T', authors: 'Mr. T', responsible: 'Dr. T' });
    const second = await post('/api/facilities', facBody('MG2'), newbieCookie);
    assert.equal(second.status, 403, 'a second facility needs an administrator');
    const sj = await second.json(); assert.equal(sj.adminNeeded, true); assert.match(sj.error, /ask an administrator/);
    assert.equal((await (await fetch(`${base}/api/plan`, nb)).json()).usage.facilities, 1);
    const nbId = A.loadUsers().users.find(x => x.username === 'newbie').id;
    assert.equal((await put(`/api/users/${nbId}`, { facilityAllowance: 2 }, newbieCookie)).status, 403, 'users cannot raise their own allowance');
    assert.equal((await put(`/api/users/${nbId}`, { facilityAllowance: 2 }, adminCookie)).status, 200);
    const second2 = await post('/api/facilities', facBody('MG2'), newbieCookie);
    assert.equal(second2.status, 200, 'allowed by the administrator');
    const secondId = (await second2.json()).id;
    assert.equal((await post('/api/facilities', facBody('MG3'), newbieCookie)).status, 403, 'and no more than that');
    assert.equal((await put(`/api/users/${nbId}`, { facilityAllowance: 1 }, adminCookie)).status, 200);

    // after creation the facility's details lock: changes only with an administrator's permission
    const edit = (cookie, p, body) => fetch(`${base}${p}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    assert.equal((await edit(newbieCookie, `/api/policies/settings${q}`, { contactPhone: '0500000001' })).status !== 423, true, 'not locked before the policies are created');
    assert.equal((await post(`/api/facilities/${mgrId}/lock`, {}, newbieCookie)).status, 403, 'users cannot lock / unlock');
    assert.equal((await post(`/api/facilities/${mgrId}/lock`, {}, adminCookie)).status, 200, '(finalised – as after creating the policies)');
    const lk = await edit(newbieCookie, `/api/policies/settings${q}`, { contactPhone: '0500000002' });
    assert.equal(lk.status, 423, 'policy details locked'); assert.match((await lk.json()).error, /require explicit Administrator permission/);
    assert.equal((await edit(newbieCookie, `/api/facilities/${mgrId}`, { name: 'Renamed Clinic' })).status, 423, 'facility name locked');
    assert.equal((await fetch(`${base}/api/policies/assets/logo${q}&name=x.png`, { method: 'POST', headers: { Cookie: newbieCookie, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('x') })).status, 423, 'pictures locked');
    assert.equal((await edit(newbieCookie, `/api/facilities/${mgrId}`, { emailTo: ['ops@example.test'] })).status, 200, 'notification e-mails stay editable');
    assert.equal((await edit(adminCookie, `/api/facilities/${mgrId}`, { name: 'Manager Clinic' })).status, 200, 'administrators can always edit');
    assert.equal((await post(`/api/facilities/${mgrId}/change-request`, { note: 'x' }, newbieCookie)).status, 400, 'say what should change');
    assert.equal((await post(`/api/facilities/${mgrId}/change-request`, { note: 'New phone number 0501112222' }, newbieCookie)).status, 200);
    let fx = (await (await fetch(`${base}/api/facilities`, { headers: { Cookie: adminCookie } })).json()).list.find(f => f.id === mgrId);
    assert.equal(fx.detailsLocked, true); assert.equal(fx.changeRequest.by, 'newbie');
    assert.equal((await post(`/api/facilities/${mgrId}/unlock`, { hours: 1 }, newbieCookie)).status, 403);
    assert.equal((await post(`/api/facilities/${mgrId}/unlock`, { hours: 1 }, adminCookie)).status, 200);
    assert.notEqual((await edit(newbieCookie, `/api/policies/settings${q}`, { contactPhone: '0501112222' })).status, 423, 'editable while allowed');
    fx = (await (await fetch(`${base}/api/facilities`, { headers: { Cookie: adminCookie } })).json()).list.find(f => f.id === mgrId);
    assert.equal(fx.changeRequest, null, 'the request is answered'); assert.ok(fx.editUnlock?.until);
    assert.equal((await post(`/api/facilities/${mgrId}/lock`, {}, adminCookie)).status, 200);
    assert.equal((await edit(newbieCookie, `/api/policies/settings${q}`, { contactPhone: '0509999999' })).status, 423, 'locked again');
    // Get Premium can send people to the subscription page the administrator sets (web addresses only)
    assert.equal((await put('/api/plans', { upgradeUrl: 'javascript:alert(1)' }, adminCookie)).status, 400);
    assert.equal((await put('/api/plans', { upgradeUrl: 'https://example.test/premium' }, adminCookie)).status, 200);
    assert.equal((await (await fetch(`${base}/api/plan`, nb)).json()).upgradeUrl, 'https://example.test/premium');
    assert.equal((await put('/api/plans', { upgradeUrl: '' }, adminCookie)).status, 200);
    // documents are claimed: 2 policies, then the gateway; the same ones stay available
    const nbUser = A.loadUsers().users.find(x => x.username === 'newbie');
    assert.deepEqual([...P.claim(nbUser, 'policies', [1, 2, 3])], ['1', '2']);
    assert.throws(() => P.claim(nbUser, 'policies', [3]), e => e.status === 402 && e.upgrade);
    assert.deepEqual([...P.claim(nbUser, 'policies', [2])], ['2'], 'a claimed policy can be opened again');
    assert.equal((await fetch(`${base}/api/policies/file${q}&type=word&name=${encodeURIComponent('MGR - PO05 - Access.docx')}`, nb)).status, 402, 'a third policy is refused');
    assert.equal((await fetch(`${base}/api/policies/preview${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: newbieCookie }, body: '{"no":7}' })).status, 402);
    // facility pack: [Facility]/<four folders>; the register folder is locked on the trial
    const tree = await (await fetch(`${base}/api/package${q}`, nb)).json();
    assert.equal(tree.root, 'Manager Clinic');
    assert.deepEqual(tree.folders.map(f => f.name), ['Policies', 'HR & Onboarding Documents', '3rd-Party Vendor Documents', 'Legal Register & Reports']);
    assert.ok(tree.folders[3].files.every(f => f.locked), 'register files locked');
    const zr = await fetch(`${base}/api/package.zip${q}&modules=register`, nb);
    assert.equal(zr.status, 200);
    assert.match(zr.headers.get('content-disposition'), /Manager Clinic - Legal Register/);
    const zt = await JSZip.loadAsync(Buffer.from(await zr.arrayBuffer()));
    assert.ok(zt.file('Manager Clinic/Legal Register & Reports/LOCKED - Get Premium.txt'), Object.keys(zt.files).join(', '));
    assert.ok(!Object.keys(zt.files).some(f => f.endsWith('.xlsx')), 'no register on the trial');
    // only administrators delete
    assert.equal((await fetch(`${base}/api/hr/checklist/s/i${q}`, { method: 'DELETE', headers: { Cookie: newbieCookie } })).status, 403, 'managers cannot delete');
    assert.equal((await fetch(`${base}/api/policies/assets/logo${q}`, { method: 'DELETE', headers: { Cookie: newbieCookie } })).status, 403);
    // welcome message: shown until the user ticks "Don't show this again" (kept on the account); admins edit it
    const wl = await (await fetch(`${base}/api/welcome`, nb)).json();
    assert.equal(wl.enabled, true); assert.match(wl.text, /ADHICS/);
    assert.equal((await (await fetch(`${base}/api/me`, nb)).json()).welcomeSeen, 0);
    assert.equal((await post('/api/account/welcome', { version: wl.version }, newbieCookie)).status, 200);
    assert.equal((await (await fetch(`${base}/api/me`, nb)).json()).welcomeSeen, wl.version, 'remembered on the account');
    assert.equal((await put('/api/welcome', { title: 'X', text: 'Y' }, newbieCookie)).status, 403, 'only admins edit it');
    const wl2 = await (await put('/api/welcome', { showAgain: true }, adminCookie)).json();
    assert.equal(wl2.version, wl.version + 1, 'show again to everyone');
    assert.ok((await (await fetch(`${base}/api/me`, nb)).json()).welcomeSeen < wl2.version, 'so it shows again');

    // asking for Premium, and the administrator upgrades: no limits, the register opens, the pack holds it
    assert.equal((await post('/api/plan/request', { note: 'please' }, newbieCookie)).status, 200);
    const asked = (await (await fetch(`${base}/api/users`, { headers: { Cookie: adminCookie } })).json()).users.find(x => x.username === 'newbie');
    assert.ok(asked.premiumRequest?.at);
    // the trial includes the FIRST items of each module – always the same ones
    const inc = (await (await fetch(`${base}/api/plan`, nb)).json()).included;
    assert.deepEqual(inc.policies, ['1', '2'], 'PO01 and PO02');
    assert.equal(inc.hr.length, 2); assert.equal(inc.thirdparty.length, 0, 'vendor forms are all Premium');
    assert.deepEqual([...P.claim(nbUser, 'policies', [5, 1, 9])], ['1'], 'only the included ones of a request');
    assert.equal((await put('/api/plans', { trial: { policies: -1 } }, newbieCookie)).status, 403, 'only admins set the limits');
    assert.equal((await put('/api/plans', { trial: { policies: -1 } }, adminCookie)).status, 400);
    // document styles: 2-4 are Premium; only administrators set the default and branding
    assert.equal((await put(`/api/doc-styles/facility${q}`, { style: 'split' }, newbieCookie)).status, 402, 'custom document styles are Premium');
    assert.equal((await put(`/api/doc-styles/facility${q}`, { style: 'classic' }, newbieCookie)).status, 200, 'Modern Classic on the trial');
    assert.equal((await put('/api/policies/settings' + q, { docStyle: 'official' }, newbieCookie)).status !== 402 && (await (await fetch(`${base}/api/doc-styles${q}`, nb)).json()).effective, 'classic', 'the style cannot be set around the Premium check');
    assert.equal((await put('/api/doc-styles', { accent: '#112233' }, newbieCookie)).status, 403, 'only administrators set the branding');
    assert.equal((await put('/api/doc-styles', { accent: 'red' }, adminCookie)).status, 400);
    assert.equal((await put(`/api/users/${asked.id}`, { plan: 'premium' }, adminCookie)).status, 200);
    assert.equal((await (await fetch(`${base}/api/plan`, nb)).json()).plan, 'premium');
    assert.equal((await put(`/api/doc-styles/facility${q}`, { style: 'official' }, newbieCookie)).status, 200, 'Premium: any document style');
    assert.equal((await (await fetch(`${base}/api/doc-styles${q}`, nb)).json()).effective, 'official');
    // the default is always the master format (every kind); other styles only where a facility chose one
    assert.equal((await put('/api/doc-styles', { defaults: { hr: 'minimal' } }, adminCookie)).status, 400, 'the default cannot be changed');
    assert.equal((await put('/api/doc-styles', { default: 'classic', watermark: '' }, adminCookie)).status, 200, 'branding still saved');
    let dsx = await (await fetch(`${base}/api/doc-styles${q}`, nb)).json();
    assert.deepEqual([dsx.settings.defaults.hr, dsx.effectives.hr, dsx.effectives.thirdparty, dsx.effectives.register, dsx.effectives.policies], ['classic', 'classic', 'classic', 'classic', 'official'], 'no choice → master format; the chosen policies style stays');
    assert.equal((await put(`/api/doc-styles/facility${q}`, { style: 'official', kind: 'hr' }, newbieCookie)).status, 200, 'own choice for HR documents');
    dsx = await (await fetch(`${base}/api/doc-styles${q}`, nb)).json();
    assert.equal(dsx.effectives.hr, 'official'); assert.equal(dsx.choices.thirdparty, ''); assert.equal(dsx.effectives.thirdparty, 'classic');
    assert.equal((await fetch(`${base}/api/doc-styles/apply-all`, nb)).status, 403, 'only administrators re-create everything');
    assert.equal((await fetch(`${base}/api/doc-styles/apply-all`, { headers: { Cookie: adminCookie } })).status, 200);
    assert.equal((await put('/api/doc-styles', { default: 'classic' }, adminCookie)).status, 200, 'back to Modern Classic for every kind');
    assert.equal((await fetch(`${base}/api/register/download${q}`, nb)).status, 200, 'premium: register download');
    const zp = await JSZip.loadAsync(Buffer.from(await (await fetch(`${base}/api/package.zip${q}&modules=register,policies&type=word`, nb)).arrayBuffer()));
    assert.ok(zp.file('Manager Clinic/Legal Register & Reports/MGR LEGAL REGISTER.xlsx'), Object.keys(zp.files).join(', '));
    assert.ok(zp.file('Manager Clinic/READ ME.txt'), 'what is missing is explained (no policies yet)');
    assert.ok(!(await (await fetch(`${base}/api/users`, { headers: { Cookie: adminCookie } })).json()).users.find(x => x.username === 'newbie').premiumRequest, 'request cleared on upgrade');
    assert.equal((await fetch(`${base}/api/hr/checklist/s/i${q}`, { method: 'DELETE', headers: { Cookie: newbieCookie } })).status, 403, 'premium managers still cannot delete');

    // the administrator sees and manages everything – including what other users created
    const adminList = await (await fetch(`${base}/api/facilities`, { headers: { Cookie: adminCookie } })).json();
    assert.ok(adminList.list.some(f => f.id === mgrId) && adminList.list.some(f => f.id === 'br2'), 'admin sees every facility');
    assert.equal((await fetch(`${base}/api/status?f=${mgrId}`, { headers: { Cookie: adminCookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/log`, { headers: { Cookie: adminCookie } })).status, 200);

    // audit trail: what the user did on the facility, with exact times – for administrators only
    assert.equal((await fetch(`${base}/api/facilities/${mgrId}/activity`, nb)).status, 403, 'users cannot read the audit trail');
    const act = await (await fetch(`${base}/api/facilities/${mgrId}/activity?user=newbie`, { headers: { Cookie: adminCookie } })).json();
    const acts = act.items.map(e => e.action);
    assert.ok(act.items.every(e => e.user === 'newbie' && !Number.isNaN(Date.parse(e.at)) && e.at.includes('T')), 'one user, exact timestamps');
    assert.ok(acts.some(a => /^Asked to change the facility details: “New phone number 0501112222”/.test(a)), acts.join(' | '));
    assert.ok(acts.includes('Downloaded the facility pack (ZIP)'), 'downloads are recorded');
    assert.ok(acts.includes('Signed in'), 'sign-ins are recorded');
    assert.ok(act.items.some(e => e.result !== 'ok'), 'blocked / refused attempts are recorded too');
    const auditFile = fs.readFileSync(path.join((await import('../src/config.js')).dir((await import('../src/config.js')).loadGlobalConfig(), 'data'), 'audit.jsonl'), 'utf8');
    assert.ok(!/Newbie-Pass-2026|Admin-Pass-2026|Viewer-Own-Pass-9|Temp-Pass-12345/.test(auditFile), 'no passwords in the audit trail');
    assert.equal((await post(`/api/facilities/${mgrId}/change-request`, { note: 'Please change the facility name' }, newbieCookie)).status, 200);
    // Users & access: the user's pending request and work history across facilities
    const ua = await (await fetch(`${base}/api/users/${asked.id}/activity`, { headers: { Cookie: adminCookie } })).json();
    assert.equal(ua.user.username, 'newbie');
    assert.deepEqual(ua.requests.map(r => [r.facility.id, r.changeRequest.note]), [[mgrId, 'Please change the facility name']], 'the pending request with its reason');
    assert.ok(ua.items.length && ua.items.every(e => e.user === 'newbie'), 'their work history');
    assert.equal((await fetch(`${base}/api/users/${asked.id}/activity`, nb)).status, 403, 'administrators only');
    assert.equal((await post(`/api/facilities/${mgrId}/decline`, { reason: 'Send the trade licence first' }, newbieCookie)).status, 403, 'only admins decline');
    assert.equal((await post(`/api/facilities/${mgrId}/decline`, { reason: 'Send the trade licence first' }, adminCookie)).status, 200);
    const dec = (await (await fetch(`${base}/api/facilities`, nb)).json()).list.find(f => f.id === mgrId);
    assert.equal(dec.changeRequest, null); assert.equal(dec.changeDeclined.reason, 'Send the trade licence first', 'the user sees the answer');
    assert.equal((await fetch(`${base}/api/facilities/${mgrId}`, { method: 'DELETE', headers: { Cookie: adminCookie } })).status, 200, 'admin removes it');
    assert.equal((await fetch(`${base}/api/facilities/${secondId}`, { method: 'DELETE', headers: { Cookie: adminCookie } })).status, 200);
    assert.equal((await put('/api/facilities-template', { id: null }, adminCookie)).status, 200);

    // restarting the portal does not sign anyone out (sessions are kept on disk – only a hash of each id)
    srv.kill(); await new Promise(r => (srv.exitCode !== null ? r() : srv.once('exit', r)));
    srv = spawn(process.execPath, ['--use-system-ca', path.join(APP, 'server.js'), '--no-scheduler'],
      { env: { ...process.env, DOH_PORTAL_CONFIG: cfgPath, DOH_PORTAL_PORT: String(port), DOH_PORTAL_HOST: '127.0.0.1' }, stdio: 'ignore' });
    for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/auth/state`); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
    assert.equal((await fetch(`${base}/api/me`, { headers: { Cookie: adminCookie } })).status, 200, 'still signed in after a restart');
    const { dir: cdir, loadGlobalConfig: lgc } = await import('../src/config.js');
    const sessFile = fs.readFileSync(path.join(cdir(lgc(), 'data'), 'sessions.json'), 'utf8');
    assert.ok(!sessFile.includes(adminCookie.split('=')[1]), 'the session id itself is not stored');

    // 5 wrong passwords lock the account
    for (let i = 0; i < 5; i++) await post('/api/auth/login', { username: 'viewer1', password: 'wrong-password-1' });
    const locked = await post('/api/auth/login', { username: 'viewer1', password: 'Viewer-Own-Pass-9' });
    assert.equal(locked.status, 423);
    assert.equal((await post(`/api/users`, {}, viewerCookie)).status, 403);

    // sign-out ends the session
    await post('/api/auth/logout', {}, adminCookie);
    assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: adminCookie } })).status, 401);
  } finally { srv.kill(); }
});

test('10h. Malaffi is a lifetime certificate; logos are picked, cropped and freed of their background', async () => {
  const { entryStatus, registerHealth } = await import('../src/master.js');
  const { pickLogo, cleanLogo } = await import('../src/logoclean.js');
  const { imageSize } = await import('../src/imagesize.js');
  // Malaffi: issue date only = valid for life; expiry / due are never required.
  assert.equal(entryStatus({ name: 'MALAFI CERTIFICATION', issued: '2021-06-21', expiry: '______' }), 'lifetime');
  assert.equal(entryStatus({ name: 'Malaffi certificate', issued: '', expiry: '' }), 'missing');
  assert.equal(entryStatus({ name: 'ADHICS', issued: '2024-01-01', expiry: '______' }), 'no-expiry');
  const h = registerHealth([{ name: 'MALAFI CERTIFICATION', issued: '2021-06-21' }, { name: 'DOH', issued: '2024-01-01', expiry: '2099-01-01' }]);
  assert.equal(h.valid, 2); assert.equal(h.lifetime, 1);
  // Logo choice: a wide footer banner or a whole scanned page loses against a real logo.
  const logo = { width: 400, height: 160, where: 'page1' };
  assert.equal(pickLogo([{ width: 1700, height: 140 }, logo, { width: 1240, height: 1754 }]), logo);
  if (process.platform !== 'win32') return;
  // Clean-up: a logo on a big off-white canvas comes back tightly cropped with a transparent background.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lrp-logo-test-'));
  const padded = path.join(work, 'padded.png');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap 1200, 800; $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::FromArgb(250, 249, 246)); $g.FillEllipse([System.Drawing.Brushes]::Teal, 500, 300, 200, 120); $g.Dispose(); $b.Save('${padded}')`]);
  const buf = fs.readFileSync(padded);
  const out = await cleanLogo({ buffer: buf, ext: 'png', ...imageSize(buf) });
  assert.ok(out.cleaned, 'logo was cleaned');
  assert.ok(out.width < 260 && out.height < 180, `cropped to the mark (${out.width}x${out.height})`);
  assert.equal(out.cleaned.transparent, true);
  fs.rmSync(work, { recursive: true, force: true });
});

test('10i. policy preparation: templates are filled for a facility (ID, dates, names, logo, history, signature) as Word + PDF', async () => {
  const P = await import('../src/policyprep.js');
  const { loadConfig, loadFacilities } = await import('../src/config.js');
  const id = loadFacilities().default;
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const p = t => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const cell = t => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(t)}</w:tc>`;
  const row = (...c) => `<w:tr>${c.map(cell).join('')}</w:tr>`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0AAf9YUi4AAAAASUVORK5CYII=', 'base64');
  const pic = rid => `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="3600000" cy="900000"/><wp:docPr id="1" name="Logo"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="logo"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3600000" cy="900000"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const body = `<w:tbl>${row('ADHICS - TEST SECURITY POLICY')}${row('Policy ID', 'OLD / ADHICS - PO07')}${row('Issued on', '01/01/2020')}${row('Reviewed on', '01/01/2021')}` +
    `${row('Due for Revision on', '01/01/2022')}${row('Prepared by', 'Old Author')}${row('Approved by', 'Old Approver')}${row('Facility Name', 'OLD TOWN MEDICAL CENTER')}${row('Version', '1.0')}</w:tbl>` +
    p('This policy applies to all Users of OLD TOWN MEDICAL CENTER and its staff.') + '<w:p><w:r><w:t>Users of OLD TOWN </w:t></w:r><w:r><w:t>MEDICAL CENTER shall comply.</w:t></w:r></w:p>' +
    // incident reporting matrix like PO18: facility cells and DoH cells side by side
    `<w:tbl>${row('Mode of Communication', 'Primary: Desk@oldtown.ae Secondary: 509379664', 'Primary: Desk@oldtown.ae Secondary: 509379664', 'Primary: soc@doh.gov.ae Secondary: +971 2 4193 777')}</w:tbl>` +
    `<w:tbl>${row('S. No', 'Version number', 'Description of Changes', 'Reviewed &amp; approved by:', 'Review Date', 'Approval Signature')}${row('1', '1.0', 'Old text', 'Old Approver', '01/01/2021', '')}${row('2', '', '', '', '', '')}${row('3', '', '', '', '', '')}</w:tbl>` +
    pic('rIdOldStamp') + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>';
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdOldStamp" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/stamp.png"/></Relationships>');
  zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W}>${pic('rIdLogo')}</w:hdr>`);
  zip.file('word/_rels/header1.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/></Relationships>');
  zip.file('word/media/logo.png', png); zip.file('word/media/stamp.png', png);
  const template = await zip.generateAsync({ type: 'nodebuffer' });

  // 1. Template upload: number, standard and old facility recognised from the content (not the file name).
  const up = await P.addTemplates([{ name: 'some file.docx', buffer: template }]);
  assert.deepEqual(up.problems, []);
  const t = up.added[0];
  assert.equal(t.no, 7); assert.equal(t.standard, 'ADHICS'); assert.equal(t.oldName, 'OLD TOWN MEDICAL CENTER'); assert.ok(t.hasRevisionTable);

  // Lock: the set becomes the master baseline; while locked nothing can be replaced or removed.
  const lock = await P.lockTemplates('tester');
  assert.equal(lock.locked, true);
  assert.equal(lock.baseline.name, 'OLD TOWN MEDICAL CENTER');
  assert.deepEqual(lock.baseline.emails, ['Desk@oldtown.ae'], 'DoH address is not facility-specific');
  assert.deepEqual(lock.baseline.phones, ['509379664']);
  await assert.rejects(P.addTemplates([{ name: 'x.docx', buffer: template }]), /locked/);
  assert.throws(() => P.removeTemplate(7), /locked/);

  // 2. Details: due for revision = one year after the review date. Contacts and a logo are required for a
  //    facility other than the baseline.
  P.saveSettings(id, { issuedOn: '2022-01-01', reviewedOn: '2026-03-23', preparedBy: 'Mr. Ashraf Said', approvedBy: 'Mr. Hamdan Almazrouei', standard: 'ADHICS', versions: { 7: '2.0' } });
  assert.ok(P.readiness(loadConfig(id)).some(n => /Contact e-mail/.test(n)));
  const s = P.saveSettings(id, { contactEmail: 'info@newfacility.ae', contactPhone: '0501234567' });
  assert.equal(s.dueOn, '2027-03-23');
  await P.saveAsset(id, 'logo', png, 'logo.png');
  await P.saveAsset(id, 'signature', png, 'sig.png');
  await P.saveAsset(id, 'stamp', png, 'stamp.png');
  assert.deepEqual(P.readiness(loadConfig(id)), []);

  // 3. Generate (Word + PDF where Microsoft Word is available).
  const hasWord = process.platform === 'win32' && (() => { try { execFileSync('powershell', ['-NoProfile', '-Command', "New-Object -ComObject Word.Application | % { $_.Quit() }"], { stdio: 'ignore', timeout: 60000 }); return true; } catch { return false; } })();
  P.generatePolicies(id, { pdf: hasWord });
  for (let k = 0; k < 600 && P.jobState(id).running; k++) await new Promise(r => setTimeout(r, 250));
  const job = P.jobState(id);
  assert.equal(job.running, false); assert.deepEqual(job.problems, []);
  const cfg = loadConfig(id), code = cfg._facility.code;
  const files = P.generatedFiles(cfg);
  assert.equal(files.word.length, 1);
  if (hasWord) assert.equal(files.pdf.length, 1);
  const out = await JSZip.loadAsync(fs.readFileSync(path.join(files.folder, 'Word', files.word[0])));
  const doc = await out.file('word/document.xml').async('string');
  const text = [...doc.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join('|');
  const name = s.facilityName;
  for (const v of [`${code} / ADHICS - PO07`, '01/01/2022', '23/03/2026', '23/03/2027', 'Mr. Ashraf Said', 'Mr. Hamdan Almazrouei', name, '2.0', 'Initial release']) assert.ok(text.includes(v), `${v} in the policy`);
  assert.ok(!/OLD TOWN|Old Approver|Old Author|OLD \/|Desk@oldtown|509379664/.test(text), 'nothing of the template facility is left');
  assert.equal((text.match(/info@newfacility\.ae/g) || []).length, 2, 'facility e-mail replaced in both facility cells');
  assert.equal((text.match(/0501234567/g) || []).length, 2, 'facility phone replaced in both facility cells');
  assert.ok(text.includes('Primary: soc@doh.gov.ae Secondary: +971 2 4193 777'), 'DoH cell unchanged');
  assert.equal(job.validation.passed, job.validation.total, 'validation before export: all policies pass');
  // Preview: the same document, built from the values typed in the form, nothing saved.
  const prev = await P.previewPolicy(id, { no: 7, newFacility: true, format: 'docx', form: { name: 'Asher Clinic', code: 'ASH', issuedOn: '2026-01-01', reviewedOn: '2026-11-01', preparedBy: 'A', approvedBy: 'B', contactEmail: 'info@asherclinic.ae', contactPhone: '0509999999' } });
  const ptext = [...(await (await JSZip.loadAsync(prev.buffer)).file('word/document.xml').async('string')).matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join('|');
  assert.ok(ptext.includes('ASH / ADHICS - PO07') && ptext.includes('ASHER CLINIC') && ptext.includes('info@asherclinic.ae'));
  assert.deepEqual(prev.report.leftovers, []);
  assert.equal(P.generatedFiles(loadConfig(id)).word.length, 1, 'preview saved nothing');
  assert.deepEqual(job.results[0].report.leftovers, []);
  // Read-only on disk while locked; unlocking needs "UNLOCK"; a replacement upload locks again automatically.
  const { dir: dirOf, loadGlobalConfig: lg } = await import('../src/config.js');
  const tplFile = path.join(dirOf(lg(), 'data'), 'policy-templates', t.file);
  assert.throws(() => fs.writeFileSync(tplFile, 'x'), /EPERM|EACCES/, 'template file is read-only');
  assert.throws(() => P.unlockTemplates('tester'), /UNLOCK/);
  assert.equal(P.unlockTemplates('tester', 'unlock').locked, false);
  const again = await P.addTemplates([{ name: 'replacement.docx', buffer: template }]);
  assert.equal(again.relocked, true); assert.equal(P.templateLock().locked, true);
  // Version baselines: a 2.0 master of the same policy is stored next to the 1.0 one and used for version 2.0.
  P.unlockTemplates('tester', 'UNLOCK');
  const z2 = await JSZip.loadAsync(template);
  z2.file('word/document.xml', (await z2.file('word/document.xml').async('string')).replace(`${p('Version')}</w:tc><w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p('1.0')}`, `${p('Version')}</w:tc><w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p('2.0')}`));
  const up2 = await P.addTemplates([{ name: 'PO07 v2.docx', buffer: await z2.generateAsync({ type: 'nodebuffer' }) }]);
  const t7 = up2.templates.find(x => x.no === 7);
  assert.deepEqual(Object.keys(t7.variants).sort(), ['1.0', '2.0'], 'both versions kept');
  assert.equal(P.masterFor(t7, '2.0').usedVersion, '2.0'); assert.equal(P.masterFor(t7, '1.0').usedVersion, '1.0');
  assert.notEqual(P.masterFor(t7, '2.0').file, P.masterFor(t7, '1.0').file);
  P.unlockTemplates('tester', 'UNLOCK');
  assert.ok(!doc.includes('rIdOldStamp'), 'old stamp removed');
  assert.equal((doc.match(/name="Signature"|name="Stamp"/g) || []).length, 2, 'signature and stamp placed');
  // side by side in ONE paragraph directly below the version table (natural size, never stacked, never squeezed
  // into the Approval Signature cell)
  const sigPara = (doc.match(/<w:p>(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/g) || []).find(p => p.includes('name="Signature"'));
  assert.ok(sigPara && sigPara.includes('name="Stamp"'), 'signature and stamp side by side in one line');
  const lastTable = doc.lastIndexOf('</w:tbl>');
  assert.ok(doc.indexOf('name="Signature"') > lastTable && doc.indexOf('name="Stamp"') > lastTable, 'signature and stamp below the version table');
  assert.equal(doc.indexOf(sigPara), lastTable + '</w:tbl>'.length, 'directly under the table – nothing in between');
  assert.ok(!/<w:drawing>/.test(doc.slice(0, lastTable).slice(doc.lastIndexOf('<w:tbl>'))), 'the Approval Signature cell is left empty');
  assert.deepEqual(job.results[0].report.mismatches, [], 'every value read back correctly');
  const hdr = await out.file('word/header1.xml').async('string');
  assert.ok(/r:embed="rIdLrp\d+"/.test(hdr), 'logo replaced in the page header');
  assert.ok(/<w:jc w:val="center"\/>[\s\S]*rIdLrp/.test(hdr), 'logo centred');
  // Document styles: the same filled policy in the 4 looks – every value kept, each style's layout applied
  const DS = await import('../src/docstyle.js');
  const filledBuf = await out.generateAsync({ type: 'nodebuffer' });
  const textIn = async b => ((await (await JSZip.loadAsync(b)).file('word/document.xml').async('string')).match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) || []).map(x => x.replace(/<[^>]+>/g, '')).join('');
  const plain = await textIn(filledBuf);
  const keep = [plain.match(/Policy ID([A-Z0-9]{2,8} \/ ADHICS - PO07)/)?.[1], plain.match(/Due for Revision on(\d\d\/\d\d\/\d{4})/)?.[1]].filter(Boolean);
  assert.equal(keep.length, 2, 'the filled policy has its Policy ID and due date');
  for (const sid of ['split', 'minimal', 'official']) {
    const sb = await DS.applyDocStyle(filledBuf, { id: sid, accent: '#123456', font: '', watermark: sid === 'minimal' ? 'CONFIDENTIAL' : '' });
    const sz = await JSZip.loadAsync(sb), sx = await sz.file('word/document.xml').async('string'), txt = await textIn(sb);
    for (const v of keep) assert.ok(txt.includes(v), `${sid}: ${v} kept`);
    assert.ok(!/<w:rPr><w:color[^>]*\/><w:(b|bCs|rFonts|i|caps)[\s/>]/.test(sx), `${sid}: run properties in the order Word expects`);
    if (sid === 'split') assert.ok(/Policy details/i.test(txt) && /w:color="123456"/.test(sx), 'split: details sidebar');
    if (sid === 'minimal') assert.ok((await sz.file('word/header1.xml').async('string')).includes('string="CONFIDENTIAL"'), 'minimal: watermark');
    if (sid === 'official') assert.ok(/<w:pgBorders[\s\S]*?w:color="123456"/.test(sx), 'official: page frame');
  }
  assert.ok((await DS.applyDocStyle(filledBuf, { id: 'classic', accent: '#123456' })).equals(filledBuf), 'Modern Classic without branding: unchanged');
  // page breaks: the revision table is a normal (not floating) table whose rows never split and keep together
  const floating = '<w:tbl><w:tblPr><w:tblpPr w:vertAnchor="text" w:tblpY="199"/><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="9000"/></w:tblGrid>'
    + '<w:tr><w:tc><w:p><w:r><w:t>Version number</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Reviewed No Changes</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
  const kept = DS.keepRevisionTogether(`<w:document><w:body><w:p><w:r><w:t>Revision History</w:t></w:r></w:p>${floating}<w:p/><w:sectPr/></w:body></w:document>`);
  assert.ok(!/tblpPr/.test(kept) && /<w:jc w:val="center"\/>/.test(kept), 'floating revision table made a normal centred table');
  assert.equal((kept.match(/<w:cantSplit\/>/g) || []).length, 2, 'no row splits over two pages'); assert.ok(kept.includes('<w:tblHeader/>'), 'header row repeats');
  assert.equal((kept.match(/<w:keepNext\/>/g) || []).length, 3, 'heading and rows keep together with the signature line');
  assert.equal(DS.effectiveStyle('split', { trial: true }).id, 'classic', 'free trial: Modern Classic only');
  // Cyber Security presentation: the master's facility name (footer) and the security contact are replaced; the 4 looks
  {
    const CP = await import('../src/cyberppt.js');
    const zp = new JSZip();
    const sld = (body, foot = 'Old Homecare') => `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:grpSpPr/>${body}<p:sp><p:txBody><a:p><a:r><a:t>${foot}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const run = t => `<p:sp><p:txBody><a:p><a:r><a:rPr><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:rPr><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`;
    zp.file('ppt/presentation.xml', '<p:presentation xmlns:p="p"><p:sldSz cx="9144000" cy="6858000"/></p:presentation>');
    zp.file('ppt/slides/slide1.xml', sld(run('Prepared By: ') + run('Mr') + run(' ') + run('Sulfikar') + run('Cyber Security Presentation')));
    zp.file('ppt/slides/slide2.xml', sld(run('Example: john.doe@example.com is a phishing sender')));
    zp.file('ppt/slides/slide3.xml', sld(run('Reporting Information Security Events') + run('send it to IT Department by email : old.it@oldcare.ae (+971 50 969 3359)')));
    zp.file('ppt/slideMasters/slideMaster1.xml', '<p:sldMaster xmlns:a="a" xmlns:p="p"><p:cSld><p:bg><p:bgRef idx="1001"/></p:bg><p:spTree><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"/></p:sldMaster>');
    zp.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', '<Relationships></Relationships>');
    zp.file('ppt/theme/theme1.xml', '<a:theme xmlns:a="a"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink><a:majorFont><a:latin typeface="Calibri"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:theme>');
    zp.file('[Content_Types].xml', '<Types><Default Extension="xml" ContentType="application/xml"/></Types>');
    const info = await CP.saveMaster(await zp.generateAsync({ type: 'nodebuffer' }), 'test.pptx');
    assert.deepEqual([info.name, info.email, info.phone, info.contactSlide, info.preparer?.name], ['Old Homecare', 'old.it@oldcare.ae', '+971 50 969 3359', 3, 'Sulfikar'], 'the security contact – not the example address');
    const st = CP.cyberState(id);
    CP.saveCyber(id, { email: 'it-desk@clinic.ae', phone: '+971 2 555 0100' });
    const out = await JSZip.loadAsync(await CP.buildPpt(id, { style: 'classic' }));
    const s3 = await out.file('ppt/slides/slide3.xml').async('string'), s2 = await out.file('ppt/slides/slide2.xml').async('string');
    assert.ok(s3.includes('it-desk@clinic.ae (+971 2 555 0100)') && !s3.includes('oldcare'), 'the typed contact on the reporting slide');
    assert.ok(s2.includes(st.facilityName) && !s2.includes('Old Homecare') && s2.includes('john.doe@example.com'), 'facility name in the footer; training examples unchanged');
    CP.saveCyber(id, { email: '', phone: '' });
    const def = await (await JSZip.loadAsync(await CP.buildPpt(id, { style: 'classic' }))).file('ppt/slides/slide3.xml').async('string');
    if (st.defaults.email) assert.ok(def.includes(st.defaults.email), 'no override: the PO18 contact');
    const dark = await JSZip.loadAsync(await CP.buildPpt(id, { style: 'dark' }));
    assert.match(await dark.file('ppt/slideMasters/slideMaster1.xml').async('string'), /bg1="dk1" tx1="lt1"/, 'dark: the colour map is swapped');
    const off = await JSZip.loadAsync(await CP.buildPpt(id, { style: 'official' }));
    assert.match(await off.file('ppt/slideMasters/slideMaster1.xml').async('string'), /name="Header banner"[\s\S]*name="Footer band"/, 'official: banners on the master');
    assert.throws(() => CP.saveCyber(id, { email: 'not-an-email' }), /not valid/);
  }
  // preview cache: the same content gives the same key (zip dates / compression do not matter), other content another
  const rezip = await (await JSZip.loadAsync(filledBuf)).generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  assert.equal(await P.contentKey(rezip), await P.contentKey(filledBuf), 'same content, same PDF from the cache');
  assert.notEqual(await P.contentKey(await DS.applyDocStyle(filledBuf, { id: 'split', accent: '#123456' })), await P.contentKey(filledBuf), 'another style, another PDF');
  // forms keep their content and get the style's look: heading bands, light or accent-framed tables
  const formDoc = await (async () => { const z = new JSZip(); z.file('word/document.xml', '<w:document><w:body><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Employee Agreement</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/><w:tblLook w:val="04A0"/></w:tblPr><w:tblGrid><w:gridCol w:w="5000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:left="1440" w:right="1440"/></w:sectPr></w:body></w:document>'); return z.generateAsync({ type: 'nodebuffer' }); })();
  const fx = async sid => (await JSZip.loadAsync(await DS.applyDocStyle(formDoc, { id: sid, accent: '#123456' }, { kind: 'form' }))).file('word/document.xml').async('string');
  const fSplit = await fx('split'), fOff = await fx('official'), fMin = await fx('minimal');
  assert.ok(/<w:pPr><w:pBdr><w:left [^>]*w:color="123456"\/><\/w:pBdr><w:shd [^>]*\/><w:spacing/.test(fSplit), 'split form: heading band (in the order Word expects)');
  assert.ok(/<w:tblBorders>[\s\S]*w:color="123456"[\s\S]*<\/w:tblBorders><w:tblLook/.test(fOff) && /<w:pgBorders/.test(fOff), 'official form: accent-framed table and page frame');
  assert.ok(/<w:tblBorders>[\s\S]*w:color="D9DEE7"/.test(fMin), 'minimal form: light table lines');
  for (const f of [fSplit, fOff, fMin]) assert.ok(f.includes('Employee Agreement') && f.includes('>Name<'), 'form content unchanged');
  // The locked template itself is untouched.
  const { dir, loadGlobalConfig } = await import('../src/config.js');
  const stored = path.join(dir(loadGlobalConfig(), 'data'), 'policy-templates', t.file);
  assert.ok(fs.readFileSync(stored).equals(template), 'template unchanged');

  // In-portal editing: change a paragraph, add a DoH clause; the edited master is used for generation and locked.
  await P.lockTemplates('tester');
  const paras = await P.masterParagraphs(7, '1.0');
  // a policy version without its own master file (e.g. issued as 3.0) opens the master the policy has – no error
  assert.equal((await P.masterParagraphs(7, '3.0')).paragraphs.length, paras.paragraphs.length, 'version 3.0 uses the stored master');
  const target = paras.paragraphs.find(x => x.text.startsWith('This policy applies'));
  const saved = await P.saveMasterEdits(7, '1.0', { edits: [{ i: target.i, text: 'This policy applies to every user of OLD TOWN MEDICAL CENTER.' }], inserts: [{ after: target.i, text: 'DoH clause: incidents are reported to the DoH SOC.' }] }, 'tester');
  assert.equal(saved.paragraphs.length, paras.paragraphs.length + 1, 'one clause added');
  assert.equal(P.templateLock().locked, true, 'locked again after editing');
  assert.ok(!fs.readFileSync(stored).equals(template), 'the edited master replaced the stored one');
  const t7e = P.listTemplates().find(x => x.no === 7);
  const m7 = P.masterFor(t7e, '1.0');
  const regen = await P.fillPolicy(fs.readFileSync(path.join(dir(loadGlobalConfig(), 'data'), 'policy-templates', m7.file)), m7, { ...P.prepSettings(loadConfig(id)), baseline: P.templateLock().baseline }, {});
  const rtext = [...(await (await JSZip.loadAsync(regen.buffer)).file('word/document.xml').async('string')).matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join('|');
  assert.ok(rtext.includes('DoH clause: incidents are reported to the DoH SOC.'), 'generation follows the edited master');
  assert.ok(rtext.includes(`every user of ${name}.`), 'edited paragraph filled for the facility, full stop kept');
  P.unlockTemplates('tester', 'UNLOCK');
});

test('10j. a huge logo is reduced before it goes into the policies (no 425 MB packs)', async () => {
  if (process.platform !== 'win32') return;
  const P = await import('../src/policyprep.js');
  const { imageSize } = await import('../src/imagesize.js');
  // a photo-like 3000 x 1700 logo of ~13 MB (random colours do not compress)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lrp-biglogo-'));
  const big = path.join(work, 'big.png');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap 3000, 1700; $r = New-Object System.Random 7; for ($y = 0; $y -lt 1700; $y += 4) { for ($x = 0; $x -lt 3000; $x += 4) { $c = [System.Drawing.Color]::FromArgb(255, $r.Next(256), $r.Next(256), $r.Next(256)); $b.SetPixel($x, $y, $c); $b.SetPixel($x+1, $y+1, $c) } }; $b.Save('${big}')`], { timeout: 300000 });
  const buf = fs.readFileSync(big);
  const out = await P.printReady('logo', { buffer: buf, ...imageSize(buf) });
  assert.ok(Math.max(out.width, out.height) <= P.PRINT_MAX.logo * 1.25, `resized to print size (${out.width}x${out.height})`);
  assert.ok(out.buffer.length <= P.PRINT_MAX_BYTES, `small enough to repeat in every policy (${(out.buffer.length / 1048576).toFixed(2)} MB, was ${(buf.length / 1048576).toFixed(1)} MB)`);
  assert.ok(out.buffer.length < buf.length / 5, 'at least 5x smaller');
  // the same picture again comes from the cache (fast preview)
  const t = Date.now(); await P.printReady('logo', { buffer: buf, ...imageSize(buf) });
  assert.ok(Date.now() - t < 500, 'cached');
  fs.rmSync(work, { recursive: true, force: true });
});

test('10k. pictures are taken out of Word files and photos; other files are refused', async () => {
  const P = await import('../src/policyprep.js');
  const JSZip = (await import('jszip')).default;
  // a Word file whose body holds one picture (e.g. a scanned stamp pasted into a document)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0AAf9YUi4AAAAASUVORK5CYII=', 'base64');
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Stamp</w:t></w:r></w:p></w:body></w:document>');
  z.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  z.file('word/media/image1.png', png);
  const docx = await z.generateAsync({ type: 'nodebuffer' });
  const out = await P.pictureFrom(docx, 'stamp.docx', 'stamp');
  assert.ok(out.width >= 1 && out.buffer.length > 0, 'picture found in the Word file');
  assert.match(out.source, /Word/);
  const pic = await P.pictureFrom(png, 'stamp.png', 'stamp');
  assert.equal(pic.source, 'picture');
  await assert.rejects(P.pictureFrom(Buffer.from('plain text'), 'note.txt', 'logo'), /picture|PDF|Word/);
  await assert.rejects(P.pictureFrom(docx.length ? await (async () => { const e = new JSZip(); e.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'); return e.generateAsync({ type: 'nodebuffer' }); })() : docx, 'empty.docx', 'logo'), /No picture found/);
});

test('10l. logo, signature and stamp are told apart (shape, ink, colours, where they sat)', async () => {
  const P = await import('../src/policyprep.js');
  // measurements of real uploads: a round stamp, a pen signature, a coloured logo
  const stamp = { aspect: 1.095, ink: 0.308, ring: 0.47, colours: 2, dark: 0, hue: 225 };
  const signature = { aspect: 2.794, ink: 0.192, ring: 0.312, colours: 1, dark: 0.1, hue: 255 };
  const logo = { aspect: 6.306, ink: 0.178, ring: 0.221, colours: 3, dark: 0.612, hue: 345 };
  const best = m => Object.entries(P.pictureScores(m)).sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(best(stamp), 'stamp'); assert.equal(best(signature), 'signature'); assert.equal(best(logo), 'logo');
  // the letterhead is the logo even for a plain one-colour picture
  assert.equal(Object.entries(P.pictureScores({ ...signature, aspect: 3.5 }, 'header')).sort((a, b) => b[1] - a[1])[0][0], 'logo');
  if (process.platform !== 'win32') return;
  // end to end on drawn pictures: one drop, each goes to its slot (names say nothing)
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lrp-sort-'));
  const draw = (f, ps) => { execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Drawing; ${ps}; $b.Save('${path.join(work, f)}')`]); return { name: f, buffer: fs.readFileSync(path.join(work, f)) }; };
  const files = [
    draw('a.png', "$b = New-Object System.Drawing.Bitmap 600, 600; $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::White); $p = New-Object System.Drawing.Pen ([System.Drawing.Color]::RoyalBlue), 16; $g.DrawEllipse($p, 20, 20, 560, 560); $g.DrawEllipse($p, 110, 110, 380, 380)"),
    draw('b.png', "$b = New-Object System.Drawing.Bitmap 700, 220; $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::White); $p = New-Object System.Drawing.Pen ([System.Drawing.Color]::DarkBlue), 5; $g.DrawBezier($p, 20, 180, 160, 10, 330, 210, 680, 40); $g.DrawBezier($p, 60, 120, 200, 200, 400, 30, 600, 150)"),
    draw('c.png', "$b = New-Object System.Drawing.Bitmap 900, 260; $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::White); $g.FillEllipse([System.Drawing.Brushes]::Teal, 20, 20, 220, 220); $g.FillRectangle([System.Drawing.Brushes]::Crimson, 260, 40, 120, 180); $g.DrawString('CLINIC', (New-Object System.Drawing.Font('Arial', 70)), [System.Drawing.Brushes]::Black, 400, 70)"),
  ];
  const r = await P.detectPictures(files);
  assert.equal(r.stamp?.file, 'a.png', 'round ring = stamp');
  assert.equal(r.signature?.file, 'b.png', 'thin strokes = signature');
  assert.equal(r.logo?.file, 'c.png', 'colours = logo');
  fs.rmSync(work, { recursive: true, force: true });
});

test('10m. a facility removed by mistake can be restored with its register', async () => {
  const F = await import('../src/facilities.js');
  const { loadFacilities, loadConfig } = await import('../src/config.js');
  const d = loadFacilities();
  const victim = d.list.find(f => f.id !== d.default && f.id !== d.templateId && f.id !== 'br2' && f.home === undefined && loadConfig(f.id).register.path);
  if (!victim) return;
  const reg = loadConfig(victim.id).register.path;
  const r = F.deleteFacility(victim.id);
  assert.ok(r.restorable, 'kept for restore');
  assert.ok(!loadFacilities().list.some(f => f.id === victim.id), 'gone from the portal');
  assert.ok(!fs.existsSync(reg), 'its folder was moved away (archived, not erased)');
  const removed = F.removedFacilities().find(x => x.id === victim.id);
  assert.ok(removed && !removed.clash, 'listed under recently removed');
  const back = F.restoreFacility(removed.archive);
  assert.equal(back.restored, victim.id);
  assert.ok(loadFacilities().list.some(f => f.id === victim.id), 'back in the portal');
  assert.ok(fs.existsSync(reg), 'register back where it was');
  assert.ok(!F.removedFacilities().some(x => x.archive === removed.archive), 'no longer listed as removed');
  assert.throws(() => F.restoreFacility('../../etc'), /Unknown removed facility/);
});

test('10n. a signature and stamp in one picture are taken apart for their own boxes', async () => {
  if (process.platform !== 'win32') return;
  const P = await import('../src/policyprep.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lrp-split-'));
  const f = path.join(work, 'both.png');
  // pen signature on the left, round stamp on the right (like a scanned approval cell)
  execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap 800, 420; $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::White); $p = New-Object System.Drawing.Pen ([System.Drawing.Color]::Navy), 5; $g.DrawBezier($p, 20, 330, 120, 120, 220, 380, 330, 160); $g.DrawBezier($p, 40, 260, 140, 340, 240, 150, 320, 280); $s = New-Object System.Drawing.Pen ([System.Drawing.Color]::SteelBlue), 10; $g.DrawEllipse($s, 420, 30, 350, 350); $g.DrawEllipse($s, 490, 100, 210, 210); $b.Save('${f}')`]);
  const buf = fs.readFileSync(f);
  const sig = await P.pictureFrom(buf, 'both.png', 'signature');
  const st = await P.pictureFrom(buf, 'both.png', 'stamp');
  const both = await P.pictureFrom(buf, 'both.png', 'combined');
  assert.equal(sig.part, 'signature', 'signature box gets the signature part');
  assert.equal(st.part, 'stamp', 'stamp box gets the stamp part');
  assert.ok(st.width / st.height > 0.8 && st.width / st.height < 1.25, 'the stamp part is the round stamp');
  assert.ok(sig.width < both.width && st.width < both.width, 'each part is smaller than the whole');
  assert.ok(!both.part, '"both in one" keeps the whole picture');
  fs.rmSync(work, { recursive: true, force: true });
});

test('10o. the assistant answers from the facility data (offline without a key) and only reads', async () => {
  const A = await import('../src/assistant.js');
  const { loadFacilities } = await import('../src/config.js');
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {
    if (A.assistantConfigured()) return; // a key is set on this PC: the AI path is not exercised here
    const id = loadFacilities().default;
    const o = await A.overview(id);
    assert.ok(o.facility.name && o.nextStep?.action, 'overview with a next step');
    const r = await A.ask(id, 'What should I do next?');
    assert.equal(r.mode, 'offline');
    assert.match(r.answer, /Next step:/);
    const e = await A.ask(id, 'Which licences are expiring?');
    assert.match(e.answer, /expir/i);
    await assert.rejects(A.ask(id, '   '), /Type a question/);
    assert.throws(() => A.setAssistantKey('not-a-key'), /Anthropic API key/);
    assert.equal(A.ASSISTANT_MODEL, 'claude-opus-5-5');
  } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
});

const HR_ZIP = 'C:/Users/HP/Downloads/HR/HR.zip';
test('10p. HR forms from several facilities get this facility\'s name, code and logo; AUP follows PO11; checklist to Excel', { skip: (process.platform !== 'win32' || !fs.existsSync(HR_ZIP)) && 'HR sample forms not available' }, async () => {
  const H = await import('../src/hrforms.js');
  const P = await import('../src/policyprep.js');
  const { encodePng } = await import('../src/docparse.js');
  const { loadFacilities } = await import('../src/config.js');
  const { parseChecklistXlsx } = await import('../src/checklistxlsx.js');
  const id = loadFacilities().default;
  const zip = await JSZip.loadAsync(fs.readFileSync(HR_ZIP));
  const files = [];
  for (const n of Object.keys(zip.files).filter(n => n.endsWith('.docx'))) files.push({ name: path.basename(n), buffer: await zip.file(n).async('nodebuffer') });
  const r = await H.addForms(files);
  assert.deepEqual(r.problems, []);
  assert.equal(r.added.length, 9, 'all nine forms recognised');
  for (const k of ['nda', 'orientation', 'background', 'user', 'disciplinary', 'aup', 'quiz', 'awareness', 'exit']) assert.ok(r.added.includes(k), k);
  // cross-check: the masters come from several facilities
  const names = r.crossCheck.sources.map(s => s.name);
  for (const n of ['PURECARE MEDICAL CENTRE', 'GENET DENTAL CENTER LLC', 'MEDSCOPE MEDICAL CENTER', 'DR ATIQUR RAHMAN POLYCLINIC LLC']) assert.ok(names.includes(n), `found ${n} in ${names}`);
  for (const c of ['PMC', 'GDC', 'CMC', 'DARP']) assert.ok(r.crossCheck.codes.includes(c), c);
  // training and 3rd-party documents (when the samples are on this PC)
  const extra = [];
  for (const z of ['C:/Users/HP/Downloads/HR/Employe training.zip', 'C:/Users/HP/Downloads/HR/3rd Party Document.zip'].filter(f => fs.existsSync(f))) {
    const zz = await JSZip.loadAsync(fs.readFileSync(z));
    for (const n of Object.keys(zz.files).filter(n => n.endsWith('.docx'))) extra.push({ name: path.basename(n), buffer: await zz.file(n).async('nodebuffer') });
  }
  if (extra.length) {
    const r2 = await H.addForms(extra);
    assert.deepEqual(r2.problems, []);
    for (const n of r2.added) assert.ok(['trainingreport', 'policyack', 'tpnda', 'tpaup'].includes(n), n);
  }
  const installed = H.listForms().filter(f => f.installed);

  // nothing can be made before the facility has its logo / policy dates
  const W = 240, Hh = 90, px = Buffer.alloc(W * Hh * 4);
  for (let i = 0; i < W * Hh; i++) { const x = i % W, y = Math.floor(i / W); const ink = x > 20 && x < 220 && y > 20 && y < 70; px.set(ink ? [20, 90, 160, 255] : [255, 255, 255, 0], i * 4); }
  await P.saveAsset(id, 'logo', encodePng({ data: px, width: W, height: Hh, channels: 4 }), 'logo.png');
  P.saveSettings(id, { issuedOn: '2026-02-01', reviewedOn: '2026-10-15', preparedBy: 'Mr. Test Author', approvedBy: 'Dr. Test Approver', versions: { 11: '1.0' } });
  const s = P.prepSettings((await import('../src/config.js')).loadConfig(id));
  const text = async b => { const z = await JSZip.loadAsync(b); let t = ''; for (const p of Object.keys(z.files).filter(f => /^word\/(document|header\d*|footer\d*)\.xml$/.test(f))) t += (await z.file(p).async('string')).replace(/<[^>]+>/g, ''); return t; };
  if (installed.some(f => f.key === 'trainingreport')) {
    assert.match((await H.formsStatus(id)).forms.find(f => f.key === 'trainingreport').need.join(), /training date/, 'training date needed first');
    H.saveDocSettings(id, { group: 'training', date: '2026-10-20' });
  }
  for (const f of installed) {
    const x = await H.fillForm(id, f.key);
    assert.deepEqual(x.report.leftovers, [], `${f.key}: nothing of another facility left`);
    assert.deepEqual(x.report.mismatches, [], `${f.key}: layout and fields as the master`);
    assert.ok(x.report.logo, `${f.key}: facility logo in the header`);
    const t = await text(x.buffer);
    assert.doesNotMatch(t, /PURECARE|GENET|MEDSCOPE|ATIQUR|RANJITH|GLAMSMILE|DIYAFA|Jaison|\b(PMC|GDC|CMC|DARP|ADP)\b/i, f.key);
    // every form: exactly one standard reference, in the header – Ref. No.: CODE/HR/FORM-NN
    assert.equal(x.report.refNo, `${s.code}/${f.group === 'thirdparty' ? 'TP' : 'HR'}/FORM-${String(f.no).padStart(2, '0')}`);
    assert.equal((t.match(/Ref\.?\s*No/gi) || []).length, 1, `${f.key}: one Ref. No.`);
    const xz = await JSZip.loadAsync(x.buffer);
    let inHeader = false;
    for (const p of Object.keys(xz.files).filter(n => /^word\/header\d*\.xml$/.test(n))) if ((await xz.file(p).async('string')).includes(`Ref. No.: ${x.report.refNo}`)) inHeader = true;
    assert.ok(inHeader, `${f.key}: Ref. No. in the header`);
  }
  const nda = await text((await H.fillForm(id, 'nda')).buffer);
  assert.ok(nda.includes(s.facilityName), 'NDA names this facility');
  // Acceptable Usage Acknowledgement = PO11: the same values, and they follow a change
  let aup = await H.fillForm(id, 'aup');
  assert.ok(aup.report.sync.ok, JSON.stringify(aup.report.sync.diffs));
  assert.equal(aup.report.sync.values.policyId, `${s.code} / ADHICS - PO11`);
  assert.equal(aup.report.sync.values.reviewed, '15/10/2026');
  assert.equal(aup.report.sync.values.due, '15/10/2027');
  if (installed.some(f => f.key === 'trainingreport')) {
    // one training date fills every date; a document can switch to its own dates line by line
    const dates = async k => [...(await text((await H.fillForm(id, k)).buffer)).matchAll(/\d{2}\/\d{2}\/\d{4}/g)].map(m => m[0]); // text without spaces between cells: no \b
    assert.deepEqual([...new Set(await dates('trainingreport'))], ['20/10/2026']);
    assert.deepEqual([...new Set(await dates('policyack'))], ['20/10/2026']);
    // one date per document: the training report on 18 Oct, the acknowledgement keeps the training date
    H.saveDocSettings(id, { key: 'trainingreport', date: '2026-10-18' });
    assert.deepEqual([...new Set(await dates('trainingreport'))], ['18/10/2026'], 'every date field of the document');
    assert.deepEqual([...new Set(await dates('policyack'))], ['20/10/2026'], 'the other document keeps the training date');
    H.saveDocSettings(id, { key: 'trainingreport', date: '' });
    assert.deepEqual([...new Set(await dates('trainingreport'))], ['20/10/2026']);
    // policy acknowledgement: this facility's codes and versions (PO03 is a major revision: 2.0)
    const ack = await text((await H.fillForm(id, 'policyack')).buffer);
    assert.match(ack, new RegExp(`${s.code} / ADHICS - PO03INFORMATION ASSET MANAGEMENT POLICY2\\.0`));
  }
  if (installed.some(f => f.key === 'tpaup')) {
    const tp = await H.fillForm(id, 'tpaup');
    assert.ok(tp.report.sync.ok, 'third-party AUP follows PO11');
    assert.equal(tp.report.refNo, `${s.code}/TP/FORM-02`);
    H.saveDocSettings(id, { key: 'tpaup', date: '2026-09-01' });
    const t2 = await text((await H.fillForm(id, 'tpaup')).buffer);
    assert.match(t2, /First Reviewed on01\/09\/2026/i); assert.match(t2, /Second Reviewed on01\/09\/2026/i);
    H.saveDocSettings(id, { key: 'tpaup', date: '' });
  }
  P.saveSettings(id, { reviewedOn: '2026-11-20' });
  aup = await H.fillForm(id, 'aup');
  assert.equal(aup.report.sync.values.reviewed, '20/11/2026');
  assert.equal(aup.report.sync.values.due, '20/11/2027');
  assert.equal(aup.report.sync.values.prepared, 'Mr. Test Author');

  // step 2 of the sequence: every HR document saved for the facility by the background job (Word here; PDF in the UI)
  H.generateForms(id, { pdf: false });
  assert.throws(() => H.generateForms(id), /already being created/);
  let job;
  for (let i = 0; i < 120 && (job = H.hrJobState(id)).running; i++) await new Promise(res => setTimeout(res, 500));
  assert.equal(job.running, false);
  assert.deepEqual(job.problems, []);
  assert.equal(job.validation.count, installed.length);
  assert.equal(job.validation.passed, installed.length);
  assert.equal((await H.formsStatus(id)).generated.count, installed.length, 'recorded for the dashboard');
  // checklist: HR items link to their forms (Exit Clearance included), status + remarks, Excel with the logo
  let c = H.getChecklist(id);
  const hr = c.sections.find(x => x.id === 'hr');
  assert.ok(hr.items.some(i => i.form === 'exit'), 'exit clearance form in the HR checklist');
  assert.equal(hr.items.filter(i => i.form).length, installed.length, 'every document is linked from its checklist item');
  c = H.updateItem(id, 'hr', hr.items[2].id, { status: 'Completed', remarks: 'Signed by all staff' }, 'test');
  assert.throws(() => H.updateItem(id, 'hr', hr.items[2].id, { status: 'Done' }), /Status must be/);
  c = H.addItem(id, 'it', 'FIREWALL CONFIGURATION REVIEW', 'test');
  assert.ok(c.sections.find(x => x.id === 'it').items.some(i => i.name === 'FIREWALL CONFIGURATION REVIEW'));
  const xl = await H.checklistXlsx(id);
  const back = await parseChecklistXlsx(xl.buffer);
  assert.equal(back.length, 4);
  assert.equal(back[0].items[2].status, 'Completed');
  assert.equal(back[0].items[2].remarks, 'Signed by all staff');
  const xz = await JSZip.loadAsync(xl.buffer);
  assert.ok(Object.keys(xz.files).some(f => /^xl\/media\/logo\.(png|jpeg)$/.test(f)), 'logo in the workbook');
  assert.ok((await xz.file('xl/worksheets/sheet1.xml').async('string')).includes(s.facilityName.replace(/&/g, '&amp;')), 'facility name in the sheet');
  const cx = path.join(os.tmpdir(), 'doh_portal_checklist_check.xlsx');
  fs.writeFileSync(cx, xl.buffer);
  const o = execFileSync('powershell', ['-NoProfile', '-Command', `$x=New-Object -ComObject Excel.Application;$x.DisplayAlerts=$false;try{$wb=$x.Workbooks.Open('${cx}',0,$true);$s=$wb.Worksheets.Item(1);"OK|$($wb.Worksheets.Count)|$($s.Range('D9').Text)|$(@($s.Shapes | Where-Object { $_.Type -eq 13 }).Count)";$wb.Close($false)}finally{$x.Quit()}`], { encoding: 'utf8', timeout: 180000 }).trim();
  assert.equal(o, 'OK|4|Completed|1', o);
});

test('10q. free trial end to end: the first 2 items open as Word + PDF, everything else and the register updates are paywalled, no sign-out', async () => {
  const A = await import('../src/auth.js');
  const { loadFacilities, dir, loadGlobalConfig, loadConfig } = await import('../src/config.js');
  const PP = await import('../src/policyprep.js');
  const H = await import('../src/hrforms.js');
  const id = loadFacilities().default;
  const tu = A.createUser({ username: 'trial.e2e', password: 'Trial-Pass-2026x', role: 'manager', facilities: [id], plan: 'trial' }, { mustChangePassword: false });
  // a signed-in session for the trial user (sessions are kept on disk, by SHA-256 of the id)
  const sid = crypto.randomBytes(32).toString('base64url');
  const sf = path.join(dir(loadGlobalConfig(), 'data'), 'sessions.json');
  const cur = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : {};
  cur[crypto.createHash('sha256').update(sid).digest('hex')] = { userId: tu.id, expires: Date.now() + 3600e3 };
  fs.writeFileSync(sf, JSON.stringify(cur));
  const port = 19000 + Math.floor(Math.random() * 900);
  const srv = spawn(process.execPath, ['--use-system-ca', path.join(APP, 'server.js'), '--no-scheduler'],
    { env: { ...process.env, DOH_PORTAL_CONFIG: cfgPath, DOH_PORTAL_PORT: String(port), DOH_PORTAL_HOST: '127.0.0.1' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`, q = `?f=${encodeURIComponent(id)}`;
  const opt = (extra = {}) => ({ ...extra, headers: { Cookie: `${A.SESSION_COOKIE}=${sid}`, 'Content-Type': 'application/json', ...(extra.headers || {}) } });
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/auth/state`); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
    const plan = await (await fetch(`${base}/api/plan`, opt())).json();
    assert.equal(plan.plan, 'trial');
    const firstNos = PP.listTemplates().map(t => t.no).sort((a, b) => a - b).slice(0, 2);
    assert.deepEqual(plan.included.policies, firstNos.map(String), 'the first two master policies (by number)');

    // policies: the first two download as Word (and PDF when Word made them); any other is the gateway
    const files = PP.generatedFiles(loadConfig(id));
    const free = firstNos[0], pick = no => files.word.find(w => PP.policyNoOf(w) === no);
    assert.ok(pick(free), 'the first policy was generated by 10i');
    const w1 = await fetch(`${base}/api/policies/file${q}&type=word&name=${encodeURIComponent(pick(free))}`, opt());
    assert.equal(w1.status, 200, 'the first policy downloads as Word'); assert.ok((await w1.arrayBuffer()).byteLength > 1000);
    const p1 = files.pdf.find(p => PP.policyNoOf(p) === free);
    if (p1) assert.equal((await fetch(`${base}/api/policies/file${q}&type=pdf&name=${encodeURIComponent(p1)}`, opt())).status, 200, 'and as PDF');
    const lockedWord = files.word.find(w => !firstNos.includes(PP.policyNoOf(w)));
    if (lockedWord) {
      const r = await fetch(`${base}/api/policies/file${q}&type=word&name=${encodeURIComponent(lockedWord)}`, opt());
      assert.equal(r.status, 402, 'a locked policy is not sent'); assert.equal((await r.json()).upgrade, true);
    }
    const zp = await JSZip.loadAsync(Buffer.from(await (await fetch(`${base}/api/policies/zip${q}&type=word`, opt())).arrayBuffer()));
    assert.ok(Object.keys(zp.files).filter(f => !zp.files[f].dir).every(f => firstNos.includes(PP.policyNoOf(f))), 'the ZIP holds only the free policies');

    // 3rd-party documents: all Premium on the trial – every vendor form is the gateway; own dates stay Premium
    const tpAll = H.installedForms('thirdparty').map(d => d.key);
    assert.equal(plan.limits.thirdparty, 0);
    assert.deepEqual(plan.included.thirdparty, [], 'no vendor form is free');
    if (tpAll.length) {
      const tw = await fetch(`${base}/api/hr/forms/${tpAll[0]}${q}&format=docx`, opt());
      assert.equal(tw.status, 402, 'the first vendor form is locked too'); assert.equal((await tw.json()).upgrade, true);
    }
    for (const body of [{ group: 'thirdparty', date: '2026-01-01' }, { key: H.HR_FORMS.find(f => f.group === 'thirdparty').key, date: '2026-01-01' }]) {
      const r = await fetch(`${base}/api/hr/documents${q}`, opt({ method: 'PUT', body: JSON.stringify(body) }));
      assert.equal(r.status, 402, `3rd-party settings are Premium: ${JSON.stringify(body)}`); assert.equal((await r.json()).upgrade, true);
    }
    assert.notEqual((await fetch(`${base}/api/hr/documents${q}`, opt({ method: 'PUT', body: '{"group":"training","date":""}' }))).status, 402, 'the training date stays open (the New facility wizard sets it)');

    // HR forms: the first 2 open as Word (PDF too where Word is installed); the next one is the gateway
    if (H.installedForms('hr').length > 2) {
      const [k1] = plan.included.hr;
      const hw = await fetch(`${base}/api/hr/forms/${k1}${q}&format=docx`, opt());
      assert.equal(hw.status, 200, 'the first HR form downloads as Word'); assert.ok((await hw.arrayBuffer()).byteLength > 1000);
      const hp = await fetch(`${base}/api/hr/forms/${k1}${q}`, opt());
      assert.notEqual(hp.status, 402, 'its PDF is not paywalled');
      const lockedKey = H.installedForms('hr').map(d => d.key).find(k => !plan.included.hr.includes(k));
      assert.equal((await fetch(`${base}/api/hr/forms/${lockedKey}${q}&format=docx`, opt())).status, 402, 'a locked HR form is not sent');
    }

    // ADHICS checklist: per section the first 2 items (1 when the section has 5 or fewer); the rest is masked and locked
    const real = H.getChecklist(id);
    const ck = (await (await fetch(`${base}/api/hr${q}`, opt())).json()).checklist;
    for (const sec of ck.sections) {
      const rs = real.sections.find(s => s.id === sec.id), free = rs.items.length <= 5 ? 1 : 2;
      assert.equal(sec.items.length, rs.items.length, 'every row is still listed');
      sec.items.forEach((it, i) => {
        if (i < free) assert.equal(it.name, rs.items[i].name, `${sec.id}: item ${i + 1} is shown`);
        else { assert.equal(it.locked, true); assert.equal(it.name, 'Premium document', `${sec.id}: item ${i + 1} is masked`); assert.equal(it.policy, null); assert.equal(it.form, null); }
      });
    }
    const big = real.sections.find(s => s.items.length > 2);
    if (big) {
      const patch = (item, body) => fetch(`${base}/api/hr/checklist/${big.id}/${item}${q}`, opt({ method: 'PATCH', body: JSON.stringify(body) }));
      assert.equal((await patch(big.items[2].id, { remarks: 'x' })).status, 402, 'a locked item cannot be changed');
      const okp = await patch(big.items[0].id, { remarks: 'checked' });
      assert.equal(okp.status, 200, 'a free item can'); assert.equal((await okp.json()).sections.find(s => s.id === big.id).items[2].name, 'Premium document', 'the answer is masked too');
      assert.equal((await fetch(`${base}/api/hr/checklist/${big.id}${q}`, opt({ method: 'POST', body: '{"name":"My own document"}' }))).status, 402, 'adding items is Premium');
      const xb = Buffer.from(await (await fetch(`${base}/api/hr/checklist.xlsx${q}&sections=${big.id}`, opt())).arrayBuffer());
      const xz = await JSZip.loadAsync(xb);
      const xmlAll = (await Promise.all(Object.keys(xz.files).filter(f => f.endsWith('.xml')).map(f => xz.file(f).async('string')))).join('');
      const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      assert.ok(xmlAll.includes(esc(big.items[0].name)), 'the Excel holds the free items');
      assert.ok(!xmlAll.includes(esc(big.items[big.items.length - 1].name)), 'and not the locked ones');
    }

    // uploaded facility documents: the first 2 different files are read (preview); a third is Premium; the same
    // file again is fine; applying any of them to the register is Premium
    const docx = async text => {
      const z = new JSZip();
      z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
      z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
      return z.generateAsync({ type: 'nodebuffer' });
    };
    const upload = async (buf, name) => fetch(`${base}/api/facilities/${id}/documents/analyze${q}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { Cookie: `${A.SESSION_COOKIE}=${sid}`, 'Content-Type': 'application/octet-stream' }, body: buf });
    const d1 = await docx('Trade Licence. Issue date 01/01/2026. Expiry date 31/12/2026.'), d2 = await docx('Civil Defence certificate. Issued 05/02/2026. Valid until 04/02/2027.'), d3 = await docx('Medical waste contract from 01/03/2026 to 28/02/2027.');
    const r1 = await upload(d1, 'licence.docx'), r2 = await upload(d2, 'civil-defence.docx');
    assert.notEqual(r1.status, 402, 'first document previewed'); assert.notEqual(r2.status, 402, 'second document previewed');
    const j1 = await r1.json(), j2 = await r2.json(), t1 = j1.token, t2 = j2.token;
    const u3 = await upload(d3, 'waste.docx');
    assert.notEqual(u3.status, 402, 'every document is read (no cap at 2)');
    // a document for a Premium entry comes back masked: no type, dates or entry name
    const freeRows = new Set((await (await import('../src/master.js')).readMaster(loadConfig(id))).slice(0, 2).map(x => x.row));
    for (const j of [j1, j2, await u3.json()]) {
      if (j.locked) { assert.equal(j.lockedMatch, true); assert.equal(j.issued ?? j.expiry ?? j.typeLabel ?? j.row, undefined, 'masked'); }
      else assert.ok(j.row == null || freeRows.has(j.row), 'unmasked only for a free entry (or not recognised)');
    }
    assert.notEqual((await upload(d1, 'licence-again.docx')).status, 402, 'the same document again is fine');
    assert.equal((await (await fetch(`${base}/api/plan`, opt())).json()).usage.uploads, 3, '3 different files read');
    // applying: the 2 free previews may be applied to the register; foreign documents or more than 2 are Premium
    const reg = (await (await fetch(`${base}/api/master${q}`, opt())).json()).items?.filter(i => !i.fixed) || [];
    const apply = items => fetch(`${base}/api/facilities/${id}/documents/apply${q}`, opt({ method: 'POST', body: JSON.stringify({ items }) }));
    const it = (token, k) => ({ token, file: 'x.docx', row: reg[k]?.row, issued: '2026-01-01', expiry: '2026-12-31', due: '2027-01-01' });
    assert.equal((await apply([it('not-my-upload', 0)])).status, 402, 'a document that was not a free preview');
    assert.equal((await apply([it(t1, 0), it(t2, 1), it(t1, 2)])).status, 402, 'more than 2 documents');
    // a document recognised for one entry is never applied to another (the DED → MCC / MCC → DoH mix-up)
    for (const [j, t] of [[j1, t1], [j2, t2]]) {
      if (!['high', 'medium'].includes(j.confidence) || !j.row) continue;
      const other = reg.find(x => x.row !== j.row && !x.locked);
      if (!other) continue;
      const rr = await apply([{ token: t, file: 'x.docx', row: other.row, issued: '2026-01-01', expiry: '2026-12-31', due: '2027-01-01' }]);
      assert.equal(rr.status, 400, 'moved to another entry: refused'); assert.match((await rr.json()).error, /recognised as another LEGAL REGISTER entry/);
    }
    // the register table: the first 2 entries are shown and can be edited; SL 3 onwards is masked and locked
    const full = await (await import('../src/master.js')).readMaster(loadConfig(id));
    const mm = await (await fetch(`${base}/api/master${q}`, opt())).json();
    assert.equal(mm.items.length, full.length, 'every row is still listed');
    mm.items.forEach((x, k) => {
      if (k < 2) assert.equal(x.name, full[k].name, `SL ${x.sl} is shown`);
      else { assert.equal(x.locked, true); assert.equal(x.name, 'Premium entry'); assert.equal(x.issued + x.expiry + x.responsible + x.compliance, '', `SL ${x.sl} is masked`); }
    });
    if (full.length > 2) {
      const regFile = loadConfig(id).register.path, saved = fs.readFileSync(regFile);
      try {
        const put = row => fetch(`${base}/api/master${q}`, opt({ method: 'PUT', body: JSON.stringify({ items: [{ row, issued: '2026-01-05' }] }) }));
        assert.equal((await put(full[2].row)).status, 402, 'SL 3 cannot be edited');
        assert.notEqual((await put(full[0].row)).status, 402, 'SL 1 can');
        assert.equal((await fetch(`${base}/api/facility-document${q}&entry=${encodeURIComponent(full[full.length - 1].name)}`, opt())).status, 402, 'no document of a locked entry');
      } finally { fs.writeFileSync(regFile, saved); }
    }
    const usable = [[j1, t1], [j2, t2]].find(([j]) => !j.locked);
    for (const [j, t] of [[j1, t1], [j2, t2]]) if (j.locked) assert.equal((await apply([it(t, 0)])).status, 402, 'a masked document cannot be applied');
    if (usable && reg.length) { // (the register is put back afterwards – later tests check its contents)
      const regFile = loadConfig(id).register.path, saved = fs.readFileSync(regFile);
      const [uj, ut] = usable, k = uj.row ? reg.findIndex(x => x.row === uj.row) : 0;
      try { assert.notEqual((await apply([it(ut, Math.max(0, k))])).status, 402, 'a document for a free entry can be applied'); }
      finally { fs.writeFileSync(regFile, saved); }
    }

    // production: no file-system path of the server reaches the browser
    for (const p of ['/api/status', '/api/settings', '/api/policies', '/api/facilities', '/api/hr', '/api/master', '/api/package']) {
      const txt = await (await fetch(`${base}${p}${q}`, opt())).text();
      assert.ok(!/[A-Za-z]:\\\\|\\\\\\\\[^\\\\"]+\\\\/.test(txt), `${p} holds no server path: ${(txt.match(/.{0,40}[A-Za-z]:\\\\.{0,40}/) || [''])[0]}`);
    }

    // DoH circulars: the basic, non-updated view – nothing from the last 90 days
    const cut = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const br = await (await fetch(`${base}/api/circulars/brief${q}`, opt())).json();
    assert.equal(typeof br.trialHeld, 'number'); assert.equal(br.trialDays, 90);
    assert.ok(br.latest.every(c => !c.date || c.date <= cut), 'no recent circular in the brief');
    const cl = await (await fetch(`${base}/api/circulars${q}`, opt())).json();
    assert.ok(cl.every(c => { const d = String(c.date || c.firstSeen || '').slice(0, 10); return !d || d <= cut; }), 'no recent circular in the list');

    // the LEGAL REGISTER: a preview that can be read, not updated
    assert.notEqual((await fetch(`${base}/api/master${q}`, opt())).status, 402, 'the register preview opens');
    for (const [m, p] of [['PUT', '/api/master'], ['POST', '/api/run'], ['GET', '/api/register/download'], ['GET', '/api/export/pdf']]) {
      assert.equal((await fetch(base + p + q, opt({ method: m, body: m === 'GET' ? undefined : '{}' }))).status, 402, `register locked: ${m} ${p}`);
    }
    // generating on the trial makes only the free policies, and nobody is signed out on the way
    const g = await (await fetch(`${base}/api/policies/generate${q}`, opt({ method: 'POST', body: '{"pdf":false}' }))).json();
    assert.equal(g.limited?.count, Math.min(2, PP.listTemplates().length));
    for (let k = 0; k < 240; k++) { const s = await (await fetch(`${base}/api/policies${q}`, opt())).json(); if (!s.job?.running) break; await new Promise(r => setTimeout(r, 250)); }
    assert.equal((await fetch(`${base}/api/me`, opt())).status, 200, 'still signed in after the paywall and generation');
  } finally {
    srv.kill();
    A.deleteUser(tu.id, 'test');
  }
});

test('11. Microsoft Excel opens the result without repair', { skip: process.platform !== 'win32' }, () => {
  for (const [f, expect] of [[br2File, 'OK|BR2 / LGL REGISTER|Dr. Branch Manager|'] /* entry 1 responsible imported from the register PDF in 10c */, [ihhcFile, 'OK|IHHC / LGL REGISTER|Mr. Hamdan Almazrouei|']]) {
    if (!f) continue;
    const c = path.join(os.tmpdir(), 'doh_portal_excel_check_fac.xlsx');
    fs.copyFileSync(f, c);
    const o = execFileSync('powershell', ['-NoProfile', '-Command', `$x=New-Object -ComObject Excel.Application;$x.DisplayAlerts=$false;try{$wb=$x.Workbooks.Open('${c}',0,$true);$d=$wb.Worksheets.Item('DOCUMENT CONTROLLER');$m=$wb.Worksheets.Item('LEGAL REGISTER');"OK|$($d.Range('C4').Text)|$($m.Range('G4').Text)|$($d.Range('C9').Text)|$($d.Shapes.Count)|$($m.Shapes.Count)";$wb.Close($false)}finally{$x.Quit()}`], { encoding: 'utf8', timeout: 180000 }).trim();
    assert.equal(o, `${expect}|2|3`, o);
  }
  const copy = path.join(os.tmpdir(), 'doh_portal_excel_check.xlsx'); // Excel cannot open paths > 218 chars
  fs.copyFileSync(REG, copy);
  let out;
  try {
    out = execFileSync('powershell', ['-NoProfile', '-Command', `$x=New-Object -ComObject Excel.Application;$x.DisplayAlerts=$false;try{$wb=$x.Workbooks.Open('${copy}',0,$true);$ws=$wb.Worksheets.Item('Circular');$l=$ws.Cells($ws.Rows.Count,2).End(-4162).Row;$m=$wb.Worksheets.Item('LEGAL REGISTER');$d=$wb.Worksheets.Item('DOCUMENT CONTROLLER');"OK|$($ws.Hyperlinks.Count)|$($wb.Worksheets.Item(1).Shapes.Count+$wb.Worksheets.Item(2).Shapes.Count)|$($ws.Cells($l,2).Text)|$($ws.Cells(${'$'}l,6).Text)|$($m.Range('E4').Value2)|$($m.Range('H7').Text)|$($d.Range('C9').Text.Length)";$wb.Close($false)}finally{$x.Quit()}`], { encoding: 'utf8', timeout: 180000 }).trim();
  } catch (e) { out = `ERR ${e.message}`; }
  if (/ComObject|80040154|Excel\.Application/.test(out) && !out.startsWith('OK')) return; // Excel not installed
  assert.match(out, /^OK\|\d+\|[1-9]\d*\|USO\/260\/2026\|.*\|46477\|Not Applicable\|0$/, out); // C9: badge image only, no typed text
});

test('12. the real register was never modified', () => assert.equal(sha(SOURCE), sourceHash));
