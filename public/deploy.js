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
let CFG = null, cur = null, openKey = null, lastSecret = null;

$('logout').onclick = async () => { await fetch('/logout', { method: 'POST', headers: H }); location.reload(); };

async function loadList() {
	const list = await api('/churches');
	$('empty').hidden = list.length > 0;
	$('tbl').hidden = list.length === 0;
	$('tbl').querySelector('tbody').innerHTML = list.map((c) => `<tr class="click" data-id="${esc(c.id)}"><td><b>${esc(c.name)}</b><div class="hint">${esc(c.id)}.${esc(CFG.previewDomain)}</div></td><td>${esc(c.domain || '—')}</td><td>${PLAN[c.plan]}</td><td><span class="dots">${CFG.stages.map((s) => `<span class="dot ${c.stages[s.key] ? 'on' : (s.onlyPlan && s.onlyPlan !== c.plan ? 'skip' : '')}" title="${esc(s.title)}"></span>`).join('')}</span></td></tr>`).join('');
	for (const tr of document.querySelectorAll('tr.click')) tr.onclick = () => openChurch(tr.dataset.id);
}

async function init() {
	CFG = await api('/config');
	const lbl = { gateway: 'AI Assistant keys (gateway)', cloudflare: 'Cloudflare (domains and DNS)', previewDns: 'Automatic preview addresses', postmark: 'Postmark (sending domains)', smtp: 'Postmark server token (site mail)', ssh: 'Hostinger SSH (site changes)', smartermail: 'SmarterMail automation', hostingerIp: 'Hostinger IP address' };
	$('setup').innerHTML = Object.entries(CFG.configured).map(([k, v]) => `<div class="${v ? 'ok' : 'no'}">${v ? '✔' : '✖'} ${lbl[k] || k}${v ? '' : ' — not set up: those steps show up as hand-done instructions'}</div>`).join('');
	await loadList();
}

$('newForm').onsubmit = async (e) => {
	e.preventDefault(); $('nErr').textContent = '';
	try {
		const c = await api('/churches', { method: 'POST', body: JSON.stringify({ name: $('nName').value, domain: $('nDomain').value, plan: $('nPlan').value }) });
		$('nName').value = ''; $('nDomain').value = '';
		await loadList(); openChurch(c.id);
	} catch (er) { $('nErr').textContent = er.message; }
};

async function openChurch(id) {
	cur = await api('/churches/' + encodeURIComponent(id));
	$('listCard').hidden = true; $('detail').hidden = false; openKey = null; lastSecret = null;
	render();
}

function itemHtml(i) {
	return `<li class="${esc(i.status)}"><span class="ic">${esc(({ pass: 'OK', done: 'Done', fail: 'Problem', error: 'Error', warn: 'Check', manual: 'By hand', info: 'Note', planned: 'Will do' })[i.status] || i.status)}</span><div>${esc(i.label)}${i.detail ? `<pre>${esc(i.detail)}</pre>` : ''}</div></li>`;
}

function render() {
	const c = cur, st = c.stageStates;
	const first = CFG.stages.find((s) => !st[s.key].done && !(s.onlyPlan && s.onlyPlan !== c.plan));
	if (openKey === null && first) openKey = first.key;
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
	</section>
	${CFG.stages.map((s) => stageHtml(s)).join('')}
	<section class="card"><h2>Activity</h2><div class="lg">${(c.log || []).slice().reverse().slice(0, 40).map((l) => `<div>${new Date(l.at).toLocaleString()} — ${esc(l.text)}</div>`).join('') || 'Nothing yet.'}</div>
	<div class="btns"><button class="sm danger" id="gwOff">Switch AI Assistant off</button><button class="sm" id="gwOn">Switch it back on</button></div></section>`;
	$('back').onclick = (e) => { e.preventDefault(); cur = null; $('detail').hidden = true; $('listCard').hidden = false; loadList(); };
	$('saveDet').onclick = async () => {
		try { cur = { ...(await api('/churches/' + c.id, { method: 'PATCH', body: JSON.stringify({ name: $('eName').value, domain: $('eDomain').value, plan: $('ePlan').value, contactEmail: $('eEmail').value, mailboxes: $('eBoxes').value }) })), manualLabels: cur.manualLabels }; cur = await api('/churches/' + c.id); render(); }
		catch (e) { $('dErr').textContent = e.message; }
	};
	$('gwOff').onclick = () => confirm('Switch the AI Assistant off for ' + c.name + '?') && gw(true);
	$('gwOn').onclick = () => gw(false);
	for (const el of document.querySelectorAll('[data-open]')) el.onclick = () => { openKey = openKey === el.dataset.open ? '' : el.dataset.open; render(); };
	for (const el of document.querySelectorAll('[data-act]')) el.onclick = () => act(el.dataset.key, el.dataset.act, el);
	for (const el of document.querySelectorAll('[data-chk]')) el.onchange = async () => { cur = await api('/churches/' + c.id + '/stages/' + el.dataset.key + '/manual', { method: 'PUT', body: JSON.stringify({ id: el.dataset.chk, value: el.checked }) }).then(() => api('/churches/' + c.id)); render(); };
}

async function gw(off) { try { await api('/churches/' + cur.id + '/gateway', { method: 'POST', body: JSON.stringify({ off }) }); alert(off ? 'Switched off.' : 'Switched on.'); cur = await api('/churches/' + cur.id); render(); } catch (e) { alert(e.message); } }

function stageHtml(s) {
	const c = cur, state = c.stageStates[s.key], skip = s.onlyPlan && s.onlyPlan !== c.plan;
	const blocked = state.blockedBy.filter((x) => x !== 'plan');
	const open = openKey === s.key;
	const labels = (c.manualLabels?.[s.key] || []);
	const last = state.last;
	return `<div class="stage ${state.done ? 'done' : blocked.length || skip ? 'blocked' : ''}">
	<div class="hd" data-open="${s.key}"><span class="num">${state.done ? '✓' : s.n}</span><span class="tt">${esc(s.title)}${skip ? ' <span class="hint">(not needed: Website plan)</span>' : ''}</span><span class="hint">${state.done ? 'Done' : blocked.length ? 'Waiting for earlier stage' : ''}</span></div>
	${open ? `<div class="bd"><p class="hint">${esc(s.blurb.replace('{slug}', c.slug))}</p>
	${labels.length ? labels.map((m) => `<label class="chk"><input type="checkbox" data-key="${s.key}" data-chk="${esc(m.id)}"${state.manual[m.id] ? ' checked' : ''}> <span>${esc(m.label)}</span></label>`).join('') : ''}
	${blocked.length ? `<p class="err">Finish first: ${blocked.map((b) => esc(CFG.stages.find((x) => x.key === b).title)).join(', ')}</p>` : ''}
	<div class="btns">
		<button class="primary" data-key="${s.key}" data-act="check">Check</button>
		${s.key === 'approval' || s.key === 'dnscheck' ? '' : `<button class="sm" data-key="${s.key}" data-act="dry">Preview what Run will do</button><button class="primary" data-key="${s.key}" data-act="run"${blocked.length || skip ? ' disabled' : ''}>Run</button><button class="sm" data-key="${s.key}" data-act="test">Test</button>`}
		${s.key === 'mailboxes' ? `<button class="sm" data-key="${s.key}" data-act="run" data-cutover="1"${blocked.length || skip ? ' disabled' : ''}>Switch MX to our server</button>` : ''}
		${s.key === 'sending' ? `<button class="sm" data-key="${s.key}" data-act="run" data-testmail="1"${blocked.length ? ' disabled' : ''}>Run + send a test email</button>` : ''}
	</div>
	<div id="out-${s.key}">${last ? `<div class="hint">Last ${esc(last.action)}: ${new Date(last.at).toLocaleString()} — ${last.ok ? 'no problems' : 'needs attention'}</div><ul class="res">${last.items.map(itemHtml).join('')}</ul>` : ''}${lastSecret && lastSecret.key === s.key ? `<div class="secret">${esc(lastSecret.text)}</div><p class="hint">Copy these now. They are not saved anywhere.</p>` : ''}</div></div>` : ''}
	</div>`;
}

async function act(key, action, btn) {
	const body = {};
	if (action === 'run') {
		if (btn.dataset.cutover) { if (!confirm('Change the MX records so email goes to OUR server? Only do this after the mailboxes exist and old mail is moved.')) return; body.cutoverMx = true; }
		else if (!confirm('Run this stage for ' + cur.name + '? It will make real changes.')) return;
		if (btn.dataset.testmail) { const t = prompt('Send the test email to which address?', cur.contactEmail || ''); if (!t) return; body.testTo = t; }
		if (key === 'handover') { body.email = cur.contactEmail || prompt('Church contact email for the login?') || ''; }
		body.confirm = true;
	}
	const out = $('out-' + key), old = btn.textContent; btn.disabled = true; btn.textContent = 'Working…';
	try {
		const r = await api(`/churches/${cur.id}/stages/${key}/${action}`, { method: 'POST', body: JSON.stringify(body) });
		const keep = cur.manualLabels; cur = { ...r.church, manualLabels: keep };
		lastSecret = r.secret ? { key, text: secretText(r.secret) } : null;
		render();
	} catch (e) { btn.disabled = false; btn.textContent = old; out.insertAdjacentHTML('afterbegin', `<p class="err">${esc(e.message)}</p>`); }
}
function secretText(s) {
	if (s.boxes) return s.boxes.map((b) => `${b.address}    ${b.password}`).join('\n');
	return `Login: ${s.login}\nPassword: ${s.password}\nSend to: ${s.email}`;
}

init().catch((e) => { document.body.insertAdjacentHTML('beforeend', `<p class="err" style="padding:20px">${esc(e.message)}</p>`); });
