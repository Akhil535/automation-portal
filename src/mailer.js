// E-mail: real-time alert after a run that processed new circulars (or failed),
// and a daily summary of the last 24 hours.
import nodemailer from 'nodemailer';
import { readSecrets } from './config.js';

const h = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtH = v => (v && typeof v === 'object' ? v.date : v);

export function circularTable(items) {
  if (!items.length) return '<p>No circulars.</p>';
  const rows = items.map(c => `<tr><td><a href="${h(c.url)}">${h(c.number)}</a></td><td>${h(c.name)}</td><td>${h(c.date)}</td>
    <td>${h(c.category)}</td><td><b>${h(c.values?.compliance)}</b></td><td>${h(c.values?.responsible)}</td>
    <td>${h(fmtH(c.values?.targetDate))}</td><td>${h(c.values?.frequency)}</td><td>${h(c.excelRow || c.status)}</td></tr>`).join('');
  return `<table style="border-collapse:collapse;font:13px Segoe UI,Arial" border="1" cellpadding="5">
    <tr style="background:#085d66;color:#fff"><th>Circular No.</th><th>Circular Name</th><th>Date</th><th>Category</th>
    <th>Compliance</th><th>Responsible</th><th>Target Date</th><th>Reporting Frequency</th><th>Excel row</th></tr>${rows}</table>`;
}

const fmtDate = iso => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC' }) : iso || '');

/** Standard institutional header (document control) for reports and e-mails. */
export function documentHeader(cfg) {
  const d = cfg?.documentControl?.values;
  if (!d) return '';
  const row = (k, v, dir = '') => `<tr><td style="background:#e3f1f2;font-weight:600;width:220px">${h(k)}</td><td${dir}>${h(v)}</td></tr>`;
  return `<table style="border-collapse:collapse;font:13px Segoe UI,Arial;margin:0 0 16px;min-width:480px" border="1" cellpadding="6">
    <tr><th colspan="2" style="background:#085d66;color:#fff;font-size:15px;text-align:center">${h(d.facilityTitle)}</th></tr>
    <tr><th colspan="2" style="text-align:left;background:#f4f7f8">A. Document Control</th></tr>
    ${row('Document Number', d.documentNumber)}${row('Date of Release', fmtDate(d.releaseDate))}${row('Document Approver', d.approver)}
    ${row('Document Author(s)', d.authors)}${row('Version No.', d.version)}${row('Document Classification', d.classification, ' dir="auto"')}
  </table>`;
}

export function runHtml(run, items, cfg) {
  const color = run.status === 'failed' ? '#b3261e' : run.status === 'success' || run.status === 'no_changes' ? '#11703a' : '#9a6200';
  return `<div style="font:14px Segoe UI,Arial;color:#1d2b36">
  ${documentHeader(cfg)}
  <h2 style="color:#085d66;margin:0 0 6px">DoH Circular Monitoring – ${h(new Date(run.started).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' }))}</h2>
  <p>Status: <b style="color:${color}">${h(run.statusLabel)}</b><br>
  Circulars checked on the DoH website: <b>${run.totalChecked}</b> · In register scope: ${run.inScope}<br>
  New circulars: <b>${run.newCount}</b> · Added to the LEGAL REGISTER: <b>${run.added}</b> ·
  Rows completed (F–J): ${run.filled || 0} · IT Department items: <b>${run.reviewCount || 0}</b></p>
  ${run.backup ? `<p style="font-size:12px;color:#55636e">Backup taken before update: ${h(run.backup)}</p>` : ''}
  ${items.length ? circularTable(items) : ''}
  ${run.conflicts?.length ? `<p><b>Held for manual check</b> (number already in register with a different title): ${run.conflicts.map(c => h(c.number)).join(', ')}</p>` : ''}
  ${run.errors?.length ? `<p style="color:#b3261e"><b>Errors</b><br>${run.errors.map(h).join('<br>')}</p>` : ''}
  <p style="font-size:12px;color:#55636e">Compliance values are filled automatically from the circular and the register's
  established practice. Status is "Fully Compliant" or "Not Applicable"; IT-related circulars are assigned to the IT Department
  (3rd-Party IT Service Provider). Confirm or override them in the portal.</p></div>`;
}

/** Send an e-mail through the configured SMTP server; `to` overrides the configured recipients. */
export async function sendMail(cfg, subject, html, to) {
  const e = cfg.email;
  const rcpt = to?.length ? to : e.to;
  if (!e.host) throw new Error('The e-mail server (SMTP) is not set up yet - enter the SMTP server, username and password in Settings → Schedule & e-mail → E-mail server, then Save');
  if (!rcpt?.length) throw new Error('No e-mail recipients configured');
  const pass = process.env.DOH_PORTAL_SMTP_PASSWORD || readSecrets(cfg).smtpPassword || '';
  const transport = nodemailer.createTransport({
    host: e.host, port: Number(e.port) || 587, secure: !!e.secure,
    auth: e.user ? { user: e.user, pass } : undefined,
  });
  await transport.sendMail({ from: e.from || e.user, to: rcpt.join(', '), subject, html });
}
