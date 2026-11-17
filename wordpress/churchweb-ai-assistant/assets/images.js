(function () {
	var C = window.CWAI_IMG;
	if (!C) return;
	var body = document.getElementById('cwi-body');
	var S = C.status;
	function h(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
	function api(path, method, data) {
		var o = { method: method || 'GET', credentials: 'same-origin', headers: { 'X-WP-Nonce': C.nonce } };
		if (data) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(data); }
		return fetch(C.root.indexOf('?') > -1 ? C.root + path.replace('?', '&') : C.root + path, o).then(function (r) { return r.text().then(function (t) { var j; try { j = JSON.parse(t); } catch (e) { throw new Error('Unexpected reply (HTTP ' + r.status + ').'); } if (!r.ok) throw new Error(j.message || 'Error'); return j; }); });
	}
	function tab(t) {
		document.querySelectorAll('#cwi-tabs a').forEach(function (a) { a.classList.toggle('nav-tab-active', a.getAttribute('data-t') === t); });
		({ stock: stock, ai: ai, setup: setup })[t]();
	}

	function stock() {
		var noKey = !S.pexels && !S.pixabay;
		body.innerHTML = noKey ? '<div class="cwi-card"><p><b>Stock photos are not set up yet.</b></p><p>' + (C.isAdmin ? 'Add a free Pexels or Pixabay key on the <a href="#" id="cwi-go-setup">Setup</a> tab (takes two minutes).' : 'Ask an administrator to add a free Pexels or Pixabay key under Images → Setup.') + '</p></div>' :
			'<div class="cwi-bar"><input type="text" id="cwi-q" placeholder="e.g. sunrise over a quiet lake, open Bible, hands holding coffee"><select id="cwi-o"><option value="">Any shape</option><option value="landscape">Wide</option><option value="portrait">Tall</option><option value="square">Square</option></select><select id="cwi-s"><option value="any">All sources</option>' + (S.pexels ? '<option value="pexels">Pexels</option>' : '') + (S.pixabay ? '<option value="pixabay">Pixabay</option>' : '') + '</select><button class="button button-primary" id="cwi-go">Search</button></div><p class="description">Free to use, no credit needed (Pexels and Pixabay licences). Do not present a stock photo as your own people or building.</p><div id="cwi-msg" class="cwi-msg"></div><div id="cwi-res" class="cwi-grid"></div>';
		var g = document.getElementById('cwi-go-setup'); if (g) g.onclick = function (e) { e.preventDefault(); tab('setup'); };
		if (noKey) return;
		function run() {
			var q = document.getElementById('cwi-q').value.trim(); if (q.length < 2) return;
			var m = document.getElementById('cwi-msg'); m.className = 'cwi-msg'; m.textContent = 'Searching…';
			api('/images/search?q=' + encodeURIComponent(q) + '&orientation=' + document.getElementById('cwi-o').value + '&source=' + document.getElementById('cwi-s').value).then(function (r) {
				m.textContent = r.results.length ? '' : 'No photos found. Try different words.';
				var box = document.getElementById('cwi-res');
				box.innerHTML = r.results.map(function (p, i) { return '<div class="cwi-it"><img src="' + h(p.preview_url) + '" alt="' + h(p.description) + '" loading="lazy"><div>' + h(p.photographer) + ' · ' + h(p.source) + (p.width ? ' · ' + p.width + '×' + p.height : '') + '</div><button class="button" data-i="' + i + '">Add to Media Library</button></div>'; }).join('');
				box.querySelectorAll('button').forEach(function (b) { b.onclick = function () {
					var p = r.results[+b.getAttribute('data-i')]; b.disabled = true; b.textContent = 'Adding…';
					api('/images/import', 'POST', { source: p.source, import_url: p.import_url, id: p.id, photographer: p.photographer, page_url: p.page_url, title: p.description, alt: p.description }).then(function (im) { b.textContent = 'Added ✓'; b.insertAdjacentHTML('afterend', '<div><a href="' + h(im.url) + '" target="_blank" rel="noopener">View</a> · media #' + im.id + '</div>'); }).catch(function (e) { b.disabled = false; b.textContent = 'Add to Media Library'; m.className = 'cwi-msg cwi-err'; m.textContent = e.message; });
				}; });
			}).catch(function (e) { m.className = 'cwi-msg cwi-err'; m.textContent = e.message; });
		}
		document.getElementById('cwi-go').onclick = run;
		document.getElementById('cwi-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); run(); } });
	}

	function ai() {
		if (!S.ai_ready) {
			body.innerHTML = '<div class="cwi-card"><p><b>AI images are not switched on yet.</b></p><p>' + (C.isAdmin ? 'Choose a provider on the <a href="#" id="cwi-go-setup">Setup</a> tab.' : 'Ask an administrator to switch them on under Images → Setup.') + '</p></div>';
			var g = document.getElementById('cwi-go-setup'); if (g) g.onclick = function (e) { e.preventDefault(); tab('setup'); };
			return;
		}
		body.innerHTML = '<div class="cwi-card"><label for="cwi-p">Describe the image</label><textarea id="cwi-p" rows="4" placeholder="e.g. Soft morning light over a quiet village green, a stone church tower in the distance, calm and hopeful, muted blues and golds"></textarea><label for="cwi-a">Shape</label><select id="cwi-a"><option value="landscape">Wide (banners)</option><option value="square">Square</option><option value="portrait">Tall</option></select><label for="cwi-st">Style</label><select id="cwi-st"><option value="photo">Photo-like</option><option value="illustration">Illustration</option><option value="abstract">Abstract</option><option value="texture">Soft background</option></select><p class="description">Best for backgrounds, textures, illustrations and scenery. It cannot make a real photo of your people or building, and it avoids text and logos. ' + (S.daily_cap ? 'Used today: ' + S.used_today + ' of ' + S.daily_cap + '.' : '') + '</p><p><button class="button button-primary" id="cwi-gen">Create image</button> <span id="cwi-msg" class="cwi-msg"></span></p><div id="cwi-out" class="cwi-res"></div></div>';
		document.getElementById('cwi-gen').onclick = function () {
			var b = this, m = document.getElementById('cwi-msg'), prompt = document.getElementById('cwi-p').value.trim();
			if (prompt.length < 5) { m.className = 'cwi-msg cwi-err'; m.textContent = 'Describe the image first.'; return; }
			b.disabled = true; m.className = 'cwi-msg'; m.textContent = 'Creating… this takes up to 30 seconds.';
			api('/images/generate', 'POST', { prompt: prompt, aspect: document.getElementById('cwi-a').value, style: document.getElementById('cwi-st').value, alt: prompt.slice(0, 120) }).then(function (r) {
				b.disabled = false; m.className = 'cwi-msg cwi-ok'; m.textContent = 'Added to the Media Library (AI-generated).'; S.used_today++;
				document.getElementById('cwi-out').innerHTML = '<img src="' + h(r.thumb || r.url) + '" alt=""><p><a href="' + h(r.url) + '" target="_blank" rel="noopener">Open full size</a> · media #' + r.id + '</p>';
			}).catch(function (e) { b.disabled = false; m.className = 'cwi-msg cwi-err'; m.textContent = e.message; });
		};
	}

	function setup() {
		var gw = S.gateway_ok;
		body.innerHTML = '<div class="cwi-card"><h2 style="margin-top:0">Free stock photos</h2><p class="description">Both are free. Get a key in about two minutes: <a href="https://www.pexels.com/api/" target="_blank" rel="noopener">pexels.com/api</a> and <a href="https://pixabay.com/api/docs/" target="_blank" rel="noopener">pixabay.com/api/docs</a>. One is enough.</p><label>Pexels key ' + (S.pexels ? '<span class="cwi-ok">saved ' + h(S.pexels_mask) + '</span>' : '') + '</label><input type="password" id="k-pexels" autocomplete="off" placeholder="' + (S.pexels ? 'Leave empty to keep the saved key' : 'Paste key') + '"><label>Pixabay key ' + (S.pixabay ? '<span class="cwi-ok">saved ' + h(S.pixabay_mask) + '</span>' : '') + '</label><input type="password" id="k-pixabay" autocomplete="off" placeholder="' + (S.pixabay ? 'Leave empty to keep the saved key' : 'Paste key') + '"></div>' +
			'<div class="cwi-card"><h2 style="margin-top:0">AI image generation</h2>' +
			'<label class="cwi-prov ' + (S.ai_provider === 'off' ? 'on' : '') + '"><input type="radio" name="prov" value="off"' + (S.ai_provider === 'off' ? ' checked' : '') + '> <b>Off</b></label>' +
			'<label class="cwi-prov ' + (S.ai_provider === 'gateway' ? 'on' : '') + (gw ? '' : ' off') + '"><input type="radio" name="prov" value="gateway"' + (S.ai_provider === 'gateway' ? ' checked' : '') + (gw ? '' : ' disabled') + '> <b>Through the ChurchWeb gateway (cheapest)</b><br><span class="description">FLUX.1 schnell on Cloudflare. A fraction of a cent per image and a free daily allowance, no extra account. ' + (gw ? '' : 'Needs the site to use the gateway (see Settings → API address).') + '</span></label>' +
			'<label class="cwi-prov ' + (S.ai_provider === 'openai' ? 'on' : '') + '"><input type="radio" name="prov" value="openai"' + (S.ai_provider === 'openai' ? ' checked' : '') + '> <b>OpenAI (own key)</b><br><span class="description">Better at fine detail. About half a cent to a few cents per image depending on quality.</span></label>' +
			'<div id="cwi-openai" style="margin-left:24px"><label>OpenAI key ' + (S.openai_mask ? '<span class="cwi-ok">saved ' + h(S.openai_mask) + '</span>' : '') + '</label><input type="password" id="k-openai" autocomplete="off" placeholder="' + (S.openai_mask ? 'Leave empty to keep the saved key' : 'sk-...') + '"><label>Model</label><input type="text" id="m-openai" value="' + h(S.openai_model) + '"><label>Quality</label><select id="q-openai">' + ['low', 'medium', 'high'].map(function (q) { return '<option' + (S.openai_quality === q ? ' selected' : '') + '>' + q + '</option>'; }).join('') + '</select></div>' +
			'<label>Daily limit (AI images per day for this site; 0 = no limit)</label><input type="text" id="cap" value="' + h(S.daily_cap) + '" style="max-width:100px"></div>' +
			'<p><button class="button button-primary" id="cwi-save">Save</button> <span id="cwi-msg" class="cwi-msg"></span></p>';
		var show = function () { document.getElementById('cwi-openai').style.display = document.querySelector('input[name=prov]:checked').value === 'openai' ? '' : 'none'; };
		document.querySelectorAll('input[name=prov]').forEach(function (r) { r.onchange = show; }); show();
		document.getElementById('cwi-save').onclick = function () {
			var m = document.getElementById('cwi-msg');
			api('/images/settings', 'POST', { pexels: document.getElementById('k-pexels').value, pixabay: document.getElementById('k-pixabay').value, openai: document.getElementById('k-openai').value, ai_provider: document.querySelector('input[name=prov]:checked').value, openai_model: document.getElementById('m-openai').value, openai_quality: document.getElementById('q-openai').value, daily_cap: document.getElementById('cap').value }).then(function (st) { S = st; m.className = 'cwi-msg cwi-ok'; m.textContent = 'Saved.'; setup(); document.getElementById('cwi-msg').className = 'cwi-msg cwi-ok'; document.getElementById('cwi-msg').textContent = 'Saved.'; }).catch(function (e) { m.className = 'cwi-msg cwi-err'; m.textContent = e.message; });
		};
	}
	document.getElementById('cwi-tabs').addEventListener('click', function (e) { var a = e.target.closest('a[data-t]'); if (!a) return; e.preventDefault(); tab(a.getAttribute('data-t')); });
	tab('stock');
})();
