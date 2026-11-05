// Turns an uploaded Word, PDF, spreadsheet, OpenDocument, RTF, text or HTML file into plain text for the AI's brief.
// Pure JavaScript (fflate + unpdf), nothing to install on the server. Never throws: an unreadable file comes back with readable:false and a plain reason.
import { unzipSync, strFromU8 } from 'fflate';

export const MAX_TEXT = 40000; // kept per document; the brief itself decides how much of it to show

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unent = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
	if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return ' '; } }
	return ENT[e.toLowerCase()] ?? m;
});
const tidy = (s) => String(s).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Open a zip safely: skip anything big, so a zip bomb cannot eat the server's memory. */
function open(buf, want) {
	return unzipSync(new Uint8Array(buf), { filter: (f) => f.originalSize <= 30 * 1048576 && want(f.name) });
}
const text = (files, name) => (files[name] ? strFromU8(files[name]) : '');

function docx(buf) {
	const f = open(buf, (n) => /^word\/(document|footnotes|endnotes)\.xml$/.test(n));
	const xml = text(f, 'word/document.xml');
	if (!xml) throw new Error('This does not look like a Word (.docx) file.');
	const out = xml
		.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n')
		.replace(/<\/w:p>\s*<\/w:tc>/g, ' | ').replace(/<\/w:tc>/g, ' | ').replace(/<\/w:tr>/g, '\n').replace(/<\/w:p>/g, '\n')
		.replace(/<[^>]+>/g, '');
	return unent(out).replace(/ \| *\n/g, '\n');
}

function colIndex(ref) { let n = 0; for (const ch of String(ref).replace(/[^A-Z]/gi, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
function xlsx(buf) {
	const f = open(buf, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(n));
	const wb = text(f, 'xl/workbook.xml');
	if (!wb) throw new Error('This does not look like an Excel (.xlsx) file.');
	const shared = [...text(f, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unent([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
	const rels = {};
	for (const m of text(f, 'xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
		const id = /Id="([^"]+)"/.exec(m[0])?.[1], target = /Target="([^"]+)"/.exec(m[0])?.[1];
		if (id && target) rels[id] = target.replace(/^\/?(xl\/)?/, 'xl/');
	}
	const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: unent(/name="([^"]*)"/.exec(m[0])?.[1] || 'Sheet'), file: rels[/r:id="([^"]+)"/.exec(m[0])?.[1]] }));
	const parts = [];
	let rowsLeft = 800;
	for (const s of sheets) {
		const xml = s.file ? text(f, s.file) : '';
		if (!xml) continue;
		const lines = [];
		for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
			if (rowsLeft-- <= 0) break;
			const cells = [];
			for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
				const at = c[1], body = c[2] || '', ref = /r="([^"]+)"/.exec(at)?.[1], t = /t="([^"]+)"/.exec(at)?.[1];
				let v = '';
				if (t === 's') v = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1])] ?? '';
				else if (t === 'inlineStr') v = unent([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
				else v = unent(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] || '');
				if (ref != null) cells[colIndex(ref)] = v;
			}
			const line = Array.from(cells, (x) => x ?? '').join(' | ').replace(/(\s*\|\s*)+$/, '').trim();
			if (line) lines.push(line);
		}
		if (lines.length) parts.push(`## Sheet: ${s.name}\n${lines.join('\n')}`);
	}
	return parts.join('\n\n');
}

function odf(buf) {
	const f = open(buf, (n) => n === 'content.xml');
	const xml = text(f, 'content.xml');
	if (!xml) throw new Error('This does not look like an OpenDocument file.');
	return unent(xml
		.replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<text:s\b[^>]*\/>/g, ' ')
		.replace(/<\/table:table-cell>/g, ' | ').replace(/<\/table:table-row>/g, '\n').replace(/<\/text:(p|h)>/g, '\n')
		.replace(/<[^>]+>/g, ''));
}

function rtf(buf) {
	return buf.toString('latin1')
		.replace(/\\par[d]?/g, '\n').replace(/\\tab/g, '\t')
		.replace(/\\'([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/\{\\\*[^{}]*\}/g, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
}

async function pdf(buf) {
	const { extractText, getDocumentProxy } = await import('unpdf');
	const doc = await getDocumentProxy(new Uint8Array(buf));
	const { text: t } = await extractText(doc, { mergePages: true });
	return Array.isArray(t) ? t.join('\n') : t;
}

const html = (b) => unent(b.toString('utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<\/(p|div|h\d|li|tr|br)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '));

/** @returns {Promise<{text:string, readable:boolean, note:string, truncated?:boolean}>} */
export async function extractDocument(name, buf) {
	const ext = (/\.([a-z0-9]+)$/i.exec(String(name))?.[1] || '').toLowerCase();
	try {
		let raw;
		if (ext === 'docx') raw = docx(buf);
		else if (ext === 'xlsx') raw = xlsx(buf);
		else if (ext === 'odt' || ext === 'ods') raw = odf(buf);
		else if (ext === 'pdf') raw = await pdf(buf);
		else if (ext === 'rtf') raw = rtf(buf);
		else if (ext === 'html' || ext === 'htm') raw = html(buf);
		else if (ext === 'txt' || ext === 'md' || ext === 'csv') raw = buf.toString('utf8');
		else if (ext === 'doc' || ext === 'xls') return { text: '', readable: false, note: `Old ${ext === 'doc' ? 'Word' : 'Excel'} files (.${ext}) can't be read. Open it and save it as .${ext}x, then upload it again.` };
		else return { text: '', readable: false, note: 'This file type can\'t be read.' };
		const t = tidy(raw);
		if (!t) return { text: '', readable: false, note: ext === 'pdf' ? 'No text found. It may be a scanned PDF (pictures of pages). Upload the original document or paste the key facts into the notes.' : 'No text found in this file.' };
		return { text: t.slice(0, MAX_TEXT), readable: true, truncated: t.length > MAX_TEXT, note: `${t.length.toLocaleString('en-US')} characters read` };
	} catch (e) {
		return { text: '', readable: false, note: /password|encrypt/i.test(e.message) ? 'This file is password protected.' : `Could not read this file (${String(e.message).slice(0, 80)}).` };
	}
}
