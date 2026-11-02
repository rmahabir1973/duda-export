const $ = (id) => document.getElementById(id), H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (path, method = 'GET', body) => { const r = await fetch(path, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Request failed'); return j; };
const show = (who, pw) => { $('tmp').hidden = false; $('tmp').innerHTML = `Temporary password for <b>${esc(who)}</b> (shown once, not saved): <code>${esc(pw)}</code>`; window.scrollTo({ top: 0 }); };
async function load() {
	try {
		const us = await api('/api/users');
		$('rows').innerHTML = us.map((u) => `<tr><td><b>${esc(u.name || u.email)}</b><div class="hint">${esc(u.email)}</div></td>
			<td><select data-role="${u.id}"><option value="staff"${u.role === 'staff' ? ' selected' : ''}>Staff</option><option value="admin"${u.role === 'admin' ? ' selected' : ''}>Admin</option></select></td>
			<td>${u.twoFactor ? '<span class="cust">On</span>' : '<span class="dash">Not set up</span>'}${u.locked ? ' <span class="pv">locked</span>' : ''}${u.active ? '' : ' <span class="pv">disabled</span>'}</td>
			<td class="hint">${u.lastLogin ? esc(new Date(u.lastLogin).toLocaleString()) : 'never'}</td>
			<td><button class="sm" data-reset="${u.id}" data-who="${esc(u.email)}">Reset password</button> <button class="sm" data-r2="${u.id}">Reset 2-step</button> <button class="sm${u.active ? ' danger' : ''}" data-act="${u.id}" data-on="${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('');
		for (const el of document.querySelectorAll('[data-role]')) el.onchange = () => api('/api/users/' + el.dataset.role, 'PATCH', { role: el.value }).then(load).catch((e) => { $('err').textContent = e.message; load(); });
		for (const el of document.querySelectorAll('[data-reset]')) el.onclick = () => confirm('Reset this password? Their sessions will end.') && api('/api/users/' + el.dataset.reset + '/reset', 'POST').then((j) => { show(el.dataset.who, j.tempPassword); load(); }).catch((e) => ($('err').textContent = e.message));
		for (const el of document.querySelectorAll('[data-r2]')) el.onclick = () => confirm('Remove their two-step setup? They will set it up again at next sign-in.') && api('/api/users/' + el.dataset.r2 + '/reset-2fa', 'POST').then(load).catch((e) => ($('err').textContent = e.message));
		for (const el of document.querySelectorAll('[data-act]')) el.onclick = () => api('/api/users/' + el.dataset.act, 'PATCH', { active: el.dataset.on === '1' }).then(load).catch((e) => ($('err').textContent = e.message));
	} catch (e) { $('err').textContent = e.message; }
}
$('f').addEventListener('submit', async (e) => {
	e.preventDefault(); $('err').textContent = '';
	try { const j = await api('/api/users', 'POST', { email: $('em').value.trim(), name: $('nm').value.trim(), role: $('rl').value }); show(j.user.email, j.tempPassword); $('f').reset(); load(); } catch (x) { $('err').textContent = x.message; }
});
load();
