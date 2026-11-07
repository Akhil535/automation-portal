// Lightweight JSON store (data/db.json): run history, processed circulars, review decisions.
import fs from 'node:fs';
import path from 'node:path';
import { dir, replaceFile } from './config.js';

const EMPTY = { meta: {}, runs: [], circulars: {} };

export class Store {
  constructor(cfg) {
    this.file = path.join(dir(cfg, 'data'), 'db.json');
    this.data = fs.existsSync(this.file) ? { ...EMPTY, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) } : structuredClone(EMPTY);
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    replaceFile(tmp, this.file);
  }

  get meta() { return this.data.meta; }

  addRun(run) {
    this.data.runs.unshift(run);
    this.data.runs = this.data.runs.slice(0, 500);
    this.save();
  }

  updateRun(id, fields) {
    const run = this.data.runs.find(r => r.id === id);
    if (run) Object.assign(run, fields);
    this.save();
  }

  /** Insert or update a processed circular. Returns true when it is seen for the first time. */
  upsertCircular(key, fields) {
    const now = new Date().toISOString();
    const existing = this.data.circulars[key];
    if (existing) {
      Object.assign(existing, fields, { lastSeen: now });
      return false;
    }
    this.data.circulars[key] = { key, firstSeen: now, lastSeen: now, ...fields };
    return true;
  }

  circular(key) { return this.data.circulars[key]; }

  circulars() {
    return Object.values(this.data.circulars).sort((a, b) =>
      (b.firstSeen || '').localeCompare(a.firstSeen || '') || (b.date || '').localeCompare(a.date || ''));
  }
}
