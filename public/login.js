const $ = (id) => document.getElementById(id), err = $('err');
const J = { 'Content-Type': 'application/json' };
let accounts = false, after = '/';
const show = (name) => { for (const el of document.querySelectorAll('.step')) el.hidden = !(el.dataset.step === name || (name === 'recovery' && el.id === 'rc')); err.textContent = ''; const f = { password: 'pw', code: 'cd', enroll: 'ec' }[name]; if (f) $(f).focus(); };
const post = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: J, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Sign-in failed'); return j; };
fetch('/api/auth-mode').then((r) => r.json()).then((m) => {
	accounts = m.mode === 'accounts'; $('emailRow').hidden = !accounts;
	if (accounts && m.firstRun) $('hint').textContent = 'First time here: enter your email and the shared setup password to create the first admin account.';
	if (!accounts) $('pw').focus();
}).catch(() => { $('emailRow').hidden = true; });

$('f').addEventListener('submit', async (e) => {
	e.preventDefault(); err.textContent = '';
	try {
		const j = await post('/login', accounts ? { email: $('em').value, password: $('pw').value } : { password: $('pw').value });
		if (j.next === 'code') show('code');
		else if (j.next === 'enroll') { const s = await post('/login/2fa/setup', {}); $('qr').innerHTML = s.qr; $('sec').textContent = s.secret.replace(/(.{4})/g, '$1 ').trim(); show('enroll'); }
		else location.href = j.mustChange ? '/account' : '/';
	} catch (x) { err.textContent = x.message; }
});
$('fc').addEventListener('submit', async (e) => {
	e.preventDefault(); err.textContent = '';
	try { const j = await post('/login/2fa/verify', { code: $('cd').value }); location.href = j.mustChange ? '/account' : '/'; }
	catch (x) { err.textContent = x.message; $('cd').value = ''; $('cd').focus(); }
});
$('fe').addEventListener('submit', async (e) => {
	e.preventDefault(); err.textContent = '';
	try { const j = await post('/login/2fa/enroll', { code: $('ec').value }); after = j.mustChange ? '/account' : '/'; $('codes').textContent = j.recoveryCodes.join('\n'); show('recovery'); }
	catch (x) { err.textContent = x.message; $('ec').value = ''; $('ec').focus(); }
});
$('saved').addEventListener('change', () => { $('done').disabled = !$('saved').checked; });
$('done').addEventListener('click', () => { location.href = after; });
