// Prospect outreach through Loops: who is eligible, a capped and confirmed send, a do-not-contact list, and Loops webhooks.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const STOP_EVENTS = { 'email.hardBounced': 'bounced', 'email.spamReported': 'spam complaint', 'contact.unsubscribed': 'unsubscribed', 'email.unsubscribed': 'unsubscribed' };

export function createOutreach({ db, dir, loops, audit, eventName = 'prospect_outreach', dailyCap = 25, windowDays = 60, paceMs = 250 }) {
	const hardCap = 200, cap = Math.max(0, Math.min(hardCap, Number(dailyCap) || 0));
	const self = {
		cap, eventName, windowDays,
		async sentToday() { return Number((await db.query("select count(*)::int as n from outreach_log where ok and sent_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'"))[0].n); },
		async _eligible(filters, campaign) {
			const { sql, p } = dir._where({ ...filters, customer: 'no', hasEmail: true });
			p.push(String(campaign)); const c = '$' + p.length;
			const rows = await db.query(
				`select distinct on (lower(email)) id, name, city, province, lower(email) as email from directory ${sql ? sql + ' and' : 'where'} email <> '' and not is_customer
				 and outreach_status not in ('not interested','customer','replied','do not contact')
				 and lower(email) not in (select email from outreach_suppress)
				 and not exists (select 1 from outreach_log l where l.email = lower(directory.email) and l.ok and l.campaign = ${c} and l.sent_at > now() - interval '${Number(windowDays)} days')
				 order by lower(email), id`, p);
			return rows.filter((r) => EMAIL_RE.test(r.email));
		},
		/** What a send would do right now. Nothing is sent. */
		async preview(filters, campaign) {
			const all = await self._eligible(filters, campaign), left = Math.max(0, cap - (await self.sentToday()));
			return { eligible: all.length, remainingToday: left, willSend: Math.min(all.length, left), cap, sample: all.slice(0, 5).map((r) => ({ name: r.name, city: r.city, email: r.email })) };
		},
		/** Sends the first `expect` eligible recipients. `expect` must equal what the preview showed, so a person has confirmed the exact number. */
		async send({ filters, campaign, expect, user }) {
			if (!loops.available()) throw new Error('Loops is not set up on this server (LOOPS_API_KEY).');
			if (!campaign || !/^[a-z0-9-]{3,40}$/.test(campaign)) throw new Error('Campaign name: 3 to 40 lowercase letters, numbers or dashes.');
			const pv = await self.preview(filters, campaign);
			if (!pv.willSend) throw new Error(pv.remainingToday ? 'Nobody is eligible: they may be customers, already contacted recently, or on the do-not-contact list.' : `Today's sending limit (${cap}) has been reached. It resets at midnight UTC.`);
			if (Number(expect) !== pv.willSend) throw new Error(`The list changed: ${pv.willSend} would be sent now. Preview again before confirming.`);
			const list = (await self._eligible(filters, campaign)).slice(0, pv.willSend);
			const done = (async () => {
				let sent = 0, failed = 0;
				for (const r of list) {
					const day = new Date().toISOString().slice(0, 10);
					let res = await loops.upsertContact({ email: r.email, source: 'ChurchWeb portal', userGroup: 'prospect', churchName: r.name, city: r.city, province: r.province });
					if (res.ok) res = await loops.sendEvent(r.email, eventName, { churchName: r.name, city: r.city }, `${campaign}-${r.id}-${day}`);
					await db.query('insert into outreach_log (directory_id, email, campaign, sent_by, ok, error) values ($1,$2,$3,$4,$5,$6)', [r.id, r.email, campaign, user?.email || '', !!res.ok, res.ok ? '' : String(res.message || 'failed').slice(0, 300)]);
					if (res.ok) { sent++; await db.query("update directory set outreach_status = 'contacted', updated_at = now() where lower(email) = $1 and outreach_status in ('new','to contact')", [r.email]); } else failed++;
					if (paceMs) await new Promise((x) => setTimeout(x, paceMs));
				}
				return { sent, failed };
			})();
			return { started: list.length, done };
		},
		async suppress(email, reason) {
			email = String(email || '').trim().toLowerCase(); if (!EMAIL_RE.test(email)) throw new Error('That is not an email address.');
			await db.query('insert into outreach_suppress (email, reason) values ($1,$2) on conflict (email) do update set reason = excluded.reason', [email, String(reason || 'manual').slice(0, 80)]);
			await db.query("update directory set outreach_status = 'do not contact', updated_at = now() where lower(email) = $1 and outreach_status <> 'customer'", [email]);
		},
		async suppressed() { return db.query('select email, reason, at from outreach_suppress order by at desc limit 500'); },
		/** A signed Loops webhook. Returns what was done. Repeats of the same webhook id are ignored. */
		async handleEvent(webhookId, payload) {
			const type = String(payload?.eventName || ''), email = String(payload?.contactIdentity?.email || '').toLowerCase();
			if (!type) return { ignored: true };
			const ins = await db.query('insert into outreach_events (wid, email, type, source) values ($1,$2,$3,$4) on conflict (wid) do nothing returning id', [String(webhookId).slice(0, 120), email, type, String(payload?.campaignName || payload?.loopName || payload?.transactionalName || '').slice(0, 120)]);
			if (!ins.length) return { duplicate: true };
			if (STOP_EVENTS[type] && email) { await self.suppress(email, STOP_EVENTS[type]); return { suppressed: email }; }
			return { recorded: type };
		},
		async stats() {
			const ev = await db.query("select type, count(*)::int as n from outreach_events where at > now() - interval '30 days' group by 1");
			const by = Object.fromEntries(ev.map((r) => [r.type, r.n]));
			const sent = Number((await db.query("select count(*)::int as n from outreach_log where ok and sent_at > now() - interval '30 days'"))[0].n);
			return { sent30: sent, sentToday: await self.sentToday(), cap, delivered: by['email.delivered'] || 0, opened: by['email.opened'] || 0, clicked: by['email.clicked'] || 0, bounced: (by['email.hardBounced'] || 0) + (by['email.softBounced'] || 0), unsubscribed: (by['contact.unsubscribed'] || 0) + (by['email.unsubscribed'] || 0), suppressed: Number((await db.query('select count(*)::int as n from outreach_suppress'))[0].n) };
		},
	};
	return self;
}
