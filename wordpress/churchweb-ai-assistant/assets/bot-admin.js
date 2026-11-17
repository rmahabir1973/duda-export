(function () {
	var C = window.CWAI_BA; if (!C) return;
	var S = C.state, body = document.getElementById('cwb-body');
	function h(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
	function api(data) {
		return fetch(C.root + '/bot/admin', { method: data ? 'POST' : 'GET', credentials: 'same-origin', headers: { 'X-WP-Nonce': C.nonce, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined })
			.then(function (r) { return r.text().then(function (t) { var j; try { j = JSON.parse(t); } catch (e) { throw new Error('Unexpected reply (HTTP ' + r.status + ').'); } if (!r.ok) throw new Error(j.message || 'Error'); return j; }); });
	}
	var tab = 'settings';
	function show(t) { tab = t || tab; document.querySelectorAll('#cwb-tabs a').forEach(function (a) { a.classList.toggle('nav-tab-active', a.getAttribute('data-t') === tab); }); ({ settings: settings, kb: kb, q: questions, test: test })[tab](); }
	function msg(t, ok) { var m = document.getElementById('cwb-msg'); if (m) { m.className = 'cwi-msg ' + (ok ? 'cwi-ok' : 'cwi-err'); m.textContent = t; } }

	function settings() {
		var o = S.settings;
		body.innerHTML = '<div class="cwi-card"><p style="margin-top:0"><label style="display:inline"><input type="checkbox" id="s-enabled"' + (o.enabled ? ' checked' : '') + '> <b>Show the chatbot to visitors</b></label></p>' +
			(S.api_ready ? '' : '<p class="cwi-err">No Claude API key is set up (Settings), so the bot cannot reply yet.</p>') +
			(S.kb.length ? '' : '<p class="description">No knowledge yet: add some first (ask the assistant, or use the Knowledge tab), then test it before turning it on.</p>') +
			'<label>Name in the chat header</label><input type="text" id="s-name" value="' + h(o.name) + '">' +
			'<label>Organization name (leave empty to use the site title)</label><input type="text" id="s-org" value="' + h(o.org) + '">' +
			'<label>First message</label><textarea id="s-greeting" rows="2" placeholder="Hi! I can answer questions about us...">' + h(o.greeting) + '</textarea>' +
			'<label>Suggested questions (one per line, up to 5)</label><textarea id="s-suggested" rows="4">' + h((o.suggested || []).join('\n')) + '</textarea>' +
			'<label>How visitors reach a person when the bot cannot help</label><textarea id="s-contact" rows="2" placeholder="Call the office at ... or email ...">' + h(o.contact_text) + '</textarea>' +
			'<label>Contact page link (optional)</label><input type="text" id="s-curl" value="' + h(o.contact_url) + '">' +
			'<label>Privacy policy link (optional)</label><input type="text" id="s-purl" value="' + h(o.privacy_url) + '">' +
			'<label>Tone</label><input type="text" id="s-tone" value="' + h(o.tone) + '">' +
			'<label>Colour (empty = your site design colour, now <span style="background:' + h(S.color) + ';display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:middle"></span> ' + h(S.color) + ')</label><input type="text" id="s-color" value="' + h(o.color) + '" placeholder="#7A2A8E" style="max-width:140px">' +
			'<label>Side of the screen</label><select id="s-pos"><option value="right"' + (o.position === 'right' ? ' selected' : '') + '>Right</option><option value="left"' + (o.position === 'left' ? ' selected' : '') + '>Left</option></select>' +
			'<label>Hide on these paths (one per line, e.g. /donate/ or /members/*)</label><textarea id="s-hide" rows="2">' + h(o.hide_on) + '</textarea>' +
			'<label>What is saved</label><select id="s-log"><option value="unanswered"' + (o.logging === 'unanswered' ? ' selected' : '') + '>Only questions it could not answer (recommended)</option><option value="all"' + (o.logging === 'all' ? ' selected' : '') + '>Every question</option><option value="off"' + (o.logging === 'off' ? ' selected' : '') + '>Nothing</option></select>' +
			'<label>Daily limit of visitor messages (0 = no limit). Used today: ' + S.used_today + '</label><input type="text" id="s-cap" value="' + h(o.daily_cap) + '" style="max-width:100px">' +
			'<label>Model</label><input type="text" id="s-model" value="' + h(o.model) + '"><p class="description">The small, fast model keeps answers cheap. Visitor messages are sent to Claude; do not enter private information in the knowledge.</p>' +
			'<p><button class="button button-primary" id="s-save">Save</button> <span id="cwb-msg" class="cwi-msg"></span></p></div>';
		document.getElementById('s-save').onclick = function () {
			var v = function (id) { return document.getElementById(id).value; };
			api({ action: 'settings', settings: { enabled: document.getElementById('s-enabled').checked, name: v('s-name'), org: v('s-org'), greeting: v('s-greeting'), suggested: v('s-suggested'), contact_text: v('s-contact'), contact_url: v('s-curl'), privacy_url: v('s-purl'), tone: v('s-tone'), color: v('s-color'), position: v('s-pos'), hide_on: v('s-hide'), logging: v('s-log'), daily_cap: v('s-cap'), model: v('s-model') } }).then(function (st) { S = st; msg('Saved.', true); }).catch(function (e) { msg(e.message); });
		};
	}

	function kb() {
		var rows = S.kb.map(function (e) { return '<tr><td><b>' + h(e.title) + '</b>' + (e.source_post ? ' <span class="description">(from a page, auto-refreshes)</span>' : '') + '<br><span class="description">' + h(e.content.slice(0, 140)) + (e.content.length > 140 ? '…' : '') + '</span></td><td>' + h(e.category) + '</td><td>' + (e.enabled ? 'On' : 'Off') + '</td><td><a href="#" data-e="' + e.id + '">Edit</a> · <a href="#" data-d="' + e.id + '" style="color:#b32d2e">Remove</a></td></tr>'; }).join('');
		body.innerHTML = '<div class="cwi-card" style="max-width:1000px"><p class="description" style="margin-top:0">' + S.kb.length + ' entries · ' + S.kb_chars + ' of ' + S.kb_cap + ' characters used per question. The easiest way to add knowledge is to ask the assistant: "add our worship and visit pages to the chatbot".</p>' +
			(rows ? '<table class="widefat striped"><thead><tr><th>Entry</th><th>Group</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' : '<p>No entries yet.</p>') + '</div>' +
			'<div class="cwi-card" id="kb-form"><h3 style="margin-top:0" id="kb-h">Add an entry</h3><input type="hidden" id="k-id"><label>Title</label><input type="text" id="k-title"><label>Facts (plain text)</label><textarea id="k-content" rows="6"></textarea><label>Group (optional)</label><input type="text" id="k-cat" placeholder="worship, events, contact..."><label>Page link (optional)</label><input type="text" id="k-url"><label style="font-weight:400"><input type="checkbox" id="k-on" checked> Use this entry</label><p><button class="button button-primary" id="k-save">Save entry</button> <span id="cwb-msg" class="cwi-msg"></span></p></div>';
		body.querySelectorAll('[data-e]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); var e = S.kb.filter(function (x) { return x.id === +a.getAttribute('data-e'); })[0]; document.getElementById('kb-h').textContent = 'Edit entry'; document.getElementById('k-id').value = e.id; document.getElementById('k-title').value = e.title; document.getElementById('k-content').value = e.content; document.getElementById('k-cat').value = e.category; document.getElementById('k-url').value = e.url; document.getElementById('k-on').checked = e.enabled; document.getElementById('kb-form').scrollIntoView(); }; });
		body.querySelectorAll('[data-d]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); if (!confirm('Remove this entry?')) return; api({ action: 'kb_delete', id: +a.getAttribute('data-d') }).then(function (st) { S = st; kb(); }); }; });
		document.getElementById('k-save').onclick = function () {
			var v = function (id) { return document.getElementById(id).value; };
			api({ action: 'kb_save', entry: { id: +v('k-id') || 0, title: v('k-title'), content: v('k-content'), category: v('k-cat'), url: v('k-url'), enabled: document.getElementById('k-on').checked } }).then(function (st) { S = st; kb(); msg('Saved.', true); }).catch(function (e) { msg(e.message); });
		};
	}

	function questions() {
		var rows = S.questions.map(function (q) { return '<tr><td>' + h(q.question) + '<br><span class="description">Bot said: ' + h(q.bot_reply) + '</span></td><td>' + q.times_asked + '×</td><td>' + (q.answered ? 'Answered' : '<b>Not answered</b>') + '</td><td><a href="#" data-x="' + h(q.id) + '">Done</a></td></tr>'; }).join('');
		var prompt = 'Review the questions visitors asked the chatbot that it could not answer, add the missing knowledge, test it, and tell me what you changed.';
		body.innerHTML = '<div class="cwi-card" style="max-width:1000px"><p class="description" style="margin-top:0">Questions the chatbot could not answer (' + (S.settings.logging === 'off' ? 'logging is off' : 'logging: ' + S.settings.logging) + '). <a href="' + C.chat + '&cwai_prompt=' + encodeURIComponent(prompt) + '">Ask the assistant to fix the gaps</a></p>' + (rows ? '<table class="widefat striped"><thead><tr><th>Question</th><th>Asked</th><th></th><th></th></tr></thead><tbody>' + rows + '</tbody></table><p><button class="button" id="q-all">Mark all done</button></p>' : '<p>Nothing to show yet.</p>') + '</div>';
		body.querySelectorAll('[data-x]').forEach(function (a) { a.onclick = function (ev) { ev.preventDefault(); api({ action: 'dismiss', ids: [a.getAttribute('data-x')] }).then(function (st) { S = st; questions(); }); }; });
		var all = document.getElementById('q-all'); if (all) all.onclick = function () { api({ action: 'dismiss', ids: 'all' }).then(function (st) { S = st; questions(); }); };
	}

	function test() {
		body.innerHTML = '<div class="cwi-card"><p class="description" style="margin-top:0">Ask the bot a question the way a visitor would. Tests are not saved or counted.</p><input type="text" id="t-q" placeholder="What time are your services?" style="max-width:520px"> <button class="button button-primary" id="t-go">Ask</button> <span id="cwb-msg" class="cwi-msg"></span><div id="t-out" style="margin-top:14px"></div></div>';
		function go() {
			var q = document.getElementById('t-q').value.trim(); if (q.length < 2) return; msg('Thinking…', true);
			api({ action: 'test', q: q }).then(function (r) { msg('', true); document.getElementById('t-out').innerHTML = '<div class="cwi-card" style="background:#f6f7f7"><b>' + (r.answered ? 'Answered from the knowledge' : 'Could not answer (would show contact details)') + '</b><p style="white-space:pre-wrap">' + h(r.reply) + '</p><p class="description">Knowledge entries sent: ' + r.knowledge_entries + '</p></div>'; }).catch(function (e) { msg(e.message); });
		}
		document.getElementById('t-go').onclick = go; document.getElementById('t-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
	}
	document.getElementById('cwb-tabs').addEventListener('click', function (e) { var a = e.target.closest('a[data-t]'); if (!a) return; e.preventDefault(); show(a.getAttribute('data-t')); });
	show('settings');
})();
