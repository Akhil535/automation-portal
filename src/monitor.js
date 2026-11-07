// One monitoring run: read register -> fetch DoH listing -> find new circulars ->
// read each circular -> decide F-J -> append to Excel (and complete blank F-J of earlier
// system-added rows) -> record history -> report -> e-mail.
import fs from 'node:fs';
import path from 'node:path';
import { dir, loadConfig, loadFacilities } from './config.js';
import { DohClient } from './doh.js';
import { RegisterIndex, circularKey, numberYear, parseDate } from './normalize.js';
import { complianceMetadata, documentText, normalizeCompliance, toColumns } from './rules.js';

const isIt = c => c.decision === 'it_related' || c.decision === 'it_review';
import { Store } from './store.js';
import { RegisterLockedError, applyChanges, readRegister } from './xlsx.js';
import { syncReleaseDate } from './master.js';
import { runHtml, sendMail } from './mailer.js';

const LABELS = {
  success: 'Completed – register updated',
  no_changes: 'Completed – no new circulars',
  check_only: 'Completed – check only (register not modified)',
  awaiting_approval: 'New circulars exceed the safety limit – awaiting approval',
  register_locked: 'Register open/locked – not modified, will retry',
  failed: 'Failed',
};

let running = null; // single-flight: a nightly run and a manual run never overlap
let batch = null;   // an all-facilities run, including its shared DoH fetch before the first facility starts
export const currentRun = () => running || batch;

export function logLine(cfg, msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  fs.appendFileSync(path.join(dir(cfg, 'logs'), 'portal.log'), line + '\n');
  (running || batch)?.log.push(line);
  return line;
}

async function analyse(client, c, cfg, store, log) {
  const known = store.circular(circularKey(c));
  if (known?.text !== undefined && known.docStatus && !/failed|No document/i.test(known.docStatus)) {
    return { text: known.text, docStatus: known.docStatus, docPath: known.docPath };
  }
  if (!c.url) return { text: '', docStatus: 'No document link' };
  try {
    const { buffer, kind } = await client.download(c.url);
    const yearDir = path.join(dir(cfg, 'downloads'), String(c.date?.slice(0, 4) || numberYear(c.number) || 'unknown'));
    fs.mkdirSync(yearDir, { recursive: true });
    const docPath = path.join(yearDir, `${c.number.replace(/[^A-Za-z0-9_-]+/g, '-')}.${kind === 'pdf' ? 'pdf' : kind === 'html' ? 'html' : 'bin'}`);
    fs.writeFileSync(docPath, buffer);
    const { text, status } = await documentText(buffer, kind);
    return { text, docStatus: status, docPath };
  } catch (e) {
    log(`Document download failed for ${c.number}: ${e.message}`);
    return { text: '', docStatus: `Download failed: ${e.message}`, error: `Document download failed for ${c.number}: ${e.message}` };
  }
}

/**
 * mode: 'update' (write to Excel) | 'check' (no changes).
 * options: { force, trigger, fillMissing }
 */
export async function runMonitor(mode = 'update', { force = false, trigger = 'manual', fillMissing = true, facility, listing, inBatch = false } = {}) {
  if (running || (batch && !inBatch)) throw new Error('A monitoring run is already in progress');
  const cfg = loadConfig(facility);
  const store = new Store(cfg);
  const run = {
    facility: cfg.facility.id, facilityName: cfg.facility.name,
    id: Date.now().toString(36) + cfg.facility.id, started: new Date().toISOString(), mode, trigger, status: 'running',
    totalChecked: 0, inScope: 0, newCount: 0, added: 0, filled: 0, reviewCount: 0, errors: [], warnings: [], rows: [], conflicts: [], log: [],
  };
  running = run;
  const log = m => logLine(cfg, m);
  const items = [];
  try {
    store.addRun({ ...run, log: undefined });
    const reg = cfg.register;
    log(`Reading the Legal Register: ${reg.path}`);
    let snap;
    try { snap = await readRegister(reg.path, reg); }
    catch (e) {
      if (e instanceof RegisterLockedError) { run.status = 'register_locked'; run.errors.push(e.message); return run; }
      throw e;
    }
    log(`Register contains ${snap.records.length} circulars (last row ${snap.lastDataRow})`);
    const records = snap.records.map(r => ({ ...r, date: parseDate(r.dateRaw) }));

    const client = new DohClient(cfg.site, reg, log);
    const { circulars, complete, recentOnly } = listing || await fetchListing(client, cfg, store, { full: force });
    run.totalChecked = circulars.length;
    log(`Retrieved ${circulars.length} circulars from the DoH website`);

    const scope = reg.scopeStartDate || '2000-01-01';
    const inScope = circulars.filter(c => (c.date || `${numberYear(c.number) || 9999}-12-31`) >= scope);
    run.inScope = inScope.length;

    const index = new RegisterIndex(records);
    const fresh = [];
    for (const c of inScope.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.number.localeCompare(b.number, 'en', { numeric: true }))) {
      const [status, rec] = index.match(c);
      if (status === 'new') { fresh.push(c); index.add({ ...c, row: -1 }); }
      else if (status === 'conflict') run.conflicts.push({ number: c.number, name: c.name, url: c.url, registerRow: rec.row, registerName: rec.name });
    }
    run.newCount = fresh.length;
    log(`New circulars: ${fresh.length}; held for manual check: ${run.conflicts.length}`);

    // Read each new circular and decide F-J.
    for (const c of fresh) {
      const doc = await analyse(client, c, cfg, store, log);
      if (doc.error) run.errors.push(doc.error);
      const meta = complianceMetadata(c, doc.text, cfg);
      items.push({ ...c, ...doc, error: undefined, values: meta.values, decision: meta.decision, reason: meta.reason, itRelated: meta.itRelated, itMatches: meta.itMatches });
    }

    // Earlier system-added rows whose F-J are still blank (e.g. added before metadata filling existed).
    const updates = [];
    if (fillMissing) {
      const byLink = new Map(circulars.map(c => [c.url, c]));
      for (const r of records.filter(r => r.row > 1 && Object.values(r.meta).every(v => v === null || v === ''))) {
        const site = byLink.get(r.url) || circulars.find(c => c.number === r.number) || { number: r.number, name: r.name, date: r.date, category: r.category, url: r.url };
        const c = { ...site, number: r.number, name: r.name, category: r.category, categories: site.categories, date: r.date };
        const doc = await analyse(client, c, cfg, store, log);
        const meta = complianceMetadata(c, doc.text, cfg);
        updates.push({ row: r.row, values: toColumns(meta.values, reg, snap.dateStyleH), item: { ...c, ...doc, error: undefined, values: meta.values, decision: meta.decision, reason: meta.reason, itRelated: meta.itRelated, excelRow: r.row } });
      }
      // Rows with a compliance status other than the two allowed ones (e.g. the retired "Under Review"):
      // only column F is corrected; everything else in the row stays as it is.
      for (const r of records.filter(r => r.row >= (scopeFirstRow(records, scope) ?? Infinity) && r.meta.compliance && !normalizeCompliance(r.meta.compliance, cfg) && !updates.some(u => u.row === r.row))) {
        const site = byLink.get(r.url) || circulars.find(c => c.number === r.number) || { number: r.number, name: r.name, date: r.date, category: r.category, url: r.url };
        const c = { ...site, number: r.number, name: r.name, category: r.category, categories: site.categories, date: r.date };
        const doc = await analyse(client, c, cfg, store, log);
        const meta = complianceMetadata(c, doc.text, cfg);
        log(`Row ${r.row} (${r.number}): compliance "${r.meta.compliance}" is not an allowed status -> "${meta.values.compliance}"`);
        updates.push({ row: r.row, values: { [reg.columns.compliance]: meta.values.compliance }, item: { ...c, ...doc, error: undefined, values: { ...r.meta, compliance: meta.values.compliance }, decision: meta.decision, reason: meta.reason, itRelated: meta.itRelated, excelRow: r.row } });
      }
    }

    if (mode !== 'update') {
      run.status = 'check_only';
      items.forEach(i => { i.status = 'detected'; });
    } else if (fresh.length > (cfg.safety.maxNewPerRun ?? 25) && !force) {
      run.status = 'awaiting_approval';
      run.warnings.push(`${fresh.length} new circulars exceeds the safety limit of ${cfg.safety.maxNewPerRun}; approve in the portal.`);
      items.forEach(i => { i.status = 'awaiting_approval'; });
    } else if (!fresh.length && !updates.length) {
      run.status = 'no_changes';
    } else {
      const append = items.map(i => ({
        values: {
          [reg.columns.serial]: 0, [reg.columns.number]: i.number, [reg.columns.name]: i.name,
          [reg.columns.date]: i.date ? { date: i.date } : i.dateText, [reg.columns.category]: i.category,
          ...toColumns(i.values, reg, snap.dateStyleH),
        },
        links: Object.fromEntries((reg.hyperlinkColumns || []).map(col => [col, i.url])),
      }));
      append.forEach((a, k) => { a.values[reg.columns.serial] = snap.lastSerial + 1 + k; });
      log(`Writing to the register: ${append.length} new row(s), ${updates.length} row(s) to complete...`);
      try {
        const res = await applyChanges(reg.path, reg, { append, updates: updates.map(u => ({ row: u.row, values: u.values })) }, dir(cfg, 'backups'), cfg.safety, log);
        run.rows = res.rows; run.backup = res.backup; run.added = res.rows.length; run.filled = updates.length;
        items.forEach((i, k) => { i.status = 'added'; i.excelRow = res.rows[k]; });
        updates.forEach(u => { u.item.status = 'completed'; items.push(u.item); });
        run.status = 'success';
        log(`Register updated: ${res.rows.length ? `rows ${res.rows[0]}-${res.rows.at(-1)} added` : 'no rows added'}; ${updates.length} row(s) completed`);
      } catch (e) {
        run.status = e instanceof RegisterLockedError ? 'register_locked' : 'failed';
        run.errors.push(`Register not updated: ${e.message}`);
        items.forEach(i => { i.status = 'pending_excel'; });
      }
    }

    // Date of Release follows the most recent circular in the register.
    if (mode === 'update' && ['success', 'no_changes'].includes(run.status)) {
      try { run.releaseDate = await syncReleaseDate(cfg.facility.id, log); }
      catch (e) { run.warnings.push(`Date of Release not updated: ${e.message}`); log(`Date of Release not updated: ${e.message}`); }
    }

    for (const i of items) {
      const prev = store.circular(circularKey(i));
      store.upsertCircular(circularKey(i), {
        number: i.number, name: i.name, date: i.date, category: i.category, url: i.url, status: i.status,
        excelRow: i.excelRow ?? prev?.excelRow, decision: i.decision, reason: i.reason, itRelated: i.itRelated,
        values: prev?.review ? prev.values : i.values, autoValues: i.values, docStatus: i.docStatus, docPath: i.docPath,
        text: i.text?.slice(0, 20000), review: prev?.review || null, runId: run.id,
      });
    }
    for (const c of run.conflicts) store.upsertCircular(circularKey(c), { ...c, status: 'conflict', runId: run.id });
    run.reviewCount = items.filter(isIt).length;
    if (complete) store.meta.lastSuccess = run.started;
    if (complete && !recentOnly) store.meta.lastFullScan = run.started;
    run.recentOnly = !!recentOnly;
  } catch (e) {
    run.status = 'failed';
    run.errors.push(e.message);
    log(`Run failed: ${e.stack || e.message}`);
  } finally {
    run.statusLabel = LABELS[run.status] || run.status;
    run.finished = new Date().toISOString();
    try {
      const html = runHtml(run, items, cfg);
      const file = path.join(dir(cfg, 'reports'), `report_${run.started.replace(/[:.]/g, '-')}.html`);
      fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>DoH monitoring report</title>${html}`);
      run.report = path.basename(file);
      await notify(cfg, run, items, html, log);
    } catch (e) { log(`Report/notification error: ${e.message}`); }
    store.meta.lastRun = run.started;
    store.updateRun(run.id, { ...run, log: undefined });
    log(`Finished: ${run.statusLabel}`);
    running = null;
  }
  return run;
}

async function notify(cfg, run, items, html, log) {
  const e = cfg.email;
  if (!e.enabled) return;
  const failed = run.status === 'failed' || run.status === 'register_locked';
  const realtime = ['realtime', 'both'].includes(e.mode) && run.mode === 'update' && items.length > 0;
  if (!(failed && e.alertOnFailure) && !realtime) return;
  const subject = failed ? `[DoH Monitor – ${cfg.facility.code}] ${run.status === 'failed' ? 'Monitoring FAILED' : 'Register locked – not updated'}`
    : `[DoH Monitor – ${cfg.facility.code}] ${run.newCount} new DoH circular(s) – ${run.added} added to the Legal Register`;
  try { await sendMail(cfg, subject, html); log('Alert e-mail sent'); }
  catch (err) { run.errors.push(`E-mail failed: ${err.message}`); log(`E-mail failed: ${err.message}`); }
}

/** Daily summary of everything processed in the last 24 hours. */
export async function sendDailySummary(facility) {
  const cfg = loadConfig(facility);
  if (!cfg.email.enabled || !['summary', 'both'].includes(cfg.email.mode)) return false;
  const store = new Store(cfg);
  const weekly = /^\S+ \S+ \* \* [0-6]$/.test(cfg.schedule.summaryCron || '');
  const since = new Date(Date.now() - (weekly ? 7 : 1) * 24 * 3600 * 1000).toISOString();
  const runs = store.data.runs.filter(r => r.started >= since);
  const items = store.circulars().filter(c => c.firstSeen >= since && c.status !== 'conflict');
  const last = runs[0] || { status: 'no_changes', statusLabel: 'No monitoring run in the last 24 hours', totalChecked: 0, inScope: 0, newCount: 0, added: 0, errors: [] };
  const summary = { ...last, newCount: items.length, added: items.filter(i => i.status === 'added').length,
    reviewCount: items.filter(isIt).length,
    errors: runs.flatMap(r => r.errors || []) };
  await sendMail(cfg, `[DoH Monitor – ${cfg.facility.code}] ${weekly ? 'Weekly' : 'Daily'} summary – ${items.length} new circular(s), ${summary.reviewCount} for the IT Department`, runHtml(summary, items, cfg));
  logLine(cfg, 'Daily summary e-mail sent');
  return true;
}

/**
 * Reviewer confirms or overrides F-J for a circular in the portal; the change is written to
 * the same row in the register (only rows this system added).
 */
export async function applyReview(key, values, reviewer, note, facility) {
  if (currentRun()) throw new Error('A monitoring run is in progress; try again in a moment');
  const cfg = loadConfig(facility);
  const store = new Store(cfg);
  const c = store.circular(key);
  if (!c) throw new Error('Circular not found');
  if (!c.excelRow) throw new Error('This circular is not in the register yet');
  const snap = await readRegister(cfg.register.path, cfg.register);
  const rec = snap.records.find(r => r.row === c.excelRow);
  if (!rec || rec.number !== c.number) throw new Error(`Register row ${c.excelRow} no longer holds ${c.number}; not updated`);
  const clean = {};
  for (const k of ['compliance', 'responsible', 'targetDate', 'frequency', 'authority']) {
    if (values[k] === undefined) continue;
    const v = k === 'responsible' ? String(values[k]) : String(values[k]).trim();
    clean[k] = /^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : v;
  }
  if (clean.compliance !== undefined) {
    const ok = normalizeCompliance(clean.compliance, cfg);
    if (!ok) throw new Error(`Compliance must be "${cfg.compliance.labels.compliant}" or "${cfg.compliance.labels.notApplicable}"`);
    clean.compliance = ok;
  }
  if (clean.responsible !== undefined && !clean.responsible.trim()) throw new Error('Responsible person is required');
  const res = await applyChanges(cfg.register.path, cfg.register,
    { updates: [{ row: c.excelRow, values: toColumns(clean, cfg.register, snap.dateStyleH) }] }, dir(cfg, 'backups'), { ...cfg.safety, lockRetries: 1 });
  Object.assign(c, { values: { ...c.values, ...clean }, review: { reviewer, note, at: new Date().toISOString(), backup: res.backup } });
  store.save();
  logLine(cfg, `Review saved for ${c.number} (row ${c.excelRow}) by ${reviewer || 'unknown'}`);
  return c;
}

/** First register row whose circular date is inside the monitoring scope. */
function scopeFirstRow(records, scope) {
  return records.find(r => r.date && r.date >= scope)?.row ?? null;
}

/**
 * Monitor every facility: the DoH listing is fetched once and then compared with each facility's register.
 * Facilities are processed one after another; a locked or failing register does not stop the others.
 */
export async function runAll(mode = 'update', opts = {}) {
  if (running || batch) throw new Error('A monitoring run is already in progress');
  const { list: all, templateId } = loadFacilities();
  const list = all.filter(f => f.id !== templateId); // the master template is not monitored
  const cfg = loadConfig((list[0] || all[0])?.id);
  batch = { mode, started: new Date().toISOString(), facility: 'all', facilityName: 'all facilities', log: [] };
  try {
    let listing;
    try {
      listing = await fetchListing(new DohClient(cfg.site, cfg.register, m => logLine(cfg, m)), cfg, new Store(cfg), { full: !!opts.force });
    } catch (e) {
      logLine(cfg, `DoH listing could not be retrieved: ${e.message}`);
      listing = undefined; // each facility run retries and records the failure
    }
    const runs = [];
    for (const f of list) {
      if (!f.register?.path) continue;
      runs.push(await runMonitor(mode, { ...opts, facility: f.id, listing, inBatch: true }));
    }
    return runs;
  } finally {
    batch = null;
  }
}

/** Daily summary e-mail for every facility (each to its own recipients). */
export async function sendAllSummaries() {
  const sent = [];
  const { list, templateId } = loadFacilities();
  for (const f of list.filter(x => x.id !== templateId)) {
    try { if (await sendDailySummary(f.id)) sent.push(f.id); }
    catch (e) { logLine(loadConfig(f.id), `Daily summary failed: ${e.message}`); }
  }
  return sent;
}

/**
 * The DoH listing for a run. Regular (weekly) runs read only recent circulars: everything since the last successful
 * check minus a 45-day margin (for late-published circulars), never before the register's start date. A full sweep
 * of every circular runs when forced, on the first run, and when the last full sweep is older than 28 days.
 */
export async function fetchListing(client, cfg, store, { full = false } = {}) {
  const last = store.meta.lastSuccess, lastFull = store.meta.lastFullScan;
  const stale = !lastFull || Date.now() - Date.parse(lastFull) > 28 * 864e5;
  if (full || !last || stale) return client.fetchAll();
  const scope = cfg.register.scopeStartDate || '2000-01-01';
  let cutoff = new Date(Date.parse(last) - 45 * 864e5).toISOString().slice(0, 10);
  if (cutoff < scope) cutoff = scope;
  return client.fetchRecent(cutoff);
}
