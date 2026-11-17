(function () {
	var S = window.CWAI_S;
	if (!S) return;
	function call(path) {
		return fetch(S.root + path, { method: 'POST', headers: { 'X-WP-Nonce': S.nonce }, credentials: 'same-origin' }).then(function (r) { return r.json(); });
	}
	var t = document.getElementById('cwai-test');
	var out = document.getElementById('cwai-test-result');
	if (t) t.addEventListener('click', function () {
		out.textContent = 'Testing… (save settings first if you changed the key)';
		call('/admin/test').then(function (r) {
			out.textContent = (r.ok ? '✓ ' : '✕ ') + (r.message || '');
			out.style.color = r.ok ? '#1a7f37' : '#b32d2e';
		}).catch(function (e) { out.textContent = '✕ ' + e.message; });
	});
	var m = document.getElementById('cwai-refresh-models');
	if (m) m.addEventListener('click', function () {
		m.disabled = true;
		call('/admin/models').then(function (r) {
			m.disabled = false;
			if (!r.ok) { alert(r.message || 'Could not load models'); return; }
			var sel = document.getElementById('cwai-model');
			var cur = sel.value;
			sel.innerHTML = '';
			Object.keys(r.models).forEach(function (id) {
				var o = document.createElement('option');
				o.value = id; o.textContent = r.models[id];
				if (id === cur) o.selected = true;
				sel.appendChild(o);
			});
		}).catch(function (e) { m.disabled = false; alert(e.message); });
	});
})();
