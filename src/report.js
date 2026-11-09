// The LEGAL REGISTER report: the master workbook's Document Control and LEGAL REGISTER sheets as a print-ready page
// (on-screen print view and PDF download, printed by Microsoft Edge / Google Chrome in headless mode - nothing
// leaves the PC). Nothing is added to the master structure: no summary tiles, scores or status labels.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIXED } from './config.js';
import { imageSize } from './imagesize.js';

const h = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Logo bytes -> data URL (or ''). */
export function logoDataUrl(buf) {
  const size = buf && imageSize(buf);
  if (!size || size.width < 16) return '';
  return `data:image/${size.ext === 'jpg' ? 'jpeg' : size.ext};base64,${buf.toString('base64')}`;
}

/**
 * The LEGAL REGISTER report – exactly the master workbook's structure, nothing added:
 *   page 1: the DOCUMENT CONTROLLER sheet (facility title, "A. Document Control" and its 6 rows)
 *   page 2+: the LEGAL REGISTER sheet (logo with RESTRICTED at the right, the title, and the table with the master's
 *            7 columns: SL NO · NAME OF DEPARTMENT · ISSUED DATE · EXPIRY DATE · DUE DATE · RESPONSIBLE PERSON ·
 *            COMPLIANCE – dates as dd/mm/yyyy, empty dates as in the master "______").
 * Style 1 (master format) looks like the workbook (blue header row, Times New Roman headings, bold centred cells,
 * thin black lines); styles 2-4 change only the presentation of this same structure.
 */
function styleCss(style) {
  const a = /^#[0-9a-f]{6}$/i.test(style?.accent || '') ? style.accent : '#1F3864';
  const font = style?.font ? `body, table.reg td, .dc td { font-family: "${style.font.replace(/"/g, '')}", Calibri, Arial, sans-serif; }` : '';
  const looks = {
    classic: '',
    // 2 · Executive Split: Document Control as a shaded sidebar next to the register (one page)
    split: `.sheets { display: grid; grid-template-columns: 270px minmax(0, 1fr); gap: 18px; align-items: start; }
      .sheet.dc-sheet { page-break-after: auto; break-after: auto; background: color-mix(in srgb, ${a} 8%, #fff); border-left: 5px solid ${a}; border-radius: 8px; padding: 12px; }
      .dc { width: 100%; } .dc th.t { background: ${a}; color: #fff; font-size: 13px; } .dc td { display: block; border: 0; padding: 2px 0; } .dc td.k { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #5b6474; background: none; padding-top: 8px; }
      .dc tr { display: block; } .dc, .dc tbody { display: block; min-width: 0; } .dc th { display: block; border: 0; white-space: normal; overflow-wrap: anywhere; } .dc th.t { border-radius: 6px; padding: 8px; line-height: 1.25; }
      .lr-title { color: ${a}; text-decoration: none; text-align: left; font-size: 26px; border-bottom: 3px solid ${a}; padding-bottom: 4px; }
      table.reg th { background: ${a}; color: #fff; }`,
    // 3 · Corporate Minimalist: no fills, accent rules and hairlines, light typography
    minimal: `.lr-title { text-decoration: none; font-family: "Segoe UI", Arial, sans-serif; font-weight: 700; font-size: 24px; text-align: left; letter-spacing: .02em; }
      table.reg, table.reg th, table.reg td, .dc, .dc th, .dc td { border-left: 0 !important; border-right: 0 !important; }
      table.reg th { background: none; color: ${a}; font-family: "Segoe UI", Arial, sans-serif; font-size: 11px; letter-spacing: .06em; border-top: 2px solid ${a}; border-bottom: 2px solid ${a}; }
      table.reg td { border-color: #e3e6ec; font-weight: 600; } .dc th.t { background: none; color: ${a}; border-bottom: 2px solid ${a}; } .dc td { border-color: #e3e6ec; } .dc td.k { background: none; color: #5b6474; }`,
    // 4 · Compact Official: a double frame, centred title, accent header, every line in the accent colour
    official: `body { border: 4px double ${a}; padding: 18px 20px; } .lr-top { justify-content: center; flex-direction: column; align-items: center; gap: 6px; }
      .lr-title { color: ${a}; text-decoration: none; letter-spacing: .08em; } table.reg th { background: ${a}; color: #fff; } table.reg, table.reg th, table.reg td, .dc, .dc th, .dc td { border-color: ${a}; }
      .dc th.t { background: ${a}; color: #fff; }`,
  };
  const mark = style?.watermark ? `body::after { content: "${String(style.watermark).replace(/["\\<>]/g, '')}"; position: fixed; top: 45%; left: 50%; transform: translate(-50%, -50%) rotate(-30deg); font-size: 90px; font-weight: 800; color: rgba(120, 130, 150, .09); white-space: nowrap; pointer-events: none; z-index: 9; }` : '';
  return `${font}${looks[style?.id] || ''}${mark}`;
}

export function reportHtml({ cfg, items, logo = '', printButton = false, style = null }) {
  const d = cfg.documentControl.values;
  const blank = cfg.master?.noDate || '______';
  const date = v => (ISO.test(v || '') ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : v && !/^_+$/.test(v) ? h(v) : blank);
  const dmy = v => (ISO.test(v || '') ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : h(v || ''));
  const rows = items.map(i => `<tr><td>${h(i.sl)}</td><td class="n">${h(i.name)}</td><td>${date(i.issued)}</td><td>${date(i.expiry)}</td><td>${date(i.due)}</td><td>${h(i.responsible || '')}</td><td>${h(i.compliance || '')}</td></tr>`).join('');
  const dcRow = (k, v, dir = '') => `<tr><td class="k">${h(k)}</td><td${dir}>${v}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${h(d.facilityTitle)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; } body { font: 12px/1.35 Calibri, "Segoe UI", Arial, sans-serif; color: #000; margin: 0; padding: 16px; }
  @media print { body { padding: 0; } .noprint { display: none !important; } }
  .btn { position: fixed; top: 14px; right: 16px; padding: 7px 14px; border-radius: 8px; border: 0; background: #1f3864; color: #fff; font: 600 13px "Segoe UI"; cursor: pointer; }
  /* DOCUMENT CONTROLLER sheet */
  .sheet.dc-sheet { page-break-after: always; break-after: page; }
  .dc { border-collapse: collapse; width: 60%; min-width: 420px; }
  .dc th, .dc td { border: 1px solid #000; padding: 6px 9px; vertical-align: middle; }
  .dc th.t { font: 700 16px "Times New Roman", serif; text-align: center; background: #4f81bd; }
  .dc th.s { font: 700 13px "Times New Roman", serif; text-align: left; }
  .dc td.k { font-weight: 700; width: 45%; }
  /* LEGAL REGISTER sheet */
  .lr-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 6px; }
  .lr-top img { max-height: 70px; max-width: 320px; object-fit: contain; }
  .lr-class { font-weight: 700; white-space: nowrap; }
  .lr-title { font: 700 25px "Times New Roman", serif; text-decoration: underline; text-align: center; margin: 4px 0 10px; page-break-after: avoid; break-after: avoid; }
  table.reg { border-collapse: collapse; width: 100%; table-layout: fixed; }
  table.reg col.c1 { width: 3.0%; } table.reg col.c2 { width: 29.6%; } table.reg col.c3 { width: 11.2%; } table.reg col.c4 { width: 11.3%; }
  table.reg col.c5 { width: 10.3%; } table.reg col.c6 { width: 22.8%; } table.reg col.c7 { width: 12.8%; }
  table.reg th, table.reg td { border: 1px solid #000; padding: 6px 5px; text-align: center; vertical-align: middle; }
  table.reg th { font: 700 12px "Times New Roman", serif; background: #4f81bd; }
  table.reg td { font-weight: 700; font-size: 12px; overflow-wrap: anywhere; }
  table.reg td:nth-child(1), table.reg td:nth-child(3), table.reg td:nth-child(4), table.reg td:nth-child(5) { white-space: nowrap; overflow-wrap: normal; }
  @media screen { body { min-width: 1000px; } }
  table.reg thead { display: table-header-group; } table.reg tr { page-break-inside: avoid; break-inside: avoid; }
  ${styleCss(style)}
</style></head><body>
${printButton ? '<button class="btn noprint" onclick="print()">Print / Save as PDF</button>' : ''}
<div class="sheets">
  <section class="sheet dc-sheet">
    <table class="dc">
      <tr><th class="t" colspan="2">${h(d.facilityTitle)}</th></tr>
      <tr><th class="s" colspan="2">A. Document Control</th></tr>
      ${dcRow('Document Number', h(d.documentNumber))}${dcRow('Date of Release', dmy(d.releaseDate))}${dcRow('Document Approver', h(d.approver))}
      ${dcRow('Document Author(s)', h(d.authors))}${dcRow('Version No.', h(d.version))}${dcRow('Document Classification', h(d.classification), ' dir="auto"')}
    </table>
  </section>
  <section class="sheet lr-sheet">
    <div class="lr-top">${logo ? `<img src="${logo}" alt="">` : '<span></span>'}<span class="lr-class" dir="auto">${h(FIXED.classification)}</span></div>
    <h1 class="lr-title">${h(FIXED.registerTitle)}</h1>
    <table class="reg">
      <colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"><col class="c5"><col class="c6"><col class="c7"></colgroup>
      <thead><tr><th>SL NO</th><th>NAME OF DEPARTMENT</th><th>ISSUED DATE</th><th>EXPIRY DATE</th><th>DUE DATE</th><th>RESPONSIBLE PERSON</th><th>COMPLIANCE</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>
</div>
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
