(function () {
	var H = window.CWAI_H; if (!H) return;
	var out = document.getElementById('cwh-out'), btn = document.getElementById('cwh-run'), st = document.getElementById('cwh-status');
	function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
	function api(path, method, body) {
		return fetch(H.root + path, { method: method || 'GET', headers: { 'X-WP-Nonce': H.nonce, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
			.then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || 'Request failed'); return j; }); });
	}
	var COL = { ok: '#1a7f37', warn: '#b26a00', bad: '#b00020', info: '#555' };
	var ICON = { ok: '✔', warn: '!', bad: '✖', info: 'i' };
	function render(checks, when) {
		var order = { bad: 0, warn: 1, info: 2, ok: 3 };
		var list = (checks || []).slice().sort(function (a, b) { return order[a.level] - order[b.level]; });
		if (!list.length) { out.innerHTML = '<p>No results yet. Click “Run the check”.</p>'; return; }
		var n = { bad: 0, warn: 0 }; list.forEach(function (c) { if (n[c.level] != null) n[c.level]++; });
		var h = '<p><strong>' + (n.bad ? n.bad + ' to fix' : 'Nothing urgent') + (n.warn ? ', ' + n.warn + ' to look at' : '') + '.</strong>' + (when ? ' <span class="description">Last run ' + esc(new Date(when * 1000).toLocaleString()) + '</span>' : '') + '</p>';
		list.forEach(function (c) {
			h += '<div class="card" style="max-width:900px;margin:8px 0;padding:10px 14px;border-left:4px solid ' + COL[c.level] + '"><strong style="color:' + COL[c.level] + '">' + ICON[c.level] + '</strong> <strong>' + esc(c.title) + '</strong>' + (c.count && c.level !== 'ok' ? ' <span class="description">(' + c.count + ')</span>' : '');
			if (c.detail) h += '<div class="description">' + esc(c.detail) + '</div>';
			if (c.items && c.items.length) {
				h += '<ul style="margin:6px 0 6px 18px;list-style:disc">';
				c.items.forEach(function (i) { h += '<li>' + (i.url ? '<a href="' + esc(i.url) + '" target="_blank" rel="noopener">' + esc(i.label) + '</a>' : esc(i.label)) + '</li>'; });
				h += '</ul>' + (c.count > c.items.length ? '<div class="description">…and ' + (c.count - c.items.length) + ' more.</div>' : '');
			}
			if (c.fix && c.level !== 'ok') h += '<p style="margin:6px 0 0"><a class="button" href="' + esc(H.chat) + '&cwai_prompt=' + encodeURIComponent(c.fix) + '">Fix with the assistant</a></p>';
			h += '</div>';
		});
		out.innerHTML = h;
	}
	function loop(total, off) {
		st.textContent = 'Checking links… ' + Math.min(off, total) + ' of ' + total;
		return api('/health/links', 'POST', { offset: off }).then(function (r) {
			if (r.done) return r.check;
			return loop(r.total, r.next);
		});
	}
	btn.onclick = function () {
		btn.disabled = true; st.textContent = 'Checking the site…'; out.innerHTML = '';
		api('/health/start', 'POST', {}).then(function (r) {
			render(r.checks);
			if (!r.link_total) { st.textContent = 'Done.'; return api('/health/last').then(function (l) { render(l.checks, l.time); }); }
			return loop(r.link_total, 0).then(function () { return api('/health/last'); }).then(function (l) { render(l.checks, l.time); st.textContent = 'Done.'; });
		}).catch(function (e) { st.textContent = 'Could not finish: ' + e.message; }).then(function () { btn.disabled = false; });
	};
	if (H.last && H.last.checks && H.last.checks.length) render(H.last.checks, H.last.time);
})();
