// Nightly monitoring of every facility + daily summaries, inside the portal process (node-cron, Asia/Dubai).
// The DoH listing is fetched once per night and applied to each facility's register in turn.
// If the PC was off at the scheduled time, a catch-up run starts shortly after the portal starts.
import cron from 'node-cron';
import { loadConfig, loadFacilities } from './config.js';
import { Store } from './store.js';
import { currentRun, logLine, runAll, sendAllSummaries } from './monitor.js';

let tasks = [];

export function startScheduler() {
  tasks.forEach(t => t.stop());
  tasks = [];
  const cfg = loadConfig();
  const s = cfg.schedule;
  if (!s.enabled) { logLine(cfg, 'Scheduler disabled'); return; }
  const opts = { timezone: s.timezone || 'Asia/Dubai' };
  tasks.push(cron.schedule(s.nightlyCron, () => {
    if (!currentRun()) runAll('update', { trigger: 'nightly' }).catch(e => logLine(cfg, `Nightly run error: ${e.message}`));
  }, opts));
  if (s.summaryCron) tasks.push(cron.schedule(s.summaryCron, () => sendAllSummaries().catch(e => logLine(cfg, `Daily summary failed: ${e.message}`)), opts));
  const { list: all, templateId } = loadFacilities();
  const facilities = all.filter(f => f.id !== templateId); // the master template is not monitored
  logLine(cfg, `Scheduler started for ${facilities.length} facility(ies): monitoring "${s.nightlyCron}", summary "${s.summaryCron}" (${opts.timezone})`);
  if (s.catchUpOnStart) {
    const weekly = /^\S+ \S+ \* \* [0-6]$/.test(s.nightlyCron);
    const maxAge = (weekly ? 7 * 24 + 6 : 26) * 3600 * 1000; // weekly: a week + 6 h; daily: 26 h
    const stale = facilities.filter(f => f.register?.path).filter(f => {
      const last = new Store(loadConfig(f.id)).meta.lastSuccess;
      return !last || Date.now() - Date.parse(last) > maxAge;
    });
    if (stale.length) {
      logLine(cfg, `Last successful check older than the schedule allows for ${stale.map(f => f.code).join(', ')} - catch-up run in 2 minutes`);
      setTimeout(() => { if (!currentRun()) runAll('update', { trigger: 'catch-up' }).catch(() => {}); }, 120000);
    }
  }
}
