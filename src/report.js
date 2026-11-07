// Compliance snapshot report: one standard, print-ready page per facility (header, logo, RESTRICTED badge, status
// summary, the LEGAL REGISTER with a status per entry, circular statistics). Used for the on-screen print view and
// for the PDF download (printed by Microsoft Edge / Google Chrome in headless mode - nothing leaves the PC).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIXED } from './config.js';
import { documentHeader } from './mailer.js';
import { registerHealth } from './master.js';
import { imageSize } from './imagesize.js';

const h = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const day = v => (ISO.test(v || '') ? new Date(v + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }) : (v || '—'));
const STATUS = { expired: ['Expired', '#c0262d', '#fdecec'], expiring: ['Expires ≤ 30 days', '#b45309', '#fff4e0'], valid: ['Valid', '#15803d', '#e7f6ec'], lifetime: ['Lifetime · no expiry', '#15803d', '#e7f6ec'],
  'no-expiry': ['No expiry date', '#536373', '#eef2f6'], missing: ['No dates', '#7c3aed', '#f1ecfe'], fixed: ['Fixed law', '#536373', '#eef2f6'] };

/** Logo bytes -> data URL (or ''). */
export function logoDataUrl(buf) {
  const size = buf && imageSize(buf);
  if (!size || size.width < 16) return '';
  return `data:image/${size.ext === 'jpg' ? 'jpeg' : size.ext};base64,${buf.toString('base64')}`;
}

/**
 * Report HTML. data: { cfg, items, logo (data URL), circulars: { total, latest, lastCheck }, printButton }
 */
export function reportHtml({ cfg, items, logo = '', circulars = {}, printButton = false }) {
  const d = cfg.documentControl.values;
  const hl = registerHealth(items);
  const pending = hl.expired + hl.expiring + hl.missing;
  const pct = hl.total ? Math.round((hl.valid / hl.total) * 100) : 0;
  const tile = (n, label, color) => `<div class="tile" style="border-top-color:${color}"><b style="color:${color}">${n}</b><span>${label}</span></div>`;
  const rows = items.map(i => {
    const [label, fg, bg] = STATUS[i.status] || STATUS.fixed;
    return `<tr class="${i.fixed ? 'fixed' : ''}"><td class="c">${h(i.sl)}</td><td class="n">${h(i.name)}</td>
      <td><span class="pill" style="color:${fg};background:${bg}">${label}</span></td>
      <td class="d">${h(day(i.issued))}</td><td class="d">${i.status === 'lifetime' ? 'Lifetime' : h(day(i.expiry))}</td><td class="d">${i.status === 'lifetime' ? '—' : h(day(i.due))}</td><td>${h(i.responsible)}</td><td>${h(i.compliance)}</td></tr>`;
  }).join('');
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${h(d.facilityTitle)} - Compliance Snapshot</title>
<style>
  @page { size: A4 landscape; margin: 12mm 12mm 14mm; }
  * { box-sizing: border-box; } body { font: 11.5px/1.45 "Segoe UI", Arial, sans-serif; color: #15232b; margin: 0; padding: 18px; }
  @media print { body { padding: 0; } .noprint { display: none !important; } }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 3px solid #0f766e; padding-bottom: 10px; margin-bottom: 12px; }
  .top img { max-height: 62px; max-width: 260px; object-fit: contain; }
  .top h1 { font-size: 18px; margin: 0; } .top .sub { color: #5f6f7f; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; font-weight: 700; }
  .badge { border: 2px solid #c0262d; color: #c0262d; border-radius: 6px; padding: 3px 10px; font-weight: 800; font-size: 12px; white-space: nowrap; }
  .grid { display: grid; grid-template-columns: 1.05fr 1.6fr; gap: 16px; align-items: start; margin-bottom: 12px; }
  .grid table { min-width: 0 !important; width: 100%; margin: 0 !important; }
  .tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
  .tile { border: 1px solid #e3e8ef; border-top: 4px solid; border-radius: 8px; padding: 8px 10px; }
  .tile b { display: block; font-size: 22px; line-height: 1.1; } .tile span { color: #5f6f7f; font-size: 10.5px; font-weight: 600; }
  .score { margin-top: 8px; font-size: 11px; color: #5f6f7f; } .bar { height: 8px; border-radius: 9px; background: #eef2f6; overflow: hidden; margin-top: 4px; } .bar i { display: block; height: 100%; background: linear-gradient(90deg,#0f766e,#22c55e); }
  h2 { font-size: 13px; margin: 6px 0; color: #0f766e; text-transform: uppercase; letter-spacing: .05em; }
  table.reg { border-collapse: collapse; width: 100%; } table.reg th { background: #0f766e; color: #fff; text-align: left; padding: 6px 7px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; }
  table.reg td { border-bottom: 1px solid #e3e8ef; padding: 6px 7px; vertical-align: top; } table.reg td.c { text-align: center; color: #5f6f7f; } table.reg td.n { font-weight: 600; } table.reg td.d { white-space: nowrap; }
  table.reg tr.fixed td { color: #5f6f7f; background: #f7f9fc; } table.reg tr { page-break-inside: avoid; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 99px; font-weight: 700; font-size: 10px; white-space: nowrap; }
  .foot { margin-top: 10px; color: #5f6f7f; font-size: 10px; display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid #e3e8ef; padding-top: 6px; }
  .btn { position: fixed; top: 14px; right: 16px; padding: 7px 14px; border-radius: 8px; border: 0; background: #0f766e; color: #fff; font: 600 13px "Segoe UI"; cursor: pointer; }
</style></head><body>
${printButton ? '<button class="btn noprint" onclick="print()">Print / Save as PDF</button>' : ''}
<div class="top">
  <div style="display:flex;align-items:center;gap:14px">${logo ? `<img src="${logo}" alt="">` : ''}<div><div class="sub">${h(FIXED.registerTitle)} · Compliance snapshot</div><h1>${h(d.facilityTitle)}</h1></div></div>
  <span class="badge" dir="auto">${h(FIXED.classification)}</span>
</div>
<div class="grid">
  <div>${documentHeader(cfg)}</div>
  <div>
    <h2>Compliance status</h2>
    <div class="tiles">${tile(hl.total, 'Total entries', '#0f766e')}${tile(hl.valid, 'Valid', '#15803d')}${tile(hl.expiring, 'Expire ≤ 30 days', '#b45309')}${tile(hl.expired, 'Expired', '#c0262d')}${tile(pending, 'Pending action', '#7c3aed')}</div>
    <div class="score">${pct}% of facility entries valid${hl['no-expiry'] ? ` · ${hl['no-expiry']} without expiry date` : ''} · 6 federal laws fixed
      <div class="bar"><i style="width:${pct}%"></i></div></div>
    <div class="score">DoH circulars in the register: <b>${h(circulars.total ?? '–')}</b>${circulars.latest ? ` (latest ${h(circulars.latest)})` : ''} · last DoH check: <b>${h(circulars.lastCheck || 'never')}</b></div>
  </div>
</div>
<h2>LEGAL REGISTER</h2>
<table class="reg"><thead><tr><th>SL</th><th>Name of department</th><th>Status</th><th>Issued</th><th>Expiry</th><th>Due</th><th>Responsible person</th><th>Compliance</th></tr></thead><tbody>${rows}</tbody></table>
<div class="foot"><span>${h(d.documentNumber)} · Version ${h(d.version)} · Date of Release ${h(day(d.releaseDate))}</span><span>Generated ${h(now)} (Asia/Dubai) by the Legal Register Portal</span><span dir="auto">${h(FIXED.classification)}</span></div>
</body></html>`;
}

// Chrome writes the PDF before it exits; Edge's launcher can return first and write the file a moment later
// (handled by waiting for the file below).
const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Wait until a file exists and its size has stopped changing (max ~45 s). */
async function settled(file) {
  let last = -1;
  for (let i = 0; i < 90; i++) {
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      if (size > 0 && size === last) return true;
      last = size;
    }
    await sleep(500);
  }
  return false;
}

/** Print report HTML to a PDF buffer with headless Edge / Chrome. */
export function htmlToPdf(html) {
  const browser = BROWSERS.find(p => fs.existsSync(p));
  if (!browser) return Promise.reject(new Error('Microsoft Edge or Google Chrome is needed to create the PDF - use Export / Print and "Save as PDF" instead'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrp-pdf-'));
  const src = path.join(dir, 'report.html'), out = path.join(dir, 'report.pdf');
  fs.writeFileSync(src, html);
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    `--user-data-dir=${path.join(dir, 'profile')}`, '--no-pdf-header-footer', `--print-to-pdf=${out}`, `file:///${src.replace(/\\/g, '/')}`];
  return new Promise((resolve, reject) => {
    execFile(browser, args, { timeout: 90000, windowsHide: true }, async err => {
      try {
        if (!(await settled(out))) return reject(new Error(`PDF could not be created${err ? `: ${err.message.split('\n')[0]}` : ''}`));
        resolve(fs.readFileSync(out));
      } finally {
        await sleep(300);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* browser may still hold its profile for a moment */ }
      }
    });
  });
}
