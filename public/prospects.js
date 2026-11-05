// Prospects: one simple flow per church. Five stages, one status line each, no popups.
const $ = (id) => document.getElementById(id), H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (path, opts = {}) => {
	const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
	if (r.status === 401) { location.reload(); return new Promise(() => {}); }
	const j = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(j.error || 'Something went wrong.');
	return j;
};
const ICON = { done: '✔', working: '●', failed: '!', needs_input: '?', blocked: '⏸', waiting: '○' };
const WORDS = { done: 'Done', working: 'Working', failed: 'Stopped', needs_input: 'Needs you', blocked: 'Waiting', waiting: '' };
let rows = [], me = null, openCards = new Set(), confirmDel = null, answers = {}, adminShown = {}, timer = null, typing = false;

const stageHtml = (s) => `<li class="st ${s.state}" title="${esc(s.message || '')}"><span class="ic">${ICON[s.state] || '○'}</span><span class="tt">${esc(s.title)}</span>${WORDS[s.state] ? `<small>${WORDS[s.state]}</small>` : ''}</li>`;
function card(c) {
	const cur = c.stages.find((s) => s.key === c.currentStage) || c.stages[0];
	const open = openCards.has(c.id) || c.runState === 'needs_input' || c.runState === 'failed';
	const bar = cur.state === 'working' && cur.pct != null ? `<div class="bar"><i style="width:${cur.pct}%"></i></div>` : cur.state === 'working' ? '<div class="bar ind"><i></i></div>' : '';
	const q = c.question ? `<div class="qbox"><b>The AI has a question</b><p>${esc(c.question.text)}</p>
		${(c.question.options || []).map((o) => `<button class="sm" data-ans="${c.id}" data-q="${esc(c.question.id)}" data-v="${esc(o)}">${esc(o)}</button>`).join(' ')}
		<div class="qrow"><input type="text" data-answer="${c.id}" placeholder="Type your answer" value="${esc(answers[c.id] || '')}"><button class="primary sm2" data-send="${c.id}" data-q="${esc(c.question.id)}">Send</button></div></div>` : '';
	const blocked = cur.state === 'blocked' ? `<div class="hint">Until then you can do the last step by hand: <a href="/api/prospects/${c.id}/package">download the ZIP</a>, open <a href="${esc(c.previewUrl)}/wp-admin" target="_blank" rel="noopener">the site</a>, then Site Assistant → Import.</div>` : '';
	const expiry = c.daysLeft != null && c.previewUrl ? `<span class="exp${c.daysLeft <= 7 ? ' soon' : ''}">${c.daysLeft > 0 ? `Deleted in ${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'}` : 'Past its 30 days'}</span> <button class="sm" data-keep="${c.id}">Keep longer</button>` : '';
	const del = confirmDel === c.id ? `<button class="sm danger" data-del2="${c.id}">Yes, delete the preview site</button> <button class="sm" data-delno="1">Cancel</button>` : (me?.user?.role === 'admin' ? `<button class="sm danger" data-del="${c.id}">Delete</button>` : '');
	const adm = adminShown[c.id] ? `<div class="hint">Admin login: <code>${esc(adminShown[c.id].login)}</code> / <code>${esc(adminShown[c.id].password)}</code></div>` : '';
	return `<div class="card pr ${c.runState}" data-id="${c.id}">
		<div class="pr-top"><div><b class="pr-name">${esc(c.name)}</b> <span class="hint">${esc(c.domain)}${c.platform ? ' · ' + esc(c.platform) : ''}</span> <span class="pill">${c.mode === 'full' ? 'FULL SITE' : 'PREVIEW'}</span></div>
			<a href="#" data-more="${c.id}" class="hint">${open ? 'Hide details' : 'Show details'}</a></div>
		<ol class="stages">${c.stages.map(stageHtml).join('')}</ol>
		<div class="status ${cur.state}"><span>${esc(c.headline)}</span></div>${bar}${q}${blocked}
		<div class="btns">
			${c.canRetry ? `<button class="primary sm2" data-run="${c.id}">Try again</button>` : ''}
			${c.canStart && !c.canRetry && c.runState === 'idle' ? `<button class="primary sm2" data-run="${c.id}">Export site</button>` : ''}
			${c.previewUrl && cur.key === 'ready' ? `<a class="btn" href="${esc(c.previewUrl)}" target="_blank" rel="noopener">Open preview</a>` : ''}
			${c.zipReady ? `<a class="btn ghost" href="/api/prospects/${c.id}/package">Download ZIP</a>` : ''}
			${expiry} ${del}
		</div>
		${open ? `<div class="pr-det"><div class="hint">Staff login on the preview: <code>churchweb</code> with the standard staff password. ${me?.user?.role === 'admin' && c.previewUrl ? `<a href="#" data-adm="${c.id}">Show admin login</a>` : ''}</div>${adm}
			${c.docs.length ? `<div class="hint">Extra information: ${c.docs.map((d) => esc(d.name)).join(', ')}</div>` : ''}
			<div class="hint">${c.exported ? `Export: ${c.exported.pages ?? '?'} pages, ${c.exported.images ?? '?'} images. ` : ''}<a href="/deploy?church=${esc(c.id)}">Open the full checklist</a></div></div>` : ''}
	</div>`;
}
function render() {
	if (typing) return;
	const mine = rows.filter((r) => !r.legacy), old = rows.filter((r) => r.legacy);
	$('list').innerHTML = mine.map(card).join('');
	$('empty').hidden = mine.length > 0; if (!mine.length) $('newBox').open = true;
	$('oldBox').hidden = !old.length; $('oldN').textContent = old.length ? `(${old.length})` : '';
	$('old').innerHTML = old.map((o) => `<a href="/deploy?church=${esc(o.id)}">${esc(o.name)}</a>`).join('');
}
async function load() {
	try { rows = await api('/api/prospects'); render(); } catch (e) { $('nErr').textContent = e.message; }
	clearTimeout(timer);
	timer = setTimeout(load, rows.some((r) => ['running', 'needs_input'].includes(r.runState)) ? 4000 : 30000);
}
const act = async (fn) => { try { await fn(); } catch (e) { alert(e.message); } await load(); };

document.addEventListener('focusin', (e) => { if (e.target.matches('[data-answer]')) typing = true; });
document.addEventListener('focusout', (e) => { if (e.target.matches('[data-answer]')) { typing = false; } });
document.addEventListener('input', (e) => { if (e.target.matches('[data-answer]')) answers[e.target.dataset.answer] = e.target.value; });
document.addEventListener('click', async (e) => {
	const t = e.target.closest('[data-more],[data-run],[data-keep],[data-del],[data-del2],[data-delno],[data-adm],[data-ans],[data-send]'); if (!t) return;
	e.preventDefault();
	const d = t.dataset;
	if (d.more) { openCards.has(d.more) ? openCards.delete(d.more) : openCards.add(d.more); return render(); }
	if (d.run) return act(() => api(`/api/prospects/${d.run}/run`, { method: 'POST', body: '{}' }));
	if (d.keep) return act(() => api(`/api/prospects/${d.keep}/keep`, { method: 'POST', body: '{}' }));
	if (d.del) { confirmDel = d.del; return render(); }
	if (d.delno) { confirmDel = null; return render(); }
	if (d.del2) { confirmDel = null; return act(() => api(`/api/deploy/churches/${d.del2}`, { method: 'DELETE', body: JSON.stringify({ confirm: d.del2, deleteSite: true }) })); }
	if (d.adm) { adminShown[d.adm] = await api(`/api/prospects/${d.adm}/admin-login`).catch((x) => ({ login: 'error', password: x.message })); return render(); }
	if (d.ans) { typing = false; return act(() => api(`/api/prospects/${d.ans}/answer`, { method: 'POST', body: JSON.stringify({ questionId: d.q, answer: d.v }) })); }
	if (d.send) { const v = (answers[d.send] || '').trim(); if (!v) return; typing = false; answers[d.send] = ''; return act(() => api(`/api/prospects/${d.send}/answer`, { method: 'POST', body: JSON.stringify({ questionId: d.q, answer: v }) })); }
});

/* ---- the form */
let detectTimer = null, nameTouched = false;
$('nName').addEventListener('input', () => { nameTouched = true; });
async function detect() {
	const u = $('nUrl').value.trim(); if (!u) return;
	$('nDetect').textContent = 'Looking at the website…';
	try { const d = await api('/api/prospects/detect?url=' + encodeURIComponent(u)); if (!nameTouched) $('nName').value = d.name; $('nDetect').textContent = d.platform ? `Looks like a ${d.platform} site. The portal handles that on its own.` : 'Got it.'; }
	catch (e) { $('nDetect').textContent = e.message; }
}
$('nUrl').addEventListener('change', detect);
$('newForm').addEventListener('submit', async (e) => {
	e.preventDefault(); $('nErr').textContent = ''; $('nGo').disabled = true;
	try {
		const files = [...$('nFiles').files];
		const c = await api('/api/prospects', { method: 'POST', body: JSON.stringify({ url: $('nUrl').value, name: $('nName').value, contactEmail: $('nEmail').value, mode: document.querySelector('input[name=mode]:checked').value, notes: $('nNotes').value, start: !files.length }) });
		for (const f of files) {
			const r = await fetch(`/api/prospects/${c.id}/docs`, { method: 'POST', headers: { 'X-Requested-With': 'duda-export', 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) }, body: f });
			if (!r.ok) { const j = await r.json().catch(() => ({})); $('nErr').textContent = `${f.name}: ${j.error || 'could not upload'}`; }
		}
		if (files.length) await api(`/api/prospects/${c.id}/run`, { method: 'POST', body: '{}' });
		const dirId = new URLSearchParams(location.search).get('dir');
		if (dirId) fetch('/api/directory/' + encodeURIComponent(dirId), { method: 'PATCH', headers: H, body: JSON.stringify({ status: 'to contact' }) }).catch(() => {});
		$('newForm').reset(); nameTouched = false; $('nDetect').textContent = ''; $('newBox').open = false; openCards.add(c.id);
		history.replaceState(null, '', '/prospects');
	} catch (x) { $('nErr').textContent = x.message; }
	$('nGo').disabled = false; await load();
});

/* ---- start */
(async () => {
	me = await fetch('/api/me', { headers: H }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
	const p = new URLSearchParams(location.search);
	if (p.get('url')) { $('nUrl').value = p.get('url'); if (p.get('name')) { $('nName').value = p.get('name'); nameTouched = true; } if (p.get('email')) $('nEmail').value = p.get('email'); $('newBox').open = true; if (!p.get('name')) detect(); else api('/api/prospects/detect?url=' + encodeURIComponent(p.get('url'))).then((d) => { $('nDetect').textContent = d.platform ? `Looks like a ${d.platform} site.` : ''; }).catch(() => {}); }
	load();
})();
