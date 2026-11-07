// What our systems know about the person behind a support ticket, as plain text for the triage prompt: their WHMCS account (services,
// open invoices, how they pay), every domain tied to them (where DNS, website and email live, when the registration renews), and where
// they are on the Customers board. Read-only, from the portal's own tables and the last WHMCS snapshot; nothing is fetched live.
const norm = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#:].*$/, '').replace(/^www\./, '');
const day = (v) => (!v ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const money = (n, cur) => `${Number(n || 0).toFixed(2)}${cur ? ' ' + cur : ''}`;

export function createSupportContext({ db, store = null, now = () => Date.now() }) {
	const kv = async (k) => { const r = (await db.query('select value from kv where key = $1', [k]))[0]; if (!r) return null; return typeof r.value === 'string' && /^[\[{"]/.test(r.value) ? JSON.parse(r.value) : r.value; };
	return async function context(row) {
		const out = [], sender = String(row.sender || '').toLowerCase(), senderDomain = sender.split('@')[1] || '', clientId = Number(row.client_id) || 0;
		const snap = (await kv('whmcs_snapshot')) || {}, clients = snap.clients || [], services = snap.services || [], invoices = snap.invoices || [];
		const client = clients.find((c) => c.id === clientId) || clients.find((c) => String(c.email || '').toLowerCase() === sender) || null;
		const domains = new Set();
		if (client) {
			out.push(`WHMCS client #${client.id}: ${client.company || client.name}${client.company && client.name ? ' (' + client.name + ')' : ''}, account email ${client.email}, status ${client.status}.`);
			const svc = services.filter((s) => s.clientid === client.id);
			for (const s of svc) { if (s.domain) domains.add(norm(s.domain)); out.push(`- Service: ${s.product}${s.domain ? ' for ' + s.domain : ''}, ${s.status}, ${s.cycle || ''} ${money(s.amount)}${s.next ? ', next due ' + day(s.next) : ''}${s.module ? ', pays by ' + s.module : ''}.`); }
			if (!svc.length) out.push('- No services on this account.');
			const inv = invoices.filter((i) => i.clientid === client.id && !['Paid', 'Cancelled', 'Refunded'].includes(i.status)).sort((a, b) => String(a.due).localeCompare(String(b.due)));
			for (const i of inv.slice(0, 5)) out.push(`- Invoice #${i.id}: ${i.status}, ${money(i.total, i.cur)}, dated ${day(i.date)}, due ${day(i.due)}${i.due && new Date(i.due).getTime() < now() ? ' (OVERDUE)' : ''}${i.module ? ', ' + i.module : ''}.`);
			if (!inv.length) out.push('- No unpaid invoices.');
			const paid = invoices.filter((i) => i.clientid === client.id && i.status === 'Paid').sort((a, b) => String(b.paid || b.date).localeCompare(String(a.paid || a.date)))[0];
			if (paid) out.push(`- Last paid invoice #${paid.id}: ${money(paid.total, paid.cur)} on ${day(paid.paid || paid.date)}.`);
			if (snap.at) out.push(`(WHMCS data as of ${String(snap.at).slice(0, 16).replace('T', ' ')} UTC.)`);
		} else if (clientId) out.push(`WHMCS client #${clientId} (not in the last WHMCS snapshot).`);
		else out.push('Not a WHMCS client (no account matches this email).');
		if (senderDomain && !/^(gmail|yahoo|hotmail|outlook|live|icloud|me|aol|sympatico|rogers|bell|telus|shaw|cogeco|eastlink|protonmail|msn)\./.test(senderDomain + '.')) domains.add(norm(senderDomain));
		if (store) for (const c of store.list()) { const d = norm(c.domain); if (d && (domains.has(d) || (client && c.name && client.company && c.name.toLowerCase() === client.company.toLowerCase()))) { domains.add(d); out.push(`Customers board: "${c.name}" (${c.kind === 'migration' ? 'DUDA migration' : 'new site'}), done stages: ${Object.entries(c.stages || {}).filter(([, v]) => v?.done).map(([k]) => k).join(', ') || 'none yet'}${c.stages?.golive?.done ? ' (LIVE on their domain)' : c.prospect?.siteReadyAt ? ' (preview site ready)' : ''}.`); } }
		for (const d of [...domains].filter(Boolean)) {
			const h = (await db.query('select * from hosted_domains where domain = $1', [d]))[0];
			if (!h) { out.push(`Domain ${d}: not found in Cloudflare, DUDA, SmarterMail, Hostinger or Ascio (we may not host it).`); continue; }
			const bits = [h.in_cloudflare ? 'DNS in our Cloudflare' : 'DNS not with us', h.in_duda ? 'website on DUDA (site ' + h.duda_site + ')' : h.in_hostinger ? 'website on our WordPress hosting (' + h.hostinger_site + ')' : 'no website with us', h.in_smartermail ? 'email hosted with us (SmarterMail)' : 'email not with us'];
			if (h.in_ascio) bits.push(`registered through us (Ascio)${h.ascio_expires ? ', renews ' + day(h.ascio_expires) : ''}${h.ascio_status ? ', ' + h.ascio_status : ''}${h.ascio_lock ? ', transfer ' + String(h.ascio_lock).toLowerCase() : ''}`); else bits.push('domain not registered through us');
			out.push(`Domain ${d}: ${bits.join('; ')}.`);
		}
		return out.join('\n');
	};
}
