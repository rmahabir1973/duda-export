// Optional second lock: only accept requests that passed Cloudflare Access (Zero Trust).
// Cloudflare adds a signed token (a JWT) to every request it lets through; we check its signature, audience, issuer and expiry.
import crypto from 'node:crypto';

const b64 = (s) => Buffer.from(String(s), 'base64url');

/** Pure check: returns the token's claims if it is genuine, otherwise throws. */
export function verifyAccessJwt(token, jwks, { teamDomain, aud, now = Date.now() }) {
	const parts = String(token || '').split('.');
	if (parts.length !== 3) throw new Error('malformed');
	const header = JSON.parse(b64(parts[0]).toString()), claims = JSON.parse(b64(parts[1]).toString());
	if (header.alg !== 'RS256') throw new Error('algorithm');
	const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
	if (!jwk) throw new Error('unknown key');
	const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), crypto.createPublicKey({ key: jwk, format: 'jwk' }), b64(parts[2]));
	if (!ok) throw new Error('signature');
	if (!(claims.exp * 1000 > now)) throw new Error('expired');
	if (claims.nbf && claims.nbf * 1000 > now + 60000) throw new Error('not yet valid');
	if (claims.iss !== 'https://' + teamDomain) throw new Error('issuer');
	if (![].concat(claims.aud || []).includes(aud)) throw new Error('audience');
	return claims;
}

export function createAccessGuard({ teamDomain, aud, fetchImpl = globalThis.fetch, exempt = ['/healthz'] }) {
	let jwks = { keys: [] }, fetchedAt = 0;
	const load = async (force) => {
		if (!force && Date.now() - fetchedAt < 3600 * 1000 && jwks.keys.length) return jwks;
		const r = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
		if (!r.ok) throw new Error('could not load the Cloudflare Access keys');
		jwks = await r.json(); fetchedAt = Date.now(); return jwks;
	};
	const deny = (res) => res.status(403).type('text').send('Access denied');
	const guard = async (req, res, next) => {
		if (exempt.some((e) => e === req.path || (e.endsWith('/') && req.path.startsWith(e)))) return next();
		const token = req.get('cf-access-jwt-assertion');
		if (!token) return deny(res);
		try {
			let claims;
			try { claims = verifyAccessJwt(token, await load(false), { teamDomain, aud }); }
			catch (e) { if (e.message !== 'unknown key') throw e; claims = verifyAccessJwt(token, await load(true), { teamDomain, aud }); } // Cloudflare rotates keys
			req.accessEmail = String(claims.email || '').toLowerCase();
			next();
		} catch (e) { deny(res); }
	};
	return guard;
}
