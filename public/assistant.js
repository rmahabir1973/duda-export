// The portal assistant: a chat panel on every page. Changes it proposes appear as cards and only happen when you press Approve.
(() => {
	const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'duda-export' };
	const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	const fmt = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
	let messages = []; try { messages = JSON.parse(sessionStorage.getItem('cw_ai') || '[]'); } catch { messages = []; }
	let pending = null, busy = false, notes = [];
	const save = () => { try { sessionStorage.setItem('cw_ai', JSON.stringify(messages.slice(-40))); } catch { /* full */ } };

	const root = document.createElement('div'); root.id = 'aiRoot';
	root.innerHTML = `<button id="aiBtn" type="button" aria-label="Open the assistant">✦ Assistant</button>
	<div id="aiPanel" hidden><div class="aih"><b>ChurchWeb Assistant</b><span><button id="aiNew" type="button" title="Start a new chat">New chat</button><button id="aiX" type="button" aria-label="Close">×</button></span></div>
	<div id="aiLog"></div><form id="aiForm"><textarea id="aiIn" rows="2" placeholder="Ask about a customer, a task, a domain, or tell me what to do…" maxlength="2000"></textarea><button type="submit" id="aiSend">Send</button></form>
	<div class="aif">It can look things up and propose changes. Nothing changes until you press Approve. Don't type passwords here.</div></div>`;
	document.body.appendChild(root);
	const $ = (id) => root.querySelector('#' + id);

	const shown = () => messages.filter((m) => typeof m.content === 'string' || m.content.some((b) => b.type === 'text')).map((m) => ({ role: m.role, text: typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') })).filter((m) => m.text.trim());
	function render() {
		const log = $('aiLog');
		const items = shown().map((m) => `<div class="aim ${m.role}">${fmt(m.text)}</div>`);
		if (!items.length) items.push('<div class="aim assistant">Hi! I can check where a customer is stuck, look at email and DNS, find churches in the directory, answer questions about billing, traffic and portal activity, sort and filter any list for you, and propose fixes. What do you need?</div>');
		for (const n of notes) items.push(`<div class="aim note"><b>${esc(n.title)}</b><pre>${esc(n.lines.join('\n'))}</pre><button type="button" class="aicopy" data-copy="${esc(n.lines.join('\n'))}">Copy</button><div class="hint">Not saved anywhere.</div></div>`);
		if (pending) items.push(`<div class="aim card"><b>Waiting for your approval</b>${pending.actions.map((a) => `<label class="aiact"><input type="checkbox" data-id="${esc(a.id)}" checked> ${esc(a.summary)}</label>`).join('')}<div class="aibtns"><button type="button" id="aiApply" class="aiok">Apply the ticked changes</button><button type="button" id="aiDecline">Decline all</button></div></div>`);
		if (busy) items.push('<div class="aim assistant aithink">Working…</div>');
		log.innerHTML = items.join(''); log.scrollTop = log.scrollHeight;
		$('aiSend').disabled = busy || !!pending; $('aiIn').disabled = busy || !!pending;
		const ap = $('aiApply'); if (ap) ap.onclick = () => resolve(false); const dc = $('aiDecline'); if (dc) dc.onclick = () => resolve(true);
		for (const b of log.querySelectorAll('.aicopy')) b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.textContent = 'Copied'; });
	}
	async function call(path, body) {
		const r = await fetch('/api/assistant/' + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
		if (r.status === 401) { location.reload(); return null; }
		const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Something went wrong.'); return j;
	}
	const take = (j) => { messages = j.messages; pending = j.pending || null; if (j.display?.length) notes.push(...j.display); save(); };
	const fail = (e) => { messages.push({ role: 'assistant', content: [{ type: 'text', text: '⚠ ' + e.message }] }); };
	async function send(text) {
		messages.push({ role: 'user', content: text }); busy = true; render();
		try { const j = await call('chat', { messages, page: location.pathname }); if (j) take(j); } catch (e) { fail(e); }
		busy = false; save(); render();
	}
	async function resolve(declineAll) {
		const decisions = {}; for (const c of root.querySelectorAll('#aiLog input[data-id]')) decisions[c.dataset.id] = declineAll ? false : c.checked;
		const g = pending.groupId; pending = null; busy = true; render();
		try { const j = await call('resolve', { groupId: g, decisions, messages, page: location.pathname }); if (j) take(j); } catch (e) { fail(e); }
		busy = false; save(); render();
	}
	$('aiBtn').onclick = () => { $('aiPanel').hidden = false; $('aiBtn').hidden = true; render(); $('aiIn').focus(); };
	$('aiX').onclick = () => { $('aiPanel').hidden = true; $('aiBtn').hidden = false; };
	$('aiNew').onclick = () => { messages = []; pending = null; notes = []; save(); render(); };
	$('aiForm').onsubmit = (e) => { e.preventDefault(); const t = $('aiIn').value.trim(); if (!t || busy || pending) return; $('aiIn').value = ''; send(t); };
	$('aiIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('aiForm').requestSubmit(); } });
	// a reload loses the pending approval (it lives only on the server for 30 minutes): drop a dangling request from the saved chat
	const last = messages[messages.length - 1]; if (last && last.role === 'assistant' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_use')) { messages.pop(); save(); }
})();
