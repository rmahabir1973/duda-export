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
const SERVICE = { gateway: 'the AI gateway key', cloudflare: 'Cloudflare', previewDns: 'Cloudflare preview zone + Hostinger IP', postmark: 'Postmark account token', smtp: 'Postmark server token', ssh: 'Hostinger SSH', smartermail: 'SmarterMail', hostingerIp: 'Hostinger IP address' };
const SAT = new Set(['ok', 'info', 'warn']);
let CFG = null, cur = null, openKey = null, secret = null, msgs = {}, working = '', open_how = {};

$('logout').onclick = async () => { await fetch('/logout', { method: 'POST', headers: H }); location.reload(); };

async function loadList() {
	const list = await api('/churches');
	$('empty').hidden = list.length > 0; $('tbl').hidden = list.length === 0;
	$('tbl').querySelector('tbody').innerHTML = list.map((c) => `<tr class="click" data-id="${esc(c.id)}"><td><b>${esc(c.name)}</b><div class="hint">${esc(c.id)}.${esc(CFG.previewDomain)}</div></td><td>${esc(c.domain || '—')}</td><td>${PLAN[c.plan]}</td><td><span class="dots">${CFG.stages.map((s) => `<span class="dot ${c.stages[s.key] ? 'on' : (s.onlyPlan && s.onlyPlan !== c.plan ? 'skip' : '')}" title="${esc(s.title)}"></span>`).join('')}</span></td></tr>`).join('');
	for (const tr of document.querySelectorAll('tr.click')) tr.onclick = () => openChurch(tr.dataset.id);
}
async function init() {
	CFG = await api('/config');
	$('setup').innerHTML = Object.entries(CFG.configured).map(([k, v]) => `<div class="${v ? 'ok' : 'no'}">${v ? '✔' : '✖'} ${esc(SERVICE[k] || k)}${v ? '' : ' — not set up'}</div>`).join('');
	await loadList();
}
$('newForm').onsubmit = async (e) => {
	e.preventDefault(); $('nErr').textContent = '';
	try { const c = await api('/churches', { method: 'POST', body: JSON.stringify({ name: $('nName').value, domain: $('nDomain').value, plan: $('nPlan').value }) }); $('nName').value = ''; $('nDomain').value = ''; await loadList(); openChurch(c.id); }
	catch (er) { $('nErr').textContent = er.message; }
};

const skipped = (s) => s.onlyPlan && s.onlyPlan !== cur.plan;
const resultsOf = (s) => cur.stageStates[s.key].results || {};
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
	$('listCard').hidden = true; $('detail').hidden = false; secret = null; msgs = {}; open_how = {};
	const t = firstTodo(); openKey = t ? t.s.key : CFG.stages[0].key;
	render();
	checkStage(openKey);
}

function progress(s) {
	const res = resultsOf(s), n = s.reqs.length, d = s.reqs.filter((q) => SAT.has(res[q.id]?.state)).length;
	return { n, d, checked: !!cur.stageStates[s.key].at };
}

function render() {
	const c = cur, t = firstTodo();
	const missing = Object.entries(CFG.configured).filter(([, v]) => !v).map(([k]) => SERVICE[k] || k);
	$('detail').innerHTML = `
	<p><a href="#" id="back">← All churches</a></p>
	<section class="card">
		<h2>${esc(c.name)}</h2>
		<div class="row3" style="grid-template-columns:2fr 2fr 1fr">
			<div><label>Church name</label><input id="eName" type="text" value="${esc(c.name)}"></div>
			<div><label>Their current website</label><input id="eDomain" type="text" value="${esc(c.domain)}" placeholder="britanniaunited.ca"></div>
			<div><label>Plan</label><select id="ePlan"><option value="website"${c.plan === 'website' ? ' selected' : ''}>Website</option><option value="email"${c.plan === 'email' ? ' selected' : ''}>Website + Email</option></select></div>
		</div>
		<div class="row3" style="grid-template-columns:2fr 2fr auto">
			<div><label>Contact email</label><input id="eEmail" type="text" value="${esc(c.contactEmail)}"></div>
			<div><label>Mailbox names (Email plan, max 10)</label><input id="eBoxes" type="text" value="${esc((c.mailboxes || []).join(', '))}" placeholder="office, pastor, treasurer"></div>
			<div><button class="primary" id="saveDet">Save</button></div>
		</div>
		<p class="err" id="dErr"></p>
		<p class="hint">Preview address: <b>${esc(c.slug)}.${esc(CFG.previewDomain)}</b></p>
		${missing.length ? `<p class="need">Not set up on this server yet: ${missing.map(esc).join(', ')}. Items that need these show how to do them by hand.</p>` : ''}
	</section>
	<section class="card next">
		${t ? (t.unchecked ? `<b>Press "Check everything" to see where this church stands.</b>` : `<b>Next:</b> ${esc(t.s.n + '. ' + t.s.title)} — ${esc(t.q.label)}`) : '<b>✔ Everything is done for this church.</b>'}
		<div class="btns"><button class="primary" id="checkAll"${working ? ' disabled' : ''}>${working === 'all' ? 'Checking…' : 'Check everything'}</button></div>
	</section>
	${CFG.stages.map(stageHtml).join('')}
	<section class="card"><h2>Activity</h2><div class="lg">${(c.log || []).slice().reverse().slice(0, 40).map((l) => `<div>${new Date(l.at).toLocaleString()} — ${esc(l.text)}</div>`).join('') || 'Nothing yet.'}</div>
	<div class="btns"><button class="sm danger" id="gwOff">Switch AI Assistant off</button><button class="sm" id="gwOn">Switch it back on</button></div></section>`;
	wire();
}

function rowHtml(s, q, blockedStage) {
	const res = resultsOf(s)[q.id], st = res?.state || 'unchecked', detail = res?.detail || '';
	const how = cur.guide?.[s.key]?.[q.id] || '';
	const m = msgs[s.key + '.' + q.id];
	const busy = working === s.key + '.' + q.id;
	let action = '';
	if (q.manual) action = `<label class="tick"><input type="checkbox" data-key="${s.key}" data-chk="${esc(q.id)}"${st === 'ok' ? ' checked' : ''}> Done</label>`;
	if (q.canFix && st !== 'ok' && st !== 'info' && st !== 'warn' && st !== 'blocked' && st !== 'unchecked') action += `<button class="primary sm2" data-key="${s.key}" data-fix="${esc(q.id)}"${blockedStage || busy || working ? ' disabled' : ''}>${busy ? 'Working…' : esc(q.fixLabel || 'Fix it')}</button>`;
	if (q.canFix && q.manual) action = action.replace('sm2', 'sm2') ;
	const showHow = how && (st === 'no' || st === 'unknown' || st === 'error') && !(q.canFix && !m?.howTo);
	return `<li class="req ${st}">
		<span class="ri ${st}">${ICON[st] || ''}</span>
		<div class="rb"><div class="rl">${esc(q.label)}</div>
			${detail ? `<div class="rd">${esc(detail)}</div>` : ''}
			${m ? `<div class="rm ${m.ok ? 'good' : 'bad'}">${esc(m.detail || (m.ok ? 'Done.' : ''))}${m.unavailable ? `<div class="hint">Not set up on this server: ${m.unavailable.map((x) => esc(SERVICE[x] || x)).join(', ')}.</div>` : ''}${m.howTo ? `<pre>${esc(m.howTo)}</pre>` : ''}</div>` : ''}
			${showHow ? `<div class="hint"><a href="#" data-how="${s.key}.${q.id}">How to do this by hand</a></div>${open_how[s.key + '.' + q.id] ? `<pre class="how">${esc(how)}</pre>` : ''}` : ''}
		</div>
		<div class="ra">${action}</div></li>`;
}

function stageHtml(s) {
	const c = cur, state = c.stageStates[s.key], skip = skipped(s);
	const blockedStage = state.blockedBy.filter((x) => x !== 'plan');
	const open = openKey === s.key, p = progress(s);
	const fixable = s.reqs.filter((q) => q.canFix && !q.confirm && ['no', 'error'].includes(resultsOf(s)[q.id]?.state)).length;
	const isBusy = working === 'all' || working === s.key;
	return `<div class="stage ${state.done ? 'done' : skip || blockedStage.length ? 'blocked' : ''}">
	<div class="hd" data-open="${s.key}"><span class="num">${state.done ? '✓' : s.n}</span><span class="tt">${esc(s.title)}${skip ? ' <span class="hint">(not needed on the Website plan)</span>' : ''}</span>
		<span class="hint">${skip ? '' : p.checked ? (state.done ? 'All done' : `${p.d} of ${p.n} ready`) : 'Not checked yet'}</span></div>
	${open && !skip ? `<div class="bd"><p class="hint">${esc(s.blurb)}</p>
		${blockedStage.length ? `<p class="need">Finish first: ${blockedStage.map((b) => esc(CFG.stages.find((x) => x.key === b).title)).join(', ')}. You can still look, but the fix buttons wait.</p>` : ''}
		<div class="btns"><button class="sm" data-check="${s.key}"${isBusy ? ' disabled' : ''}>${working === s.key ? 'Checking…' : 'Re-check'}</button>
		${fixable ? `<button class="primary" data-fixall="${s.key}"${blockedStage.length || working ? ' disabled' : ''}>Fix everything that can be fixed (${fixable})</button>` : ''}</div>
		${secret && secret.key === s.key ? `<div class="secret">${esc(secret.text)}</div><p class="hint">Copy this now. It isn't saved anywhere.</p>` : ''}
		<ul class="reqs">${s.reqs.map((q) => rowHtml(s, q, blockedStage.length)).join('')}</ul></div>` : ''}
	</div>`;
}

function wire() {
	$('back').onclick = (e) => { e.preventDefault(); cur = null; $('detail').hidden = true; $('listCard').hidden = false; loadList(); };
	$('saveDet').onclick = async () => {
		try { await api('/churches/' + cur.id, { method: 'PATCH', body: JSON.stringify({ name: $('eName').value, domain: $('eDomain').value, plan: $('ePlan').value, contactEmail: $('eEmail').value, mailboxes: $('eBoxes').value }) }); cur = await api('/churches/' + cur.id); render(); }
		catch (e) { $('dErr').textContent = e.message; }
	};
	$('gwOff').onclick = () => confirm('Switch the AI Assistant off for ' + cur.name + '?') && gw(true);
	$('gwOn').onclick = () => gw(false);
	$('checkAll').onclick = checkAll;
	for (const el of document.querySelectorAll('[data-open]')) el.onclick = () => { const k = el.dataset.open; openKey = openKey === k ? '' : k; render(); if (openKey === k && !cur.stageStates[k].at) checkStage(k); };
	for (const el of document.querySelectorAll('[data-check]')) el.onclick = () => checkStage(el.dataset.check);
	for (const el of document.querySelectorAll('[data-fix]')) el.onclick = () => fix(el.dataset.key, el.dataset.fix);
	for (const el of document.querySelectorAll('[data-fixall]')) el.onclick = () => fix(el.dataset.fixall, 'all');
	for (const el of document.querySelectorAll('[data-how]')) el.onclick = (e) => { e.preventDefault(); open_how[el.dataset.how] = !open_how[el.dataset.how]; render(); };
	for (const el of document.querySelectorAll('[data-chk]')) el.onchange = async () => { try { cur = await api(`/churches/${cur.id}/stages/${el.dataset.key}/manual`, { method: 'PUT', body: JSON.stringify({ id: el.dataset.chk, value: el.checked }) }); } catch (e) { alert(e.message); } render(); recheckAfterTick(el.dataset.key); };
}
// Ticking a box can unlock the items that were waiting on it.
async function recheckAfterTick(key) { await checkStage(key); }

async function checkStage(key) {
	if (!cur) return;
	working = key; render();
	try { const r = await api(`/churches/${cur.id}/stages/${key}/check`, { method: 'POST', body: '{}' }); cur = r.church; }
	catch (e) { alert(e.message); }
	working = ''; render();
}
async function checkAll() {
	working = 'all'; render();
	try { for (const s of CFG.stages) { if (skipped(s)) continue; const r = await api(`/churches/${cur.id}/stages/${s.key}/check`, { method: 'POST', body: '{}' }); cur = r.church; render(); } }
	catch (e) { alert(e.message); }
	working = ''; const t = firstTodo(); if (t) openKey = t.s.key; render();
}
async function fix(key, req) {
	const s = CFG.stages.find((x) => x.key === key), q = req === 'all' ? null : s.reqs.find((x) => x.id === req);
	const text = q?.confirm || (req === 'all' ? `Fix everything that can be fixed in "${s.title}" for ${cur.name}? This makes real changes.` : `${q.fixLabel || 'Fix it'}: ${q.label} This makes a real change for ${cur.name}.`);
	if (!confirm(text)) return;
	working = req === 'all' ? key : key + '.' + req; render();
	try {
		const r = await api(`/churches/${cur.id}/stages/${key}/fix`, { method: 'POST', body: JSON.stringify({ req, confirm: true }) });
		cur = r.church;
		for (const f of r.fixed) msgs[key + '.' + f.id] = f;
		if (r.secret) secret = { key, text: r.secret.boxes ? r.secret.boxes.map((b) => `${b.address}    ${b.password}`).join('\n') : `Login: ${r.secret.login}\nPassword: ${r.secret.password}\nSend to: ${r.secret.email}` };
	} catch (e) { msgs[key + '.' + (req === 'all' ? s.reqs[0].id : req)] = { ok: false, detail: e.message }; }
	working = ''; render();
}
async function gw(off) { try { await api('/churches/' + cur.id + '/gateway', { method: 'POST', body: JSON.stringify({ off }) }); alert(off ? 'Switched off.' : 'Switched on.'); cur = await api('/churches/' + cur.id); render(); } catch (e) { alert(e.message); } }

init().catch((e) => { document.body.insertAdjacentHTML('beforeend', `<p class="err" style="padding:20px">${esc(e.message)}</p>`); });
