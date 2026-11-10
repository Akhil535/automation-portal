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
import { cachedPdf, contentKey, pdfFor, pptToPdf, prepSettings, printPics } from './policyprep.js';
import { styleSettings, trialFacility } from './docstyle.js';
import { imageSize } from './imagesize.js';
import { artTiles, scenePng, topicOf } from './pptart.js';
import { CARTOONS } from './pptscenes.js';

/** The tools of the Security & Awareness section; new ones are added here (status 'soon' shows a placeholder page). */
export const TOOLS = [
  { id: 'calendar', title: 'Awareness Training Calendar', status: 'soon', desc: 'Plan the year\'s awareness sessions – topics, dates, trainers and who attended.' },
  { id: 'tracker', title: 'Document Tracker', status: 'ready', desc: 'Every policy with its ID, version, issue / review / approval dates, author, approver and change log – synced with the policies.' },
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
          const h = 170000, w = Math.min(900000, Math.round(h * info.width / info.height));
          pic = `<p:pic><p:nvPicPr><p:cNvPr id="9103" name="Facility logo"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr userDrawn="1"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdLrpLogo"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="2050000" y="${H - 290000}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
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
  // each look's own type pairing (titles get theirs on the slides, see composeSlides)
  const lf = LOOK_FONTS[id];
  th = th.replace(/(<a:majorFont>\s*<a:latin typeface=")[^"]*"/, `$1${lf.title}"`).replace(/(<a:minorFont>\s*<a:latin typeface=")[^"]*"/, `$1${lf.body}"`);
  z.file(themePath, th);
  // every look but the master format: framed pictures and a security illustration per slide (in free space only)
  const pres = await z.file('ppt/presentation.xml').async('string');
  await decorateSlides(z, id, accent, Number(pres.match(/<p:sldSz cx="([0-9]+)"/)?.[1] || 9144000), Number(pres.match(/<p:sldSz[^>]*cy="([0-9]+)"/)?.[1] || 6858000));
  await composeSlides(z, id, accent.replace('#', '').toUpperCase());
}

// ---------------------------------------------------------------------------------------------------
// Looks 2-4: every original picture and every word stays; the pictures are framed in the look's colours, and each
// slide gets a security illustration for its topic – only in a corner that is free (nothing is ever covered).
// ---------------------------------------------------------------------------------------------------
const EMU_IN = 914400;
const boxesIn = xml => [...xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/g)].map(m => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
const overlaps = (a, b, pad = 0.06 * EMU_IN) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
const PIC_FRAME = {
  dark: '<a:ln w="15875"><a:solidFill><a:srgbClr val="22D3EE"/></a:solidFill></a:ln><a:effectLst><a:glow rad="63500"><a:srgbClr val="22D3EE"><a:alpha val="35000"/></a:srgbClr></a:glow></a:effectLst>',
  minimal: '<a:ln><a:noFill/></a:ln><a:effectLst><a:outerShdw blurRad="152400" dist="38100" dir="5400000" algn="t" rotWithShape="0"><a:srgbClr val="1F2937"><a:alpha val="22000"/></a:srgbClr></a:outerShdw></a:effectLst>',
  official: a => `<a:ln w="19050"><a:solidFill><a:srgbClr val="${a}"/></a:solidFill></a:ln><a:effectLst><a:outerShdw blurRad="63500" dist="25400" dir="5400000" algn="t" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="30000"/></a:srgbClr></a:outerShdw></a:effectLst>`,
};
async function decorateSlides(z, look, accent, W, H) {
  const a = accent.replace('#', '').toUpperCase();
  const tiles = await artTiles(look, accent);
  if (!Object.keys(tiles).length) return; // no browser to draw them: the look without illustrations
  let ct = await z.file('[Content_Types].xml').async('string');
  if (!/Extension="png"/i.test(ct)) z.file('[Content_Types].xml', ct.replace('<Default ', '<Default Extension="png" ContentType="image/png"/><Default '));
  // 0 · the master's stick-figure cartoons → professional scenes telling the same story (their words kept)
  for (const media of Object.keys(z.files).filter(f => /^ppt\/media\/[^/]+\.png$/i.test(f))) {
    const buf = await z.file(media).async('nodebuffer');
    const scene = CARTOONS[crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)];
    if (!scene) continue;
    const png = await scenePng(scene, look, accent, buf.readUInt32BE(16), buf.readUInt32BE(20));
    if (png) z.file(media, png);
  }
  const layoutBoxes = new Map(); // layout file → its placeholders' boxes by type / idx
  const S = Math.round(0.82 * EMU_IN), m = Math.round(0.18 * EMU_IN), top = Math.round((look === 'official' ? 0.36 : 0.16) * EMU_IN), footer = Math.round(0.62 * EMU_IN);
  const slides = Object.keys(z.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  for (const f of slides) {
    let sx = await z.file(f).async('string');
    const relPath = f.replace('slides/', 'slides/_rels/') + '.rels';
    let rels = await z.file(relPath)?.async('string') || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    // 1 · the slide's pictures (not small badges): framed in the look's colours
    const frame = typeof PIC_FRAME[look] === 'function' ? PIC_FRAME[look](a) : PIC_FRAME[look];
    sx = sx.replace(/<p:pic>[\s\S]*?<\/p:pic>/g, pic => {
      const e = pic.match(/<a:ext cx="(\d+)" cy="(\d+)"/);
      if (!e || (+e[1] * +e[2]) < EMU_IN * EMU_IN || /<a:ln\b|<a:effectLst\b/.test(pic.match(/<p:spPr\b[\s\S]*?<\/p:spPr>/)?.[0] || '')) return pic;
      return pic.replace(/<\/p:spPr>/, `${frame}</p:spPr>`);
    });
    // 2 · what is already on the slide: its own shapes and the layout's placeholders it uses without a position
    const boxes = boxesIn(sx.replace(/<p:grpSpPr>[\s\S]*?<\/p:grpSpPr>/g, m0 => (/<a:chOff/.test(m0) ? m0 : '')));
    const layout = rels.match(/Type="[^"]*\/slideLayout"[^>]*Target="\.\.\/slideLayouts\/([^"]+)"/)?.[1] || rels.match(/Target="\.\.\/slideLayouts\/([^"]+)"[^>]*Type="[^"]*\/slideLayout"/)?.[1];
    if (layout) {
      if (!layoutBoxes.has(layout)) {
        const lx = await z.file(`ppt/slideLayouts/${layout}`)?.async('string') || '';
        layoutBoxes.set(layout, [...lx.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map(s0 => ({ ph: s0[0].match(/<p:ph\b[^>]*>/)?.[0] || '', box: boxesIn(s0[0])[0] })).filter(v => v.ph && v.box));
      }
      for (const s0 of sx.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []) {
        const ph = s0.match(/<p:ph\b[^>]*>/)?.[0]; if (!ph || boxesIn(s0).length) continue;
        const type = ph.match(/type="([^"]+)"/)?.[1] || 'body', idx = ph.match(/idx="([^"]+)"/)?.[1];
        const hit = layoutBoxes.get(layout).find(v => (idx && v.ph.includes(`idx="${idx}"`)) || (v.ph.match(/type="([^"]+)"/)?.[1] || 'body') === type);
        if (hit) boxes.push(hit.box);
      }
    }
    // 3 · the illustration for the slide's topic, in the first free corner (the footer stays clear)
    const text = (sx.match(/<a:t>[^<]*<\/a:t>/g) || []).map(t => t.slice(5, -6)).join(' ');
    const topic = topicOf(text);
    const spots = [{ x: W - S - m, y: top }, { x: m, y: top }, { x: W - S - m, y: H - S - footer }, { x: m, y: H - S - footer }].map(p => ({ ...p, w: S, h: S }));
    const spot = tiles[topic] && spots.find(p => !boxes.some(b => overlaps(p, b)));
    if (spot) {
      const media = `ppt/media/lrp-art-${look}-${topic}.png`;
      if (!z.file(media)) z.file(media, tiles[topic]);
      const rid = 'rIdLrpArt';
      if (!rels.includes(`Id="${rid}"`)) rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/lrp-art-${look}-${topic}.png"/></Relationships>`);
      const pic = `<p:pic><p:nvPicPr><p:cNvPr id="9201" name="Security illustration" descr="${topic}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${spot.x}" y="${spot.y}"/><a:ext cx="${S}" cy="${S}"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 16667"/></a:avLst></a:prstGeom></p:spPr></p:pic>`;
      sx = sx.replace(/<\/p:spTree>/, `${pic}</p:spTree>`);
      if (!/xmlns:r=/.test(sx.slice(0, 600))) sx = sx.replace('<p:sld ', '<p:sld xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
      z.file(relPath, rels);
    }
    z.file(f, sx);
  }
}

// ---------------------------------------------------------------------------------------------------
// The identity of looks 2-4: title bars, the title slide's banner and the content get each look's own composition
// (fonts, colours, cards / rules). Only shapes are added behind the content and title bars are recoloured – every
// word, position and picture stays as in the master.
// ---------------------------------------------------------------------------------------------------
const LOOK_FONTS = { dark: { title: 'Bahnschrift SemiBold', body: 'Calibri' }, minimal: { title: 'Segoe UI Semibold', body: 'Calibri Light' }, official: { title: 'Cambria', body: 'Calibri' } };
const fillOf = s => (s.match(/<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/)?.[1] || '').replace(/<a:ln\b[\s\S]*?<\/a:ln>|<a:ln\b[^>]*\/>/g, '').replace(/<a:extLst>[\s\S]*?<\/a:extLst>/g, '').match(/<a:solidFill>[\s\S]*?<\/a:solidFill>/)?.[0] || '';
const textOf = s => (s.match(/<a:t>[^<]*<\/a:t>/g) || []).map(t => t.slice(5, -6)).join('').trim();
/** Replace a shape's own fill (after its geometry). */
const setFill = (s, fill, geom = null) => s.replace(/<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>/, sp => {
  // (a placeholder may have no geometry of its own: it is given one, the fill follows the geometry)
  let v = /<a:prstGeom\b|<a:custGeom\b/.test(sp) ? sp : sp.replace(/(<\/a:xfrm>)/, `$1<a:prstGeom prst="${geom || 'rect'}"><a:avLst/></a:prstGeom>`);
  v = v.replace(/(<\/a:prstGeom>|<a:prstGeom\b[^>]*\/>)\s*(?:<a:solidFill>[\s\S]*?<\/a:solidFill>|<a:noFill\/>|<a:gradFill\b[\s\S]*?<\/a:gradFill>)?/, `$1${fill}`);
  if (geom) v = v.replace(/<a:prstGeom prst="[^"]*">\s*<a:avLst\/>\s*<\/a:prstGeom>/, `<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>`);
  return v;
});
/** Every run of a shape's text in a colour (and a font). */
function setRuns(s, color, font = null) {
  return s.replace(/<p:txBody>[\s\S]*<\/p:txBody>/, tb => tb.replace(/<a:(rPr|endParaRPr)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:\1>)/g, (m, tag, attrs, inner = '') => {
    let v = inner.replace(/<a:solidFill>[\s\S]*?<\/a:solidFill>|<a:gradFill\b[\s\S]*?<\/a:gradFill>/g, '');
    if (font) v = v.replace(/<a:latin\b[^>]*\/>/g, '');
    const ln = v.match(/^\s*<a:ln\b[\s\S]*?<\/a:ln>|^\s*<a:ln\b[^>]*\/>/)?.[0] || '';
    v = ln + `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` + v.slice(ln.length);
    if (font) { const i = v.search(/<a:(ea|cs|sym|hlinkClick|hlinkMouseOver|rtl|extLst)\b/); const lat = `<a:latin typeface="${font}"/>`; v = i < 0 ? v + lat : v.slice(0, i) + lat + v.slice(i); }
    return `<a:${tag}${attrs}>${v}</a:${tag}>`;
  }));
}
const shape = (id, name, b, geom, spPr, adj = '') => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(b.x)}" y="${Math.round(b.y)}"/><a:ext cx="${Math.round(b.w)}" cy="${Math.round(b.h)}"/></a:xfrm><a:prstGeom prst="${geom}"><a:avLst>${adj}</a:avLst></a:prstGeom>${spPr}</p:spPr><p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
const solid = (c, alpha = null) => `<a:solidFill><a:srgbClr val="${c}"${alpha == null ? '/>' : `><a:alpha val="${alpha}"/></a:srgbClr>`}</a:solidFill>`;
async function composeSlides(z, look, a) {
  const IN = EMU_IN, F = LOOK_FONTS[look];
  const isRed = f => /val="(C00000|FF0000|C0504D|E31A1C|B00000)"/i.test(f);
  for (const f of Object.keys(z.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
    let sx = await z.file(f).async('string');
    const behind = [], above = [];
    let id = 9300;
    sx = sx.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, s => {
      const b = boxesIn(s)[0], fill = fillOf(s), text = textOf(s);
      if (!b || !text || /<p:ph\b[^>]*type="(dt|ftr|sldNum)"/.test(s)) return s;
      // the title slide's banner (a red bar with the presentation's name)
      if (fill && isRed(fill) && b.w > 4 * IN && b.h < 1.6 * IN) {
        if (look === 'dark') return setRuns(setFill(s, '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="0E7490"/></a:gs><a:gs pos="100000"><a:srgbClr val="6D28D9"/></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill>', 'roundRect'), 'FFFFFF', F.title);
        if (look === 'minimal') return setRuns(setFill(s, solid(a), 'roundRect'), 'FFFFFF', F.title);
        above.push(shape(id++, 'Banner rule', { x: b.x, y: b.y + b.h, w: b.w, h: 0.06 * IN }, 'rect', `${solid('C9A227')}<a:ln><a:noFill/></a:ln>`));
        return setRuns(setFill(s, solid(a)), 'FFFFFF', F.title);
      }
      // a slide's title bar (a filled bar across the top)
      if (fill && b.y < 1.5 * IN && b.w > 5 * IN && b.h < 1.3 * IN && text.length < 90) {
        if (look === 'dark') {
          behind.push(shape(id++, 'Title accent', { x: b.x, y: b.y + 0.08 * IN, w: 0.08 * IN, h: b.h - 0.16 * IN }, 'rect', `${solid('22D3EE')}<a:ln><a:noFill/></a:ln>`));
          behind.push(shape(id++, 'Title rule', { x: b.x, y: b.y + b.h + 0.04 * IN, w: b.w, h: 0.035 * IN }, 'rect', `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="22D3EE"/></a:gs><a:gs pos="100000"><a:srgbClr val="A78BFA"><a:alpha val="0"/></a:srgbClr></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill><a:ln><a:noFill/></a:ln>`));
          return setRuns(setFill(s, '<a:noFill/>'), 'F8FAFC', F.title).replace(/(<a:pPr\b[^>]*?)\salgn="ctr"/g, '$1 algn="l"').replace(/(<a:bodyPr\b)/, '$1 lIns="228600"');
        }
        if (look === 'minimal') {
          behind.push(shape(id++, 'Title underline', { x: b.x + 0.1 * IN, y: b.y + b.h + 0.02 * IN, w: 1.6 * IN, h: 0.09 * IN }, 'roundRect', `${solid(a)}<a:ln><a:noFill/></a:ln>`));
          return setRuns(setFill(s, '<a:noFill/>'), a, F.title).replace(/(<a:pPr\b[^>]*?)\salgn="ctr"/g, '$1 algn="l"');
        }
        behind.push(shape(id++, 'Title rule', { x: b.x, y: b.y + b.h, w: b.w, h: 0.05 * IN }, 'rect', `${solid('C9A227')}<a:ln><a:noFill/></a:ln>`));
        return setRuns(setFill(s, solid(a)), 'FFFFFF', F.title);
      }
      // the content: a card behind it (dark, minimal) or a rule beside it (official)
      if (!fill && b.y > 1.0 * IN && b.w > 3 * IN && b.h > 1.2 * IN && text.length > 60 && !/<p:ph\b[^>]*type="(title|ctrTitle|subTitle)"/.test(s)) {
        const p = 0.14 * IN, card = { x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: Math.min(b.h + 2 * p, 6.88 * IN - (b.y - p)) }; // (the footer stays clear)
        if (look === 'dark') behind.push(shape(id++, 'Content card', card, 'roundRect', `${solid('111C33', 85000)}<a:ln w="9525">${solid('22D3EE', 35000)}</a:ln>`, '<a:gd name="adj" fmla="val 4000"/>'));
        else if (look === 'minimal') behind.push(shape(id++, 'Content card', card, 'roundRect', `${solid('FFFFFF')}<a:ln w="6350">${solid('E5E9F2')}</a:ln><a:effectLst><a:outerShdw blurRad="190500" dist="38100" dir="5400000" algn="t" rotWithShape="0"><a:srgbClr val="1F2937"><a:alpha val="12000"/></a:srgbClr></a:outerShdw></a:effectLst>`, '<a:gd name="adj" fmla="val 3500"/>'));
        else behind.push(shape(id++, 'Content rule', { x: b.x - 0.16 * IN, y: b.y, w: 0.05 * IN, h: b.h }, 'rect', `${solid(a)}<a:ln><a:noFill/></a:ln>`));
      }
      return s;
    });
    if (behind.length) sx = sx.replace(/(<p:spTree>[\s\S]*?(?:<\/p:grpSpPr>|<p:grpSpPr\/>))/, `$1${behind.join('')}`);
    if (above.length) sx = sx.replace(/<\/p:spTree>/, `${above.join('')}</p:spTree>`);
    z.file(f, sx);
  }
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
const LOOK_VERSION = 7;
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

/** The style cards' pictures: slide 2 of the facility's presentation in each look (one PowerPoint run, cached). */
const THUMB_SLIDE = 2;
const thumbDir = () => { const d = path.join(home(), 'thumbs'); fs.mkdirSync(d, { recursive: true }); return d; };
const thumbRuns = new Map();
export async function pptThumb(id, style) {
  const f = path.join(thumbDir(), `${await inputsKey(id, pptStyle(style).id)}.png`);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  if (!thumbRuns.has(id)) thumbRuns.set(id, makeThumbs(id).finally(() => thumbRuns.delete(id)));
  await thumbRuns.get(id);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  throw new Error('The slide picture could not be made (Microsoft PowerPoint is needed)');
}
async function makeThumbs(id) {
  const tmp = fs.mkdtempSync(path.join(thumbDir(), 'run-'));
  try {
    fs.mkdirSync(path.join(tmp, 'w'));
    const jobs = [];
    for (const s of PPT_STYLES) {
      const thumb = path.join(thumbDir(), `${await inputsKey(id, s.id)}.png`);
      if (fs.existsSync(thumb)) continue;
      const inp = path.join(tmp, 'w', `${s.id}.pptx`);
      fs.writeFileSync(inp, await buildPpt(id, { style: s.id }));
      jobs.push({ in: inp, out: path.join(tmp, 'w', `${s.id}.pdf`), pdf: false, thumb, slide: THUMB_SLIDE });
    }
    if (jobs.length) await pptToPdf(jobs);
    const list = fs.readdirSync(thumbDir()).filter(n => n.endsWith('.png')).map(n => ({ n, t: fs.statSync(path.join(thumbDir(), n)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const x of list.slice(200)) fs.rmSync(path.join(thumbDir(), x.n), { force: true });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
export { trialFacility };
