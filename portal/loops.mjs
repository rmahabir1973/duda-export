// A small Loops client plus webhook signature checking. The API key never leaves the server.
import crypto from 'node:crypto';

const BASE = 'https://app.loops.so/api/v1';

export function createLoops({ apiKey = '', fetchImpl = globalThis.fetch, base = BASE } = {}) {
	const call = async (method, path, body, headers = {}) => {
		let res;
		try {
			res = await fetchImpl(base + path, { method, headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
		} catch (e) { return { ok: false, status: 0, message: 'Could not reach Loops.' }; }
		let data = null; try { data = await res.json(); } catch { /* no body */ }
		return { ok: res.ok, status: res.status, data, message: data?.message || (res.ok ? '' : 'Loops returned HTTP ' + res.status) };
	};
	return {
		available: () => !!apiKey,
		/** Is the key valid? Returns the team name Loops reports. */
		async ping() { const r = await call('GET', '/api-key'); return r.ok ? { ok: true, team: r.data?.teamName || '' } : { ok: false, message: r.status === 401 ? 'Loops rejected the API key.' : r.message }; },
		/** Create the contact, or update it if it already exists. */
		async upsertContact(props) {
			const r = await call('POST', '/contacts/create', props);
			if (r.ok) return { ok: true, created: true };
			if (r.status === 409) { const u = await call('PUT', '/contacts/update', props); return u.ok ? { ok: true, created: false } : { ok: false, message: u.message }; }
			return { ok: false, message: r.message };
		},
		/** Fire an event; a Loop in Loops listens for it and sends the email. */
		async sendEvent(email, eventName, eventProperties, idempotencyKey) {
			const r = await call('POST', '/events/send', { email, eventName, eventProperties }, idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 100) } : {});
			return r.ok ? { ok: true } : { ok: false, status: r.status, message: r.message };
		},
	};
}

/** Standard Webhooks check (what Loops uses): HMAC-SHA256 over "id.timestamp.body" with the base64 secret after "whsec_". */
export function verifyLoopsWebhook({ secret, id, timestamp, signature, rawBody, now = Date.now(), toleranceSec = 300 }) {
	if (!secret || !id || !timestamp || !signature) return false;
	const ts = Number(timestamp);
	if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSec) return false;
	let key; try { key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64'); } catch { return false; }
	if (!key.length) return false;
	const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();
	for (const part of String(signature).split(' ')) {
		const [v, sig] = part.split(',');
		if (v !== 'v1' || !sig) continue;
		let given; try { given = Buffer.from(sig, 'base64'); } catch { continue; }
		if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return true;
	}
	return false;
}
