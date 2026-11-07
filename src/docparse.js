// Read facility documents in Word (.docx / .doc) or PDF form into a common shape:
//   { kind, rows: [[cell, cell, ...], ...], images: [{ buffer, ext, width, height, where }] }
// rows: every table row (Word) or every text line split into columns (PDF), in reading order.
// images: candidate logos (Word: page-header pictures; PDF: pictures in the top part of page 1).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { imageSize } from './imagesize.js';

const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const clean = s => decode(String(s || '')).replace(/\s+/g, ' ').trim();
const paraTexts = xml => [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
  .map(p => clean([...p[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map(m => m[1] ?? ' ').join(''))).filter(Boolean);

export const kindOf = (name, buffer) => {
  if (buffer?.subarray(0, 4).toString() === '%PDF') return 'pdf';
  if (buffer?.subarray(0, 2).toString() === 'PK') return 'docx';
  if (buffer?.length > 8 && buffer.readUInt32BE(0) === 0xd0cf11e0) return 'doc'; // OLE compound file (Word 97-2003)
  if (buffer?.length > 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'png'; // photo / scan of a document
  if (buffer?.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  const ext = path.extname(name || '').toLowerCase().slice(1);
  return ['pdf', 'docx', 'doc'].includes(ext) ? ext : ['jpg', 'jpeg'].includes(ext) ? 'jpg' : ext === 'png' ? 'png' : null;
};

// ---------------------------------------------------------------------------------------------------
// Word .docx
// ---------------------------------------------------------------------------------------------------
async function readDocx(buffer) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch { throw new Error('The file could not be opened as a Word document'); }
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('Not a Word document');
  const rows = [];
  // Tables in order, then paragraphs outside tables as single-cell rows.
  const parts = xml.split(/(<w:tbl>[\s\S]*?<\/w:tbl>)/);
  for (const part of parts) {
    if (part.startsWith('<w:tbl>')) {
      for (const tr of part.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)) {
        const cells = [...tr[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)].map(c => paraTexts(c[0]).join(' ')).filter(Boolean);
        if (cells.length) rows.push(cells);
      }
    } else for (const p of paraTexts(part)) rows.push([p]);
  }
  // Header pictures = logo candidates.
  const images = [];
  const rels = await zip.file('word/_rels/document.xml.rels')?.async('string') || '';
  const headers = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).filter(r => /\/header"/.test(r))
    .map(r => r.match(/Target="([^"]+)"/)[1].replace(/^\/?(word\/)?/, ''));
  for (const h of headers) {
    const hx = await zip.file(`word/${h}`)?.async('string');
    const hr = await zip.file(`word/_rels/${h.split('/').pop()}.rels`)?.async('string');
    if (!hx || !hr) continue;
    for (const [, rid] of hx.matchAll(/(?:r:embed|r:id)="([^"]+)"/g)) { // DrawingML pictures and legacy VML (v:imagedata)
      const m = hr.match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`));
      const t = m && (m[1] || m[2]);
      const f = t && (zip.file(`word/${t.replace(/^\.\.\//, '').replace(/^\/?word\//, '')}`) || zip.file(t.replace(/^\//, '')));
      if (!f) continue;
      const buf = await f.async('nodebuffer');
      const size = imageSize(buf);
      if (size) images.push({ buffer: buf, ...size, where: 'header' });
    }
  }
  // Every picture of the document (body included): a Word file holding just a logo, signature or stamp. Pictures in
  // a table that has a "Signature" column (the approval / version table) are marked: that is where signatures and
  // stamps sit.
  const docRels = await zip.file('word/_rels/document.xml.rels')?.async('string') || '';
  const target = rid => { const m = docRels.match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`)); return m && (m[1] || m[2]).replace(/^\.\.\//, '').replace(/^\/?word\//, ''); };
  const approval = new Set(), badges = new Set();
  for (const t of xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || []) {
    const text = paraTexts(t).join(' ');
    if (/signature/i.test(text)) for (const [, rid] of t.matchAll(/(?:r:embed|r:id)="([^"]+)"/g)) { const f = target(rid); if (f) approval.add(f.toLowerCase()); }
    // the "Document Classification" row holds the RESTRICTED badge - never a logo, signature or stamp
    for (const row of t.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || []) {
      if (!/classification/i.test(paraTexts(row).join(' '))) continue;
      for (const [, rid] of row.matchAll(/(?:r:embed|r:id)="([^"]+)"/g)) { const f = target(rid); if (f) badges.add(f.toLowerCase()); }
    }
  }
  // pictures of the page footers (badges, footer lines)
  for (const r of [...docRels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).filter(r => /\/footer"/.test(r))) {
    const part = r.match(/Target="([^"]+)"/)[1].replace(/^\/?(word\/)?/, '');
    const fr = await zip.file(`word/_rels/${part.split('/').pop()}.rels`)?.async('string') || '';
    for (const [, t] of fr.matchAll(/Target="([^"]+)"/g)) badges.add(t.replace(/^\.\.\//, '').replace(/^\/?word\//, '').toLowerCase());
  }
  const allImages = [];
  for (const f of Object.values(zip.files).filter(x => !x.dir && /^word\/media\//i.test(x.name))) {
    const buf = await f.async('nodebuffer');
    const size = imageSize(buf);
    const key = f.name.replace(/^word\//i, '').toLowerCase();
    const where = approval.has(key) ? 'approval' : badges.has(key) ? 'footer' : 'body';
    if (size && !images.some(i => i.buffer.equals(buf))) allImages.push({ buffer: buf, ...size, where });
  }
  return { kind: 'docx', rows, images, allImages };
}

// ---------------------------------------------------------------------------------------------------
// Word 97-2003 .doc -> converted to .docx by Microsoft Word on this PC (macros disabled)
// ---------------------------------------------------------------------------------------------------
export function docToDocx(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrp-doc-'));
  const src = path.join(dir, 'in.doc'), out = path.join(dir, 'out.docx');
  fs.writeFileSync(src, buffer);
  const ps = `$ErrorActionPreference='Stop';$w=New-Object -ComObject Word.Application;$w.Visible=$false;$w.DisplayAlerts=0;` +
    `$w.AutomationSecurity=3;try{$d=$w.Documents.Open('${src}',$false,$true,$false);$d.SaveAs2('${out}',16);$d.Close($false)}finally{$w.Quit()}`;
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 120000, windowsHide: true }, err => {
      try {
        if (err || !fs.existsSync(out)) return reject(new Error('This .doc file could not be converted (Microsoft Word is needed on the server PC). Save it as .docx or PDF and upload again.'));
        resolve(fs.readFileSync(out));
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  });
}

// ---------------------------------------------------------------------------------------------------
// PDF: text lines rebuilt from positioned text; large horizontal gaps become column breaks
// ---------------------------------------------------------------------------------------------------
async function readPdf(buffer) {
  const { getDocumentProxy, extractImages } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
  const rows = [], rowsByPage = {};
  for (let p = 1; p <= Math.min(pdf.numPages, 30); p++) {
    const page = await pdf.getPage(p);
    const { items } = await page.getTextContent();
    rowsByPage[p] = items.map(i => i.str).join(' ');
    const lines = [];
    for (const it of items) {
      if (!it.str?.trim()) continue;
      const x = it.transform[4], y = it.transform[5], w = it.width || it.str.length * 4;
      let line = lines.find(l => Math.abs(l.y - y) < 3);
      if (!line) lines.push(line = { y, parts: [] });
      line.parts.push({ x, end: x + w, s: it.str });
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) {
      l.parts.sort((a, b) => a.x - b.x);
      const cells = [];
      let cur = null, lastEnd = -1e9;
      for (const part of l.parts) {
        if (cur === null || part.x - lastEnd > 14) { if (cur !== null) cells.push(cur); cur = part.s; }
        else cur += (part.x - lastEnd > 1.5 && !/\s$/.test(cur) ? ' ' : '') + part.s;
        lastEnd = Math.max(lastEnd, part.end);
      }
      if (cur !== null) cells.push(cur);
      const cleaned = cells.map(clean).filter(Boolean);
      if (cleaned.length) rows.push(cleaned);
    }
  }
  // Pictures of every page (up to 40). A picture repeated on several pages is page furniture: the largest one is
  // the letterhead logo ('header'), the others are badges / footers ('footer', ignored as logo, signature or stamp).
  // A picture on a page that says "Signature" (the approval table) is marked 'approval'. Logo candidates for old
  // callers: page-1 pictures in `images`; whole scanned pages (for OCR) are kept in `allImages` as before.
  const images = [], allImages = [], seen = new Map();
  for (let p = 1; p <= Math.min(pdf.numPages, 40); p++) {
    let list = [];
    try { list = (await extractImages(pdf, p)) || []; } catch { /* pictures are optional */ }
    const pageText = rowsByPage[p] || '';
    for (const img of list) {
      if (!img.width || !img.height || img.width < 40 || img.height < 20) continue;
      const key = crypto.createHash('sha1').update(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength)).digest('hex');
      const had = seen.get(key);
      if (had) { had.pages.push(p); continue; }
      const entry = { buffer: encodePng(img), ext: 'png', width: img.width, height: img.height, where: `page${p}`, page: p, pages: [p], approvalPage: /signature/i.test(pageText) };
      seen.set(key, entry);
    }
  }
  const furniture = [...seen.values()].filter(e => e.pages.length >= 2);
  const letterhead = furniture.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  for (const e of seen.values()) {
    if (e.pages.length >= 2) e.where = e === letterhead ? 'header' : 'footer';
    else if (e.approvalPage && e.page > 1) e.where = 'approval';
    if ((e.page === 1 && e.where !== 'footer') || e.where === 'header') images.push(e);
    if (e.page > 1 || (e.width >= 800 && e.height >= 800)) allImages.push(e); // later pages; whole scanned pages (OCR)
  }
  return { kind: 'pdf', rows, images, allImages };
}

/** Minimal PNG encoder for raw RGB/RGBA/grey pixel data. */
export function encodePng({ data, width, height, channels }) {
  const ch = channels || Math.round(data.length / (width * height));
  const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[ch] ?? 6;
  const raw = Buffer.alloc((width * ch + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * ch + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * ch, width * ch).copy(raw, y * (width * ch + 1) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type), body]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Read a PDF, DOCX or DOC document - or a photo / scan of one (PNG, JPG: its text is read with OCR on this PC). */
export async function readDocument(buffer, name = '') {
  const kind = kindOf(name, buffer);
  if (kind === 'pdf') return readPdf(buffer);
  if (kind === 'docx') return readDocx(buffer);
  if (kind === 'doc') return { ...(await readDocx(await docToDocx(buffer))), kind: 'doc' };
  if (kind === 'png' || kind === 'jpg') {
    const size = imageSize(buffer);
    let lines = [];
    try { const { ocrImage } = await import('./recognize.js'); lines = await ocrImage(buffer, kind); } catch { /* OCR unavailable: pictures only */ }
    return { kind, rows: lines.filter(l => String(l).trim()).map(l => [String(l).trim()]), images: size ? [{ buffer, ...size, where: 'page1' }] : [], allImages: [], ocr: true };
  }
  throw new Error('Unsupported file - upload a PDF, Word (.docx / .doc) document or a photo (PNG / JPG)');
}
