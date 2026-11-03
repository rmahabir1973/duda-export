const $ = (id) => document.getElementById(id), H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE = 100; let offset = 0, timer = null, LABELS = {}, sort = 'name', dir = 'asc';
const api = async (path, opts = {}) => { const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); if (r.status === 401) return location.reload(); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Request failed'); return j; };
const money = (o) => Object.entries(o || {}).filter(([, v]) => v).map(([c, v]) => `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${esc(c)}`).join(' · ') || '<span class="dash">—</span>';
async function status() {
	const s = await api('/api/whmcs/status'), l = s.last;
	$('sync').disabled = s.running || !s.configured;
	$('src').innerHTML = !s.configured ? '<li class="no"><span class="ic">Not set up</span><div><b>WHMCS</b><pre>Add these in Railway: WHMCS_URL (https://my.churchwebglobal.com), WHMCS_API_IDENTIFIER, WHMCS_API_SECRET. If WHMCS restricts API access by IP, also set WHMCS_ACCESS_KEY (the $api_access_key from WHMCS configuration.php). Create the API credential with a role that allows only GetClients, GetClientsProducts, GetInvoices and GetPaymentMethods.</pre></div></li>'
		: !l ? '<li class="unknown"><span class="ic">Not run yet</span><div><b>WHMCS</b> · press Sync now.</div></li>'
		: `<li class="${l.ok ? (l.skipped?.length ? 'error' : 'ok') : 'error'}"><span class="ic">${l.ok ? (l.skipped?.length ? 'Check' : 'OK') : 'Problem'}</span><div><b>WHMCS</b> · ${new Date(l.at).toLocaleString()}${l.ok ? ` · ${l.clients} customers, ${l.services} services, ${l.invoices} invoices` : `<pre>${esc(l.error)}</pre>`}${l.skipped?.length ? (() => { const n = l.skipped.reduce((a, x) => a + x.count, 0); return `<details class="sect" style="margin-top:6px"><summary>${n} record${n === 1 ? ' was' : 's were'} left out (click to see where)</summary><pre>WHMCS cannot return these records (text with a broken character, often an accented letter pasted from Word), so the numbers below do not include them. Open each one in WHMCS and re-type its text; they come back at the next sync.\n${esc(l.skipped.map((x) => `- ${x.count} ${x.what}${x.count > 1 ? 's' : ''} ${x.beforeId != null ? `between ${x.what} ID ${x.afterId ?? 'the start'} and ID ${x.beforeId}` : `after ${x.what} ID ${x.afterId}`}`).join('\n'))}</pre></details>`; })() : ''}</div></li>`;
	$('syncMsg').textContent = s.running ? 'Syncing… this can take a minute.' : '';
	return s;
}
async function summary() {
	const j = await api('/api/whmcs/summary'), s = j.summary; LABELS = j.labels; $('body').hidden = !s; if (!s) return;
	const by = Object.fromEntries(s.categories.map((c) => [c.category, c])), ch = by.cheque, card = by.card, t = s.totals;
	const pct = t.activeClients ? Math.round(ch.clients / t.activeClients * 100) : 0;
	$('stats').innerHTML = [['Active customers', t.activeClients], ['Active services', t.activeServices], ['Mainly pay by cheque', `${ch.clients} (${pct}%)`], ['Days to pay: cheque vs card', `${ch.avgDaysToPay ?? '—'} vs ${card.avgDaysToPay ?? '—'}`]].map(([l, n]) => `<div class="stat"><small>${esc(l).toUpperCase()}</small><b>${typeof n === 'number' ? n.toLocaleString() : esc(n)}</b></div>`).join('');
	$('cats').innerHTML = s.categories.filter((c) => c.category !== 'none' || c.services).map((c) => `<tr><td class="nm">${esc(c.label)}</td><td>${c.clients}</td><td>${c.anyClients}</td><td>${c.services}</td><td>${money(c.annual)}</td><td>${c.paid12m}${c.paid12m ? ' <span class="hint">' + money(c.paidTotal) + '</span>' : ''}</td><td>${c.avgDaysToPay ?? '<span class="dash">—</span>'}</td><td>${c.unpaid}${c.unpaid ? ' <span class="hint">' + money(c.unpaidTotal) + '</span>' : ''}</td><td>${c.overdue}</td></tr>`).join('');
	const opts = (cur) => `<option value="auto"${cur ? '' : ' selected'}>Automatic</option>` + Object.entries(LABELS).filter(([k]) => k !== 'none').map(([k, v]) => `<option value="${k}"${cur === k ? ' selected' : ''}>${esc(v)}</option>`).join('');
	$('gws').innerHTML = s.gateways.map((g) => `<tr><td class="nm">${esc(g.name)} <span class="hint">${esc(g.module)}</span></td><td>${g.module ? `<select data-m="${esc(g.module)}">${opts(g.overridden ? g.category : '')}</select> <span class="hint">${esc(LABELS[g.category])}${g.overridden ? '' : ' (guess)'}</span>` : '<span class="hint">None set on the service</span>'}</td><td>${g.services}</td><td>${g.clients}</td><td>${money(g.annual)}</td></tr>`).join('');
	for (const sel of $('gws').querySelectorAll('select')) sel.onchange = async () => { $('err').textContent = ''; try { await api('/api/whmcs/gateway-map', { method: 'POST', body: JSON.stringify({ module: sel.dataset.m, category: sel.value }) }); await summary(); await load(); } catch (e) { $('err').textContent = e.message; } };
	if ($('cat').options.length < 2) $('cat').innerHTML += Object.entries(LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
}
async function load() {
	try {
		const p = new URLSearchParams({ q: $('q').value.trim(), category: $('cat').value, any: $('any').checked ? '1' : '', sort, dir, limit: PAGE, offset }); for (const [k, v] of [...p]) if (v === '') p.delete(k);
		const j = await api('/api/whmcs/customers?' + p);
		$('rows').innerHTML = j.rows.map((x) => `<tr><td class="nm">${esc(x.company || x.name)}${x.company && x.name ? ' <span class="hint">' + esc(x.name) + '</span>' : ''}</td><td>${esc(x.email)}</td><td>${esc(x.status)}</td><td>${x.services}</td><td>${esc(LABELS[x.primary])}${x.categories.length > 1 ? ' <span class="hint">+ ' + x.categories.filter((c) => c !== x.primary).map((c) => esc(LABELS[c])).join(', ') + '</span>' : ''}</td><td>${money(x.annual)}</td><td>${esc(x.next)}</td></tr>`).join('') || '<tr><td colspan="7" class="hint" style="padding:24px;text-align:center">Nothing here yet. Press Sync now.</td></tr>';
		$('page').textContent = j.total ? `${offset + 1}–${Math.min(offset + PAGE, j.total)} of ${j.total.toLocaleString()}` : ''; $('prev').disabled = offset === 0; $('next').disabled = offset + PAGE >= j.total;
		const c = new URLSearchParams({ category: $('cat').value, any: $('any').checked ? '1' : '', sort, dir }); for (const [k, v] of [...c]) if (v === '') c.delete(k); $('csv').href = '/api/whmcs/export.csv' + (c.toString() ? '?' + c : '');
	} catch (e) { $('err').textContent = e.message; }
}
$('sync').onclick = async () => { $('err').textContent = ''; $('sync').disabled = true; $('syncMsg').textContent = 'Syncing… this can take a minute.'; try { await api('/api/whmcs/sync', { method: 'POST', body: '{}' }); } catch (e) { $('err').textContent = e.message; } await status(); await summary(); await load(); };
for (const th of document.querySelectorAll('#custHead th')) { th.dataset.label = th.textContent; th.onclick = () => { if (sort === th.dataset.sort) dir = dir === 'asc' ? 'desc' : 'asc'; else { sort = th.dataset.sort; dir = 'asc'; } offset = 0; marks(); load(); }; }
function marks() { for (const th of document.querySelectorAll('#custHead th')) th.textContent = th.dataset.label + (th.dataset.sort === sort ? (dir === 'asc' ? ' ▲' : ' ▼') : ''); }
marks();
$('cat').onchange = () => { offset = 0; load(); }; $('any').onchange = () => { offset = 0; load(); }; $('q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { offset = 0; load(); }, 250); };
$('prev').onclick = () => { offset = Math.max(0, offset - PAGE); load(); }; $('next').onclick = () => { offset += PAGE; load(); };
// remember which sections are open
for (const d of document.querySelectorAll('details.sect[id]')) { try { const v = localStorage.getItem('cw_sect_' + d.id); if (v !== null) d.open = v === '1'; } catch { /* storage unavailable */ } d.addEventListener('toggle', () => { try { localStorage.setItem('cw_sect_' + d.id, d.open ? '1' : '0'); } catch { /* ignore */ } }); }
status().then(summary).then(load).catch((e) => { $('err').textContent = e.message; });
