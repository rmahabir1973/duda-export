const $ = (id) => document.getElementById(id);
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
const api = async (path, opts = {}) => {
	const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
	if (r.status === 401) return location.reload();
	const j = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(j.error || 'Request failed');
	return j;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let openLog = null, cfg = {};

api('/api/config').then((c) => {
	cfg = c;
	$('ret').textContent = c.retentionHours;
	if (c.apiAvailable) $('apiBox').hidden = false;
	else $('noApi').hidden = false;
});
$('useApi')?.addEventListener('change', () => ($('siteBox').hidden = !$('useApi').checked));

$('f').addEventListener('submit', async (e) => {
	e.preventDefault();
	$('err').textContent = '';
	$('go').disabled = true;
	try {
		const j = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ domain: $('domain').value, site: $('site')?.value || '', useApi: $('useApi')?.checked || false, maxPages: $('maxPages').value, skipImages: $('skipImages').checked }) });
		openLog = j.id;
		$('domain').value = '';
		refresh();
	} catch (x) {
		$('err').textContent = x.message;
	}
	$('go').disabled = false;
});
$('logout').onclick = async () => {
	await api('/logout', { method: 'POST' });
	location.reload();
};

const when = (t) => (t ? new Date(t).toLocaleString() : '');
function result(j) {
	if (j.status === 'done' && j.summary) {
		const s = j.summary;
		return `${s.pages} pages · ${s.images} images · ${s.documents} documents · ${s.zipMB} MB${s.flags ? ` · <b>${s.flags} to check</b>` : ''}`;
	}
	if (j.error) return `<span style="color:#b32d2e">${esc(j.error)}</span>`;
	return '<span class="small">' + (j.status === 'running' ? 'working…' : '') + '</span>';
}
async function refresh() {
	let list;
	try {
		list = await api('/api/jobs');
	} catch {
		return;
	}
	$('rows').innerHTML = list.length
		? list.map((j) => `<tr><td><b>${esc(j.domain)}</b><div class="small">${esc(when(j.created))}${j.useApi ? ' · API' : ''}</div></td>
		<td><span class="badge ${j.status}">${j.status}</span></td><td>${result(j)}</td>
		<td><div class="actions">${j.status === 'done' ? `<a href="/api/jobs/${j.id}/download"><button class="sm" type="button">Download ZIP</button></a>` : ''}
		<button class="sm" data-act="log" data-id="${j.id}" type="button">Log</button>
		${j.status === 'running' || j.status === 'queued' ? `<button class="sm danger" data-act="cancel" data-id="${j.id}" type="button">Cancel</button>` : `<button class="sm danger" data-act="del" data-id="${j.id}" type="button">Delete</button>`}</div></td></tr>`).join('')
		: '<tr><td colspan="4" class="small">No exports yet.</td></tr>';
	if (openLog) {
		try {
			const j = await api('/api/jobs/' + openLog);
			$('logWrap').hidden = false;
			$('logTitle').textContent = `${j.domain}: ${j.status}`;
			const el = $('log');
			const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
			el.textContent = j.log.join('\n');
			if (atEnd) el.scrollTop = el.scrollHeight;
		} catch {
			openLog = null;
			$('logWrap').hidden = true;
		}
	}
}
$('rows').addEventListener('click', async (e) => {
	const b = e.target.closest('button[data-act]');
	if (!b) return;
	const { act, id } = b.dataset;
	if (act === 'log') {
		openLog = id;
		$('log').scrollTop = 1e9;
	} else if (act === 'cancel') await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
	else if (act === 'del' && confirm('Delete this export?')) {
		await api(`/api/jobs/${id}`, { method: 'DELETE' });
		if (openLog === id) {
			openLog = null;
			$('logWrap').hidden = true;
		}
	}
	refresh();
});
refresh();
setInterval(refresh, 2500);
