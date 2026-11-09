// Document styles: 4 looks for the generated Word documents (and so for the PDFs Word makes from them).
//   1 Modern Classic (default)   – the master's own layout: metadata box, key-value fields, revision table.
//   2 Executive Split            – page 1 as two columns: a shaded sidebar with the policy details, the objectives,
//                                  scope and responsibilities beside it.
//   3 Corporate Minimalist       – a borderless top grid (labels in the accent colour above the values), accent rules,
//                                  coloured headings and a light revision table.
//   4 Compact Official           – a full-page border frame, a centred title and a horizontal summary table.
// Branding for every style (administrator): accent colour, font, and an optional watermark.
// The style is applied to the FILLED document (after every value was written and checked), so the facility details,
// dates and Ref. Nos stay exactly as generated; only the presentation changes. Forms (HR / 3rd-party) keep their
// own layout and get the style's frame, colours, font and watermark.
import JSZip from 'jszip';
import { loadGlobalConfig, saveConfig } from './config.js';
import { loadUsers } from './auth.js';

/** A facility created by a free-trial account (its documents stay on Modern Classic). */
export function trialFacility(f) {
  if (!f?.createdBy) return false;
  const u = loadUsers().users.find(x => x.username === f.createdBy);
  return !!u && u.role !== 'admin' && u.plan === 'trial';
}

export const STYLES = [
  { id: 'classic', no: 1, name: 'Modern Classic', premium: false, desc: 'The standard layout: the details box at the top, key-value fields and the revision table at the end.' },
  { id: 'split', no: 2, name: 'Executive Split', premium: true, desc: 'Page 1 in two columns: a sidebar with Policy ID, dates, facility and approver, the objectives and scope beside it.' },
  { id: 'minimal', no: 3, name: 'Corporate Minimalist', premium: true, desc: 'A clean borderless top grid, accent-coloured labels and headings, full-width text and a light revision table.' },
  { id: 'official', no: 4, name: 'Compact Official', premium: true, desc: 'A full-page border frame, a centred title and a horizontal summary table of the policy details.' },
];
export const FONTS = ['', 'Calibri', 'Arial', 'Segoe UI', 'Cambria', 'Georgia', 'Times New Roman', 'Verdana'];
const DEFAULT_ACCENT = '#1F3864';
export const styleById = id => STYLES.find(s => s.id === id) || STYLES[0];

/** The administrator's settings: default style, accent colour, font, watermark. */
export function styleSettings() {
  const g = loadGlobalConfig().docStyles || {};
  return {
    default: STYLES.some(s => s.id === g.default) ? g.default : 'classic',
    accent: /^#[0-9a-f]{6}$/i.test(g.accent || '') ? g.accent.toUpperCase() : DEFAULT_ACCENT,
    font: FONTS.includes(g.font) ? g.font : '',
    watermark: String(g.watermark || '').replace(/[<>&"]/g, '').trim().slice(0, 40),
  };
}
export function saveStyleSettings(body = {}) {
  const cfg = loadGlobalConfig();
  const cur = styleSettings();
  const next = { ...cur };
  if (body.default !== undefined) { if (!STYLES.some(s => s.id === body.default)) throw new Error('Unknown document style'); next.default = body.default; }
  if (body.accent !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(body.accent)) throw new Error('Accent colour: use a colour like #1F3864'); next.accent = body.accent.toUpperCase(); }
  if (body.font !== undefined) { if (!FONTS.includes(body.font)) throw new Error('Choose one of the listed fonts'); next.font = body.font; }
  if (body.watermark !== undefined) next.watermark = String(body.watermark).replace(/[<>&"]/g, '').trim().slice(0, 40);
  cfg.docStyles = next;
  saveConfig(cfg);
  return next;
}
/**
 * The style a facility's documents get: its own choice, else the default. Premium styles need a Premium account –
 * a facility created by a free-trial account always gets Modern Classic (trial: true).
 */
export function effectiveStyle(choice, { trial = false } = {}) {
  const g = styleSettings();
  let id = STYLES.some(s => s.id === choice) ? choice : g.default;
  if (trial && styleById(id).premium) id = 'classic';
  return { id, accent: g.accent, font: g.font, watermark: g.watermark };
}

// ---------------------------------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------------------------------
const x = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textOf = s => (s.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const hex = c => c.replace('#', '').toUpperCase();
/** A tint of the accent colour (k: share of white). */
function tint(c, k) {
  const n = parseInt(hex(c), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const m = v => Math.round(v + (255 - v) * k).toString(16).padStart(2, '0');
  return `${m(r)}${m(g)}${m(b)}`.toUpperCase();
}
/** End of the element starting at `start` (handles nesting and self-closing tags). */
function closeOf(xml, start, tag) {
  const first = xml.indexOf('>', start);
  if (xml[first - 1] === '/') return first + 1;
  const re = new RegExp(`<${tag}(?=[\\s>/])|</${tag}>`, 'g');
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(xml))) {
    if (m[0][1] === '/') { depth--; if (depth === 0) return m.index + m[0].length; }
    else { const gt = xml.indexOf('>', m.index); if (xml[gt - 1] !== '/') depth++; }
  }
  return xml.length;
}
/** Direct children of a range with the given tags, e.g. the body's paragraphs and tables. */
function childrenOf(xml, from, to, tags) {
  const out = [];
  const re = new RegExp(`<(${tags.join('|')})(?=[\\s>/])`, 'g');
  re.lastIndex = from;
  let m;
  while ((m = re.exec(xml)) && m.index < to) {
    const e = closeOf(xml, m.index, m[1]);
    out.push({ s: m.index, e, tag: m[1] });
    re.lastIndex = e;
  }
  return out;
}
const rowsOf = (xml, t) => childrenOf(xml, xml.indexOf('>', t.s) + 1, t.e, ['w:tr', 'w:tblPr', 'w:tblGrid']).filter(r => r.tag === 'w:tr');
const cellsOf = (xml, r) => childrenOf(xml, xml.indexOf('>', r.s) + 1, r.e, ['w:tc', 'w:trPr']).filter(c => c.tag === 'w:tc');

const META_LABEL = /policy\s*id|issued|reviewed|due\s*for|prepared|approved|facility\s*name|^version|classification|owner|effective/i;
/** The policy details table (Policy ID, dates, people, version …): its label / value pairs and title rows. */
function metaTable(xml, blocks) {
  for (const b of blocks.filter(b => b.tag === 'w:tbl').slice(0, 3)) {
    const pairs = [], titles = [];
    for (const r of rowsOf(xml, b)) {
      const cs = cellsOf(xml, r);
      const texts = cs.map(c => textOf(xml.slice(c.s, c.e)).replace(/\s+/g, ' ').trim());
      if (cs.length >= 2 && cs.length <= 4 && META_LABEL.test(texts[0])) {
        // a row can hold two pairs (label | value | label | value); a value that is a picture (e.g. a classification
        // badge) is carried over as it is
        const pic = c => (/<w:drawing|<w:pict/.test(xml.slice(c.s, c.e)) ? xml.slice(c.s, c.e).replace(/^<w:tc(?:\s[^>]*)?>/, '').replace(/<w:tcPr>[\s\S]*?<\/w:tcPr>/, '').replace(/<\/w:tc>$/, '') : '');
        const vc = cs.length === 4 ? cs[1] : cs.at(-1);
        pairs.push({ label: texts[0], value: cs.length === 4 ? texts[1] : texts.at(-1), pic: pic(vc) });
        if (cs.length === 4 && texts[2]) pairs.push({ label: texts[2], value: texts[3], pic: pic(cs[3]) });
      } else if (texts.join('').trim() && !/<w:drawing|<w:pict/.test(xml.slice(r.s, r.e))) titles.push(texts.filter(Boolean).join(' '));
    }
    if (pairs.length >= 4) return { block: b, pairs, titles };
  }
  return null;
}
function textWidth(xml) {
  const sect = xml.slice(xml.lastIndexOf('<w:sectPr'));
  const w = Number(sect.match(/<w:pgSz[^>]*w:w="(\d+)"/)?.[1] || 11906);
  const l = Number(sect.match(/<w:pgMar[^>]*w:left="(\d+)"/)?.[1] || 1440), r = Number(sect.match(/<w:pgMar[^>]*w:right="(\d+)"/)?.[1] || 1440);
  return Math.max(6000, w - l - r);
}
const run = (t, { b = false, sz = 20, color = '1F2937', caps = false, spacing = 0, font = '' } = {}) =>
  `<w:r><w:rPr>${font ? `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>` : ''}${b ? '<w:b/><w:bCs/>' : ''}${caps ? '<w:caps/>' : ''}<w:color w:val="${color}"/>${spacing ? `<w:spacing w:val="${spacing}"/>` : ''}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr><w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
const para = (t, o = {}) => `<w:p><w:pPr>${o.keep ? '<w:keepNext/>' : ''}<w:spacing w:before="${o.before || 0}" w:after="${o.after ?? 0}"/>${o.jc ? `<w:jc w:val="${o.jc}"/>` : ''}</w:pPr>${t ? run(t, o) : ''}</w:p>`;
const border = (side, val, sz, color) => `<w:${side} w:val="${val}" w:sz="${sz}" w:space="0" w:color="${color}"/>`;
const NONE = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="nil"/>`).join('');
function cell(w, content, { fill = '', borders = '', vAlign = 'top', mar = 120, span = 1 } = {}) {
  return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${borders ? `<w:tcBorders>${borders}</w:tcBorders>` : ''}${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}<w:tcMar><w:top w:w="${mar}" w:type="dxa"/><w:left w:w="${mar + 40}" w:type="dxa"/><w:bottom w:w="${mar}" w:type="dxa"/><w:right w:w="${mar + 40}" w:type="dxa"/></w:tcMar><w:vAlign w:val="${vAlign}"/></w:tcPr>${content}${/(<\/w:p>|<w:p\/>)\s*$/.test(content) ? '' : '<w:p/>'}</w:tc>`;
}
const table = (widths, rows, borders = NONE) => `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblLook w:val="0000"/></w:tblPr><w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`;
const tr = (cells, { header = false, cantSplit = false } = {}) => `<w:tr>${header || cantSplit ? `<w:trPr>${cantSplit ? '<w:cantSplit/>' : ''}${header ? '<w:tblHeader/>' : ''}</w:trPr>` : ''}${cells.join('')}</w:tr>`;

// Word checks the order of the formatting elements: <w:color> goes after rFonts / b / i / caps … and before
// spacing / sz / highlight / u …; <w:shd> in a cell goes after tcW / gridSpan / vMerge / tcBorders.
const AFTER_COLOR = /<w:(spacing|w|kern|position|sz|szCs|highlight|u|effect|bdr|shd|fitText|vertAlign|rtl|cs|em|lang|eastAsianLayout|specVanish|oMath)[\s/>]/;
function withColor(rpr, color) { // rpr: '<w:rPr>…</w:rPr>'
  let inner = rpr.slice(7, -8).replace(/<w:color [^>]*\/>/g, '');
  const m = inner.match(AFTER_COLOR);
  inner = m ? inner.slice(0, m.index) + `<w:color w:val="${color}"/>` + inner.slice(m.index) : `${inner}<w:color w:val="${color}"/>`;
  return `<w:rPr>${inner}</w:rPr>`;
}
/** Every run of a fragment in a colour (existing colours replaced). */
const colourRuns = (frag, color) => frag.replace(/(<w:r(?=[\s>])[^>]*>)(\s*<w:rPr>[\s\S]*?<\/w:rPr>)?/g, (m, open, rpr) => (rpr ? open + withColor(rpr.trim(), color) : `${open}<w:rPr><w:color w:val="${color}"/></w:rPr>`));
function withShading(tcPr, fill) { // tcPr: '<w:tcPr>…</w:tcPr>'
  let inner = tcPr.slice(8, -9).replace(/<w:shd [^>]*\/>/g, '');
  const m = inner.match(/<w:(noWrap|tcMar|textDirection|tcFitText|vAlign|hideMark|headers|cellIns|cellDel|cellMerge|tcPrChange)[\s/>]/);
  const shd = `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`;
  inner = m ? inner.slice(0, m.index) + shd + inner.slice(m.index) : inner + shd;
  return `<w:tcPr>${inner}</w:tcPr>`;
}
/** Short bold paragraphs outside tables (and Heading styles) get the accent colour. */
function colourHeadings(p, color) {
  const t = textOf(p).trim();
  const heading = /<w:pStyle w:val="(Heading|Title)[^"]*"/i.test(p) || (t && t.length < 70 && /<w:b\/>|<w:b w:val="(1|true)"\/>/.test(p) && !/[.:;,]$/.test(t));
  return heading ? colourRuns(p, color) : p;
}
/** Colour the runs inside a range only (used for headings outside tables). */
function outsideTables(xml, fn) {
  const b0 = xml.indexOf('<w:body>');
  const blocks = childrenOf(xml, b0 + 8, xml.length, ['w:p', 'w:tbl', 'w:sdt']);
  let out = xml.slice(0, b0 + 8), at = b0 + 8;
  for (const b of blocks) { out += xml.slice(at, b.s) + (b.tag === 'w:p' ? fn(xml.slice(b.s, b.e)) : xml.slice(b.s, b.e)); at = b.e; }
  return out + xml.slice(at);
}
/** The revision table (last table with Version + Review columns): header row in the accent tint, light borders. */
function lightRevisionTable(xml, accent, { frame = false } = {}) {
  const b0 = xml.indexOf('<w:body>');
  const tbls = childrenOf(xml, b0 + 8, xml.length, ['w:p', 'w:tbl', 'w:sdt']).filter(b => b.tag === 'w:tbl');
  const rev = [...tbls].reverse().find(t => /version/i.test(textOf(xml.slice(t.s, t.e))) && /review|approv/i.test(textOf(xml.slice(t.s, t.e))));
  if (!rev) return xml;
  let t = xml.slice(rev.s, rev.e);
  const line = frame ? accent : 'D9DEE7';
  t = t.replace(/<w:tblBorders>[\s\S]*?<\/w:tblBorders>/, `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => border(s, 'single', 4, line)).join('')}</w:tblBorders>`);
  const r1 = childrenOf(t, t.indexOf('>') + 1, t.length, ['w:tr', 'w:tblPr', 'w:tblGrid']).find(r => r.tag === 'w:tr');
  if (r1) {
    let row = t.slice(r1.s, r1.e).replace(/<w:tcPr>[\s\S]*?<\/w:tcPr>/g, tp => withShading(tp, frame ? hex(accent) : tint(accent, 0.86)));
    row = colourRuns(row, frame ? 'FFFFFF' : hex(accent));
    t = t.slice(0, r1.s) + row + t.slice(r1.e);
  }
  return xml.slice(0, rev.s) + t + xml.slice(rev.e);
}
/** A paragraph that keeps with the next one (keepNext goes right after pStyle in the paragraph properties). */
function keepWithNext(p) {
  if (/<w:keepNext\/>/.test(p)) return p;
  if (/<w:pPr>/.test(p)) return p.replace(/<w:pPr>(\s*<w:pStyle [^>]*\/>)?/, (m, st) => `<w:pPr>${st || ''}<w:keepNext/>`);
  if (/<w:pPr\/>/.test(p)) return p.replace('<w:pPr/>', '<w:pPr><w:keepNext/></w:pPr>');
  return p.replace(/^(<w:p(?:\s[^>]*)?>)/, '$1<w:pPr><w:keepNext/></w:pPr>');
}
/**
 * The revision table never breaks apart: no row splits over two pages, every row keeps with the next one, the last
 * row keeps with the signature / stamp line under it, and the header row repeats if the table is ever longer than a
 * page. So the table header, its rows and the signature + stamp land on the same page (no header alone at the
 * bottom of a page). A paragraph heading right before the table stays with it too.
 */
export function keepRevisionTogether(xml) {
  const b0 = xml.indexOf('<w:body>');
  if (b0 < 0) return xml;
  const blocks = childrenOf(xml, b0 + 8, xml.length, ['w:p', 'w:tbl', 'w:sdt']);
  const tbls = blocks.filter(b => b.tag === 'w:tbl');
  const rev = [...tbls].reverse().find(t => { const tx = textOf(xml.slice(t.s, t.e)); return /version/i.test(tx) && /review|approv/i.test(tx); });
  if (!rev) return xml;
  let t = xml.slice(rev.s, rev.e);
  // A floating (positioned) table ignores "keep together" and Word splits it anywhere – the masters' revision tables
  // are floating: it becomes a normal table, centred like before.
  t = t.replace(/<w:tblPr>([\s\S]*?)<\/w:tblPr>/, (m, inner) => {
    if (!/<w:tblpPr\b/.test(inner)) return m;
    inner = inner.replace(/<w:tblpPr\b[^>]*\/>/, '').replace(/<w:tblOverlap\b[^>]*\/>/, '').replace(/<w:jc\b[^>]*\/>/, '');
    const w = inner.match(/<w:tblW\b[^>]*\/>/);
    inner = w ? inner.replace(w[0], `${w[0]}<w:jc w:val="center"/>`) : inner.replace(/(<w:tblStyle\b[^>]*\/>)?/, `$1<w:jc w:val="center"/>`);
    return `<w:tblPr>${inner}</w:tblPr>`;
  });
  const rows = childrenOf(t, t.indexOf('>') + 1, t.length, ['w:tr', 'w:tblPr', 'w:tblGrid']).filter(r => r.tag === 'w:tr');
  let out = '', at = 0;
  rows.forEach((r, i) => {
    let row = t.slice(r.s, r.e);
    const trPr = row.match(/<w:trPr>[\s\S]*?<\/w:trPr>/)?.[0] || '';
    const add = (/<w:cantSplit\/>/.test(trPr) ? '' : '<w:cantSplit/>') + (i === 0 && !/<w:tblHeader\/>/.test(trPr) ? '<w:tblHeader/>' : '');
    if (add) row = trPr ? row.replace('<w:trPr>', `<w:trPr>${add}`) : row.replace(/^(<w:tr(?:\s[^>]*)?>)/, `$1<w:trPr>${add}</w:trPr>`);
    row = row.replace(/<w:p(?=[\s>])(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g, keepWithNext);
    out += t.slice(at, r.s) + row; at = r.e;
  });
  t = out + t.slice(at);
  // the paragraph right before the table (e.g. a "Revision History" heading) keeps with it
  const i = blocks.indexOf(rev), prev = blocks[i - 1];
  let head = xml.slice(0, rev.s);
  if (prev && prev.tag === 'w:p' && textOf(xml.slice(prev.s, prev.e)).trim()) head = xml.slice(0, prev.s) + keepWithNext(xml.slice(prev.s, prev.e)) + xml.slice(prev.e, rev.s);
  return head + t + xml.slice(rev.e);
}
function pageBorder(xml, color) {
  const pg = `<w:pgBorders w:offsetFrom="page">${['top', 'left', 'bottom', 'right'].map(s => `<w:${s} w:val="double" w:sz="6" w:space="24" w:color="${color}"/>`).join('')}</w:pgBorders>`;
  return xml.replace(/<w:sectPr(?:\s[^>]*)?>[\s\S]*?<\/w:sectPr>/g, sp => {
    sp = sp.replace(/<w:pgBorders[\s\S]*?<\/w:pgBorders>/, '');
    const after = sp.match(/<w:paperSrc[^>]*\/>/) || sp.match(/<w:pgMar[^>]*\/>/) || sp.match(/<w:pgSz[^>]*\/>/);
    return after ? sp.replace(after[0], after[0] + pg) : sp.replace(/<\/w:sectPr>$/, `${pg}</w:sectPr>`);
  });
}
function setFont(xml, font) {
  if (!font) return xml;
  return xml.replace(/<w:rFonts [^>]*\/>/g, `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:eastAsia="${font}"/>`);
}
const SHAPETYPE = '<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e"><v:formulas><v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/><v:f eqn="sum 0 0 @2"/><v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/><v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/><v:f eqn="if @0 @4 21600"/><v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @8"/><v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/></v:formulas><v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/><v:textpath on="t" fitshape="t"/><v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles><o:lock v:ext="edit" text="t" shapetype="t"/></v:shapetype>';
function watermarkPara(text, font) {
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:noProof/></w:rPr><w:pict>${SHAPETYPE}<v:shape id="LrpWatermark" o:spid="_x0000_s4097" type="#_x0000_t136" style="position:absolute;margin-left:0;margin-top:0;width:470pt;height:110pt;rotation:315;z-index:-251654144;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin" o:allowincell="f" fillcolor="#c8ccd6" stroked="f"><v:fill opacity=".3"/><v:textpath style="font-family:&quot;${font || 'Calibri'}&quot;;font-size:1pt" string="${x(text)}"/></v:shape></w:pict></w:r></w:p>`;
}
function addWatermark(hx, text, font) {
  if (/LrpWatermark/.test(hx)) return hx;
  if (!/xmlns:v=/.test(hx)) hx = hx.replace(/<w:hdr\b/, '<w:hdr xmlns:v="urn:schemas-microsoft-com:vml"');
  if (!/xmlns:o=/.test(hx)) hx = hx.replace(/<w:hdr\b/, '<w:hdr xmlns:o="urn:schemas-microsoft-com:office:office"');
  return hx.replace(/(<w:hdr\b[^>]*>)/, `$1${watermarkPara(text, font)}`);
}

// ---------------------------------------------------------------------------------------------------
// The page-1 layouts (policies)
// ---------------------------------------------------------------------------------------------------
/** Body blocks after the details table that belong to page 1 (until "Policy in Detail", a page / section break). */
function pageOneBlocks(xml, blocks, from) {
  const out = [];
  for (const b of blocks.slice(from + 1)) {
    const bx = xml.slice(b.s, b.e), t = textOf(bx).trim();
    if (/^policy\s+in\s+detail/i.test(t) || /w:type="page"|<w:pageBreakBefore|<w:sectPr|<w:lastRenderedPageBreak\/>[\s\S]*<w:t/.test(bx)) break;
    if (b.tag === 'w:tbl' && /version/i.test(t) && /review/i.test(t)) break; // never move the revision table
    out.push(b);
    if (out.length >= 45) break;
  }
  return out;
}
const titleParas = (titles, o) => titles.map(t => para(t, o)).join('');

function layoutSplit(xml, meta, blocks, accent, font) {
  const W = textWidth(xml), side = Math.round(W * 0.32), main = W - side;
  const idx = blocks.indexOf(meta.block);
  const moved = pageOneBlocks(xml, blocks, idx);
  const sideXml = para('Policy details', { b: true, sz: 18, caps: true, color: hex(accent), spacing: 20, after: 140, font })
    + meta.pairs.map(p => para(p.label, { sz: 15, caps: true, color: '5B6474', spacing: 10, after: 20, font, keep: true }) + (p.pic && !p.value ? p.pic : para(p.value || '—', { b: true, sz: 19, color: '111827', after: 150, font }))).join('');
  const mainXml = moved.map(b => xml.slice(b.s, b.e)).join('') || '<w:p/>';
  const tbl = table([side, main], [tr([
    cell(side, sideXml, { fill: tint(accent, 0.9), borders: border('right', 'single', 18, hex(accent)), mar: 140 }),
    cell(main, mainXml, { mar: 180 }),
  ])]);
  const head = titleParas(meta.titles, { b: true, sz: 30, color: hex(accent), after: 160, font });
  const end = moved.length ? moved.at(-1).e : meta.block.e;
  return xml.slice(0, meta.block.s) + head + tbl + xml.slice(end);
}
function layoutMinimal(xml, meta, accent, font) {
  const W = textWidth(xml), cols = 3, w = Math.floor(W / cols);
  const rows = [];
  for (let i = 0; i < meta.pairs.length; i += cols) {
    const slice = meta.pairs.slice(i, i + cols);
    while (slice.length < cols) slice.push(null);
    rows.push(tr(slice.map(p => cell(w, p ? para(p.label, { sz: 15, caps: true, color: hex(accent), spacing: 12, after: 30, font }) + (p.pic && !p.value ? p.pic : para(p.value || '—', { b: true, sz: 20, color: '111827', font })) : '<w:p/>', { mar: 90 })), { cantSplit: true }));
  }
  const borders = border('top', 'single', 12, hex(accent)) + '<w:left w:val="nil"/>' + border('bottom', 'single', 12, hex(accent)) + '<w:right w:val="nil"/>' + border('insideH', 'single', 4, 'E5E7EB') + '<w:insideV w:val="nil"/>';
  const head = titleParas(meta.titles, { b: true, sz: 34, color: '111827', after: 200, font });
  return xml.slice(0, meta.block.s) + head + table(Array(cols).fill(w), rows, borders) + para('', { after: 120 }) + xml.slice(meta.block.e);
}
function layoutOfficial(xml, meta, accent, font) {
  const W = textWidth(xml), per = Math.ceil(meta.pairs.length / Math.ceil(meta.pairs.length / 5)); // balanced bands of up to 5
  const rows = [];
  for (let i = 0; i < meta.pairs.length; i += per) {
    const slice = meta.pairs.slice(i, i + per);
    const w = Math.floor(W / slice.length);
    // each band: its own little table so the columns can differ per band
    rows.push(table(Array(slice.length).fill(w), [
      tr(slice.map(p => cell(w, para(p.label, { b: true, sz: 15, caps: true, color: 'FFFFFF', jc: 'center', font }), { fill: hex(accent), vAlign: 'center', mar: 70 })), { header: true, cantSplit: true }),
      tr(slice.map(p => cell(w, p.pic && !p.value ? p.pic : para(p.value || '—', { b: true, sz: 19, color: '111827', jc: 'center', font }), { vAlign: 'center', mar: 90 })), { cantSplit: true }),
    ], ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => border(s, 'single', 6, hex(accent))).join('')) + para('', { after: 80 }));
  }
  const head = titleParas(meta.titles, { b: true, sz: 30, caps: true, color: hex(accent), jc: 'center', after: 200, font });
  return xml.slice(0, meta.block.s) + head + rows.join('') + xml.slice(meta.block.e);
}

/**
 * Apply a style to a filled document. style: { id, accent, font, watermark }; kind: 'policy' | 'form'.
 * Returns the new buffer (or the same one for Modern Classic without branding).
 */
export async function applyDocStyle(buffer, style, { kind = 'policy' } = {}) {
  const st = { ...effectiveStyle(null), ...(style || {}) };
  const id = styleById(st.id).id, accent = st.accent || DEFAULT_ACCENT, font = st.font || '', mark = st.watermark || '';
  const zip = await JSZip.loadAsync(buffer);
  let xml = await zip.file('word/document.xml').async('string');
  const b0 = xml.indexOf('<w:body>');
  if (b0 < 0) return buffer;
  // every style (Modern Classic too): the revision table, its rows and the signature + stamp stay on one page
  if (kind === 'policy') {
    const kept = keepRevisionTogether(xml);
    if (id === 'classic' && !font && !mark) {
      if (kept === xml) return buffer;
      zip.file('word/document.xml', kept);
      return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    }
    xml = kept;
  } else if (id === 'classic' && !font && !mark) return buffer;

  if (id !== 'classic') {
    const blocks = childrenOf(xml, b0 + 8, xml.length, ['w:p', 'w:tbl', 'w:sdt']);
    const meta = kind === 'policy' ? metaTable(xml, blocks) : null;
    if (meta) {
      if (id === 'split') xml = layoutSplit(xml, meta, blocks, accent, font);
      else if (id === 'minimal') xml = layoutMinimal(xml, meta, accent, font);
      else if (id === 'official') xml = layoutOfficial(xml, meta, accent, font);
    }
    xml = outsideTables(xml, p => colourHeadings(p, hex(accent)));
    if (id === 'minimal' || id === 'official') xml = lightRevisionTable(xml, accent, { frame: id === 'official' });
    if (id === 'official') xml = pageBorder(xml, hex(accent));
  }
  xml = setFont(xml, font);
  zip.file('word/document.xml', xml);
  for (const part of Object.keys(zip.files).filter(f => /^word\/(header|footer)\d*\.xml$/.test(f))) {
    let hx = await zip.file(part).async('string');
    hx = setFont(hx, font);
    if (mark && /^word\/header/.test(part)) hx = addWatermark(hx, mark, font);
    zip.file(part, hx);
  }
  if (font) {
    const sp = 'word/styles.xml';
    if (zip.file(sp)) zip.file(sp, setFont(await zip.file(sp).async('string'), font));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
