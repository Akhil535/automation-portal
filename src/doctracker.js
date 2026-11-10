// Document Tracker (Security & Awareness): every policy of the facility with its Policy ID, title, version, issue /
// review / approval / next-review dates, author, approver and change log – read live from the policy module (the
// same settings the policies are generated from), so the tracker never disagrees with the documents.
// Change log: version 1 → "NILL"; version 2 and above → the description of what changed (required).
// The Excel export mirrors the DoH-style tracker: a DOCUMENT CONTROLLER sheet (logo, title, document control,
// RESTRICTED / داخلي badge) and a DOCUMENT TRACKER sheet (one row per policy). Written from scratch with JSZip.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { loadConfig } from './config.js';
import { generatedFiles, listTemplates, masterFor, policyChange, prepSettings, printPics, saveSettings } from './policyprep.js';
import { imageSize } from './imagesize.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BADGE = path.join(APP, 'assets', 'restricted-badge.png');
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const plusOneYear = iso => { if (!ISO.test(iso || '')) return ''; const d = new Date(`${iso}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + 1); return d.toISOString().slice(0, 10); };
const nn = no => String(no).padStart(2, '0');

/** The tracker of a facility: its document control and one row per policy. */
export function trackerData(id) {
  const cfg = loadConfig(id), s = prepSettings(cfg);
  const made = new Set(generatedFiles(cfg).word.map(f => Number(/\bPO(\d{2})\b/.exec(f)?.[1])).filter(Boolean));
  const dueOn = plusOneYear(s.reviewedOn);
  const rows = listTemplates().map(t => {
    const c = policyChange(s, t.no), m = masterFor(t, c.version);
    return {
      no: t.no, policyId: `${s.code} / ${s.standard || t.standard || 'ADHICS'} - PO${nn(t.no)}`,
      // the policy's name as in a tracker: without the standard's prefix ("ADHICS - …")
      title: String(m.title || t.title || `Policy PO${nn(t.no)}`).trim().replace(new RegExp(`^(${s.standard || 'ADHICS'}|ADHICS)\\s*[-–]\\s*`, 'i'), ''), version: c.version,
      issuedOn: s.issuedOn, reviewedOn: s.reviewedOn, approvedOn: s.reviewedOn, nextReview: dueOn,
      preparedBy: s.preparedBy, approvedBy: s.approvedBy,
      change: c.change, changeNeeded: c.needed, changeOwn: c.own, generated: made.has(t.no),
    };
  });
  return {
    control: {
      facilityName: s.facilityName, code: s.code, number: `${s.code} / DOCUMENT TRACKER`,
      issuedOn: s.issuedOn, reviewedOn: s.reviewedOn, dueOn, preparedBy: s.preparedBy, approvedBy: s.approvedBy,
      version: '1.0', classification: 'RESTRICTED / داخلي',
    },
    rows, missing: rows.filter(r => r.changeNeeded).length, generated: made.size,
  };
}

/** Change one policy's version and change log (the same settings the policy documents use). */
export function savePolicyChange(id, no, { version, change } = {}) {
  const n = Number(no);
  if (!listTemplates().some(t => t.no === n)) throw Object.assign(new Error('Unknown policy'), { status: 404 });
  const s = prepSettings(loadConfig(id));
  const versions = { ...s.versions }, descriptions = { ...s.descriptions };
  if (version !== undefined) {
    const v = String(version).trim();
    if (!/^\d+\.\d$/.test(v) || Number(v) < 1) throw Object.assign(new Error('Version: use 1.0, 2.0, 3.0 …'), { status: 400 });
    versions[n] = v;
  }
  if (change !== undefined) { const c = String(change).trim().slice(0, 300); if (c && !/^nill?$/i.test(c)) descriptions[n] = c; else delete descriptions[n]; }
  saveSettings(id, { versions, descriptions });
  return trackerData(id);
}

// ---------------------------------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------------------------------
const x = v => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const serial = iso => (ISO.test(iso || '') ? Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000) : null);
// styles (cellXfs): 0 default · 1 text cell · 2 date cell · 3 version (0.0) · 4 header · 5 sheet title · 6 controller
// title · 7 "A. Document Control" · 8 label · 9 value · 10 value date · 11 value version
const STYLES = `${XML}<styleSheet xmlns="${NS}">
<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="10"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="10"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDAE3F3"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF002060"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD0CECE"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right><top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border>
<border><left/><right/><top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="165" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="165" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
const str = (ref, v, s) => `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${x(v)}</t></is></c>`;
const num = (ref, v, s) => (v == null || v === '' || Number.isNaN(Number(v)) ? `<c r="${ref}" s="${s}"/>` : `<c r="${ref}" s="${s}"><v>${Number(v)}</v></c>`);
const date = (ref, iso, s) => num(ref, serial(iso), s);
const row = (r, ht, cells) => `<row r="${r}" ht="${ht}" customHeight="1">${cells.join('')}</row>`;

function controllerSheet(d, hasDrawing) {
  const c = d.control, H = 'C', V = 'D';
  const rows = [
    row(4, 21, [`<c r="C4" s="0"/>`]), row(5, 21, []), row(6, 21, []), row(7, 21, []), row(8, 21, []),
    row(9, 25.8, [str('C9', `${c.facilityName} - DOCUMENT TRACKER`, 6), `<c r="D9" s="6"/>`]),
    row(10, 20.4, [str('C10', 'A. Document Control', 7), `<c r="D10" s="7"/>`]),
    row(11, 20.4, [str(`${H}11`, 'Document Number', 8), str(`${V}11`, c.number, 9)]),
    row(12, 20.4, [str(`${H}12`, 'Issued on', 8), date(`${V}12`, c.issuedOn, 10)]),
    row(13, 20.4, [str(`${H}13`, 'Reviewed on', 8), date(`${V}13`, c.reviewedOn, 10)]),
    row(14, 20.4, [str(`${H}14`, 'Due for Revision by', 8), date(`${V}14`, c.dueOn, 10)]),
    row(15, 20.4, [str(`${H}15`, 'Prepared by', 8), str(`${V}15`, c.preparedBy, 9)]),
    row(16, 20.4, [str(`${H}16`, 'Document Approver', 8), str(`${V}16`, c.approvedBy, 9)]),
    row(17, 20.4, [str(`${H}17`, 'Version', 8), num(`${V}17`, c.version, 11)]),
    row(18, 30, [str(`${H}18`, 'Document Classification', 8), `<c r="${V}18" s="9"/>`]), // the badge picture is the classification
  ];
  return `${XML}<worksheet xmlns="${NS}" xmlns:r="${RNS}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="C4:D18"/>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><sheetFormatPr defaultRowHeight="14.4"/>
<cols><col min="1" max="2" width="3" customWidth="1"/><col min="3" max="3" width="26.66" customWidth="1"/><col min="4" max="4" width="38.78" customWidth="1"/></cols>
<sheetData>${rows.join('')}</sheetData><mergeCells count="2"><mergeCell ref="C4:D8"/><mergeCell ref="C9:D9"/></mergeCells>
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="portrait" fitToHeight="1"/>${hasDrawing ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;
}
const COLS = [7.66, 19.66, 53.55, 12, 15, 15, 15, 16, 22, 27.33, 34];
const HEAD = ['Sr.no.', 'Policy ID', 'Policy Name', 'Version', 'Issue Date', 'Reviewed Date', 'Approved Date', 'Next Review Date', 'Prepared By', 'Approved By', '(if any Modification)'];
const L = 'ABCDEFGHIJK';
function trackerSheet(d) {
  const rows = [
    row(3, 46.2, [str('A3', 'Document Control', 5), ...[...L.slice(1)].map(k => `<c r="${k}3" s="5"/>`)]),
    row(4, 27.6, HEAD.map((h, i) => str(`${L[i]}4`, h, 4))),
    ...d.rows.map((p, i) => {
      const r = 5 + i, lines = Math.max(1, Math.ceil(p.title.length / 52), Math.ceil(String(p.change || '').length / 33));
      return row(r, Math.max(28.8, lines * 14), [num(`A${r}`, i + 1, 1), str(`B${r}`, p.policyId, 1), str(`C${r}`, p.title, 1), num(`D${r}`, p.version, 3),
        date(`E${r}`, p.issuedOn, 2), date(`F${r}`, p.reviewedOn, 2), date(`G${r}`, p.approvedOn, 2), date(`H${r}`, p.nextReview, 2),
        str(`I${r}`, p.preparedBy, 1), str(`J${r}`, p.approvedBy, 1), str(`K${r}`, p.changeNeeded ? '' : p.change, 1)]);
    }),
  ];
  const last = 4 + d.rows.length;
  return `${XML}<worksheet xmlns="${NS}" xmlns:r="${RNS}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A3:K${last}"/>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="14.4"/>
<cols>${COLS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rows.join('')}</sheetData><autoFilter ref="A4:K${last}"/><mergeCells count="1"><mergeCell ref="A3:K3"/></mergeCells>
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="landscape" fitToHeight="0"/>
<headerFooter><oddFooter>&amp;L${x(d.control.facilityName)}&amp;CRESTRICTED&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter></worksheet>`;
}
const EMU = 9525, px = w => Math.trunc(w * 7 + 5);
function drawingXml(pics) {
  const anchors = pics.map((p, i) => `<xdr:oneCellAnchor><xdr:from><xdr:col>${p.col}</xdr:col><xdr:colOff>${p.colOff}</xdr:colOff><xdr:row>${p.row}</xdr:row><xdr:rowOff>${p.rowOff}</xdr:rowOff></xdr:from><xdr:ext cx="${p.cx}" cy="${p.cy}"/>
<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="${x(p.name)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${p.cx}" cy="${p.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`).join('');
  return `${XML}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${RNS}">${anchors}</xdr:wsDr>`;
}

/** The facility's Document Tracker as an .xlsx buffer. */
export async function trackerXlsx(id) {
  const d = trackerData(id), cfg = loadConfig(id);
  const pics = [];
  const logo = (await printPics(cfg).catch(() => ({}))).logo;
  const boxW = px(26.66) + px(38.78), boxH = 5 * 21 / 0.75; // C4:D8 in pixels
  if (logo?.buffer && imageSize(logo.buffer)) {
    const info = imageSize(logo.buffer), k = Math.min((boxW - 20) / info.width, (boxH - 12) / info.height), w = Math.round(info.width * k), h = Math.round(info.height * k);
    const left = Math.round((boxW - w) / 2), c = left > px(26.66) ? 3 : 2;
    pics.push({ name: 'Facility logo', buffer: logo.buffer, ext: info.ext === 'jpg' ? 'jpeg' : info.ext, col: c, colOff: (left - (c === 3 ? px(26.66) : 0)) * EMU, row: 3, rowOff: Math.round((boxH - h) / 2) * EMU, cx: w * EMU, cy: h * EMU });
  }
  if (fs.existsSync(BADGE)) {
    const b = fs.readFileSync(BADGE), info = imageSize(b), h = 26, w = Math.round(info.width * h / info.height);
    pics.push({ name: 'RESTRICTED / داخلي', buffer: b, ext: 'png', col: 3, colOff: 6 * EMU, row: 17, rowOff: 7 * EMU, cx: w * EMU, cy: h * EMU });
  }
  const z = new JSZip();
  const exts = [...new Set(pics.map(p => p.ext))];
  z.file('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${exts.map(e => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('')}
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${pics.length ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
  z.file('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  z.file('docProps/core.xml', `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(d.control.facilityName)} - DOCUMENT TRACKER</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`);
  z.file('xl/workbook.xml', `${XML}<workbook xmlns="${NS}" xmlns:r="${RNS}"><bookViews><workbookView activeTab="1"/></bookViews><sheets><sheet name="DOCUMENT CONTROLLER" sheetId="1" r:id="rId1"/><sheet name="DOCUMENT TRACKER" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">'DOCUMENT TRACKER'!$A$4:$K$${4 + d.rows.length}</definedName><definedName name="_xlnm.Print_Titles" localSheetId="1">'DOCUMENT TRACKER'!$3:$4</definedName></definedNames></workbook>`);
  z.file('xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  z.file('xl/styles.xml', STYLES);
  z.file('xl/worksheets/sheet1.xml', controllerSheet(d, pics.length > 0));
  z.file('xl/worksheets/sheet2.xml', trackerSheet(d));
  if (pics.length) {
    z.file('xl/worksheets/_rels/sheet1.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
    z.file('xl/drawings/drawing1.xml', drawingXml(pics));
    z.file('xl/drawings/_rels/drawing1.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${pics.map((p, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i + 1}.${p.ext}"/>`).join('')}</Relationships>`);
    pics.forEach((p, i) => z.file(`xl/media/image${i + 1}.${p.ext}`, p.buffer));
  }
  const name = `${d.control.code} - DOCUMENT TRACKER.xlsx`;
  return { name, buffer: await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), data: d };
}
