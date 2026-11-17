(function () {
	var R = window.CWAI_R; if (!R) return;
	var $ = function (id) { return document.getElementById(id); };
	var list = $('cwr-list'), go = $('cwr-go'), st = $('cwr-status'), prog = $('cwr-progress');
	function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
	function api(path, method, body) {
		return fetch(R.root.indexOf('?') > -1 ? R.root + path.replace('?', '&') : R.root + path, { method: method || 'GET', headers: { 'X-WP-Nonce': R.nonce, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
			.then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.message || 'Request failed'); e.data = j; throw e; } return j; }); });
	}
	function mode() { return document.querySelector('input[name="cwr-mode"]:checked').value; }
	function row(cls, key, label, n, note, checked) {
		return '<label style="display:block;margin:3px 0"><input type="checkbox" class="' + cls + '" data-k="' + esc(key) + '"' + (checked ? ' checked' : '') + (n === 0 ? ' disabled' : '') + '> ' + esc(label) + ' <span class="description">(' + n + (note ? ', ' + esc(note) : '') + ')</span></label>';
	}
	function render(inv) {
		var h = '<p class="description">Pages, posts and content types</p>';
		inv.types.forEach(function (t) { h += row('cwr-type', t.slug, t.label, t.count, mode() === 'trash' && t.total > t.count ? t.total - t.count + ' already in the trash' : '', t.count > 0); });
		h += '<p class="description" style="margin-top:10px">Everything else</p>';
		h += row('cwr-scope', 'media', 'Media library: images and files', inv.media, 'files are always permanently deleted', inv.media > 0);
		h += row('cwr-scope', 'menus', 'Menus', inv.menus, '', inv.menus > 0);
		h += row('cwr-scope', 'terms', 'Categories, tags and other terms', inv.terms, 'the default category stays', inv.terms > 0);
		h += row('cwr-scope', 'comments', 'Comments', inv.comments, 'permanently deleted', inv.comments > 0);
		h += row('cwr-scope', 'assistant', 'Assistant data: imports, wizard answers, design choice, chats, undo points, chatbot knowledge', inv.assistant.chats + inv.assistant.knowledge, 'settings and keys stay', true);
		if (inv.oxygen_types.length) h += row('cwr-scope', 'oxygen', 'Oxygen templates, headers, footers and components', inv.oxygen, 'global styles are not touched', false);
		if (inv.has_types_def) h += row('cwr-scope', 'typedefs', 'The Sermons / Events / Staff section definitions made by the assistant', 1, 'the sections disappear from the menu', false);
		list.innerHTML = h;
		check();
	}
	function load() { return api('/reset/inventory?mode=' + mode()).then(function (r) { render(r.inventory); }).catch(function (e) { list.innerHTML = '<p style="color:#b00020">' + esc(e.message) + '</p>'; }); }
	function picked() {
		var types = [], scopes = {};
		document.querySelectorAll('.cwr-type:checked').forEach(function (c) { types.push(c.dataset.k); });
		document.querySelectorAll('.cwr-scope:checked').forEach(function (c) { scopes[c.dataset.k] = 1; });
		return { types: types, scopes: scopes };
	}
	function check() {
		var p = picked();
		go.disabled = !!R.blocked || !$('cwr-backup').checked || $('cwr-confirm').value.trim() !== R.want || (!p.types.length && !Object.keys(p.scopes).length);
	}
	function show(rem) {
		var h = '<ul style="margin:8px 0 0 18px;list-style:disc">';
		Object.keys(rem).forEach(function (k) { h += '<li>' + esc(rem[k].label) + ': ' + (rem[k].left > 0 ? rem[k].left + ' left' : '<strong>done</strong>') + '</li>'; });
		prog.innerHTML = h + '</ul>';
	}
	function loop(token) {
		return api('/reset/step', 'POST', { token: token }).then(function (r) {
			if (!r.done) { show(r.remaining); return loop(token); }
			return r;
		});
	}
	go.onclick = function () {
		var p = picked();
		if (!confirm('This clears the selected content from this site. Continue?')) return;
		go.disabled = true; st.textContent = 'Working…'; prog.innerHTML = '';
		api('/reset/start', 'POST', { mode: mode(), types: p.types, scopes: p.scopes, confirm: $('cwr-confirm').value, backup: $('cwr-backup').checked }).then(function (s) {
			show(s.plan); return loop(s.token);
		}).then(function (r) {
			var t = r.summary.totals || {}, parts = Object.keys(t).map(function (k) { return k + ': ' + t[k]; });
			st.textContent = 'Finished. ' + parts.join(', ');
			prog.innerHTML = '<div class="notice notice-success inline"><p><strong>The reset is complete.</strong> The site is ready to build again. Open the assistant to start.</p></div>';
			load();
		}).catch(function (e) { st.textContent = e.message; check(); });
	};
	document.querySelectorAll('input[name="cwr-mode"]').forEach(function (r) { r.addEventListener('change', load); });
	['cwr-backup', 'cwr-confirm'].forEach(function (id) { $(id).addEventListener('input', check); $(id).addEventListener('change', check); });
	list.addEventListener('change', check);
	load();
})();
