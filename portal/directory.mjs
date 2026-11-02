// The United Church of Canada directory: import a CSV, search and filter it, export it, and match it against our customers.
const FREE_MAIL = new Set(['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.ca', 'live.com', 'live.ca', 'icloud.com', 'me.com', 'aol.com', 'msn.com', 'sympatico.ca', 'bell.net', 'rogers.com', 'shaw.ca', 'telus.net', 'eastlink.ca', 'cogeco.ca', 'videotron.ca', 'sasktel.net', 'mts.net', 'nbnet.nb.ca', 'bellnet.ca', 'xplornet.ca', 'execulink.com']);
export const STATUSES = ['new', 'to contact', 'contacted', 'replied', 'not interested', 'customer'];

/** Minimal RFC 4180 CSV reader: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF, BOM. */
export function parseCsv(text) {
	const rows = []; let row = [], f = '', q = false;
	const s = String(text).replace(/^﻿/, '');
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
		if (c === '"') q = true;
		else if (c === ',') { row.push(f); f = ''; }
		else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
		else f += c;
	}
	if (f !== '' || row.length) { row.push(f); if (row.some((x) => x !== '')) rows.push(row); }
	return rows;
}
export function csvLine(vals) { return vals.map((v) => { const t = String(v ?? ''); return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }).join(','); }

export const hostOf = (u) => { const t = String(u || '').trim().toLowerCase(); if (!t) return ''; try { return new URL(/^[a-z]+:\/\//.test(t) ? t : 'http://' + t).hostname.replace(/^www\./, ''); } catch { return ''; } };
export const emailDomain = (e) => { const d = String(e || '').trim().toLowerCase().split('@')[1] || ''; return d && !FREE_MAIL.has(d) ? d.replace(/^www\./, '') : ''; };

/** Turn CSV rows (header first) into directory records. Header names are matched loosely so a re-export still imports. */
export function toRecords(rows) {
	if (rows.length < 2) throw new Error('The file has no listings.');
	const idx = {}; rows[0].forEach((h, i) => { idx[String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()] = i; });
	const col = (...names) => { for (const n of names) if (n in idx) return idx[n]; return -1; };
	const c = { name: col('name'), type: col('type'), address: col('address'), address2: col('address line 2', 'address2'), city: col('city'), province: col('province', 'prov'), postal: col('postal code', 'postal'), phone: col('phone'), email: col('email'), website: col('website'), existing: col('existing customer'), charge: col('pastoral charge'), council: col('regional council'), source: col('source') };
	if (c.name < 0) throw new Error('This doesn\'t look like the directory export: there is no "Name" column.');
	const get = (r, k) => (c[k] >= 0 ? String(r[c[k]] ?? '').trim() : '');
	const seen = new Set(), out = [];
	for (const r of rows.slice(1)) {
		const name = get(r, 'name'); if (!name) continue;
		const province = get(r, 'province').toUpperCase(), city = get(r, 'city');
		const source = get(r, 'source') || `${name}|${city}|${province}`;
		if (seen.has(source)) continue; seen.add(source);
		const website = get(r, 'website'), email = get(r, 'email');
		out.push({ source, name, type: get(r, 'type') || 'Congregation', address: get(r, 'address'), address2: get(r, 'address2'), city, province, postal: get(r, 'postal'), phone: get(r, 'phone'), email, website, domain: hostOf(website), email_domain: emailDomain(email), pastoral_charge: get(r, 'charge'), regional_council: get(r, 'council'), csv_existing: /^(yes|true|1)$/i.test(get(r, 'existing')) });
	}
	return out;
}

const COLS = ['source', 'name', 'type', 'address', 'address2', 'city', 'province', 'postal', 'phone', 'email', 'website', 'domain', 'email_domain', 'pastoral_charge', 'regional_council', 'csv_existing'];

export function createDirectory(db) {
	const self = {
		/** Add new listings and refresh existing ones (matched by their source page). Outreach status and notes are kept. */
		async import(records) {
			let added = 0, updated = 0;
			const before = new Set((await db.query('select source from directory')).map((r) => r.source));
			for (let i = 0; i < records.length; i += 150) {
				const chunk = records.slice(i, i + 150), params = [], vals = [];
				for (const r of chunk) { vals.push('(' + COLS.map((k) => { params.push(r[k]); return '$' + params.length; }).join(',') + ')'); if (before.has(r.source)) updated++; else added++; }
				await db.query(`insert into directory (${COLS.join(',')}) values ${vals.join(',')} on conflict (source) do update set ${COLS.filter((k) => k !== 'source').map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = now()`, params);
			}
			await self.rematch();
			const hosts = {}; for (const r of records) { try { const h = new URL(r.source).hostname; hosts[h] = (hosts[h] || 0) + 1; } catch { /* no source URL */ } }
			const top = Object.entries(hosts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'imported file';
			await db.query("insert into kv (key, value) values ('directory_meta', $1) on conflict (key) do update set value = excluded.value, updated_at = now()", [JSON.stringify({ source: top.replace(/^www\./, ''), importedAt: new Date().toISOString(), listings: records.length })]);
			return { added, updated, total: records.length };
		},

		/** A listing is a customer if the file says so, or if its website or email domain is one of our customer domains. */
		async rematch() { await db.query("update directory d set is_customer = (d.csv_existing or exists (select 1 from customer_domains c where c.domain <> '' and (c.domain = d.domain or c.domain = d.email_domain)))"); },

		async addCustomerDomains(text, source = 'manual') {
			const list = [...new Set(String(text || '').split(/[\s,;]+/).map(hostOf).filter((d) => d.includes('.')))];
			for (const d of list) await db.query('insert into customer_domains (domain, source) values ($1,$2) on conflict (domain) do nothing', [d, source]);
			await self.rematch(); return list.length;
		},
		async clearCustomerDomains(source = 'manual') { await db.query('delete from customer_domains where source = $1', [source]); await self.rematch(); },
		async customerSummary() {
			const total = Number((await db.query('select count(*)::int as n from customer_domains'))[0].n);
			const notFound = await db.query("select c.domain, c.source from customer_domains c where not exists (select 1 from directory d where d.domain = c.domain or d.email_domain = c.domain) order by c.domain");
			return { total, found: total - notFound.length, notFound };
		},

		_where(f) {
			const w = [], p = [], add = (sql, v) => { p.push(v); return sql.replace('?', '$' + p.length); };
			if (f.q) { const like = '%' + String(f.q).trim().replace(/[\\%_]/g, '\\$&') + '%'; p.push(like); const n = '$' + p.length; w.push(`(name ilike ${n} or city ilike ${n} or postal ilike ${n} or email ilike ${n} or website ilike ${n} or address ilike ${n} or pastoral_charge ilike ${n} or phone ilike ${n})`); }
			if (f.province) w.push(add('province = ?', f.province));
			if (f.listing === 'church') w.push("type = 'Congregation'"); else if (f.listing === 'charge') w.push("type = 'Pastoral Charge'");
			if (f.hasEmail) w.push("email <> ''");
			if (f.hasWebsite === 'yes') w.push("website <> ''"); else if (f.hasWebsite === 'no') w.push("website = ''");
			if (f.council) w.push(add('regional_council = ?', f.council));
			if (f.charge) w.push(add('pastoral_charge ilike ?', '%' + String(f.charge).replace(/[\\%_]/g, '\\$&') + '%'));
			if (f.customer === 'yes') w.push('is_customer'); else if (f.customer === 'no') w.push('not is_customer');
			if (f.status) w.push(add('outreach_status = ?', f.status));
			return { sql: w.length ? 'where ' + w.join(' and ') : '', p };
		},
		async list(f = {}) {
			const { sql, p } = self._where(f);
			const sort = { name: 'lower(name)', type: 'type', city: 'lower(city)', province: 'province', postal: 'postal', status: 'outreach_status' }[f.sort] || 'lower(name)', dir = f.dir === 'desc' ? 'desc' : 'asc';
			const total = Number((await db.query(`select count(*)::int as n from directory ${sql}`, p))[0].n);
			const lim = Math.min(500, Math.max(1, +f.limit || 100)), off = Math.max(0, +f.offset || 0);
			const rows = await db.query(`select id, name, type, address, city, province, postal, phone, email, website, pastoral_charge, regional_council, is_customer, outreach_status, notes from directory ${sql} order by ${sort} ${dir}, id limit ${lim} offset ${off}`, p);
			return { total, rows };
		},
		async exportRows(f = {}) {
			const { sql, p } = self._where(f);
			return db.query(`select name, type, address, address2, city, province, postal, phone, email, website, is_customer, outreach_status, notes, pastoral_charge, regional_council, source from directory ${sql} order by lower(name), id`, p);
		},
		async meta() {
			const s = (await db.query("select count(*)::int as total, count(*) filter (where type = 'Congregation')::int as churches, count(*) filter (where type = 'Pastoral Charge')::int as charges, count(*) filter (where email <> '')::int as with_email, count(distinct nullif(province, ''))::int as provinces, count(*) filter (where is_customer)::int as customers from directory"))[0];
			const meta = (await db.query("select value from kv where key = 'directory_meta'"))[0]?.value || null;
			return {
				stats: { total: s.total, churches: s.churches, charges: s.charges, withEmail: s.with_email, provinces: s.provinces, customers: s.customers },
				provinces: (await db.query("select province as v, count(*)::int as n from directory where province <> '' group by 1 order by 1")),
				councils: (await db.query("select regional_council as v, count(*)::int as n from directory where regional_council <> '' group by 1 order by 1")),
				statuses: STATUSES, source: meta, customerMatch: await self.customerSummary(),
			};
		},
		async setOutreach(id, { status, notes }) {
			if (status !== undefined && !STATUSES.includes(status)) throw new Error('Unknown outreach status.');
			const rows = await db.query('update directory set outreach_status = coalesce($2, outreach_status), notes = coalesce($3, notes), updated_at = now() where id = $1 returning id, name, outreach_status, notes', [id, status ?? null, notes === undefined ? null : String(notes).slice(0, 2000)]);
			if (!rows.length) throw new Error('Listing not found.');
			return rows[0];
		},
	};
	return self;
}
