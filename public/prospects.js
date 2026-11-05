// Prospects: a dashboard of every church, with one simple five-stage flow per church. No popups.
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
let seen = false, rows = [], costs = null, me = null, openCards = new Set(), confirmDel = null, confirmFull = null, confirmRestart = null, answers = {}, adminShown = {}, timer = null, typing = false;

const stageHtml = (s) => `<li class="st ${s.state}" title="${esc(s.message || '')}"><span class="ic">${ICON[s.state] || '○'}</span><span class="tt">${esc(s.title)}</span>${WORDS[s.state] ? `<small>${WORDS[s.state]}</small>` : ''}</li>`;
const fmtDate = (t) => t ? new Date(t).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const who = (e) => String(e || '').replace(/@.*/, '');
const curOf = (c) => c.stages.find((s) => s.key === c.currentStage) || c.stages[0];
const needsYou = (c) => c.runState === 'needs_input';
const isOpen = () => true; // every church always shows its stages; no Details toggle

function daysCell(c) {
	if (!c.previewUrl || c.daysLeft == null) return '<span class="hint">—</span>';
	const n = c.daysLeft, cls = n <= 2 ? 'bad' : n <= 7 ? 'soon' : 'ok';
	return `<span class="days ${cls}"><b>${n > 0 ? n : 0}</b> day${n === 1 ? '' : 's'}</span><small>${n > 0 ? 'until deleted' : 'past its 30 days'}</small>`;
}
const usd = (n) => '$' + Number(n || 0).toFixed(2);
const big = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0);
function costCell(c) {
	const k = c.cost; if (!k) return '<span class="hint">—</span>';
	const part = (label, e) => !e ? '' : e.state === 'unavailable' ? `<div class="cost"><small class="cost-note" title="${esc(e.note)}">${label}: no reading</small></div>` : `<div class="cost"><b>${usd(e.usd)}</b><small>${label}${e.state === 'running' ? ' · so far' : ''}${e.estimated ? ' · estimate' : ''}</small></div>`;
	return part('preview', k.preview) + part('full site', k.full) || (k.tracked ? '<span class="hint">—</span>' : '<small>Not tracked</small>');
}
function costDetail(c) {
	const k = c.cost; if (!k) return '';
	return [['preview', k.preview], ['full site', k.full]].map(([label, e]) => {
		if (!e) return '';
		if (e.state === 'unavailable') return `<div class="hint cost-note">AI cost for the ${label}: not measured. ${esc(e.note)}</div>`;
		const t = e.tokens || {}, m = (e.byModel || []).map((x) => `${esc(x.model.replace('claude-', ''))} ${usd(x.usd)}`).join(', ');
		return `<div class="hint"><b>AI cost for the ${label}: ${usd(e.usd)}</b>${e.state === 'running' ? ' so far' : ''} · ${e.calls} AI calls · ${big(t.input)} new input, ${big(t.output)} output, ${big(t.cacheWrite)} cache writes, ${big(t.cacheRead)} cache reads${m ? ' · ' + m : ''}${e.estimated ? ' · Haiku is priced at its lower rate, so treat this as a minimum' : ''}</div>`;
	}).join('');
}
function statusCell(c) {
	const cur = curOf(c), label = c.runState === 'done' ? 'Ready' : needsYou(c) ? 'Needs you' : c.runState === 'failed' ? 'Stopped' : c.runState === 'idle' ? 'Not started' : cur.title;
	return `<span class="chip ${c.runState}">${esc(label)}</span><small>${esc(c.headline || '')}</small>`;
}
function actions(c) {
	const out = [];
	if (c.canRetry) out.push(`<button class="primary sm2" data-run="${c.id}">Try again</button>`);
	if (c.canStart && !c.canRetry && c.runState === 'idle') out.push(`<button class="primary sm2" data-run="${c.id}">Start</button>`);
	if (c.previewUrl && c.runState === 'done') out.push(`<a class="btn sm" href="${esc(c.previewUrl)}" target="_blank" rel="noopener">Preview</a>`);
	if (c.canRestart) out.push(confirmRestart === c.id ? `<button class="sm primary" data-restart2="${c.id}">Yes, stop and restart</button> <button class="sm" data-restartno="1">Cancel</button>` : `<button class="sm" data-restart="${c.id}" title="Stop the build and start it again">Stop &amp; restart</button>`);
	if (c.canLogin) out.push(`<button class="sm" data-login="${c.id}" title="Sign in to this site's WordPress admin">WP-Admin</button>`);
	if (c.canFull) out.push(confirmFull === c.id ? `<button class="sm primary" data-full2="${c.id}">Yes, build the full site</button> <button class="sm" data-fullno="1">Cancel</button>` : `<button class="sm" data-full="${c.id}" title="Keep this site and build every page">Build full site</button>`);
	if (c.previewUrl && c.daysLeft != null) out.push(`<button class="sm" data-ext="${c.id}" ${c.daysLeft >= 30 ? 'disabled title="Already at the 30-day maximum"' : ''}>+7 days</button>`);
	if (c.previewUrl && c.runState === 'done') out.push(`<button class="sm" data-lic="${c.id}" title="Apply the Oxygen licence to this site">Oxygen licence</button>`);
	if (c.canDelete) out.push(confirmDel === c.id ? `<button class="sm danger" data-del2="${c.id}">Yes, delete the site</button> <button class="sm" data-delno="1">Cancel</button>` : `<button class="sm danger" data-del="${c.id}">Delete</button>`);
	return out.join(' ');
}
function detail(c) {
	const cur = curOf(c);
	const bar = cur.state === 'working' && cur.pct != null ? `<div class="bar"><i style="width:${cur.pct}%"></i></div>` : cur.state === 'working' ? '<div class="bar ind"><i></i></div>' : '';
	const q = c.question ? `<div class="qbox"><b>The AI has a question</b><p>${esc(c.question.text)}</p>
		${(c.question.options || []).map((o) => `<button class="sm" data-ans="${c.id}" data-q="${esc(c.question.id)}" data-v="${esc(o)}">${esc(o)}</button>`).join(' ')}
		<div class="qrow"><input type="text" data-answer="${c.id}" placeholder="Type your answer" value="${esc(answers[c.id] || '')}"><button class="primary sm2" data-send="${c.id}" data-q="${esc(c.question.id)}">Send</button></div></div>` : '';
	const blocked = cur.state === 'blocked' ? `<div class="hint">Until then you can do the last step by hand: <a href="/api/prospects/${c.id}/package">download the ZIP</a>, open <a href="${esc(c.previewUrl)}/wp-admin" target="_blank" rel="noopener">the site</a>, then Site Assistant → Import.</div>` : '';
	const adm = adminShown[c.id] ? `<div class="hint">Admin login: <code>${esc(adminShown[c.id].login)}</code> / <code>${esc(adminShown[c.id].password)}</code></div>` : '';
	const docs = c.docs.length ? `<ul class="pr-docs">${c.docs.map((d) => `<li class="${d.readable ? '' : 'bad'}">${esc(d.name)} <small>${esc(d.note || '')}</small></li>`).join('')}</ul>` : '';
	return `<ol class="stages">${c.stages.map(stageHtml).join('')}</ol>
		<div class="status ${cur.state}"><span>${esc(c.headline)}</span></div>${bar}${q}${blocked}
		<div class="pr-det">
			<div class="hint">Staff login on the preview: <code>churchweb</code> with the standard staff password. ${me?.user?.role === 'admin' && c.previewUrl ? `<a href="#" data-adm="${c.id}">Show admin login</a>` : ''}</div>${adm}
			${costDetail(c)}
			${c.tidy && c.tidy.state !== 'done' ? `<div class="hint">Hostinger plugins: ${esc(c.tidy.message)}</div>` : ''}${c.notes ? `<div class="hint"><b>Notes:</b> ${esc(c.notes)}</div>` : ''}${docs}
			<div class="hint">${c.exported ? `Export: ${c.exported.pages ?? '?'} pages, ${c.exported.images ?? '?'} images. ` : ''}${c.zipReady ? `<a href="/api/prospects/${c.id}/package">Download the ZIP</a>` : ''}</div>
		</div>`;
}
function row(c) {
	const open = isOpen(c);
	return `<tr class="${c.runState}${open ? ' open' : ''}" data-id="${c.id}">
		<td class="c-name"><b>${esc(c.name)}</b><small>${esc(c.domain)}${c.platform ? ' · ' + esc(c.platform) : ''}</small>${c.contactEmail ? `<small>${esc(c.contactEmail)}</small>` : ''}</td>
		<td><span class="pill">${c.mode === 'full' ? 'FULL SITE' : 'PREVIEW'}</span></td>
		<td class="c-status">${statusCell(c)}</td>
		<td class="c-days">${daysCell(c)}</td>
		<td class="c-cost">${costCell(c)}</td>
		<td class="c-added">${fmtDate(c.createdAt)}<small>${esc(who(c.createdBy))}</small>${c.exported ? `<small>${c.exported.pages ?? '?'} pages</small>` : ''}</td>
		<td class="c-act">${actions(c)}</td>
	</tr>${open ? `<tr class="drow"><td colspan="7">${detail(c)}</td></tr>` : ''}`;
}
function summary(list) {
	const n = (f) => list.filter(f).length;
	const cells = [['Prospects', list.length], ['Building', n((c) => c.runState === 'running')], ['Need you', n(needsYou)], ['Stopped', n((c) => c.runState === 'failed')], ['Ready', n((c) => c.runState === 'done')], ['Deleted within 7 days', n((c) => c.previewUrl && c.daysLeft != null && c.daysLeft <= 7)]];
	if (costs && costs.total > 0) cells.push(['AI cost, last 30 days', usd(costs.last30)], ['Average preview', costs.preview.n ? usd(costs.preview.avg) : '—'], ['Average full site', costs.full.n ? usd(costs.full.avg) : '—']);
	return cells.map(([k, v]) => `<div class="tile${v && (k === 'Need you' || k === 'Stopped' || k.startsWith('Deleted')) ? ' hot' : ''}"><b>${v}</b><span>${k}</span></div>`).join('');
}
function render() {
	if (typing) return;
	const mine = rows.filter((r) => !r.legacy);
	const f = $('fFind')?.value.trim().toLowerCase() || '', shown = f ? mine.filter((c) => `${c.name} ${c.domain} ${c.contactEmail}`.toLowerCase().includes(f)) : mine;
	$('sum').innerHTML = mine.length ? summary(mine) : '';
	$('dash').hidden = !mine.length;
	$('rows').innerHTML = shown.map(row).join('') || `<tr><td colspan="7" class="hint">Nothing matches.</td></tr>`;
	$('empty').hidden = mine.length > 0; if (!mine.length) $('newBox').open = true; else if (!seen) { $('newBox').open = !!new URLSearchParams(location.search).get('url'); } seen = true;
}
async function load() {
	try { rows = await api('/api/prospects'); try { costs = await api('/api/prospects/costs'); } catch { /* the tiles just stay away */ } render(); } catch (e) { $('nErr').textContent = e.message; }
	clearTimeout(timer);
	timer = setTimeout(load, rows.some((r) => ['running', 'needs_input'].includes(r.runState)) ? 4000 : 30000);
}
const act = async (fn) => { try { await fn(); } catch (e) { alert(e.message); } await load(); };

document.addEventListener('focusin', (e) => { if (e.target.matches('[data-answer]')) typing = true; });
document.addEventListener('focusout', (e) => { if (e.target.matches('[data-answer]')) { typing = false; } });
document.addEventListener('input', (e) => { if (e.target.matches('[data-answer]')) answers[e.target.dataset.answer] = e.target.value; });
document.addEventListener('click', async (e) => {
	const t = e.target.closest('[data-more],[data-run],[data-restart],[data-restart2],[data-restartno],[data-ext],[data-lic],[data-login],[data-full],[data-full2],[data-fullno],[data-del],[data-del2],[data-delno],[data-adm],[data-ans],[data-send]'); if (!t) return;
	e.preventDefault();
	const d = t.dataset;
	if (d.more) { openCards.has(d.more) ? openCards.delete(d.more) : openCards.add(d.more); return render(); }
	if (d.run) return act(() => api(`/api/prospects/${d.run}/run`, { method: 'POST', body: '{}' }));
	if (d.lic) return act(async () => { t.disabled = true; const r = await api(`/api/prospects/${d.lic}/license`, { method: 'POST', body: '{}' }); alert(r.state === 'ok' ? 'Oxygen is licensed on this site.' : (r.detail || 'The licence could not be applied.')); });
	if (d.ext) return act(() => api(`/api/prospects/${d.ext}/extend`, { method: 'POST', body: JSON.stringify({ days: 7 }) }));
	if (d.login) {
		const w = window.open('about:blank', '_blank'); // opened first so the browser doesn't block it
		try { const r = await api(`/api/prospects/${d.login}/login`, { method: 'POST', body: '{}' }); if (w) w.location.href = r.url; else location.href = r.url; }
		catch (x) { if (w) w.close(); alert(x.message); }
		return;
	}
	if (d.restart) { confirmRestart = d.restart; return render(); }
	if (d.restartno) { confirmRestart = null; return render(); }
	if (d.restart2) { confirmRestart = null; return act(() => api(`/api/prospects/${d.restart2}/restart`, { method: 'POST', body: '{}' })); }
	if (d.full) { confirmFull = d.full; return render(); }
	if (d.fullno) { confirmFull = null; return render(); }
	if (d.full2) { confirmFull = null; openCards.add(d.full2); return act(() => api(`/api/prospects/${d.full2}/full`, { method: 'POST', body: '{}' })); }
	if (d.del) { confirmDel = d.del; return render(); }
	if (d.delno) { confirmDel = null; return render(); }
	if (d.del2) { confirmDel = null; return act(() => api(`/api/prospects/${d.del2}`, { method: 'DELETE' })); }
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

$('fFind').addEventListener('input', () => render());

/* ---- start */
(async () => {
	me = await fetch('/api/me', { headers: H }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
	const p = new URLSearchParams(location.search);
	if (p.get('url')) { $('nUrl').value = p.get('url'); if (p.get('name')) { $('nName').value = p.get('name'); nameTouched = true; } if (p.get('email')) $('nEmail').value = p.get('email'); $('newBox').open = true; if (!p.get('name')) detect(); else api('/api/prospects/detect?url=' + encodeURIComponent(p.get('url'))).then((d) => { $('nDetect').textContent = d.platform ? `Looks like a ${d.platform} site.` : ''; }).catch(() => {}); }
	load();
})();
