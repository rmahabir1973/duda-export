import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createConverter, pdfName, isConvertible } from '../portal/convert.mjs';
import { convertRouter, siteConvertRouter } from '../portal/convertRoutes.mjs';

const PDF = Buffer.from('%PDF-1.7 fake');
/** A stand-in for Gotenberg: records what it was sent, returns a PDF. */
function fakeGotenberg() {
	const calls = [];
	const fetchImpl = async (url, { method, body } = {}) => {
		if (url.endsWith('/health')) return { ok: true, json: async () => ({ status: 'up' }) };
		const files = []; const fields = {};
		for (const [k, v] of body.entries()) { if (typeof v === 'string') fields[k] = v; else files.push({ field: k, name: v.name, type: v.type, size: v.size }); }
		calls.push({ url, method, files, fields });
		if (files.some((f) => /broken/.test(f.name))) return { ok: false, status: 400, text: async () => 'LibreOffice failed', headers: new Headers() };
		return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/pdf' }), arrayBuffer: async () => PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.length) };
	};
	return { calls, fetchImpl };
}

test('converter: posts office files to Gotenberg one by one, or merged in order; validates type, size and emptiness', async () => {
	const g = fakeGotenberg(), c = createConverter({ url: 'http://gotenberg.internal:3000/', fetchImpl: g.fetchImpl });
	assert.ok(c.available()); assert.equal(c.url, 'http://gotenberg.internal:3000');
	assert.ok(isConvertible('Bulletin.DOCX')); assert.ok(!isConvertible('photo.jpg')); assert.equal(pdfName('Sunday Bulletin: Nov/16.docx'), 'Sunday Bulletin- Nov-16.pdf');
	const out = await c.toPdf([{ name: 'a.docx', bytes: Buffer.from('x') }, { name: 'b.xlsx', bytes: Buffer.from('y') }]);
	assert.deepEqual(out.map((o) => o.name), ['a.pdf', 'b.pdf']); assert.equal(out[0].bytes.toString(), PDF.toString());
	assert.equal(g.calls.length, 2); assert.equal(g.calls[0].url, 'http://gotenberg.internal:3000/forms/libreoffice/convert'); assert.equal(g.calls[0].files[0].type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
	const merged = await c.toPdf([{ name: 'cover.docx', bytes: Buffer.from('x') }, { name: 'body.odt', bytes: Buffer.from('y') }], { merge: true, landscape: true });
	assert.equal(merged.length, 1); assert.equal(merged[0].name, 'cover.pdf');
	const m = g.calls.at(-1); assert.equal(m.fields.merge, 'true'); assert.equal(m.fields.landscape, 'true'); assert.deepEqual(m.files.map((f) => f.name), ['001-cover.docx', '002-body.odt'], 'merge order is pinned by filename');
	await assert.rejects(c.toPdf([{ name: 'photo.jpg', bytes: Buffer.from('x') }]), /not a type we can convert/);
	await assert.rejects(c.toPdf([{ name: 'empty.docx', bytes: Buffer.alloc(0) }]), /is empty/);
	await assert.rejects(c.toPdf([{ name: 'broken.docx', bytes: Buffer.from('x') }]), /refused the file \(400\): LibreOffice failed/);
	await assert.rejects(createConverter({}).toPdf([{ name: 'a.docx', bytes: Buffer.from('x') }]), /not set up/);
	assert.equal((await createConverter({}).health()).ok, false);
});

test('routes: signed-in upload returns a PDF (or a ZIP for several); site route needs a working gateway token and is rate-limited', async () => {
	const g = fakeGotenberg(), converter = createConverter({ url: 'http://g', fetchImpl: g.fetchImpl }), audits = [];
	const app = express();
	app.use('/api/convert', convertRouter({ need: (req, res, next) => { req.user = { id: 1, email: 'wayne@x.ca' }; next(); }, converter, audit: { write: async (a) => audits.push(a) } }));
	const gateway = { available: () => true, tokenWorks: async (t) => t === 'cwai_goodtoken_abc' };
	let t = 0; app.use('/api/v1/convert', siteConvertRouter({ converter, gateway, audit: { write: async (a) => audits.push(a) }, now: () => t }));
	const srv = app.listen(0), base = `http://127.0.0.1:${srv.address().port}`;
	try {
		const fd = new FormData(); fd.append('file', new Blob([Buffer.from('doc')]), 'Bulletin.docx');
		let r = await fetch(base + '/api/convert/pdf', { method: 'POST', body: fd });
		assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf'); assert.match(r.headers.get('content-disposition'), /Bulletin\.pdf/); assert.equal(Buffer.from(await r.arrayBuffer()).toString(), PDF.toString());
		assert.equal(audits.at(-1).action, 'convert.pdf'); assert.equal(audits.at(-1).user.email, 'wayne@x.ca');
		const two = new FormData(); two.append('file', new Blob([Buffer.from('a')]), 'a.docx'); two.append('file', new Blob([Buffer.from('b')]), 'b.docx');
		r = await fetch(base + '/api/convert/pdf', { method: 'POST', body: two }); assert.equal(r.headers.get('content-type'), 'application/zip');
		r = await fetch(base + '/api/convert/pdf?merge=1', { method: 'POST', body: two }); assert.equal(r.headers.get('content-type'), 'application/pdf');
		r = await fetch(base + '/api/convert/pdf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(r.status, 415);
		const bad = new FormData(); bad.append('file', new Blob([Buffer.from('x')]), 'photo.jpg');
		r = await fetch(base + '/api/convert/pdf', { method: 'POST', body: bad }); assert.equal(r.status, 400); assert.match((await r.json()).error, /not a type/);
		const st = await (await fetch(base + '/api/convert/status')).json(); assert.equal(st.ok, true); assert.ok(st.types.includes('docx'));
		// site route
		const one = () => { const f = new FormData(); f.append('file', new Blob([Buffer.from('doc')]), 'Bulletin.docx'); return f; };
		r = await fetch(base + '/api/v1/convert/pdf', { method: 'POST', body: one() }); assert.equal(r.status, 401);
		r = await fetch(base + '/api/v1/convert/pdf', { method: 'POST', headers: { authorization: 'Bearer cwai_badtoken_xyz' }, body: one() }); assert.equal(r.status, 401);
		r = await fetch(base + '/api/v1/convert/pdf', { method: 'POST', headers: { authorization: 'Bearer cwai_goodtoken_abc' }, body: one() }); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
		assert.equal(audits.at(-1).action, 'convert.pdf.site'); assert.equal(audits.at(-1).target, 'cwai_goodtok…');
		for (let i = 0; i < 119; i++) await fetch(base + '/api/v1/convert/pdf', { method: 'POST', headers: { authorization: 'Bearer cwai_goodtoken_abc' }, body: one() });
		r = await fetch(base + '/api/v1/convert/pdf', { method: 'POST', headers: { authorization: 'Bearer cwai_goodtoken_abc' }, body: one() }); assert.equal(r.status, 429);
		t += 3600001; r = await fetch(base + '/api/v1/convert/pdf', { method: 'POST', headers: { authorization: 'Bearer cwai_goodtoken_abc' }, body: one() }); assert.equal(r.status, 200, 'the hour rolled over');
	} finally { srv.close(); }
});
