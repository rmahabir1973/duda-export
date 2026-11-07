const $ = (id) => document.getElementById(id), H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAMES = { cloudflare: 'Cloudflare', duda: 'DUDA', smartermail: 'SmarterMail', hostinger: 'Hostinger', ascio: 'Ascio' };
const DAY = 86400000;
const expiry = (x) => { if (!x.in_ascio) return '<span class="dash">—</span>'; if (!x.ascio_expires) return `<span class="cust">✔</span> <span class="hint">${esc(x.ascio_status || '')}</span>`; const d = new Date(x.ascio_expires), days = Math.round((d - Date.now()) / DAY), cls = days < 0 ? 'exp-past' : days < 60 ? 'exp-soon' : 'hint'; const ns = Array.isArray(x.ascio_ns) ? x.ascio_ns : []; return `<span class="cust">✔</span> <span class="${cls}" title="${esc((x.ascio_status || '') + (ns.length ? ' · NS: ' + ns.join(', ') : '') + (x.ascio_lock ? ' · transfer ' + x.ascio_lock.toLowerCase() : ''))}">${days < 0 ? 'expired ' + (-days) + 'd ago' : 'expires ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + (days < 60 ? ' (' + days + 'd)' : '')}</span>`; };
const PAGE = 100; let offset = 0, timer = null, poll = null;
const api = async (path, opts = {}) => { const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); if (r.status === 401) return location.reload(); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Request failed'); return j; };
const yes = (v, extra = '') => (v ? `<span class="cust">✔</span>${extra ? ' <span class="hint">' + esc(extra) + '</span>' : ''}` : '<span class="dash">—</span>');
async function status() {
	const s = await api('/api/hosted/status'), c = s.counts;
	$('stats').innerHTML = [['Domains', c.total], ['In Cloudflare', c.cloudflare], ['In DUDA', c.duda], ['Email with us', c.smartermail], ['Registered (Ascio)', c.ascio], ['Renewals in 60 days', c.expiring]].map(([l, n]) => `<div class="stat"><small>${l.toUpperCase()}</small><b>${Number(n || 0).toLocaleString()}</b></div>`).join('');
	$('src').innerHTML = Object.keys(NAMES).map((k) => { const x = s.sources[k], on = s.configured[k]; const st = !on ? 'no' : !x ? 'unknown' : x.ok ? 'ok' : 'error'; return `<li class="${st}"><span class="ic">${esc(({ ok: 'OK', no: 'Not set up', unknown: 'Not run yet', error: 'Problem' })[st])}</span><div><b>${NAMES[k]}</b>${x ? ` · ${new Date(x.at).toLocaleString()}` : ''}${x?.ok ? ` · ${x.count} domains${x.note ? ' (' + esc(x.note) + ')' : ''}` : ''}${x && !x.ok ? `<pre>${esc(x.error)}</pre>` : ''}${!on ? '<pre>Not configured on this server.</pre>' : ''}</div></li>`; }).join('');
	$('sync').disabled = s.running; $('syncMsg').textContent = s.running ? 'Syncing… this can take a minute or two.' : '';
	if (s.running && !poll) poll = setInterval(async () => { const t = await api('/api/hosted/status'); if (!t.running) { clearInterval(poll); poll = null; status(); load(); } }, 4000);
	return s;
}
async function load() {
	try {
		const p = new URLSearchParams({ q: $('q').value.trim(), gap: $('gap').value, limit: PAGE, offset }); for (const [k, v] of [...p]) if (v === '') p.delete(k);
		const j = await api('/api/hosted/list?' + p);
		$('rows').innerHTML = j.rows.map((x) => `<tr><td class="nm">${esc(x.domain)}</td><td>${yes(x.in_cloudflare, x.cf_status)}</td><td>${yes(x.in_duda, x.duda_site)}</td><td>${yes(x.in_smartermail)}</td>"<td>${yes(x.in_hostinger, x.hostinger_site)}</td><td>${expiry(x)}</td></tr>`).join('') || '<tr><td colspan="6" class="hint" style="padding:24px;text-align:center">Nothing here yet. Press Sync now.</td></tr>';
		$('page').textContent = j.total ? `${offset + 1}–${Math.min(offset + PAGE, j.total)} of ${j.total.toLocaleString()}` : ''; $('prev').disabled = offset === 0; $('next').disabled = offset + PAGE >= j.total;
	} catch (e) { $('err').textContent = e.message; }
}
$('sync').onclick = async () => { $('err').textContent = ''; try { await api('/api/hosted/sync', { method: 'POST', body: '{}' }); await status(); } catch (e) { $('err').textContent = e.message; } };
$('gap').onchange = () => { offset = 0; load(); }; $('q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { offset = 0; load(); }, 250); };
$('prev').onclick = () => { offset = Math.max(0, offset - PAGE); load(); }; $('next').onclick = () => { offset += PAGE; load(); };
status().then(load).catch((e) => { $('err').textContent = e.message; });

async function candidates() {
	try {
		const c = await api('/api/hosted/board-candidates'); $('cand').hidden = !c.length; if (!c.length) return;
		$('candRows').innerHTML = c.map((x) => `<label style="display:block;margin:4px 0"><input type="checkbox" data-slug="${esc(x.slug)}" checked> <b>${esc(x.name)}</b> <span class="hint">${esc(x.host)}${x.domain ? ' · ' + esc(x.domain) : ' · no real domain found'} · ${x.kind === 'migration' ? 'from DUDA' : 'new site'}</span></label>`).join('');
	} catch { $('cand').hidden = true; }
}
$('candAll').onclick = () => { for (const b of document.querySelectorAll('#candRows input')) b.checked = true; };
$('candAdd').onclick = async () => {
	const slugs = [...document.querySelectorAll('#candRows input:checked')].map((b) => b.dataset.slug); $('candMsg').textContent = '';
	try { const r = await api('/api/hosted/board-import', { method: 'POST', body: JSON.stringify({ slugs }) }); $('candMsg').textContent = `Added ${r.created.length} to the Customers board.${r.skipped.length ? ' Skipped ' + r.skipped.length + '.' : ''}`; await candidates(); } catch (e) { $('candMsg').textContent = e.message; }
};
candidates();
