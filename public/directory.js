const $ = (id) => document.getElementById(id), H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rowsById = {}; const PAGE = 100; let offset = 0, total = 0, meta = null, emailOnly = false, timer = null;
const api = async (path, opts = {}) => { const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); if (r.status === 401) return location.reload(); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Request failed'); return j; };
const num = (n) => Number(n || 0).toLocaleString();
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : 'https://' + u);

function query(extra = {}) {
	const [sort, dir] = $('sort').value.split('|');
	const p = new URLSearchParams({ q: $('q').value.trim(), province: $('province').value, listing: $('listing').value, council: $('council').value, charge: $('charge').value.trim(), hasWebsite: $('hasWebsite').value, customer: $('customer').value, status: $('status').value, sort, dir, ...extra });
	if (emailOnly) p.set('hasEmail', '1');
	for (const [k, v] of [...p]) if (v === '') p.delete(k);
	return p;
}
function renderStats() {
	const s = meta.stats;
	$('stats').innerHTML = [['Churches', s.churches], ['Pastoral charges', s.charges], ['With email', s.withEmail], ['Provinces & territories', s.provinces]].map(([l, n]) => `<div class="stat"><small>${l.toUpperCase()}</small><b>${num(n)}</b></div>`).join('');
	$('src').textContent = meta.source ? `${meta.source.source} · ${num(s.total)} listings` : 'No directory imported yet';
	const cm = meta.customerMatch;
	$('banner').innerHTML = cm.total
		? `<div class="bn-i">✔</div><div><b>Existing customers</b><div class="hint">${num(cm.found)} of ${num(cm.total)} customer domains found in the directory · ${num(cm.notFound.length)} not found</div></div>${cm.notFound.length ? `<button class="sm" id="nf">View not found (${num(cm.notFound.length)})</button>` : ''}`
		: `<div class="bn-i">✔</div><div><b>Existing customers</b><div class="hint">${num(s.customers)} listings are marked as customers. Add your customer domains under "Manage data" to match them exactly.</div></div>`;
	if ($('nf')) $('nf').onclick = () => alert('Customer domains with no listing in the directory:\n\n' + cm.notFound.map((x) => x.domain).join('\n'));
}
function fillSelect(sel, items, label) { const cur = sel.value; sel.innerHTML = `<option value="">${label}</option>` + items.map((i) => `<option value="${esc(i.v ?? i)}">${esc(i.v ?? i)}${i.n ? ' (' + i.n + ')' : ''}</option>`).join(''); sel.value = cur; }
async function loadMeta() {
	meta = await api('/api/directory/meta'); renderStats();
	fillSelect($('province'), meta.provinces, 'All provinces'); fillSelect($('council'), meta.councils, 'Any'); fillSelect($('status'), meta.statuses, 'Any');
}
async function load() {
	$('err').textContent = '';
	try {
		const r = await api('/api/directory?' + query({ limit: PAGE, offset }));
		total = r.total; for (const x of r.rows) rowsById[x.id] = x;
		$('shown').textContent = `Showing ${num(Math.min(PAGE, Math.max(0, total - offset)))} of ${num(total)} matching listings`;
		$('page').textContent = total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${num(total)}` : '';
		$('prev').disabled = offset === 0; $('next').disabled = offset + PAGE >= total;
		$('rows').innerHTML = r.rows.map((x) => `<tr data-id="${x.id}">
			<td class="nm">${esc(x.name)}</td><td><span class="pill">${x.type === 'Pastoral Charge' ? 'CHARGE' : 'CHURCH'}</span></td><td>${esc(x.city)}</td><td>${x.province ? `<span class="pv">${esc(x.province)}</span>` : '<span class="dash">—</span>'}</td>
			<td>${esc(x.address) || '<span class="dash">—</span>'}</td><td>${esc(x.postal) || '<span class="dash">—</span>'}</td><td>${esc(x.phone) || '<span class="dash">—</span>'}</td>
			<td>${x.email ? `<a href="mailto:${esc(x.email)}">${esc(x.email)}</a>` : '<span class="dash">—</span>'}</td>
			<td>${x.website ? `<a href="${esc(safeUrl(x.website))}" target="_blank" rel="noopener noreferrer">${esc(x.website.replace(/^https?:\/\//, ''))}</a>` : '<span class="dash">—</span>'}</td>
			<td>${x.is_customer ? '<span class="cust">✔ Customer</span>' : `<button class="pros" data-pros="${x.id}" title="Add to the Customers board as a new prospect">＋ Prospect</button>`}</td>
			<td><select class="oc" data-id="${x.id}">${meta.statuses.map((s) => `<option${s === x.outreach_status ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select> <button class="note" data-id="${x.id}" title="${esc(x.notes) || 'Add a note'}">${x.notes ? '📝' : '＋'}</button></td></tr>`).join('') || '<tr><td colspan="11" class="hint" style="padding:24px;text-align:center">No listings match. Clear a filter, or import the directory under "Manage data".</td></tr>';
		for (const el of document.querySelectorAll('[data-pros]')) el.onclick = () => startProspect(el.dataset.pros);
		for (const el of document.querySelectorAll('select.oc')) el.onchange = async () => { try { await api('/api/directory/' + el.dataset.id, { method: 'PATCH', body: JSON.stringify({ status: el.value }) }); } catch (e) { $('err').textContent = e.message; } };
		for (const el of document.querySelectorAll('button.note')) el.onclick = async () => { const cur = el.title === 'Add a note' ? '' : el.title; const v = prompt('Note for this church:', cur); if (v === null) return; try { await api('/api/directory/' + el.dataset.id, { method: 'PATCH', body: JSON.stringify({ notes: v }) }); el.title = v || 'Add a note'; el.textContent = v ? '📝' : '＋'; } catch (e) { $('err').textContent = e.message; } };
	} catch (e) { $('err').textContent = e.message; }
	$('export').href = '/api/directory/export.csv?' + query();
}
async function startProspect(id) {
	const x = rowsById[id]; if (!x) return;
	if (!confirm(`Add "${x.name}" to the Customers board as a new prospect?`)) return;
	const body = { name: x.name, kind: 'new', contactEmail: x.email || '', notes: `From the United Church directory: ${[x.city, x.province].filter(Boolean).join(', ')}` };
	const send = (domain) => api('/api/deploy/churches', { method: 'POST', body: JSON.stringify({ ...body, domain }) });
	try {
		let c; try { c = await send(x.website || ''); } catch (e) { c = await send(''); }
		await api('/api/directory/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'to contact' }) });
		alert(`Added. Find "${c.name}" on the Customers board under Prospect.`); load();
	} catch (e) { $('err').textContent = e.message; }
}
const refresh = () => { offset = 0; load(); };
for (const id of ['province', 'listing', 'sort', 'council', 'hasWebsite', 'customer', 'status']) $(id).addEventListener('change', refresh);
for (const id of ['q', 'charge']) $(id).addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 250); });
$('fbtn').onclick = () => { $('panel').hidden = !$('panel').hidden; $('fbtn').classList.toggle('on', !$('panel').hidden); };
$('hasEmail').onclick = () => { emailOnly = !emailOnly; $('hasEmail').classList.toggle('on', emailOnly); refresh(); };
$('clear').onclick = () => { for (const id of ['q', 'province', 'listing', 'council', 'charge', 'hasWebsite', 'customer', 'status']) $(id).value = ''; $('sort').value = 'name|asc'; emailOnly = false; $('hasEmail').classList.remove('on'); refresh(); };
$('prev').onclick = () => { offset = Math.max(0, offset - PAGE); load(); window.scrollTo({ top: 0 }); };
$('next').onclick = () => { offset += PAGE; load(); window.scrollTo({ top: 0 }); };
$('imp').onclick = async () => {
	const f = $('file').files[0]; if (!f) return ($('impOut').textContent = 'Choose the CSV file first.');
	$('imp').disabled = true; $('impOut').textContent = 'Importing…';
	try { const r = await fetch('/api/directory/import', { method: 'POST', headers: { 'Content-Type': 'text/csv', 'X-Requested-With': 'duda-export' }, body: await f.text() }); const j = await r.json(); if (!r.ok) throw new Error(j.error); $('impOut').textContent = `Done: ${num(j.added)} added, ${num(j.updated)} updated.`; await loadMeta(); refresh(); }
	catch (e) { $('impOut').textContent = e.message; }
	$('imp').disabled = false;
};
$('addDoms').onclick = async () => { try { const r = await api('/api/directory/customers', { method: 'POST', body: JSON.stringify({ domains: $('doms').value }) }); $('doms').value = ''; alert(`${r.added} domains added. ${r.found} of ${r.total} customer domains are in the directory.`); await loadMeta(); refresh(); } catch (e) { $('err').textContent = e.message; } };
$('clrDoms').onclick = async () => { if (!confirm('Remove the pasted customer-domain list?')) return; try { await api('/api/directory/customers', { method: 'DELETE' }); await loadMeta(); refresh(); } catch (e) { $('err').textContent = e.message; } };
loadMeta().then(load).catch((e) => { $('err').textContent = e.message; });

/* ---- outreach through Loops */
let oWill = 0;
$('oCamp').value = 'intro-' + new Date().toISOString().slice(0, 7);
async function loadOutreach() {
	try {
		const st = await api('/api/outreach/status'), s = await api('/api/outreach/stats');
		const warn = [!st.configured && 'LOOPS_API_KEY is not set on this server.', st.configured && !st.webhookConfigured && 'LOOPS_WEBHOOK_SECRET is not set, so unsubscribes and bounces from Loops will not come back here yet.'].filter(Boolean);
		$('oWarn').hidden = !warn.length; $('oWarn').textContent = warn.join(' ');
		$('oPrev').disabled = !st.configured;
		$('oStats').textContent = `Last 30 days: ${num(s.sent30)} sent · ${num(s.delivered)} delivered · ${num(s.opened)} opened · ${num(s.clicked)} clicked · ${num(s.bounced)} bounced · ${num(s.unsubscribed)} unsubscribed. Today: ${num(s.sentToday)} of ${num(s.cap)} allowed. Do-not-contact list: ${num(s.suppressed)}.`;
	} catch (e) { $('oStats').textContent = ''; }
}
function oFilters() { const p = Object.fromEntries(query()); return { q: p.q, province: p.province, listing: p.listing, council: p.council, charge: p.charge, hasWebsite: p.hasWebsite, status: p.status }; }
$('oPrev').onclick = async () => {
	$('oErr').textContent = ''; $('oConfirm').hidden = true; $('oRes').textContent = 'Checking…';
	try {
		const r = await api('/api/outreach/preview', { method: 'POST', body: JSON.stringify({ filters: oFilters(), campaign: $('oCamp').value.trim() }) });
		oWill = r.willSend;
		$('oRes').innerHTML = `<b>${num(r.eligible)}</b> churches match. Today's limit allows <b>${num(r.willSend)}</b> (${num(r.remainingToday)} left of ${num(r.cap)}).` + (r.sample.length ? '<br>For example: ' + r.sample.map((x) => `${esc(x.name)} (${esc(x.email)})`).join('; ') : '');
		$('oConfirm').hidden = !r.willSend; $('oType').value = '';
	} catch (e) { $('oRes').textContent = ''; $('oErr').textContent = e.message; }
};
$('oSend').onclick = async () => {
	if ($('oType').value.trim() !== String(oWill)) return ($('oErr').textContent = `Type ${oWill} to confirm.`);
	$('oSend').disabled = true; $('oErr').textContent = '';
	try {
		const r = await api('/api/outreach/send', { method: 'POST', body: JSON.stringify({ filters: oFilters(), campaign: $('oCamp').value.trim(), expect: oWill }) });
		$('oRes').textContent = `Sending ${r.started} emails now. This takes a minute; the numbers below update as Loops reports back.`; $('oConfirm').hidden = true;
		setTimeout(() => { loadOutreach(); load(); }, 8000);
	} catch (e) { $('oErr').textContent = e.message; }
	$('oSend').disabled = false;
};
loadOutreach();
