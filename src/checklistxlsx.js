// The ADHICS / HR document checklist of a facility as a clean Excel workbook: one sheet per section, the facility
// logo centred at the top, the facility name and code under the title, a status drop-down (Completed / Pending /
// Not applicable) coloured by its value, remarks, frozen header row and A4 landscape printing on one page width.
// Written from scratch (no spreadsheet library): plain SpreadsheetML parts zipped with JSZip.
import JSZip from 'jszip';
import { imageSize } from './imagesize.js';

export const STATUSES = ['Completed', 'Pending', 'Not applicable'];
const x = s => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// Columns: A gutter, B S.No, C document, D status, E remarks (Excel character widths)
const COLS = { A: 3, B: 8, C: 70, D: 18, E: 50 };
const px = w => Math.trunc(w * 7 + 5);
const EMU = 9525;
const FIRST_ROW = 7; // header on row 6

const STYLES = `${XML}<styleSheet xmlns="${NS}">
<fonts count="8">
<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="16"/><color rgb="FF1F2A44"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="13"/><color rgb="FF1F2A44"/><name val="Calibri"/><family val="2"/></font>
<font><i/><sz val="10"/><color rgb="FF6B7280"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF166534"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF9A3412"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="11"/><color rgb="FF6B7280"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="7">
<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFEDD5"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="5" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="6" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="7" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="3">
<dxf><font><b/><color rgb="FF166534"/></font><fill><patternFill><bgColor rgb="FFDCFCE7"/></patternFill></fill></dxf>
<dxf><font><b/><color rgb="FF9A3412"/></font><fill><patternFill><bgColor rgb="FFFFEDD5"/></patternFill></fill></dxf>
<dxf><font><color rgb="FF6B7280"/></font><fill><patternFill><bgColor rgb="FFF3F4F6"/></patternFill></fill></dxf>
</dxfs>
</styleSheet>`;

const STATUS_STYLE = { Completed: 7, Pending: 8, 'Not applicable': 9 };
const cell = (ref, text, s) => `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${x(text)}</t></is></c>`;
const num = (ref, n, s) => `<c r="${ref}" s="${s}"><v>${n}</v></c>`;
const blank = (ref, s) => `<c r="${ref}" s="${s}"/>`;
const lines = (text, width) => Math.max(1, ...String(text || '').split('\n').map(l => Math.ceil(l.length / (width * 1.05)) || 1));

/** Counts of a section's items by status. */
export const countStatuses = items => ({
  total: items.length,
  completed: items.filter(i => i.status === 'Completed').length,
  pending: items.filter(i => (i.status || 'Pending') === 'Pending').length,
  na: items.filter(i => i.status === 'Not applicable').length,
});

function sheetXml(sec, facility, hasLogo, exportedOn) {
  const items = sec.items || [];
  const c = countStatuses(items);
  const rows = [];
  rows.push(`<row r="1" spans="1:5" ht="${hasLogo ? 66 : 8}" customHeight="1"/>`);
  rows.push(`<row r="2" spans="1:5" ht="26" customHeight="1">${cell('B2', sec.heading || sec.title, 1)}${blank('C2', 1)}${blank('D2', 1)}${blank('E2', 1)}</row>`);
  rows.push(`<row r="3" spans="1:5" ht="21" customHeight="1">${cell('B3', `${facility.name}${facility.code ? `  (${facility.code})` : ''}`, 2)}${blank('C3', 2)}${blank('D3', 2)}${blank('E3', 2)}</row>`);
  const summary = `${c.completed} of ${c.total} completed · ${c.pending} pending${c.na ? ` · ${c.na} not applicable` : ''} · exported ${exportedOn}`;
  rows.push(`<row r="4" spans="1:5" ht="17" customHeight="1">${cell('B4', summary, 3)}${blank('C4', 3)}${blank('D4', 3)}${blank('E4', 3)}</row>`);
  rows.push('<row r="5" spans="1:5" ht="8" customHeight="1"/>');
  rows.push(`<row r="6" spans="1:5" ht="22" customHeight="1">${cell('B6', 'S.NO', 4)}${cell('C6', 'DOCUMENT NAME', 4)}${cell('D6', 'STATUS', 4)}${cell('E6', 'REMARKS', 4)}</row>`);
  items.forEach((it, k) => {
    const r = FIRST_ROW + k;
    const st = STATUSES.includes(it.status) ? it.status : 'Pending';
    const h = Math.max(20, Math.max(lines(it.name, COLS.C), lines(it.remarks, COLS.E)) * 15 + 6);
    rows.push(`<row r="${r}" spans="1:5" ht="${h}" customHeight="1">${num(`B${r}`, k + 1, 5)}${cell(`C${r}`, it.name, 6)}${cell(`D${r}`, st, STATUS_STYLE[st])}${cell(`E${r}`, it.remarks || '', 10)}</row>`);
  });
  const last = Math.max(FIRST_ROW, FIRST_ROW + items.length - 1);
  const cols = Object.entries(COLS).map(([, w], i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const range = `D${FIRST_ROW}:D${last}`;
  const cf = STATUSES.map((s, i) => `<cfRule type="cellIs" dxfId="${i}" priority="${i + 1}" operator="equal"><formula>"${s}"</formula></cfRule>`).join('');
  return `${XML}<worksheet xmlns="${NS}" xmlns:r="${RNS}">` +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    `<dimension ref="A1:E${last}"/>` +
    `<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="6" topLeftCell="A${FIRST_ROW}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="D${FIRST_ROW}" sqref="D${FIRST_ROW}"/></sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<cols>${cols}</cols>` +
    `<sheetData>${rows.join('')}</sheetData>` +
    '<mergeCells count="3"><mergeCell ref="B2:E2"/><mergeCell ref="B3:E3"/><mergeCell ref="B4:E4"/></mergeCells>' +
    `<conditionalFormatting sqref="${range}">${cf}</conditionalFormatting>` +
    `<dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="1" errorTitle="Status" error="Choose Completed, Pending or Not applicable" sqref="${range}"><formula1>"${STATUSES.join(',')}"</formula1></dataValidation></dataValidations>` +
    '<printOptions horizontalCentered="1"/>' +
    '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.3" footer="0.3"/>' +
    '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
    `<headerFooter><oddFooter>&amp;L&amp;8${x(facility.name)}${facility.code ? ` (${x(facility.code)})` : ''}&amp;R&amp;8Page &amp;P of &amp;N</oddFooter></headerFooter>` +
    (hasLogo ? '<drawing r:id="rId1"/>' : '') +
    '</worksheet>';
}

/** The logo centred over the table (columns B-E) in row 1. */
function drawingXml(logo) {
  const tableLeft = px(COLS.A), tableWidth = px(COLS.B) + px(COLS.C) + px(COLS.D) + px(COLS.E);
  const rowPx = 88; // row 1: 66 pt
  const k = Math.min(300 / logo.width, 76 / logo.height, 1.5);
  const w = Math.round(logo.width * k), h = Math.round(logo.height * k);
  const left = tableLeft + Math.round((tableWidth - w) / 2), top = Math.round((rowPx - h) / 2);
  return `${XML}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<xdr:absoluteAnchor><xdr:pos x="${left * EMU}" y="${top * EMU}"/><xdr:ext cx="${w * EMU}" cy="${h * EMU}"/>` +
    '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Facility logo" descr="Facility logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
    `<xdr:blipFill><a:blip xmlns:r="${RNS}" r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    `<xdr:spPr><a:xfrm><a:off x="${left * EMU}" y="${top * EMU}"/><a:ext cx="${w * EMU}" cy="${h * EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>` +
    '<xdr:clientData/></xdr:absoluteAnchor></xdr:wsDr>';
}

const sheetName = (s, used) => {
  let n = String(s || 'Sheet').replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  for (let k = 2; used.has(n.toLowerCase()); k++) n = `${n.slice(0, 28)} ${k}`;
  used.add(n.toLowerCase());
  return n;
};

/**
 * sections: [{ sheet, heading, title, items: [{ name, status, remarks }] }]
 * facility: { name, code }; logo: image buffer (PNG / JPEG) or null.
 */
export async function buildChecklistXlsx({ sections, facility, logo = null, exportedOn = new Date() }) {
  const zip = new JSZip();
  const img = logo ? imageSize(logo) : null;
  const ext = img?.ext === 'jpg' ? 'jpeg' : img?.ext;
  const hasLogo = !!img && ['png', 'jpeg', 'gif'].includes(ext);
  const day = exportedOn.toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', year: 'numeric' });
  const used = new Set();
  // tabs named like the portal sections: HR & facility · IT documents · EMR & others · Policies
  const names = sections.map(s => sheetName(s.title || s.sheet, used));
  sections.forEach((sec, i) => {
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sec, facility, hasLogo, day));
    if (hasLogo) {
      zip.file(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/drawing" Target="../drawings/drawing${i + 1}.xml"/></Relationships>`);
      zip.file(`xl/drawings/drawing${i + 1}.xml`, drawingXml(img));
      zip.file(`xl/drawings/_rels/drawing${i + 1}.xml.rels`, `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/image" Target="../media/logo.${ext}"/></Relationships>`);
    }
  });
  if (hasLogo) zip.file(`xl/media/logo.${ext}`, logo);
  zip.file('xl/styles.xml', STYLES);
  zip.file('xl/workbook.xml', `${XML}<workbook xmlns="${NS}" xmlns:r="${RNS}"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews><sheets>` +
    names.map((n, i) => `<sheet name="${x(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets><definedNames>' +
    names.map((n, i) => `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${x(n.replace(/'/g, "''"))}'!$6:$6</definedName>`).join('') + '</definedNames></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    names.map((n, i) => `<Relationship Id="rId${i + 1}" Type="${RNS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${names.length + 1}" Type="${RNS}/styles" Target="styles.xml"/></Relationships>`);
  zip.file('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  zip.file('docProps/core.xml', `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(`ADHICS checklist – ${facility.name}`)}</dc:title><dc:creator>Compliance Portal</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${exportedOn.toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`);
  zip.file('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    (hasLogo ? `<Default Extension="${ext}" ContentType="image/${ext}"/>` : '') +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    names.map((n, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      (hasLogo ? `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : '')).join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Read a checklist workbook laid out like "ADHICS CHECKLIST.xlsx": per sheet a heading in B1, S.NO / DOCUMENT NAME rows. */
export async function parseChecklistXlsx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const wb = await zip.file('xl/workbook.xml')?.async('string');
  if (!wb) throw new Error('Not an Excel workbook (.xlsx)');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const ss = await zip.file('xl/sharedStrings.xml')?.async('string') || '';
  const dec = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const strs = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => dec([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(t => t[1]).join('')));
  const sections = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"/g)) {
    const target = rels.match(new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"`))?.[1] || rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${m[2]}"`))?.[1];
    const xml = target && await zip.file(`xl/${target.replace(/^\/?xl\//, '')}`)?.async('string');
    if (!xml) continue;
    const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(r => Object.fromEntries([...r[1].matchAll(/<c\b[^>]*r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)].map(c => {
      const v = c[3].match(/<v>([^<]*)<\/v>/)?.[1];
      const t = /t="s"/.test(c[2]) ? strs[+v] : /t="inlineStr"/.test(c[2]) ? dec(c[3].match(/<t[^>]*>([^<]*)<\/t>/)?.[1] || '') : v;
      return [c[1], String(t ?? '').trim()];
    })));
    const heading = rows.find(r => Object.values(r).some(Boolean)) || {};
    const head = Object.values(heading).find(Boolean) || dec(m[1]);
    const hdr = rows.findIndex(r => Object.values(r).some(v => /document\s*name/i.test(v)));
    if (hdr < 0) continue;
    const nameCol = Object.keys(rows[hdr]).find(k => /document\s*name/i.test(rows[hdr][k]));
    const statusCol = Object.keys(rows[hdr]).find(k => /status/i.test(rows[hdr][k]));
    const remarksCol = Object.keys(rows[hdr]).find(k => /remark/i.test(rows[hdr][k]));
    const items = rows.slice(hdr + 1).filter(r => r[nameCol]).map(r => ({
      name: r[nameCol].replace(/\s+/g, ' ').trim(),
      status: STATUSES.find(s => s.toLowerCase() === String(r[statusCol] || '').toLowerCase()) || 'Pending',
      remarks: r[remarksCol] || '',
    }));
    if (items.length) sections.push({ sheet: dec(m[1]), heading: head, items });
  }
  if (!sections.length) throw new Error('No checklist found – each sheet needs a "DOCUMENT NAME" column');
  return sections;
}
