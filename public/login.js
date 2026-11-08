// Sign-in flow: (first-run setup) -> password -> (new password) -> (authenticator enrolment) -> 6-digit code.
const $ = s => document.querySelector(s);
let token = null;
try { if (localStorage.getItem('ui-look') !== 'fluid') { localStorage.setItem('ui-look', 'fluid'); localStorage.setItem('ui-theme', 'light'); } document.documentElement.dataset.theme = localStorage.getItem('ui-theme') || 'light'; } catch {}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function show(id) {
  document.querySelectorAll('.auth-step').forEach(s => { s.hidden = s.id !== id; });
  $('#msg').textContent = '';
  setTimeout(() => $(`#${id} input`)?.focus(), 50);
}
const msg = (t, ok = false) => { $('#msg').textContent = t; $('#msg').className = `auth-msg ${ok ? 'ok' : 'bad'}`; };
const busy = (form, on) => form.querySelectorAll('button').forEach(b => { b.disabled = on; });

function next(r) {
  token = r.token;
  if (r.stage === 'change-password') return show('f-password');
  if (r.stage === 'enrol') {
    $('#qr').src = r.enrol.qr;
    $('#secret').textContent = r.enrol.secret;
    return show('f-enrol');
  }
  $('#otp-user').textContent = r.username;
  $('#email-code').hidden = !r.emailOtp;
  show('f-otp');
}

async function submit(form, fn) {
  busy(form, true);
  try { await fn(new FormData(form)); } catch (e) { msg(e.message); } finally { busy(form, false); }
}

$('#f-setup').onsubmit = e => { e.preventDefault(); submit(e.target, async d => {
  if (d.get('password') !== d.get('password2')) throw new Error('The passwords do not match');
  next(await post('/api/auth/setup', { username: d.get('username'), email: d.get('email'), password: d.get('password') }));
}); };
$('#f-login').onsubmit = e => { e.preventDefault(); submit(e.target, async d => next(await post('/api/auth/login', { username: d.get('username'), password: d.get('password') }))); };
$('#to-signup').onclick = () => show('f-signup');
document.querySelectorAll('[data-to-login]').forEach(b => { b.onclick = () => show('f-login'); });
$('#f-signup').onsubmit = e => { e.preventDefault(); submit(e.target, async d => {
  if (d.get('password') !== d.get('password2')) throw new Error('The passwords do not match');
  await post('/api/auth/signup', { fullName: d.get('fullName'), username: d.get('username'), email: d.get('email'), password: d.get('password'), note: d.get('note') });
  e.target.reset();
  show('signup-done');
}); };
$('#f-password').onsubmit = e => { e.preventDefault(); submit(e.target, async d => {
  if (d.get('password') !== d.get('password2')) throw new Error('The passwords do not match');
  next(await post('/api/auth/password', { token, password: d.get('password') }));
}); };
const verify = form => submit(form, async d => {
  await post('/api/auth/verify', { token, code: d.get('code') });
  msg('Signed in – opening the portal…', true);
  location.replace('/');
});
$('#f-enrol').onsubmit = e => { e.preventDefault(); verify(e.target); };
$('#f-otp').onsubmit = e => { e.preventDefault(); verify(e.target); };
$('#email-code').onclick = async () => {
  try { const r = await post('/api/auth/email-code', { token }); msg(`A code was sent to ${r.sentTo}. It is valid for 5 minutes.`, true); }
  catch (e) { msg(e.message); }
};

(async () => {
  try {
    const s = await (await fetch('/api/auth/state')).json();
    if (s.user) return location.replace('/');
    if (s.setup) return show(s.setupAllowed ? 'f-setup' : 'setup-remote');
    show('f-login');
  } catch { show('f-login'); }
})();
