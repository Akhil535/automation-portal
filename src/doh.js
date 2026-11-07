// Reads the circular listing from the official DoH website.
//
// /en/resources/Circulars fills its table from /Assets/js/circulars.js, which POSTs
// {itemID, pageNo, pageSize, culture, year, category, keyword} to
// /api/feature/Resources/circulars and gets back a JSON *string* holding
// {Items:[{CircularNo, CircularName, PDF, Date, lstCategories, Year}], TotalRecordCount}.
// We page through the unfiltered list (all years and categories); the page's year
// drop-down is out of date, so it is not relied on. Public data only, polite rate.
import { cleanText, normNumber, parseDate } from './normalize.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DoH-Circular-Portal/1.0';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class DohClient {
  constructor(site, register, log = () => {}) {
    this.site = site;
    this.sep = register.categorySeparator || '; ';
    this.base = site.baseUrl.replace(/\/$/, '');
    this.itemId = site.itemId;
    this.log = log;
  }

  async request(url, opts = {}, attempt = 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (this.site.timeoutSeconds || 60) * 1000);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'en', ...opts.headers } });
      if ([429, 500, 502, 503, 504].includes(res.status)) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) { const e = new Error(`HTTP ${res.status} for ${url}`); e.fatal = true; throw e; }
      return res;
    } catch (err) {
      const retries = this.site.retries ?? 3;
      if (err.fatal || attempt > retries) throw new Error(`${err.message}${err.cause ? ` (${err.cause.code || err.cause.message})` : ''}`);
      await sleep(2000 * 2 ** (attempt - 1));
      return this.request(url, opts, attempt + 1);
    } finally {
      clearTimeout(timer);
    }
  }

  async discoverItemId() {
    try {
      const html = await (await this.request(this.base + this.site.listingPage)).text();
      const m = html.match(/value="(\{[0-9A-Fa-f-]{36}\})"\s+id="hdnCirculars"/) || html.match(/id="hdnCirculars"\s+value="(\{[0-9A-Fa-f-]{36}\})"/);
      if (m) this.itemId = m[1];
    } catch (e) {
      this.log(`Listing page not reachable (${e.message}); using configured itemID`);
    }
  }

  async page(pageNo, pageSize, year = '') {
    const body = { itemID: this.itemId, pageNo, pageSize, culture: this.site.culture || 'en', year: String(year || ''), category: '', keyword: '' };
    const res = await this.request(this.base + this.site.apiPath, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest', Referer: this.base + this.site.listingPage },
    });
    let data = await res.text();
    for (let i = 0; i < 3 && typeof data === 'string'; i++) data = JSON.parse(data.replace(/^﻿/, ''));
    if (!data || !Array.isArray(data.Items)) throw new Error(`Unexpected response from DoH data endpoint (page ${pageNo})`);
    return data;
  }

  toCircular(it) {
    const cats = (Array.isArray(it.lstCategories) ? it.lstCategories : [it.lstCategories]).map(cleanText).filter(Boolean);
    const pdf = cleanText(it.PDF || it.Link || '');
    return {
      number: cleanText(it.CircularNo), name: cleanText(it.CircularName),
      date: parseDate(it.Date), dateText: cleanText(it.Date),
      categories: cats, category: cats.join(this.sep),
      url: pdf ? new URL(pdf, this.base + '/').href : '',
    };
  }

  async collect(year = '') {
    const size = this.site.pageSize || 50;
    const first = await this.page(1, size, year);
    const items = [...first.Items];
    const total = Number(first.TotalRecordCount) || null;
    const perPage = first.Items.length || size;
    const pages = total ? Math.ceil(total / perPage) : 1;
    this.log(`${year || 'All years'}: ${total ?? '?'} circulars reported, ${pages} page(s)`);
    for (let p = 2; p <= pages; p++) {
      await sleep(this.site.delayMs ?? 800);
      const d = await this.page(p, size, year);
      if (!d.Items.length) break;
      items.push(...d.Items);
    }
    return { items, total };
  }

  /**
   * Recent circulars only: the listing (newest first) is read page by page and reading stops after the first page
   * whose circulars are all older than `cutoff` (YYYY-MM-DD). Returns { circulars, total, complete, recentOnly, pages }.
   */
  async fetchRecent(cutoff) {
    this.log(`Contacting the DoH website (recent circulars since ${cutoff})...`);
    await this.discoverItemId();
    const size = this.site.pageSize || 50;
    const items = [];
    let total = null, p = 0;
    for (p = 1; p <= 60; p++) {
      if (p > 1) await sleep(this.site.delayMs ?? 800);
      const d = await this.page(p, size, '');
      if (p === 1) total = Number(d.TotalRecordCount) || null;
      if (!d.Items.length) break;
      items.push(...d.Items);
      const dates = d.Items.map(i => this.toCircular(i).date).filter(Boolean);
      if (dates.length && dates.every(x => x < cutoff)) break;
      if (total && items.length >= total) break;
    }
    this.log(`Recent circulars: read ${p} page(s) (${items.length} of ${total ?? '?'} listed) - older archived circulars skipped`);
    return { ...this.dedupe(items), total, complete: true, recentOnly: true, pages: p };
  }

  dedupe(items) {
    const seen = new Set();
    const circulars = [];
    for (const c of items.map(i => this.toCircular(i))) {
      if (!c.number && !c.name) continue;
      const k = `${normNumber(c.number)}|${c.name.toLowerCase()}|${c.url.toLowerCase()}`;
      if (!seen.has(k)) { seen.add(k); circulars.push(c); }
    }
    return { circulars };
  }

  /** Returns { circulars, total, complete }. */
  async fetchAll() {
    this.log('Contacting the DoH website (official circulars data endpoint)...');
    await this.discoverItemId();
    let { items, total } = await this.collect();
    let complete = !total || items.length >= total;
    if (!complete) {
      this.log(`Listing returned ${items.length} of ${total}; sweeping year by year`);
      for (let y = new Date().getFullYear(); y >= 2010; y--) items.push(...(await this.collect(y)).items);
      complete = true;
    }
    const seen = new Set();
    const circulars = [];
    for (const c of items.map(i => this.toCircular(i))) {
      if (!c.number && !c.name) continue;
      const k = `${normNumber(c.number)}|${c.name.toLowerCase()}|${c.url.toLowerCase()}`;
      if (!seen.has(k)) { seen.add(k); circulars.push(c); }
    }
    return { circulars, total, complete };
  }

  /** Download a circular document. Returns { buffer, kind }. */
  async download(url) {
    const res = await this.request(url, { headers: { Referer: this.base + this.site.listingPage } });
    const buffer = Buffer.from(await res.arrayBuffer());
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const kind = buffer.subarray(0, 5).toString() === '%PDF-' || type.includes('pdf') ? 'pdf' : type.includes('html') ? 'html' : 'other';
    return { buffer, kind };
  }
}
