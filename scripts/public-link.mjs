// Public link for the portal without a domain:
//   https://<github-user>.github.io/<repo>/  (GitHub Pages, branch gh-pages)  ->  the portal on this PC.
//
// 1. A Cloudflare quick tunnel (cloudflared, no account, no domain) gives the portal on this PC a public
//    https://<random>.trycloudflare.com address. It changes every time the tunnel starts.
// 2. Every time it changes, the small start page on GitHub Pages (index.html + link.json on the gh-pages branch) is
//    updated and pushed, so the github.io link always leads to the running portal.
// 3. If the tunnel stops it is started again; when this script is stopped, the page says "offline".
//
// Run: node scripts/public-link.mjs   (start-public-link.bat; or at log-on via scripts/install-public-link.ps1)
// Nothing secret is published: only the tunnel address. Sign-in (password + 2FA) protects the portal itself.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = path.resolve(APP, '..', 'pages-site'); // git worktree of the gh-pages branch
const LOG = path.join(APP, 'logs', 'public-link.log');
const CLOUDFLARED = ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe'].find(f => fs.existsSync(f)) || 'cloudflared';
const port = (() => { try { return JSON.parse(fs.readFileSync(path.join(APP, 'config.json'), 'utf8')).server?.port || 8080; } catch { return 8080; } })();

fs.mkdirSync(path.dirname(LOG), { recursive: true });
const log = m => { const line = `${new Date().toISOString()} ${m}`; console.log(line); fs.appendFileSync(LOG, `${line}\n`); };
const git = (args, cwd = APP) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).trim();

/** The gh-pages branch checked out next to the project (created on first use, never touching main). */
function ensurePages() {
  if (fs.existsSync(path.join(PAGES, '.git'))) return;
  let remote = false;
  try { remote = !!git(['ls-remote', '--heads', 'origin', 'gh-pages']); } catch { /* offline: create locally */ }
  if (remote) { git(['fetch', 'origin', 'gh-pages:gh-pages']); git(['worktree', 'add', PAGES, 'gh-pages']); }
  else git(['worktree', 'add', '--orphan', '-b', 'gh-pages', PAGES]);
  log(`GitHub Pages folder ready: ${PAGES}`);
}

const stamp = () => new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' (UAE)';
/** Write the start page + link.json and push them to GitHub (only when something changed). */
function publish(url, online) {
  ensurePages();
  const updated = stamp();
  const html = fs.readFileSync(path.join(APP, 'scripts', 'pages-template.html'), 'utf8')
    .split('__PORTAL_URL__').join(url || '').split('__UPDATED__').join(updated).split('__ONLINE__').join(online ? 'true' : 'false');
  fs.writeFileSync(path.join(PAGES, 'index.html'), html);
  fs.writeFileSync(path.join(PAGES, 'link.json'), `${JSON.stringify({ url: url || '', online, updated }, null, 2)}\n`);
  fs.writeFileSync(path.join(PAGES, '.nojekyll'), '');
  git(['add', '-A'], PAGES);
  if (!git(['status', '--porcelain'], PAGES)) return;
  git(['commit', '-q', '-m', online ? `Portal link: ${url}` : 'Portal offline'], PAGES);
  for (let k = 1; k <= 5; k++) {
    try { git(['push', '-q', 'origin', 'gh-pages'], PAGES); log(`GitHub Pages updated (${online ? url : 'offline'})`); return; }
    catch (e) { log(`push failed (try ${k}): ${String(e.stderr || e.message).split('\n')[0]}`); execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 15']); }
  }
}

const reachable = async url => { try { const r = await fetch(`${url}/login.html`, { signal: AbortSignal.timeout(10000) }); return r.ok; } catch { return false; } };

let child = null, stopping = false, current = '';
function startTunnel() {
  log(`starting the tunnel to http://127.0.0.1:${port}`);
  child = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true });
  let found = false;
  const onData = async d => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m || found) return;
    found = true;
    const url = m[0];
    log(`tunnel address: ${url}`);
    for (let i = 0; i < 30 && !(await reachable(url)); i++) await new Promise(r => setTimeout(r, 2000)); // DNS takes a few seconds
    current = url;
    try { publish(url, true); } catch (e) { log(`could not update GitHub Pages: ${e.message}`); }
  };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.on('exit', code => {
    log(`tunnel stopped (code ${code})`);
    if (!stopping) setTimeout(startTunnel, 10000); // started again with a new address
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  try { child?.kill(); } catch { /* already gone */ }
  try { publish(current, false); } catch (e) { log(`could not mark offline: ${e.message}`); }
  process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGBREAK', stop);

// Every 5 minutes: if the address stopped answering, restart the tunnel (a new address is published).
setInterval(async () => { if (current && !stopping && !(await reachable(current))) { log('the address stopped answering – restarting the tunnel'); current = ''; child?.kill(); } }, 5 * 60000);

startTunnel();
