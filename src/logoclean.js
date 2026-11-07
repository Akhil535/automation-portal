// Logo extraction clean-up: choose the picture that is the facility logo, then crop it tightly and remove its plain
// background (scripts/logo-clean.ps1, Windows imaging on this PC - nothing is sent to an external service).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageSize } from './imagesize.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'logo-clean.ps1');

/** A whole scanned page rather than a logo picture. */
export const isPageScan = img => img.width >= 800 && img.height >= 800 && img.height / img.width > 1.15 && img.height / img.width < 1.6;

/**
 * Pick the logo among a document's pictures: the largest one, but wide strips (footer banners, rules) and whole
 * scanned pages only when nothing better exists.
 */
export function pickLogo(images = []) {
  // the letterhead (a picture repeated at the top of the pages) is the logo; badges and footers never are
  const letterhead = images.filter(i => i.where === 'header').sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (letterhead) return letterhead;
  images = images.filter(i => i.where !== 'footer' && i.where !== 'badge');
  const score = img => {
    const aspect = Math.max(img.width, img.height) / Math.max(1, Math.min(img.width, img.height));
    let s = img.width * img.height;
    if (aspect > 7) s *= 0.2;
    if (isPageScan(img)) s *= 0.01;
    if (img.where === 'header' || img.where === 'page1') s *= 1.2;
    return s;
  };
  return images.slice().sort((a, b) => score(b) - score(a))[0] || null;
}

const SPLIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'picture-split.ps1');
/**
 * A picture holding a signature and a stamp side by side, split into the two: { signature, stamp } (transparent
 * PNGs cropped to their ink), or null when it is one thing only (or the analysis is not available).
 */
export async function splitSignStamp(img) {
  if (!img?.buffer || process.platform !== 'win32') return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrp-split-'));
  const src = path.join(tmp, `in.${img.ext || imageSize(img.buffer)?.ext || 'png'}`), prefix = path.join(tmp, 'part');
  try {
    fs.writeFileSync(src, img.buffer);
    const stdout = await new Promise(resolve => execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SPLIT, '-In', src, '-OutPrefix', prefix],
      { timeout: 120000, windowsHide: true }, (err, so) => resolve(err ? '' : so)));
    const r = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');
    if (!r.ok || !r.split) return null;
    const part = f => { const buffer = fs.readFileSync(f), size = imageSize(buffer); return size ? { buffer, ext: 'png', width: size.width, height: size.height } : null; };
    const signature = part(`${prefix}-signature.png`), stamp = part(`${prefix}-stamp.png`);
    return signature && stamp ? { signature, stamp } : null;
  } catch { return null; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

const RESIZE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'image-resize.ps1');
/** Plain resize to at most `max` px on the longest side (PNG, or JPEG on white). Returns the original when it cannot run. */
export async function resizeImage(img, max, { jpeg = false } = {}) {
  if (!img?.buffer || process.platform !== 'win32') return img;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrp-resize-'));
  const src = path.join(tmp, `in.${img.ext || 'png'}`), out = path.join(tmp, jpeg ? 'out.jpg' : 'out.png');
  try {
    fs.writeFileSync(src, img.buffer);
    const stdout = await new Promise(resolve => execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RESIZE, '-In', src, '-Out', out, '-Max', String(max), ...(jpeg ? ['-Jpeg'] : [])],
      { timeout: 120000, windowsHide: true }, (err, so) => resolve(err ? '' : so)));
    const r = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');
    if (!r.ok || !fs.existsSync(out)) return img;
    const buffer = fs.readFileSync(out), size = imageSize(buffer);
    return size ? { ...img, buffer, ext: jpeg ? 'jpg' : 'png', width: size.width, height: size.height } : img;
  } catch { return img; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/**
 * Crop the logo to its content and make its plain background transparent. Whole scanned pages: the logo block is
 * found in the top part of the page. Returns a new { buffer, ext: 'png', width, height, cleaned } or the original
 * picture unchanged when it cannot be improved (or the clean-up is not available).
 */
export async function cleanLogo(img, { max = 0 } = {}) {
  if (!img?.buffer || process.platform !== 'win32') return img;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrp-logo-'));
  const src = path.join(tmp, `in.${img.ext || 'png'}`), out = path.join(tmp, 'out.png');
  try {
    fs.writeFileSync(src, img.buffer);
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, src, out];
    if (isPageScan(img)) args.push('-Mode', 'header');
    if (max > 0) args.push('-Max', String(max)); // print size: smaller files
    const stdout = await new Promise(resolve => execFile('powershell', args, { timeout: 60000, windowsHide: true }, (err, so) => resolve(err ? '' : so)));
    const r = JSON.parse(stdout.trim().split(/\r?\n/).pop() || '{}');
    if (!r.ok || !fs.existsSync(out)) return img;
    const buffer = fs.readFileSync(out);
    const size = imageSize(buffer);
    return size ? { ...img, buffer, ext: 'png', width: size.width, height: size.height, cleaned: { cropped: r.cropped, transparent: r.transparent, resized: !!r.resized, from: `${img.width}x${img.height}` } } : img;
  } catch { return img; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
