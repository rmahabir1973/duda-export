const $ = (id) => document.getElementById(id), H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAMES = { cloudflare: 'Cloudflare', duda: 'DUDA', smartermail: 'SmarterMail', hostinger: 'Hostinger' };
const PAGE = 100; let offset = 0, timer = null, poll = null;
const api = async (path, opts = {}) => { const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); if (r.status === 401) return location.reload(); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Request failed'); return j; };
const yes = (v, extra = '') => (v ? `<span class="cust">✔</span>${extra ? ' <span class="hint">' + esc(extra) + '</span>' : ''}` : '<span class="dash">—</span>');
async function status() {
	const s = await api('/api/hosted/status'), c = s.counts;
	$('stats').innerHTML = [['Domains', c.total], ['In Cloudflare', c.cloudflare], ['In DUDA', c.duda], ['Email with us', c.smartermail]].map(([l, n]) => `<div class="stat"><small>${l.toUpperCase()}</small><b>${Number(n || 0).toLocaleString()}</b></div>`).join('');
	$('src').innerHTML = Object.keys(NAMES).map((k) => { const x = s.sources[k], on = s.configured[k]; const st = !on ? 'no' : !x ? 'unknown' : x.ok ? 'ok' : 'error'; return `<li class="${st}"><span class="ic">${esc(({ ok: 'OK', no: 'Not set up', unknown: 'Not run yet', error: 'Problem' })[st])}</span><div><b>${NAMES[k]}</b>${x ? ` · ${new Date(x.at).toLocaleString()}` : ''}${x?.ok ? ` · ${x.count} domains${x.note ? ' (' + esc(x.note) + ')' : ''}` : ''}${x && !x.ok ? `<pre>${esc(x.error)}</pre>` : ''}${!on ? '<pre>Not configured on this server.</pre>' : ''}</div></li>`; }).join('');
	$('sync').disabled = s.running; $('syncMsg').textContent = s.running ? 'Syncing… this can take a minute or two.' : '';
	if (s.running && !poll) poll = setInterval(async () => { const t = await api('/api/hosted/status'); if (!t.running) { clearInterval(poll); poll = null; status(); load(); } }, 4000);
	return s;
}
async function load() {
	try {
		const p = new URLSearchParams({ q: $('q').value.trim(), gap: $('gap').value, limit: PAGE, offset }); for (const [k, v] of [...p]) if (v === '') p.delete(k);
		const j = await api('/api/hosted/list?' + p);
		$('rows').innerHTML = j.rows.map((x) => `<tr><td class="nm">${esc(x.domain)}</td><td>${yes(x.in_cloudflare, x.cf_status)}</td><td>${yes(x.in_duda, x.duda_site)}</td><td>${yes(x.in_smartermail)}</td><td>${yes(x.in_hostinger, x.hostinger_site)}</td></tr>`).join('') || '<tr><td colspan="5" class="hint" style="padding:24px;text-align:center">Nothing here yet. Press Sync now.</td></tr>';
		$('page').textContent = j.total ? `${offset + 1}–${Math.min(offset + PAGE, j.total)} of ${j.total.toLocaleString()}` : ''; $('prev').disabled = offset === 0; $('next').disabled = offset + PAGE >= j.total;
	} catch (e) { $('err').textContent = e.message; }
}
$('sync').onclick = async () => { $('err').textContent = ''; try { await api('/api/hosted/sync', { method: 'POST', body: '{}' }); await status(); } catch (e) { $('err').textContent = e.message; } };
$('gap').onchange = () => { offset = 0; load(); }; $('q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { offset = 0; load(); }, 250); };
$('prev').onclick = () => { offset = Math.max(0, offset - PAGE); load(); }; $('next').onclick = () => { offset += PAGE; load(); };
status().then(load).catch((e) => { $('err').textContent = e.message; });
