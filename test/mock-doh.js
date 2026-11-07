// Local stand-in for the DoH Circulars website (same interface as the real one), for tests only.
import http from 'node:http';

export const ITEM_ID = '{11111111-2222-3333-4444-555555555555}';
const MAX_PAGE = 20; // server caps page size; the client must still collect everything

export function makePdf(text) {
  const lines = [];
  let cur = '';
  for (const w of text.split(/\s+/)) { if ((cur + w).length > 90) { lines.push(cur); cur = ''; } cur += (cur ? ' ' : '') + w; }
  lines.push(cur);
  const e = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 10 Tf 40 800 Td 13 TL ${lines.map(l => `(${e(l)}) '`).join(' ')} ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function startMock(items) {
  const state = { items, fail: '', apiCalls: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const send = (code, data, type = 'text/html; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type }); res.end(data); };
      const p = req.url.split('?')[0];
      if (state.fail === 'all') return send(503, 'Service Unavailable');
      if (req.method === 'GET' && p.toLowerCase() === '/en/resources/circulars') {
        return send(200, `<html><input type="hidden" value="${ITEM_ID}" id="hdnCirculars" /></html>`);
      }
      if (req.method === 'GET' && p.startsWith('/-/media/')) {
        const it = state.items.find(i => i.PDF === p);
        if (!it || it._broken) return send(404, 'Not found');
        return send(200, makePdf(it._text || it.CircularName), 'application/pdf');
      }
      if (req.method === 'POST' && p.toLowerCase() === '/api/feature/resources/circulars') {
        if (state.fail === 'api') return send(500, 'Internal Server Error');
        const b = JSON.parse(body);
        state.apiCalls++;
        const empty = { Items: [], PageNo: 1, PageSize: 10, TotalRecordCount: 0 };
        if (b.itemID !== ITEM_ID) return send(200, JSON.stringify(JSON.stringify(empty)), 'application/json');
        let list = [...state.items].sort((a, c) => c._date.localeCompare(a._date));
        if (b.year) list = list.filter(i => i._date.startsWith(String(b.year)));
        const size = Math.min(Number(b.pageSize) || 10, MAX_PAGE), page = Math.max(1, Number(b.pageNo) || 1);
        const Items = list.slice((page - 1) * size, page * size).map(i => Object.fromEntries(Object.entries(i).filter(([k]) => !k.startsWith('_'))));
        return send(200, JSON.stringify(JSON.stringify({ Items, PageNo: page, PageSize: size, TotalRecordCount: list.length })), 'application/json; charset=utf-8');
      }
      send(404, 'Not found');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` })));
}
