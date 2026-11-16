const $ = (id) => document.getElementById(id), H = { 'X-Requested-With': 'duda-export' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let files = [], types = [], maxMb = 25, maxFiles = 10;
const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
const extOf = (n) => n.toLowerCase().split('.').pop();
function render() {
	$('list').innerHTML = files.map((f, i) => `<li><span>${esc(f.name)}</span> <span class="hint">${kb(f.size)}${!types.includes(extOf(f.name)) ? ' · <b class="exp-past">not a type we can convert</b>' : f.size > maxMb * 1048576 ? ' · <b class="exp-past">over ' + maxMb + ' MB</b>' : ''}</span> <button class="sm" data-i="${i}" type="button" title="Remove">✕</button></li>`).join('');
	$('go').disabled = !files.length || files.some((f) => !types.includes(extOf(f.name)) || f.size > maxMb * 1048576);
	$('go').textContent = files.length > 1 ? ($('merge').checked ? 'Convert and merge' : `Convert ${files.length} files`) : 'Convert';
}
function add(list) { for (const f of list) { if (files.length >= maxFiles) { $('err').textContent = `At most ${maxFiles} files at a time.`; break; } if (!files.some((x) => x.name === f.name && x.size === f.size)) files.push(f); } render(); }
fetch('/api/convert/status', { headers: H }).then((r) => r.json()).then((s) => {
	types = s.types || []; maxMb = s.maxFileMb || 25; maxFiles = s.maxFiles || 10;
	$('types').textContent = types.map((t) => '.' + t).join('  ') + ` · up to ${maxMb} MB each, ${maxFiles} at a time`;
	if (!s.ok) $('banner').innerHTML = `<p class="err">The converter is not reachable right now${s.error ? ': ' + esc(s.error) : ''}. Conversions will fail until it is.</p>`;
}).catch(() => {});
$('drop').onclick = () => $('file').click(); $('drop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') $('file').click(); };
$('file').onchange = () => { add([...$('file').files]); $('file').value = ''; };
['dragenter', 'dragover'].forEach((ev) => $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('over'); }));
$('drop').addEventListener('drop', (e) => add([...e.dataTransfer.files]));
$('list').onclick = (e) => { const b = e.target.closest('button[data-i]'); if (b) { files.splice(+b.dataset.i, 1); render(); } };
$('merge').onchange = render; $('clear').onclick = () => { files = []; render(); $('err').textContent = ''; $('msg').textContent = ''; };
$('go').onclick = async () => {
	$('err').textContent = ''; $('msg').textContent = 'Converting…'; $('go').disabled = true;
	const fd = new FormData(); files.forEach((f) => fd.append('file', f, f.name)); if ($('merge').checked) fd.append('merge', '1'); if ($('landscape').checked) fd.append('landscape', '1');
	try {
		const r = await fetch('/api/convert/pdf', { method: 'POST', headers: H, body: fd });
		if (r.status === 401) return location.reload();
		if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'Conversion failed.'); }
		const blob = await r.blob(), cd = r.headers.get('content-disposition') || '', m = /filename\*=UTF-8''([^;]+)/.exec(cd) || /filename="([^"]+)"/.exec(cd), name = m ? decodeURIComponent(m[1]) : (blob.type.includes('zip') ? 'converted-pdfs.zip' : 'document.pdf');
		const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
		$('msg').textContent = `Done: ${name} (${kb(blob.size)}).`;
	} catch (e) { $('err').textContent = e.message; $('msg').textContent = ''; }
	finally { render(); }
};
