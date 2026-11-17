(function () {
	'use strict';
	var C = window.CWAI;
	if (!C) return;
	var I = C.i18n || {};

	/* ---------- helpers ---------- */
	function el(tag, cls, html) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (html != null) e.innerHTML = html;
		return e;
	}
	function esc(s) {
		return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
	}
	function safeUrl(u) {
		return /^(https?:\/\/|\/|#|mailto:|tel:)/i.test(u) ? u : '#';
	}
	function md(src) {
		var codes = [];
		var t = esc(src).replace(/```[a-z]*\n?([\s\S]*?)```/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
		t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>')
			.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
			.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
			.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, a, u) { return '<a href="' + safeUrl(u.replace(/&amp;/g, '&')) + '" target="_blank" rel="noopener">' + a + '</a>'; })
			.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_, p, u) { return p + '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>'; });
		var out = [], list = null;
		t.split('\n').forEach(function (line) {
			var ul = /^\s*[-*•]\s+(.*)/.exec(line), ol = /^\s*\d+[.)]\s+(.*)/.exec(line), h = /^#{1,4}\s+(.*)/.exec(line);
			if (ul || ol) {
				var kind = ul ? 'ul' : 'ol';
				if (list !== kind) { if (list) out.push('</' + list + '>'); out.push('<' + kind + '>'); list = kind; }
				out.push('<li>' + (ul || ol)[1] + '</li>');
				return;
			}
			if (list) { out.push('</' + list + '>'); list = null; }
			if (h) out.push('<p><strong>' + h[1] + '</strong></p>');
			else if (line.trim() === '') out.push('\u0001');
			else out.push(line + '<br>');
		});
		if (list) out.push('</' + list + '>');
		t = out.join('').replace(/(<br>)?\u0001+/g, '</p><p>');
		t = '<p>' + t + '</p>';
		t = t.replace(/<p>\s*(<\/?(ul|ol)>)/g, '$1').replace(/(<\/?(ul|ol)>)\s*<\/p>/g, '$1').replace(/<p>\s*<\/p>/g, '').replace(/<br><\/p>/g, '</p>').replace(/<br>(<\/?(ul|ol))/g, '$1');
		return t.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<pre><code>' + codes[+i] + '</code></pre>'; });
	}

	function Api(path, opts) {
		opts = opts || {};
		var h = { 'X-WP-Nonce': C.nonce };
		var init = { method: opts.method || 'GET', headers: h, credentials: 'same-origin' };
		if (opts.form) init.body = opts.form;
		else if (opts.body) { h['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
		return fetch(C.root + path, init).then(function (r) {
			return r.text().then(function (txt) {
				var j; try { j = JSON.parse(txt); } catch (e) { j = { message: r.ok ? 'Unexpected response from the server.' : 'Server error (' + r.status + '). ' + txt.replace(/<[^>]+>/g, ' ').slice(0, 160) }; }
				if (!r.ok) { var err = new Error(j.message || ('Error ' + r.status)); err.data = j; throw err; }
				return j;
			});
		});
	}

	/* ---------- chat widget ---------- */
	function Chat(root, mode) {
		var self = this;
		this.mode = mode;
		this.conv = 0;
		this.busy = false;
		this.stop = false;
		this.items = {};
		this.files = [];
		var wrap = this.wrap = el('div', 'cwai' + (mode === 'page' ? ' cwai-page' : ''));
		wrap.innerHTML =
			'<div class="cwai-head"><div class="cwai-title"></div><select class="cwai-model" title="AI model"></select>' +
			'<button class="cwai-btn" data-a="hist" type="button"></button><button class="cwai-btn" data-a="new" type="button"></button>' +
			(mode === 'panel' ? '<button class="cwai-btn" data-a="close" type="button" aria-label="Close">✕</button>' : '') + '</div>' +
			'<div class="cwai-body"><div class="cwai-msgs" aria-live="polite"></div><div class="cwai-hist"></div></div>' +
			'<div class="cwai-status"></div>' +
			'<div class="cwai-compose"><div class="cwai-pending"></div><div class="cwai-row">' +
			'<button class="cwai-btn" data-a="attach" type="button" title="" aria-label="Attach">📎</button>' +
			'<textarea rows="1"></textarea><button class="cwai-btn primary" data-a="send" type="button"></button></div>' +
			'<label class="cwai-enter"><input type="checkbox" class="cwai-enter-cb"> <span></span></label>' +
			'<input type="file" hidden multiple accept="image/*,.pdf,.docx,.txt,.csv"></div>';
		root.appendChild(wrap);
		this.$ = function (s) { return wrap.querySelector(s); };
		this.msgs = this.$('.cwai-msgs');
		this.ta = this.$('textarea');
		this.sendBtn = this.$('[data-a=send]');
		this.$('.cwai-title').textContent = C.brand;
		this.$('[data-a=hist]').textContent = I.history;
		this.$('[data-a=new]').textContent = I.new;
		this.$('[data-a=attach]').title = I.attach;
		this.ta.placeholder = I.placeholder;
		this.sendBtn.textContent = I.send;
		try { var pre = new URLSearchParams(location.search).get('cwai_prompt'); if (pre && root.getAttribute('data-mode') === 'page') { this.ta.value = pre; } } catch (e) {}

		var sel = this.$('.cwai-model'), models = C.models || {};
		if (!Object.keys(models).length) sel.style.display = 'none';
		else {
			var saved = localStorage.getItem('cwai_model') || C.model;
			Object.keys(models).forEach(function (id) {
				var o = el('option'); o.value = id; o.textContent = models[id];
				if (id === saved) o.selected = true;
				sel.appendChild(o);
			});
			sel.addEventListener('change', function () { localStorage.setItem('cwai_model', sel.value); });
		}

		wrap.addEventListener('click', function (e) {
			var a = e.target.closest('[data-a]'); if (!a) return;
			var act = a.getAttribute('data-a');
			if (act === 'send') self.busy ? self.onStop() : self.send();
			else if (act === 'new') self.reset();
			else if (act === 'hist') self.history();
			else if (act === 'attach') self.$('input[type=file]').click();
			else if (act === 'close' && self.onClose) self.onClose();
		});
		// Enter starts a new line by default (long prompts); Ctrl/Cmd+Enter always sends; the checkbox makes plain Enter send.
		var enterCb = this.$('.cwai-enter-cb');
		this.$('.cwai-enter span').textContent = I.enterSends || 'Press Enter to send';
		this.$('.cwai-enter').title = I.enterHint || 'Off: Enter adds a new line and you click Send (or press Ctrl+Enter). On: Enter sends and Shift+Enter adds a new line.';
		try { enterCb.checked = localStorage.getItem('cwai_enter_send') === '1'; } catch (e) {}
		enterCb.addEventListener('change', function () { try { localStorage.setItem('cwai_enter_send', enterCb.checked ? '1' : '0'); } catch (e) {} self.ta.focus(); });
		this.ta.addEventListener('keydown', function (e) {
			if (e.key !== 'Enter' || e.isComposing) return;
			if (e.ctrlKey || e.metaKey || (enterCb.checked && !e.shiftKey)) { e.preventDefault(); if (!self.busy) self.send(); }
		});
		this.ta.addEventListener('input', function () { self.ta.style.height = 'auto'; self.ta.style.height = Math.min(160, self.ta.scrollHeight) + 'px'; });
		this.$('input[type=file]').addEventListener('change', function (e) { self.upload(e.target.files); e.target.value = ''; });
		wrap.addEventListener('paste', function (e) {
			var fs = e.clipboardData && e.clipboardData.files; if (fs && fs.length) self.upload(fs);
		});

		this.empty();
		if (!C.hasKey) {
			this.say('assistant', C.isAdmin
				? 'The assistant is not connected yet. [Add your Anthropic API key in Settings](' + C.settingsUrl + ') and it will be ready.'
				: 'The assistant is not connected yet. Please ask your site administrator to add the Anthropic API key in the assistant settings.');
		}
	}

	Chat.prototype.empty = function () {
		var self = this;
		this.items = {};
		this.msgs.innerHTML = '';
		var e = el('div', 'cwai-empty', '<h3>' + esc(C.brand) + '</h3><div>Tell me what you would like changed on the website. I can build and edit pages, update menus, post sermons and blog articles, and improve your Google search listing.</div>');
		var s = el('div', 'cwai-sugg');
		(C.suggestions || []).forEach(function (t) {
			var label = typeof t === 'string' ? t : t.label, text = typeof t === 'string' ? t : t.prompt;
			var b = el('button'); b.type = 'button'; b.textContent = label;
			b.onclick = function () { self.ta.value = text; self.ta.focus(); };
			s.appendChild(b);
		});
		e.appendChild(s);
		this.msgs.appendChild(e);
		this.emptyEl = e;
	};

	Chat.prototype.reset = function () {
		if (this.busy) return;
		this.conv = 0; this.files = []; this.renderPending(); this.empty(); this.status('');
		this.$('.cwai-title').textContent = C.brand;
		this.$('.cwai-hist').classList.remove('open');
		this.persist();
	};

	Chat.prototype.persist = function () {
		try { sessionStorage.setItem('cwai_conv', String(this.conv || 0)); } catch (e) {}
	};

	Chat.prototype.status = function (t) { this.$('.cwai-status').textContent = t || ''; };

	Chat.prototype.scroll = function () { this.msgs.scrollTop = this.msgs.scrollHeight; };

	Chat.prototype.say = function (who, text, key) {
		if (this.emptyEl) { this.emptyEl.remove(); this.emptyEl = null; }
		var m = el('div', 'cwai-m ' + (who === 'user' ? 'cwai-user' : 'cwai-asst'));
		m.innerHTML = md(text);
		if (key) { m.dataset.key = key; this.items[key] = m; }
		this.msgs.appendChild(m);
		this.scroll();
		return m;
	};

	Chat.prototype.upsert = function (it) {
		var self = this, node = it.key ? this.items[it.key] : null, fresh = !node;
		if (this.emptyEl) { this.emptyEl.remove(); this.emptyEl = null; }
		if (it.kind === 'user') {
			if (this.items.tmp) { this.items.tmp.remove(); delete this.items.tmp; }
			node = node || el('div', 'cwai-m cwai-user');
			node.innerHTML = md(it.text || '');
			if (it.files && it.files.length) {
				var f = el('div', 'cwai-files');
				it.files.forEach(function (x) { f.appendChild(/^image\//.test(x.mime) ? Object.assign(el('img'), { src: x.url, alt: x.name }) : el('span', null, '📄 ' + esc(x.name))); });
				node.appendChild(f);
			}
		} else if (it.kind === 'assistant') {
			node = node || el('div', 'cwai-m cwai-asst');
			node.innerHTML = md(it.text);
		} else if (it.kind === 'tool') {
			node = node || el('div');
			node.className = 'cwai-tool ' + it.status;
			var ico = { running: '<span class="cwai-spin"></span>', waiting: '⏸', ok: '✓', error: '✕', denied: '⊘' }[it.status] || '•';
			node.innerHTML = '<span class="ico">' + ico + '</span><span class="txt">' + esc(it.summary) + (it.error ? '<span class="err">' + esc(it.error) + '</span>' : '') + '</span>';
			if (it.status === 'ok' && it.snapshots && it.snapshots.length) {
				var u = el('button', 'cwai-btn'); u.type = 'button'; u.textContent = I.undo;
				u.onclick = function () { self.undo(it.snapshots, u); };
				node.appendChild(u);
			}
		}
		if (!node) return;
		if (it.key) { node.dataset.key = it.key; this.items[it.key] = node; }
		if (fresh) this.msgs.appendChild(node);
		this.scroll();
	};

	Chat.prototype.undo = function (ids, btn) {
		btn.disabled = true; btn.textContent = '…';
		var list = ids.slice().reverse(), self = this;
		(function next() {
			if (!list.length) { btn.textContent = '✓'; self.say('assistant', 'Undone. The page is back to how it was before that change.'); return; }
			Api('/undo/' + list.shift(), { method: 'POST' }).then(next).catch(function (e) { btn.disabled = false; btn.textContent = I.undo; self.say('assistant', 'I could not undo that: ' + e.message); });
		})();
	};

	Chat.prototype.apply = function (res) {
		var self = this;
		if (res.conversation_id) { this.conv = res.conversation_id; this.persist(); }
		if (res.title) this.$('.cwai-title').textContent = res.title;
		(res.items || []).forEach(function (it) { self.upsert(it); });
	};

	Chat.prototype.setBusy = function (b) {
		this.busy = b;
		this.sendBtn.textContent = b ? I.stop : I.send;
		this.sendBtn.classList.toggle('danger', b);
		this.sendBtn.classList.toggle('primary', !b);
		this.ta.disabled = b;
		if (!b) { this.status(''); clearInterval(this.timer); this.ta.focus(); }
	};

	Chat.prototype.onStop = function () { this.stop = true; this.status('Stopping after the current step…'); };

	Chat.prototype.upload = function (list) {
		var self = this;
		Array.prototype.forEach.call(list, function (f) {
			var fd = new FormData(); fd.append('file', f);
			self.status('Uploading ' + f.name + '…');
			Api('/upload', { method: 'POST', form: fd }).then(function (r) { self.files.push(r); self.renderPending(); self.status(''); })
				.catch(function (e) { self.status(''); self.say('assistant', 'Upload failed: ' + e.message); });
		});
	};

	Chat.prototype.renderPending = function () {
		var self = this, box = this.$('.cwai-pending');
		box.innerHTML = '';
		this.files.forEach(function (f, i) {
			var s = el('span', null, esc(f.name));
			var x = el('b', null, '×'); x.onclick = function () { self.files.splice(i, 1); self.renderPending(); };
			s.appendChild(x); box.appendChild(s);
		});
	};

	Chat.prototype.send = function () {
		var text = this.ta.value.trim();
		if (this.busy || (!text && !this.files.length)) return;
		var self = this, ids = this.files.map(function (f) { return f.id; });
		this.ta.value = ''; this.ta.style.height = 'auto';
		var tmp = this.say('user', text || '(attachment)', 'tmp');
		this.files = []; this.renderPending();
		this.stop = false;
		this.setBusy(true);
		var t0 = Date.now();
		this.timer = setInterval(function () { self.status(I.working + ' ' + Math.round((Date.now() - t0) / 1000) + 's'); }, 1000);
		var model = this.$('.cwai-model').value || '';
		this.run({ conversation_id: this.conv, message: text, attachments: ids, context: { url: location.href, post_id: C.postId || 0 }, model: model }, model);
	};

	Chat.prototype.run = function (body, model) {
		var self = this;
		Api('/chat', { method: 'POST', body: body }).then(function (res) {
			self.apply(res);
			if (res.status === 'continue' && !self.stop) return self.run({ conversation_id: res.conversation_id, model: model }, model);
			if (res.status === 'needs_approval') return self.askApproval(res, model);
			self.setBusy(false);
		}).catch(function (e) {
			if (self.items.tmp) { self.items.tmp.remove(); delete self.items.tmp; self.ta.value = body.message || ''; }
			self.say('assistant', '⚠️ ' + e.message);
			self.setBusy(false);
		});
	};

	Chat.prototype.askApproval = function (res, model) {
		var self = this, box = el('div', 'cwai-approve'), decisions = {};
		this.status('Waiting for your approval…');
		box.innerHTML = '<h4>Please confirm</h4>';
		(res.approvals || []).forEach(function (a) {
			var row = el('div', 'row');
			row.innerHTML = '<div>' + esc(a.summary) + '</div><small>' + esc(a.detail) + '</small>';
			box.appendChild(row);
			decisions[a.id] = true;
		});
		var acts = el('div', 'acts'), ok = el('button', 'cwai-btn primary'), no = el('button', 'cwai-btn danger');
		ok.type = no.type = 'button'; ok.textContent = I.approve; no.textContent = I.decline;
		acts.appendChild(ok); acts.appendChild(no); box.appendChild(acts);
		this.msgs.appendChild(box); this.scroll();
		function resolve(yes) {
			ok.disabled = no.disabled = true;
			Object.keys(decisions).forEach(function (k) { decisions[k] = yes; });
			Api('/approve', { method: 'POST', body: { conversation_id: res.conversation_id, decisions: decisions } }).then(function (r) {
				box.remove(); self.apply(r);
				if (r.status === 'continue' && !self.stop) return self.run({ conversation_id: r.conversation_id, model: model }, model);
				self.setBusy(false);
			}).catch(function (e) { box.remove(); self.say('assistant', '⚠️ ' + e.message); self.setBusy(false); });
		}
		ok.onclick = function () { resolve(true); };
		no.onclick = function () { resolve(false); };
	};

	Chat.prototype.history = function () {
		var self = this, box = this.$('.cwai-hist');
		if (box.classList.contains('open')) { box.classList.remove('open'); return; }
		box.innerHTML = 'Loading…'; box.classList.add('open');
		Api('/conversations').then(function (list) {
			box.innerHTML = '';
			if (!list.length) box.textContent = 'No earlier chats yet.';
			list.forEach(function (c) {
				var it = el('div', 'it'); it.innerHTML = '<span>' + esc(c.title || 'Untitled') + '</span><small>' + esc((c.updated || '').slice(0, 10)) + '</small>';
				var del = el('button', 'cwai-btn', '🗑'); del.type = 'button'; del.title = 'Delete';
				del.onclick = function (ev) { ev.stopPropagation(); if (confirm('Delete this chat?')) Api('/conversations/' + c.id, { method: 'DELETE' }).then(function () { it.remove(); if (self.conv === +c.id) self.reset(); }); };
				it.appendChild(del);
				it.onclick = function () { self.load(c.id); };
				box.appendChild(it);
			});
		}).catch(function (e) { box.textContent = e.message; });
	};

	Chat.prototype.load = function (id) {
		var self = this;
		this.$('.cwai-hist').classList.remove('open');
		this.msgs.innerHTML = ''; this.items = {}; this.emptyEl = null;
		Api('/conversations/' + id).then(function (res) {
			self.apply(res);
			if (res.status === 'needs_approval') { self.setBusy(true); self.askApproval(res, ''); }
		}).catch(function (e) { self.say('assistant', e.message); });
	};

	/* ---------- boot ---------- */
	function boot() {
		var page = document.getElementById('cwai-app');
		if (page) { new Chat(page, 'page'); return; }
		var root = document.getElementById('cwai-panel-root');
		if (!root) return;
		var fab = el('button'); fab.id = 'cwai-fab'; fab.type = 'button'; fab.title = C.brand; fab.setAttribute('aria-label', C.brand); fab.textContent = '💬';
		var drawer = el('div'); drawer.id = 'cwai-drawer'; drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-label', C.brand);
		root.appendChild(fab); root.appendChild(drawer);
		var chat = null;
		function open(v) {
			if (v && !chat) {
				chat = new Chat(drawer, 'panel');
				chat.onClose = function () { open(false); };
				var saved = +sessionStorage.getItem('cwai_conv') || 0;
				if (saved) chat.load(saved);
			}
			drawer.classList.toggle('open', v);
			fab.style.display = v ? 'none' : '';
			try { sessionStorage.setItem('cwai_open', v ? '1' : '0'); } catch (e) {}
			if (v && chat) chat.ta.focus();
		}
		fab.onclick = function () { open(true); };
		document.addEventListener('click', function (e) {
			var a = e.target.closest('#wp-admin-bar-cwai-toggle a, a[href="#cwai"]');
			if (a) { e.preventDefault(); open(!drawer.classList.contains('open')); }
		});
		if (sessionStorage.getItem('cwai_open') === '1') open(true);
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
