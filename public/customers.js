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
let rmConfirm = null, rows = [], open = new Set(), plans = {}, confirmBack = null, tests = {}, drafts = {}, busy = {}, notes = {};
const ACTION = { create: ['Add', 'ok'], keep: ['Already there', 'muted'], copy: ['Copy over', 'info'], replace: ['Replaces old', 'warn'], later: ['Added later', 'info'] };

function planHtml(id) {
	const p = plans[id];
	if (!p) return '<div class="hint">Working out the plan…</div>';
	if (p.error) return `<div class="err">${esc(p.error)}</div>`;
	const c = p.counts || {};
	const head = [!p.cloudflare ? '<div class="hint bad">Cloudflare isn\'t connected on this server, so the plan is a preview only.</div>' : '', !p.hostingerIp ? '<div class="hint bad">HOSTINGER_IP isn\'t set on this server, so the website records can\'t be planned.</div>' : '',
		p.zone ? `<div class="hint">The domain is in our Cloudflare (${esc(p.zoneStatus)}). ${p.nameservers.length ? 'Nameservers: <code>' + p.nameservers.map(esc).join('</code> and <code>') + '</code>' : ''}</div>` : `<div class="hint">The domain isn't in our Cloudflare yet. ${p.copiedFromPublic ? `${p.copiedFromPublic} records found in their current DNS will be copied.` : 'No records were found in their current DNS.'}</div>`].join('');
	const lines = p.lines.map((l) => { const [w, cls] = ACTION[l.action] || [l.action, '']; return `<tr class="${cls}"><td><span class="chip ${cls}">${w}</span></td><td>${esc(l.type)}</td><td class="mono">${esc(l.name)}</td><td class="mono">${esc(l.content)}${l.priority != null ? ' <small>priority ' + esc(l.priority) + '</small>' : ''}${l.was ? `<small>was ${esc(l.was)}</small>` : ''}</td><td>${l.type === 'MX' || l.type === 'TXT' ? '' : l.proxy ? 'Proxied <small>(after the certificate)</small>' : 'DNS only'}</td><td><small>${esc(l.note || '')}</small>${l.removable && l.id && p.zone ? (rmConfirm === l.id ? ` <button class="sm danger" data-rm2="${l.id}" data-cust="${id}">Yes, remove</button> <button class="sm" data-rmno="1">Cancel</button>` : ` <button class="sm" data-rm="${l.id}">Remove</button>`) : ''}</td></tr>`; }).join('');
	return `${head}<div class="pr-tablewrap"><table class="pr-table cu-plan"><thead><tr><th></th><th>Type</th><th>Name</th><th>Points to</th><th>Cloudflare</th><th></th></tr></thead><tbody>${lines}</tbody></table></div>
		<div class="hint">${c.create || 0} to add, ${c.copy || 0} to copy, ${c.replace || 0} replaced, ${c.later || 0} switched on later, ${c.keep || 0} already in place.${p.zone ? '' : ' Nothing has been changed yet.'}</div>`;
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
const STATE = { ok: ['OK', 'ok'], no: ['Not yet', 'warn'], info: ['Info', 'muted'] };
function dnsActionsHtml(c) {
	if (c.dns !== 'ours') return '<h4>DNS</h4><div class="hint">The church manages its own DNS. Emailing them the records is coming next.</div>';
	const d = drafts[c.id], t = tests[c.id], n = notes[c.id], b = busy[c.id];
	const setup = `<div class="btns"><button class="sm primary" data-setup="${c.id}" ${b ? 'disabled' : ''}>${b === 'setup' ? 'Setting up…' : c.dnsSetupAt ? 'Run DNS setup again' : 'Set up DNS in Cloudflare'}</button>
		<button class="sm" data-draft="${c.id}" ${b ? 'disabled' : ''}>Nameserver email…</button> <button class="sm" data-test="${c.id}" ${b ? 'disabled' : ''}>${b === 'test' ? 'Testing…' : 'Test'}</button></div>`;
	const note = n ? `<div class="hint ${n.bad ? 'bad' : ''}">${n.html}</div>` : '';
	const sent = c.nsEmailAt ? `<div class="hint">Nameserver email sent to ${esc(c.nsEmailTo)} on ${fmtDate(c.nsEmailAt)}.</div>` : '';
	const form = d ? `<div class="cu-mail"><label>To <input type="text" data-m="to" value="${esc(d.to)}" placeholder="office@church.ca"></label><label>Subject <input type="text" data-m="subject" value="${esc(d.subject)}"></label>
		<label>Message <textarea data-m="body" rows="16">${esc(d.body)}</textarea></label><div class="btns"><button class="sm primary" data-sendns="${c.id}" ${b ? 'disabled' : ''}>${b === 'send' ? 'Sending…' : 'Send from ' + esc(d.from)}</button> <button class="sm" data-closens="${c.id}">Close</button></div></div>` : '';
	const res = t ? `<table class="pr-table cu-plan"><tbody>${t.checks.map((k) => { const [w, cls] = STATE[k.state] || [k.state, '']; return `<tr class="${cls}"><td><span class="chip ${cls}">${w}</span></td><td>${esc(k.label)}</td><td><small>${esc(k.detail)}</small></td></tr>`; }).join('')}</tbody></table>
		<div class="hint">${t.ok ? 'Everything checked is in place.' : 'Some checks are not in place yet. That is normal until the church has switched its nameservers.'}</div>` : '';
	return `<h4>DNS</h4><div class="hint">Setting up DNS only adds records in our Cloudflare. Nothing changes for the church until they switch their nameservers.</div>${setup}${note}${sent}${form}${res}`;
}
function emailCell(c) {
	if (!c.email) return 'Not with us';
	const e = c.emailSetup || {}, ok = (k) => e[k] && e[k].items.length && e[k].items.every((i) => ['ok', 'info'].includes(i.state));
	const steps = [['create', 'Mailboxes'], ['postmark', 'Postmark'], ['health', 'Checked']];
	return `With us<small>${steps.map(([k, w]) => `${ok(k) ? '✓' : '·'} ${w}`).join('  ')}</small>`;
}
function costCell(c) { const k = c.cost; if (!k) return '<small>—</small>'; const v = k.total ? k.total.usd : (k.preview?.usd || 0) + (k.full?.usd || 0); return v > 0 ? '$' + v.toFixed(2) : '<small>—</small>'; }
function row(c) {
	const isOpen = open.has(c.id);
	return `<tr data-id="${c.id}"><td class="c-name"><b>${esc(c.name)}</b><small>${esc(c.domain)}</small></td>
		<td>${c.dns === 'ours' ? 'We manage' : 'Church manages'}</td><td>${emailCell(c)}</td><td>${c.live ? '<span class="chip ok">Live</span>' : c.mode === 'full' ? 'Full site' : 'Preview'}</td><td>${costCell(c)}</td><td><small>${esc(c.contactEmail || '—')}</small></td><td>${fmtDate(c.since)}</td>
		<td class="c-act"><button class="sm${isOpen ? '' : ' primary'}" data-open="${c.id}">${isOpen ? 'Hide' : 'DNS plan'}</button>${c.previewUrl ? ` <a class="btn sm" href="${esc(c.previewUrl)}" target="_blank" rel="noopener">Preview</a>` : ''}</td></tr>
		${isOpen ? `<tr class="drow"><td colspan="8">${settingsHtml(c)}<h4>DNS plan</h4>${planHtml(c.id)}${actionsHtml(c)}</td></tr>` : ''}`;
}
function render() {
	$('cTable').hidden = !rows.length; $('cEmpty').hidden = rows.length > 0;
	$('cRows').innerHTML = rows.map(row).join('');
}
async function loadPlan(id) { plans[id] = null; render(); try { plans[id] = await api(`/api/customers/${id}/plan`); } catch (e) { plans[id] = { error: e.message }; } render(); }
const readForm = (id) => { const box = document.querySelector(`.cu-set[data-for="${id}"]`), g = (f) => box.querySelector(`[data-f="${f}"]`); return { domain: g('domain').value, dns: (box.querySelector('[data-f="dns"]:checked') || {}).value || '', email: g('email').checked, contactEmail: g('contactEmail').value }; };
const usd = (n) => '$' + (n || 0).toFixed(2);
function costHtml(c) {
	const k = c.cost; if (!k) return '';
	const parts = [k.preview && k.preview.usd != null ? `preview ${usd(k.preview.usd)}` : '', k.full && k.full.usd != null ? `full site ${usd(k.full.usd)}` : ''].filter(Boolean);
	const total = k.total ? `${usd(k.total.usd)} in total` : parts.length ? '' : (k.tracked ? 'not measured yet' : 'not tracked');
	return `<div class="hint"><b>AI cost for this church:</b> ${[total, parts.length ? '(' + parts.join(', ') + ')' : ''].filter(Boolean).join(' ')}. DNS, email and go-live use no AI; this is everything the church\'s site has spent through the gateway since its preview began.</div>`;
}
function siteHtml(c) {
	const b = busy[c.id], g = c.goliveItems;
	const full = c.mode === 'full' ? `<div class="hint">Full site: ${esc(c.runState === 'done' ? 'built' : c.headline || c.runState)}.</div>` : c.canFull ? `<button class="sm" data-fullsite="${c.id}" ${b ? 'disabled' : ''}>Build full site</button>` : `<div class="hint">${esc(c.headline || 'Preview')}</div>`;
	const live = c.live ? `<div class="hint ok">Live on ${esc(c.domain)}.</div>` : '';
	const res = g ? `<table class="pr-table cu-plan"><tbody>${g.map((k) => { const [w, cls] = STATE[k.state] || (k.state === 'blocked' ? ['Waiting', 'muted'] : k.state === 'error' ? ['Error', 'warn'] : [k.state, '']); return `<tr class="${cls}"><td><span class="chip ${cls}">${w}</span></td><td>${esc(k.label)}</td><td><small>${esc(k.detail || '')}</small></td></tr>`; }).join('')}</tbody></table>` : '';
	return `<h4>Site</h4>${costHtml(c)}<div class="btns">${full} <button class="sm primary" data-golive="${c.id}" ${b || c.runState !== 'done' ? 'disabled' : ''}>${b === 'golive' ? 'Working…' : c.live ? 'Check the live site again' : 'Move preview to the live domain'}</button></div>${live}
		<div class="hint">Moving to the live domain needs the domain to point at our hosting (DNS set up and, for "We manage", nameservers switched). Hostinger takes a few minutes for the certificate: press the button again until every line is green.</div>${res}`;
}
function emailHtml(c) {
	const e = c.emailSetup || {}, names = { create: 'Mailboxes', postmark: 'Postmark', health: 'Check', send: 'Test email', test: 'Test email' };
	const rows = Object.entries(e).map(([k, h]) => `<tr><td>${esc(names[k] || k)}</td><td><small>${new Date(h.at).toLocaleString('en-CA')}${h.by ? ' · ' + esc(h.by) : ''}</small></td><td>${h.items.map((i) => `<span class="chip ${i.state === 'ok' ? 'ok' : ['no', 'error'].includes(i.state) ? 'warn' : 'muted'}">${esc(i.label)}</span>`).join(' ')}</td></tr>`).join('');
	return c.email ? `<h4>Email</h4><div class="btns"><a class="btn sm primary" href="/email?domain=${encodeURIComponent(c.domain)}">Open Email setup</a></div>${rows ? `<table class="pr-table cu-plan"><tbody>${rows}</tbody></table>` : '<div class="hint">No email setup has been run for this domain yet.</div>'}` : '';
}
function historyHtml(c) {
	return `<details class="cu-hist"><summary>History (${c.history.length})</summary><ul>${c.history.map((h) => `<li><small>${new Date(h.at).toLocaleString('en-CA')}${h.by ? ' · ' + esc(h.by) : ''}</small> ${esc(h.text)}</li>`).join('')}</ul></details>`;
}
const actionsHtml = (c) => dnsActionsHtml(c) + siteHtml(c) + emailHtml(c) + historyHtml(c);
const readMail = (id) => { const box = document.querySelector(`.cu-set[data-for="${id}"]`).closest('td'), g = (f) => box.querySelector(`[data-m="${f}"]`).value; return { to: g('to'), subject: g('subject'), body: g('body') }; };
async function act(id, kind, fn) {
	busy[id] = kind; notes[id] = null; render();
	try { await fn(); } catch (err) { notes[id] = { bad: true, html: esc(err.message) }; }
	busy[id] = null; render();
}
document.addEventListener('click', async (e) => {
	const t = e.target.closest('[data-open],[data-save],[data-back],[data-back2],[data-backno],[data-setup],[data-rm],[data-rm2],[data-rmno],[data-fullsite],[data-golive],[data-draft],[data-test],[data-sendns],[data-closens]'); if (!t) return;
	const d = t.dataset;
	if (d.setup) return act(d.setup, 'setup', async () => {
		const r = await api(`/api/customers/${d.setup}/dns/setup`, { method: 'POST', body: '{}' });
		notes[d.setup] = { bad: r.errors.length > 0, html: `${r.created ? 'Added the domain to Cloudflare. ' : ''}${r.done.length} records written${r.errors.length ? `, ${r.errors.length} failed: ${r.errors.map(esc).join('; ')}` : ''}.${r.flagged.length ? ' Needs a person: ' + r.flagged.map(esc).join('; ') : ''}${r.nameservers.length ? ' Nameservers: <code>' + r.nameservers.map(esc).join('</code> and <code>') + '</code>' : ''}` };
		await load(); loadPlan(d.setup);
	});
	if (d.rmno) { rmConfirm = null; return render(); }
	if (d.rm) { rmConfirm = d.rm; return render(); }
	if (d.rm2) { const id = d.cust; rmConfirm = null; return act(id, 'rm', async () => { const r = await api(`/api/customers/${id}/dns/delete`, { method: 'POST', body: JSON.stringify({ recordId: d.rm2 }) }); notes[id] = { html: `Removed ${esc(r.removed)}.` }; await loadPlan(id); }); }
	if (d.fullsite) return act(d.fullsite, 'full', async () => { await api(`/api/customers/${d.fullsite}/full`, { method: 'POST', body: '{}' }); notes[d.fullsite] = { html: 'The full site build has started. Follow it on the Prospects page.' }; await load(); });
	if (d.golive) return act(d.golive, 'golive', async () => { await api(`/api/customers/${d.golive}/golive`, { method: 'POST', body: '{}' }); await load(); });
	if (d.draft) return act(d.draft, 'draft', async () => { drafts[d.draft] = await api(`/api/customers/${d.draft}/ns-email`); });
	if (d.closens) { drafts[d.closens] = null; return render(); }
	if (d.sendns) return act(d.sendns, 'send', async () => {
		const r = await api(`/api/customers/${d.sendns}/ns-email/send`, { method: 'POST', body: JSON.stringify(readMail(d.sendns)) });
		drafts[d.sendns] = null; notes[d.sendns] = { html: `Sent to ${esc(r.to)}.` }; await load();
	});
	if (d.test) return act(d.test, 'test', async () => { tests[d.test] = await api(`/api/customers/${d.test}/test`); });
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
