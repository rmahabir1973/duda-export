(function () {
	var W = window.CWAI_W;
	if (!W) return;
	var D = W.data;
	var body = document.getElementById('cww-body');
	var stepsEl = document.getElementById('cww-steps');
	var designGrid = document.querySelector('#cww-design-src #cwai-designs');
	var STEPS = ['About you', 'Design', 'Images', 'Pages', 'Review'];
	var step = D.step || 1;
	var saving = null;

	function h(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
	function api(path, method, data) {
		var o = { method: method || 'GET', credentials: 'same-origin', headers: { 'X-WP-Nonce': W.nonce } };
		if (data) { if (data instanceof FormData) o.body = data; else { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(data); } }
		return fetch(W.root + path, o).then(function (r) { return r.text().then(function (t) { var j; try { j = JSON.parse(t); } catch (e) { throw new Error('Unexpected reply from the server (HTTP ' + r.status + ').'); } if (!r.ok) throw new Error(j.message || 'Error'); return j; }); });
	}
	function save(toStep) {
		D.step = toStep || step;
		var payload = { type: D.type, name: D.name, tagline: D.tagline, kind: D.kind, about: D.about, tone: D.tone, address: D.address, city: D.city, phone: D.phone, email: D.email, times: D.times, extra: D.extra, social: D.social, design: D.design, images: D.images.map(function (i) { return { id: i.id, role: i.role, note: i.note }; }), image_stock: !!D.image_stock, image_ai: !!D.image_ai, pages: D.pages, custom_pages: D.custom_pages, step: D.step };
		return api('/wizard', 'POST', payload).then(function (r) { D.images = r.images; return r; });
	}
	function err(msg) { var e = document.getElementById('cww-err'); if (e) { e.textContent = msg || ''; if (msg) e.scrollIntoView({ block: 'nearest' }); } }

	function ensurePages() {
		var known = {}; (D.pages || []).forEach(function (p) { known[p.key] = p; });
		D.pages = W.pages.map(function (p) {
			var cur = known[p.key];
			return { key: p.key, label: p.label, include: cur ? cur.include : (p.req || p.types.indexOf(D.type) > -1), notes: cur ? cur.notes : '' };
		});
	}

	function renderSteps() {
		stepsEl.innerHTML = STEPS.map(function (s, i) { return '<li class="' + (i + 1 === step ? 'on' : (i + 1 < step ? 'done' : '')) + '" data-s="' + (i + 1) + '"><b>' + (i + 1) + '</b> ' + h(s) + '</li>'; }).join('');
	}
	function nav(next, label) {
		return '<p id="cww-err" class="cww-err" role="alert"></p><div class="cww-nav">' + (step > 1 ? '<button type="button" class="button" id="cww-back">Back</button>' : '') + '<button type="button" class="button button-primary button-hero" id="cww-next">' + (label || 'Next') + '</button><button type="button" class="button-link" id="cww-reset">Start over</button></div>';
	}
	function field(label, key, type, ph, hint) {
		return '<div class="cww-f"><label for="f-' + key + '">' + label + '</label>' + (type === 'area' ? '<textarea id="f-' + key + '" data-k="' + key + '" rows="4" placeholder="' + h(ph || '') + '">' + h(D[key]) + '</textarea>' : '<input id="f-' + key + '" data-k="' + key + '" type="' + (type || 'text') + '" value="' + h(D[key]) + '" placeholder="' + h(ph || '') + '">') + (hint ? '<small>' + hint + '</small>' : '') + '</div>';
	}

	function step1() {
		var T = W.types[D.type];
		body.innerHTML = '<div class="cww-card"><h2>About you</h2><div class="cww-types">' + Object.keys(W.types).map(function (k) { return '<label class="cww-type' + (D.type === k ? ' on' : '') + '"><input type="radio" name="type" value="' + k + '"' + (D.type === k ? ' checked' : '') + '> ' + h(W.types[k].label) + '</label>'; }).join('') + '</div>' +
			'<div class="cww-grid2">' + field(h(T.name) + ' *', 'name', 'text') + field('Tagline or motto (optional)', 'tagline', 'text', 'A short line under the name') + '</div>' +
			field(h(T.kind), 'kind', 'text') + field(h(T.about), 'about', 'area', 'A few sentences is plenty. The assistant writes the page copy from this.') +
			'<div class="cww-f"><label for="f-tone">Tone of voice</label><select id="f-tone" data-k="tone">' + [['warm', 'Warm and welcoming'], ['formal', 'Traditional and formal'], ['contemporary', 'Fresh and contemporary'], ['plain', 'Plain and direct']].map(function (o) { return '<option value="' + o[0] + '"' + (D.tone === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>' +
			'<h3>Where and how to reach you</h3><div class="cww-grid2">' + field('Street address', 'address') + field('City / region', 'city') + field('Phone', 'phone', 'tel') + field('Email', 'email', 'email') + '</div>' +
			field(h(T.times), 'times', 'area', 'One per line, e.g. Sunday 10:30 am Worship') +
			'<h3>Social links (optional)</h3><div class="cww-grid2">' + ['facebook', 'instagram', 'youtube', 'x'].map(function (k) { return '<div class="cww-f"><label for="s-' + k + '">' + k.charAt(0).toUpperCase() + k.slice(1) + '</label><input id="s-' + k + '" data-s="' + k + '" type="text" value="' + h(D.social[k]) + '" placeholder="https://"></div>'; }).join('') + '</div>' +
			field('Anything else the assistant should know (optional)', 'extra', 'area', 'Staff names, ministries, history, things to avoid saying...') + nav() + '</div>';
		body.querySelectorAll('[data-k]').forEach(function (el) { el.addEventListener('input', function () { D[el.getAttribute('data-k')] = el.value; }); });
		body.querySelectorAll('[data-s]').forEach(function (el) { el.addEventListener('input', function () { D.social[el.getAttribute('data-s')] = el.value; }); });
		body.querySelectorAll('input[name=type]').forEach(function (el) { el.addEventListener('change', function () { D.type = el.value; D.pages = []; step1(); }); });
	}

	function paint(item, p, a) {
		var el = item.querySelector('.cwd-p');
		function hex(c) { return [1, 3, 5].map(function (i) { return parseInt(c.substr(i, 2), 16); }); }
		function lum(c) { var x = hex(c).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2]; }
		function ct(a1, b1) { var l1 = lum(a1), l2 = lum(b1); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
		function on(bg) { return ct('#FFFFFF', bg) >= ct('#111111', bg) ? '#FFFFFF' : '#111111'; }
		function dk(c) { return '#' + hex(c).map(function (v) { return ('0' + Math.round(v * 0.78).toString(16)).slice(-2); }).join('').toUpperCase(); }
		el.style.setProperty('--p', p); el.style.setProperty('--pd', dk(p)); el.style.setProperty('--op', on(p)); el.style.setProperty('--a', a); el.style.setProperty('--oa', on(a));
		var bg = getComputedStyle(el).getPropertyValue('--bg').trim() || '#ffffff';
		el.style.setProperty('--l', /^#[0-9a-f]{6}$/i.test(bg) && ct(p, bg) >= 4.5 ? p : a);
	}
	function logoImg() { return (D.images || []).filter(function (i) { return i.role === 'logo'; })[0]; }
	function logoColours(url) {
		return new Promise(function (resolve, reject) {
			var img = new Image(); img.crossOrigin = 'anonymous';
			img.onload = function () {
				try {
					var w0 = img.naturalWidth || 200, h0 = img.naturalHeight || 100, k = Math.min(1, 120 / Math.max(w0, h0)), c = document.createElement('canvas');
					c.width = Math.max(8, Math.round(w0 * k)); c.height = Math.max(8, Math.round(h0 * k));
					var x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
					var d = x.getImageData(0, 0, c.width, c.height).data, bk = {};
					for (var i = 0; i < d.length; i += 4) {
						var r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3]; if (a < 128) continue;
						var mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mn > 232 || mx < 45 || mx - mn < 30) continue;
						var key = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4), e = bk[key] || (bk[key] = { n: 0, r: 0, g: 0, b: 0 }); e.n++; e.r += r; e.g += g; e.b += b;
					}
					var list = Object.keys(bk).map(function (k2) { return bk[k2]; }).sort(function (p, q) { return q.n - p.n; }).map(function (e) { return '#' + [e.r, e.g, e.b].map(function (v) { return ('0' + Math.round(v / e.n).toString(16)).slice(-2); }).join('').toUpperCase(); });
					var out = []; list.forEach(function (c1) { if (out.every(function (o) { var A = [1, 3, 5].map(function (i) { return parseInt(o.substr(i, 2), 16) - parseInt(c1.substr(i, 2), 16); }); return Math.hypot(A[0], A[1], A[2]) > 70; })) out.push(c1); });
					resolve(out.slice(0, 3));
				} catch (e) { reject(e); }
			};
			img.onerror = function () { reject(new Error('Could not read the logo.')); };
			img.src = url;
		});
	}
	function step2() {
		body.innerHTML = '<div class="cww-card"><h2>Choose a design</h2><p class="description">Pick the look you like. You can change the main and accent colours to match your logo.</p><div id="cww-choice" class="cwd-current"></div><div id="cww-grid-slot"></div>' + nav() + '</div>';
		var slot = document.getElementById('cww-grid-slot');
		designGrid.hidden = false; slot.appendChild(designGrid);
		function refresh() {
			designGrid.querySelectorAll('.cwd-item').forEach(function (it) {
				var sel = it.getAttribute('data-id') === D.design.id;
				it.classList.toggle('is-selected', sel);
				paint(it, sel && D.design.primary ? D.design.primary : it.getAttribute('data-p'), sel && D.design.accent ? D.design.accent : it.getAttribute('data-a'));
			});
			var box = document.getElementById('cww-choice');
			if (!D.design.id) { box.innerHTML = '<span>No design chosen yet.</span>'; return; }
			var it = designGrid.querySelector('.cwd-item[data-id="' + D.design.id + '"]');
			var p = D.design.primary || it.getAttribute('data-p'), a = D.design.accent || it.getAttribute('data-a');
			box.innerHTML = '<div><b>Your design: ' + h(it.querySelector('h3').textContent) + '</b></div><label>Main colour <input type="color" id="cww-p" value="' + p.toLowerCase() + '"></label><label>Accent colour <input type="color" id="cww-a" value="' + a.toLowerCase() + '"></label><button type="button" class="button" id="cww-lc"' + (logoImg() ? '' : ' disabled title="Upload a logo in the next step first, then come back"') + '>Use my logo colours</button><button type="button" class="button-link" id="cww-cr">Reset colours</button><span id="cww-lcm" class="description"></span>';
			function upd() { D.design.primary = document.getElementById('cww-p').value.toUpperCase(); D.design.accent = document.getElementById('cww-a').value.toUpperCase(); paint(it, D.design.primary, D.design.accent); }
			document.getElementById('cww-p').addEventListener('input', upd); document.getElementById('cww-a').addEventListener('input', upd);
			document.getElementById('cww-cr').addEventListener('click', function () { D.design.primary = ''; D.design.accent = ''; refresh(); });
			document.getElementById('cww-lc').addEventListener('click', function () {
				var lg = logoImg(); if (!lg) return;
				logoColours(lg.url).then(function (c) {
					if (!c.length) { document.getElementById('cww-lcm').textContent = 'No distinct colours found in the logo.'; return; }
					D.design.primary = c[0]; D.design.accent = c[1] || D.design.accent; refresh();
				}).catch(function (e) { document.getElementById('cww-lcm').textContent = e.message; });
			});
		}
		designGrid.querySelectorAll('.cww-pick').forEach(function (b) { b.onclick = function () { D.design = { id: b.closest('.cwd-item').getAttribute('data-id'), primary: '', accent: '' }; err(''); refresh(); window.scrollTo({ top: 0, behavior: 'smooth' }); }; });
		designGrid.querySelectorAll('.cwd-tabs button').forEach(function (b) { b.onclick = function () { designGrid.querySelectorAll('.cwd-tabs button').forEach(function (x) { x.classList.toggle('button-primary', x === b); }); var f = b.getAttribute('data-fam'); designGrid.querySelectorAll('.cwd-item').forEach(function (i) { i.style.display = !f || i.getAttribute('data-fam') === f ? '' : 'none'; }); }; });
		refresh();
	}

	function step3() {
		body.innerHTML = '<div class="cww-card"><h2>Images</h2><p class="description">Upload your logo and the photos the assistant may use: a wide photo for the top banner, your building, activities and community. Photos of identifiable people should only be uploaded if you have permission to publish them.</p><div class="cww-drop"><input type="file" id="cww-files" accept="image/*" multiple><span id="cww-up" class="description"></span></div><div class="cww-f"><label>If you do not have enough pictures</label><label style="font-weight:400"><input type="checkbox" id="cww-stock"' + (D.image_stock ? ' checked' : '') + '> Let the assistant add free stock photos (nature, objects, generic scenes)' + (W.images.pexels || W.images.pixabay ? '' : ' <span class="description">— not set up yet: Images → Setup</span>') + '</label><label style="font-weight:400"><input type="checkbox" id="cww-ai"' + (D.image_ai ? ' checked' : '') + '> Let the assistant create AI images for backgrounds and illustrations' + (W.images.ai_ready ? '' : ' <span class="description">— not switched on yet: Images → Setup</span>') + '</label><small>Stock and AI pictures are never used to stand in for your own people or building, and the assistant tells you which ones they are.</small></div><div id="cww-imgs" class="cww-imgs"></div>' + nav() + '</div>';
		function draw() {
			var box = document.getElementById('cww-imgs');
			box.innerHTML = D.images.map(function (im, i) { return '<div class="cww-img"><img src="' + h(im.url) + '" alt=""><select data-i="' + i + '">' + Object.keys(W.roles).map(function (r) { return '<option value="' + r + '"' + (im.role === r ? ' selected' : '') + '>' + h(W.roles[r]) + '</option>'; }).join('') + '</select><input type="text" data-n="' + i + '" value="' + h(im.note) + '" placeholder="What is it? (optional)"><button type="button" class="button-link-delete" data-x="' + i + '">Remove</button></div>'; }).join('') || '<p class="description">No images yet. You can also add them later.</p>';
			box.querySelectorAll('select').forEach(function (s) { s.onchange = function () { D.images[+s.getAttribute('data-i')].role = s.value; }; });
			box.querySelectorAll('input[data-n]').forEach(function (s) { s.oninput = function () { D.images[+s.getAttribute('data-n')].note = s.value; }; });
			box.querySelectorAll('[data-x]').forEach(function (s) { s.onclick = function () { D.images.splice(+s.getAttribute('data-x'), 1); draw(); }; });
		}
		draw();
		document.getElementById('cww-stock').onchange = function () { D.image_stock = this.checked; };
		document.getElementById('cww-ai').onchange = function () { D.image_ai = this.checked; };
		document.getElementById('cww-files').addEventListener('change', function (e) {
			var files = Array.prototype.slice.call(e.target.files), up = document.getElementById('cww-up'), i = 0;
			(function next() {
				if (i >= files.length) { up.textContent = files.length ? 'Done.' : ''; e.target.value = ''; return; }
				var f = files[i++]; up.textContent = 'Uploading ' + i + ' of ' + files.length + '…';
				if (f.size > 25 * 1048576) { up.textContent = f.name + ' is larger than 25 MB and was skipped.'; return next(); }
				var fd = new FormData(); fd.append('file', f);
				api('/upload', 'POST', fd).then(function (r) { D.images.push({ id: r.id, url: r.url, role: D.images.length === 0 && /logo/i.test(f.name) ? 'logo' : (/logo/i.test(f.name) ? 'logo' : 'other'), note: '' }); draw(); next(); }).catch(function (x) { up.textContent = f.name + ': ' + x.message; next(); });
			})();
		});
	}

	function step4() {
		ensurePages();
		var rows = W.pages.map(function (p) {
			var cur = D.pages.filter(function (x) { return x.key === p.key; })[0];
			var show = p.types.indexOf(D.type) > -1 || cur.include || ['about', 'contact', 'news', 'gallery', 'faq', 'privacy', 'events', 'team', 'give'].indexOf(p.key) > -1;
			if (!show) return '';
			return '<div class="cww-pg"><label><input type="checkbox" data-p="' + p.key + '"' + (cur.include ? ' checked' : '') + (p.req ? ' disabled' : '') + '> <b>' + h(p.label) + '</b> <span class="description">' + h(p.desc) + '</span></label><input type="text" class="cww-pn" data-pn="' + p.key + '" value="' + h(cur.notes) + '" placeholder="Anything specific for this page? (optional)"' + (cur.include ? '' : ' style="display:none"') + '></div>';
		}).join('');
		body.innerHTML = '<div class="cww-card"><h2>Pages</h2><p class="description">Tick the pages you want. The assistant builds them as drafts, in your design, and creates the menu.</p>' + rows + '<h3>Other pages</h3><div class="cww-f"><textarea id="cww-cp" rows="3" placeholder="One per line, e.g.\nBaptism and weddings\nRoom rentals: how to book the hall">' + h((D.custom_pages || []).map(function (c) { return c.label + (c.notes ? ': ' + c.notes : ''); }).join('\n')) + '</textarea><small>Optional. After a colon you can add what the page should say.</small></div>' + nav() + '</div>';
		body.querySelectorAll('input[data-p]').forEach(function (cb) {
			cb.onchange = function () { D.pages.filter(function (x) { return x.key === cb.getAttribute('data-p'); })[0].include = cb.checked; var n = body.querySelector('[data-pn="' + cb.getAttribute('data-p') + '"]'); if (n) n.style.display = cb.checked ? '' : 'none'; };
		});
		body.querySelectorAll('input[data-pn]').forEach(function (n) { n.oninput = function () { D.pages.filter(function (x) { return x.key === n.getAttribute('data-pn'); })[0].notes = n.value; }; });
		document.getElementById('cww-cp').oninput = function () { D.custom_pages = this.value.split('\n').map(function (l) { var m = l.trim().match(/^([^:]{1,80}):?\s*(.*)$/); return m && m[1].trim() ? { label: m[1].trim(), notes: m[2].trim() } : null; }).filter(Boolean); };
	}

	function step5() {
		var pages = D.pages.filter(function (p) { return p.include; }).map(function (p) { return p.label; }).concat((D.custom_pages || []).map(function (c) { return c.label; }));
		var it = designGrid.querySelector('.cwd-item[data-id="' + D.design.id + '"]');
		var dn = it ? it.querySelector('h3').textContent : '';
		var T = W.types[D.type];
		body.innerHTML = '<div class="cww-card"><h2>Review</h2><table class="cww-sum"><tr><th>' + h(T.label) + '</th><td><b>' + h(D.name) + '</b>' + (D.tagline ? ' · ' + h(D.tagline) : '') + '</td></tr><tr><th>Contact</th><td>' + h([D.address, D.city, D.phone, D.email].filter(Boolean).join(' · ') || 'Not given') + '</td></tr><tr><th>' + h(T.times) + '</th><td>' + h((D.times || 'Not given').split('\n').join(' · ')) + '</td></tr><tr><th>Design</th><td>' + h(dn || 'Not chosen') + (D.design.primary ? ' (custom colours ' + h(D.design.primary) + ' / ' + h(D.design.accent) + ')' : '') + '</td></tr><tr><th>Images</th><td>' + D.images.length + ' uploaded' + (logoImg() ? ' (logo included)' : ' (no logo)') + '</td></tr><tr><th>Pages (' + pages.length + ')</th><td>' + h(pages.join(', ')) + '</td></tr></table><p class="description">Pressing the button chooses your design, saves your details for the assistant and opens the chat. The assistant first builds the home page as a draft and asks you to look at it before building the rest. Nothing is published automatically.</p>' + nav(true, 'Build my website with the assistant') + '</div>';
	}

	function validate(s) {
		if (s === 1 && !String(D.name || '').trim()) return 'Please enter a name.';
		if (s === 2 && !D.design.id) return 'Please choose a design.';
		if (s === 4 && !D.pages.some(function (p) { return p.include; }) && !(D.custom_pages || []).length) return 'Please choose at least one page.';
		return '';
	}
	function go(n) {
		if (designGrid && designGrid.parentNode && n !== 2) { designGrid.hidden = true; document.getElementById('cww-design-src').appendChild(designGrid); }
		step = n; renderSteps(); [null, step1, step2, step3, step4, step5][n](); wire(); window.scrollTo({ top: 0 });
	}
	function wire() {
		var nx = document.getElementById('cww-next'), bk = document.getElementById('cww-back'), rs = document.getElementById('cww-reset');
		if (bk) bk.onclick = function () { save(step - 1); go(step - 1); };
		if (rs) rs.onclick = function () { if (confirm('Clear all wizard answers and start again? Uploaded images stay in the Media Library.')) api('/wizard/reset', 'POST').then(function () { location.reload(); }); };
		if (nx) nx.onclick = function () {
			var v = validate(step); if (v) { err(v); return; } err('');
			if (step < 5) { nx.disabled = true; save(step + 1).then(function () { nx.disabled = false; go(step + 1); }).catch(function (e) { nx.disabled = false; err(e.message); }); return; }
			nx.disabled = true; nx.textContent = 'Starting…';
			save().then(function () { return api('/wizard/start', 'POST', {}); }).then(function (r) { location.href = r.chat + '&cwai_prompt=' + encodeURIComponent(r.prompt); }).catch(function (e) { nx.disabled = false; nx.textContent = 'Build my website with the assistant'; err(e.message); });
		};
	}
	stepsEl.addEventListener('click', function (e) { var li = e.target.closest('li[data-s]'); if (!li) return; var n = +li.getAttribute('data-s'); if (n < step) { save(n); go(n); } });
	go(Math.min(step, 5) || 1);
})();
