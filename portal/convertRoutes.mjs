import express from 'express';
import archiver from 'archiver';
import { MAX_FILE_BYTES, MAX_FILES, CONVERTIBLE, isConvertible } from './convert.mjs';

/** Read a multipart upload with Node's own parser. Returns [{ name, bytes }] plus the plain fields. */
async function readUpload(req) {
	const ct = req.headers['content-type'] || '';
	if (!/multipart\/form-data/i.test(ct)) throw Object.assign(new Error('Send the file(s) as multipart/form-data in a field called "file".'), { status: 415 });
	const len = Number(req.headers['content-length'] || 0);
	if (len > (MAX_FILE_BYTES * MAX_FILES) + 1024 * 1024) throw Object.assign(new Error('The upload is too large.'), { status: 413 });
	const chunks = []; let total = 0;
	for await (const c of req) { total += c.length; if (total > (MAX_FILE_BYTES * MAX_FILES) + 1024 * 1024) throw Object.assign(new Error('The upload is too large.'), { status: 413 }); chunks.push(c); }
	const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': ct } }).formData();
	const files = [], fields = {};
	for (const [k, v] of form.entries()) {
		if (typeof v === 'string') { fields[k] = v; continue; }
		if (!/^files?(\[\])?$/.test(k) && k !== 'document') continue;
		files.push({ name: v.name || 'document', bytes: Buffer.from(await v.arrayBuffer()) });
	}
	return { files, fields };
}
const sendPdf = (res, name, bytes) => { res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`); res.setHeader('Content-Length', bytes.length); res.end(bytes); };
const sendZip = (res, name, pdfs) => { res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); const z = archiver('zip', { zlib: { level: 6 } }); z.pipe(res); for (const p of pdfs) z.append(p.bytes, { name: p.name }); return z.finalize(); };
const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

/**
 * Two front doors to the same converter:
 *  - /api/convert/*     for signed-in portal users (the Convert page)
 *  - /api/v1/convert/*  for church sites: `Authorization: Bearer <that site's gateway token>`, the same token the AI Assistant plugin already holds.
 * Both accept multipart with one or more "file" fields; one file returns a PDF, several return a ZIP of PDFs, ?merge=1 returns one combined PDF.
 */
export function convertRouter({ need, converter, audit = null }) {
	const r = express.Router();
	r.use(need);
	r.get('/status', async (req, res) => res.json({ ...(await converter.health()), types: CONVERTIBLE, maxFileMb: MAX_FILE_BYTES / 1024 / 1024, maxFiles: MAX_FILES }));
	r.post('/pdf', async (req, res) => {
		try {
			const { files, fields } = await readUpload(req);
			const out = await converter.toPdf(files, { merge: bool(fields.merge ?? req.query.merge), landscape: bool(fields.landscape ?? req.query.landscape) });
			await audit?.write({ user: req.user, action: 'convert.pdf', target: files.map((f) => f.name).join(', ').slice(0, 200), status: 200, detail: { files: files.length, bytesIn: files.reduce((n, f) => n + f.bytes.length, 0), merged: out.length === 1 && files.length > 1 }, ip: req.ip || '' });
			return out.length === 1 ? sendPdf(res, out[0].name, out[0].bytes) : sendZip(res, 'converted-pdfs.zip', out);
		} catch (e) { res.status(e.status || 400).json({ error: e.message }); }
	});
	return r;
}

/** Site-facing: the Bearer token is a church's gateway token; checked against the gateway and remembered for ten minutes. */
export function siteConvertRouter({ converter, gateway, audit = null, now = () => Date.now() }) {
	const r = express.Router();
	const okTokens = new Map(), bad = new Map(), buckets = new Map(); // token → expiry, token → expiry, token → [timestamps]
	const PER_HOUR = 120;
	r.use(async (req, res, next) => {
		const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
		if (!token || !/^cwai_[\w-]{8,}/.test(token)) return res.status(401).json({ error: 'Send the site\'s gateway token as "Authorization: Bearer …".' });
		const t = now();
		if (bad.get(token) > t) return res.status(401).json({ error: 'This site\'s token is not accepted by the gateway.' });
		if (!(okTokens.get(token) > t)) {
			let ok = false; try { ok = gateway?.available() ? await gateway.tokenWorks(token) : false; } catch { ok = false; }
			if (!ok) { bad.set(token, t + 60000); return res.status(401).json({ error: 'This site\'s token is not accepted by the gateway.' }); }
			okTokens.set(token, t + 10 * 60000);
		}
		const hits = (buckets.get(token) || []).filter((x) => x > t - 3600000); if (hits.length >= PER_HOUR) return res.status(429).json({ error: `Limit of ${PER_HOUR} conversions an hour reached for this site.` }); hits.push(t); buckets.set(token, hits);
		req.siteToken = token.slice(0, 12) + '…';
		next();
	});
	r.get('/status', async (req, res) => res.json({ ok: (await converter.health()).ok, types: CONVERTIBLE, maxFileMb: MAX_FILE_BYTES / 1024 / 1024, maxFiles: MAX_FILES }));
	r.post('/pdf', async (req, res) => {
		try {
			const { files, fields } = await readUpload(req);
			if (files.some((f) => !isConvertible(f.name))) return res.status(415).json({ error: 'Only office documents can be converted: ' + CONVERTIBLE.join(', ') });
			const out = await converter.toPdf(files, { merge: bool(fields.merge ?? req.query.merge), landscape: bool(fields.landscape ?? req.query.landscape) });
			await audit?.write({ user: null, action: 'convert.pdf.site', target: req.siteToken, status: 200, detail: { files: files.map((f) => f.name).slice(0, 10), bytesIn: files.reduce((n, f) => n + f.bytes.length, 0) }, ip: req.ip || '' });
			return out.length === 1 ? sendPdf(res, out[0].name, out[0].bytes) : sendZip(res, 'converted-pdfs.zip', out);
		} catch (e) { res.status(e.status || 400).json({ error: e.message }); }
	});
	return r;
}
