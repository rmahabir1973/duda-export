const $ = (id) => document.getElementById(id), H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEC = { '': '— decide —', renewing: 'Renewing', contact: 'Contact the church', expire: 'Let it expire' };
const PAGE = 100; let offset = 0, timer = null;
const api = async (path, opts = {}) => { const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); if (r.status === 401) return location.reload(); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Request failed'); return j; };
const fmt = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const daysCls = (d) => (d <= 7 ? 'exp-past' : d <= 30 ? 'exp-soon' : 'hint');
async function summary() {
	const s = await api('/api/registrar/summary');
	$('stats').innerHTML = [['Live registrations', s.live], ['Within 90 days', s.d90], ['Within 30 days', s.d30], ['No decision (60 days)', s.undecided60]].map(([l, n]) => `<div class="stat"><small>${l.toUpperCase()}</small><b>${Number(n || 0).toLocaleString()}</b></div>`).join('');
	const a = s.ascio;
	$('banner').innerHTML = !s.configured ? '<p class="err">Ascio is not set up on this server (ASCIO_ACCOUNT, ASCIO_PASSWORD).</p>' : !a ? '<p class="hint">Ascio has not been synced yet. Press Sync from Ascio now.</p>' : a.ok ? `<p class="hint">Ascio synced ${new Date(a.at).toLocaleString()} · ${a.note || a.count + ' domains'} · ${s.hidden} deleted, transferred or expired registration${s.hidden === 1 ? '' : 's'} hidden${s.last_alert ? ` · alerts last checked ${new Date(s.last_alert.at).toLocaleString()}${s.last_alert.found ? ` (${s.last_alert.found} new${s.last_alert.sent ? ', email sent' : ''})` : ''}` : ''}</p>` : `<p class="err">The last Ascio sync failed (${new Date(a.at).toLocaleString()}): ${esc(a.error)}</p>`;
}
async function load() {
	try {
		const p = new URLSearchParams({ q: $('q').value.trim(), window: $('window').value, decision: $('decision').value, limit: PAGE, offset }); if (!p.get('q')) p.delete('q');
		const j = await api('/api/registrar/list?' + p);
		$('rows').innerHTML = j.rows.map((x) => {
			const host = [x.in_cloudflare ? 'DNS: Cloudflare' : 'DNS: elsewhere', x.in_duda ? 'site: DUDA' : x.in_hostinger ? 'site: Hostinger' : 'site: none', x.in_smartermail ? 'email: yes' : ''].filter(Boolean).join(' · ');
			const who = [x.whmcs ? `<b>${esc(x.whmcs.client)}</b>${x.whmcs.service_status ? ' <span class="pill">' + esc(x.whmcs.service_status) + '</span>' : ''}` : (x.board ? `<b>${esc(x.board.name)}</b> <span class="pill">board</span>` : ''), x.ascio_owner ? `<span class="hint">${esc(x.ascio_owner)}</span>` : '', x.own ? '<span class="pill">our own</span>' : ''].filter(Boolean).join('<br>');
			const ns = x.nameservers.length ? x.nameservers.map((n) => n.replace(/\.ns\.cloudflare\.com$/, '.ns.cloudflare…')).slice(0, 2).join(', ') + (x.nameservers.length > 2 ? ' +' + (x.nameservers.length - 2) : '') : 'no nameservers';
			return `<tr data-d="${esc(x.domain)}"><td class="nm">${esc(x.domain)}<br><span class="hint">${esc(x.ascio_status)}</span></td><td><b class="${daysCls(x.days)}">${x.days <= 0 ? 'today' : x.days + ' day' + (x.days === 1 ? '' : 's')}</b><br><span class="hint">${fmt(x.ascio_expires)}</span></td><td>${who || '<span class="dash">—</span>'}</td><td class="hint">${esc(host)}</td><td class="hint">${x.ascio_lock ? esc(x.ascio_lock) : '—'}<br>${esc(ns)}</td><td><select class="dec">${Object.entries(DEC).map(([k, v]) => `<option value="${k}"${k === x.decision ? ' selected' : ''}>${v}</option>`).join('')}</select>${x.decided_by ? `<br><span class="hint">${esc(x.decided_by.split('@')[0])} · ${fmt(x.decided_at)}</span>` : ''}</td><td><input class="note" value="${esc(x.note)}" placeholder="Note" style="width:100%;min-width:140px"></td></tr>`;
		}).join('') || '<tr><td colspan="7" class="hint" style="padding:24px;text-align:center">Nothing in this window.</td></tr>';
		$('page').textContent = j.total ? `${offset + 1}–${Math.min(offset + PAGE, j.total)} of ${j.total.toLocaleString()}` : ''; $('prev').disabled = offset === 0; $('next').disabled = offset + PAGE >= j.total;
	} catch (e) { $('err').textContent = e.message; }
}
async function save(tr) {
	const domain = tr.dataset.d, decision = tr.querySelector('.dec').value, note = tr.querySelector('.note').value.trim(); $('err').textContent = '';
	try { await api('/api/registrar/decide', { method: 'POST', body: JSON.stringify({ domain, decision, note }) }); $('msg').textContent = `Saved ${domain}.`; setTimeout(() => { $('msg').textContent = ''; }, 2500); summary(); } catch (e) { $('err').textContent = e.message; }
}
$('rows').addEventListener('change', (e) => { if (e.target.classList.contains('dec') || e.target.classList.contains('note')) save(e.target.closest('tr')); });
$('rows').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('note')) { e.preventDefault(); e.target.blur(); } });
$('sync').onclick = async () => { $('err').textContent = ''; $('msg').textContent = 'Syncing… this can take a minute or two.'; try { await api('/api/hosted/sync', { method: 'POST', body: '{}' }); const poll = setInterval(async () => { const t = await api('/api/hosted/status'); if (!t.running) { clearInterval(poll); $('msg').textContent = ''; summary(); load(); } }, 4000); } catch (e) { $('msg').textContent = ''; $('err').textContent = e.message; } };
$('check').onclick = async () => { $('err').textContent = ''; try { const r = await api('/api/registrar/alerts/check', { method: 'POST', body: '{}' }); $('msg').textContent = r.found ? `${r.found} domain(s) entered a new window${r.sent ? '; email sent' : ''}.` : 'Nothing new: every domain in a window has already been reported.'; summary(); } catch (e) { $('err').textContent = e.message; } };
$('window').onchange = $('decision').onchange = () => { offset = 0; load(); }; $('q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { offset = 0; load(); }, 250); };
$('prev').onclick = () => { offset = Math.max(0, offset - PAGE); load(); }; $('next').onclick = () => { offset += PAGE; load(); };
summary().then(load).catch((e) => { $('err').textContent = e.message; });
