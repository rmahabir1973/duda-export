// Document conversion (Word, Excel, PowerPoint, OpenDocument, RTF, HTML → PDF) through Gotenberg, a LibreOffice service that runs beside the
// portal on Railway's private network. Used by the Convert page, by the API the church-site AI Assistant plugin calls, and by anything else
// that has a file and needs a PDF. Nothing is stored: bytes in, bytes out.
const TYPES = {
	doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', dot: 'application/msword', dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
	odt: 'application/vnd.oasis.opendocument.text', rtf: 'application/rtf', txt: 'text/plain', html: 'text/html', htm: 'text/html',
	xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ods: 'application/vnd.oasis.opendocument.spreadsheet', csv: 'text/csv',
	ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odp: 'application/vnd.oasis.opendocument.presentation',
	pages: 'application/x-iwork-pages-sffpages', wpd: 'application/wordperfect', pdf: 'application/pdf',
};
export const CONVERTIBLE = Object.keys(TYPES).filter((e) => e !== 'pdf');
export const MAX_FILE_BYTES = 25 * 1024 * 1024, MAX_FILES = 10;
const ext = (name) => String(name || '').toLowerCase().split('.').pop();
export const isConvertible = (name) => CONVERTIBLE.includes(ext(name));
export const pdfName = (name) => String(name || 'document').replace(/\.[^.]+$/, '') .replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 120) + '.pdf';

export function createConverter({ url = '', fetchImpl = globalThis.fetch, timeout = 120000 } = {}) {
	const base = String(url || '').replace(/\/$/, '');
	const available = () => !!base;
	async function post(path, form, { accept = 'application/pdf' } = {}) {
		if (!available()) throw new Error('Document conversion is not set up on this server (CONVERT_URL).');
		const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
		let r;
		try { r = await fetchImpl(base + path, { method: 'POST', body: form, signal: ctl.signal }); }
		catch (e) { throw new Error(e.name === 'AbortError' ? 'The converter took too long (over 2 minutes). Try a smaller file.' : 'The converter could not be reached: ' + e.message); }
		finally { clearTimeout(t); }
		if (!r.ok) { const text = await r.text().catch(() => ''); throw new Error(`The converter refused the file (${r.status})${text ? ': ' + text.replace(/\s+/g, ' ').slice(0, 200) : ''}`); }
		const ct = r.headers.get('content-type') || '';
		if (accept && !ct.includes(accept)) throw new Error('The converter returned something other than a PDF (' + ct + ').');
		return Buffer.from(await r.arrayBuffer());
	}
	const self = {
		available, url: base,
		/** One or more office files → one PDF each, or one merged PDF when merge is set. files: [{ name, bytes }] in the order wanted. */
		async toPdf(files, { merge = false, landscape = false } = {}) {
			const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
			if (!list.length) throw new Error('No file to convert.');
			if (list.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files at a time.`);
			for (const f of list) {
				if (!isConvertible(f.name)) throw new Error(`"${f.name}" is not a type we can convert (${CONVERTIBLE.slice(0, 8).join(', ')}, …).`);
				if (!f.bytes || !f.bytes.length) throw new Error(`"${f.name}" is empty.`);
				if (f.bytes.length > MAX_FILE_BYTES) throw new Error(`"${f.name}" is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
			}
			const one = async (f) => {
				const form = new FormData();
				form.append('files', new Blob([f.bytes], { type: TYPES[ext(f.name)] || 'application/octet-stream' }), f.name);
				if (landscape) form.append('landscape', 'true');
				return post('/forms/libreoffice/convert', form);
			};
			if (merge && list.length > 1) {
				const form = new FormData();
				list.forEach((f, i) => form.append('files', new Blob([f.bytes], { type: TYPES[ext(f.name)] || 'application/octet-stream' }), `${String(i + 1).padStart(3, '0')}-${f.name}`)); // Gotenberg merges in filename order
				form.append('merge', 'true'); if (landscape) form.append('landscape', 'true');
				return [{ name: pdfName(list[0].name), bytes: await post('/forms/libreoffice/convert', form) }];
			}
			const out = [];
			for (const f of list) out.push({ name: pdfName(f.name), bytes: await one(f) });
			return out;
		},
		async health() {
			if (!available()) return { ok: false, error: 'CONVERT_URL is not set.' };
			try { const r = await fetchImpl(base + '/health', { signal: AbortSignal.timeout(8000) }); const j = await r.json().catch(() => ({})); return { ok: r.ok && j.status !== 'down', status: j.status || r.status, url: base }; }
			catch (e) { return { ok: false, error: e.message, url: base }; }
		},
	};
	return self;
}
