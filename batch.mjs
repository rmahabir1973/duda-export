/** Parse pasted text into [{label, domain}] — one prospect per line.
 *  Accepts: "www.example.org", "Example Church, example.org", "Example Church<TAB>https://example.org/about", CSV rows
 *  (extra columns before the website are joined into the name; lines starting with # are ignored). */
export const MAX_BATCH = 40;
const DOMAINISH = /^(https?:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}([/:?#].*)?$/i;
export function parseBatch(text) {
	const out = [];
	const seen = new Set();
	for (const raw of String(text || '').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const fields = line.split(/[\t,;]/).map((f) => f.trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
		if (!fields.length) continue;
		let di = -1;
		for (let i = fields.length - 1; i >= 0; i--) if (DOMAINISH.test(fields[i]) && !/\s/.test(fields[i])) { di = i; break; }
		const domain = di >= 0 ? fields[di] : fields[fields.length - 1];
		const label = (di >= 0 ? fields.slice(0, di) : fields.slice(0, -1)).join(' ').replace(/[\u0000-\u001f]/g, '').slice(0, 80);
		const key = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
		if (seen.has(key)) { out.push({ label, domain, duplicate: true }); continue; }
		seen.add(key);
		out.push({ label, domain });
	}
	return out;
}
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
export function csvCell(v) {
	const s = String(v ?? '');
	const safe = /^[=+\-@]/.test(s) ? "'" + s : s; // stop spreadsheet formula injection
	return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}
