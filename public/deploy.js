const $ = (id) => document.getElementById(id);
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
const api = async (path, opts = {}) => {
	const r = await fetch('/api/deploy' + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
	if (r.status === 401) return location.reload();
	const j = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(j.error || 'Request failed');
	return j;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PLAN = { website: 'Website', email: 'Website + Email' };
const ICON = { ok: '✔', no: '✖', warn: '!', info: 'i', unknown: '?', blocked: '…', error: '!' };
const SERVICE = { gateway: 'the AI gateway key', cloudflare: 'Cloudflare', previewDns: 'Cloudflare preview zone + Hostinger IP', postmark: 'Postmark account token', smtp: 'Postmark server token', ssh: 'Hostinger SSH', smartermail: 'SmarterMail', hostingerIp: 'Hostinger IP address', hostingerApi: 'Hostinger API key' };
const SAT = new Set(['ok', 'info', 'warn']);
// The board and the project tabs group the stages into phases a person thinks in.
const PHASES = [
	{ id: 'domain', title: 'Domain setup', stages: ['dnscheck', 'cloudflare'] },
	{ id: 'preview', title: 'Preview site', stages: ['preview'] },
	{ id: 'approval', title: 'Review & approval', stages: ['approval'] },
	{ id: 'switch', title: 'Switch domain', stages: ['dns'] },
	{ id: 'live', title: 'Go live', stages: ['golive'] },
	{ id: 'email', title: 'Email', stages: ['mailboxes', 'sending'] },
	{ id: 'handover', title: 'Handover', stages: ['handover'] },
];
const phaseOf = (stageKey) => PHASES.find((p) => p.stages.includes(stageKey));
let CFG = null, cur = null, openPhase = 'domain', secret = null, msgs = {}, working = '', openHow = {};


/* ------------------------------------------------------------------ the board */
async function loadBoard() {
	const list = await api('/churches');
	$('empty').hidden = list.length > 0;
	const cols = [...PHASES.map((p) => ({ id: p.id, title: p.title, cards: [] })), { id: 'done', title: 'Done', cards: [] }];
	for (const c of list) (cols.find((x) => x.id === (c.stage ? phaseOf(c.stage).id : 'done')) || cols[0]).cards.push(c);
	$('board').innerHTML = cols.map((col) => `<div class="col"><div class="colh">${esc(col.title)} <span class="cnt">${col.cards.length}</span></div>
		${col.cards.map((c) => { const t = Object.values(c.counts).reduce((a, x) => a + x.total, 0), d = Object.values(c.counts).reduce((a, x) => a + x.done, 0); return `<div class="pcard" data-id="${esc(c.id)}"><b>${esc(c.name)}</b><div class="hint">${esc(c.domain || 'no domain yet')} · ${PLAN[c.plan]}</div><div class="bar"><i style="width:${t ? Math.round((d / t) * 100) : 0}%"></i></div><div class="hint">${d} of ${t} tasks${c.next ? ' · Next: ' + esc(c.next) : ''}</div></div>`; }).join('') || '<div class="hint empty">—</div>'}</div>`).join('');
	for (const el of document.querySelectorAll('.pcard')) el.onclick = () => openChurch(el.dataset.id);
}
async function init() {
	CFG = await api('/config');
	$('setup').innerHTML = Object.entries(CFG.configured).map(([k, v]) => `<div class="${v ? 'ok' : 'no'}">${v ? '✔' : '✖'} ${esc(SERVICE[k] || k)}${v ? '' : ' — not set up'}</div>`).join('');
	await loadBoard();
}
$('newForm').onsubmit = async (e) => {
	e.preventDefault(); $('nErr').textContent = '';
	try { const c = await api('/churches', { method: 'POST', body: JSON.stringify({ name: $('nName').value, domain: $('nDomain').value, plan: $('nPlan').value }) }); $('nName').value = ''; $('nDomain').value = ''; await loadBoard(); openChurch(c.id); }
	catch (er) { $('nErr').textContent = er.message; }
};
$('hostProbe').onclick = async (e) => {
	const b = e.target; b.disabled = true; b.textContent = 'Testing…'; $('hostOut').innerHTML = '';
	try { const r = await api('/hostinger-probe', { method: 'POST', body: '{}' }); $('hostOut').innerHTML = r.items.map((i) => `<li class="${esc(i.state)}"><span class="ic">${esc(({ ok: 'OK', no: 'Problem', error: 'Error', warn: 'Check', info: 'Note' })[i.state] || i.state)}</span><div>${esc(i.label)}${i.detail ? `<pre>${esc(i.detail)}</pre>` : ''}</div></li>`).join(''); }
	catch (er) { $('hostOut').innerHTML = `<li class="error"><div>${esc(er.message)}</div></li>`; }
	b.disabled = false; b.textContent = 'Test Hostinger access (read-only)';
};

/* ------------------------------------------------------------------ one customer = one project */
const skipped = (s) => s.onlyPlan && s.onlyPlan !== cur.plan;
const resultsOf = (s) => cur.stageStates[s.key].results || {};
const stageOf = (k) => CFG.stages.find((s) => s.key === k);
const phaseStats = (ph) => {
	let total = 0, done = 0, any = false, checked = false;
	for (const k of ph.stages) { const s = stageOf(k); if (skipped(s)) continue; any = true; total += s.reqs.length; done += s.reqs.filter((q) => SAT.has(resultsOf(s)[q.id]?.state)).length; if (cur.stageStates[k].at) checked = true; }
	return { total, done, any, checked };
};
const firstTodo = () => {
	for (const s of CFG.stages) {
		if (skipped(s)) continue;
		const res = resultsOf(s);
		for (const q of s.reqs) { const st = res[q.id]?.state; if (!st) return { s, q, unchecked: true }; if (!SAT.has(st) && st !== 'blocked') return { s, q, st }; }
	}
	return null;
};

async function openChurch(id) {
	cur = await api('/churches/' + encodeURIComponent(id));
	$('listCard').hidden = true; $('detail').hidden = false; secret = null; msgs = {}; openHow = {};
	const t = firstTodo(); openPhase = t ? phaseOf(t.s.key).id : 'handover';
	render();
	const ph = PHASES.find((p) => p.id === openPhase);
	for (const k of ph.stages) if (!skipped(stageOf(k)) && !cur.stageStates[k].at) await checkStage(k, true);
}

function render() {
	const c = cur, t = firstTodo();
	const missing = Object.entries(CFG.configured).filter(([, v]) => !v).map(([k]) => SERVICE[k] || k);
	const allT = CFG.stages.reduce((a, s) => a + (skipped(s) ? 0 : s.reqs.length), 0), allD = CFG.stages.reduce((a, s) => a + (skipped(s) ? 0 : s.reqs.filter((q) => SAT.has(resultsOf(s)[q.id]?.state)).length), 0);
	const ph = PHASES.find((p) => p.id === openPhase);
	$('detail').innerHTML = `
	<p><a href="#" id="back">← All customers</a></p>
	<section class="card proj">
		<div class="projh"><div><h2 style="margin:0">${esc(c.name)}</h2><div class="hint">${esc(c.domain || 'no domain yet')} · ${PLAN[c.plan]} · preview: ${esc(c.slug)}.${esc(CFG.previewDomain)}</div></div>
		<div class="projp"><div class="bar"><i style="width:${allT ? Math.round((allD / allT) * 100) : 0}%"></i></div><div class="hint">${allD} of ${allT} tasks done</div></div></div>
		<div class="nextbox">${t ? (t.unchecked ? '<b>Press "Check everything" to see where this customer stands.</b>' : `<b>Next:</b> ${esc(t.q.label)}`) : '<b>✔ Everything is done for this customer.</b>'}
		<button class="primary" id="checkAll"${working ? ' disabled' : ''}>${working === 'all' ? 'Checking…' : 'Check everything'}</button></div>
		<details class="setup"><summary>Customer details</summary>
		<div class="row3" style="grid-template-columns:2fr 2fr 1fr"><div><label>Church name</label><input id="eName" type="text" value="${esc(c.name)}"></div><div><label>Their current website</label><input id="eDomain" type="text" value="${esc(c.domain)}" placeholder="britanniaunited.ca"></div>
		<div><label>Plan</label><select id="ePlan"><option value="website"${c.plan === 'website' ? ' selected' : ''}>Website</option><option value="email"${c.plan === 'email' ? ' selected' : ''}>Website + Email</option></select></div></div>
		<div class="row3" style="grid-template-columns:2fr 2fr auto"><div><label>Contact email</label><input id="eEmail" type="text" value="${esc(c.contactEmail)}"></div><div><label>Mailbox names (Email plan, max 10)</label><input id="eBoxes" type="text" value="${esc((c.mailboxes || []).join(', '))}" placeholder="office, pastor, treasurer"></div><div><button class="primary" id="saveDet">Save</button></div></div>
		<p class="err" id="dErr"></p></details>
		${missing.length ? `<p class="need">Not set up on this server yet: ${missing.map(esc).join(', ')}. Tasks that need these show how to do them by hand.</p>` : ''}
	</section>
	<div class="tabs">${PHASES.map((p) => { const st = phaseStats(p); return `<button class="tab ${p.id === openPhase ? 'on' : ''} ${!st.any ? 'na' : st.checked && st.done === st.total ? 'full' : ''}" data-phase="${p.id}"${!st.any ? ' disabled' : ''}>${esc(p.title)}<span class="tc">${st.any ? (st.checked ? `${st.done}/${st.total}` : '·') : 'n/a'}</span></button>`; }).join('')}</div>
	${ph.stages.map((k) => stageHtml(stageOf(k))).join('')}
	<section class="card"><h2>Activity</h2><div class="lg">${(c.log || []).slice().reverse().slice(0, 40).map((l) => `<div>${new Date(l.at).toLocaleString()} — ${esc(l.text)}</div>`).join('') || 'Nothing yet.'}</div>
	<div class="btns"><button class="sm danger" id="gwOff">Switch AI Assistant off</button><button class="sm" id="gwOn">Switch it back on</button><button class="sm danger" id="delProj" style="margin-left:auto">Delete this customer…</button></div></section>`;
	wire();
}

function rowHtml(s, q, blockedStage) {
	const res = resultsOf(s)[q.id], st = res?.state || 'unchecked', detail = res?.detail || '';
	const how = cur.guide?.[s.key]?.[q.id] || '', m = msgs[s.key + '.' + q.id], busy = working === s.key + '.' + q.id;
	let action = '';
	if (q.manual) action = `<label class="tick"><input type="checkbox" data-key="${s.key}" data-chk="${esc(q.id)}"${st === 'ok' ? ' checked' : ''}> Done</label>`;
	if (q.canFix && !['ok', 'info', 'warn', 'blocked', 'unchecked'].includes(st)) action += `<button class="primary sm2" data-key="${s.key}" data-fix="${esc(q.id)}"${blockedStage || busy || working ? ' disabled' : ''}>${busy ? 'Working…' : esc(q.fixLabel || 'Fix it')}</button>`;
	const showHow = how && ['no', 'unknown', 'error'].includes(st) && !(q.canFix && !m?.howTo);
	return `<li class="req ${st}"><span class="ri ${st}">${ICON[st] || ''}</span>
		<div class="rb"><div class="rl">${esc(q.label)}</div>${detail ? `<div class="rd">${esc(detail)}</div>` : ''}
		${m && !(m.detail && m.detail === detail) ? `<div class="rm ${m.ok ? 'good' : 'bad'}">${esc(m.detail || (m.ok ? 'Done.' : ''))}${m.unavailable ? `<div class="hint">Not set up on this server: ${m.unavailable.map((x) => esc(SERVICE[x] || x)).join(', ')}.</div>` : ''}${m.howTo ? `<pre>${esc(m.howTo)}</pre>` : ''}</div>` : ''}
		${showHow ? `<div class="hint"><a href="#" data-how="${s.key}.${q.id}">How to do this by hand</a></div>${openHow[s.key + '.' + q.id] ? `<pre class="how">${esc(how)}</pre>` : ''}` : ''}</div>
		<div class="ra">${action}</div></li>`;
}

function stageHtml(s) {
	const state = cur.stageStates[s.key];
	if (skipped(s)) return `<section class="card"><h2>${esc(s.title)}</h2><p class="hint">Not needed on the Website plan.</p></section>`;
	const blocked = state.blockedBy.filter((x) => x !== 'plan'), res = resultsOf(s);
	const fixable = s.reqs.filter((q) => q.canFix && !q.confirm && ['no', 'error'].includes(res[q.id]?.state)).length;
	const done = s.reqs.filter((q) => SAT.has(res[q.id]?.state)).length, isBusy = working === 'all' || working === s.key;
	return `<section class="card stagecard"><div class="stagehd"><h2>${esc(s.title)}</h2><span class="hint">${state.at ? `${done} of ${s.reqs.length} ready` : 'Not checked yet'}</span></div>
		<p class="hint">${esc(s.blurb)}</p>
		${blocked.length ? `<p class="need">Finish first: ${blocked.map((b) => esc(stageOf(b).title)).join(', ')}. You can still look, but the fix buttons wait.</p>` : ''}
		<div class="btns"><button class="sm" data-check="${s.key}"${isBusy ? ' disabled' : ''}>${working === s.key ? 'Checking…' : 'Re-check'}</button>
		${fixable ? `<button class="primary" data-fixall="${s.key}"${blocked.length || working ? ' disabled' : ''}>Fix everything that can be fixed (${fixable})</button>` : ''}</div>
		${secret && secret.key === s.key ? `<div class="secret">${esc(secret.text)}</div><p class="hint">Copy this now. It isn't saved anywhere.</p>` : ''}
		<ul class="reqs">${s.reqs.map((q) => rowHtml(s, q, blocked.length)).join('')}</ul></section>`;
}

function wire() {
	$('back').onclick = (e) => { e.preventDefault(); cur = null; $('detail').hidden = true; $('listCard').hidden = false; loadBoard(); };
	$('saveDet').onclick = async () => {
		try { await api('/churches/' + cur.id, { method: 'PATCH', body: JSON.stringify({ name: $('eName').value, domain: $('eDomain').value, plan: $('ePlan').value, contactEmail: $('eEmail').value, mailboxes: $('eBoxes').value }) }); cur = await api('/churches/' + cur.id); render(); }
		catch (e) { $('dErr').textContent = e.message; }
	};
	$('gwOff').onclick = () => confirm('Switch the AI Assistant off for ' + cur.name + '?') && gw(true);
	$('gwOn').onclick = () => gw(false);
	$('delProj').onclick = deleteCustomer;
	$('checkAll').onclick = checkAll;
	for (const el of document.querySelectorAll('[data-phase]')) el.onclick = async () => { openPhase = el.dataset.phase; render(); for (const k of PHASES.find((p) => p.id === openPhase).stages) if (!skipped(stageOf(k)) && !cur.stageStates[k].at) await checkStage(k, true); };
	for (const el of document.querySelectorAll('[data-check]')) el.onclick = () => checkStage(el.dataset.check);
	for (const el of document.querySelectorAll('[data-fix]')) el.onclick = () => fix(el.dataset.key, el.dataset.fix);
	for (const el of document.querySelectorAll('[data-fixall]')) el.onclick = () => fix(el.dataset.fixall, 'all');
	for (const el of document.querySelectorAll('[data-how]')) el.onclick = (e) => { e.preventDefault(); openHow[el.dataset.how] = !openHow[el.dataset.how]; render(); };
	for (const el of document.querySelectorAll('[data-chk]')) el.onchange = async () => { try { cur = await api(`/churches/${cur.id}/stages/${el.dataset.key}/manual`, { method: 'PUT', body: JSON.stringify({ id: el.dataset.chk, value: el.checked }) }); } catch (e) { alert(e.message); } render(); await checkStage(el.dataset.key); };
}

async function checkStage(key, quiet) {
	if (!cur) return;
	working = key; render();
	try { const r = await api(`/churches/${cur.id}/stages/${key}/check`, { method: 'POST', body: '{}' }); cur = r.church; }
	catch (e) { if (!quiet) alert(e.message); }
	working = ''; render();
}
async function checkAll() {
	working = 'all'; render();
	try { for (const s of CFG.stages) { if (skipped(s)) continue; const r = await api(`/churches/${cur.id}/stages/${s.key}/check`, { method: 'POST', body: '{}' }); cur = r.church; render(); } }
	catch (e) { alert(e.message); }
	working = ''; const t = firstTodo(); if (t) openPhase = phaseOf(t.s.key).id; render();
}
async function fix(key, req) {
	const s = stageOf(key), q = req === 'all' ? null : s.reqs.find((x) => x.id === req);
	const text = q?.confirm || (req === 'all' ? `Fix everything that can be fixed in "${s.title}" for ${cur.name}? This makes real changes.` : `${q.fixLabel || 'Fix it'}: ${q.label} This makes a real change for ${cur.name}.`);
	if (!confirm(text)) return;
	working = req === 'all' ? key : key + '.' + req; render();
	try {
		const r = await api(`/churches/${cur.id}/stages/${key}/fix`, { method: 'POST', body: JSON.stringify({ req, confirm: true }) });
		cur = r.church;
		for (const f of r.fixed) msgs[key + '.' + f.id] = f;
		if (r.secret) secret = { key, text: r.secret.boxes ? r.secret.boxes.map((b) => `${b.address}    ${b.password}`).join('\n') : `${r.secret.url ? 'Site: ' + r.secret.url + '\n' : ''}Login: ${r.secret.login}\nPassword: ${r.secret.password}${r.secret.email ? '\nEmail: ' + r.secret.email : ''}` };
	} catch (e) { msgs[key + '.' + (req === 'all' ? s.reqs[0].id : req)] = { ok: false, detail: e.message }; }
	working = ''; render();
}
async function deleteCustomer() {
	const c = cur, host = `${c.slug}.${CFG.previewDomain}`, hasSite = c.stageStates.preview.results?.site?.state === 'ok';
	if (!confirm(`Delete the customer "${c.name}"?\n\nThis removes the project from this board. It does not touch their current website or domain.`)) return;
	let deleteSite = false;
	if (hasSite) deleteSite = confirm(`Also delete the preview site ${host} on Hostinger?\n\nOK = delete the site too (use this for a mistake or a test).\nCancel = keep the site on Hostinger.`);
	const typed = prompt(`To confirm, type the short name:\n${c.slug}`);
	if (typed === null) return;
	try {
		const r = await api('/churches/' + encodeURIComponent(c.id), { method: 'DELETE', body: JSON.stringify({ confirm: typed.trim(), deleteSite }) });
		cur = null; $('detail').hidden = true; $('listCard').hidden = false; await loadBoard();
		if (r.out?.length) alert(r.out.join('\n'));
	} catch (e) { alert(e.message); }
}
async function gw(off) { try { await api('/churches/' + cur.id + '/gateway', { method: 'POST', body: JSON.stringify({ off }) }); alert(off ? 'Switched off.' : 'Switched on.'); cur = await api('/churches/' + cur.id); render(); } catch (e) { alert(e.message); } }

init().catch((e) => { document.body.insertAdjacentHTML('beforeend', `<p class="err" style="padding:20px">${esc(e.message)}</p>`); });
