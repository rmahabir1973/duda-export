const $ = (id) => document.getElementById(id), H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
fetch('/api/me', { headers: H }).then((r) => r.json()).then((m) => { if (m.user) { $('who').textContent = `${m.user.name || m.user.email} · ${m.user.email} · ${m.user.role}`; $('must').hidden = !m.user.mustChange; } });
$('f').addEventListener('submit', async (e) => {
	e.preventDefault(); $('err').textContent = ''; $('ok').textContent = '';
	if ($('nw').value !== $('nw2').value) return ($('err').textContent = 'The two new passwords don\'t match.');
	const r = await fetch('/api/account/password', { method: 'POST', headers: H, body: JSON.stringify({ current: $('cur').value, next: $('nw').value }) });
	const j = await r.json().catch(() => ({}));
	if (!r.ok) return ($('err').textContent = j.error || 'Could not change the password.');
	$('ok').textContent = 'Password changed. Taking you to the portal…'; setTimeout(() => (location.href = '/deploy'), 900);
});

fetch('/api/account/2fa', { headers: H }).then((r) => r.json()).then((t) => { $('tfs').textContent = t.enabled ? `Two-step is on. ${t.recoveryLeft} recovery codes left.` : 'Two-step is not set up yet.'; });
$('rf').addEventListener('submit', async (e) => {
	e.preventDefault(); $('rerr').textContent = '';
	const r = await fetch('/api/account/2fa/recovery', { method: 'POST', headers: H, body: JSON.stringify({ password: $('rpw').value, code: $('rcd').value.trim() }) });
	const j = await r.json().catch(() => ({}));
	if (!r.ok) return ($('rerr').textContent = j.error || 'Could not make new codes.');
	$('codes').hidden = false; $('codes').textContent = 'Save these now. They are shown once:\n\n' + j.codes.join('\n'); $('rpw').value = ''; $('rcd').value = '';
});
