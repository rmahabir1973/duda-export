const $ = (id) => document.getElementById(id);
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LABEL = { ok: 'OK', no: 'Problem', error: 'Error', warn: 'Check', info: 'Note', unknown: 'Unknown', blocked: 'Waiting' };
const post = async (path, body) => {
	const r = await fetch('/api/email' + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
	if (r.status === 401) return location.reload();
	const j = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(j.error || 'Request failed');
	return j;
};
const show = (el, items) => { el.innerHTML = items.map((i) => `<li class="${esc(i.state)}"><span class="ic">${LABEL[i.state] || esc(i.state)}</span><div>${esc(i.label)}${i.detail ? `<pre>${esc(i.detail)}</pre>` : ''}</div></li>`).join(''); };
async function go(btn, out, path, body, confirmText) {
	$('err').textContent = '';
	if (confirmText && !confirm(confirmText)) return;
	const old = btn.textContent; btn.disabled = true; btn.textContent = 'Working…'; out.innerHTML = '';
	try { const j = await post(path, body); show(out, j.items); } catch (e) { $('err').textContent = e.message; }
	btn.disabled = false; btn.textContent = old;
}
const create = (dry) => ({ domain: $('domain').value, addresses: $('boxes').value, password: $('pw').value, dry, confirm: !dry });
$('bPrev').onclick = (e) => go(e.target, $('rCreate'), '/create', create(true));
$('bCreate').onclick = (e) => go(e.target, $('rCreate'), '/create', create(false), `Create ${$('domain').value} and its mailboxes on the live mail server?`);
$('pPrev').onclick = (e) => go(e.target, $('rPm'), '/postmark', { domain: $('domain').value, dry: true });
$('pRun').onclick = (e) => go(e.target, $('rPm'), '/postmark', { domain: $('domain').value, confirm: true }, `Set up Postmark and change DNS records for ${$('domain').value}?`);
$('hRun').onclick = (e) => go(e.target, $('rHealth'), '/health', { domain: $('domain').value });
$('tRun').onclick = (e) => go(e.target, $('rTest'), '/test', { domain: $('domain').value, to: $('to').value, confirm: true }, `Send a test email from test@${$('domain').value} to ${$('to').value}?`);

// Come back to where you were: the fields are remembered (never the password), and the server keeps the last result of each step even if you left while it was running.
const SECT = { create: 'rCreate', postmark: 'rPm', health: 'rHealth', send: 'rTest', test: 'rTest' };
const saveFields = () => { try { localStorage.setItem('emailSetup', JSON.stringify({ domain: $('domain').value, boxes: $('boxes').value, to: $('to').value })); } catch { /* optional */ } };
['domain', 'boxes', 'to'].forEach((id) => $(id).addEventListener('input', saveFields));
let poll = null;
async function restore() {
	const d = $('domain').value.trim(); if (!d) return;
	let j; try { const r = await fetch('/api/email/state?domain=' + encodeURIComponent(d), { headers: H }); j = await r.json(); } catch { return; }
	const made = ((j.history || {}).create?.items || []).map((i) => i.label).filter((l) => /^[^@\s]+@[^@\s]+$/.test(l)).map((l) => l.split('@')[0]);
	if (made.length && !$('boxes').value.trim()) $('boxes').value = made.join('\n');
	for (const [step, h] of Object.entries(j.history || {})) { const el = $(SECT[step]); if (!el) continue; show(el, h.items); el.insertAdjacentHTML('afterbegin', `<li class="info"><span class="ic">Last run</span><div>${new Date(h.at).toLocaleString()}${h.by ? ' by ' + esc(h.by) : ''}</div></li>`); }
	clearTimeout(poll);
	if (j.running) { $('err').textContent = `Still running on the server: ${j.running}. This page will update when it finishes.`; poll = setTimeout(restore, 4000); } else if ($('err').textContent.startsWith('Still running')) $('err').textContent = '';
}
(() => {
	let saved = {}; try { saved = JSON.parse(localStorage.getItem('emailSetup') || '{}'); } catch { /* none */ }
	const q = new URLSearchParams(location.search).get('domain');
	$('domain').value = q || saved.domain || ''; if (!q || q === saved.domain) { $('boxes').value = saved.boxes || ''; $('to').value = saved.to || ''; }
	$('domain').addEventListener('change', restore);
	fetch('/api/customers', { headers: H }).then((r) => r.json()).then((list) => {
		const mine = (Array.isArray(list) ? list : []).filter((c) => c.email);
		$('cust').innerHTML = '<option value="">Choose a customer…</option>' + mine.map((c) => `<option value="${esc(c.domain)}">${esc(c.name)} (${esc(c.domain)})</option>`).join('');
		if (!$('domain').value && mine.length === 1) $('domain').value = mine[0].domain;
		$('cust').value = mine.some((c) => c.domain === $('domain').value) ? $('domain').value : '';
		restore();
	}).catch(restore);
	$('cust').addEventListener('change', () => { if (!$('cust').value) return; $('domain').value = $('cust').value; $('boxes').value = ''; saveFields(); restore(); });
})();
