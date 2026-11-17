(function () {
	var D = window.CWAI_D;
	if (!D) return;
	var $ = function (s, r) { return (r || document).querySelector(s); };
	var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
	var sel = D.selected;

	function api(body) {
		return fetch(D.root + '/design', { method: 'POST', credentials: 'same-origin', headers: { 'X-WP-Nonce': D.nonce, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
			.then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || 'Error'); return j; }); });
	}
	function hex(c) { return [1, 3, 5].map(function (i) { return parseInt(c.substr(i, 2), 16); }); }
	function toHex(a) { return '#' + a.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return ('0' + v.toString(16)).slice(-2); }).join('').toUpperCase(); }
	function lum(c) { var a = hex(c).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]; }
	function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
	function on(bg) { return contrast('#FFFFFF', bg) >= contrast('#111111', bg) ? '#FFFFFF' : '#111111'; }
	function dark(c) { return toHex(hex(c).map(function (v) { return v * 0.78; })); }

	function paint(item, p, a) {
		var el = $('.cwd-p', item);
		el.style.setProperty('--p', p); el.style.setProperty('--pd', dark(p)); el.style.setProperty('--op', on(p));
		el.style.setProperty('--a', a); el.style.setProperty('--oa', on(a));
		el.style.setProperty('--l', contrast(p, getComputedStyle(el).getPropertyValue('--bg').trim() || '#fff') >= 4.5 ? p : a);
	}
	function item(id) { return $('.cwd-item[data-id="' + id + '"]'); }

	function render() {
		$$('.cwd-item').forEach(function (i) { i.classList.toggle('is-selected', !!sel && i.getAttribute('data-id') === sel.id); });
		var box = $('#cwd-current');
		if (!sel) { box.hidden = true; return; }
		var it = item(sel.id); if (!it) { box.hidden = true; return; }
		var p = sel.primary || it.getAttribute('data-p'), a = sel.accent || it.getAttribute('data-a');
		paint(it, p, a);
		var name = $('h3', it).textContent;
		var prompt = 'Apply the chosen site design (' + name + '). Read it with the design tool, add the base styles, build the header and footer, then build the home page as a draft proof and show it to me before you build any other pages.';
		box.hidden = false;
		box.innerHTML = '<div><b>Your design: ' + name.replace(/</g, '&lt;') + '</b><br><small>' + (sel.applied ? 'Applied to the site.' : 'Not applied yet: open the assistant to build it.') + '</small></div>' +
			'<label>Main colour <input type="color" id="cwd-p" value="' + p.toLowerCase() + '"></label>' +
			'<label>Accent colour <input type="color" id="cwd-a" value="' + a.toLowerCase() + '"></label>' +
			'<button class="button" id="cwd-save">Save colours</button><button class="button-link" id="cwd-reset">Reset to the design\'s colours</button>' +
			'<a class="button button-primary" href="' + D.chat + '&cwai_prompt=' + encodeURIComponent(prompt) + '">Open the assistant to apply it</a>' +
			'<button class="button-link-delete" id="cwd-clear">Remove</button>';
		$('#cwd-p').addEventListener('input', function (e) { paint(it, e.target.value.toUpperCase(), $('#cwd-a').value.toUpperCase()); });
		$('#cwd-a').addEventListener('input', function (e) { paint(it, $('#cwd-p').value.toUpperCase(), e.target.value.toUpperCase()); });
		$('#cwd-save').addEventListener('click', function () {
			api({ id: sel.id, primary: $('#cwd-p').value, accent: $('#cwd-a').value }).then(function (r) { sel = r.selected; this_msg('Saved.'); render(); }).catch(function (e) { alert(e.message); });
		});
		$('#cwd-reset').addEventListener('click', function () {
			api({ id: sel.id }).then(function (r) { sel = r.selected; paint(it, it.getAttribute('data-p'), it.getAttribute('data-a')); render(); });
		});
		$('#cwd-clear').addEventListener('click', function () {
			if (!confirm('Remove the chosen design? Pages already built stay as they are.')) return;
			api({ clear: 1 }).then(function () { paint(it, it.getAttribute('data-p'), it.getAttribute('data-a')); sel = null; render(); });
		});
	}
	function this_msg(t) { var s = $('#cwd-save'); if (s) { s.textContent = t; setTimeout(function () { var x = $('#cwd-save'); if (x) x.textContent = 'Save colours'; }, 1500); } }

	$$('.cwd-choose').forEach(function (b) {
		b.addEventListener('click', function () {
			var it = b.closest('.cwd-item'); var id = it.getAttribute('data-id');
			if (sel && sel.id !== id) { var old = item(sel.id); if (old) paint(old, old.getAttribute('data-p'), old.getAttribute('data-a')); }
			b.disabled = true;
			api({ id: id }).then(function (r) { sel = r.selected; b.disabled = false; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }).catch(function (e) { b.disabled = false; alert(e.message); });
		});
	});
	$$('.cwd-tabs button').forEach(function (b) {
		b.addEventListener('click', function () {
			$$('.cwd-tabs button').forEach(function (x) { x.classList.toggle('button-primary', x === b); });
			var f = b.getAttribute('data-fam');
			$$('.cwd-item').forEach(function (i) { i.style.display = !f || i.getAttribute('data-fam') === f ? '' : 'none'; });
		});
	});
	render();
})();
