(function () {
	var C = window.CWAI_BOT;
	if (!C || document.getElementById('cwb-root')) return;
	var cfg = null, msgs = [], busy = false, opened = false, SKEY = 'cwb_chat_v1';
	function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
	function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
	function fmt(t) {
		var h = esc(t);
		h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, function (m, a, u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + a + '</a>'; });
		h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
		h = h.replace(/(^|[\s(>])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1<a href="mailto:$2">$2</a>');
		h = h.replace(/(^|[\s(>])(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})\b/g, function (m, p, n) { return p + '<a href="tel:' + n.replace(/[^\d+]/g, '') + '">' + n + '</a>'; });
		var lines = h.split(/\n/), out = [], inList = false;
		lines.forEach(function (l) { var li = /^\s*[-•*]\s+(.*)$/.exec(l); if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + li[1] + '</li>'); } else { if (inList) { out.push('</ul>'); inList = false; } out.push(l + '<br>'); } });
		if (inList) out.push('</ul>');
		return out.join('').replace(/(<br>)+$/, '');
	}
	var root = el('div'); root.id = 'cwb-root'; root.className = 'cwb-' + C.position + (Number(C.offset) ? ' cwb-up' : '');
	root.style.setProperty('--cwb', C.color); root.style.setProperty('--cwb-on', C.on);
	var launch = el('button', 'cwb-launch', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>');
	launch.type = 'button'; launch.setAttribute('aria-label', 'Open chat: ' + C.name); launch.setAttribute('aria-expanded', 'false'); launch.setAttribute('aria-controls', 'cwb-panel');
	var panel = el('section', 'cwb-panel'); panel.id = 'cwb-panel'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', C.name);
	var head = el('div', 'cwb-head', '<b></b><button type="button" data-a="new">New chat</button><button type="button" data-a="close" aria-label="Close chat">✕</button>');
	head.querySelector('b').textContent = C.name;
	var note = el('div', 'cwb-note'); var log = el('div', 'cwb-log'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite'); var chips = el('div', 'cwb-chips');
	var form = el('form'); var ta = el('textarea'); ta.rows = 1; ta.maxLength = 600; ta.setAttribute('aria-label', 'Your question'); ta.placeholder = 'Type your question…';
	var hp = el('div', 'cwb-hp', '<label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label>');
	var sendBtn = el('button', null, 'Send'); sendBtn.type = 'submit';
	form.appendChild(ta); form.appendChild(sendBtn); form.appendChild(hp);
	var foot = el('div', 'cwb-foot');
	[head, note, log, chips, form, foot].forEach(function (n) { panel.appendChild(n); });
	root.appendChild(panel); root.appendChild(launch); document.body.appendChild(root);

	function save() { try { sessionStorage.setItem(SKEY, JSON.stringify({ t: Date.now(), msgs: msgs.slice(-20) })); } catch (e) {} }
	function load() { try { var s = JSON.parse(sessionStorage.getItem(SKEY) || 'null'); if (s && Date.now() - s.t < 30 * 60000) msgs = s.msgs || []; } catch (e) {} }
	function scroll() { log.scrollTop = log.scrollHeight; }
	function add(role, text) { var d = el('div', 'cwb-m ' + (role === 'user' ? 'me' : 'bot'), fmt(text)); log.appendChild(d); scroll(); return d; }
	function contactCard(text, url) {
		if (!text && !url) return;
		var h = (text ? fmt(text) : '') + (url ? (text ? '<br>' : '') + '<a href="' + esc(url) + '">Contact page</a>' : '');
		log.appendChild(el('div', 'cwb-contact', h)); scroll();
	}
	function render() {
		log.innerHTML = '';
		if (cfg) add('bot', cfg.greeting);
		msgs.forEach(function (m) { add(m.role, m.content); });
		chips.innerHTML = '';
		if (cfg && !msgs.length) (cfg.suggested || []).forEach(function (q) { var b = el('button'); b.type = 'button'; b.textContent = q; b.onclick = function () { ask(q); }; chips.appendChild(b); });
	}
	function api(path, body) {
		var o = { method: body ? 'POST' : 'GET', credentials: 'omit', headers: {} };
		if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
		return fetch(C.root + path, o).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
	}
	function init() {
		return api('/bot/init').then(function (r) {
			if (!r.ok || !r.j.enabled) throw new Error('off');
			cfg = r.j; cfg.t = Date.now();
			note.textContent = cfg.disclosure;
			foot.innerHTML = cfg.privacy_url ? '<a href="' + esc(cfg.privacy_url) + '" target="_blank" rel="noopener">Privacy</a>' : '';
			if (cfg.logging && cfg.logging !== 'off') foot.insertAdjacentHTML('afterbegin', (cfg.logging === 'all' ? 'Chats are saved to improve answers. ' : 'Questions the assistant cannot answer are saved to improve it. ') + 'Please do not share personal details. ');
			load(); render();
		});
	}
	function flag(v) { try { sessionStorage.setItem('cwb_open', v ? '1' : '0'); } catch (e) {} }
	function open() {
		flag(true); root.classList.add('cwb-open'); panel.hidden = false; launch.setAttribute('aria-expanded', 'true'); opened = true;
		(cfg ? Promise.resolve() : init()).then(function () { ta.focus(); }).catch(function () { log.innerHTML = ''; add('bot', 'Sorry, the assistant is not available right now.'); });
	}
	function close() { flag(false); root.classList.remove('cwb-open'); panel.hidden = true; launch.setAttribute('aria-expanded', 'false'); launch.focus(); }
	function ask(text) {
		text = String(text || '').trim();
		if (!text || busy || !cfg) return;
		busy = true; sendBtn.disabled = true; chips.innerHTML = '';
		msgs.push({ role: 'user', content: text }); add('user', text); ta.value = ''; ta.style.height = 'auto'; save();
		var typing = el('div', 'cwb-typing', '<i></i><i></i><i></i>'); typing.setAttribute('aria-label', 'Typing'); log.appendChild(typing); scroll();
		var wait = Math.max(0, 1600 - (Date.now() - cfg.t));
		setTimeout(function () {
			api('/bot/chat', { messages: msgs.slice(-8), token: cfg.token, website: form.querySelector('input[name=website]').value }).then(function (r) {
				typing.remove();
				var j = r.j || {};
				if (j.reply) { add('bot', j.reply); if (r.ok) msgs.push({ role: 'assistant', content: j.reply }); }
				else add('bot', 'Sorry, something went wrong. Please try again.');
				if (!r.ok && j.error === 'token') { cfg = null; init(); }
				if (j.contact_text || j.contact_url) contactCard(j.contact_text, j.contact_url);
				save();
			}).catch(function () { typing.remove(); add('bot', 'Sorry, I could not reach the assistant. Please try again.'); }).then(function () { busy = false; sendBtn.disabled = false; ta.focus(); });
		}, wait);
	}
	launch.addEventListener('click', function () { panel.hidden ? open() : close(); });
	head.addEventListener('click', function (e) { var a = e.target.closest('[data-a]'); if (!a) return; if (a.getAttribute('data-a') === 'close') close(); else { msgs = []; try { sessionStorage.removeItem(SKEY); } catch (x) {} render(); ta.focus(); } });
	form.addEventListener('submit', function (e) { e.preventDefault(); ask(ta.value); });
	ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(ta.value); } });
	ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(96, ta.scrollHeight) + 'px'; });
	panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
	try { if (sessionStorage.getItem('cwb_open') === '1') open(); } catch (e) {}
})();
