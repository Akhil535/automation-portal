// Security & Awareness toolkit – the Cyber Security awareness presentation (PowerPoint).
// The master presentation (uploaded once; the original is never changed) is made for each facility:
//   · the facility's name replaces the master facility's name everywhere (the footer on every slide, the master and
//     its layouts, the notes);
//   · the "Reporting Information Security Events" slide gets the facility's IT / security contact – by default the
//     incident contact of policy PO18 (the policy details' contact e-mail and phone), or what the user typed instead;
//   · "Prepared By" gets the policies' author;
//   · one of 4 looks: 1 Master format (the presentation as designed), 2 Executive Dark (dark slides, cyan accents),
//     3 Corporate Minimalist (subtle grid, brand accent, light type), 4 Compact Official (framed slides, banners, logo).
// PDFs are made with Microsoft PowerPoint on this PC and cached by content (like the document previews).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { dir, loadConfig, loadGlobalConfig, updateFacility } from './config.js';
import { cachedPdf, contentKey, pdfFor, prepSettings, printPics } from './policyprep.js';
import { styleSettings, trialFacility } from './docstyle.js';
import { imageSize } from './imagesize.js';

/** The tools of the Security & Awareness section; new ones are added here (status 'soon' shows a placeholder page). */
export const TOOLS = [
  { id: 'calendar', title: 'Awareness Training Calendar', status: 'soon', desc: 'Plan the year\'s awareness sessions – topics, dates, trainers and who attended.' },
  { id: 'tracker', title: 'Document Tracker', status: 'soon', desc: 'Every compliance document with its owner, review date and status in one list.' },
  { id: 'cyberppt', title: 'Cyber Security PPT', status: 'ready', desc: 'The cyber security awareness presentation with your facility\'s name and IT contact.' },
  { id: 'visitors', title: 'Visitor Log Book', status: 'soon', desc: 'A printable visitor log for reception – name, company, purpose, time in and out.' },
];

export const PPT_STYLES = [
  { id: 'classic', no: 1, name: 'Master format', premium: false, desc: 'The presentation exactly as designed: white slides, blue accents, the original layout. Always the default.' },
  { id: 'dark', no: 2, name: 'Executive Dark', premium: true, desc: 'Dark slides with high-contrast cyan security accents and clean light text.' },
  { id: 'minimal', no: 3, name: 'Corporate Minimalist', premium: true, desc: 'A subtle dot grid, your brand accent colour and light, modern typography.' },
  { id: 'official', no: 4, name: 'Compact Official', premium: true, desc: 'Framed slides with a formal header banner, a footer band and your logo on every slide.' },
];
const pptStyle = id => PPT_STYLES.find(s => s.id === id) || PPT_STYLES[0];

const home = () => { const d = path.join(path.resolve(dir(loadGlobalConfig(), 'data')), 'toolkit', 'cyber-ppt'); fs.mkdirSync(d, { recursive: true }); return d; };
const masterFile = () => path.join(home(), 'master.pptx');
const infoFile = () => path.join(home(), 'master.json');
const x = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const esc = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const textsOf = s => (s.match(/<a:t>[^<]*<\/a:t>/g) || []).map(t => t.slice(5, -6));

/** What the master contains: its facility name (footer), contact e-mail and phone, the "Prepared By" name. */
export async function inspectMaster(buffer) {
  const z = await JSZip.loadAsync(buffer);
  const slides = Object.keys(z.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => Number(a.match(/(\d+)\.xml/)[1]) - Number(b.match(/(\d+)\.xml/)[1]));
  if (!slides.length) throw new Error('This is not a PowerPoint presentation with slides');
  const counts = new Map(), all = [];
  for (const s of slides) {
    const t = textsOf(await z.file(s).async('string'));
    all.push(t);
    for (const v of new Set(t.map(v => v.trim()).filter(v => v.length > 3 && v.length < 50 && !/^\d+$/.test(v)))) counts.set(v, (counts.get(v) || 0) + 1);
  }
  // the facility name: the short text on (almost) every slide – the footer
  const name = [...counts.entries()].filter(([, n]) => n >= slides.length * 0.6).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  // the security contact: the e-mail that stands next to a phone number (the incident-reporting text), else the
  // e-mail on the "Reporting Information Security Events" slide – never an example address from the training content
  const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/, PHONE = /\+?\d{3}[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}/;
  let email = '', phone = '', contactSlide = 0;
  all.forEach((t, si) => t.forEach(v => { if (!email && EMAIL.test(v) && PHONE.test(v)) { email = v.match(EMAIL)[0]; phone = v.match(PHONE)[0]; contactSlide = si + 1; } }));
  if (!email) {
    const si = all.findIndex(t => /report/i.test(t.join(' ')) && /security\s+(event|incident)/i.test(t.join(' ')) && t.some(v => EMAIL.test(v)));
    if (si >= 0) { const t = all[si]; email = t.find(v => EMAIL.test(v)).match(EMAIL)[0]; phone = t.join(' ').match(PHONE)?.[0] || ''; contactSlide = si + 1; }
  }
  // "Prepared By: Mr | Sulfikar" (slide 1): the title and the name runs after the label
  let preparer = null;
  const first = all[0] || [], i = first.findIndex(v => /prepared\s*by/i.test(v));
  if (i >= 0) {
    const rest = first.slice(i + 1).map(v => v.trim()).filter(Boolean);
    const title = /^(mr|mrs|ms|miss|dr)\.?$/i.test(rest[0] || '') ? rest[0] : '';
    const who = title ? rest[1] : rest[0];
    if (who && who.length < 40) preparer = { title, name: who };
  }
  return { slides: slides.length, name, email, phone, contactSlide, preparer };
}
export function masterInfo() {
  try { return fs.existsSync(masterFile()) ? JSON.parse(fs.readFileSync(infoFile(), 'utf8')) : null; } catch { return null; }
}
/** Administrators: the master presentation (replaced; the previous one is kept as master.previous.pptx). */
export async function saveMaster(buffer, name = '') {
  if (buffer.subarray(0, 2).toString() !== 'PK') throw new Error('Upload the presentation as .pptx');
  const info = await inspectMaster(buffer);
  if (fs.existsSync(masterFile())) fs.copyFileSync(masterFile(), path.join(home(), 'master.previous.pptx'));
  fs.writeFileSync(masterFile(), buffer);
  fs.writeFileSync(infoFile(), JSON.stringify({ ...info, original: name || 'presentation.pptx', at: new Date().toISOString() }, null, 2));
  return masterInfo();
}

/** The facility's settings and what the presentation will get. */
export function cyberState(id, { trial = false } = {}) {
  const cfg = loadConfig(id), s = prepSettings(cfg), own = cfg._facility.cyberPpt || {};
  const style = pptStyle(own.style).id;
  return {
    master: masterInfo(),
    facilityName: String(cfg._facility.name || s.facilityName || '').trim(),
    defaults: { email: s.contactEmail || '', phone: s.contactPhone || '', source: 'PO18 – incident contact (Prepare policies → policy details)' },
    email: own.email || '', phone: own.phone || '', // '' = the PO18 default
    preparedBy: s.preparedBy || '',
    choice: own.style || '', style: trial && pptStyle(style).premium ? 'classic' : style,
    styles: PPT_STYLES,
  };
}
export function saveCyber(id, body = {}) {
  const cfg = loadConfig(id), cur = cfg._facility.cyberPpt || {}, next = { ...cur };
  if (body.email !== undefined) {
    const e = String(body.email).trim();
    if (e && !/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(e)) throw Object.assign(new Error('The e-mail address is not valid'), { status: 400 });
    next.email = e;
  }
  if (body.phone !== undefined) {
    const p = String(body.phone).trim();
    if (p && !/^[+\d][\d\s()-]{5,20}$/.test(p)) throw Object.assign(new Error('The phone number is not valid'), { status: 400 });
    next.phone = p;
  }
  if (body.style !== undefined) { if (body.style && pptStyle(body.style).id !== body.style) throw new Error('Unknown presentation style'); next.style = body.style || ''; }
  updateFacility(id, { cyberPpt: next });
  return next;
}

// ---------------------------------------------------------------------------------------------------
// The looks (applied to the theme, the slide master and the slides; pictures and text stay as they are)
// ---------------------------------------------------------------------------------------------------
const lum = hex => { const n = parseInt(hex, 16); const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(n >> 16) + .7152 * f((n >> 8) & 255) + .0722 * f(n & 255); };
const setThemeColor = (th, name, hex) => th.replace(new RegExp(`<a:${name}>[\\s\\S]*?</a:${name}>`), `<a:${name}><a:srgbClr val="${hex}"/></a:${name}>`);
function darkText(xml) {
  // explicit dark text colours → light; explicit near-white shape fills → dark panels; slide backgrounds → dark
  xml = xml.replace(/<a:(rPr|defRPr|endParaRPr)\b[^>]*?(?:\/>|>[\s\S]*?<\/a:\1>)/g, r => r.replace(/<a:srgbClr val="([0-9A-Fa-f]{6})"/g, (m, c) => (lum(c) < 0.45 ? '<a:srgbClr val="E6F0FF"' : m)));
  xml = xml.replace(/<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/g, sp => sp.replace(/(<a:solidFill>\s*<a:srgbClr val=")([0-9A-Fa-f]{6})"/g, (m, a, c) => (lum(c) > 0.8 ? `${a}16223A"` : m)));
  return xml.replace(/<p:bg>[\s\S]*?<\/p:bg>/, '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="0B1220"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>');
}
const sp = (id, name, x0, y0, cx, cy, fill, line = '') => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x0}" y="${y0}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : '<a:noFill/>'}${line ? `<a:ln w="28575"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>'}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;

async function applyLook(z, id, { accent, logo }) {
  if (id === 'classic') return;
  const themePath = Object.keys(z.files).find(f => /^ppt\/theme\/theme\d+\.xml$/.test(f));
  let th = await z.file(themePath).async('string');
  const masters = Object.keys(z.files).filter(f => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(f));
  const slidesAndLayouts = Object.keys(z.files).filter(f => /^ppt\/(slides\/slide|slideLayouts\/slideLayout)\d+\.xml$/.test(f));
  const a = accent.replace('#', '').toUpperCase();
  if (id === 'dark') {
    for (const [n, v] of [['dk1', '0B1220'], ['lt1', 'E6F0FF'], ['dk2', '111C33'], ['lt2', 'C9D6EA'], ['accent1', '22D3EE'], ['accent2', 'A78BFA'], ['accent3', '34D399'], ['hlink', '67E8F9'], ['folHlink', 'A5B4FC']]) th = setThemeColor(th, n, v);
    for (const m of masters) {
      let mx = await z.file(m).async('string');
      mx = mx.replace(/<p:clrMap\b[^>]*\/>/, c => c.replace(/bg1="lt1"/, 'bg1="dk1"').replace(/tx1="dk1"/, 'tx1="lt1"').replace(/bg2="lt2"/, 'bg2="dk2"').replace(/tx2="dk2"/, 'tx2="lt2"'));
      z.file(m, darkText(mx).replace(/<p:bg>[\s\S]*?<\/p:bg>/, '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="0B1220"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'));
    }
    for (const f of slidesAndLayouts) { const sx = await z.file(f).async('string'); z.file(f, /<p:bg>/.test(sx) ? darkText(sx) : darkText(sx).replace(/(<p:cSld\b[^>]*>)/, '$1<p:bg><p:bgPr><a:solidFill><a:srgbClr val="0B1220"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>')); }
  }
  if (id === 'minimal') {
    th = setThemeColor(setThemeColor(setThemeColor(th, 'accent1', a), 'accent2', '64748B'), 'dk2', a);
    th = th.replace(/(<a:majorFont>\s*<a:latin typeface=")[^"]*"/, '$1Segoe UI Semibold"').replace(/(<a:minorFont>\s*<a:latin typeface=")[^"]*"/, '$1Segoe UI"');
    for (const m of masters) {
      const mx = await z.file(m).async('string');
      z.file(m, mx.replace(/<p:bg>[\s\S]*?<\/p:bg>/, '<p:bg><p:bgPr><a:pattFill prst="dotGrid"><a:fgClr><a:srgbClr val="E3E8F1"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill><a:effectLst/></p:bgPr></p:bg>'));
    }
    // the slides' own colours: bright text colours (e.g. red titles) → the brand accent; grey title bars → a very light
    // tint with an accent rule underneath (borderless, airy)
    const sat = c => { const n = parseInt(c, 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; return Math.max(r, g, b) - Math.min(r, g, b); };
    for (const f of slidesAndLayouts) {
      let sx = await z.file(f).async('string');
      sx = sx.replace(/<a:(rPr|defRPr|endParaRPr)\b[^>]*?(?:\/>|>[\s\S]*?<\/a:\1>)/g, r => r.replace(/<a:srgbClr val="([0-9A-Fa-f]{6})"/g, (mm, c) => (sat(c) > 90 ? `<a:srgbClr val="${a}"` : mm)));
      sx = sx.replace(/<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/g, s => s.replace(/(<a:solidFill>\s*<a:(?:srgbClr|schemeClr) val=")([0-9A-Fa-f]{6}|bg2|bg1)("[^>]*?(?:\/>|>[\s\S]*?<\/a:(?:srgbClr|schemeClr)>)\s*<\/a:solidFill>)/, (mm, pre, c, post) => {
        const grey = (/^[0-9A-Fa-f]{6}$/.test(c) && sat(c) < 25 && lum(c) > 0.25 && lum(c) < 0.9) || (/^bg[12]$/.test(c) && /<a:lumMod val="([0-9]+)"/.test(mm) && Number(mm.match(/<a:lumMod val="([0-9]+)"/)[1]) < 95000);
        return grey ? `<a:solidFill><a:srgbClr val="F3F5FA"/></a:solidFill>` : mm;
      }).replace(/<a:ln\b[^>]*>[\s\S]*?<\/a:ln>|<a:ln\b[^>]*\/>/, ln => ln)); // (outlines stay)
      z.file(f, sx);
    }
  }
  if (id === 'official') {
    th = setThemeColor(setThemeColor(th, 'accent1', a), 'dk2', a);
    const pres = await z.file('ppt/presentation.xml').async('string');
    const W = Number(pres.match(/<p:sldSz cx="(\d+)"/)?.[1] || 9144000), H = Number(pres.match(/<p:sldSz[^>]*cy="(\d+)"/)?.[1] || 6858000);
    for (const m of masters) {
      let mx = await z.file(m).async('string');
      const relPath = m.replace('slideMasters/', 'slideMasters/_rels/') + '.rels';
      let pic = '';
      if (logo?.buffer) {
        const info = imageSize(logo.buffer), ext = info?.ext === 'jpg' ? 'jpeg' : info?.ext;
        if (ext && ['png', 'jpeg', 'gif'].includes(ext)) {
          const media = `ppt/media/lrp-logo.${ext}`;
          z.file(media, logo.buffer);
          let rels = await z.file(relPath).async('string');
          if (!rels.includes('rIdLrpLogo')) rels = rels.replace('</Relationships>', `<Relationship Id="rIdLrpLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/lrp-logo.${ext}"/></Relationships>`);
          z.file(relPath, rels);
          let ct = await z.file('[Content_Types].xml').async('string');
          if (!new RegExp(`Extension="${ext}"`, 'i').test(ct)) ct = ct.replace('<Default ', `<Default Extension="${ext}" ContentType="image/${ext}"/><Default `);
          z.file('[Content_Types].xml', ct);
          const h = 400000, w = Math.min(1600000, Math.round(h * info.width / info.height));
          pic = `<p:pic><p:nvPicPr><p:cNvPr id="9103" name="Facility logo"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr userDrawn="1"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdLrpLogo"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${W - w - 230000}" y="${H - 300000 - h - 40000}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
        }
      }
      // a frame, a header banner and a footer band behind the content of every slide, the logo above the footer
      const shapes = sp(9100, 'Frame', 110000, 110000, W - 220000, H - 220000, '', a) + sp(9101, 'Header banner', 110000, 110000, W - 220000, 150000, a) + sp(9102, 'Footer band', 110000, H - 300000, W - 220000, 190000, 'E8EDF6') + pic;
      mx = mx.replace(/(<p:spTree>[\s\S]*?(?:<\/p:grpSpPr>|<p:grpSpPr\/>))/, `$1${shapes}`); // (short or long form)
      if (!/xmlns:r=/.test(mx.slice(0, 600))) mx = mx.replace('<p:sldMaster ', '<p:sldMaster xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
      z.file(m, mx);
    }
    // layouts that hide the master's shapes show the frame too
    for (const f of Object.keys(z.files).filter(f => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(f))) {
      const lx = await z.file(f).async('string');
      if (/showMasterSp="0"/.test(lx)) z.file(f, lx.replace(/\sshowMasterSp="0"/, ''));
    }
  }
  z.file(themePath, th);
}

/** The facility's presentation (.pptx buffer) in a style. */
export async function buildPpt(id, { style = null, email = null, phone = null } = {}) {
  if (!fs.existsSync(masterFile())) throw Object.assign(new Error('The master presentation has not been uploaded yet'), { status: 409 });
  const st = cyberState(id), info = st.master || {};
  const name = st.facilityName, mail = (email ?? st.email) || st.defaults.email, tel = (phone ?? st.phone) || st.defaults.phone;
  const z = await JSZip.loadAsync(fs.readFileSync(masterFile()));
  const parts = Object.keys(z.files).filter(f => /^ppt\/(slides\/slide|slideLayouts\/slideLayout|slideMasters\/slideMaster|notesSlides\/notesSlide)\d+\.xml$/.test(f));
  const swaps = [];
  if (info.name && name) swaps.push([new RegExp(esc(info.name), 'gi'), name]);
  if (info.email) swaps.push([new RegExp(esc(info.email), 'gi'), mail || '[IT department e-mail]']);
  if (info.phone) swaps.push([new RegExp(esc(info.phone), 'g'), tel || '[IT department phone]']);
  for (const f of parts) {
    let sx = await z.file(f).async('string');
    sx = sx.replace(/<a:t>([^<]*)<\/a:t>/g, (m, t) => { let v = t; for (const [re, to] of swaps) v = v.replace(re, x(to)); return `<a:t>${v}</a:t>`; });
    z.file(f, sx);
  }
  // "Prepared By": the policies' author (title and name in their own runs, as in the master)
  if (info.preparer && st.preparedBy) {
    const m = st.preparedBy.trim().match(/^(Mr|Mrs|Ms|Miss|Dr)\.?\s+(.+)$/i);
    const title = m ? m[1] : info.preparer.title, who = m ? m[2] : st.preparedBy.trim();
    const s1 = 'ppt/slides/slide1.xml';
    let sx = await z.file(s1).async('string');
    if (info.preparer.title) sx = sx.replace(`<a:t>${x(info.preparer.title)}</a:t>`, `<a:t>${x(title)}</a:t>`);
    sx = sx.replace(`<a:t>${x(info.preparer.name)}</a:t>`, `<a:t>${x(who)}</a:t>`);
    z.file(s1, sx);
  }
  const g = styleSettings();
  const pics = await printPics(loadConfig(id)).catch(() => ({}));
  await applyLook(z, pptStyle(style || st.style).id, { accent: g.accent, logo: pics.logo || null });
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
/**
 * What a presentation is made from (master, facility name, contacts, author, style, branding, logo): the same inputs
 * always give the same presentation, so its PDF can be found without building the 6-MB file again.
 */
async function inputsKey(id, style, opts = {}) {
  const st = cyberState(id), g = styleSettings();
  const logo = style === 'official' ? (await printPics(loadConfig(id)).catch(() => ({}))).logo?.buffer : null;
  const parts = [LOOK_VERSION, st.master?.at, st.facilityName, (opts.email ?? st.email) || st.defaults.email, (opts.phone ?? st.phone) || st.defaults.phone, st.preparedBy, style, g.accent,
    logo ? crypto.createHash('sha256').update(logo).digest('hex') : ''];
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}
/** Raised whenever a look changes, so presentations made with an older look are made again. */
const LOOK_VERSION = 4;
const sigFile = () => path.join(home(), 'pdf-index.json');
const readSigs = () => { try { return JSON.parse(fs.readFileSync(sigFile(), 'utf8')); } catch { return {}; } };
/** PDFs of the presentation in every style (made in one PowerPoint run, cached); returns the one asked for. */
export async function pptPdf(id, style, opts = {}) {
  const all = PPT_STYLES.map(s => s.id), want = pptStyle(style).id, i = all.indexOf(want);
  const sigs = await Promise.all(all.map(s => inputsKey(id, s, opts)));
  const known = readSigs()[sigs[i]], hit = known && cachedPdf(known);
  if (hit) return hit; // made before from exactly these inputs
  const bufs = await Promise.all(all.map(s => buildPpt(id, { ...opts, style: s })));
  const keys = await Promise.all(bufs.map(contentKey));
  const index = readSigs(); sigs.forEach((s, k) => { index[s] = keys[k]; });
  const names = Object.keys(index); if (names.length > 300) for (const n of names.slice(0, names.length - 300)) delete index[n];
  fs.writeFileSync(sigFile(), JSON.stringify(index));
  const pdfs = await pdfFor(bufs, { want: i, kind: 'ppt' });
  return pdfs[i];
}
export { trialFacility };
