// Command line:
//   node cli.js check | run [--force] | fill-missing | summary | register-info | facilities   [--facility <id>|--all]
// Without --facility, the default facility is used; --all runs every facility (one DoH fetch).
import { loadConfig, loadFacilities } from './src/config.js';
import { runAll, runMonitor, sendAllSummaries, sendDailySummary } from './src/monitor.js';
import { lockReason, readRegister } from './src/xlsx.js';

const args = process.argv.slice(2);
const cmd = args[0] || 'check';
const fi = args.indexOf('--facility');
const facility = fi >= 0 ? args[fi + 1] : undefined;
const all = args.includes('--all');

if (cmd === 'facilities') {
  const { default: def, list } = loadFacilities();
  for (const f of list) console.log(`${f.id === def ? '*' : ' '} ${f.id.padEnd(12)} ${f.code.padEnd(8)} ${f.name}  ->  ${loadConfig(f.id).register.path || '(no register)'}`);
  process.exit(0);
}
if (cmd === 'register-info') {
  const cfg = loadConfig(facility);
  const s = await readRegister(cfg.register.path, cfg.register);
  console.log(`Facility: ${cfg.facility.name} (${cfg.facility.code})\nRegister: ${cfg.register.path}\nRecords: ${s.records.length}  Last row: ${s.lastDataRow}  Latest: ${s.records.at(-1).number}`);
  console.log(`Rows with blank F-J: ${s.records.filter(r => Object.values(r.meta).every(v => v === null || v === '')).map(r => r.row).join(', ') || 'none'}`);
  console.log(`Lock: ${lockReason(cfg.register.path) || 'not locked'}`);
  process.exit(0);
}
if (cmd === 'summary') {
  if (all) console.log(`Daily summary sent for: ${(await sendAllSummaries()).join(', ') || 'none (e-mail disabled)'}`);
  else console.log((await sendDailySummary(facility)) ? 'Daily summary sent' : 'E-mail summary disabled in settings');
  process.exit(0);
}
if (!['check', 'run', 'fill-missing'].includes(cmd)) {
  console.log('Usage: node cli.js check | run [--force] | fill-missing | summary | register-info | facilities  [--facility <id> | --all]');
  process.exit(1);
}

const opts = { force: args.includes('--force'), trigger: 'cli' };
const mode = cmd === 'check' ? 'check' : 'update';
const runs = all ? await runAll(mode, opts) : [await runMonitor(mode, { ...opts, facility })];
for (const run of runs) {
  console.log(`\n=== ${run.facilityName} (${run.facility}) ===`);
  for (const line of run.log) console.log(line.replace(/^\S+ /, ''));
  console.log(`\n${run.statusLabel}`);
  console.log(`Checked ${run.totalChecked} | in scope ${run.inScope} | new ${run.newCount} | added ${run.added} | F-J completed ${run.filled} | IT items ${run.reviewCount}`);
  if (run.backup) console.log(`Backup: ${run.backup}`);
  if (run.errors.length) console.log('Errors:\n - ' + run.errors.join('\n - '));
}
process.exit(runs.some(r => r.status === 'failed') ? 1 : runs.some(r => ['register_locked', 'awaiting_approval'].includes(r.status)) ? 2 : 0);
