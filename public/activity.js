const $ = (id) => document.getElementById(id), H = { 'X-Requested-With': 'duda-export' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE = 100; let offset = 0, timer = null, usersLoaded = false;
const qs = () => { const p = new URLSearchParams({ q: $('q').value.trim(), user: $('user').value }); for (const [k, v] of [...p]) if (!v) p.delete(k); return p; };
async function load() {
	$('err').textContent = '';
	try {
		const p = qs(); p.set('limit', PAGE); p.set('offset', offset);
		const r = await fetch('/api/audit?' + p, { headers: H }); if (r.status === 401) return location.reload();
		const j = await r.json(); if (!r.ok) throw new Error(j.error);
		if (!usersLoaded) { $('user').insertAdjacentHTML('beforeend', j.users.map((u) => `<option>${esc(u)}</option>`).join('')); usersLoaded = true; }
		$('rows').innerHTML = j.rows.map((x) => `<tr><td>${esc(new Date(x.at).toLocaleString())}</td><td>${esc(x.user_email || '—')}</td><td><b>${esc(x.action)}</b></td><td>${esc(x.target)}</td><td>${x.status == null ? '' : `<span class="pv">${esc(x.status)}</span>`}</td><td class="hint">${x.detail ? esc(JSON.stringify(x.detail)).slice(0, 160) : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="hint" style="padding:24px;text-align:center">Nothing recorded yet.</td></tr>';
		$('page').textContent = j.total ? `${offset + 1}–${Math.min(offset + PAGE, j.total)} of ${j.total.toLocaleString()}` : '';
		$('prev').disabled = offset === 0; $('next').disabled = offset + PAGE >= j.total;
		$('export').href = '/api/audit/export.csv?' + qs();
	} catch (e) { $('err').textContent = e.message; }
}
$('user').onchange = () => { offset = 0; load(); };
$('q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { offset = 0; load(); }, 250); };
$('prev').onclick = () => { offset = Math.max(0, offset - PAGE); load(); };
$('next').onclick = () => { offset += PAGE; load(); };
load();
