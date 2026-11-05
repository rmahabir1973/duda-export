// Customers: who manages the DNS, whether email is with us, and the exact DNS plan. Nothing here changes DNS yet: it only shows the plan.
const $ = (id) => document.getElementById(id), H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (path, opts = {}) => {
	const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
	if (r.status === 401) { location.reload(); return new Promise(() => {}); }
	const j = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(j.error || 'Something went wrong.');
	return j;
};
const fmtDate = (t) => t ? new Date(t).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
let rows = [], open = new Set(), plans = {}, confirmBack = null;
const ACTION = { create: ['Add', 'ok'], keep: ['Already there', 'muted'], copy: ['Copy over', 'info'], replace: ['Replaces old', 'warn'], later: ['Switch on later', 'info'] };

function planHtml(id) {
	const p = plans[id];
	if (!p) return '<div class="hint">Working out the plan…</div>';
	if (p.error) return `<div class="err">${esc(p.error)}</div>`;
	const c = p.counts || {};
	const head = [!p.cloudflare ? '<div class="hint bad">Cloudflare isn\'t connected on this server, so the plan is a preview only.</div>' : '', !p.hostingerIp ? '<div class="hint bad">HOSTINGER_IP isn\'t set on this server, so the website records can\'t be planned.</div>' : '',
		p.zone ? `<div class="hint">The domain is in our Cloudflare (${esc(p.zoneStatus)}). ${p.nameservers.length ? 'Nameservers: <code>' + p.nameservers.map(esc).join('</code> and <code>') + '</code>' : ''}</div>` : `<div class="hint">The domain isn't in our Cloudflare yet. ${p.copiedFromPublic ? `${p.copiedFromPublic} records found in their current DNS will be copied.` : 'No records were found in their current DNS.'}</div>`].join('');
	const lines = p.lines.map((l) => { const [w, cls] = ACTION[l.action] || [l.action, '']; return `<tr class="${cls}"><td><span class="chip ${cls}">${w}</span></td><td>${esc(l.type)}</td><td class="mono">${esc(l.name)}</td><td class="mono">${esc(l.content)}${l.priority != null ? ' <small>priority ' + esc(l.priority) + '</small>' : ''}${l.was ? `<small>was ${esc(l.was)}</small>` : ''}</td><td>${l.type === 'MX' || l.type === 'TXT' ? '' : l.proxy ? 'Proxied <small>(after the certificate)</small>' : 'DNS only'}</td><td><small>${esc(l.note || '')}</small></td></tr>`; }).join('');
	return `${head}<div class="pr-tablewrap"><table class="pr-table cu-plan"><thead><tr><th></th><th>Type</th><th>Name</th><th>Points to</th><th>Cloudflare</th><th></th></tr></thead><tbody>${lines}</tbody></table></div>
		<div class="hint">${c.create || 0} to add, ${c.copy || 0} to copy, ${c.replace || 0} replaced, ${c.later || 0} switched on later, ${c.keep || 0} already in place. Nothing has been changed yet.</div>`;
}
function settingsHtml(c) {
	return `<div class="cu-set" data-for="${c.id}">
		<label>Website address <input type="text" data-f="domain" value="${esc(c.domain)}"></label>
		<fieldset><legend>Who manages the DNS?</legend>
			<label class="pr-opt"><input type="radio" name="dns-${c.id}" data-f="dns" value="ours" ${c.dns === 'ours' ? 'checked' : ''}><span><b>We do</b><small>The church moves their nameservers to us. We copy their records and add the new website.</small></span></label>
			<label class="pr-opt"><input type="radio" name="dns-${c.id}" data-f="dns" value="theirs" ${c.dns === 'theirs' ? 'checked' : ''}><span><b>The church does</b><small>We email them the records to add (to them or whoever runs their website).</small></span></label></fieldset>
		<label class="cu-chk"><input type="checkbox" data-f="email" ${c.email ? 'checked' : ''}> Email is hosted with us (adds the mail server records)</label>
		<label>Contact email <input type="text" data-f="contactEmail" value="${esc(c.contactEmail)}" placeholder="office@church.ca"></label>
		<div class="btns"><button class="sm primary" data-save="${c.id}">Save choices</button>
		${confirmBack === c.id ? `<button class="sm danger" data-back2="${c.id}">Yes, move back to Prospects</button> <button class="sm" data-backno="1">Cancel</button>` : `<button class="sm" data-back="${c.id}">Move back to Prospects</button>`}</div>
		<p class="err" data-err="${c.id}"></p></div>`;
}
function row(c) {
	const isOpen = open.has(c.id);
	return `<tr data-id="${c.id}"><td class="c-name"><b>${esc(c.name)}</b><small>${esc(c.domain)}</small></td>
		<td>${c.dns === 'ours' ? 'We manage' : 'Church manages'}</td><td>${c.email ? 'With us' : 'Not with us'}</td><td><small>${esc(c.contactEmail || '—')}</small></td><td>${fmtDate(c.since)}</td>
		<td class="c-act"><button class="sm${isOpen ? '' : ' primary'}" data-open="${c.id}">${isOpen ? 'Hide' : 'DNS plan'}</button>${c.previewUrl ? ` <a class="btn sm" href="${esc(c.previewUrl)}" target="_blank" rel="noopener">Preview</a>` : ''}</td></tr>
		${isOpen ? `<tr class="drow"><td colspan="6">${settingsHtml(c)}<h4>DNS plan</h4>${planHtml(c.id)}</td></tr>` : ''}`;
}
function render() {
	$('cTable').hidden = !rows.length; $('cEmpty').hidden = rows.length > 0;
	$('cRows').innerHTML = rows.map(row).join('');
}
async function loadPlan(id) { plans[id] = null; render(); try { plans[id] = await api(`/api/customers/${id}/plan`); } catch (e) { plans[id] = { error: e.message }; } render(); }
const readForm = (id) => { const box = document.querySelector(`.cu-set[data-for="${id}"]`), g = (f) => box.querySelector(`[data-f="${f}"]`); return { domain: g('domain').value, dns: (box.querySelector('[data-f="dns"]:checked') || {}).value || '', email: g('email').checked, contactEmail: g('contactEmail').value }; };
document.addEventListener('click', async (e) => {
	const t = e.target.closest('[data-open],[data-save],[data-back],[data-back2],[data-backno]'); if (!t) return;
	const d = t.dataset;
	if (d.open) { if (open.has(d.open)) { open.delete(d.open); render(); } else { open.add(d.open); loadPlan(d.open); } return; }
	if (d.backno) { confirmBack = null; return render(); }
	if (d.back) { confirmBack = d.back; return render(); }
	try {
		if (d.back2) { await api(`/api/customers/${d.back2}/revert`, { method: 'POST', body: '{}' }); confirmBack = null; open.delete(d.back2); return load(); }
		if (d.save) { t.disabled = true; await api(`/api/customers/${d.save}/settings`, { method: 'POST', body: JSON.stringify(readForm(d.save)) }); await load(); loadPlan(d.save); }
	} catch (err) { t.disabled = false; const box = document.querySelector(`[data-err="${d.save || d.back2}"]`); if (box) box.textContent = err.message; else alert(err.message); }
});
async function load() { try { rows = await api('/api/customers'); render(); } catch (e) { $('cErr').textContent = e.message; } }
load();
