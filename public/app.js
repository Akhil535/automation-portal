// Legal Register Portal - front end (vanilla JS, no build step). Multi-facility: every facility-scoped request
// carries ?f=<facility id> for the facility chosen in the sidebar.
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let facility = store.get('facility') || '';
let facilities = [];
const u = p => facility ? `${p}${p.includes('?') ? '&' : '?'}f=${encodeURIComponent(facility)}` : p;
async function call(url, opts = {}, scoped = true) {
  const res = await fetch(scoped ? u(url) : url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (res.status === 401) { location.replace('/login.html'); throw new Error('Please sign in'); } // session ended
  if (!res.ok) throw new Error(data.error || data || res.statusText);
  return data;
}
const api = (url, opts) => call(url, opts, true);
const apiGlobal = (url, opts) => call(url, opts, false);
const fmt = iso => iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const fmtDay = iso => ISO.test(iso || '') ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }) : (iso || '');
const hval = v => (v && typeof v === 'object' ? v.date : v) ?? '';
// Schedules are "m h * * d" (d = 0-6 weekday, or * for every day).
const cronToTime = c => { const m = /^(\d+) (\d+) \* \* (\*|[0-6])$/.exec(c || ''); return m ? `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}` : ''; };
const cronDay = c => (/^\d+ \d+ \* \* (\*|[0-6])$/.exec(c || '') || [])[1] ?? '0';
const timeToCron = (t, day = '*') => { const [h, m] = (t || '02:00').split(':').map(Number); return `${m} ${h} * * ${day}`; };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const scheduleText = c => { const d = cronDay(c), t = cronToTime(c); return d === '*' ? `Daily ${t}` : `Weekly · ${DAYS[+d]} ${t}`; };
const isIt = c => c.decision === 'it_related' || c.decision === 'it_review';
const statusLabel = o => /^fully/i.test(o) ? 'Fully Compliant' : o;
const tagFor = (st, label) => `<span class="tag ${({ success: 'ok', no_changes: 'ok', check_only: 'na', failed: 'bad' })[st] || 'warn'}">${esc(label || st)}</span>`;

let circulars = [], filter = 'all', wasRunning = false, status = null, master = null, refreshTimer = null;

// ===================================================================================================
// Facilities
// ===================================================================================================
let template = null; // the master template facility (administrators only; hidden from the facility list)
let templateOpen = false; // the template is only worked on when an administrator opens it on purpose
const onTemplate = () => !!template && facility === template.id;
async function loadFacilities() {
  const r = await apiGlobal('/api/facilities');
  facilities = r.list;
  template = r.template || null;
  if (!facilities.some(f => f.id === facility) && !(templateOpen && onTemplate())) facility = r.default || '';
  store.set('facility', facility);
  const opts = [...facilities, ...(onTemplate() ? [template] : [])];
  $('#facility-select').innerHTML = opts.map(f => `<option value="${esc(f.id)}"${f.id === facility ? ' selected' : ''}>${esc(f.code)} – ${esc(f.name)}</option>`).join('');
  // New registers are copied from the master template first, then from any facility.
  $('#add-template').innerHTML = [...(template ? [template] : []), ...facilities].map(f => `<option value="${esc(f.id)}"${f.id === (template?.id || r.default) ? ' selected' : ''}>${f.isTemplate ? '★ Master template' : `${esc(f.code)} – ${esc(f.name)}`}</option>`).join('');
  renderSwitcher(); renderTemplateCard(r);
  document.body.classList.toggle('no-fac', !facility);
  document.body.classList.toggle('on-template', onTemplate());
  $('#tpl-banner').hidden = !onTemplate();
  if (onTemplate()) $('#tpl-name').textContent = 'the baseline for every new facility';
  if (!facility) {
    $('#side-fac-name').textContent = 'No facility yet'; $('#side-fac-code').textContent = me?.role !== 'viewer' ? 'Create one to start' : 'Ask an administrator';
    $('#nofac-title').textContent = me?.role !== 'viewer' ? 'Create your first facility' : 'No facility assigned yet';
    $('#nofac-text').textContent = me?.role !== 'viewer'
      ? 'Facilities you add appear here – only you (and the administrators) can see them. Start with the policy pack: the ADHICS policies are prepared for the new facility from the master template, then its LEGAL REGISTER is created.'
      : 'Your account is active, but no facility has been assigned to it yet. Ask an administrator to give you access to your facility.';
    const cur = $('#tabs button.active')?.dataset.tab;
    if (cur !== 'admin') showTab('nofac');
  } else if ($('#nofac').classList.contains('active')) showTab('overview');
  $('#fac-tbl tbody').innerHTML = facilities.map(f => `<tr>
    <td><img class="fac-mini" src="/api/facility-logo?f=${encodeURIComponent(f.id)}" alt="" onerror="this.style.visibility='hidden'"></td>
    <td><b>${esc(f.name)}</b><br><span class="muted small">${esc(f.code)}${f.isDefault ? ' · default' : ''}${f.id === facility ? ' · selected' : ''}${f.createdBy ? ` · created by ${esc(f.createdBy)}` : ''}</span></td>
    <td>${healthBar(f.health)}</td>
    <td class="small">${f.lock ? `<span class="tag warn">${esc(f.lock)}</span>` : '<span class="tag ok">Ready</span>'}</td>
    <td class="num">${f.lastSuccess ? fmt(f.lastSuccess) : 'Never'}</td><td>${f.lastStatus ? tagFor(f.lastStatusCode, f.lastStatus) : '–'}</td>
    <td><div class="row-actions">
      ${f.id === facility ? '' : `<button class="icon-btn" data-open="${esc(f.id)}">Open</button>`}
      <button class="icon-btn" data-write data-edit="${esc(f.id)}">Edit</button>
      <button class="icon-btn del" data-admin data-del="${esc(f.id)}" ${f.isDefault ? 'disabled title="The default facility cannot be removed"' : ''}>Delete</button>
    </div></td></tr>`).join('');
  $$('#fac-tbl [data-open]').forEach(b => b.onclick = () => selectFacility(b.dataset.open));
  $$('#fac-tbl [data-edit]').forEach(b => b.onclick = () => { selectFacility(b.dataset.edit); showTab('settings'); });
  $$('#fac-tbl [data-del]').forEach(b => b.onclick = () => removeFacility(b.dataset.del));
}

/** Stacked bar + counts of a facility's register entries by status. */
function healthBar(h) {
  if (!h || !h.total) return '<span class="muted small">–</span>';
  const seg = (k, cls) => h[k] ? `<i class="${cls}" style="flex:${h[k]}" title="${h[k]} ${STATUS[k][0].toLowerCase()}"></i>` : '';
  const none = (h.missing || 0) + (h['no-expiry'] || 0);
  return `<div class="hbar">${seg('valid', 'ok')}${seg('expiring', 'warn')}${seg('expired', 'bad')}${seg('no-expiry', 'missing')}${seg('missing', 'missing')}</div>
    <div class="hcount"><span class="ok">${h.valid} valid</span>${h.expiring ? ` · <span class="warn">${h.expiring} expiring</span>` : ''}${h.expired ? ` · <span class="bad">${h.expired} expired</span>` : ''}${none ? ` · <span class="muted">${none} without dates</span>` : ''}</div>`;
}

function selectFacility(id) {
  facility = id;
  templateOpen = !!template && id === template.id;
  pwStep = null; // the policies wizard starts at the new facility's first open step
  store.set('facility', id);
  $('#facility-select').value = id;
  circulars = []; master = null;
  loadFacilities();
  refresh();
  const active = $('#tabs button.active')?.dataset.tab;
  loaders[active]?.();
}
$('#facility-select').onchange = e => selectFacility(e.target.value);

/** Sidebar facility switcher: a card with the current facility and a searchable list. */
function renderSwitcher() {
  const q = ($('#fs-search').value || '').trim().toLowerCase();
  const row = f => {
    const h = f.health, bad = h ? (h.expired || 0) : 0, warn = h ? (h.expiring || 0) : 0;
    const dot = !h?.total ? 'na' : bad ? 'bad' : warn ? 'warn' : 'ok';
    return `<div class="fs-row"><button type="button" role="option" class="fs-item${f.id === facility ? ' on' : ''}${f.isTemplate ? ' tpl' : ''}" data-fid="${esc(f.id)}" aria-selected="${f.id === facility}">
      <span class="fs-ilogo"><img src="/api/facility-logo?f=${encodeURIComponent(f.id)}" alt="" onerror="this.remove()"><i>${esc(String(f.code).slice(0, 2))}</i></span>
      <span class="fs-itext"><b>${f.isTemplate ? 'Master template' : esc(f.name)}</b><small>${f.isTemplate ? '★ baseline for new facilities' : esc(f.code)}</small></span>
      ${f.isTemplate ? '' : `<span class="fs-dot ${dot}" title="${!h?.total ? 'No register entries yet' : `${bad} expired · ${warn} expiring`}"></span>`}</button>
      ${f.isTemplate || f.isDefault ? '' : `<button type="button" class="fs-del" data-admin data-del-fac="${esc(f.id)}" title="Remove ${esc(f.name)}" aria-label="Remove ${esc(f.name)}"><svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7zm4 2v8h2v-8zm4 0v8h2v-8z"/></svg></button>`}</div>`;
  };
  const hit = f => !q || `${f.name} ${f.code}`.toLowerCase().includes(q);
  const list = facilities.filter(hit);
  $('#fs-list').innerHTML = (list.length ? list.map(row).join('') : `<p class="fs-empty">${facilities.length ? 'No facility matches' : 'No facilities yet'}</p>`)
    + (template && hit(template) ? `<div class="fs-sep">Admin only</div>${row({ ...template, isTemplate: true })}` : '');
  $('#fs-search').hidden = facilities.length < 6;
  $$('#fs-list [data-fid]').forEach(b => b.onclick = () => { fsOpen(false); if (b.dataset.fid !== facility) selectFacility(b.dataset.fid); });
  $$('#fs-list [data-del-fac]').forEach(b => b.onclick = e => { e.stopPropagation(); fsOpen(false); removeFacility(b.dataset.delFac); });
}
function fsOpen(on = $('#fs-pop').hidden) {
  $('#fs-pop').hidden = !on; $('#fs-btn').setAttribute('aria-expanded', on); $('#fs').classList.toggle('open', on);
  if (on) { $('#fs-search').value = ''; renderSwitcher(); if (!$('#fs-search').hidden) $('#fs-search').focus(); }
}
$('#fs-btn').onclick = e => { e.stopPropagation(); fsOpen(); };
$('#fs-search').oninput = renderSwitcher;
document.addEventListener('click', e => { if (!$('#fs-pop').hidden && !e.target.closest('#fs')) fsOpen(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#fs-pop').hidden) fsOpen(false); });
const newFacilityPack = async () => { fsOpen(false); if (window.canAddFacility && !(await canAddFacility())) return; if (!pp) await loadPolicies().catch(() => {}); npOpen(); };
$('#fs-new').onclick = newFacilityPack;
$('#nofac-new').onclick = newFacilityPack;
$('#nofac-excel').onclick = () => $('#btn-add-facility').click();
$('#tpl-leave').onclick = () => { facility = ''; loadFacilities().then(() => { if (facility) selectFacility(facility); }); };

/** Admin console → Facilities: the master template card. */
function renderTemplateCard(r) {
  let box = $('#tpl-card');
  if (!box) { box = document.createElement('div'); box.id = 'tpl-card'; $('#adm-facilities')?.prepend(box); }
  if (me?.role !== 'admin') { box.innerHTML = ''; return; }
  const t = template;
  box.className = 'panel tpl-card';
  box.innerHTML = t ? `<span class="tpl-star big">★</span>
      <div class="tpl-main"><span class="adm-kicker">Master template</span><h2>Master template <span class="muted small">built from the documents of ${esc(t.name)} (${esc(t.code)})</span></h2>
      <p class="muted small">New facilities copy their LEGAL REGISTER and policy pack from this template. It is hidden from the facility list, users cannot open it, and it is not monitored or e-mailed.</p></div>
      <div class="btn-row"><button type="button" class="btn primary small" id="tpl-open">Open the template</button><button type="button" class="btn small" id="tpl-clear">Make it a normal facility</button></div>`
    : `<div class="tpl-main"><span class="adm-kicker">Master template</span><h2>No master template set</h2>
      <p class="muted small">Pick the facility you prepared as the template. It is then hidden from the facility list and new facilities are copied from it.</p></div>
      <div class="btn-row"><select id="tpl-pick">${facilities.map(f => `<option value="${esc(f.id)}">${esc(f.code)} – ${esc(f.name)}</option>`).join('')}</select><button type="button" class="btn primary small" id="tpl-set"${facilities.length ? '' : ' disabled'}>Use as master template</button></div>`;
  const setTpl = async id => { await apiGlobal('/api/facilities-template', { method: 'PUT', body: JSON.stringify({ id }) }); await loadFacilities(); refresh(); };
  if ($('#tpl-open')) $('#tpl-open').onclick = () => selectFacility(t.id);
  if ($('#tpl-clear')) $('#tpl-clear').onclick = () => confirm(`Show ${t.name} as a normal facility again (listed, monitored and e-mailed)?`) && setTpl(null).catch(e => alert(e.message));
  if ($('#tpl-set')) $('#tpl-set').onclick = () => setTpl($('#tpl-pick').value).catch(e => alert(e.message));
}

async function removeFacility(id) {
  const f = facilities.find(x => x.id === id);
  if (!f) return;
  if (!confirm(`Remove ${f.name} (${f.code})?\n\nIt disappears from the portal with its LEGAL REGISTER, policies and documents.\nNothing is erased: everything is kept and can be restored (Admin console → Facilities → Recently removed).`)) return;
  try {
    const r = await apiGlobal(`/api/facilities/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (facility === id) facility = '';
    await loadFacilities(); refresh();
    const undo = r.restorable ? r.archived.split(/[\\/]/).pop() : null;
    toast(`<b>${esc(f.name)}</b> was removed.`, undo ? { label: 'Undo', run: () => restoreRemoved(undo) } : null);
    loadRemoved();
  } catch (e) { alert(`Not removed: ${e.message}`); }
}
async function restoreRemoved(archive) {
  try {
    const r = await apiGlobal(`/api/facilities-removed/${encodeURIComponent(archive)}/restore`, { method: 'POST', body: '{}' });
    await loadFacilities(); selectFacility(r.restored);
    toast(`<b>${esc(r.name)}</b> is back.`);
    loadRemoved();
  } catch (e) { alert(`Not restored: ${e.message}`); }
}
/** Admin console → Facilities: recently removed facilities, with Restore. */
async function loadRemoved() {
  if (me?.role !== 'admin') return;
  let box = $('#removed-card');
  if (!box) { box = Object.assign(document.createElement('div'), { id: 'removed-card', className: 'panel removed-card' }); $('#adm-facilities')?.append(box); }
  let list = [];
  try { ({ list } = await apiGlobal('/api/facilities-removed')); } catch { /* not available */ }
  box.hidden = !list.length;
  box.innerHTML = `<h2>Recently removed <span class="muted small">kept on disk · restore puts the facility back with its register, policies and documents</span></h2>
    <div class="rm-list">${list.map(x => `<div class="rm-row"><div><b>${esc(x.name)}</b> <span class="muted small">${esc(x.code)}${x.removedAt ? ` · removed ${fmt(x.removedAt)}` : ''}</span></div>
      ${x.clash ? '<span class="muted small">a facility with this code exists</span>' : `<button type="button" class="btn small" data-restore="${esc(x.archive)}">↺ Restore</button>`}</div>`).join('')}</div>`;
  box.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => restoreRemoved(b.dataset.restore));
}
/** Small message at the bottom of the screen, with an optional action (e.g. Undo). */
function toast(html, action = null) {
  let t = $('#toast');
  if (!t) { t = Object.assign(document.createElement('div'), { id: 'toast', className: 'toast' }); t.setAttribute('role', 'status'); document.body.append(t); }
  t.innerHTML = `<span>${html}</span>${action ? '<button type="button" class="btn small primary" id="toast-act"></button>' : ''}<button type="button" class="toast-x" aria-label="Close">✕</button>`;
  if (action) { $('#toast-act').textContent = action.label; $('#toast-act').onclick = () => { t.classList.remove('on'); action.run(); }; }
  t.querySelector('.toast-x').onclick = () => t.classList.remove('on');
  t.classList.add('on');
  clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove('on'), action ? 12000 : 5000);
}
$('#btn-fac-delete').onclick = () => removeFacility(facility);

// ===================================================================================================
// Header (document control) and shared lists
// ===================================================================================================
function renderHeader(s) {
  const d = s.documentControl || {};
  $('#doc-title').textContent = d.facilityTitle || 'LEGAL REGISTER';
  document.title = d.facilityTitle || 'Compliance Portal';
  const tplOpen = typeof onTemplate === 'function' && onTemplate();
  if (tplOpen) document.title = 'Master template – Compliance Portal';
  $('#side-fac-name').textContent = tplOpen ? 'Master template' : (s.facility?.name || '');
  $('#side-fac-code').textContent = tplOpen ? 'Baseline for every new facility' : (s.facility?.code ? `${s.facility.code}${s.fixed?.numberSuffix || ''}` : '');
  $('#doc-class').textContent = s.fixed?.classification || '';
  $('#doc-strip').innerHTML = $('#home-doc').innerHTML = [['Document Number', d.documentNumber], ['Date of Release', fmtDay(d.releaseDate)], ['Approver', d.approver],
    ['Author(s)', d.authors], ['Version', d.version]].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v || '–')}</dd></div>`).join('');
  $('#band-title').textContent = d.facilityTitle || s.facility?.name || 'LEGAL REGISTER';
  $('#band-class').textContent = s.fixed?.classification || '';
  const people = [...new Set([...(s.branch?.responsibleOptions || []), s.branch?.responsible, s.itDepartment].filter(Boolean))];
  $('#resp-options').innerHTML = people.map(p => `<option value="${esc(p)}">`).join('');
  const opts = (s.complianceOptions || []).map(o => `<option value="${esc(o)}">${esc(statusLabel(o))}</option>`).join('');
  if (!$('#rv-compliance').options.length) $('#rv-compliance').innerHTML = opts;
  $$('.fac-name').forEach(e => { e.textContent = s.facility?.name ? `– ${s.facility.name}` : ''; });
  $('#num-suffix').textContent = $('#add-suffix').textContent = s.fixed?.numberSuffix || ' / LGL REGISTER';
  const logoSrc = u(`/api/facility-logo?v=${encodeURIComponent((s.facility?.id || '') + (d.releaseDate || '') + (d.facilityTitle || ''))}`);
  const img = $('#fac-logo');
  if (img.dataset.src !== logoSrc) {
    img.dataset.src = logoSrc;
    img.onload = () => { img.hidden = false; $('#logo-fallback').hidden = true; };
    img.onerror = () => { img.hidden = true; $('#logo-fallback').hidden = false; };
    img.src = logoSrc;
    const bl = $('#band-logo');
    bl.onload = () => { bl.hidden = false; $('#band-logo-fallback').hidden = true; };
    bl.onerror = () => { bl.hidden = true; $('#band-logo-fallback').hidden = false; };
    bl.src = logoSrc;
  }
  $('#qa-excel').href = u('/api/register/download');
  $('#lnk-download').href = u('/api/register/download');
  $('#lnk-export').href = u('/api/master/export');
}

// ===================================================================================================
// Navigation
// ===================================================================================================
const loaders = { overview: () => { if (!master) loadMaster(); }, policies: () => loadPolicies(), master: () => loadMaster(), circulars: () => loadCirculars(), settings: () => loadSettings(), exports: () => loadExports(), hr: () => loadHr(), thirdparty: () => loadThirdParty() };

/** Export hub: every download of the current facility on one page. */
async function loadExports() {
  const fac = facilities.find(f => f.id === facility) || template;
  $('#ex-fac').textContent = fac ? `${fac.name} (${fac.code})` : 'this facility';
  $('#ex-reg-xlsx').href = $('#ex-doh-xlsx').href = u('/api/register/download');
  $('#ex-reg-print').href = u('/api/master/export');
  $('#ex-hr-xlsx').href = u('/api/hr/checklist.xlsx'); $('#ex-hr-zip').href = u('/api/hr/zip'); $('#ex-hr-word').href = u('/api/hr/zip?type=word');
  const r = status?.lastRun?.report;
  $('#ex-doh-report').hidden = !r; if (r) $('#ex-doh-report').href = u(`/reports/${encodeURIComponent(r)}`);
  $('#ex-doh-sub').textContent = status?.register?.records != null ? `${status.register.records} circulars recorded${status.lastSuccess ? ` · checked ${fmt(status.lastSuccess)}` : ''}` : 'Recorded in the Excel register';
  try {
    const p = await api('/api/policies');
    const n = p.files.word.length, has = n > 0;
    $('#ex-pol-sub').textContent = has ? `${n} Word + ${p.files.pdf.length} PDF files${p.lastGenerated ? ` · ${fmt(p.lastGenerated.at)}` : ''}` : 'Not created yet';
    $('#ex-pol-all').href = u('/api/policies/zip?type=all'); $('#ex-pol-word').href = u('/api/policies/zip?type=word'); $('#ex-pol-pdf').href = u('/api/policies/zip?type=pdf');
    $$('#ex-pol-all, #ex-pol-word, #ex-pol-pdf').forEach(a => a.classList.toggle('disabled', !has));
    $('#ex-pol-go').hidden = has;
  } catch (e) { $('#ex-pol-sub').textContent = e.message; }
  loadPack();
}
$('#ex-reg-pdf').onclick = () => openExport();
$('#ex-pol-go').onclick = () => showTab('policies');
function showTab(name, adm) {
  if (!facility && name !== 'admin') name = 'nofac'; // nothing to work on yet
  if (name === 'admin') adm = adm || currentAdm || 'masters';
  $$('#tabs button').forEach(x => x.classList.toggle('active', x.dataset.tab === name && (!x.dataset.adm || x.dataset.adm === adm)));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === name));
  window.scrollTo({ top: 0 });
  const btn = $(`#tabs button[data-tab="${name}"]${adm ? `[data-adm="${adm}"]` : ''}`);
  if (btn) $('#mb-title').textContent = [...btn.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
  else if (name === 'nofac') $('#mb-title').textContent = 'Get started';
  document.body.classList.remove('menu-open'); // phone: the side menu closes after choosing a page
  renderFlow(); // "You are here" follows the page
  if (name === 'admin') return showAdmin(adm);
  loaders[name]?.();
}
$$('#tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab, b.dataset.adm));

// ---------------------------------------------------------------------------------------------------
// Admin console (administrators): master policies, facilities, users & security, schedule & e-mail, history & logs.
// The existing panels are moved here, so every button and form keeps working exactly as before.
// ---------------------------------------------------------------------------------------------------
let currentAdm = 'masters';
const ADM = {
  masters: ['Policy templates', 'The locked master policies used for every facility: versions 1.0 / 2.0, view, edit, upload and lock.', () => loadPolicies()],
  facilities: ['Facilities', 'Every facility in this portal and the health of its register. Open one to work on it.', () => { loadFacilities(); loadRemoved(); }],
  users: ['Users & access', 'Who can sign in, their role and facilities, and two-factor authentication.', () => loadUsersPanel()],
  schedule: ['Schedule & email', 'When DoH is checked, the e-mail server and alert recipients, the compliance rules, and the AI assistant.', () => { loadSettings(); renderAiSettings(); }],
  logs: ['Activity log', 'Every DoH check with its result, and the portal activity log.', () => { loadRuns(); loadLog(); }],
};
(function buildAdmin() {
  const move = (el, to, title) => {
    if (!el) return;
    if (title) $(to).insertAdjacentHTML('beforeend', `<h2 class="adm-h2">${title}</h2>`);
    $(to).appendChild(el);
    el.classList.add('active');
  };
  move($('#pp-tpl-body')?.closest('.panel'), '#adm-masters');
  move($('#fac-tbl')?.closest('.panel'), '#adm-facilities');
  move($('#users-panel'), '#adm-users');
  move($('#settings-form'), '#adm-schedule');
  move($('#history-panel'), '#adm-logs', 'DoH check history');
  move($('#log-panel'), '#adm-logs', 'Activity log');
})();
function showAdmin(key) {
  currentAdm = key;
  const [title, sub, load] = ADM[key];
  $('#adm-title').textContent = title;
  $('#adm-sub').textContent = sub;
  $$('#admin .adm').forEach(d => { d.hidden = d.id !== `adm-${key}`; });
  load();
}
// Side menu on small screens
$('#sb-burger').onclick = () => document.body.classList.toggle('menu-open');
$('#sb-scrim').onclick = () => document.body.classList.remove('menu-open');
const subLoaders = { 'history-panel': () => loadRuns(), 'log-panel': () => loadLog() };
function showSub(name) {
  $$('#subtabs button').forEach(x => x.classList.toggle('active', x.dataset.sub === name));
  $$('#settings .sub').forEach(t => t.classList.toggle('active', t.id === name));
  subLoaders[name]?.();
}
$$('#subtabs button').forEach(b => b.onclick = () => showSub(b.dataset.sub));
// Drop-down menus (user menu, "More"): close when clicking elsewhere or choosing an item.
document.addEventListener('click', e => $$('details.menu[open]').forEach(d => { if (!d.contains(e.target) || e.target.closest('.menu-pop')) d.open = false; }));
$('#menu-account').onclick = () => { showTab('settings'); showSub('account-panel'); };

// ===================================================================================================
// Overview
// ===================================================================================================
async function refresh() {
  clearTimeout(refreshTimer);
  if (!facility) return; // no facility yet: nothing to show
  let s;
  try { s = await api('/api/status'); } catch (e) { $('#alerts').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; refreshTimer = setTimeout(refresh, 10000); return; }
  status = s; renderHeader(s); renderHome(s);
  if (!master && !masterLoading && s.register?.path && !s.register?.error) loadMaster();
  $('#c-records').textContent = s.register.records ?? '–';
  $('#c-records-sub').textContent = s.register.latest ? `Latest: ${s.register.latest}` : (s.register.error || '');
  $('#c-new').textContent = s.lastRun ? `${s.lastRun.newCount ?? 0}` : '–';
  $('#c-new-sub').textContent = s.lastRun ? `${s.lastRun.added ?? 0} added · ${s.lastRun.filled ?? 0} completed` : '';
  $('#c-review').textContent = s.itItems ?? 0;
  $('#last-run-fac').textContent = s.facility?.name ? `– ${s.facility.name}` : '';

  const alerts = [];
  if (s.register.error) alerts.push(`<div class="alert bad">${esc(s.register.error)}</div>`);
  if (s.register.lock) alerts.push(`<div class="alert warn">${esc(s.register.lock)} – updates wait until it is closed.</div>`);
  if (s.register.blankMetadata) alerts.push(`<div class="alert warn">${s.register.blankMetadata} register row(s) have blank F–J; the next run completes them.</div>`);
  if (s.awaitingApproval) alerts.push(`<div class="alert warn">${s.awaitingApproval} circular(s) waiting (safety limit or locked register).</div>`);
  if (s.conflicts) alerts.push(`<div class="alert warn">${s.conflicts} circular(s) held: number already in the register with a different title.</div>`);
  $('#alerts').innerHTML = alerts.join('');
  $('#btn-force').hidden = !s.awaitingApproval;

  const r = s.lastRun;
  $('#last-run').innerHTML = r ? `<dl class="kv">
    <dt>Started</dt><dd>${fmt(r.started)} (${esc(r.trigger)})</dd>
    <dt>Status</dt><dd>${tagFor(r.status, r.statusLabel)}</dd>
    <dt>Checked on DoH</dt><dd>${r.totalChecked} (in scope ${r.inScope})</dd>
    <dt>New / added</dt><dd>${r.newCount} / ${r.added}${r.rows?.length ? ` (rows ${r.rows[0]}–${r.rows.at(-1)})` : ''}</dd>
    <dt>F–J completed</dt><dd>${r.filled || 0}</dd>
    ${r.errors?.length ? `<dt>Errors</dt><dd style="color:var(--bad)">${r.errors.map(esc).join('<br>')}</dd>` : ''}
    ${r.report ? `<dt>Report</dt><dd><a href="${u(`/reports/${encodeURIComponent(r.report)}`)}" target="_blank">Open report ↗</a></dd>` : ''}</dl>` : 'No runs yet.';

  const running = !!s.running;
  ['#btn-run', '#btn-run-all', '#btn-check', '#btn-force'].forEach(id => { $(id).disabled = running; });
  $('#run-state').textContent = running ? `Running (${s.running.mode}) for ${s.running.facilityName || ''} since ${fmt(s.running.started)}…` : '';
  if (running) $('#live').textContent = s.running.log.map(l => l.replace(/^\S+ /, '')).join('\n') || 'Starting…';
  if (wasRunning && !running) { loadFacilities(); if ($('#circulars').classList.contains('active')) loadCirculars(); }
  wasRunning = running;
  refreshTimer = setTimeout(refresh, running ? 1500 : 10000);
}

// ===================================================================================================
// Home: one clear status, four numbers, what needs attention, quick actions, DoH monitoring in plain words
// ===================================================================================================
let parsing = 0; // documents being read right now
const fmtShort = iso => iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const daysTo = iso => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) / 864e5);

// Download tracking: "Download Excel" is highlighted when the register changed since this facility's last download.
const dlKey = () => `downloaded:${facility}`;
function changedSinceDownload(s = status) {
  if (!s) return false;
  const changes = [s.workflow?.lastDocumentAt, (s.lastRun && (s.lastRun.added || s.lastRun.filled)) ? s.lastRun.finished : null].filter(Boolean).sort().at(-1);
  const seen = store.get(dlKey());
  return !!changes && (!seen || changes > seen);
}
function markDownloaded() { store.set(dlKey(), new Date().toISOString()); renderHome(); }

/** Counts of the facility's own entries (federal laws excluded). */
function counts(s = status) {
  const items = (master?.items || []).filter(i => !i.fixed);
  if (items.length) {
    const n = k => items.filter(i => i.status === k).length;
    return { total: items.length, valid: n('valid') + n('lifetime'), expiring: n('expiring'), expired: n('expired'), missing: n('missing') + n('no-expiry') };
  }
  const h = s?.workflow?.health;
  return h?.total ? { total: h.total, valid: h.valid, expiring: h.expiring, expired: h.expired, missing: (h.missing || 0) + (h['no-expiry'] || 0) } : null;
}

// ===================================================================================================
// Hover cards: hovering (or focusing) anything with data-hc shows its details in a small floating card.
//   data-hc="tip" data-tip="text"  – a short explanation
//   data-hc="entry" data-row="12"  – a register entry (dates, days left, responsible, document)
//   data-hc="group" data-group="expired" – the entries in that status group
//   data-hc="<key>"                – any other key registered in hoverCards
// ===================================================================================================
const hoverCards = {};
const hcEl = Object.assign(document.createElement('div'), { className: 'hovercard', role: 'tooltip' });
document.body.appendChild(hcEl);
let hcTarget = null;
function hcShow(el) {
  const kind = el.dataset.hc;
  const html = kind === 'tip' ? esc(el.dataset.tip || '') : hoverCards[kind]?.(el);
  if (!html) return;
  hcTarget = el;
  hcEl.innerHTML = html;
  hcEl.classList.toggle('wide', kind !== 'tip');
  hcEl.classList.add('on');
  const r = el.getBoundingClientRect(), w = hcEl.offsetWidth, h = hcEl.offsetHeight;
  let x = Math.min(window.innerWidth - w - 10, Math.max(10, r.left + r.width / 2 - w / 2));
  let y = r.bottom + 10;
  if (y + h > window.innerHeight - 10) y = Math.max(10, r.top - h - 10); // no room below: above
  hcEl.style.left = `${x}px`; hcEl.style.top = `${y}px`;
}
function hcHide() { hcTarget = null; hcEl.classList.remove('on'); }
document.addEventListener('mouseover', e => { const el = e.target.closest?.('[data-hc]'); if (el && el !== hcTarget) hcShow(el); else if (!el && hcTarget) hcHide(); });
document.addEventListener('focusin', e => { const el = e.target.closest?.('[data-hc]'); if (el) hcShow(el); });
document.addEventListener('focusout', hcHide);
window.addEventListener('scroll', hcHide, true);

const entryOf = row => (master?.items || []).find(i => i.row === Number(row));
const daysText = i => {
  if (i.status === 'lifetime') return 'Lifetime – never expires';
  if (!ISO.test(i.expiry || '')) return i.status === 'missing' ? 'No dates yet – upload the document' : 'No expiry date';
  const d = daysTo(i.expiry);
  return d < 0 ? `Expired ${plural(-d, 'day', 'days')} ago` : d === 0 ? 'Expires today' : `${plural(d, 'day', 'days')} left`;
};
hoverCards.entry = el => {
  const i = entryOf(el.dataset.row);
  if (!i) return '';
  // Short: what it is, how long it has left, when it expires, who is responsible, its document (photo thumbnail)
  const doc = master?.documents?.[i.name];
  const isPic = doc?.hasFile && /\.(png|jpe?g)$/i.test(doc.original || '');
  const expiry = i.status === 'lifetime' ? 'Lifetime' : ISO.test(i.expiry || '') ? `Expires ${fmtDay(i.expiry)}` : 'No expiry date';
  return `<div class="hc-head"><b>${esc(i.name)}</b>${statusPill(i.status)}</div>
    <p class="hc-big">${esc(i.fixed ? 'Federal law – fixed' : daysText(i))}</p>
    ${i.fixed ? '' : `<p class="hc-line">${esc(expiry)} · 👤 ${esc(i.responsible || '—')}</p>`}
    ${isPic ? `<img class="hc-thumb" src="${u(`/api/facility-document?entry=${encodeURIComponent(i.name)}`)}" alt="">` : doc?.hasFile ? `<p class="hc-line">📄 ${esc(doc.original || 'document attached')}</p>` : ''}`;
};
const GROUPS = { valid: ['Valid', ['valid', 'lifetime']], expiring: ['Expiring soon', ['expiring']], expired: ['Expired', ['expired']], missing: ['No dates yet', ['missing', 'no-expiry']] };
hoverCards.group = el => {
  const [label, sts] = GROUPS[el.dataset.group];
  const list = (master?.items || []).filter(i => !i.fixed && sts.includes(i.status));
  return `<div class="hc-head"><b>${label} · ${list.length}</b></div>` +
    (list.length ? `<ul class="hc-list">${list.slice(0, 5).map(i => `<li><span>${esc(i.name)}</span><small>${esc(daysText(i))}</small></li>`).join('')}${list.length > 5 ? `<li class="muted">+ ${list.length - 5} more</li>` : ''}</ul>` : '<p class="hc-line">Nothing here.</p>');
};

// ===================================================================================================
// Home
// ===================================================================================================
let homePolicies = null, homePoliciesAt = 0;
function renderHome(s = status) {
  if (!s) return;
  const w = s.workflow || {}, r = s.lastRun, c = counts(s);
  const items = (master?.items || []).filter(i => !i.fixed);
  $('#hx-date').textContent = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // ---- Compliance health: score, verdict, the bar, the legend ----
  const pct = c?.total ? Math.round((c.valid / c.total) * 100) : 0;
  let tone = 'info', title = 'No register yet', hint = s.register?.error || 'Add a facility, or link its Excel register under Settings.';
  if (c) {
    if (c.expired) { tone = 'bad'; title = `${plural(c.expired, 'item has', 'items have')} expired`; hint = 'Upload the renewed document or update its dates – see Next deadlines.'; }
    else if (c.expiring) { tone = 'warn'; title = `${plural(c.expiring, 'item expires', 'items expire')} within 30 days`; hint = 'Start the renewal now so nothing lapses.'; }
    else if (c.missing) { tone = 'info'; title = `${plural(c.missing, 'item has', 'items have')} no dates yet`; hint = 'Upload the documents – the dates are read for you.'; }
    else { tone = 'ok'; title = 'Everything is valid'; hint = `All ${c.total} licences, certificates and contracts are in date.`; }
  }
  $('#hx-health').className = `hx-strip tone-${tone}`;
  $('#hx-ring').style.setProperty('--p', c ? pct : 0);
  if (c && c.total) { // donut: valid · expiring · expired · no dates, in proportion
    let at = 0; const stop = (k, col) => { const a = at; at += (c[k] || 0) / c.total * 100; return `${col} ${a}% ${at}%`; };
    $('#hx-ring').style.setProperty('--donut', `conic-gradient(${[stop('valid', 'var(--ok)'), stop('expiring', 'var(--warn)'), stop('expired', 'var(--bad)'), stop('missing', 'var(--muted)')].join(', ')}, var(--panel-2) ${at}% 100%)`);
  } else $('#hx-ring').style.setProperty('--donut', 'conic-gradient(var(--panel-2) 0 100%)');
  $('#hx-pct').textContent = c ? pct : '–';
  $('#hx-verdict').textContent = title;
  $('#hx-hint').textContent = hint;
  const segs = [['valid', 'ok'], ['expiring', 'warn'], ['expired', 'bad'], ['missing', 'missing']];
  $('#hx-bar').innerHTML = c ? segs.filter(([k]) => c[k]).map(([k, cls]) =>
    `<button type="button" class="seg ${cls}" style="flex:${c[k]}" data-filter="${k}" data-hc="group" data-group="${k}" aria-label="${GROUPS[k][0]}: ${c[k]}"><span>${c[k]}</span></button>`).join('') : '<div class="seg empty"></div>';
  $('#hx-legend').innerHTML = segs.map(([k, cls]) =>
    `<button type="button" class="lg-chip ${cls}${c && !c[k] ? ' zero' : ''}" data-filter="${k}" data-hc="group" data-group="${k}"><i></i>${GROUPS[k][0]}<b>${c ? c[k] : '–'}</b></button>`).join('');
  $$('#hx-bar [data-filter], #hx-legend [data-filter]').forEach(b => b.onclick = () => { statusFilter = b.dataset.filter; showTab('master'); });

  // ---- Next deadlines (timeline) ----
  const soon = items.filter(i => i.status !== 'lifetime' && ISO.test(i.expiry || '') && daysTo(i.expiry) <= 120).sort((a, b) => a.expiry.localeCompare(b.expiry));
  const noDates = items.filter(i => ['missing', 'no-expiry'].includes(i.status));
  const mon = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'short' });
  $('#hx-timeline').innerHTML = !master ? `<li class="muted">${c ? 'Loading…' : 'Nothing to show yet.'}</li>`
    : !soon.length && !noDates.length ? '<li class="hx-clear"><span>✓</span><div><b>Nothing due in the next 4 months</b><small>All dates are comfortably in the future.</small></div></li>'
    : [...soon.slice(0, 7).map(i => {
      const d = daysTo(i.expiry), cls = d < 0 ? 'bad' : d <= 30 ? 'warn' : 'ok';
      return `<li class="tl ${cls}" data-hc="entry" data-row="${i.row}" data-open="${i.row}" tabindex="0">
        <span class="tl-date"><b>${i.expiry.slice(8, 10)}</b><small>${mon(i.expiry)} ${i.expiry.slice(2, 4)}</small></span>
        <span class="tl-body"><b>${esc(i.name)}</b><small>${esc(daysText(i))}</small></span><span class="tl-go">›</span></li>`;
    }), ...(soon.length < 7 ? noDates.slice(0, 7 - soon.length).map(i => `<li class="tl missing" data-hc="entry" data-row="${i.row}" data-open="${i.row}" tabindex="0">
        <span class="tl-date"><b>?</b><small>no date</small></span><span class="tl-body"><b>${esc(i.name)}</b><small>${esc(daysText(i))}</small></span><span class="tl-go">›</span></li>`) : [])].join('');

  // ---- All entries as tiles ----
  const order = { expired: 0, expiring: 1, missing: 2, 'no-expiry': 3, valid: 4, lifetime: 5 };
  const cls = { expired: 'bad', expiring: 'warn', missing: 'missing', 'no-expiry': 'missing', valid: 'ok', lifetime: 'ok' };
  $('#hx-mosaic').innerHTML = !master ? '<p class="muted">Loading…</p>' : !items.length ? '<p class="muted">No entries in this register.</p>'
    : [...items].sort((a, b) => order[a.status] - order[b.status] || String(a.expiry).localeCompare(String(b.expiry))).map(i => {
      const d = ISO.test(i.expiry || '') ? daysTo(i.expiry) : null;
      const fill = i.status === 'lifetime' ? 100 : d === null ? 0 : Math.max(4, Math.min(100, (d / 365) * 100));
      const big = i.status === 'lifetime' ? '∞' : d === null ? '?' : String(Math.abs(d));
      const unit = i.status === 'lifetime' ? 'lifetime' : d === null ? 'no date' : d < 0 ? (Math.abs(d) === 1 ? 'day late' : 'days late') : (d === 1 ? 'day left' : 'days left');
      return `<button type="button" class="tile t2 ${cls[i.status]}" data-hc="entry" data-row="${i.row}" data-open="${i.row}">
        <span class="t2-top"><span class="t2-chip"><i></i>${esc(STATUS[i.status]?.[0] || i.status)}</span><span class="t2-ring" style="--f:${i.status === 'expired' ? 100 : fill}"><b>${esc(big)}</b><small>${esc(unit)}</small></span></span>
        <b class="t2-name" title="${esc(i.name)}">${esc(i.name)}</b>
        <span class="t2-date">${esc(i.status === 'lifetime' ? 'Never expires' : ISO.test(i.expiry || '') ? `Expires ${fmtDay(i.expiry)}` : 'No expiry date yet')}</span>
        <span class="t2-foot"><span>${esc(i.responsible ? `👤 ${i.responsible}` : '')}</span><span class="t2-go">${i.status === 'expired' || i.status === 'expiring' ? 'Renew' : 'Update'} →</span></span></button>`;
    }).join('');
  $$('#overview [data-open]').forEach(el => {
    const go = () => (me?.role === 'viewer' ? (statusFilter = 'all', showTab('master')) : openEntry(Number(el.dataset.open)));
    el.onclick = go; el.onkeydown = e => { if (e.key === 'Enter') go(); };
  });

  // ---- Download highlight ----
  const fresh = changedSinceDownload(s);
  $('#qa-excel').classList.toggle('fresh', fresh);
  $('#qa-new').hidden = !fresh;

  // ---- DoH monitoring ----
  const next = w.nextRun ? fmtShort(w.nextRun) : null;
  let dot = 'ok', head = 'DoH circulars: up to date';
  if (s.running) { dot = 'run'; head = 'Checking DoH now…'; }
  else if (r && (r.status === 'failed' || r.status === 'register_locked')) { dot = 'bad'; head = `DoH check problem: ${r.statusLabel || r.status}`; }
  else if (!s.lastSuccess) { dot = 'warn'; head = 'DoH circulars: not checked yet'; }
  $('#doh-dot').className = `sys-dot ${dot}`;
  $('#doh-title').textContent = head;
  $('#doh-last').innerHTML = s.lastSuccess ? `${fmtShort(s.lastSuccess)} <span class="muted">· ${r?.added ? plural(r.added, 'new circular', 'new circulars') : 'nothing new'}</span>` : 'Not yet';
  const sd = cronDay(s.schedule?.nightlyCron);
  $('#doh-next').innerHTML = s.schedule?.enabled ? `${next || '–'} <span class="muted">· ${sd === '*' ? 'daily' : `every ${DAYS[+sd]}`} ${cronToTime(s.schedule.nightlyCron)}</span>` : '<span class="warn-txt">Automatic checks off</span>';
  $('#doh-mail').innerHTML = !s.emailEnabled ? '<span class="muted">Off</span>' : s.emailReady ? esc((s.emailTo || []).join(', ') || 'recipients')
    : '<span class="warn-txt">Not set up</span> <span class="muted">– Settings → Schedule &amp; e-mail</span>';

  // ---- Policies + activity (policies status is fetched at most once a minute) ----
  if (Date.now() - homePoliciesAt > 60000) {
    homePoliciesAt = Date.now();
    api('/api/policies').then(p => { homePolicies = p; renderHomePolicies(); renderHomeActivity(); renderJourney(); }).catch(() => {});
    api('/api/hr').then(h => { homeHr = h; renderHomeHr(); renderJourney(); }).catch(() => {});
    api('/api/circulars/brief').then(b => { dohBrief = b; renderDohBrief(); }).catch(() => {});
  }
  renderHomePolicies(); renderHomeHr(); renderHomeActivity(); renderJourney();
}

/** DoH card: this year's circulars in brief and the four newest ones (from the LEGAL REGISTER's Circular sheet). */
var dohBrief = null;
function renderDohBrief() {
  const b = dohBrief, box = $('#doh-brief'), list = $('#doh-latest');
  if (!b || !box) return;
  const y = b.year;
  box.innerHTML = y ? `<div class="db-stat"><b>${y.count}</b><span>circulars in ${y.year}</span></div>
    <div class="db-stat ok"><b>${y.applicable}</b><span>apply to you</span></div>
    <div class="db-stat na"><b>${y.notApplicable}</b><span>not applicable</span></div>
    <div class="db-stat warn"><b>${y.recalls}</b><span>recalls &amp; alerts</span></div>` : '';
  const day = iso => (iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short' }) : '–');
  list.innerHTML = b.latest.length ? b.latest.map(c => {
    const applies = c.compliance && !/not applicable/i.test(c.compliance);
    return `<li class="dl-item">
      <span class="dl-date"><b>${day(c.date).split(' ')[0]}</b><small>${day(c.date).split(' ')[1] || ''}</small></span>
      <span class="dl-body"><span class="dl-no">${esc(c.number)}</span><b title="${esc(c.name)}">${esc(c.name)}</b>
        <span class="dl-meta"><span class="dl-chip ${applies ? 'ok' : 'na'}">${applies ? 'Applies' : 'Not applicable'}</span>${c.responsible ? `<span>👤 ${esc(c.responsible)}</span>` : ''}${c.target && c.target !== '_' ? `<span>⏱ ${esc(c.target)}</span>` : ''}</span></span>
      ${c.url ? `<a class="dl-open" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" title="Open the circular on doh.gov.ae">PDF ↗</a>` : ''}
    </li>`;
  }).join('') : '<li class="muted small">No circulars in the register yet.</li>';
}

/** Step 2 card on the dashboard: the HR & onboarding documents of this facility (live while they are created). */
var homeHr = null, homeHrPoll = 0;
function renderHomeHr() {
  const h = homeHr, box = $('#hx-hr');
  if (!h || !box) return;
  const j = h.job, g = h.generated, installed = h.forms.filter(f => f.installed).length;
  const needLogo = h.forms.some(f => f.installed && f.need.some(n => /logo/.test(n)));
  box.innerHTML = j?.running
    ? `<div class="hx-live" role="status"><div class="hx-live-top"><span class="spin"></span><b>Creating the HR documents – ${j.done || 0} of ${j.total}</b><span>${Math.round(((j.done || 0) / Math.max(1, j.total)) * 100)}%</span></div><div class="days-bar"><i style="width:${Math.round(((j.done || 0) / Math.max(1, j.total)) * 100)}%"></i></div><small>${esc(j.step || '')}</small></div>`
    : g ? `<div class="hx-live ${g.passed < g.total ? 'warn' : 'ok'}"><b>${g.passed < g.total ? '⚠' : '✓'} ${g.count} of ${g.total} documents created · ${g.passed} checked and correct</b><small>${fmt(g.at)} · Word + PDF with this facility's name and logo</small></div>`
    : `<p class="small muted">${!installed ? 'No master HR forms uploaded yet.' : needLogo ? 'Add the facility logo first (Prepare policies → Pictures).' : `${installed} forms ready to create: NDA, orientation, background verification, IT/EMR user form, disciplinary process, acceptable usage, IT quiz, awareness training, exit clearance.`}</p>`;
  $('#hx-hr-checklist').textContent = `Checklist: ${h.checklist.counts.completed} of ${h.checklist.counts.total} documents completed`;
  clearTimeout(homeHrPoll);
  if (j?.running) homeHrPoll = setTimeout(() => api('/api/hr').then(n => { homeHr = n; renderHomeHr(); renderJourney(); }).catch(() => {}), 2000);
}

function renderHomePolicies() {
  const p = homePolicies;
  if (!p) return;
  const lg = p.lastGenerated, val = p.job?.validation;
  const steps = [['Masters', p.templates.length > 0, `${p.templates.length} master policies${p.lock?.locked ? ' · 🔒 locked' : ''}`],
    ['Details', !p.need.filter(n => !/templates/i.test(n)).length, p.need.length ? `Still needed: ${p.need.join(', ')}` : 'Dates, people, logo and signatures set'],
    ['Generated', !!p.files.word.length, lg ? `${lg.count} policies · ${fmt(lg.at)}${val ? ` · validation ${val.passed}/${val.total}` : ''}` : 'Not generated yet']];
  const j = p.job;
  // live: while the policies are being created, show how far it is (refreshed every 2 s until done)
  const live = j?.running ? `<div class="hx-live" role="status"><div class="hx-live-top"><span class="spin"></span><b>Creating the policies – ${j.done || 0} of ${j.total || '…'}</b><span>${Math.round(((j.done || 0) / Math.max(1, j.total || 1)) * 100)}%</span></div>
      <div class="days-bar"><i style="width:${Math.round(((j.done || 0) / Math.max(1, j.total || 1)) * 100)}%"></i></div><small>${esc(j.step || '')}</small></div>`
    : (val && !j?.running ? `<div class="hx-live ${val.failed?.length ? 'warn' : 'ok'}"><b>${val.failed?.length ? '⚠' : '✓'} Last run: ${val.passed} of ${val.total} policies checked and correct</b>${val.failed?.length ? `<small>Please look at ${esc(val.failed.join(', '))}</small>` : ''}</div>` : '');
  $('#hx-policies').innerHTML = `${live}<ol class="hx-steps">${steps.map(([k, done, tip]) => `<li class="${done ? 'done' : ''}" data-hc="tip" data-tip="${esc(tip)}"><i>${done ? '✓' : ''}</i><span>${k}</span></li>`).join('')}</ol>
    <p class="small muted">${p.files.word.length ? `${p.files.word.length} Word · ${p.files.pdf.length} PDF files ready` : 'Prepare this facility\'s 33 policies in a few minutes.'}</p>`;
  clearTimeout(homePolicyPoll);
  if (j?.running) homePolicyPoll = setTimeout(() => api('/api/policies').then(np => { homePolicies = np; renderHomePolicies(); renderJourney(); }).catch(() => {}), 2000);
}
var homePolicyPoll = 0;

function renderHomeActivity() {
  const s = status, ev = [];
  if (s?.lastRun) ev.push([s.lastRun.finished || s.lastRun.started, '↻', `DoH check – ${s.lastRun.statusLabel || s.lastRun.status}${s.lastRun.added ? `, ${plural(s.lastRun.added, 'circular', 'circulars')} added` : ''}`]);
  for (const [name, d] of Object.entries(master?.documents || {})) if (d.appliedAt) ev.push([d.appliedAt, '📄', `Document applied to ${name}${d.original ? ` (${d.original})` : ''}`]);
  if (homePolicies?.lastGenerated) ev.push([homePolicies.lastGenerated.at, '📚', `${homePolicies.lastGenerated.count} policies generated`]);
  if (homePolicies?.linked) ev.push([homePolicies.linked, '🔗', 'Policies linked to the LEGAL REGISTER']);
  if (homePolicies?.lock?.at) ev.push([homePolicies.lock.at, '🔒', `Master policies locked${homePolicies.lock.by ? ` by ${homePolicies.lock.by}` : ''}`]);
  const list = ev.filter(e => e[0]).sort((a, b) => String(b[0]).localeCompare(String(a[0]))).slice(0, 6);
  $('#hx-activity').innerHTML = list.length ? list.map(([at, ic, text]) => `<li data-hc="tip" data-tip="${esc(fmt(at))}"><i>${ic}</i><span>${esc(text)}</span><small>${esc(fmtShort(at))}</small></li>`).join('')
    : '<li class="muted">Nothing yet.</li>';
}

// Home buttons
const uploadDocs = async () => {
  if (!status?.workflow?.health && !status?.register?.path) return $('#btn-add-facility').click();
  if (!master) await loadMaster();
  openDocs();
};
$('#qa-upload').onclick = uploadDocs;
$('#qa-entry').onclick = async () => { if (!master) await loadMaster(); openEntry(null); };
$('#hx-pol-open').onclick = () => showTab('policies');
$('#jr-reg-open').onclick = () => { statusFilter = 'all'; showTab('master'); };
$$('#jr-track [data-goto], #hx-hr-open').forEach(b => b.onclick = () => showTab(b.dataset.goto));

/** The journey: 1 Policies -> 2 HR documents -> 3 LEGAL REGISTER (final) – done, needs attention, or still to do. */
function renderJourney() {
  const s = status, p = homePolicies, c = counts(s), r = s?.lastRun;
  const st = [];
  const h = homeHr;
  // 1 Policies (from the master template)
  if (!p) st.push(['todo', 'Checking…']);
  else if (p.job?.running) st.push(['warn', `Creating ${p.job.done || 0}/${p.job.total || '…'}`]);
  else if (p.files.word.length) st.push(['done', `${p.files.word.length} policies ready`]);
  else st.push(['todo', p.need.length ? 'Details still needed' : 'Ready to generate']);
  // 2 HR & onboarding documents
  if (!h) st.push(['todo', 'Checking…']);
  else if (h.job?.running) st.push(['warn', `Creating ${h.job.done || 0}/${h.job.total}`]);
  else if (!h.forms.some(f => f.installed)) st.push(['warn', 'Master forms not uploaded']);
  else if (h.generated?.count) st.push([h.generated.passed < h.generated.total ? 'warn' : 'done', `${h.generated.count} documents ready`]);
  else st.push(['todo', h.forms.some(f => f.installed && f.need.some(n => /logo/.test(n))) ? 'Facility logo needed' : 'Ready to create']);
  // 3 LEGAL REGISTER – the final step: policies linked, every entry dated, DoH circulars recorded
  if (!c) st.push(['todo', 'No register yet']);
  else if (p?.files.word.length && !p.linked) st.push(['todo', 'Link the policies']);
  else if (r && (r.status === 'failed' || r.status === 'register_locked')) st.push(['bad', 'Last DoH check failed']);
  else if (c.expired || c.expiring) st.push(['warn', [c.expired && `${c.expired} expired`, c.expiring && `${c.expiring} expiring`].filter(Boolean).join(' · ')]);
  else if (c.missing) st.push(['warn', `${plural(c.missing, 'entry', 'entries')} without dates`]);
  else if (s?.running) st.push(['warn', 'DoH check running…']);
  else if (!s?.lastSuccess) st.push(['todo', 'Run the first DoH check']);
  else st.push(['done', `All ${c.total} entries valid · DoH ${fmtShort(s.lastSuccess).replace(/,.*$/, '')}`]);
  const firstOpen = st.findIndex(([x]) => x !== 'done');
  st.forEach(([state, text], k) => {
    const li = $(`#jr-track [data-jr="${k + 1}"]`);
    li.className = `${state}${k === firstOpen ? ' current' : ''}`;
    li.querySelector('i').textContent = state === 'done' ? '✓' : String(k + 1);
    $(`#jr-s${k + 1}`).textContent = text;
    const badge = $(`#jr-st${k + 1}`);
    if (badge) { badge.className = `jr-state ${state}`; badge.textContent = { done: 'Done', warn: 'Needs attention', bad: 'Problem', todo: k === firstOpen ? 'Do this now' : 'To do' }[state]; }
    $(`#jr-c${k + 1}`)?.classList.toggle('current', k === firstOpen);
  });
  $('#jr-zip').hidden = !p?.files.word.length;
  if (p?.files.word.length) $('#jr-zip').href = u('/api/policies/zip?type=all');
  flowState = { st, firstOpen, p, c, s, r };
  renderFlow();
}

/**
 * The process, start to finish, on every work page: Start → 1 Prepare policies → 2 LEGAL REGISTER → 3 DoH updates
 * → Finished. Done steps get ✓, the first open step is highlighted ("Do this now"), the page you are on is marked
 * ("You are here"), and the Next step box says exactly what to do, with a button that takes you there.
 */
var flowState = null; // var: showTab may run before this line during start-up
function renderFlow() {
  const flow = $('#flow');
  if (!flow) return;
  const tab = $$('.tab').find(t => t.classList.contains('active'))?.id || 'overview';
  flow.hidden = !facility || tab === 'admin' || tab === 'nofac';
  if (!flowState || flow.hidden) return;
  const { st, firstOpen, p, c, s, r } = flowState;
  const here = { policies: 1, hr: 2, master: 3, circulars: 3 }[tab] || 0;
  const allDone = firstOpen < 0;
  st.forEach(([state, text], k) => {
    const li = $(`#flow [data-f="${k + 1}"]`);
    li.className = [state === 'done' ? 'done' : state === 'bad' ? 'bad' : state === 'warn' ? 'warn' : 'todo', k === firstOpen ? 'now' : '', here === k + 1 ? 'here' : ''].join(' ').trim();
    li.querySelector('.fl-dot').textContent = state === 'done' ? '✓' : String(k + 1);
    $(`#fl-s${k + 1}`).textContent = k === firstOpen ? `Do this now · ${text}` : text;
  });
  // overall completion in the bar: steps 1-3 done (100 % when everything is finished)
  const doneSteps = st.filter(([x]) => x === 'done').length, pct = allDone ? 100 : Math.round((doneSteps / st.length) * 100);
  $('#fl-ring')?.style.setProperty('--p', pct);
  if ($('#fl-pct')) $('#fl-pct').textContent = `${pct}%`;
  if ($('#fl-sum')) $('#fl-sum').textContent = allDone ? 'All steps done' : `${doneSteps} of ${st.length} steps done`;
  $('#flow [data-f="4"]').className = allDone ? 'done now' : 'todo';
  $('#fl-s4').textContent = allDone ? 'Everything up to date ✓' : 'When steps 1–3 are done';
  // the one next step, in plain words
  let title, sub = '', go = null, badge = 'Next step';
  if (allDone) { title = 'All done – everything is up to date'; sub = 'The DoH check runs every week by itself. Come back when a licence is due.'; badge = 'Finished'; }
  else if (firstOpen === 0) {
    go = 'policies';
    if (!p) title = 'Prepare the policies';
    else if (p.job?.running) { title = `Creating the policies – ${p.job.done || 0} of ${p.job.total || '…'} done`; sub = p.job.step || 'Word and PDF files are being made…'; }
    else if (p.need?.length) { title = 'Fill in the policy details'; sub = `Still needed: ${p.need.slice(0, 3).join(', ')}${p.need.length > 3 ? '…' : ''}`; }
    else { title = 'Create the policies'; sub = `All details are in – create the ${p.templates?.length || 33} policies as Word + PDF.`; }
  } else if (firstOpen === 1) {
    go = 'hr';
    const h = homeHr;
    if (h?.job?.running) { title = `Creating the HR documents – ${h.job.done || 0} of ${h.job.total} done`; sub = h.job.step || ''; }
    else if (h && !h.forms.some(f => f.installed)) { title = 'Upload the master HR forms'; sub = 'An administrator adds them once on the HR & checklist page.'; }
    else if (h?.forms.some(f => f.installed && f.need.some(n => /logo/.test(n)))) { title = 'Add the facility logo'; sub = 'The HR documents carry this facility’s logo – add it under Prepare policies → Pictures.'; go = 'policies'; }
    else if (h?.generated?.count) { title = 'Check the HR documents'; sub = `${h.generated.total - h.generated.passed} of ${h.generated.total} documents need a look.`; }
    else { title = 'Create the HR & onboarding documents'; sub = 'NDA, orientation, background verification, IT/EMR form, disciplinary process, acceptable usage, exit clearance… with this facility’s name and logo.'; }
  } else if (firstOpen === 2 && p?.files.word.length && !p.linked) {
    go = 'policies'; title = 'Final step: link everything to the LEGAL REGISTER'; sub = 'One click copies the facility details, approver and author into the register (Prepare policies → step 4).';
  } else if (firstOpen === 2 && (!c || c.expired || c.expiring || c.missing)) {
    go = 'master';
    if (!c) title = 'Set up the LEGAL REGISTER';
    else if (c.expired || c.expiring) { title = `Renew ${[c.expired && `${c.expired} expired`, c.expiring && `${c.expiring} expiring`].filter(Boolean).join(' and ')} item${(c.expired || 0) + (c.expiring || 0) > 1 ? 's' : ''}`; sub = 'Upload the new licence or certificate – the dates are read for you.'; }
    else { title = `Add the missing dates (${plural(c.missing, 'entry', 'entries')})`; sub = 'Upload the document or a photo of it, or type the dates in.'; }
  } else {
    go = 'circulars';
    if (s?.running) { title = 'Checking DoH now…'; sub = 'This takes a minute.'; go = null; }
    else if (r && (r.status === 'failed' || r.status === 'register_locked')) { title = 'The last DoH check did not finish – run it again'; sub = r.status === 'register_locked' ? 'Close the Excel file first, then check again.' : 'Press "Check DoH now".'; }
    else { title = 'Run the first DoH check'; sub = 'New Abu Dhabi DoH circulars are added to the register.'; }
  }
  $('#fn-badge').textContent = badge;
  $('#fn-title').textContent = title; $('#fn-sub').textContent = sub;
  $('#flow-next').className = `flow-next${allDone ? ' done' : ''}`;
  const btn = $('#fn-go');
  btn.hidden = !go || tab === go;
  btn.onclick = () => go && showTab(go);
  if (go && tab === go) $('#fn-sub').textContent = `${sub}${sub ? ' ' : ''}You are on this page now.`.trim();
  if (typeof iso !== 'undefined') iso.progress(); // the isometric badges follow the same progress
}
$$('#flow [data-goto]').forEach(b => b.onclick = () => showTab(b.dataset.goto));
$('#btn-add-facility-2').onclick = () => $('#btn-add-facility').click();

// Menu items explain themselves on hover
const NAV_TIPS = { overview: 'Where you are in the process and what to do next', policies: 'Step 1 – fill in the details and create the policies (Word + PDF)', hr: 'Step 2 – HR and onboarding documents, employee training documents and the ADHICS checklist', thirdparty: '3rd-party / vendor documents: NDA and acceptable usage, with this facility\'s logo, name and Ref. No.', master: 'Step 3, the final step – link the policies, licences and certificates with their dates', circulars: 'Always on – new DoH Abu Dhabi circulars are added to the register every week', exports: 'Every file to download in one place', settings: 'Details of this facility and your account' };
$$('#tabs button').forEach(b => { b.dataset.hc = 'tip'; b.dataset.tip = NAV_TIPS[b.dataset.tab] || ''; });

// ---- Export window: Master Excel (.xlsx) and PDF summary report (.pdf) ----
function openExport() {
  $('#exp-xlsx').href = u('/api/register/download');
  $('#exp-print').href = u('/api/master/export');
  $('#export-sub').textContent = `${status?.documentControl?.facilityTitle || 'LEGAL REGISTER'} – both formats contain the header, logo and the latest dates and statuses.`;
  $('#exp-msg').textContent = ''; $('#exp-pdf-label').textContent = 'Download .pdf';
  $('#export-dlg').showModal();
}
$('#btn-export-more').onclick = openExport;
$('#exp-close').onclick = () => $('#export-dlg').close();
$('#exp-xlsx').onclick = () => { markDownloaded(); setTimeout(() => $('#export-dlg').close(), 300); };
$('#qa-excel').addEventListener('click', markDownloaded);
$('#lnk-download').addEventListener('click', markDownloaded);

/** Download the PDF summary (button shows progress). */
async function downloadPdf(btn, label) {
  const original = label.innerHTML;
  btn.disabled = true; label.innerHTML = '<span class="spin"></span> Preparing PDF…';
  try {
    const res = await fetch(u('/api/export/pdf'));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'LEGAL REGISTER.pdf';
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: name });
    document.body.appendChild(link); link.click(); link.parentNode.removeChild(link);
    label.innerHTML = original;
    return name;
  } catch (e) { label.innerHTML = original; throw e; }
  finally { btn.disabled = false; }
}
$('#exp-pdf').onclick = async () => {
  try { $('#exp-msg').textContent = `Downloaded ${await downloadPdf($('#exp-pdf'), $('#exp-pdf-label'))}`; }
  catch (e) { $('#exp-msg').textContent = `PDF not created: ${e.message}`; }
};
$('#qa-pdf').onclick = async () => {
  try { await downloadPdf($('#qa-pdf'), $('#qa-pdf-label')); } catch (e) { alert(`PDF not created: ${e.message}`); }
};

// ---- Theme: light by default, dark on request (remembered on this PC) ----
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $$('[data-theme-set]').forEach(b => b.classList.toggle('active', b.dataset.themeSet === t));
}
if (store.get('ui-look') !== 'teal') { store.set('ui-look', 'teal'); store.set('ui-theme', 'light'); } // the Clinical Teal look starts light
applyTheme(store.get('ui-theme') || 'light');
$$('[data-theme-set]').forEach(b => b.onclick = () => { store.set('ui-theme', b.dataset.themeSet); store.set('theme', b.dataset.themeSet); applyTheme(b.dataset.themeSet); });

async function startRun(mode, force = false, all = false) {
  if (force && !confirm('Add all held circulars to the LEGAL REGISTER, even above the per-run safety limit?')) return;
  try {
    await api('/api/run', { method: 'POST', body: JSON.stringify({ mode, force, all }) });
    $('#live').textContent = 'Starting…';
    setTimeout(refresh, 500);
  } catch (e) { alert(e.message); }
}
$('#btn-run').onclick = () => startRun('update');
$('#btn-run-all').onclick = () => startRun('update', false, true);
$('#btn-check').onclick = () => startRun('check');
$('#btn-force').onclick = () => startRun('update', true);

// ===================================================================================================
// LEGAL REGISTER (master table): view, edit, add, delete
// ===================================================================================================
const today = () => new Date().toISOString().slice(0, 10);
const soon = () => new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
const dateState = (k, v) => k !== 'issued' && ISO.test(v) ? (v < today() ? 'expired' : v <= soon() ? 'expiring' : '') : '';
const dateCell = (k, v) => ISO.test(v) ? `<span class="date ${dateState(k, v)}" title="${dateState(k, v) === 'expired' ? 'Expired' : dateState(k, v) === 'expiring' ? 'Expires within 30 days' : ''}">${fmtDay(v)}</span>` : `<span class="date empty">${esc(v || '—')}</span>`;

// Entry status (same rule as the server): label, colour class, sort order for "needs attention first".
const STATUS = {
  expired: ['Expired', 'bad'], expiring: ['Expires soon', 'warn'], missing: ['No dates', 'missing'],
  'no-expiry': ['No expiry date', 'na'], valid: ['Valid', 'ok'], lifetime: ['Lifetime · no expiry', 'ok'], fixed: ['Fixed law', 'na'],
};
const LIFETIME_CELL = '<span class="lifetime-tag" title="Malaffi is a one-time connection certificate: no expiry or due date">∞ Lifetime</span>';
const isLifetimeName = n => /MALAF+I/i.test(n || '');
const statusPill = s => `<span class="pill-status ${STATUS[s]?.[1] || 'na'}">${STATUS[s]?.[0] || s}</span>`;
let statusFilter = 'all';

function renderStatusBar() {
  const items = (master?.items || []).filter(i => !i.fixed);
  const n = s => items.filter(i => i.status === s).length;
  const chip = (key, label, count, cls) => `<button class="stat ${cls}${statusFilter === key ? ' active' : ''}" data-status="${key}"><b>${count}</b><span>${label}</span></button>`;
  $('#status-bar').innerHTML = chip('all', 'All entries', items.length, 'all') + chip('valid', 'Valid', n('valid') + n('lifetime'), 'ok') +
    chip('expiring', 'Expire within 30 days', n('expiring'), 'warn') + chip('expired', 'Expired', n('expired'), 'bad') +
    chip('missing', 'No dates yet', n('missing') + n('no-expiry'), 'missing');
  $$('#status-bar [data-status]').forEach(b => b.onclick = () => { statusFilter = b.dataset.status; renderStatusBar(); renderMasterRows(); });
}

let masterLoading = false;
async function loadMaster() {
  if (!master) $('#mtbl tbody').innerHTML = '<tr><td colspan="9" class="muted">Loading…</td></tr>';
  const forFacility = facility;
  masterLoading = true;
  try { const m = await api('/api/master'); if (forFacility !== facility) return; master = m; }
  catch (e) { $('#master-alert').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; $('#mtbl tbody').innerHTML = ''; $('#status-bar').innerHTML = ''; return; }
  finally { masterLoading = false; }
  $('#master-alert').innerHTML = master.lock ? `<div class="alert warn">${esc(master.lock)} – close it before making changes.</div>` : '';
  renderStatusBar();
  renderMasterRows();
  renderHome();
}

// Cards or table for the LEGAL REGISTER: chosen by the user (remembered), cards by default on narrower screens.
const mviewPref = () => store.get('mview') || 'cards'; // cards are easiest to read; the table is one click away
function mviewApply() {
  const v = window.innerWidth < 760 ? 'cards' : mviewPref(); // phones always get cards – a wide table cannot fit
  $('#mcards').hidden = v !== 'cards'; $('#mtable').hidden = v === 'cards';
  $$('#mview [data-mview]').forEach(b => b.classList.toggle('on', b.dataset.mview === v));
}
$$('#mview [data-mview]').forEach(b => b.onclick = () => { store.set('mview', b.dataset.mview); mviewApply(); });
window.addEventListener('resize', () => { if (master) mviewApply(); });
const FILTER_LABEL = { valid: 'Valid registers', expiring: 'Expiring within 30 days', expired: 'Expired licences', pending: 'Pending action items', missing: 'No dates yet' };
function renderMasterRows() {
  const show = i => statusFilter === 'all' || (statusFilter === 'missing' ? ['missing', 'no-expiry'].includes(i.status)
    : statusFilter === 'pending' ? ['expired', 'expiring', 'missing'].includes(i.status)
    : statusFilter === 'valid' ? ['valid', 'lifetime'].includes(i.status) : i.status === statusFilter);
  const rows = master.items.filter(i => statusFilter === 'all' ? true : !i.fixed && show(i));
  const note = $('#filter-note');
  note.hidden = statusFilter === 'all';
  note.innerHTML = statusFilter === 'all' ? '' : `Showing <b>${FILTER_LABEL[statusFilter] || statusFilter}</b> (${rows.length}) <button class="icon-btn" id="clear-filter">Show all entries</button>`;
  if (!note.hidden) $('#clear-filter').onclick = () => { statusFilter = 'all'; renderMasterRows(); renderHome(); };
  mviewApply();
  if (!rows.length) { $('#mtbl tbody').innerHTML = '<tr><td colspan="9" class="muted">Nothing in this group – well done.</td></tr>'; $('#mcards').innerHTML = '<p class="muted">Nothing in this group – well done.</p>'; return; }
  // Cards view: one card per entry (status colour, dates, time left, actions); details on hover
  const ecls = { expired: 'bad', expiring: 'warn', missing: 'missing', 'no-expiry': 'missing', valid: 'ok', lifetime: 'ok', fixed: 'na' };
  $('#mcards').innerHTML = rows.map(i => {
    const d = ISO.test(i.expiry || '') ? daysTo(i.expiry) : null;
    const fill = i.status === 'lifetime' ? 100 : d === null ? 0 : Math.max(4, Math.min(100, (d / 365) * 100));
    const doc = master.documents?.[i.name];
    return `<article class="ecard ${ecls[i.status] || 'na'}${i.fixed ? ' fixed' : ''}" data-hc="entry" data-row="${i.row}">
      <header><span class="ecard-sl">${esc(i.sl)}</span>${statusPill(i.status)}</header>
      <h3>${esc(i.name)}</h3>
      ${i.fixed ? '<p class="muted small">Federal law – fixed in every register</p>' : `
      <dl class="ecard-dates"><div><dt>Issued</dt><dd>${ISO.test(i.issued || '') ? fmtDay(i.issued) : '—'}</dd></div><div><dt>Expiry</dt><dd>${i.status === 'lifetime' ? '∞ Lifetime' : ISO.test(i.expiry || '') ? fmtDay(i.expiry) : '—'}</dd></div><div><dt>Due</dt><dd>${i.status !== 'lifetime' && ISO.test(i.due || '') ? fmtDay(i.due) : '—'}</dd></div></dl>
      <div class="tile-bar"><i style="width:${fill}%"></i></div>
      <p class="ecard-days">${esc(daysText(i))}</p>
      <footer><span class="ecard-who" title="Responsible person">👤 ${esc(i.responsible || '—')}</span>
        <span class="row-actions">${doc?.hasFile ? `<a class="icon-btn" href="${u(`/api/facility-document?entry=${encodeURIComponent(i.name)}`)}" target="_blank" title="${esc(doc.original || 'Source document')}">📄</a>` : ''}<label class="icon-btn" data-write title="Add a photo or document (dates are read for you)">📷<input type="file" accept="image/*,.pdf,.docx,.doc" hidden data-photo-row="${i.row}"></label><button class="icon-btn" data-write data-edit-row="${i.row}">Edit</button><button class="icon-btn del" data-write data-del-row="${i.row}">Delete</button></span></footer>`}
    </article>`;
  }).join('');
  $('#mtbl tbody').innerHTML = rows.map(i => `<tr class="${i.fixed ? 'fixed' : ''} st-${i.status}" data-hc="entry" data-row="${i.row}">
    <td class="num">${esc(i.sl)}</td>
    <td class="name">${esc(i.name)}${master.documents?.[i.name]?.hasFile ? `<a class="doc-link" href="${u(`/api/facility-document?entry=${encodeURIComponent(i.name)}`)}" target="_blank" title="Source document: ${esc(master.documents[i.name].original || '')}">📄 source document</a>` : ''}</td>
    <td>${statusPill(i.status)}</td>
    <td>${dateCell('issued', i.issued)}</td><td>${i.status === 'lifetime' ? LIFETIME_CELL : dateCell('expiry', i.expiry)}</td><td>${i.status === 'lifetime' ? '<span class="date empty">—</span>' : dateCell('due', i.due)}</td>
    <td>${esc(i.responsible)}</td>
    <td>${/not applicable/i.test(i.compliance) ? `<span class="tag na">${esc(i.compliance)}</span>` : `<span class="tag ok">${esc(i.compliance)}</span>`}</td>
    <td><div class="row-actions">${i.fixed ? '<span class="muted small">Locked</span>' : `<button class="icon-btn" data-write data-edit-row="${i.row}">Edit</button><button class="icon-btn del" data-write data-del-row="${i.row}">Delete</button>`}</div></td>
  </tr>`).join('');
  $$('[data-edit-row]').forEach(b => b.onclick = () => openEntry(Number(b.dataset.editRow)));
  $$('[data-photo-row]').forEach(inp => inp.onchange = e => { const files = [...e.target.files]; e.target.value = ''; addDocFor(Number(inp.dataset.photoRow), files); });
  $$('[data-del-row]').forEach(b => b.onclick = () => deleteEntry(Number(b.dataset.delRow)));
}

let editingRow = null;
function openEntry(row) {
  const f = $('#entry-form');
  const L = master?.labels || { compliant: 'Fully Compliant', notApplicable: 'Not Applicable' };
  f.elements.compliance.innerHTML = [L.compliant, L.notApplicable].map(o => `<option>${esc(o)}</option>`).join('');
  const it = row ? master.items.find(i => i.row === row) : null;
  editingRow = it ? it.row : null;
  $('#entry-title').textContent = it ? `Edit entry ${it.sl}` : 'Add entry';
  f.elements.name.value = it?.name || '';
  for (const k of ['issued', 'expiry', 'due']) f.elements[k].value = ISO.test(it?.[k] || '') ? it[k] : '';
  f.elements.responsible.value = it?.responsible || status?.branch?.responsible || '';
  f.elements.compliance.value = it?.compliance || L.compliant;
  lifetimeFields();
  $('#entry-msg').textContent = '';
  // The entry's document: show it, or add one – a photo of the certificate is fine (its dates are read with OCR)
  const doc = it && master.documents?.[it.name];
  $('#entry-doc').hidden = !it;
  $('#entry-doc-now').innerHTML = doc?.hasFile
    ? `📄 <a href="${u(`/api/facility-document?entry=${encodeURIComponent(it.name)}`)}" target="_blank">${esc(doc.original || 'document')}</a> <span class="muted">· replace it:</span>`
    : 'No document attached yet';
  $('#entry-dlg').showModal();
}
$('#btn-entry-add').onclick = () => openEntry(null);
/** Add a photo or document to one entry: it is read, the dates are shown for checking, then saved with the entry. */
function addDocFor(row, files) {
  if (!files.length) return;
  $('#entry-dlg').close();
  openDocs();
  analyzeFiles(files, row);
}
$('#entry-photo').onchange = e => { const files = [...e.target.files]; e.target.value = ''; addDocFor(editingRow, files); };
/** Malaffi (lifetime certificate): no expiry / due date in the entry form. */
function lifetimeFields() {
  const f = $('#entry-form'), life = isLifetimeName(f.elements.name.value);
  for (const k of ['expiry', 'due']) { f.elements[k].disabled = life; if (life) f.elements[k].value = ''; f.elements[k].placeholder = life ? 'Lifetime' : ''; }
  $('#entry-life').hidden = !life;
}
$('#entry-form').elements.name.addEventListener('input', lifetimeFields);
$('#entry-cancel').onclick = () => $('#entry-dlg').close();
$('#entry-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const v = Object.fromEntries(['name', 'issued', 'expiry', 'due', 'responsible', 'compliance'].map(k => [k, f.elements[k].value]));
  $('#entry-msg').textContent = 'Saving…';
  try {
    if (editingRow) await api('/api/master', { method: 'PUT', body: JSON.stringify({ items: [{ row: editingRow, ...v }] }) });
    else await api('/api/master/entries', { method: 'POST', body: JSON.stringify({ entry: v }) });
    $('#entry-dlg').close();
    await loadMaster();
    $('#master-alert').insertAdjacentHTML('afterbegin', `<div class="alert ok">${editingRow ? 'Entry updated' : 'Entry added'} in the Excel register (backup taken).</div>`);
  } catch (err) { $('#entry-msg').textContent = `Not saved: ${err.message}`; }
};
async function deleteEntry(row) {
  const it = master.items.find(i => i.row === row);
  if (!it || !confirm(`Delete "${it.name}" from the LEGAL REGISTER?\n\nThe entries below move up one row. A backup is taken first.`)) return;
  try {
    await api(`/api/master/entries/${row}`, { method: 'DELETE' });
    await loadMaster();
    $('#master-alert').insertAdjacentHTML('afterbegin', `<div class="alert ok">"${esc(it.name)}" deleted (backup taken).</div>`);
  } catch (e) { $('#master-alert').insertAdjacentHTML('afterbegin', `<div class="alert bad">Not deleted: ${esc(e.message)}</div>`); }
}

// ===================================================================================================
// Facility documents for register entries (licences, certificates, contracts): recognise -> review -> apply
// ===================================================================================================
let docResults = [];
function openDocs() {
  docResults = [];
  $('#docs-files').value = ''; $('#docs-result').innerHTML = ''; $('#docs-msg').textContent = ''; $('#docs-apply').disabled = true;
  $('#docs-dlg').showModal();
}
$('#btn-docs').onclick = async () => { if (!master) await loadMaster(); openDocs(); };
// Inline drop zone on the LEGAL REGISTER page: opens the review dialog with the dropped / chosen files.
const pageDrop = $('#page-drop');
const openWith = async files => { if (!files.length) return; if (!master) await loadMaster(); openDocs(); analyzeFiles(files); };
['dragenter', 'dragover'].forEach(ev => pageDrop.addEventListener(ev, e => { e.preventDefault(); pageDrop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => pageDrop.addEventListener(ev, e => { e.preventDefault(); pageDrop.classList.remove('over'); }));
pageDrop.addEventListener('drop', e => openWith([...e.dataTransfer.files]));
$('#page-files').onchange = e => { const f = [...e.target.files]; e.target.value = ''; openWith(f); };
$('#docs-cancel').onclick = () => $('#docs-dlg').close();
const drop = $('#docs-drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => analyzeFiles([...e.dataTransfer.files]));
$('#docs-files').onchange = e => analyzeFiles([...e.target.files]);

async function analyzeFiles(files, forRow = null) {
  files = files.filter(f => /\.(pdf|docx?|png|jpe?g)$/i.test(f.name) || /^image\/(png|jpeg)$/.test(f.type));
  if (!files.length) return;
  for (const f of files) docResults.push({ file: f.name, pending: true });
  parsing += files.length; renderHome();
  renderDocs();
  for (const f of files) {
    const slot = docResults.find(r => r.pending && r.file === f.name);
    try {
      const res = await fetch(u(`/api/facilities/${encodeURIComponent(facility)}/documents/analyze?name=${encodeURIComponent(f.name)}`), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      Object.assign(slot, d, { pending: false, include: !!d.row });
      if (forRow) Object.assign(slot, { row: forRow, include: true }); // added from that entry: it belongs there
    } catch (e) { Object.assign(slot, { pending: false, error: e.message, include: false }); }
    parsing = Math.max(0, parsing - 1); renderHome();
    renderDocs();
  }
}

const docLife = r => r.lifetime || isLifetimeName((master?.items || []).find(i => i.row === r.row)?.name);
function renderDocs() {
  const options = r => `<option value="">— skip —</option>` + (master?.items || []).filter(i => !i.fixed)
    .map(i => `<option value="${i.row}"${i.row === r.row ? ' selected' : ''}>${esc(i.name)}</option>`).join('');
  $('#docs-result').innerHTML = docResults.length ? `<div class="table-wrap flat"><table class="docs-table"><thead><tr>
      <th></th><th>Document</th><th>Recognised as</th><th>Register entry</th><th>Issued</th><th>Expiry</th><th>Due</th><th>Notes</th></tr></thead><tbody>
    ${docResults.map((r, k) => r.pending ? `<tr><td></td><td class="file">${esc(r.file)}</td><td colspan="6"><span class="spin"></span> Reading…</td></tr>`
      : r.error ? `<tr><td></td><td class="file">${esc(r.file)}</td><td colspan="6" class="notes">${esc(r.error)}</td></tr>`
      : `<tr data-k="${k}">
        <td><input type="checkbox" data-f="include" ${r.include ? 'checked' : ''}></td>
        <td class="file">${esc(r.file)}${r.ocr ? '<br><span class="tag na">scanned – OCR</span>' : ''}</td>
        <td>${esc(r.typeLabel)}<br><span class="conf ${r.confidence}">${r.confidence} confidence</span></td>
        <td><select data-f="row">${options(r)}</select>${r.current ? `<div class="ev">now: ${esc(fmtDay(r.current.issued) || '—')} → ${esc(fmtDay(r.current.expiry) || '—')}</div>` : ''}</td>
        <td><input type="date" data-f="issued" value="${esc(r.issued)}"></td>
        ${docLife(r) ? `<td>${LIFETIME_CELL}</td><td><span class="date empty">—</span></td>` : `<td><input type="date" data-f="expiry" value="${esc(r.expiry)}"></td>
        <td><input type="date" data-f="due" value="${esc(r.due)}"></td>`}
        <td>${r.warnings?.length ? `<div class="notes">${r.warnings.map(esc).join('<br>')}</div>` : '<span class="tag ok">OK</span>'}
          ${r.evidence?.issued || r.evidence?.expiry ? `<div class="ev" title="Where the dates were found">${r.evidence.issued ? `Issued: ${esc(r.evidence.issued.slice(0, 80))}<br>` : ''}${r.evidence.expiry ? `Expiry: ${esc(r.evidence.expiry.slice(0, 80))}` : ''}</div>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>
    <p class="muted small">Due date = the day after expiry (the register's practice) – change it if needed. Documents left on "skip" or unticked are not applied.</p>` : '';
  $$('#docs-result tr[data-k]').forEach(tr => {
    const r = docResults[Number(tr.dataset.k)];
    tr.querySelectorAll('[data-f]').forEach(el => el.onchange = () => {
      const f = el.dataset.f;
      if (f === 'include') r.include = el.checked;
      else if (f === 'row') { r.row = el.value ? Number(el.value) : null; r.include = !!r.row; return renderDocs(); }
      else {
        r[f] = el.value;
        if (f === 'expiry' && el.value) { const due = new Date(Date.parse(el.value + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10); r.due = due; tr.querySelector('[data-f=due]').value = due; }
      }
      updateDocsButton();
    });
  });
  updateDocsButton();
}
function updateDocsButton() {
  const n = docResults.filter(r => r.include && r.row && !r.pending && !r.error).length;
  $('#docs-apply').disabled = !n;
  $('#docs-apply').textContent = n ? `Apply ${n} document${n === 1 ? '' : 's'} to the LEGAL REGISTER` : 'Apply to the LEGAL REGISTER';
}
$('#docs-form').onsubmit = async e => {
  e.preventDefault();
  const items = docResults.filter(r => r.include && r.row && !r.error).map(r => ({ token: r.token, file: r.file, row: r.row, issued: r.issued, expiry: docLife(r) ? '' : r.expiry, due: docLife(r) ? '' : r.due }));
  const rows = items.map(i => i.row);
  if (new Set(rows).size !== rows.length) { $('#docs-msg').textContent = 'Two documents are mapped to the same entry – untick one.'; return; }
  const other = docResults.filter(r => r.include && r.warnings?.some(w => /another facility/.test(w)));
  if (other.length && !confirm(`${other.length} document(s) do not mention ${status?.facility?.name || 'this facility'}:\n${other.map(r => '• ' + r.file).join('\n')}\n\nApply them to this facility anyway?`)) return;
  $('#docs-msg').textContent = 'Applying…'; $('#docs-apply').disabled = true;
  try {
    const r = await api(`/api/facilities/${encodeURIComponent(facility)}/documents/apply`, { method: 'POST', body: JSON.stringify({ items }) });
    $('#docs-dlg').close();
    await loadMaster(); refresh();
    $('#master-alert').insertAdjacentHTML('afterbegin', `<div class="alert ok">${r.applied.length} entr${r.applied.length === 1 ? 'y' : 'ies'} updated from documents (backup taken)${r.releaseDate ? ` · Date of Release: ${fmtDay(r.releaseDate)}` : ''}.</div>`);
  } catch (err) { $('#docs-msg').textContent = `Not applied: ${err.message}`; updateDocsButton(); }
};

// ===================================================================================================
// Documents (PDF / DOCX / DOC): read, preview, apply
// ===================================================================================================
async function readDoc(fileInput, pathValue, template) {
  if (fileInput.files[0]) {
    const f = fileInput.files[0];
    const res = await fetch(`/api/policy/parse?name=${encodeURIComponent(f.name)}&template=${encodeURIComponent(template || '')}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    return d;
  }
  if (pathValue.trim()) return apiGlobal('/api/policy/parse-path', { method: 'POST', body: JSON.stringify({ path: pathValue, template }) });
  throw new Error('Choose a document (PDF, .docx or .doc) or enter its path');
}
const docSummary = (p, extra = '') => {
  const f = p.fields;
  return `<div class="alert ${p.warnings.some(w => /not found/.test(w)) ? 'warn' : 'ok'}">${p.logo ? `<img class="policy-logo" src="${p.logo.dataUrl}" alt="">` : ''}<b>${esc(p.policyTitle || 'Document read')}</b> <span class="small">(${esc((p.kind || '').toUpperCase())})</span><br>
    ${esc(f.code || '–')} · ${esc(f.name || '–')} · approver ${esc(f.approver || '–')} · author ${esc(f.authors || '–')} · responsible ${esc(f.responsible || '–')}${extra}
    ${p.warnings.length ? `<br><span class="small">${p.warnings.map(esc).join(' · ')}</span>` : ''}</div>`;
};

// Import into the current facility
let impSource = null, impPreview = null;
function openImport() {
  $('#import-form').reset(); impSource = null; impPreview = null;
  $('#imp-result').innerHTML = ''; $('#imp-msg').textContent = ''; $('#imp-apply').disabled = true;
  $('#import-dlg').showModal();
}
$('#btn-import').onclick = openImport;
$('#btn-import-2').onclick = openImport;
$('#imp-cancel').onclick = () => $('#import-dlg').close();
async function readImport() {
  $('#imp-result').innerHTML = '<p class="muted">Reading the document…</p>';
  $('#imp-apply').disabled = true;
  try {
    const d = await readDoc($('#imp-file'), $('#imp-path').value, facility);
    impSource = { policyToken: d.policyToken, policyPath: d.policyPath, policyName: d.policyName };
    impPreview = await api(`/api/facilities/${encodeURIComponent(facility)}/document/preview`, { method: 'POST', body: JSON.stringify(impSource) });
    const rows = impPreview.entries.map((e, k) => {
      const cell = key => {
        const nv = e[key], ov = e.current[key];
        if (nv === undefined || nv === null) return `<span class="same">${esc(key === 'responsible' || key === 'compliance' ? ov : fmtDay(ov) || '—')}</span>`;
        const shown = key === 'responsible' || key === 'compliance' ? nv : (fmtDay(nv) || '—');
        return (nv === ov) ? `<span class="same">${esc(shown)}</span>` : `<span class="new">${esc(shown)}</span>`;
      };
      return `<tr><td><input type="checkbox" data-imp="${k}" checked></td><td>${esc(e.name)}</td><td>${cell('issued')}</td><td>${cell('expiry')}</td><td>${cell('due')}</td><td>${cell('responsible')}</td><td>${cell('compliance')}</td></tr>`;
    }).join('');
    $('#imp-result').innerHTML = docSummary(impPreview.parsed) + `
      <label class="check"><input type="checkbox" id="imp-header" checked> Update facility details (name, title, approver, author, responsible person)</label>
      <label class="check"><input type="checkbox" id="imp-logo" ${impPreview.parsed.logo ? 'checked' : 'disabled'}> Use this logo in the Excel register${impPreview.parsed.logo ? '' : ' (no logo found)'}</label>
      ${impPreview.entries.length ? `<p class="small"><b>${impPreview.entries.length}</b> register entr${impPreview.entries.length === 1 ? 'y' : 'ies'} found – new values in green:</p>
      <div class="table-wrap flat"><table class="imp-table"><thead><tr><th></th><th>Entry</th><th>Issued</th><th>Expiry</th><th>Due</th><th>Responsible</th><th>Compliance</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="muted small">No register entries (department / certificate dates) were found in this document.</p>'}`;
    $('#imp-apply').disabled = false;
  } catch (e) { $('#imp-result').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
}
$('#imp-file').onchange = () => { $('#imp-path').value = ''; readImport(); };
$('#imp-read').onclick = readImport;
$('#import-form').onsubmit = async e => {
  e.preventDefault();
  if (!impSource || !impPreview) return;
  const entries = impPreview.entries.filter((_, k) => $(`[data-imp="${k}"]`)?.checked);
  $('#imp-msg').textContent = 'Applying…'; $('#imp-apply').disabled = true;
  try {
    await apiGlobal(`/api/facilities/${encodeURIComponent(facility)}/policy`, { method: 'POST', body: JSON.stringify({ ...impSource, header: $('#imp-header').checked, logo: $('#imp-logo').checked, entries }) });
    $('#import-dlg').close();
    await loadFacilities(); await refresh();
    if ($('#master').classList.contains('active')) await loadMaster();
    if ($('#settings').classList.contains('active')) await loadSettings();
    alert('The document was applied to this facility (backups taken).');
  } catch (err) { $('#imp-msg').textContent = `Not applied: ${err.message}`; $('#imp-apply').disabled = false; }
};

// ===================================================================================================
// DoH circulars
// ===================================================================================================
const decisionTag = c => {
  if (c.status === 'conflict') return '<span class="tag warn">Held – number conflict</span>';
  const f = c.values?.compliance || '';
  if (/not applicable/i.test(f)) return `<span class="tag na">${esc(f)}</span>`;
  if (/^fully/i.test(f)) return '<span class="tag ok">Fully Compliant</span>' + (isIt(c) ? ' <span class="tag it">IT</span>' : '');
  return f ? `<span class="tag warn">${esc(f)}</span>` : '';
};
const statusText = c => ({ added: 'Added', completed: 'Completed', detected: 'Detected (check)', awaiting_approval: 'Awaiting approval',
  pending_excel: 'Waiting – register locked', conflict: 'Manual check' }[c.status] || c.status || '') + (c.review ? ' · reviewed' : '');

hoverCards.circ = el => {
  const c = circulars.find(x => x.key === el.dataset.key);
  if (!c) return '';
  const target = hval(c.values?.targetDate);
  return `<div class="hc-head"><b>${esc(c.number)}</b>${decisionTag(c)}</div>
    <p class="hc-line">👤 ${esc(c.values?.responsible || '—')}${target && target !== '_' ? ` · 🎯 ${esc(target)}` : ''}</p>
    ${c.reason ? `<p class="hc-why">${esc(c.reason.length > 140 ? `${c.reason.slice(0, 140)}…` : c.reason)}</p>` : ''}`;
};
async function loadCirculars() { circulars = await api('/api/circulars'); renderCirculars(); }
function renderCirculars() {
  const q = $('#search').value.trim().toLowerCase();
  const rows = circulars.filter(c => {
    if (q && !`${c.number} ${c.name}`.toLowerCase().includes(q)) return false;
    if (filter === 'all') return true;
    if (filter === 'held') return ['conflict', 'awaiting_approval', 'pending_excel', 'detected'].includes(c.status);
    if (filter === 'it_related') return isIt(c);
    return c.decision === filter;
  });
  $('#tbl tbody').innerHTML = rows.map(c => `<tr data-key="${esc(c.key)}" data-hc="circ">
    <td class="num"><a href="${esc(c.url)}" target="_blank" onclick="event.stopPropagation()">${esc(c.number)}</a></td>
    <td class="name">${esc(c.name)}</td><td class="num">${esc(c.date)}</td><td>${esc(c.category)}</td>
    <td>${decisionTag(c)}</td><td>${esc(c.values?.responsible)}</td><td class="num">${esc(hval(c.values?.targetDate))}</td>
    <td>${esc(c.values?.frequency)}</td><td class="num">${esc(c.excelRow)}</td><td>${esc(statusText(c))}</td></tr>`).join('')
    || '<tr><td colspan="10" class="muted">No circulars processed yet for this facility. Run monitoring from the Overview.</td></tr>';
  $$('#tbl tbody tr[data-key]').forEach(tr => tr.onclick = () => openReview(tr.dataset.key));
}
$$('#filters button').forEach(b => b.onclick = () => { filter = b.dataset.f; $$('#filters button').forEach(x => x.classList.toggle('active', x === b)); renderCirculars(); });
$('#search').oninput = renderCirculars;

function openReview(key) {
  const c = circulars.find(x => x.key === key);
  if (!c) return;
  const f = $('#review-form');
  $('#rv-title').textContent = `${c.number} – ${c.name}`;
  $('#rv-sub').textContent = `${c.date || ''} · ${c.category || ''}${c.excelRow ? ` · Register row ${c.excelRow}` : ''}`;
  $('#rv-reason').innerHTML = `<b>Automatic decision:</b> ${esc(c.reason || '–')}<br><b>Document:</b> ${esc(c.docStatus || '–')}` +
    (c.review ? `<br><b>Reviewed</b> by ${esc(c.review.reviewer)} on ${fmt(c.review.at)}${c.review.note ? ` – ${esc(c.review.note)}` : ''}` : '');
  for (const k of ['compliance', 'responsible', 'frequency', 'authority']) f.elements[k].value = c.values?.[k] ?? '';
  if (f.elements.compliance.selectedIndex < 0) f.elements.compliance.selectedIndex = 0;
  f.elements.targetDate.value = hval(c.values?.targetDate);
  f.elements.note.value = c.review?.note || '';
  f.elements.reviewer.value = store.get('reviewer') || '';
  $('#rv-pdf').href = c.url || '#';
  $('#rv-save').disabled = !c.excelRow;
  $('#rv-msg').textContent = c.excelRow ? '' : 'Not in the register yet.';
  $('#review').returnValue = '';
  $('#review').showModal();
  $('#review').dataset.key = key;
}
$('#review').addEventListener('close', async () => {
  const dlg = $('#review');
  if (dlg.returnValue !== 'save') return;
  const f = $('#review-form');
  const values = Object.fromEntries(['compliance', 'responsible', 'targetDate', 'frequency', 'authority'].map(k => [k, f.elements[k].value]));
  store.set('reviewer', f.elements.reviewer.value);
  try {
    await api(`/api/circulars/${encodeURIComponent(dlg.dataset.key)}/review`, { method: 'POST', body: JSON.stringify({ values, reviewer: f.elements.reviewer.value, note: f.elements.note.value }) });
    await loadCirculars(); refresh();
  } catch (e) { alert(`Not saved: ${e.message}`); }
});

// ===================================================================================================
// History / log
// ===================================================================================================
async function loadRuns() {
  const runs = await api('/api/runs');
  $('#runs tbody').innerHTML = runs.map(r => `<tr><td class="num">${fmt(r.started)}</td><td>${esc(r.trigger)}</td><td>${esc(r.mode)}</td>
    <td>${tagFor(r.status, r.statusLabel)}</td><td>${r.totalChecked ?? ''}</td><td>${r.newCount ?? ''}</td><td>${r.added ?? ''}</td>
    <td>${r.filled ?? ''}</td><td>${r.reviewCount ?? ''}</td><td class="small">${(r.errors || []).map(esc).join('<br>')}</td>
    <td>${r.report ? `<a href="${u(`/reports/${encodeURIComponent(r.report)}`)}" target="_blank">Report</a>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="11" class="muted">No runs yet.</td></tr>';
}
async function loadLog() {
  const lines = await api('/api/log');
  $('#logbox').textContent = lines.join('\n') || 'Log is empty.';
  $('#logbox').scrollTop = 1e9;
}

// ===================================================================================================
// Settings
// ===================================================================================================
async function loadSettings() {
  const s = await api('/api/settings');
  const p = s.facilityProfile;
  const dc = await api('/api/document-control').catch(() => null);
  const df = $('#doc-form');
  df.elements.facilityTitle.value = p.title || '';
  df.elements.code.value = p.code || '';
  df.elements.releaseDate.value = p.releaseDate || '';
  df.elements.approver.value = p.approver || '';
  df.elements.authors.value = p.authors || '';
  $('#fx-version').value = s.fixed.version;
  if (dc) {
    const diff = ['facilityTitle', 'documentNumber', 'releaseDate', 'approver', 'authors', 'version'].filter(k => String(dc.workbook[k] ?? '').trim() !== String(dc.values[k] ?? '').trim());
    $('#doc-msg').textContent = diff.length ? `The Excel register differs for: ${diff.join(', ')} – save to update it.` : 'The Excel register matches.';
  } else $('#doc-msg').textContent = '';
  const pf = $('#profile-form');
  pf.elements.name.value = p.name || '';
  pf.elements.responsible.value = p.responsible || '';
  pf.elements.responsibleOptions.value = (p.responsibleOptions || []).join('\n');
  pf.elements.emailTo.value = (p.emailTo || []).join(', ');
  pf.elements.scopeStartDate.value = p.register?.scopeStartDate || '';
  pf.elements.makeDefault.checked = facilities.find(f => f.id === p.id)?.isDefault || false;
  $('#it-dept').value = s.itDepartment;
  $('#pol-current').textContent = p.policyPath || 'none';
  $('#src-current').textContent = p.registerPath || 'none linked';
  $('#src-preview').innerHTML = ''; $('#src-actions').hidden = true; $('#src-file').value = ''; $('#src-path').value = '';
  $('#btn-fac-delete').disabled = facilities.find(f => f.id === p.id)?.isDefault || false;
  $('#btn-fac-delete').title = $('#btn-fac-delete').disabled ? 'The default facility cannot be removed – make another facility the default first' : '';

  const f = $('#settings-form');
  const get = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
  for (const el of f.elements) {
    if (!el.name || ['nightlyTime', 'summaryTime', 'runDay', 'smtpPassword', 'portalPassword'].includes(el.name)) continue;
    const v = get(s, el.name);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = Array.isArray(v) ? v.join(el.tagName === 'TEXTAREA' ? '\n' : ', ') : v ?? '';
  }
  f.elements.nightlyTime.value = cronToTime(s.schedule.nightlyCron) || '02:00';
  f.elements.runDay.value = cronDay(s.schedule.nightlyCron);
  f.elements.summaryTime.value = cronToTime(s.schedule.summaryCron) || '07:30';
  $('#status-list').value = (status?.complianceOptions || []).map(statusLabel).join(' / ');
  f.elements.smtpPassword.placeholder = s.hasSmtpPassword ? 'saved – leave blank to keep' : 'not set';
}

$('#doc-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const values = Object.fromEntries(['facilityTitle', 'code', 'approver', 'authors'].map(k => [k, f.elements[k].value]));
  try {
    const r = await api('/api/document-control', { method: 'PUT', body: JSON.stringify({ values, writeWorkbook: f.elements.writeWorkbook.checked }) });
    await loadFacilities(); await refresh(); await loadSettings();
    $('#doc-msg').textContent = f.elements.writeWorkbook.checked ? `Saved${r.changed.length ? ` – ${r.changed.length} Excel cell(s) updated (backup taken)` : ' – Excel already up to date'}.` : 'Saved to the portal only.';
  } catch (err) { $('#doc-msg').textContent = `Not saved: ${err.message}`; }
};

$('#profile-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.elements.name.value, responsible: f.elements.responsible.value,
    responsibleOptions: f.elements.responsibleOptions.value.split('\n').filter(x => x.trim()),
    emailTo: f.elements.emailTo.value.split(/[,;]/).map(x => x.trim()).filter(Boolean),
    scopeStartDate: f.elements.scopeStartDate.value, makeDefault: f.elements.makeDefault.checked,
  };
  try {
    await apiGlobal(`/api/facilities/${encodeURIComponent(facility)}`, { method: 'PUT', body: JSON.stringify(body) });
    $('#profile-msg').textContent = 'Saved.';
    loadFacilities(); refresh();
  } catch (err) { $('#profile-msg').textContent = `Not saved: ${err.message}`; }
};

// Master Excel source (upload or link a workbook)
let pendingSource = null;
const workbookPreview = p => { const h = p.header || {}; return `<div class="alert ${p.ok ? 'ok' : 'bad'}"><b>${p.ok ? 'Workbook accepted' : 'Workbook not accepted'}</b><br>
  ${p.circulars} circular(s)${p.latest ? `, latest ${esc(p.latest)}` : ''} · ${p.entries} register entries · ${p.coreLaws}/6 fixed regulations<br>
  ${esc(h.facilityTitle || '–')} · ${esc(h.documentNumber || '–')}${p.problems.length ? `<br><b>Problems:</b> ${p.problems.map(esc).join('; ')}` : ''}${p.warnings.length ? `<br>${p.warnings.map(esc).join('; ')}` : ''}</div>`; };
$('#btn-src-check').onclick = async () => {
  $('#src-preview').innerHTML = '<p class="muted">Checking…</p>';
  try {
    if ($('#src-file').files[0]) {
      const file = $('#src-file').files[0];
      const res = await fetch(`/api/facilities/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const d = await res.json(); if (!res.ok) throw new Error(d.error);
      pendingSource = { source: 'upload', token: d.token, name: d.name, preview: d.preview };
    } else if ($('#src-path').value.trim()) {
      const d = await apiGlobal('/api/facilities/check-path', { method: 'POST', body: JSON.stringify({ path: $('#src-path').value }) });
      pendingSource = { source: 'link', path: d.path, preview: d.preview };
    } else throw new Error('Choose a workbook or enter a path');
    $('#src-preview').innerHTML = workbookPreview(pendingSource.preview);
    $('#src-actions').hidden = !pendingSource.preview.ok;
  } catch (e) { $('#src-preview').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
};
$('#btn-src-use').onclick = async () => {
  if (!pendingSource || !confirm('Use this workbook as the Excel register for this facility?')) return;
  try {
    const { preview, ...body } = pendingSource;
    const d = await apiGlobal(`/api/facilities/${encodeURIComponent(facility)}/register`, { method: 'POST', body: JSON.stringify({ ...body, importHeader: $('#src-import').checked }) });
    pendingSource = null;
    await loadFacilities(); await refresh(); await loadSettings();
    $('#src-preview').innerHTML = `<div class="alert ok">Now using ${esc(d.path)}.</div>`;
  } catch (e) { $('#src-preview').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
};

// Shared settings
$('#settings-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, body = {};
  const set = (o, p, v) => { const ks = p.split('.'); ks.slice(0, -1).reduce((a, k) => (a[k] ??= {}), o)[ks.at(-1)] = v; };
  for (const el of f.elements) {
    if (!el.name || ['nightlyTime', 'summaryTime', 'runDay', 'smtpPassword', 'portalPassword'].includes(el.name)) continue;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number') v = Number(v);
    if (el.tagName === 'TEXTAREA') v = v.split('\n').map(x => x.trim()).filter(Boolean);
    if (el.name === 'email.to') v = v.split(/[,;]/).map(x => x.trim()).filter(Boolean);
    set(body, el.name, v);
  }
  set(body, 'schedule.nightlyCron', timeToCron(f.elements.nightlyTime.value, f.elements.runDay.value));
  set(body, 'schedule.summaryCron', timeToCron(f.elements.summaryTime.value, f.elements.runDay.value));
  if (f.elements.smtpPassword.value) body.smtpPassword = f.elements.smtpPassword.value;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    $('#settings-msg').textContent = 'Saved. Schedule updated.';
    f.elements.smtpPassword.value = '';
    refresh();
  } catch (err) { $('#settings-msg').textContent = `Not saved: ${err.message}`; }
};
$('#btn-test-mail').onclick = async () => {
  try { await api('/api/email/test', { method: 'POST' }); alert('Test e-mail sent.'); }
  catch (e) { alert(`Test e-mail failed: ${e.message}\n(Save the settings first.)`); }
};

// ===================================================================================================
// Add facility (3 steps: document -> details -> Excel register)
// ===================================================================================================
let addDoc = null;
$('#btn-add-facility').onclick = () => {
  $('#add-form').reset(); addDoc = null;
  $('#add-preview').innerHTML = ''; $('#add-msg').textContent = ''; $('#add-policy-msg').innerHTML = ''; $('#add-release').value = '';
  $('#add-logo').hidden = true; $('#add-logo-none').hidden = false; $('#add-logo-none').textContent = 'Logo appears here';
  $('#add-dlg').showModal();
};
$('#add-cancel').onclick = () => $('#add-dlg').close();
async function readAddDoc() {
  const f = $('#add-form');
  $('#add-policy-msg').innerHTML = '<p class="muted">Reading the document…</p>';
  try {
    const d = await readDoc($('#add-policy-file'), $('#add-policy-path').value, f.elements.templateFrom.value);
    addDoc = d;
    const p = d.parsed.fields;
    for (const k of ['code', 'name', 'title', 'approver', 'authors', 'responsible']) if (p[k]) f.elements[k].value = p[k];
    $('#add-release').value = d.releaseDate ? `${fmtDay(d.releaseDate)} (latest circular)` : 'set from the register';
    if (d.parsed.logo) { $('#add-logo').src = d.parsed.logo.dataUrl; $('#add-logo').hidden = false; $('#add-logo-none').hidden = true; }
    else { $('#add-logo').hidden = true; $('#add-logo-none').hidden = false; $('#add-logo-none').textContent = 'No logo found – the template logo is kept'; }
    const n = d.parsed.entries?.length || 0;
    $('#add-policy-msg').innerHTML = docSummary(d.parsed, n ? ` · <b>${n}</b> register entr${n === 1 ? 'y' : 'ies'} with dates` : '');
  } catch (e) { addDoc = null; $('#add-policy-msg').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
}
$('#add-policy-file').onchange = () => { $('#add-policy-path').value = ''; readAddDoc(); };
$('#add-policy-read').onclick = readAddDoc;
$('#add-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, src = f.elements.source.value;
  const body = Object.fromEntries(['code', 'name', 'title', 'approver', 'authors', 'responsible', 'templateFrom'].map(k => [k, f.elements[k].value]));
  body.source = src;
  if (addDoc) Object.assign(body, { policyToken: addDoc.policyToken, policyPath: addDoc.policyPath, policyName: addDoc.policyName });
  $('#add-create').disabled = true;
  $('#add-msg').textContent = src === 'template' ? 'Creating the facility and its Excel register…' : 'Checking the workbook…';
  try {
    if (src === 'upload' || src === 'link') {
      let preview;
      if (src === 'upload') {
        const file = $('#add-file').files[0];
        if (!file) throw new Error('Choose the workbook to upload');
        const res = await fetch(`/api/facilities/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
        const d = await res.json(); if (!res.ok) throw new Error(d.error);
        Object.assign(body, { token: d.token, fileName: d.name }); preview = d.preview;
      } else {
        const d = await apiGlobal('/api/facilities/check-path', { method: 'POST', body: JSON.stringify({ path: f.elements.path.value }) });
        Object.assign(body, { path: d.path }); preview = d.preview;
      }
      $('#add-preview').innerHTML = workbookPreview(preview);
      if (!preview.ok) throw new Error('Workbook not accepted');
    }
    const d = await apiGlobal('/api/facilities', { method: 'POST', body: JSON.stringify(body) });
    $('#add-dlg').close();
    await loadFacilities();
    selectFacility(d.id);
  } catch (err) { $('#add-msg').textContent = `Not created: ${err.message}`; }
  finally { $('#add-create').disabled = false; }
};

// ===================================================================================================
// Signed-in user: roles, sign-out, user administration, own account
// ===================================================================================================
let me = null;
const ROLE_LABEL = { admin: 'Administrator', manager: 'Manager', viewer: 'Viewer' };
function applyRole() {
  document.body.classList.toggle('ro', me.role === 'viewer');
  document.body.classList.toggle('not-admin', me.role !== 'admin');
  $('#me-name').textContent = me.username;
  $('#me-role').textContent = ROLE_LABEL[me.role] || me.role;
  const hour = Number(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', hour12: false }));
  $('#home-hello').innerHTML = `Welcome back, ${esc(me.username)}<span class="h-dim"><mark>your compliance, on autopilot</mark></span>`;
  $('#me-avatar').textContent = me.username.slice(0, 1);
  $('#me-info').innerHTML = `Signed in as <b>${esc(me.username)}</b> · ${ROLE_LABEL[me.role]} · two-factor authentication <b>${me.twoFactor ? 'on' : 'off'}</b>${me.lastLogin ? ` · last sign-in ${fmt(me.lastLogin)}` : ''}`;
  if (me.role === 'viewer') { // viewers: settings show only their own account
    $$('#subtabs button').forEach(x => x.classList.toggle('active', x.dataset.sub === 'account-panel'));
    $$('#settings .sub').forEach(t => t.classList.toggle('active', t.id === 'account-panel'));
  }
}
$('#btn-logout').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.replace('/login.html'); };

/** Access requests (self sign-up) waiting for approval: shown in Users & security and as a badge in the menu. */
function renderPending(all) {
  const pend = all.filter(x => x.status === 'pending');
  $('#sb-pending').hidden = !pend.length; $('#sb-pending').textContent = pend.length;
  $('#pending-panel').hidden = !pend.length; $('#pending-count').textContent = pend.length;
  const facBoxes = uid => `<label class="check"><input type="checkbox" value="*"> All facilities</label>` +
    facilities.map(f => `<label class="check"><input type="checkbox" value="${esc(f.id)}"${facilities.length === 1 ? ' checked' : ''}> ${esc(f.code)} – ${esc(f.name)}</label>`).join('');
  $('#pending-list').innerHTML = pend.map(x => `<article class="pend" data-uid="${x.id}">
      <span class="avatar">${esc(x.fullName || x.username).slice(0, 1).toUpperCase()}</span>
      <div class="pend-who"><b>${esc(x.fullName || x.username)}</b><small>${esc(x.username)} · ${esc(x.email)} · asked ${fmt(x.createdAt)}</small>${x.requestNote ? `<p>“${esc(x.requestNote)}”</p>` : ''}</div>
      <div class="pend-set">
        <label>Role<select data-f="role"><option value="viewer">Viewer – read only</option><option value="manager">Manager – can edit</option></select></label>
        <div class="pend-facs"><span>Facilities</span>${facilities.length ? facBoxes(x.id) : '<em class="muted small">No facility yet – approve now and give access later (Change access)</em>'}</div>
      </div>
      <div class="pend-act"><button type="button" class="btn primary small" data-act="approve">✓ Approve</button><button type="button" class="btn small danger-txt" data-act="decline">Decline</button></div>
    </article>`).join('');
  $$('#pending-list .pend').forEach(card => card.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
    const x = pend.find(p => p.id === card.dataset.uid);
    try {
      if (b.dataset.act === 'decline') {
        if (!confirm(`Decline the request from ${x.fullName || x.username}? The request is deleted.`)) return;
        await apiGlobal(`/api/users/${x.id}`, { method: 'DELETE' });
      } else {
        const facs = [...card.querySelectorAll('.pend-facs input:checked')].map(i => i.value);
        if (facilities.length && !facs.length) { alert('Choose at least one facility (or All facilities).'); return; }
        await apiGlobal(`/api/users/${x.id}`, { method: 'PUT', body: JSON.stringify({ approve: true, role: card.querySelector('[data-f=role]').value, facilities: facs.includes('*') ? ['*'] : facs }) });
      }
      loadUsersPanel();
    } catch (e) { alert(e.message); }
  }));
}
async function loadPendingBadge() {
  if (me?.role !== 'admin') return;
  try { const { users } = await apiGlobal('/api/users'); renderPending(users); } catch { /* badge only */ }
}

async function loadUsersPanel() {
  if (me?.role !== 'admin') return;
  const { users: all } = await apiGlobal('/api/users');
  renderPending(all);
  const users = all.filter(x => x.status !== 'pending');
  const facName = id => { const f = facilities.find(x => x.id === id); return f ? `${f.code} – ${f.name}` : `${id} (removed)`; };
  const scope = x => x.role === 'admin' ? '<span class="scope all" title="Administrators see and manage every facility">All facilities · full control</span>'
    : x.facilities.includes('*') ? '<span class="scope all">All facilities</span>'
    : x.facilities.length ? `<div class="scope-list">${x.facilities.map(id => `<span class="scope">${esc(facName(id))}</span>`).join('')}</div>`
    : '<span class="scope none">No facility – sees nothing</span>';
  $('#users-tbl tbody').innerHTML = users.map(x => `<tr>
    <td><b>${esc(x.username)}${x.id === me.id ? '<span class="users-me">you</span>' : ''}</b><span class="muted small" title="${esc(x.email || '')}">${esc(x.email || 'no e-mail')}</span></td>
    <td><select data-uid="${x.id}" data-f="role">${['admin', 'manager', 'viewer'].map(r => `<option value="${r}"${r === x.role ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select></td>
    <td>${x.role === 'admin' ? '<span class="tag ok">Premium</span>' : `<select data-uid="${x.id}" data-f="plan" aria-label="Plan"><option value="trial"${x.plan === 'trial' ? ' selected' : ''}>Free trial</option><option value="premium"${x.plan === 'premium' ? ' selected' : ''}>Premium</option></select>${x.plan === 'trial' ? '<br><span class="muted small">Trial limits apply</span>' : ''}${x.premiumRequest ? '<br><span class="tag warn">Asked for Premium</span>' : ''}`}</td>
    <td class="small">${scope(x)}${x.role === 'admin' ? '' : `<button type="button" class="link-btn small scope-edit" data-act="access" data-uid="${x.id}">Change access</button>`}</td>
    <td>${x.twoFactor ? '<span class="tag ok">On</span>' : '<span class="tag warn">At next sign-in</span>'}${x.locked ? ' <span class="tag bad">Locked</span>' : ''}${x.mustChangePassword ? ' <span class="tag na">Temp. password</span>' : ''}</td>
    <td class="num">${x.lastLogin ? fmt(x.lastLogin) : 'Never'}</td>
    <td><details class="menu user-manage"><summary class="btn small">Manage ▾</summary><div class="menu-pop right">
      ${x.locked ? `<button class="icon-btn" data-act="unlock" data-uid="${x.id}">Unlock</button>` : ''}
      <button class="icon-btn" data-act="reset-pw" data-uid="${x.id}">Reset password</button>
      <button class="icon-btn" data-act="reset-2fa" data-uid="${x.id}">Reset 2FA</button>
      ${x.id === me.id ? '' : `<button class="icon-btn del" data-act="delete" data-uid="${x.id}">Delete account</button>`}
    </div></details></td></tr>`).join('');
  $$('#users-tbl [data-f=role]').forEach(sel => sel.onchange = async () => {
    try { await apiGlobal(`/api/users/${sel.dataset.uid}`, { method: 'PUT', body: JSON.stringify({ role: sel.value }) }); loadUsersPanel(); }
    catch (e) { alert(e.message); loadUsersPanel(); }
  });
  $$('#users-tbl [data-f=plan]').forEach(sel => sel.onchange = async () => {
    try { await apiGlobal(`/api/users/${sel.dataset.uid}`, { method: 'PUT', body: JSON.stringify({ plan: sel.value }) }); toast(`Plan changed to ${sel.value === 'premium' ? 'Premium' : 'Free trial'}`); loadUsersPanel(); }
    catch (e) { alert(e.message); loadUsersPanel(); }
  });
  loadLimits(); loadWelcomeForm();
  $$('#users-tbl [data-act]').forEach(b => b.onclick = async () => {
    const u = users.find(x => x.id === b.dataset.uid), act = b.dataset.act;
    try {
      if (act === 'delete') { if (!confirm(`Delete the account "${u.username}"?`)) return; await apiGlobal(`/api/users/${u.id}`, { method: 'DELETE' }); }
      if (act === 'unlock') await apiGlobal(`/api/users/${u.id}`, { method: 'PUT', body: JSON.stringify({ unlock: true }) });
      if (act === 'access') { await editAccess(u); return; }
      if (act === 'reset-2fa') { if (!confirm(`Reset two-factor authentication for "${u.username}"? They will scan a new QR code at their next sign-in.`)) return; await apiGlobal(`/api/users/${u.id}`, { method: 'PUT', body: JSON.stringify({ resetTwoFactor: true }) }); }
      if (act === 'reset-pw') {
        const pw = genPassword();
        if (!confirm(`Set a new temporary password for "${u.username}"?\n\nTemporary password: ${pw}\n\nGive it to the user securely – they must change it at their next sign-in.`)) return;
        await apiGlobal(`/api/users/${u.id}`, { method: 'PUT', body: JSON.stringify({ password: pw, mustChangePassword: true }) });
      }
      loadUsersPanel();
    } catch (e) { alert(e.message); }
  });
  $('#user-facs').innerHTML = `<label class="check"><input type="checkbox" value="*"> All facilities</label>` +
    facilities.map(f => `<label class="check"><input type="checkbox" value="${esc(f.id)}"> ${esc(f.code)} – ${esc(f.name)}</label>`).join('');
}
/** Which facilities a user may open: tick them; nothing ticked = no access at all. Saved at once. */
function editAccess(u) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'access-dlg';
    const all = u.facilities.includes('*');
    dlg.innerHTML = `<form method="dialog">
      <h2>Facility access – ${esc(u.username)}</h2>
      <p class="muted small">${esc(ROLE_LABEL[u.role] || u.role)}. They see and work on only the facilities ticked here – nothing else is shown to them. Nothing ticked = no access.</p>
      <label class="check access-all"><input type="checkbox" value="*"${all ? ' checked' : ''}> All facilities (also every new one)</label>
      <div class="access-list">${facilities.map(f => `<label class="check"><input type="checkbox" value="${esc(f.id)}"${!all && u.facilities.includes(f.id) ? ' checked' : ''}${all ? ' disabled' : ''}> <b>${esc(f.code)}</b> ${esc(f.name)}${f.createdBy ? ` <span class="muted small">· created by ${esc(f.createdBy)}</span>` : ''}</label>`).join('') || '<p class="muted small">No facilities yet.</p>'}</div>
      <div class="btn-row"><button type="button" class="btn" value="cancel">Cancel</button><button type="submit" class="btn primary" value="save">Save access</button></div>
    </form>`;
    document.body.append(dlg);
    const allBox = dlg.querySelector('.access-all input');
    allBox.onchange = () => dlg.querySelectorAll('.access-list input').forEach(i => { i.disabled = allBox.checked; });
    dlg.querySelector('[value=cancel]').onclick = () => dlg.close();
    dlg.addEventListener('close', async () => {
      if (dlg.returnValue === 'save') {
        const facs = allBox.checked ? ['*'] : [...dlg.querySelectorAll('.access-list input:checked')].map(i => i.value);
        try { await apiGlobal(`/api/users/${u.id}`, { method: 'PUT', body: JSON.stringify({ facilities: facs }) }); toast(`Access saved – ${esc(u.username)} now sees ${facs[0] === '*' ? 'all facilities' : facs.length ? `${facs.length} facilit${facs.length > 1 ? 'ies' : 'y'}` : 'no facility'}`); }
        catch (e) { toast(`⚠ ${esc(e.message)}`); }
      }
      dlg.remove(); loadUsersPanel(); resolve();
    });
    dlg.showModal();
  });
}
const genPassword = () => { const a = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; const r = crypto.getRandomValues(new Uint32Array(14)); return [...r].map(n => a[n % a.length]).join('') + (r[0] % 10); };
$('#gen-pw').onclick = () => { $('#user-form').elements.password.value = genPassword(); };
$('#user-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const facs = $$('#user-facs input:checked').map(x => x.value);
  const body = { username: f.elements.username.value, email: f.elements.email.value, role: f.elements.role.value, plan: f.elements.plan.value, password: f.elements.password.value, facilities: facs.includes('*') ? ['*'] : facs };
  try {
    await apiGlobal('/api/users', { method: 'POST', body: JSON.stringify(body) });
    $('#user-msg').textContent = `User "${body.username}" added – they choose their own password and set up 2FA at first sign-in.`;
    f.reset(); loadUsersPanel();
  } catch (err) { $('#user-msg').textContent = `Not added: ${err.message}`; }
};
$('#pw-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  if (f.elements.next.value !== f.elements.next2.value) { $('#pw-msg').textContent = 'The new passwords do not match'; return; }
  try { await apiGlobal('/api/account/password', { method: 'POST', body: JSON.stringify({ current: f.elements.current.value, next: f.elements.next.value }) }); f.reset(); $('#pw-msg').textContent = 'Password changed.'; }
  catch (err) { $('#pw-msg').textContent = `Not changed: ${err.message}`; }
};
$$('#subtabs button').forEach(b => b.addEventListener('click', () => { if (b.dataset.sub === 'users-panel') loadUsersPanel(); }));

// ===================================================================================================
// Policy Document Preparation: templates -> details & pictures -> generate Word + PDF -> link to LEGAL REGISTER
// ===================================================================================================
let pp = null, ppTimer = null;
const PP_FIELD = { policyId: 'Policy ID', issued: 'Issued on', reviewed: 'Reviewed on', due: 'Due for revision', prepared: 'Prepared by',
  approved: 'Approved by', facility: 'Facility name', version: 'Version', history: 'Version history', logo: 'Logo', signature: 'Signature / stamp' };
const plusYear = iso => { if (!ISO.test(iso || '')) return ''; const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y + 1, m - 1, d)); if (t.getUTCDate() !== d) t.setUTCDate(0); return t.toISOString().slice(0, 10); };
const ppNo = n => `PO${String(n).padStart(2, '0')}`;

/** Master files of a policy per version: v1.0 / v2.0 chips; the one used for the chosen version is highlighted. */
function ppMasters(t, chosen) {
  const vs = Object.keys(t.variants || { [t.version]: 1 }).sort();
  const key = v => `${Math.max(1, Math.floor(Number(v) || 1))}.0`;
  const used = vs.includes(key(chosen)) ? key(chosen) : key(t.version);
  const chips = vs.map(v => `<span class="vchip${v === used ? ' used' : ''}" title="${v === used ? 'used for the chosen version' : 'stored master'}">v${v}</span>`).join(' ');
  const hint = (pp?.majorRevision || []).includes(t.no) && vs.length < 2 ? `<br><span class="muted">upload the ${vs.includes('2.0') ? 'v1.0' : 'v2.0'} file to keep both</span>` : '';
  const note = !vs.includes(key(chosen)) ? `<br><span class="muted">uses the v${used} master</span>` : '';
  return chips + note + hint;
}

/** Policies wizard: one step at a time; the step tabs show what is done. */
let pwStep = null, pwDone = {};
function pwShow(n) {
  pwStep = Number(n);
  $$('#policies .pw-pane').forEach(p => { p.hidden = Number(p.dataset.pane) !== pwStep; });
  $$('#pp-steps li').forEach(li => {
    const k = Number(li.dataset.pw);
    li.className = `${pwDone[k] ? 'done' : ''}${k === pwStep ? ' on' : ''}`;
    li.querySelector('i').textContent = pwDone[k] && k !== pwStep ? '✓' : k;
  });
}
$$('#pp-steps li button').forEach(b => b.onclick = () => pwShow(b.closest('li').dataset.pw));
$$('#policies [data-pw-go]').forEach(b => b.onclick = () => { pwShow(b.dataset.pwGo); $('#pp-steps').scrollIntoView({ behavior: 'smooth', block: 'start' }); });

async function loadPolicies() {
  clearTimeout(ppTimer);
  try { pp = await api('/api/policies'); } catch (e) { $('#pp-tpl-msg').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; return; }
  renderPolicies();
  if (pp.job?.running) ppTimer = setTimeout(loadPolicies, 1500);
}

function renderPolicies() {
  const s = pp.settings, t = pp.templates;
  // wizard: 1 details · 2 pictures · 3 create · 4 link
  const a = s.assets || {};
  pwDone = {
    1: ['issuedOn', 'reviewedOn', 'preparedBy', 'approvedBy'].every(k => String(s[k] || '').trim()),
    2: !!a.logo && (!!a.combined || (!!a.signature && !!a.stamp)),
    3: !!pp.files.word.length,
    4: !!pp.linked,
  };
  if (!pwStep) pwStep = Number(Object.keys(pwDone).find(k => !pwDone[k]) || 3);
  if (pp.job?.running) pwStep = 3;
  pwShow(pwStep);
  $('#pp-status').textContent = pp.job?.running ? 'Generating…' : pp.lastGenerated ? `${pp.lastGenerated.count} policies generated · ${fmt(pp.lastGenerated.at)}` : `${t.length} template${t.length === 1 ? '' : 's'}`;
  const L = pp.lock || {}, base = L.baseline || {};
  const isBase = base.name && base.name.toUpperCase() === String(s.facilityName).toUpperCase();
  $('#pp-for').innerHTML = isBase
    ? '<span>You are looking at</span><b>the master template</b><span class="muted small">· nothing is replaced here – create a facility to prepare its own policies.</span><button type="button" class="btn primary small" data-write onclick="npOpen()">＋ New facility</button>'
    : `<span>Preparing policies for</span><b>${esc(s.facilityName)}</b><span class="pp-code">${esc(s.code)}</span>` + (base.name ? '<span class="muted small">· the master template\'s name, code, e-mail and phone are replaced with this facility\'s details</span>' : '');
  // lock
  $('#pp-lockbar').hidden = !L.locked && !L.unlockedAt;
  $('#pp-lockbar').className = `pp-lockbar ${L.locked ? 'on' : 'off'}`;
  $('#pp-lockbar').innerHTML = L.locked
    ? `🔒 <b>Master template locked</b> · ${L.count} policies · locked ${fmt(L.at)}${L.by ? ` by ${esc(L.by)}` : ''}. The files are fingerprinted – structure, wording, layout and tables stay exactly as uploaded; each facility gets its own filled copy.`
    : `🔓 Unlocked ${L.unlockedAt ? fmt(L.unlockedAt) : ''}${L.unlockedBy ? ` by ${esc(L.unlockedBy)}` : ''} – templates can be replaced. Lock them again when done.`;
  $('#pp-upload-btn').hidden = !!L.locked;
  $('#pp-lock').hidden = !!L.locked || !t.length;
  $('#pp-unlock').hidden = !L.locked;
  $('#pp-email-note').textContent = base.emails?.length ? `replaces ${base.emails.join(', ')}` : 'incident contact';
  $('#pp-phone-note').textContent = base.phones?.length ? `replaces ${base.phones.join(', ')}` : 'incident contact';

  // 1. templates
  const ver = n => s.versions[n] || (pp.majorRevision.includes(n) ? '2.0' : '1.0');
  const vKey = v => `${Math.max(1, Math.floor(Number(v) || 1))}.0`;
  const used = x => x.variants?.[vKey(ver(x.no))] || x; // the master file used for the chosen version
  $('#pp-tpl-body').innerHTML = t.length ? t.map(x => `<tr>
      <td class="num"><b>${ppNo(x.no)}</b></td>
      <td class="name">${esc(used(x).title || x.title)}<br><span class="muted small">${esc(used(x).original || x.original)}${used(x).oldName ? ` · written for ${esc(used(x).oldName)}` : ''}${used(x).editedAt ? ` · <b>edited ${fmt(used(x).editedAt)}</b>` : ''}</span></td>
      <td>${Object.keys(x.variants || {}).length > 1
        ? `<input type="hidden" data-ver="${x.no}" value="${esc(ver(x.no))}"><div class="vtoggle" data-write>${Object.keys(x.variants).sort().map(v => `<button type="button" data-vt="${x.no}" data-v="${v}" class="${v === vKey(ver(x.no)) ? 'on' : ''}">${v}</button>`).join('')}</div>`
        : `<select data-ver="${x.no}" data-write>${['1.0', '2.0', '3.0'].map(v => `<option${v === ver(x.no) ? ' selected' : ''}>${v}</option>`).join('')}</select>`}</td>
      <td class="small">${ppMasters(x, ver(x.no))}</td>
      <td><input data-desc="${x.no}" data-write placeholder="${Number(ver(x.no)) >= 2 ? 'Major revision – policy updated' : 'Reviewed No Changes'}" value="${esc(s.descriptions[x.no] || '')}"></td>
      <td class="small">${(x.labels || []).length >= 4 && x.hasRevisionTable ? '<span class="tag ok">All fields</span>' : `<span class="tag warn">${(x.labels || []).length} fields${x.hasRevisionTable ? '' : ' · no version table'}</span>`}</td>
      <td><div class="row-actions">
        <button class="icon-btn" data-pm-open="${x.no}" data-pm-mode="view" title="See this master as a document">👁 View</button>
        <button class="icon-btn" data-admin data-pm-open="${x.no}" data-pm-mode="edit" title="Edit the text or add clauses">✎ Edit</button>
        ${pp.lock?.locked ? '<span class="muted small" title="Locked master">🔒</span>' : `<button class="icon-btn del" data-admin data-del-tpl="${x.no}">Remove</button>`}
      </div></td></tr>`).join('')
    : '<tr><td colspan="8" class="muted">No master policies yet – an administrator uploads the Word files (e.g. all 33 ADHICS policies) once.</td></tr>';
  $$('#pp-tpl-body [data-ver]').forEach(el => el.onchange = () => saveVersions());
  $$('#pp-tpl-body [data-vt]').forEach(b => b.onclick = () => { $(`#pp-tpl-body input[data-ver="${b.dataset.vt}"]`).value = b.dataset.v; saveVersions(); });
  $$('#pp-tpl-body [data-pm-open]').forEach(b => b.onclick = () => openMaster(Number(b.dataset.pmOpen), vKey(ver(Number(b.dataset.pmOpen))), b.dataset.pmMode));
  $$('#pp-tpl-body [data-desc]').forEach(el => el.onchange = () => saveVersions());
  $$('#pp-tpl-body [data-del-tpl]').forEach(b => b.onclick = async () => {
    if (!confirm(`Remove master policy ${ppNo(b.dataset.delTpl)} from the templates?`)) return;
    try { await apiGlobal(`/api/policies/templates/${b.dataset.delTpl}`, { method: 'DELETE' }); loadPolicies(); } catch (e) { alert(e.message); }
  });

  // 2. details
  const f = $('#pp-form');
  if (document.activeElement?.form !== f) {
    for (const k of ['standard', 'issuedOn', 'reviewedOn', 'preparedBy', 'approvedBy', 'contactEmail', 'contactPhone']) f.elements[k].value = s[k] || '';
  }
  $('#pp-fac').value = s.facilityName || '';
  $('#pp-idfmt').value = `${s.code} / ${f.elements.standard.value || 'ADHICS'} - PO01 … ${ppNo(Math.max(33, ...t.map(x => x.no)))}`;
  $('#pp-due').value = fmtDay(plusYear(f.elements.reviewedOn.value)) || '–';
  $$('#pp-assets .pp-asset').forEach(box => {
    const k = box.dataset.kind, img = box.querySelector('img'), has = s.assets[k];
    img.hidden = !has; box.querySelector('.pp-pic span').hidden = has;
    if (has) img.src = u(`/api/policies/assets/${k}?t=${Date.now()}`);
    box.querySelector('[data-remove]').hidden = !has || (k === 'logo' && s.usesFacilityLogo);
    box.classList.toggle('muted-box', k !== 'combined' && k !== 'logo' && s.assets.combined);
  });
  $('#pp-logo-note').textContent = s.usesFacilityLogo ? 'the facility logo – upload to use another' : 'top of every policy';

  // 3. generate
  const need = pp.need;
  $('#pp-need').innerHTML = need.length ? `<div class="alert warn">Still needed before generating: <b>${need.map(esc).join(' · ')}</b></div>` : '';
  $('#pp-generate').disabled = !!need.length || !!pp.job?.running;
  $('#pp-generate').innerHTML = pp.job?.running ? '<span class="spin"></span> Generating…' : `⚙ Create all ${t.length || ''} policies`;
  const j = pp.job;
  $('#pp-progress').hidden = !j?.running;
  if (j?.running) { $('#pp-bar').style.width = `${Math.round(((j.done || 0) / Math.max(1, j.total)) * 100)}%`; $('#pp-step').textContent = `${j.done}/${j.total} · ${j.step}`; }
  const val = j && !j.running ? j.validation : null;
  $('#pp-problems').innerHTML = (val ? `<div class="alert ${val.failed.length ? 'warn' : 'ok'}">${val.failed.length ? '⚠' : '✓'} Checked: <b>${val.passed} of ${val.total}</b> policies are correct for ${esc(s.facilityName)}${val.failed.length ? ` – please look at ${val.failed.map(esc).join(', ')}` : ''}.${val.pages ? ` <span class="muted small">${val.pages} pages · ${val.megabytes} MB</span>` : ''}</div>` : '') +
    (j && !j.running && j.problems?.length ? `<div class="alert warn">${j.problems.map(esc).join('<br>')}</div>` : '');
  const files = pp.files;
  $('#pp-out').hidden = !files.word.length && !files.pdf.length;
  $('#pp-folder').textContent = `Saved in ${files.folder} → Word\\ and PDF\\`;
  $('#pp-out-title').textContent = `${files.word.length} Word · ${files.pdf.length} PDF files`;
  $('#pp-zip-word').href = u('/api/policies/zip?type=word'); $('#pp-zip-pdf').href = u('/api/policies/zip?type=pdf'); $('#pp-zip-all').href = u('/api/policies/zip?type=all');
  const results = j?.results || [];
  $('#pp-out-body').innerHTML = files.word.map(w => {
    const no = Number(w.match(/PO(\d+)/)?.[1]);
    const r = results.find(x => x.no === no);
    const pdf = files.pdf.find(p => p.replace(/\.pdf$/, '') === w.replace(/\.docx$/, ''));
    const filled = r ? r.report.filled.map(k => PP_FIELD[k] || k) : null;
    if (trialLocked('policies', no)) { // free trial: only the first policies open – the rest are locked
      return `<tr class="trial-locked"><td class="name"><span class="lock-ic" aria-hidden="true">🔒</span>${esc(w.replace(/\.docx$/, ''))}</td><td>${esc(r?.version || '')}</td>
        <td class="small"><span class="muted">Part of Premium</span></td>
        <td><div class="row-actions"><button type="button" class="icon-btn premium-mini" data-up>🔒 Get Premium</button></div></td></tr>`;
    }
    return `<tr><td class="name">${esc(w.replace(/\.docx$/, ''))}</td><td>${esc(r?.version || '')}</td>
      <td class="small">${filled ? `${filled.length} items${r.report.missing.length ? ` · <span class="warn-txt">not found: ${r.report.missing.map(k => PP_FIELD[k] || k).join(', ')}</span>` : ''}${r.report.nameReplaced ? ` · name replaced ${r.report.nameReplaced}×` : ''}` : '<span class="muted">–</span>'}</td>
      <td><div class="row-actions"><a class="icon-btn" href="${u(`/api/policies/file?type=word&name=${encodeURIComponent(w)}`)}">Word</a>${pdf ? `<a class="icon-btn" target="_blank" data-view="${esc(pdf.replace(/\.pdf$/, ''))}" href="${u(`/api/policies/file?type=pdf&inline=1&name=${encodeURIComponent(pdf)}`)}">⤢ PDF</a>` : ''}</div></td></tr>`;
  }).join('');

  $('#pw-next-3').disabled = !files.word.length;
  // 4. link
  $('#pp-link').disabled = !files.word.length;
  $('#pp-link-msg').innerHTML = pp.linked ? `<div class="alert ok">Linked to the LEGAL REGISTER on ${fmt(pp.linked)}.</div>` : '';
}

async function saveVersions() {
  const versions = {}, descriptions = {};
  $$('#pp-tpl-body [data-ver]').forEach(el => { versions[el.dataset.ver] = el.value; });
  $$('#pp-tpl-body [data-desc]').forEach(el => { if (el.value.trim()) descriptions[el.dataset.desc] = el.value.trim(); });
  try { await api('/api/policies/settings', { method: 'PUT', body: JSON.stringify({ versions, descriptions }) }); loadPolicies(); }
  catch (e) { alert(`Not saved: ${e.message}`); }
}

// ===================================================================================================
// Master policy viewer / editor: version 1.0 / 2.0, view as document, edit text & add clauses, Word round trip
// ===================================================================================================
let pm = null; // { no, version, mode, data, edits: Map, inserts: [], deletes: Set }
const pmTpl = () => pp.templates.find(x => x.no === pm.no);
const pmDirty = () => pm && (pm.edits.size || pm.inserts.some(x => x.text.trim()) || pm.deletes.size);

async function openMaster(no, version, mode = 'view') {
  pm = { no, version, mode, data: null, edits: new Map(), inserts: [], deletes: new Set() };
  pmHeader();
  $('#pm-msg').textContent = '';
  $('#pm-dlg').showModal();
  pmShow(me?.role === 'admin' ? mode : 'view');
}
function pmHeader() {
  const t = pmTpl(), v = t.variants?.[pm.version] || t;
  $('#pm-title').textContent = `${ppNo(pm.no)} – ${(v.title || t.title).replace(/^ADHICS\s*[-–]\s*/i, '')}`;
  $('#pm-kicker').textContent = `Master policy · version ${pm.version}`;
  const chosen = `${Math.max(1, Math.floor(Number(pp.settings.versions[pm.no] || (pp.majorRevision.includes(pm.no) ? '2.0' : '1.0')) || 1))}.0`;
  $('#pm-vers').innerHTML = Object.keys(t.variants || { [t.version]: 1 }).sort().map(k =>
    `<button type="button" data-pmv="${k}" class="${k === pm.version ? 'on' : ''}">Version ${k}${k === chosen ? ' <small>used</small>' : ''}</button>`).join('');
  $$('#pm-vers [data-pmv]').forEach(b => b.onclick = () => {
    if (b.dataset.pmv === pm.version) return;
    if (pmDirty() && !confirm('Discard the unsaved changes?')) return;
    Object.assign(pm, { version: b.dataset.pmv, edits: new Map(), inserts: [], deletes: new Set(), data: null });
    pmHeader(); pmShow(pm.mode);
  });
  $('#pm-info').innerHTML = `${esc(v.original || v.file || '')} · written for <b>${esc(v.oldName || '–')}</b>` +
    (v.editedAt ? ` · edited ${fmt(v.editedAt)}${v.editedBy ? ` by ${esc(v.editedBy)}` : ''}` : '') +
    (pp.lock?.locked ? ' · 🔒 locked master' : '') +
    (pm.version === chosen ? ' · <span class="tag ok">used for this facility\'s policies</span>' : ` · <span class="tag na">not used – this facility uses version ${chosen}</span>`);
}
async function pmShow(mode) {
  pm.mode = mode;
  $$('#pm-tabs [data-pm]').forEach(b => b.classList.toggle('active', b.dataset.pm === mode));
  $$('#pm-dlg .pm-pane').forEach(p => { p.hidden = p.dataset.pane !== mode; });
  $('#pm-save').hidden = mode !== 'edit';
  const q = `version=${encodeURIComponent(pm.version)}`;
  if (mode === 'view') {
    $('#pm-view-msg').textContent = 'Preparing the document with Microsoft Word (about 10 seconds the first time)…';
    const fr = $('#pm-frame');
    fr.onload = () => { $('#pm-view-msg').textContent = 'The master exactly as stored – the facility details are filled in only when policies are generated.'; };
    fr.src = `/api/policies/templates/${pm.no}/view?${q}&t=${Date.now()}`;
  } else if (mode === 'edit') {
    if (!pm.data) {
      $('#pm-paras').innerHTML = '<li class="muted"><span class="spin"></span> Loading the paragraphs…</li>';
      try { pm.data = await apiGlobal(`/api/policies/templates/${pm.no}/paragraphs?${q}`); } catch (e) { $('#pm-paras').innerHTML = `<li class="alert bad">${esc(e.message)}</li>`; return; }
    }
    pmRender();
  } else {
    $('#pm-download').href = `/api/policies/templates/${pm.no}/view?${q}&format=docx`;
    $('#pm-file-msg').textContent = '';
  }
}
$$('#pm-tabs [data-pm]').forEach(b => b.onclick = () => pmShow(b.dataset.pm));

function pmRender() {
  const label = { heading: 'Heading', list: 'List item', text: '', picture: 'Picture', empty: '' };
  const rows = [];
  for (const p of pm.data.paragraphs) {
    if (p.kind === 'empty') continue;
    const del = pm.deletes.has(p.i), val = pm.edits.has(p.i) ? pm.edits.get(p.i) : p.text;
    rows.push(`<li class="pm-p k-${p.kind}${del ? ' deleted' : ''}${pm.edits.has(p.i) ? ' changed' : ''}" data-i="${p.i}">
      <span class="pm-n">${p.i + 1}${label[p.kind] ? `<small>${label[p.kind]}</small>` : ''}</span>
      ${p.kind === 'picture' ? '<div class="pm-pic">Picture (logo / badge) – kept as is</div>' : `<textarea rows="1" data-pe="${p.i}" ${del ? 'disabled' : ''}>${esc(val)}</textarea>`}
      <span class="pm-acts">${p.kind === 'picture' ? '' : `<button type="button" class="icon-btn" data-pa="${p.i}" title="Add a clause after this paragraph">＋ Clause</button>
        <button type="button" class="icon-btn ${del ? '' : 'del'}" data-pd="${p.i}">${del ? 'Undo' : 'Delete'}</button>`}</span></li>`);
    pm.inserts.forEach((ins, k) => {
      if (ins.after !== p.i) return;
      rows.push(`<li class="pm-p k-new" data-new="${k}"><span class="pm-n">＋<small>New clause</small></span>
        <textarea rows="2" data-pn="${k}" placeholder="Type the new clause – e.g. a DoH compliance requirement">${esc(ins.text)}</textarea>
        <span class="pm-acts"><button type="button" class="icon-btn del" data-px="${k}">Remove</button></span></li>`);
    });
  }
  $('#pm-paras').innerHTML = rows.join('');
  const grow = ta => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
  $$('#pm-paras textarea').forEach(grow);
  $$('#pm-paras [data-pe]').forEach(ta => ta.oninput = () => {
    const i = Number(ta.dataset.pe), orig = pm.data.paragraphs[i].text;
    if (ta.value === orig) pm.edits.delete(i); else pm.edits.set(i, ta.value);
    ta.closest('li').classList.toggle('changed', pm.edits.has(i)); grow(ta); pmCount();
  });
  $$('#pm-paras [data-pn]').forEach(ta => ta.oninput = () => { pm.inserts[Number(ta.dataset.pn)].text = ta.value; grow(ta); pmCount(); });
  $$('#pm-paras [data-pa]').forEach(b => b.onclick = () => { pm.inserts.push({ after: Number(b.dataset.pa), text: '' }); pmRender(); $(`#pm-paras [data-pn="${pm.inserts.length - 1}"]`)?.focus(); });
  $$('#pm-paras [data-px]').forEach(b => b.onclick = () => { pm.inserts.splice(Number(b.dataset.px), 1); pmRender(); });
  $$('#pm-paras [data-pd]').forEach(b => b.onclick = () => { const i = Number(b.dataset.pd); if (pm.deletes.has(i)) pm.deletes.delete(i); else pm.deletes.add(i); pmRender(); });
  pmFilter(); pmCount();
}
function pmCount() {
  const n = pm.edits.size + pm.inserts.filter(x => x.text.trim()).length + pm.deletes.size;
  $('#pm-save').disabled = !n;
  $('#pm-msg').textContent = n ? `${pm.edits.size} changed · ${pm.inserts.filter(x => x.text.trim()).length} new clause(s) · ${pm.deletes.size} deleted – not saved yet` : 'No changes yet.';
}
function pmFilter() {
  const q = $('#pm-filter').value.trim().toLowerCase();
  $$('#pm-paras li[data-i]').forEach(li => { li.hidden = !!q && !li.querySelector('textarea')?.value.toLowerCase().includes(q); });
}
$('#pm-filter').oninput = pmFilter;

$('#pm-save').onclick = async () => {
  const body = {
    version: pm.version,
    edits: [...pm.edits].map(([i, text]) => ({ i, text })),
    inserts: pm.inserts.filter(x => x.text.trim()).map(x => ({ after: x.after, text: x.text.trim() })),
    deletes: [...pm.deletes],
  };
  if (!confirm(`Save these changes to the ${ppNo(pm.no)} v${pm.version} master?\n\nA copy of the current master is kept. From now on every Word and PDF policy is generated from the edited master, and the masters are locked again.`)) return;
  const btn = $('#pm-save'); btn.disabled = true; btn.innerHTML = '<span class="spin light"></span> Saving…';
  try {
    pm.data = await apiGlobal(`/api/policies/templates/${pm.no}/paragraphs`, { method: 'PUT', body: JSON.stringify(body) });
    Object.assign(pm, { edits: new Map(), inserts: [], deletes: new Set() });
    await loadPolicies();
    pmHeader(); pmRender();
    $('#pm-msg').innerHTML = '<span class="ok-txt">✓ Saved and locked – this is now the master used for every generation.</span>';
  } catch (e) { $('#pm-msg').innerHTML = `<span class="warn-txt">Not saved: ${esc(e.message)}</span>`; }
  finally { btn.innerHTML = '💾 Save &amp; lock'; }
};
$('#pm-close').onclick = () => { if (pmDirty() && !confirm('Close without saving the changes?')) return; $('#pm-dlg').close(); };

// Word round trip: upload the edited file as this version's master (unlock -> upload -> locks again by itself)
$('#pm-upload').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (pp.lock?.locked) {
    const typed = prompt(`Replace the ${ppNo(pm.no)} v${pm.version} master with "${file.name}"?\n\nThe current master is kept as a copy and the masters lock again right after the upload.\n\nType UNLOCK to continue:`);
    if (typed === null) return;
    try { await apiGlobal('/api/policies/templates/unlock', { method: 'POST', body: JSON.stringify({ confirm: typed }) }); } catch (err) { $('#pm-file-msg').innerHTML = `<span class="warn-txt">${esc(err.message)}</span>`; return; }
  }
  $('#pm-file-msg').innerHTML = '<span class="spin"></span> Uploading and checking…';
  try {
    const res = await fetch(`/api/policies/templates?name=${encodeURIComponent(file.name)}&version=${encodeURIComponent(pm.version)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    const d = await res.json(); if (!res.ok) throw new Error(d.error);
    if (d.problems?.length) throw new Error(d.problems.join('; '));
    await loadPolicies(); pm.data = null; pmHeader();
    $('#pm-file-msg').innerHTML = `<span class="ok-txt">✓ "${esc(file.name)}" is now the ${ppNo(pm.no)} v${pm.version} master${d.relocked ? ' – locked again' : ''}.</span>`;
  } catch (err) { $('#pm-file-msg').innerHTML = `<span class="warn-txt">Not replaced: ${esc(err.message)}</span>`; }
};

$('#pp-tpl-files').onchange = async e => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length) return;
  const msgs = [];
  for (const [k, f] of files.entries()) {
    $('#pp-tpl-msg').innerHTML = `<p class="muted"><span class="spin"></span> Reading ${k + 1}/${files.length}: ${esc(f.name)}…</p>`;
    try {
      const res = await fetch(`/api/policies/templates?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const d = await res.json(); if (!res.ok) throw new Error(d.error);
      msgs.push(...d.problems);
    } catch (err) { msgs.push(`${f.name}: ${err.message}`); }
  }
  $('#pp-tpl-msg').innerHTML = msgs.length ? `<div class="alert warn">${msgs.map(esc).join('<br>')}</div>` : `<div class="alert ok">${files.length} polic${files.length === 1 ? 'y' : 'ies'} added to the templates.</div>`;
  loadPolicies();
};

$('#pp-form').oninput = e => {
  if (e.target.name === 'reviewedOn') $('#pp-due').value = fmtDay(plusYear(e.target.value)) || '–';
  if (e.target.name === 'standard') $('#pp-idfmt').value = `${pp.settings.code} / ${e.target.value || 'ADHICS'} - PO01 …`;
};
$('#pp-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target, body = Object.fromEntries(['standard', 'issuedOn', 'reviewedOn', 'preparedBy', 'approvedBy', 'contactEmail', 'contactPhone'].map(k => [k, f.elements[k].value]));
  try { await api('/api/policies/settings', { method: 'PUT', body: JSON.stringify(body) }); $('#pp-msg').textContent = 'Saved.'; pwStep = 2; loadPolicies(); }
  catch (err) { $('#pp-msg').textContent = `Not saved: ${err.message}`; }
};

$$('#pp-assets .pp-asset').forEach(box => {
  const kind = box.dataset.kind;
  box.querySelector('input[type=file]').onchange = async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    $('#pp-asset-msg').innerHTML = `<span class="spin"></span> Cleaning ${esc(file.name)} (crop + background removal)…`;
    try {
      const res = await fetch(u(`/api/policies/assets/${kind}?name=${encodeURIComponent(file.name)}`), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const d = await res.json(); if (!res.ok) throw new Error(d.error);
      $('#pp-asset-msg').textContent = 'Saved.';
      loadPolicies();
    } catch (err) { $('#pp-asset-msg').innerHTML = `<span class="warn-txt">${esc(err.message)}</span>`; }
  };
  box.querySelector('[data-remove]').onclick = async () => {
    try { await api(`/api/policies/assets/${kind}`, { method: 'DELETE' }); loadPolicies(); } catch (e) { alert(e.message); }
  };
});

$('#pp-generate').onclick = async () => {
  if (!confirm(`Generate ${pp.templates.length} policies for ${pp.settings.facilityName} as Word and PDF?\n\nExisting generated files with the same names are replaced.`)) return;
  try { await api('/api/policies/generate', { method: 'POST', body: '{}' }); loadPolicies(); } catch (e) { alert(e.message); }
};

// Lock / unlock the master baseline (administrator)
$('#pp-lock').onclick = async () => {
  if (!confirm(`Lock the ${pp.templates.length} master policies as the baseline?\n\nThey can no longer be replaced or removed until an administrator unlocks them, and every generation checks that the files are unchanged.`)) return;
  try { await apiGlobal('/api/policies/templates/lock', { method: 'POST', body: '{}' }); loadPolicies(); } catch (e) { alert(e.message); }
};
$('#pp-unlock').onclick = async () => {
  const typed = prompt('The master policies are protected (read-only).\n\nOnly unlock to replace a policy in the baseline – they lock again automatically as soon as the replacement is uploaded.\n\nType UNLOCK to continue:');
  if (typed === null) return;
  try { await apiGlobal('/api/policies/templates/unlock', { method: 'POST', body: JSON.stringify({ confirm: typed }) }); loadPolicies(); } catch (e) { alert(e.message); }
};

// New facility policy pack: ONE form -> facility + LEGAL REGISTER created -> details -> pictures -> 33 policies
// generated (Word + PDF) from the locked masters -> linked to the LEGAL REGISTER.
const np = () => $('#pp-new-form');
const npInitials = name => name.split(/\s+/).filter(w => /^[A-Za-z]/.test(w) && !/^(LLC|L\.L\.C|OPC|THE|AND|OF)$/i.test(w)).map(w => w[0]).join('').toUpperCase().slice(0, 6);
function npPreview() {
  const f = np(), code = (f.elements.code.value || 'CODE').toUpperCase(), std = f.elements.standard.value || 'ADHICS';
  const last = Math.max(1, ...(pp?.templates || []).map(t => t.no));
  $('#np-idprev').textContent = `${code} / ${std} - PO01`;
  $('#np-idrange').textContent = `… ${code} / ${std} - PO${String(last).padStart(2, '0')}`;
  $('#np-due').value = fmtDay(plusYear(f.elements.reviewedOn.value)) || '';
  // live replica of the policy's Document Control table
  const no = Number($('#np-prev-no').value || 1), tpl = (pp?.templates || []).find(t => t.no === no);
  const dmy = iso => (ISO.test(iso || '') ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '–');
  const name = (f.elements.name.value.trim() || '–').toUpperCase();
  $('#np-doc-title').textContent = tpl?.title || 'ADHICS - POLICY';
  $('#np-doc-id').textContent = `${code} / ${std} - PO${String(no).padStart(2, '0')}`;
  $('#np-doc-issued').textContent = dmy(f.elements.issuedOn.value);
  $('#np-doc-reviewed').textContent = dmy(f.elements.reviewedOn.value);
  $('#np-doc-due').textContent = dmy(plusYear(f.elements.reviewedOn.value));
  $('#np-doc-prepared').textContent = f.elements.preparedBy.value.trim() || '–';
  $('#np-doc-approved').textContent = f.elements.approvedBy.value.trim() || '–';
  $('#np-doc-name').innerHTML = `<b>${esc(name)}</b>`;
  $('#np-doc-version').textContent = pp?.settings?.versions?.[no] || ((pp?.majorRevision || []).includes(no) ? '2.0' : '1.0');
  $('#np-doc-text').innerHTML = `This policy applies to all Users of <b>${esc(name)}</b>.`;
}
/** Full-screen document reader (PDF): the whole page across the screen, page width, like a real document viewer. */
function openViewer(url, { title = 'Document', sub = '', file = '', revoke = false } = {}) {
  const dlg = $('#doc-viewer'), fr = $('#dv-frame');
  if (fr.dataset.revoke) URL.revokeObjectURL(fr.dataset.revoke);
  fr.dataset.revoke = revoke ? url : '';
  fr.src = `${url}#view=FitH&toolbar=1&navpanes=0`;
  $('#dv-title').textContent = title; $('#dv-sub').textContent = sub;
  $('#dv-download').href = url; $('#dv-download').download = file || 'document.pdf';
  $('#dv-tab').href = url;
  if (!dlg.open) dlg.showModal();
}
$('#dv-close').onclick = () => $('#doc-viewer').close();
$('#doc-viewer').addEventListener('close', () => { const fr = $('#dv-frame'); fr.src = 'about:blank'; if (fr.dataset.revoke) { URL.revokeObjectURL(fr.dataset.revoke); fr.dataset.revoke = ''; } });
// generated policy PDFs open in the reader too
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-view]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  openViewer(a.href, { title: a.dataset.view, sub: pp?.settings?.facilityName || '', file: `${a.dataset.view}.pdf` });
});

const fileToDataUrl = file => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
async function npPreviewFile(format) {
  const f = np(), btn = format === 'pdf' ? $('#np-prev-btn') : $('#np-prev-word');
  const form = Object.fromEntries(['name', 'code', 'standard', 'issuedOn', 'reviewedOn', 'preparedBy', 'approvedBy', 'contactEmail', 'contactPhone'].map(k => [k, f.elements[k].value]));
  const pics = {};
  for (const k of ['logo', 'signature', 'stamp', 'combined']) if (f.elements[k].files[0]) pics[k] = await fileToDataUrl(f.elements[k].files[0]);
  const label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Preparing…';
  $('#np-prev-msg').textContent = format === 'pdf' ? 'Filling the master and creating the PDF with Microsoft Word (about 10 seconds)…' : 'Filling the master…';
  try {
    const res = await fetch(u('/api/policies/preview'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ no: Number($('#np-prev-no').value), form, pics, newFacility: true, format }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const report = JSON.parse(decodeURIComponent(res.headers.get('X-Policy-Report') || '%7B%7D'));
    const blobUrl = URL.createObjectURL(await res.blob());
    if (format === 'pdf') {
      const no = String($('#np-prev-no').value).padStart(2, '0');
      openViewer(blobUrl, { title: `${form.code || 'NEW'} – PO${no} (preview)`, sub: `${form.name || 'New facility'} · generated from the locked master · not saved`, file: `${form.code || 'NEW'} - PO${no} - PREVIEW.pdf`, revoke: true });
    }
    else { const a = Object.assign(document.createElement('a'), { href: blobUrl, download: `${form.code || 'NEW'} - PO${String($('#np-prev-no').value).padStart(2, '0')} - PREVIEW.docx` }); document.body.appendChild(a); a.click(); a.remove(); }
    $('#np-prev-msg').innerHTML = report.leftovers?.length ? `<span class="warn-txt">Check: ${report.leftovers.map(esc).join(', ')}</span>`
      : `✓ ${report.nameReplaced || 0} name/code and ${report.contactsReplaced || 0} contact replacements · nothing of the master facility left.`;
  } catch (e) { $('#np-prev-msg').innerHTML = `<span class="warn-txt">${esc(e.message)}</span>`; }
  finally { btn.disabled = false; btn.innerHTML = label; }
}
$('#np-prev-btn').onclick = () => npPreviewFile('pdf');
$('#np-prev-word').onclick = () => npPreviewFile('docx');
$('#np-prev-no').onchange = () => npPreview();
function npOpen() {
  const f = np(); f.reset();
  $$('#pp-new-form .np-pic').forEach(l => l._reset?.());
  const base = pp?.lock?.baseline || {};
  $('#np-count').textContent = pp?.templates?.length || 0;
  $('#np-base').textContent = 'the master template';
  $('#np-email-note').textContent = base.emails?.length ? `replaces ${base.emails.join(', ')}` : 'incident contact';
  $('#np-phone-note').textContent = base.phones?.length ? `replaces ${base.phones.join(', ')}` : 'incident contact';
  $('#np-run').hidden = true; $('#np-result').innerHTML = ''; $('#pp-new-msg').textContent = '';
  $('#pp-new-create').hidden = false; $('#pp-new-create').disabled = false; $('#pp-new-create').innerHTML = '⚙ Create the policy pack';
  $$('#pp-new-form fieldset').forEach(x => { x.disabled = false; });
  $('#np-inputs').hidden = false; f.querySelector('.np-live').hidden = false; $('#np-check').hidden = true;
  $$('#pp-new-form .invalid').forEach(x => x.classList.remove('invalid'));
  delete f.elements.code.dataset.touched;
  $('#np-prev-no').innerHTML = (pp?.templates || []).map(t => `<option value="${t.no}">PO${String(t.no).padStart(2, '0')} – ${esc(t.title.replace(/^ADHICS\s*[-–]\s*/i, ''))}</option>`).join('');
  $('#np-prev-frame').hidden = true; $('#np-prev-msg').textContent = 'Opens the real document full screen – generated from the locked master with the values above. Nothing is saved.';
  $('#np-doc-logo').hidden = true; $('#np-doc-nologo').hidden = false;
  npPreview();
  npGo(1);
  $('#pp-new-dlg').showModal();
}
$('#pp-new').onclick = npOpen;
$('#pp-new-cancel').onclick = () => $('#pp-new-dlg').close();
np().addEventListener('input', e => {
  e.target.classList?.remove('invalid');
  e.target.closest?.('.np-pic')?.classList.remove('invalid');
  if (e.target.name === 'name' && !np().elements.code.dataset.touched) np().elements.code.value = npInitials(e.target.value);
  if (e.target.name === 'code') { e.target.dataset.touched = '1'; e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  npPreview();
});
/**
 * Wizard pictures: a photo, scan, PDF or Word file. The server takes the picture out of it, crops it and removes its
 * background straight away; the box then shows exactly what goes into the policies, and that cleaned picture is used.
 * ✕ removes it (choose another without starting again).
 */
const NP_LABEL = { logo: 'logo', signature: 'signature', stamp: 'stamp' };
/** Sort for me: drop several files at once - each picture found goes to its slot (logo, signature, stamp). */
async function npSort(files) {
  files = [...files].slice(0, 6);
  if (!files.length) return;
  const box = $('#np-sort'), msg = $('#np-sort-msg');
  box.classList.add('busy'); msg.innerHTML = `<span class="spin"></span> Looking at ${files.length} file${files.length > 1 ? 's' : ''} – finding the logo, signature and stamp…`;
  try {
    const payload = { files: await Promise.all(files.map(async f => ({ name: f.name, data: await fileToDataUrl(f) }))) };
    const res = await fetch(u('/api/policies/picture-detect'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || res.statusText);
    const placed = [];
    for (const k of ['logo', 'signature', 'stamp']) {
      if (!d[k]) continue;
      await np().querySelector(`.np-pic[data-pic="${k}"]`)._set(d[k], `✓ Auto-detected (${d[k].reason}) · ${d[k].source}`);
      placed.push(NP_LABEL[k]);
    }
    const missing = ['logo', 'signature', 'stamp'].filter(k => !d[k]).map(k => NP_LABEL[k]);
    msg.innerHTML = `${placed.length ? `✓ Placed: <b>${placed.join(', ')}</b>.` : 'No logo, signature or stamp recognised.'}${missing.length ? ` Not found: ${missing.join(', ')} – add ${missing.length > 1 ? 'them' : 'it'} below.` : ''} Check each picture; ✕ removes one.`;
  } catch (e) { msg.innerHTML = `<span class="warn-txt">${esc(e.message)}</span>`; }
  finally { box.classList.remove('busy'); }
}
$('#np-sort-files').onchange = e => { npSort(e.target.files); e.target.value = ''; };
['dragenter', 'dragover'].forEach(t => $('#np-sort').addEventListener(t, e => { e.preventDefault(); $('#np-sort').classList.add('over'); }));
['dragleave', 'drop'].forEach(t => $('#np-sort').addEventListener(t, e => { e.preventDefault(); $('#np-sort').classList.remove('over'); }));
$('#np-sort').addEventListener('drop', e => npSort(e.dataTransfer.files));

$$('#pp-new-form .np-pic').forEach(l => {
  const inp = l.querySelector('input'), img = l.querySelector('img'), em = l.querySelector('em'), empty = em.textContent;
  inp.accept = 'image/png,image/jpeg,.png,.jpg,.jpeg,.pdf,.docx,.doc';
  const x = Object.assign(document.createElement('button'), { type: 'button', className: 'pic-x', title: 'Remove', textContent: '✕', hidden: true });
  x.setAttribute('aria-label', 'Remove this picture');
  l.querySelector('.np-box').append(x);
  const note = Object.assign(document.createElement('span'), { className: 'pic-note' });
  l.append(note);
  const reset = () => {
    l.dataset.seq = ''; inp.value = ''; img.hidden = true; img.removeAttribute('src'); em.hidden = false; em.textContent = empty;
    l.classList.remove('set', 'busy', 'bad'); x.hidden = true; note.textContent = '';
    if (inp.name === 'logo') { $('#np-doc-logo').hidden = true; $('#np-doc-nologo').hidden = false; }
  };
  l._reset = reset;
  /** Put a cleaned picture ({ dataUrl, ext }) in this slot - from the slot's own upload or from the sort-for-me drop. */
  l._set = async (d, text) => {
    const blob = await (await fetch(d.dataUrl)).blob();
    const dt = new DataTransfer(); dt.items.add(new File([blob], `${inp.name}.${d.ext}`, { type: blob.type }));
    inp.files = dt.files; // from now on the cleaned picture is used (preview and the pack)
    l.dataset.seq = String(Date.now());
    l.classList.add('set'); l.classList.remove('bad', 'busy', 'invalid'); x.hidden = false;
    img.src = d.dataUrl; img.hidden = false; em.hidden = true;
    note.textContent = text;
    if (inp.name === 'logo') { $('#np-doc-logo').src = d.dataUrl; $('#np-doc-logo').hidden = false; $('#np-doc-nologo').hidden = true; }
  };
  x.onclick = e => { e.preventDefault(); e.stopPropagation(); reset(); };
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return reset();
    const seq = l.dataset.seq = String(Date.now());
    l.classList.add('set', 'busy'); l.classList.remove('bad', 'invalid'); x.hidden = false;
    img.hidden = true; em.hidden = false; em.innerHTML = '<span class="spin"></span> Cleaning…'; note.textContent = f.name;
    try {
      const res = await fetch(u(`/api/policies/picture-preview?kind=${inp.name}&name=${encodeURIComponent(f.name)}`), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || res.statusText);
      if (l.dataset.seq !== seq) return; // replaced or removed meanwhile
      await l._set(d, `✓ ${d.cropped ? 'Cropped' : 'Ready'}${d.transparent ? ' · background removed' : ''} · from ${d.source}`);
      // looks like another kind (e.g. a round stamp in the signature slot): say so and offer to move it
      if (d.mismatch && NP_LABEL[d.mismatch]) {
        note.innerHTML = `<span class="warn-txt">⚠ This looks like a ${NP_LABEL[d.mismatch]}.</span> <button type="button" class="link-btn" data-move="${d.mismatch}">Move it to ${NP_LABEL[d.mismatch]} →</button>`;
        note.querySelector('[data-move]').onclick = async ev => {
          ev.preventDefault(); ev.stopPropagation();
          const to = np().querySelector(`.np-pic[data-pic="${d.mismatch}"]`);
          await to._set(d, `✓ Moved here – looks like a ${NP_LABEL[d.mismatch]}`);
          reset();
        };
      }
    } catch (e) {
      if (l.dataset.seq !== seq) return;
      reset(); l.classList.add('bad'); note.textContent = `✕ ${e.message}`;
    } finally { if (l.dataset.seq === seq) l.classList.remove('busy'); }
  };
});

const npStep = (k, state) => { const li = $(`#np-steps [data-s="${k}"]`); if (li) li.className = state; };
/** Wizard step 2: create the HR & onboarding documents and follow the job (bar 70 → 95 %). Never blocks the pack. */
async function npMakeHr(q, btn) {
  let r;
  try { r = await apiGlobal(`/api/hr/generate${q}`, { method: 'POST', body: '{}' }); }
  catch (e) { $('#np-hr-progress').textContent = e.message; return { skipped: e.message }; }
  $('#np-hr-n').textContent = r.total;
  let st, misses = 0;
  const until = Date.now() + 15 * 60000;
  for (;;) {
    await new Promise(res => setTimeout(res, 1200));
    try { st = await apiGlobal(`/api/hr${q}`); misses = 0; }
    catch (e) { if (++misses > 10) return { skipped: `lost contact with the portal (${e.message})` }; continue; }
    const j = st.job || {};
    $('#np-bar').style.width = `${70 + Math.round(((j.done || 0) / Math.max(1, j.total || 1)) * 25)}%`;
    $('#np-hr-progress').textContent = j.running ? `${j.done}/${j.total} · ${j.step}` : '';
    btn.innerHTML = `<span class="spin light"></span> ${j.running ? `HR document ${Math.min((j.done || 0) + 1, j.total || 1)} of ${j.total}…` : 'Finishing…'}`;
    if (!j.running) return j;
    if (Date.now() > until) return { skipped: 'taking unusually long – check the HR & checklist page' };
  }
}
/**
 * New facility pack as a wizard: 1 facility · 2 dates & people · 3 pictures · 4 preview & create. One set of rules
 * checks a step (Next) or all steps (Create); the message says exactly what is missing and opens that step.
 */
let npAt = 1;
function npCheck(steps) {
  const f = np(), v = k => f.elements[k].value.trim(), files = k => f.elements[k].files[0];
  const missing = []; let first = 0;
  const flag = (step, el, ok, label) => { el.classList.toggle('invalid', !ok); if (!ok) { missing.push(label); first ||= step; } };
  const field = (step, k, label, ok = !!v(k)) => flag(step, f.elements[k], ok, label);
  if (steps.includes(1)) {
    field(1, 'name', 'Facility name');
    const taken = facilities.some(x => x.code.toUpperCase() === v('code').toUpperCase()) || (template && template.code.toUpperCase() === v('code').toUpperCase());
    field(1, 'code', taken ? `A different code – ${v('code')} is already used` : 'Code / prefix (letters and digits)', /^[A-Z0-9]{1,12}$/.test(v('code')) && !taken);
    field(1, 'contactEmail', 'Contact e-mail (valid address)', /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(v('contactEmail')));
    field(1, 'contactPhone', 'Contact phone', /\d{6,}/.test(v('contactPhone').replace(/\D/g, '')));
  }
  if (steps.includes(2)) {
    field(2, 'issuedOn', 'Issued on'); field(2, 'reviewedOn', 'Reviewed on'); field(2, 'preparedBy', 'Prepared by'); field(2, 'approvedBy', 'Approved by');
  }
  if (steps.includes(3)) {
    const pic = k => f.querySelector(`.np-pic[data-pic="${k}"]`);
    flag(3, pic('logo'), !!files('logo'), 'Facility logo (picture)');
    const sigOk = !!files('combined') || (!!files('signature') && !!files('stamp'));
    pic('signature').classList.toggle('invalid', !sigOk && !files('signature')); pic('stamp').classList.toggle('invalid', !sigOk && !files('stamp'));
    if (!sigOk) { missing.push('Signature and stamp (or one picture with both)'); first ||= 3; }
  }
  $('#np-check').hidden = !missing.length;
  $('#np-check').innerHTML = missing.length ? `<div class="alert warn"><b>Please complete:</b> ${missing.map(esc).join(' · ')}</div>` : '';
  if (first) npGo(first, { keepCheck: true });
  return !missing.length;
}
function npGo(n, { keepCheck = false } = {}) {
  npAt = Math.min(4, Math.max(1, Number(n)));
  $$('#pp-new-form [data-npstep]').forEach(fs => fs.classList.toggle('np-off', Number(fs.dataset.npstep) !== npAt));
  $$('#np-wiz li').forEach(li => { const k = Number(li.dataset.pw); li.className = `${k < npAt ? 'done' : ''}${k === npAt ? ' on' : ''}`; li.querySelector('i').textContent = k < npAt ? '✓' : k; });
  $('#np-back').hidden = npAt === 1; $('#np-next').hidden = npAt === 4; $('#pp-new-create').hidden = npAt !== 4 || !$('#np-run').hidden;
  $('#np-autolink').closest('label').hidden = npAt !== 4;
  if (!keepCheck) $('#np-check').hidden = true;
  if (npAt === 4) npPreview();
  $('#pp-new-dlg').scrollTop = 0;
}
$('#np-next').onclick = () => { if (npCheck([npAt])) npGo(npAt + 1); };
$('#np-back').onclick = () => npGo(npAt - 1);
// a step tab: going back is free; going forward checks the steps in between
$$('#np-wiz li button').forEach(b => b.onclick = () => { const to = Number(b.closest('li').dataset.pw); if (to <= npAt || npCheck([...Array(to - 1).keys()].map(i => i + 1))) npGo(to); });

np().onsubmit = async e => {
  e.preventDefault();
  const f = e.target, v = k => f.elements[k].value.trim();
  const pics = Object.fromEntries(['logo', 'signature', 'stamp', 'combined'].map(k => [k, f.elements[k].files[0]]));
  if (!npCheck([1, 2, 3])) return; // shows what is missing and opens that step
  if (!pp?.templates?.length) { $('#np-check').hidden = false; $('#np-check').innerHTML = '<div class="alert warn">No master policies are uploaded yet – an administrator adds them in Admin console → Master policies.</div>'; return; }
  const name = v('name'), code = v('code');
  $('#pp-new-msg').textContent = '';
  const btn = $('#pp-new-create'); btn.disabled = true; btn.innerHTML = '<span class="spin light"></span> Creating the pack…';
  $$('#pp-new-form fieldset').forEach(x => { x.disabled = true; });
  $('#np-inputs').hidden = true; f.querySelector('.np-live').hidden = true; // show the progress, not the greyed form
  $('#np-run').hidden = false; $$('#np-steps li').forEach(li => { li.className = ''; }); $('#np-bar').style.width = '0%';
  $('#np-result').innerHTML = '';
  $('#pp-new-dlg').scrollTop = 0; f.scrollIntoView({ block: 'start' });
  $('#np-n').textContent = pp.templates.length;
  let id = null, step = 'create';
  const started = Date.now();
  clearInterval(npTicker);
  npTicker = setInterval(() => { const sEl = Math.round((Date.now() - started) / 1000); $('#pp-new-msg').textContent = `Working… ${Math.floor(sEl / 60)}:${String(sEl % 60).padStart(2, '0')}`; }, 1000);
  try {
    npStep('create', 'active');
    const d = await apiGlobal('/api/facilities', { method: 'POST', body: JSON.stringify({ source: 'template', code, name, title: `${name.toUpperCase()} - LEGAL REGISTER`, approver: v('approvedBy'), authors: v('preparedBy'), responsible: v('approvedBy') }) });
    id = d.id; facility = id; store.set('facility', id);
    npStep('create', 'done'); step = 'details'; npStep('details', 'active');
    const q = `?f=${encodeURIComponent(id)}`;
    await apiGlobal(`/api/policies/settings${q}`, { method: 'PUT', body: JSON.stringify(Object.fromEntries(['standard', 'issuedOn', 'reviewedOn', 'preparedBy', 'approvedBy', 'contactEmail', 'contactPhone'].map(k => [k, v(k)]))) });
    if (v('trainingDate')) await apiGlobal(`/api/hr/documents${q}`, { method: 'PUT', body: JSON.stringify({ group: 'training', date: v('trainingDate') }) });
    npStep('details', 'done'); step = 'pics'; npStep('pics', 'active');
    for (const [kind, file] of Object.entries(pics)) {
      if (!file) continue;
      const res = await fetch(`/api/policies/assets/${kind}${q}&name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const r = await res.json(); if (!res.ok) throw new Error(`${kind}: ${r.error}`);
    }
    npStep('pics', 'done'); step = 'generate'; npStep('generate', 'active');
    await apiGlobal(`/api/policies/generate${q}`, { method: 'POST', body: '{}' });
    let st, misses = 0;
    const until = Date.now() + 30 * 60000;
    for (;;) {
      await new Promise(r => setTimeout(r, 1200));
      try { st = await apiGlobal(`/api/policies${q}`); misses = 0; }
      catch (e) { if (++misses > 10) throw new Error(`lost contact with the portal while generating (${e.message})`); continue; }
      const j = st.job || {};
      $('#np-bar').style.width = `${Math.round(((j.done || 0) / Math.max(1, j.total || 1)) * 70)}%`; // policies: first 70 %
      $('#np-progress').textContent = j.running ? `${j.done}/${j.total} · ${j.step}` : '';
      btn.innerHTML = `<span class="spin light"></span> ${j.running ? `Policy ${Math.min(j.done + 1, j.total)} of ${j.total}…` : 'Finishing…'}`;
      if (!j.running) break;
      if (Date.now() > until) throw new Error('generation is taking unusually long – check the Policies page');
    }
    const j = st.job;
    npStep('generate', j.problems?.length ? 'warn' : 'done');
    // Step 2: the HR & onboarding documents, with this facility's logo and name (they also follow PO11's dates)
    step = 'hr'; npStep('hr', 'active');
    const hr = await npMakeHr(q, btn);
    npStep('hr', hr.skipped ? 'warn' : hr.problems?.length ? 'warn' : 'done');
    // Step 3 (last): link everything to the LEGAL REGISTER (free trial: the register is a locked preview – skipped)
    const trialPack = document.body.classList.contains('trial');
    if (trialPack) npStep('link', 'warn');
    else if ($('#np-autolink').checked) {
      step = 'link'; npStep('link', 'active');
      btn.innerHTML = '<span class="spin light"></span> Linking to the LEGAL REGISTER…';
      await apiGlobal(`/api/policies/link-register${q}`, { method: 'POST', body: '{}' });
      npStep('link', 'done');
    }
    $('#np-bar').style.width = '100%';
    const val = j.validation || {};
    const hv = hr.validation || {};
    $('#np-result').innerHTML = `<div class="alert ${j.problems?.length || val.failed?.length || hr.problems?.length || hr.skipped ? 'warn' : 'ok'}"><b>${esc(name)} (${esc(code)}): ${st.files.word.length} Word + ${st.files.pdf.length} PDF policies${hr.skipped ? '' : `, ${hv.count ?? 0} HR &amp; onboarding documents`} ready${$('#np-autolink').checked ? ', linked to the LEGAL REGISTER' : ''}.</b>
      <br>1 · Policies: <b>${val.passed ?? '–'} of ${val.total ?? '–'}</b> fully reflect ${esc(name)}${val.pages ? ` (${val.pages} pages · ${val.megabytes} MB of PDF · no extra signature pages)` : ''} – nothing of the master template left, DoH contacts unchanged${val.failed?.length ? ` · <span class="warn-txt">check: ${val.failed.map(esc).join(', ')}</span>` : ''}.
      <br>2 · HR documents: ${hr.skipped ? `<span class="warn-txt">${esc(hr.skipped)}</span>` : `<b>${hv.passed ?? 0} of ${hv.total ?? 0}</b> checked – this facility's name, code and logo only; Acceptable Usage matches PO11`}.
      <br>3 · LEGAL REGISTER: ${trialPack ? 'a locked preview on the free trial' : $('#np-autolink').checked ? 'linked ✓ (final step)' : 'not linked yet – do it on the Policies page'}.
      ${trialPack ? `<br><span class="np-trial">★ Free trial: ${st.files.word.length} of ${pp?.templates?.length || 33} policies and ${hv.count ?? 0} HR documents are included. <button type="button" class="btn small premium-btn" id="np-premium">Get Premium for the full pack</button></span>` : ''}
      ${[...(j.problems || []), ...(hr.problems || [])].length ? `<br>${[...(j.problems || []), ...(hr.problems || [])].map(esc).join('<br>')}` : ''}<br><span class="small">Saved in ${esc(st.files.folder)}</span></div>
      <div class="btn-row"><a class="btn primary" href="/api/policies/zip?type=all&f=${encodeURIComponent(id)}">⬇ Policies Word + PDF (.zip)</a>${hr.skipped ? '' : `<a class="btn" href="/api/hr/zip?f=${encodeURIComponent(id)}">⬇ HR documents (.zip)</a>`}
      <button type="button" class="btn" id="np-open">Open the policies</button><button type="button" class="btn" id="np-hr">Open HR &amp; checklist</button><button type="button" class="btn" id="np-register">Open the LEGAL REGISTER</button></div>`;
    $('#pp-new-create').hidden = true;
    await loadFacilities();
    $('#np-open').onclick = () => { $('#pp-new-dlg').close(); selectFacility(id); showTab('policies'); };
    $('#np-hr').onclick = () => { $('#pp-new-dlg').close(); selectFacility(id); showTab('hr'); };
    $('#np-register').onclick = () => { $('#pp-new-dlg').close(); selectFacility(id); showTab('master'); };
    if ($('#np-premium')) $('#np-premium').onclick = () => { $('#pp-new-dlg').close(); showUpgrade(); };
    refreshPlan();
  } catch (err) {
    npStep(step, 'bad');
    $('#np-result').innerHTML = `<div class="alert bad">Stopped at “${esc($(`#np-steps [data-s="${step}"]`).textContent)}”: ${esc(err.message)}${id ? '<br>The facility was created – open it on the Policies page to finish.' : ''}</div>`;
    btn.disabled = false; btn.innerHTML = '⚙ Create the policy pack';
    if (!id) { // nothing was created: give the form back to correct it
      $$('#pp-new-form fieldset').forEach(x => { x.disabled = false; });
      $('#np-inputs').hidden = false; f.querySelector('.np-live').hidden = false;
      $('#np-run').hidden = true; npGo(npAt, { keepCheck: true });
    } else { btn.hidden = true; await loadFacilities(); }
  } finally {
    clearInterval(npTicker);
    const secs = Math.round((Date.now() - started) / 1000);
    $('#pp-new-msg').textContent = $('#np-result .alert.bad') ? '' : `Done in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  }
};
let npTicker = null;

$('#pp-link').onclick = async () => {
  $('#pp-link-msg').innerHTML = '<p class="muted"><span class="spin"></span> Linking…</p>';
  try {
    const r = await api('/api/policies/link-register', { method: 'POST', body: '{}' });
    await loadFacilities(); await refresh(); master = null;
    showTab('master');
    $('#master-alert').insertAdjacentHTML('afterbegin', `<div class="alert ok">Policies linked: details taken from ${esc(r.policy)} and written to the LEGAL REGISTER (backup taken).</div>`);
  } catch (e) { $('#pp-link-msg').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
};


// ===================================================================================================
// AI assistant chat (read-only answers about this facility)
// ===================================================================================================
const ai = { history: [], busy: false, status: null };
/** Safe, small formatting: **bold**, lines starting with "• " or "- " become bullets, line breaks kept. */
function aiFormat(text) {
  return esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split('\n').map(l => (/^\s*(•|-|\*)\s+/.test(l) ? `<span class="ai-li">${l.replace(/^\s*(•|-|\*)\s+/, '')}</span>` : l)).join('<br>')
    .replace(/<\/span><br>/g, '</span>').replace(/<br><span class="ai-li">/g, '<span class="ai-li">').replace(/(<br>){3,}/g, '<br><br>'); // bullets are blocks: no extra line breaks
}
function aiAdd(role, text, extra = '') {
  const el = document.createElement('div');
  el.className = `ai-msg ${role}`;
  el.innerHTML = role === 'bot' ? `<span class="ai-avatar sm">AI</span><div class="ai-bubble">${aiFormat(text)}${extra}</div>` : `<div class="ai-bubble">${esc(text)}</div>`;
  $('#ai-log').append(el);
  $('#ai-log').scrollTop = $('#ai-log').scrollHeight;
  return el;
}
async function aiStatus() {
  try { ai.status = await apiGlobal('/api/assistant/status'); } catch { ai.status = { configured: false }; }
  $('#ai-mode').textContent = ai.status.configured ? 'AI model connected · reads your portal data' : 'Simple mode – answers from your portal data';
  $('#ai-panel').classList.toggle('offline', !ai.status.configured);
}
function aiGreet() {
  $('#ai-log').innerHTML = '';
  ai.history = [];
  aiAdd('bot', `Hi ${me?.username || ''}! I can tell you what to do next, which licences are expiring, whether your policies are ready, and how to use each page. Ask me anything about this facility.`);
  $('#ai-chips').hidden = false;
}
function aiOpen(on = $('#ai-panel').hidden) {
  $('#ai-panel').hidden = !on; $('#ai-fab').setAttribute('aria-expanded', on); $('#ai-fab').classList.toggle('open', on);
  if (on) { if (!ai.status) aiStatus(); if (!$('#ai-log').children.length) aiGreet(); setTimeout(() => $('#ai-q').focus(), 50); }
}
async function aiAsk(q) {
  q = String(q || '').trim();
  if (!q || ai.busy) return;
  if (!facility) { aiAdd('bot', 'Choose or create a facility first – then I can answer about it.'); return; }
  ai.busy = true; $('#ai-chips').hidden = true; $('#ai-q').value = '';
  aiAdd('user', q);
  const wait = aiAdd('bot', '', '<span class="ai-typing"><i></i><i></i><i></i></span>');
  try {
    const r = await api('/api/assistant/ask', { method: 'POST', body: JSON.stringify({ question: q, history: ai.history.slice(-10) }) });
    wait.remove();
    aiAdd('bot', r.answer);
    ai.history.push({ role: 'user', text: q }, { role: 'assistant', text: r.answer });
  } catch (e) { wait.remove(); aiAdd('bot', `Sorry – ${e.message}`); }
  finally { ai.busy = false; }
}
$('#ai-fab').onclick = () => aiOpen();
$('#ai-close').onclick = () => aiOpen(false);
$('#ai-new').onclick = () => aiGreet();
$('#ai-form').onsubmit = e => { e.preventDefault(); aiAsk($('#ai-q').value); };
$$('#ai-chips button').forEach(b => b.onclick = () => aiAsk(b.textContent));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#ai-panel').hidden) aiOpen(false); });

/** Administration → Schedule & email: connect the AI model (API key kept on the portal PC, never shown again). */
async function renderAiSettings() {
  if (me?.role !== 'admin') return;
  let box = $('#ai-settings');
  if (!box) { box = Object.assign(document.createElement('div'), { id: 'ai-settings', className: 'panel ai-settings' }); $('#adm-schedule')?.prepend(box); }
  await aiStatus();
  const on = ai.status.configured;
  box.innerHTML = `<h2>AI assistant</h2>
    <p class="muted small">The "Ask AI" chat answers staff questions about this portal using Claude (${esc(ai.status.model || 'Anthropic')}). It only reads portal data. Without a key it runs in simple mode with fixed answers. The key is stored on this PC only and is never shown again.</p>
    <p><span class="tag ${on ? 'ok' : 'na'}">${on ? 'Connected' : 'Not connected – simple mode'}</span></p>
    <form id="ai-key-form" class="ai-key-row" autocomplete="off">
      <input type="password" id="ai-key" placeholder="${on ? 'Enter a new key to replace the current one' : 'Anthropic API key (sk-ant-…)'}" autocomplete="new-password">
      <button class="btn primary" type="submit">Save key</button>
      ${on ? '<button class="btn" type="button" id="ai-key-del">Disconnect</button>' : ''}
    </form><p class="small muted" id="ai-key-msg"></p>`;
  $('#ai-key-form').onsubmit = async e => {
    e.preventDefault();
    try { await apiGlobal('/api/assistant/key', { method: 'PUT', body: JSON.stringify({ key: $('#ai-key').value }) }); $('#ai-key').value = ''; renderAiSettings(); }
    catch (err) { $('#ai-key-msg').textContent = err.message; }
  };
  if ($('#ai-key-del')) $('#ai-key-del').onclick = async () => {
    if (!confirm('Disconnect the AI model? The chat goes back to simple mode.')) return;
    await apiGlobal('/api/assistant/key', { method: 'PUT', body: JSON.stringify({ key: '' }) }); renderAiSettings();
  };
}

(async () => {
  try { me = await apiGlobal('/api/me'); } catch { return; } // redirected to sign-in
  applyRole(); refreshPlan(); setTimeout(() => showWelcome(), 450); // after the page has drawn
  await loadFacilities();
  refresh();
  loadPendingBadge(); setInterval(loadPendingBadge, 120000);
})().catch(e => { $('#alerts').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; });

// Home shows only the essentials; the rest (deadline lists, figures, tiles, activity) on request – remembered.
(function homeDetails() {
  const btn = $('#hx-more-btn');
  if (!btn) return;
  const set = on => {
    $('#overview').classList.toggle('more', on);
    btn.setAttribute('aria-expanded', on);
    btn.innerHTML = on ? 'Show less <span aria-hidden="true">▴</span>' : 'Show more details <span aria-hidden="true">▾</span>';
    store.set('home-more', on ? '1' : '');
  };
  btn.onclick = () => set(!$('#overview').classList.contains('more'));
  set(store.get('home-more') === '1');
})();

// ===================================================================================================
// "How it works" – the shared isometric "compliance factory" (public/iso-factory.js): four stations on a moving
// conveyor belt (1 Policies · 2 HR forms · 3 LEGAL REGISTER · DoH updates), documents riding the belt, a glowing
// package hopping to the active station, a caption per step, and badges with this facility's real progress.
// ===================================================================================================
var iso = (() => { // var: renderFlow may ask for it during start-up
  const LABELS = ['Policies', 'HR forms', 'Register', 'DoH'];
  const STEPS = [
    { title: 'Step 1 · Prepare the ADHICS policies', sub: 'The policies are printed as Word + PDF with your logo, signature and stamp – each one stamped with your facility’s details.', tab: 'policies' },
    { title: 'Step 2 · HR, training & 3rd-party documents', sub: 'NDA, orientation, exit clearance, training records and vendor forms – same logo, each with its own Ref. No.', tab: 'hr' },
    { title: 'Step 3 · LEGAL REGISTER – the final step', sub: 'Policies are filed in the register and every licence, certificate and contract is tracked with its dates.', tab: 'master' },
    { title: 'Always on · DoH updates', sub: 'New Department of Health circulars are checked every week and added to your register.', tab: 'circulars' },
  ];
  let F = null;
  const STEP_MS = 3800, MOVE_MS = 900;
  const st = { k: 0, t0: 0, playing: true, raf: 0, visible: true, built: false };
  const reduce = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const lerp = (a, b, f) => a.map((v, i) => v + (b[i] - v) * f);
  const ease = f => (f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2);

  function place(k, f) {
    if (!F) return;
    const from = F.centre(k === 0 ? 3 : k - 1), to = F.centre(k);
    const g = lerp(from, to, ease(Math.min(1, f)));
    const hop = f < 1 ? Math.sin(Math.PI * Math.min(1, f)) * (k === 0 ? 70 : 42) : 0;
    const [sx, sy] = F.P(g[0], g[1], g[2] + 8 + hop), [ox, oy] = F.P(0, 0, 0);
    $('#iso-pkg')?.setAttribute('transform', `translate(${(sx - ox).toFixed(1)},${(sy - oy).toFixed(1)})`);
  }
  function show(k) {
    st.k = k;
    const svg = $('#iso-stage svg'); if (svg) IsoFactory.fit(svg, k);
    $$('#iso-stage .iso-isle').forEach(g => g.classList.toggle('on', Number(g.dataset.k) === k));
    $$('#iso-dots button').forEach(b => { const on = Number(b.dataset.k) === k; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    $('#iso-title').textContent = STEPS[k].title; $('#iso-sub').textContent = STEPS[k].sub;
    $('#iso-go').textContent = k === 3 ? 'Open DoH updates →' : `Open step ${k + 1} →`;
  }
  function frame(now) {
    st.raf = 0;
    if (!st.playing || !st.visible || document.hidden) return;
    const el = now - st.t0, k = Math.floor(el / STEP_MS) % 4, f = (el % STEP_MS) / MOVE_MS;
    if (k !== st.k) show(k);
    place(k, f);
    $('#iso-bar').style.width = `${(((el % (STEP_MS * 4)) / (STEP_MS * 4)) * 100).toFixed(2)}%`;
    st.raf = requestAnimationFrame(frame);
  }
  const run = () => { if (!st.raf && st.playing && st.visible) st.raf = requestAnimationFrame(frame); };
  function setPlaying(on) {
    st.playing = on;
    $('#iso-stage')?.classList.toggle('paused', !on);
    $('#iso-play').innerHTML = on ? '❚❚ Pause' : '▶ Play'; $('#iso-play').setAttribute('aria-label', on ? 'Pause' : 'Play');
    if (on) { st.t0 = performance.now() - st.k * STEP_MS - MOVE_MS; run(); } else { cancelAnimationFrame(st.raf); st.raf = 0; }
  }
  function jump(k) { show(k); place(k, 1); $('#iso-bar').style.width = `${((k + 1) / 4) * 100}%`; st.t0 = performance.now() - k * STEP_MS - MOVE_MS; }

  /** Badges: done ✓ / do this now / later – from the same data as the process guide (steps 1-3; DoH follows the register). */
  function progress() {
    if (!st.built || !flowState) return;
    const { st: steps, firstOpen, s, r } = flowState;
    $$('#iso-stage .iso-isle').forEach(g => {
      const k = Number(g.dataset.k);
      const state = k < 3 ? steps[k]?.[0] : (r && (r.status === 'failed' || r.status === 'register_locked')) ? 'bad' : s?.lastSuccess ? 'done' : 'todo';
      g.classList.toggle('done', state === 'done');
      g.classList.toggle('now', k === firstOpen);
      g.classList.toggle('warn', state === 'warn' || state === 'bad');
      const t = g.querySelector('.b-txt');
      if (t) t.textContent = state === 'done' ? `${LABELS[k]} ✓` : k === firstOpen ? 'Do this now' : LABELS[k];
    });
  }

  function init() {
    const stage = $('#iso-stage');
    if (!stage || st.built || !window.IsoFactory) return;
    F = IsoFactory.create({ labels: LABELS, nums: ['1', '2', '3', '↻'], pkgId: 'iso-pkg', gradId: 'isoGlow' });
    stage.innerHTML = F.svg;
    st.built = true;
    const svg = stage.querySelector('svg'), fit = () => IsoFactory.fit(svg, st.k);
    requestAnimationFrame(fit); setTimeout(fit, 400); window.addEventListener('load', fit); IsoFactory.watch(svg);
    $$('#iso-dots button').forEach(b => b.onclick = () => { setPlaying(false); jump(Number(b.dataset.k)); });
    $('#iso-play').onclick = () => setPlaying(!st.playing);
    $('#iso-go').onclick = () => showTab(STEPS[st.k].tab);
    const hide = on => { $('#iso-card').hidden = on; $('#iso-show').hidden = !on; store.set('iso-hidden', on ? '1' : ''); if (on) setPlaying(false); else setPlaying(!reduce()); };
    $('#iso-hide').onclick = () => hide(true);
    $('#iso-unhide').onclick = () => hide(false);
    if ('IntersectionObserver' in window) new IntersectionObserver(e => { st.visible = e[0].isIntersecting; run(); }).observe(stage);
    document.addEventListener('visibilitychange', run);
    jump(0);
    if (store.get('iso-hidden') === '1') hide(true);
    else setPlaying(!reduce()); // people who prefer less motion get the still picture and the step buttons
    progress();
  }
  return { init, progress };
})();
iso.init();

// ===================================================================================================
// HR & checklist: HR / onboarding forms filled with the facility's name, code and logo, and the ADHICS document
// checklist (status + remarks, saved at once, Excel download with the facility branding).
// ===================================================================================================
var hrData = null, hrSection = 'hr', hrStatus = '';
const HR_ST_CLASS = { Completed: 'ok', Pending: 'warn', 'Not applicable': 'na' };
async function loadHr() {
  $('#hr-xlsx').href = u('/api/hr/checklist.xlsx'); $('#hr-zip').href = u('/api/hr/zip');
  try { hrData = await api('/api/hr'); } catch (e) { $('#hr-sum').innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
  if (!hrData.checklist.sections.some(s => s.id === hrSection)) hrSection = hrData.checklist.sections[0]?.id;
  renderHr();
  if (me?.role === 'admin') loadHrCross();
}
function renderHr() {
  const d = hrData, c = d.checklist.counts;
  // branding: the facility's own logo, name and code
  const logo = $('#hr-logo');
  logo.hidden = !d.facility.logo;
  if (d.facility.logo) logo.src = u(`/api/policies/assets/logo?v=${Date.now() % 1e6}`);
  $('#hr-fac').innerHTML = onTemplate() ? 'Master template' : `${esc(d.facility.name)} <span class="pp-code">${esc(d.facility.code)}</span>`;
  const pct = c.total ? Math.round((c.completed / c.total) * 100) : 0;
  $('#hr-sum').innerHTML = `<div class="hr-sum-main"><b>${c.completed}</b><span>of ${c.total} documents completed</span></div>
    <div class="hr-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i class="ok" style="width:${pct}%"></i><i class="na" style="width:${c.total ? (c.na / c.total) * 100 : 0}%"></i></div>
    <div class="hr-sum-legend"><span class="ok">● ${c.completed} completed</span><span class="warn">● ${c.pending} pending</span>${c.na ? `<span class="na">● ${c.na} not applicable</span>` : ''}</div>`;
  homeHr = d; renderJourney(); // the process guide follows the HR step live
  renderHrGen(); renderHrForms(); renderHrTabs(); renderHrRows();
}
/** Per form: PDF ready to open at once (made ahead in the background) and the measured logo position. */
function hrPdfLine(key) {
  const p = hrData.pdf?.forms?.[key];
  if (!p || p.blocked) return '';
  const lay = p.layout;
  const where = lay?.centred ? ' · logo centred ✓' : lay?.centred === false ? ` · <span class="warn">logo ${Math.abs(lay.offsetMm)} mm off centre</span>` : '';
  return p.ready ? `<small class="hr-pdf ok">⚡ PDF ready – opens at once${where}</small>` : '<small class="hr-pdf muted"><span class="spin"></span> Preparing the PDF…</small>';
}
var hrPdfPoll = 0;
function renderHrForms() {
  const d = hrData;
  clearTimeout(hrPdfPoll); // while PDFs are made in the background, refresh until they are all ready
  if (d.pdf?.building || Object.values(d.pdf?.forms || {}).some(p => !p.ready && !p.blocked)) hrPdfPoll = setTimeout(async () => { if (!$('#hr').classList.contains('active') && !$('#thirdparty').classList.contains('active')) return; try { hrData = await api('/api/hr'); renderHr(); } catch { /* next time */ } }, 2500);
  const hrForms = d.forms.filter(f => f.group === 'hr');
  const ready = hrForms.filter(f => f.installed && !f.need.length).length;
  $('#hr-forms-sub').textContent = `${ready} of ${hrForms.length} forms ready · filled with this facility's details every time you open them`;
  renderDocCards('#hr-form-grid', hrForms);
  renderDocCards('#hr-train-grid', d.forms.filter(f => f.group === 'training'));
  renderDocDates('#hr-train-dates', 'training');
  if ($('#thirdparty').classList.contains('active')) renderThirdParty();
  const v = d.aupSync.values;
  const row = (k, l) => `<tr><th>${l}</th><td>${esc(v[k] || '–')}</td></tr>`;
  $('#hr-sync').innerHTML = `<div class="hr-sync-txt"><b>Acceptable Usage Acknowledgement = Acceptable Usage Policy (PO11)</b>
      <small>The acknowledgement (and the third-party one) always shows the same Policy ID, dates, people and version as PO11. Change them once under <a href="#" data-goto-pol>Prepare policies → Details</a> and all follow.${d.aupSync.generatedPolicy ? ' Opening the form also compares it with the created PO11 file.' : ' PO11 has not been created yet.'}</small></div>
    <table class="hr-sync-tbl">${row('policyId', 'Policy ID')}${row('issued', 'Issued on')}${row('reviewed', 'Reviewed on')}${row('due', 'Due for revision')}${row('prepared', 'Prepared by')}${row('approved', 'Approved by')}${row('version', 'Version')}</table>`;
  $$('#hr-sync [data-goto-pol]').forEach(a => a.onclick = e => { e.preventDefault(); showTab('policies'); });
}
/** Cards of documents (HR, training, 3rd-party): Ref. No., ready / what is missing, PDF ready, View / Word / PDF. */
function renderDocCards(sel, forms) {
  const box = $(sel);
  if (!box) return;
  box.innerHTML = forms.map(f => {
    const nn = String(f.no).padStart(2, '0');
    const ok = f.installed && !f.need.length;
    if (f.installed && trialLocked(f.group === 'thirdparty' ? 'thirdparty' : 'hr', f.key)) { // free trial: locked
      return `<div class="hr-form trial-locked">
      <div class="hr-form-top"><span class="hr-no">Ref. No. ${esc(hrData.facility.code)}/${f.series}/FORM-${nn}</span><span class="tag lock-tag">🔒 Premium</span></div>
      <b>${esc(f.title)}</b>
      <small class="muted">Part of Premium – the free trial includes the first ${planState.limits[f.group === 'thirdparty' ? 'thirdparty' : 'hr']} documents.</small>
      <div class="btn-row"><button type="button" class="btn small premium-btn" data-up>🔒 Get Premium</button></div>
    </div>`;
    }
    return `<div class="hr-form${ok ? '' : ' off'}">
      <div class="hr-form-top"><span class="hr-no" title="Reference number printed in the header of this document">Ref. No. ${esc(hrData.facility.code)}/${f.series}/FORM-${nn}</span>${f.policy ? `<span class="tag na" title="Same Policy ID, dates, people and version as the Acceptable Usage Policy">Follows PO${String(f.policy).padStart(2, '0')}</span>` : ''}</div>
      <b>${esc(f.title)}</b>
      ${ok ? `<small class="ok">✓ Ready – name, code and logo filled in</small>${hrPdfLine(f.key)}`
        : `<small class="warn">${!f.installed ? 'Master form not uploaded yet' : `Needs ${esc(f.need.join(', '))}`}</small>`}
      <div class="btn-row">${ok ? `<button type="button" class="btn small primary" data-hr-view="${f.key}">View</button><a class="btn small" href="${u(`/api/hr/forms/${f.key}?format=docx`)}">Word</a><a class="btn small" href="${u(`/api/hr/forms/${f.key}`)}">PDF</a>`
        : f.installed ? (f.need.some(n => /date/.test(n)) ? `<button type="button" class="btn small" data-goto-dates="${f.dates?.setting || ''}">Set the date ↓</button>` : '<button type="button" class="btn small" data-goto-pol>Add the details →</button>') : ''}</div>
    </div>`;
  }).join('') || '<p class="muted small">No master documents uploaded yet.</p>';
  box.querySelectorAll('[data-hr-view]').forEach(b => b.onclick = () => viewHrForm(b.dataset.hrView));
  box.querySelectorAll('[data-goto-pol]').forEach(b => b.onclick = () => showTab('policies'));
  box.querySelectorAll('[data-goto-dates]').forEach(b => b.onclick = () => $(`.doc-dates[data-setting="${b.dataset.gotoDates}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

/**
 * Dates of the training / 3rd-party documents. One date fills every date field of every document (default); a
 * document can switch to its own dates (e.g. training on one day, acknowledgement on another), line by line.
 */
const ymdToDmy = v => (v ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : '–');
function renderDocDates(sel, setting) {
  const box = $(sel), d = hrData;
  if (!box) return;
  const forms = d.forms.filter(f => f.dates?.setting === setting || (f.details && setting === 'training'));
  if (!forms.length) { box.innerHTML = ''; return; }
  const ro = me?.role === 'viewer' ? ' disabled' : '';
  const globalDate = d.dateSettings[setting] || '';
  const fallback = setting === 'thirdparty' ? d.dateSettings.thirdpartyDefault : '';
  const title = setting === 'training' ? 'Training date' : 'Document date';
  const hint = setting === 'training'
    ? 'Enter it once – it fills every date in the training documents. A document can have its own date below (e.g. the acknowledgement signed on another day).'
    : `One date for the 3rd-party documents${fallback ? ` – empty = the policy review date (${ymdToDmy(fallback)})` : ''}. Policy ID, issued / reviewed / due dates follow PO11.`;
  box.innerHTML = `<div class="doc-dates" data-setting="${setting}">
    <div class="dd-global"><label><b>${title}</b><input type="date" data-dd-global value="${esc(globalDate)}"${ro}></label><small class="muted">${hint}</small></div>
    <div class="dd-list">${forms.filter(f => f.dates).map(f => {
      const dt = f.dates;
      return `<div class="dd-row"><div class="dd-what"><b>${esc(f.title)}</b><small class="muted">${dt.fields} date field${dt.fields > 1 ? 's' : ''} (${esc(dt.labels.slice(0, 2).join(', '))}${dt.fields > 2 ? ' …' : ''}) – all get this one date</small></div>
        <label class="dd-own"><input type="date" data-dd-doc="${f.key}" value="${esc(dt.own)}"${ro}><small class="muted">${dt.own ? 'own date' : `= ${title.toLowerCase()} ${ymdToDmy(dt.date)}`}</small></label>
        ${dt.own ? `<button type="button" class="link-btn small" data-dd-reset="${f.key}"${ro}>Use the ${title.toLowerCase()}</button>` : ''}</div>`;
    }).join('')}</div>
    ${forms.filter(f => f.details?.length).map(f => `<div class="dd-details"><b class="small">Details in the ${esc(f.title)}</b><div class="dd-grid">${f.details.map(x => `<label>${esc(x.label)}<input data-dd-detail="${f.key}" data-k="${x.key}" value="${esc(x.value)}" placeholder="${esc(x.master)}"${ro}></label>`).join('')}</div></div>`).join('')}</div>`;
  const save = async (body, msg) => {
    try { await api('/api/hr/documents', { method: 'PUT', body: JSON.stringify(body) }); hrData = await api('/api/hr'); renderHr(); toast(msg); }
    catch (e) { toast(`⚠ ${esc(e.message)}`); }
  };
  box.querySelector('[data-dd-global]').onchange = e => save({ group: setting, date: e.target.value }, `${title} saved – every document without its own date follows it`);
  box.querySelectorAll('[data-dd-doc]').forEach(i => i.onchange = () => save({ key: i.dataset.ddDoc, date: i.value }, i.value ? 'Date saved for this document' : `Back to the ${title.toLowerCase()}`));
  box.querySelectorAll('[data-dd-reset]').forEach(b => b.onclick = () => save({ key: b.dataset.ddReset, date: '' }, `Back to the ${title.toLowerCase()}`));
  box.querySelectorAll('[data-dd-detail]').forEach(i => i.onchange = () => save({ key: i.dataset.ddDetail, details: Object.fromEntries([...box.querySelectorAll(`[data-dd-detail="${i.dataset.ddDetail}"]`)].map(x => [x.dataset.k, x.value])) }, 'Saved'));
}

/** 3rd-party documents page: same branding (logo, name, code) and engine as the HR forms. */
async function loadThirdParty() {
  $('#tp-zip').href = u('/api/hr/zip?group=thirdparty');
  try { hrData = await api('/api/hr'); } catch (e) { $('#tp-grid').innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
  renderThirdParty();
  renderHrForms(); // keeps the PDF refresh going
}
function renderThirdParty() {
  const d = hrData;
  if (!d) return;
  const logo = $('#tp-logo');
  logo.hidden = !d.facility.logo;
  if (d.facility.logo) logo.src = u(`/api/policies/assets/logo?v=${Date.now() % 1e6}`);
  $('#tp-fac').innerHTML = onTemplate() ? 'Master template' : `${esc(d.facility.name)} <span class="pp-code">${esc(d.facility.code)}</span>`;
  const forms = d.forms.filter(f => f.group === 'thirdparty');
  $('#tp-sub').textContent = `${forms.filter(f => f.installed && !f.need.length).length} of ${forms.length} documents ready · Ref. No. ${d.facility.code}/TP/FORM-NN`;
  renderDocCards('#tp-grid', forms);
  renderDocDates('#tp-dates', 'thirdparty');
}
$('#tp-gen').onclick = async () => {
  try { const r = await api('/api/hr/generate', { method: 'POST', body: JSON.stringify({ group: 'thirdparty' }) }); toast(`Creating ${r.total} 3rd-party documents (Word + PDF)…`); hrData = await api('/api/hr'); renderThirdParty(); }
  catch (e) { toast(`⚠ ${esc(e.message)}`); }
};
async function viewHrForm(key) {
  const f = hrData.forms.find(x => x.key === key);
  toast(`Preparing the ${esc(f.title)}…`);
  try {
    const res = await fetch(u(`/api/hr/forms/${key}?inline=1`));
    if (res.status === 401) return location.replace('/login.html');
    if (!res.ok) { const e = await res.json().catch(() => ({})); return toast(`⚠ ${esc(e.error || res.statusText)}`); }
    const rep = JSON.parse(decodeURIComponent(res.headers.get('X-HR-Report') || '%7B%7D'));
    const checks = (rep.leftovers?.length ? `⚠ still mentions ${rep.leftovers.join(', ')}` : '✓ only this facility’s name, code and logo') + (rep.refNo ? ` · Ref. No.: ${rep.refNo}` : '') + (rep.layout?.centred ? ' · logo centred ✓' : rep.layout?.centred === false ? ` · ⚠ logo ${Math.abs(rep.layout.offsetMm)} mm off centre` : '');
    const sync = rep.sync ? (rep.sync.ok && (!rep.sync.generated || rep.sync.generated.ok) ? ' · ✓ same values as PO11'
      : ` · ⚠ differs from PO11: ${[...(rep.sync.diffs || []), ...(rep.sync.generated?.diffs || [])].join('; ')}${rep.sync.generated && !rep.sync.generated.ok ? ' – create the policies again' : ''}`) : '';
    const file = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || `${f.title}.pdf`;
    openViewer(URL.createObjectURL(await res.blob()), { title: f.title, sub: checks + sync, file, revoke: true });
    $('#toast')?.classList.remove('on');
  } catch (e) { toast(`⚠ ${esc(e.message)}`); }
}
function renderHrTabs() {
  $('#hr-tabs').innerHTML = hrData.checklist.sections.map(s => `<button type="button" role="tab" data-sec="${esc(s.id)}" class="${s.id === hrSection ? 'on' : ''}" aria-selected="${s.id === hrSection}">${esc(s.title)}<small>${s.counts.completed}/${s.counts.total}</small></button>`).join('');
  $$('#hr-tabs [data-sec]').forEach(b => b.onclick = () => { hrSection = b.dataset.sec; renderHrTabs(); renderHrRows(); });
  $('#hr-xlsx-one').href = u(`/api/hr/checklist.xlsx?sections=${encodeURIComponent(hrSection)}`);
}
function renderHrRows() {
  const sec = hrData.checklist.sections.find(s => s.id === hrSection);
  if (!sec) return;
  const q = ($('#hr-q').value || '').trim().toLowerCase();
  const ro = me?.role === 'viewer';
  const rows = sec.items.map((it, k) => ({ it, k })).filter(({ it }) => (!q || it.name.toLowerCase().includes(q) || (it.remarks || '').toLowerCase().includes(q)) && (!hrStatus || it.status === hrStatus));
  $('#hr-rows').innerHTML = rows.map(({ it, k }) => {
    const link = it.form ? `<button type="button" class="link-btn" data-hr-view="${it.form}">📄 Open form</button>`
      : it.formMissing ? '<span class="muted small">form not uploaded</span>'
      : it.policy ? (it.policy.pdf ? `<a class="link-btn" href="${u(`/api/policies/file?type=pdf&inline=1&name=${encodeURIComponent(it.policy.pdf)}`)}" target="_blank">📄 Policy PDF</a>` : '<span class="muted small">policy not created yet</span>') : '';
    return `<tr data-id="${esc(it.id)}">
      <td class="num">${k + 1}</td>
      <td><span class="hr-name">${esc(it.name)}</span>${link ? `<div class="hr-link">${link}</div>` : ''}${it.updatedBy ? `<div class="muted small">${esc(it.updatedBy)} · ${fmt(it.updatedAt)}</div>` : ''}</td>
      <td><select class="hr-status ${HR_ST_CLASS[it.status] || 'warn'}" data-status aria-label="Status"${ro ? ' disabled' : ''}>${hrData.checklist.statuses.map(s => `<option${s === it.status ? ' selected' : ''}>${s}</option>`).join('')}</select></td>
      <td><input class="hr-remarks" data-remarks value="${esc(it.remarks || '')}" placeholder="${ro ? '' : 'Add a remark…'}" maxlength="1000" aria-label="Remarks"${ro ? ' disabled' : ''}></td>
      <td><div class="row-actions"><button type="button" class="icon-btn" data-write data-rename title="Rename">✎</button><button type="button" class="icon-btn del" data-write data-remove title="Remove from this facility's checklist">✕</button></div></td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" class="muted">${q || hrStatus ? 'Nothing matches.' : 'No documents in this section yet.'}</td></tr>`;
  const save = async (tr, body, msg) => {
    try { hrData.checklist = await api(`/api/hr/checklist/${encodeURIComponent(hrSection)}/${encodeURIComponent(tr.dataset.id)}`, { method: 'PATCH', body: JSON.stringify(body) }); toast(msg); }
    catch (e) { toast(`⚠ ${esc(e.message)}`); }
    renderHr();
  };
  $$('#hr-rows tr[data-id]').forEach(tr => {
    tr.querySelector('[data-status]').onchange = e => save(tr, { status: e.target.value }, `Saved – ${esc(e.target.value)}`);
    const rm = tr.querySelector('[data-remarks]');
    rm.onchange = () => save(tr, { remarks: rm.value }, 'Remark saved');
    rm.onkeydown = e => { if (e.key === 'Enter') rm.blur(); };
    tr.querySelector('[data-rename]').onclick = () => {
      const cur = tr.querySelector('.hr-name').textContent;
      const n = prompt('Document name', cur);
      if (n && n.trim() && n.trim() !== cur) save(tr, { name: n.trim() }, 'Renamed');
    };
    tr.querySelector('[data-remove]').onclick = async () => {
      const name = tr.querySelector('.hr-name').textContent;
      if (!confirm(`Remove "${name}" from this facility's checklist?\n\nOnly this facility's list changes. "Reset to master list" brings it back.`)) return;
      try { hrData.checklist = await api(`/api/hr/checklist/${encodeURIComponent(hrSection)}/${encodeURIComponent(tr.dataset.id)}`, { method: 'DELETE' }); toast('Removed from the checklist'); }
      catch (e) { toast(`⚠ ${esc(e.message)}`); }
      renderHr();
    };
    tr.querySelector('[data-hr-view]')?.addEventListener('click', e => viewHrForm(e.currentTarget.dataset.hrView));
  });
}
$('#hr-q').oninput = () => renderHrRows();
$$('#hr-st [data-st]').forEach(b => b.onclick = () => { hrStatus = b.dataset.st; $$('#hr-st [data-st]').forEach(x => x.classList.toggle('on', x === b)); renderHrRows(); });
$('#hr-add').onsubmit = async e => {
  e.preventDefault();
  const name = e.target.elements.name.value.trim();
  if (!name) return;
  try { hrData.checklist = await api(`/api/hr/checklist/${encodeURIComponent(hrSection)}`, { method: 'POST', body: JSON.stringify({ name }) }); e.target.reset(); toast('Added to the checklist'); renderHr(); }
  catch (er) { toast(`⚠ ${esc(er.message)}`); }
};
$('#hr-reset').onclick = async () => {
  if (!confirm('Use the master checklist again for this facility?\n\nStatuses and remarks of documents with the same name are kept; documents you added yourself are removed.')) return;
  try { hrData.checklist = await api('/api/hr/checklist/reset', { method: 'POST' }); toast('Checklist reset to the master list'); renderHr(); }
  catch (e) { toast(`⚠ ${esc(e.message)}`); }
};

/** Administrators: the master HR forms, which facility each was written for, and uploads. */
async function loadHrCross() {
  let r;
  try { r = await api('/api/hr/templates'); } catch (e) { $('#hr-cross').innerHTML = `<p class="bad">${esc(e.message)}</p>`; return; }
  const x = r.crossCheck;
  $('#hr-cross').innerHTML = `
    <div class="hr-cross-note">${x.sources.length > 1 ? `<b>${x.sources.length} different facilities</b> found in the masters` : x.sources.length ? '<b>1 facility</b> found in the masters' : 'No facility names found in the masters'}${x.codes.length ? ` · codes ${x.codes.map(esc).join(', ')}` : ''} – all of them are replaced with each facility's own name, code (Ref No CODE-HR-NN) and centred logo, and every filled form is read back to make sure none is left.${x.missing.length ? `<br><span class="warn">Not uploaded yet: ${x.missing.map(esc).join(', ')}</span>` : ''}</div>
    <div class="tbl-wrap"><table class="hr-tbl"><thead><tr><th>Form</th><th>Master file</th><th>Written for</th><th></th></tr></thead><tbody>
    ${r.forms.map(f => `<tr><td><b>FORM-${String(f.no).padStart(2, '0')}</b> ${esc(f.title)}</td>
      <td class="small">${f.master ? `${esc(f.master.original)}<br><span class="muted">${fmt(f.master.uploadedAt)}${f.master.hasLogo ? ' · logo in header' : ''}</span>` : '<span class="warn">not uploaded</span>'}</td>
      <td class="small">${f.master ? ([...(f.master.names || []), ...(f.master.codes || []).map(c => `code ${c}`)].map(esc).join('<br>') || '<span class="muted">no name in the text (logo only)</span>') : '–'}</td>
      <td><label class="btn small">${f.master ? 'Replace' : 'Upload'}<input type="file" accept=".docx,.doc" hidden data-hr-key="${f.key}"></label></td></tr>`).join('')}
    </tbody></table></div>`;
  $$('#hr-cross [data-hr-key]').forEach(i => i.onchange = () => uploadHrForms([...i.files], i.dataset.hrKey));
}
async function uploadHrForms(files, key = '') {
  if (!files.length) return;
  const added = [], problems = [];
  for (const f of files) {
    try {
      const r = await fetch(u(`/api/hr/templates?name=${encodeURIComponent(f.name)}${key ? `&key=${key}` : ''}`), { method: 'POST', body: f });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      added.push(...j.added); problems.push(...j.problems);
    } catch (e) { problems.push(`${f.name}: ${e.message}`); }
  }
  toast(`${added.length ? `✓ ${added.length} form${added.length > 1 ? 's' : ''} added` : 'Nothing added'}${problems.length ? ` · ⚠ ${esc(problems.join('; '))}` : ''}`);
  loadHr();
}
$('#hr-up').onchange = e => { uploadHrForms([...e.target.files]); e.target.value = ''; };
$('#hr-up-xlsx').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const r = await fetch(u('/api/hr/checklist-master'), { method: 'POST', body: f });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    toast(`✓ Master checklist updated: ${j.checklist.map(s => `${esc(s.title)} (${s.items.length})`).join(', ')}. New facilities get it; existing ones with ↺ Reset to master list.`);
  } catch (er) { toast(`⚠ ${esc(er.message)}`); }
};

/** Step 2 of the sequence on the HR page: create every HR document (Word + PDF), live progress, then on to step 3. */
var hrGenPoll = 0;
function renderHrGen() {
  const box = $('#hr-gen-box'), d = hrData;
  if (!box || !d) return;
  const j = d.job, g = d.generated;
  $('#hr-gen').disabled = !!j?.running;
  if (j?.running) {
    const pct = Math.round(((j.done || 0) / Math.max(1, j.total)) * 100);
    box.hidden = false;
    box.innerHTML = `<div class="hx-live" role="status"><div class="hx-live-top"><span class="spin"></span><b>Step 2 · Creating the HR documents – ${j.done || 0} of ${j.total}</b><span>${pct}%</span></div><div class="days-bar"><i style="width:${pct}%"></i></div><small>${esc(j.step || '')}</small></div>`;
    clearTimeout(hrGenPoll);
    hrGenPoll = setTimeout(async () => { try { hrData = await api('/api/hr'); renderHr(); } catch { /* next time */ } }, 1500);
    return;
  }
  if (!g) { box.hidden = true; return; }
  const linked = homePolicies?.linked;
  box.hidden = false;
  box.innerHTML = `<div class="hx-live ${g.passed < g.total || (j?.problems?.length) ? 'warn' : 'ok'}"><b>${g.passed < g.total ? '⚠' : '✓'} Step 2 done: ${g.count} of ${g.total} HR documents created · ${g.passed} checked and correct (${g.pdf} PDF)</b>
    <small>${fmt(g.at)} · saved in the facility folder (HR\\Word and HR\\PDF)${j?.problems?.length ? ` · ${j.problems.map(esc).join(' · ')}` : ''}</small></div>
    <div class="btn-row"><a class="btn small" href="${u('/api/hr/zip')}">⬇ Word + PDF (.zip)</a>${linked ? '<span class="muted small">Step 3 · LEGAL REGISTER is linked ✓</span>' : '<button type="button" class="btn small primary" id="hr-next">Next: Step 3 · link the LEGAL REGISTER (final) →</button>'}</div>`;
  $('#hr-next')?.addEventListener('click', () => { pwStep = 4; showTab('policies'); });
}
$('#hr-gen').onclick = async () => {
  try {
    const r = await api('/api/hr/generate', { method: 'POST', body: '{}' });
    toast(`Creating ${r.total} HR documents…`);
    hrData = await api('/api/hr'); renderHr();
  } catch (e) { toast(`⚠ ${esc(e.message)}`); }
};

$('#pp-to-hr').onclick = () => showTab('hr');

// ===================================================================================================
// Screen fit: drop-down menus stay inside the screen, and on a phone every data table becomes a list of cards
// (each cell shows its column name), so nothing has to be scrolled sideways.
// ===================================================================================================
(() => {
  document.addEventListener('toggle', e => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.open || !d.classList.contains('menu')) return;
    const pop = d.querySelector('.menu-pop');
    if (!pop) return;
    pop.style.left = pop.style.right = pop.style.maxWidth = pop.style.position = pop.style.top = pop.style.bottom = '';
    if (d.closest('.table-wrap')) { // inside a scrolling table: float above the page so the menu is never cut off
      const s = d.querySelector('summary').getBoundingClientRect(), Wd = document.documentElement.clientWidth;
      Object.assign(pop.style, { position: 'fixed', top: `${s.bottom + 6}px`, bottom: 'auto', left: 'auto', right: `${Math.max(8, Wd - s.right)}px`, zIndex: 60 });
      const h = pop.getBoundingClientRect().height;
      if (s.bottom + 6 + h > innerHeight - 8) pop.style.top = `${Math.max(8, s.top - 6 - h)}px`;
      return;
    }
    const W = document.documentElement.clientWidth, r = pop.getBoundingClientRect();
    pop.style.maxWidth = `${W - 16}px`;
    if (r.left < 8) { pop.style.right = 'auto'; pop.style.left = `${8 - d.getBoundingClientRect().left}px`; }
    else if (r.right > W - 8) { pop.style.left = 'auto'; pop.style.right = `${d.getBoundingClientRect().right - (W - 8)}px`; }
  }, true);
  // a floating table menu closes when the page scrolls (it would otherwise drift away from its button)
  window.addEventListener('scroll', () => $$('.table-wrap details.menu[open]').forEach(d => { d.open = false; }), { passive: true });

  function label(root = document) {
    root.querySelectorAll('table:not(.no-cards)').forEach(t => {
      const heads = [...(t.tHead?.rows[t.tHead.rows.length - 1]?.cells || [])].map(th => th.textContent.trim());
      if (!heads.length) return;
      t.classList.add('rt');
      for (const tb of t.tBodies) for (const tr of tb.rows) {
        let c = 0;
        for (const td of tr.cells) {
          const span = td.colSpan || 1;
          if (!td.hasAttribute('data-label')) td.setAttribute('data-label', span > 1 && tr.cells.length === 1 ? '' : heads[c] || '');
          c += span;
        }
      }
    });
  }
  let t = 0;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(label, 60); }).observe(document.body, { childList: true, subtree: true });
  label();
})();

// ===================================================================================================
// Plans: free trial vs premium. Any request the trial does not include answers 402 → the upgrade gateway opens.
// Trial users see a plan chip, a lock on the LEGAL REGISTER, and locked files on the Downloads page.
// ===================================================================================================
var planState = null; // var: may be read before this line runs
/** Free trial: is this document locked? (kind: policies | hr | thirdparty; id: policy number or form key) */
function trialLocked(kind, id) { const inc = planState?.included?.[kind]; return !!inc && !inc.includes(String(id)); }
// every lock / Get Premium button opens the upgrade gateway – and nothing else happens
document.addEventListener('click', e => {
  const b = e.target.closest?.('[data-up]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  showUpgrade();
}, true);
(() => {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await realFetch(...args);
    if (res.status === 402) res.clone().json().then(d => { if (d?.upgrade) showUpgrade(d); }).catch(() => {});
    else if (res.ok && res.headers.get('content-type')?.includes('json')) res.clone().json().then(d => {
      // bulk generation on the trial makes only the included documents – say so in the upgrade gateway
      // (the New facility wizard says it in its summary instead)
      if (d?.limited && !$('#pp-new-dlg')?.open) showUpgrade({ error: `Free trial: only ${d.limited.count}${d.limited.of ? ` of ${d.limited.of}` : ''} document${d.limited.count === 1 ? ' is' : 's are'} being created. Unlimited bulk generation is part of Premium.` });
    }).catch(() => {});
    return res;
  };
  // trial: file links are fetched first, so a locked file opens the upgrade gateway instead of an error page
  document.addEventListener('click', async e => {
    const a = e.target.closest?.('a[href]');
    if (!a || !document.body.classList.contains('trial') || e.defaultPrevented) return;
    if (a.dataset.locked) { e.preventDefault(); showUpgrade(); return; }
    const href = a.getAttribute('href');
    if (!/^\/(api|reports)\//.test(href) || a.classList.contains('disabled') || a.hasAttribute('data-empty')) return;
    e.preventDefault();
    try {
      const res = await realFetch(href);
      if (res.status === 402) { showUpgrade(await res.json().catch(() => ({}))); return; }
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast(`⚠ ${esc(d.error || res.statusText)}`); return; }
      const blob = await res.blob(), url = URL.createObjectURL(blob);
      const cd = res.headers.get('content-disposition') || '';
      const name = /filename\*=UTF-8''([^;]+)/.exec(cd)?.[1] || /filename="([^"]+)"/.exec(cd)?.[1] || '';
      const link = Object.assign(document.createElement('a'), { href: url, target: a.target || '' });
      if (!a.target) link.download = decodeURIComponent(name) || 'download';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { toast(`⚠ ${esc(err.message)}`); }
  }, true);

  const KIND = { policies: 'Policies', hr: 'HR & training documents', thirdparty: '3rd-party documents', facilities: 'Facilities' };
  window.showUpgrade = function showUpgrade(d = {}) {
    const dlg = $('#upgrade-dlg');
    if (!dlg) return;
    $('#up-why').textContent = d.error || 'You are on the free trial. Premium unlocks every document, the live LEGAL REGISTER and full downloads.';
    const meters = () => {
      const p = planState;
      $('#up-meters').innerHTML = p?.limits ? Object.keys(KIND).map(k => {
        const lim = p.limits[k];
        if (k !== 'facilities') return `<div class="up-meter"><span>${KIND[k]}</span><b>First ${lim} included · rest 🔒</b><i style="--w:100%"></i></div>`;
        const used = p.usage.facilities || 0;
        return `<div class="up-meter${used >= lim ? ' full' : ''}"><span>${KIND[k]}</span><b>${Math.min(used, lim)} / ${lim} created</b><i style="--w:${lim ? Math.min(100, (used / lim) * 100) : 100}%"></i></div>`;
      }).join('') + '<div class="up-meter up-locked"><span>LEGAL REGISTER</span><b>🔒 Preview</b><i style="--w:100%"></i></div>' : '';
      const sent = !!me?.premiumRequest, url = planState?.upgradeUrl;
      $('#up-msg').textContent = sent && !url ? 'Premium requested – an administrator will upgrade your account.' : '';
      $('#up-request').textContent = url ? '★ Get Premium ↗' : sent ? '✓ Premium requested' : '★ Get Premium';
      $('#up-request').disabled = sent && !url;
    };
    meters();
    if (!dlg.open) dlg.showModal();
    refreshPlan().then(meters);
  };
  // Get Premium: the subscription page when the administrator set one (new tab), and the administrators are told
  $('#up-request').onclick = async () => {
    const url = planState?.upgradeUrl;
    if (url) window.open(url, '_blank', 'noopener');
    try {
      await apiGlobal('/api/plan/request', { method: 'POST', body: '{}' });
      if (me) me.premiumRequest = { at: new Date().toISOString() };
      $('#up-msg').textContent = url ? 'The upgrade page opened in a new tab. Your account switches to Premium as soon as the administrator confirms it.' : 'Request sent – an administrator will upgrade your account to Premium.';
      if (!url) { $('#up-request').disabled = true; $('#up-request').textContent = '✓ Premium requested'; }
    } catch (e) { $('#up-msg').textContent = e.message; }
  };
  /** Free trial: a new facility only while the trial allows one more – otherwise the upgrade gateway. */
  window.canAddFacility = async function canAddFacility() {
    if (!document.body.classList.contains('trial')) return true;
    await refreshPlan();
    const p = planState;
    if (p?.limits && p.usage.facilities >= p.limits.facilities) {
      showUpgrade({ error: `The free trial includes ${p.limits.facilities} facilit${p.limits.facilities === 1 ? 'y' : 'ies'} – you have created ${p.usage.facilities}. Get Premium to add more facilities and unlock full compliance packs.` });
      return false;
    }
    return true;
  };
  $('#plan-chip').onclick = () => showUpgrade();

  window.refreshPlan = async function refreshPlan() {
    const before = JSON.stringify(planState?.included || null);
    try { planState = await apiGlobal('/api/plan'); } catch { return; }
    const trial = planState.plan === 'trial';
    if (JSON.stringify(planState.included || null) !== before) { // locks changed (first load, or upgraded): draw the pages again
      try { if (pp && !pp.newPackOnly) renderPolicies(); } catch { /* page not loaded */ }
      try { if (hrData) { renderHr(); renderThirdParty(); } } catch { /* page not loaded */ }
    }
    document.body.classList.toggle('trial', trial);
    $('#plan-chip').hidden = !trial;
    if (trial) {
      const l = planState.limits, us = planState.usage;
      $('#plan-chip').title = `Free trial: the first ${l.policies} policies, ${l.hr} HR and ${l.thirdparty} 3rd-party documents · ${us.facilities}/${l.facilities} facilities · LEGAL REGISTER preview`;
      if (!$('#trial-reg')) $('#master')?.insertAdjacentHTML('afterbegin', '<div class="trial-lock" id="trial-reg"><span class="tl-ic" aria-hidden="true">🔒</span><div><b>Preview – locked on the free trial</b><span>You can look around the LEGAL REGISTER. Editing, renewals, weekly DoH updates and register downloads are part of Premium.</span></div><button type="button" class="btn primary small" data-up>Get Premium</button></div>');
      $$('[data-up]').forEach(b => { b.onclick = () => showUpgrade(); });
    } else $('#trial-reg')?.remove();
  };

  // --- Downloads: the facility pack (folder tree, one folder or single files) ---
  let packType = 'all';
  const ICON = { policies: '📄', hr: '🧑‍⚕️', thirdparty: '🤝', register: '📊' };
  window.loadPack = async function loadPack() {
    const tree = $('#pack-tree');
    if (!tree || !facility) return;
    let d;
    try { d = await api('/api/package'); } catch (e) { tree.innerHTML = `<p class="muted small">${esc(e.message)}</p>`; return; }
    $('#pack-root').textContent = `${d.root}/`;
    $('#pack-all').href = u(`/api/package.zip?type=${packType}`);
    const show = f => packType === 'all' || f.type === packType || f.type === 'xlsx';
    tree.innerHTML = `<div class="pk-root"><span aria-hidden="true">📁</span><b>${esc(d.root)}</b></div>` + d.folders.map(fo => {
      const files = fo.files.filter(show);
      const open = files.filter(f => !f.locked).length;
      return `<details class="pk-folder${fo.locked ? ' locked' : ''}">
        <summary>
          <span class="pk-ic" aria-hidden="true">${ICON[fo.key]}</span>
          <span class="pk-name"><b>${esc(fo.name)}</b><small>${files.length ? `${open} file${open === 1 ? '' : 's'}${files.length > open ? ` · ${files.length - open} 🔒 Premium` : ''}` : 'Nothing yet'}</small></span>
          ${fo.locked ? '<button type="button" class="btn small" data-up>🔒 Get Premium</button>' : `<a class="btn small" href="${u(`/api/package.zip?modules=${fo.key}&type=${packType}`)}"${open ? '' : ' data-empty'}>⬇ Folder (.zip)</a>`}
        </summary>
        <ul class="pk-files">${files.map(f => `<li class="${f.locked ? 'locked' : ''}"><span class="pk-sub">${esc(f.sub || '')}</span><span class="pk-file">${esc(f.name)}</span>${f.locked ? '<a href="#" class="pk-dl" data-locked="1" title="Premium" aria-label="Locked – Premium">🔒</a>' : `<a class="pk-dl" href="${esc(f.url)}" title="Download" aria-label="Download ${esc(f.name)}">⬇</a>`}</li>`).join('') || '<li class="muted small">Nothing created yet.</li>'}</ul>
      </details>`;
    }).join('');
    $$('#pack-tree [data-up]').forEach(b => { b.onclick = e => { e.preventDefault(); showUpgrade(); }; });
    $$('#pack-tree [data-empty]').forEach(a => { a.onclick = e => { e.preventDefault(); toast('Nothing to download in this folder yet'); }; });
    $$('#pack-tree [data-locked]').forEach(a => { a.onclick = e => { e.preventDefault(); showUpgrade(); }; });
  };
  $$('#pack-type button').forEach(b => {
    b.onclick = () => {
      packType = b.dataset.t;
      $$('#pack-type button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
      loadPack();
    };
  });

  // --- Admin: trial limits ---
  window.loadLimits = async function loadLimits() {
    const f = $('#limits-form');
    if (!f || me?.role !== 'admin') return;
    try { const { trial, upgradeUrl } = await apiGlobal('/api/plans'); for (const [k, v] of Object.entries(trial)) if (f.elements[k]) f.elements[k].value = v; f.elements.upgradeUrl.value = upgradeUrl || ''; } catch { /* shown on save */ }
  };
  $('#limits-form').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, body = Object.fromEntries(['policies', 'hr', 'thirdparty', 'facilities'].map(k => [k, Number(f.elements[k].value)]));
    try { await apiGlobal('/api/plans', { method: 'PUT', body: JSON.stringify({ trial: body, upgradeUrl: f.elements.upgradeUrl.value.trim() }) }); $('#limits-msg').textContent = 'Saved.'; }
    catch (err) { $('#limits-msg').textContent = err.message; }
  };
})();

// ===================================================================================================
// Welcome message after sign-in: compliance information, "Don't show this again" (saved on the account for this
// version of the message, and in this browser as a fallback). Administrators edit it in Users & security.
// ===================================================================================================
(() => {
  const dlg = $('#welcome-dlg');
  if (!dlg) return;
  const key = v => `welcome-seen:${me?.id || ''}:${v}`;
  const WL_FIELDS = ['title', 'text', 'supportTitle', 'supportText', 'phone', 'phoneNote'];
  let current = null;
  function open(w, { preview = false } = {}) {
    current = { ...w, preview };
    $('#wl-title').textContent = w.title;
    // paragraphs (an empty line in the text starts a new one), then the support box with a tap-to-call number
    $('#wl-text').innerHTML = String(w.text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('');
    $('#wl-sup-title').textContent = w.supportTitle || 'Need assistance?';
    $('#wl-sup-text').textContent = w.supportText || '';
    $('#wl-sup-text').hidden = !w.supportText;
    $('#wl-phone').textContent = w.phone || '';
    $('#wl-phone-note').textContent = w.phoneNote || '';
    $('#wl-call').hidden = !w.phone;
    $('#wl-call').href = w.phone ? `tel:${String(w.phone).replace(/[^\d+]/g, '')}` : '#';
    $('#wl-support').hidden = !w.phone && !w.supportText;
    $('#wl-dont').checked = false;
    $('#wl-dont').closest('label').hidden = preview;
    dlg.classList.remove('closing');
    if (!dlg.open) dlg.showModal();
  }
  // close with a short fade (Esc, the button, or a click on the backdrop)
  function close() {
    if (!dlg.open || dlg.classList.contains('closing')) return;
    remember(); // saved at once – not after the fade-out
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    dlg.classList.add('closing');
    setTimeout(() => { dlg.classList.remove('closing'); dlg.close(); }, reduce ? 0 : 220);
  }
  dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); }); // the backdrop
  $('#wl-ok').onclick = e => { e.preventDefault(); close(); };
  dlg.addEventListener('close', () => remember());
  async function remember() {
    if (!current || current.preview || current.saved || !$('#wl-dont').checked) return;
    current.saved = true;
    try { store.set(key(current.version), '1'); } catch { /* private window */ }
    try { const r = await apiGlobal('/api/account/welcome', { method: 'POST', body: JSON.stringify({ version: current.version }) }); if (me) me.welcomeSeen = r.welcomeSeen; } catch { /* kept in this browser */ }
  }

  window.showWelcome = async function showWelcome() {
    let w;
    try { w = await apiGlobal('/api/welcome'); } catch { return; }
    if (!w.enabled || (me?.welcomeSeen || 0) >= w.version || store.get(key(w.version)) === '1') return;
    if (document.querySelector('dialog[open]')) return; // never on top of another window
    open(w);
  };

  // --- Admin: edit the message ---
  window.loadWelcomeForm = async function loadWelcomeForm() {
    const f = $('#welcome-form');
    if (!f || me?.role !== 'admin') return;
    try {
      const w = await apiGlobal('/api/welcome');
      f.elements.enabled.checked = !!w.enabled; f.elements.showAgain.checked = false;
      for (const k of WL_FIELDS) f.elements[k].value = w[k] || '';
    } catch { /* shown on save */ }
  };
  $('#welcome-form').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    try {
      await apiGlobal('/api/welcome', { method: 'PUT', body: JSON.stringify({ enabled: f.elements.enabled.checked, ...Object.fromEntries(WL_FIELDS.map(k => [k, f.elements[k].value])), showAgain: f.elements.showAgain.checked }) });
      $('#welcome-msg').textContent = f.elements.showAgain.checked ? 'Saved – everyone sees it again at their next sign-in.' : 'Saved.';
      f.elements.showAgain.checked = false;
    } catch (err) { $('#welcome-msg').textContent = err.message; }
  };
  $('#welcome-preview').onclick = () => {
    const f = $('#welcome-form');
    open({ ...Object.fromEntries(WL_FIELDS.map(k => [k, f.elements[k].value])), title: f.elements.title.value || 'Welcome', version: 0 }, { preview: true });
  };
})();
