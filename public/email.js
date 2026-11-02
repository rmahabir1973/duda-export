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
$('logout').onclick = async () => { await fetch('/logout', { method: 'POST', headers: H }); location.reload(); };
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
