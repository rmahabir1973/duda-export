(function () {
	var C = window.CWAI_I;
	if (!C) return;
	var $ = function (id) { return document.getElementById(id); };
	function api(path, opts) {
		opts = opts || {};
		opts.headers = Object.assign({ 'X-WP-Nonce': C.nonce }, opts.headers || {});
		opts.credentials = 'same-origin';
		return fetch(C.root + path, opts).then(function (r) {
			return r.text().then(function (t) {
				var j; try { j = JSON.parse(t); } catch (e) { throw new Error('Unexpected server reply (HTTP ' + r.status + ').'); }
				if (!r.ok) throw new Error(j.message || ('HTTP ' + r.status));
				return j;
			});
		});
	}
	function bar(id, pct) { var b = $(id); if (b && b.firstChild) b.firstChild.style.width = Math.max(0, Math.min(100, pct)) + '%'; }
	function rid() { var a = new Uint8Array(8); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }

	function render(st) {
		var box = $('cwai-loaded');
		if (!st || !st.loaded) { box.style.display = 'none'; return; }
		box.style.display = '';
		$('cwai-sum').textContent = (st.site || 'Old site') + (st.exported ? ' (exported ' + st.exported + ')' : '') + ': ' + st.pages + ' pages, ' + st.posts + ' blog posts, ' + st.media_total + ' images and documents.';
		var done = st.media_done + Object.keys(st.media_failed || {}).length;
		bar('cwai-m-bar', st.media_total ? (done / st.media_total) * 100 : 100);
		$('cwai-m-msg').textContent = st.media_done + ' of ' + st.media_total + ' in the Media Library' + (done >= st.media_total ? ' — finished.' : '.');
		$('cwai-m-go').style.display = done >= st.media_total ? 'none' : '';
		var f = Object.keys(st.media_failed || {});
		$('cwai-m-fail').innerHTML = f.length ? '<p><b>Could not import ' + f.length + ':</b></p><ul style="list-style:disc;margin-left:20px">' + f.slice(0, 20).map(function (k) { return '<li>' + k.replace(/</g, '&lt;') + ' — ' + String(st.media_failed[k]).replace(/</g, '&lt;') + '</li>'; }).join('') + '</ul>' : '';
		var p = st.progress || {};
		$('cwai-prog').textContent = 'Migration progress: ' + (p.migrated || 0) + ' built, ' + (p.skipped || 0) + ' skipped, ' + (p.needs_review || 0) + ' need review, ' + (p.pending || 0) + ' waiting.';
	}

	var running = false;
	function mediaLoop() {
		if (running) return;
		running = true;
		$('cwai-m-go').disabled = true;
		(function step(fails) {
			api('/import/media', { method: 'POST' }).then(function (st) {
				render(st);
				var done = st.media_done + Object.keys(st.media_failed || {}).length;
				if (done < st.media_total) return step(0);
				running = false; $('cwai-m-go').disabled = false;
			}).catch(function (e) {
				if (fails < 3) return setTimeout(function () { step(fails + 1); }, 1500);
				running = false; $('cwai-m-go').disabled = false;
				$('cwai-m-msg').textContent = 'Stopped: ' + e.message + ' Press the button to continue.';
			});
		})(0);
	}

	function upload(file) {
		var id = rid(), size = C.chunk, total = Math.max(1, Math.ceil(file.size / size));
		$('cwai-up-bar').style.display = ''; bar('cwai-up-bar', 0);
		$('cwai-zip-go').disabled = true;
		function send(i, tries) {
			var fd = new FormData();
			fd.append('upload_id', id); fd.append('index', i); fd.append('total', total);
			fd.append('chunk', file.slice(i * size, (i + 1) * size), 'chunk');
			return api('/import/chunk', { method: 'POST', body: fd }).catch(function (e) {
				if (tries < 3) return new Promise(function (r) { setTimeout(r, 1500); }).then(function () { return send(i, tries + 1); });
				throw e;
			});
		}
		var p = Promise.resolve();
		for (var i = 0; i < total; i++) (function (i) {
			p = p.then(function () {
				$('cwai-up-msg').textContent = 'Uploading… ' + (i + 1) + ' of ' + total;
				bar('cwai-up-bar', (i / total) * 100);
				return send(i, 0);
			});
		})(i);
		p.then(function () {
			bar('cwai-up-bar', 100);
			$('cwai-up-msg').textContent = 'Reading the package…';
			var fd = new FormData(); fd.append('upload_id', id); fd.append('total', total);
			return api('/import/finish', { method: 'POST', body: fd });
		}).then(function () {
			$('cwai-up-msg').textContent = 'Done. Opening the import…';
			location.href = location.pathname + '?page=cwai-import&auto=1';
		}).catch(function (e) {
			$('cwai-zip-go').disabled = false;
			$('cwai-up-msg').textContent = 'Upload failed: ' + e.message;
		});
	}

	$('cwai-zip-go').addEventListener('click', function () {
		var f = $('cwai-zip').files[0];
		if (!f) { $('cwai-up-msg').textContent = 'Choose the ZIP file first.'; return; }
		if (!/\.zip$/i.test(f.name)) { $('cwai-up-msg').textContent = 'That is not a .zip file.'; return; }
		if ($('cwai-loaded').style.display !== 'none' && !confirm('This replaces the import that is already loaded (images already in the Media Library stay). Continue?')) return;
		upload(f);
	});
	$('cwai-m-go').addEventListener('click', mediaLoop);
	$('cwai-reset').addEventListener('click', function () {
		if (!confirm('Remove the imported package from this site? Images and documents already in the Media Library stay.')) return;
		api('/import/reset', { method: 'POST' }).then(function () { location.reload(); }).catch(function (e) { alert(e.message); });
	});

	render(C.status);
	var s = C.status;
	if (s && s.loaded && (s.media_done + Object.keys(s.media_failed || {}).length) < s.media_total && new URLSearchParams(location.search).get('auto') === '1') mediaLoop();
})();
