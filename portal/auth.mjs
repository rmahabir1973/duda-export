// Accounts, sessions and the audit log. Passwords are hashed with scrypt; session tokens are random and only their hash is stored.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const ROLES = ['admin', 'staff'];

export async function hashPassword(pw) {
	const salt = crypto.randomBytes(16);
	const N = 16384, r = 8, p = 1;
	const key = await scrypt(String(pw), salt, 32, { N, r, p });
	return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
	const [alg, N, r, p, salt, key] = String(stored || '').split('$');
	if (alg !== 'scrypt' || !key) return false;
	const want = Buffer.from(key, 'base64');
	const got = await scrypt(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p });
	return got.length === want.length && crypto.timingSafeEqual(got, want);
}
export function checkPassword(pw) {
	const p = String(pw || '');
	if (p.length < 12) return 'The password must be at least 12 characters.';
	if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/\d/.test(p)) return 'The password needs a capital letter, a small letter and a number.';
	return '';
}
export const randomPassword = (n = 14) => {
	const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let out = ''; for (const b of crypto.randomBytes(n)) out += chars[b % chars.length];
	return out + 'a7';
};

/* ---- TOTP (RFC 6238): 6-digit codes from an authenticator app ---- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const b32encode = (buf) => { let bits = 0, v = 0, out = ''; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(v << (5 - bits)) & 31]; return out; };
export const b32decode = (s) => { let bits = 0, v = 0; const out = []; for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
export function hotp(secret, counter, digits = 6) {
	const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
	const h = crypto.createHmac('sha1', secret).update(b).digest(), o = h[19] & 15;
	return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 10 ** digits).padStart(digits, '0');
}
export const totpNow = (secretB32, t = Date.now()) => hotp(b32decode(secretB32), Math.floor(t / 30000));
/** Returns the matched 30-second step (> lastStep, so a code can't be used twice), or 0. Allows one step of clock drift. */
export function checkTotp(secretB32, code, lastStep = 0, now = Date.now()) {
	const c = String(code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(c)) return 0;
	const key = b32decode(secretB32), cur = Math.floor(now / 30000);
	for (const d of [-1, 0, 1]) { const step = cur + d; if (step > Number(lastStep) && crypto.timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(c))) return step; }
	return 0;
}
export const newTotpSecret = () => b32encode(crypto.randomBytes(20));
export const otpauthUri = (email, secret, issuer = 'ChurchWeb Portal') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
/** Secrets are stored encrypted (AES-256-GCM) with a key that lives in Railway, not in the database. */
const encKey = (k) => crypto.createHash('sha256').update('cw-portal-enc:' + k).digest();
export const seal = (plain, k) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', encKey(k), iv), ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url'); };
export const unseal = (s, k) => { const b = Buffer.from(String(s), 'base64url'), d = crypto.createDecipheriv('aes-256-gcm', encKey(k), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); };
const normCode = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const newRecoveryCodes = () => Array.from({ length: 8 }, () => { const r = b32encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase(); return r.slice(0, 5) + '-' + r.slice(5); });
const LOCK_AFTER = 5, LOCK_MINUTES = 15;

const publicUser = (u) => u && { id: Number(u.id), email: u.email, name: u.name, role: u.role, active: u.active, mustChange: u.must_change, createdAt: u.created_at, lastLogin: u.last_login, twoFactor: !!u.totp_enabled, locked: !!(u.locked_until && new Date(u.locked_until) > new Date()) };

export function createAuth(db, { sessionHours = 12, requireTwoFactor = true, encryptionKey = '', previousKeys = [] } = {}) {
	if (!encryptionKey) throw new Error('createAuth needs an encryption key for the two-factor secrets.');
	const maxAgeMs = sessionHours * 3600 * 1000, absoluteMs = 7 * 86400 * 1000;
	/** Opens a sealed secret with the current key, or an earlier one (a key that was in use before PORTAL_ENC_KEY changed). Returns null if none fit. */
	const openSecret = (sealed) => {
		for (const [i, k] of [encryptionKey, ...previousKeys.filter((x) => x && x !== encryptionKey)].entries()) { try { return { secret: unseal(sealed, k), old: i > 0 }; } catch { /* try the next key */ } }
		return null;
	};
	const self = {
		async userCount() { return Number((await db.query('select count(*)::int as n from users'))[0].n); },
		async listUsers() { return (await db.query('select * from users order by lower(email)')).map(publicUser); },
		async getUser(id) { return publicUser((await db.query('select * from users where id = $1', [id]))[0]); },

		async createUser({ email, name = '', role = 'staff', password, mustChange = true, createdBy = null }) {
			email = String(email || '').trim().toLowerCase();
			if (!EMAIL_RE.test(email)) throw new Error('Enter a valid email address.');
			if (!ROLES.includes(role)) throw new Error('The role must be admin or staff.');
			const bad = checkPassword(password); if (bad) throw new Error(bad);
			if ((await db.query('select 1 from users where email = $1', [email])).length) throw new Error('There is already an account for ' + email + '.');
			const rows = await db.query('insert into users (email, name, role, password_hash, must_change, created_by) values ($1,$2,$3,$4,$5,$6) returning *', [email, String(name).trim().slice(0, 80), role, await hashPassword(password), !!mustChange, createdBy]);
			return publicUser(rows[0]);
		},

		/** Admins can rename, change role, and switch accounts on or off, but there must always be one active admin. */
		async updateUser(id, { name, role, active }, actingId = null) {
			const u = (await db.query('select * from users where id = $1', [id]))[0];
			if (!u) throw new Error('Account not found.');
			const next = { name: name ?? u.name, role: role ?? u.role, active: active ?? u.active };
			if (!ROLES.includes(next.role)) throw new Error('The role must be admin or staff.');
			if (Number(actingId) === Number(id) && (next.active === false || next.role !== 'admin')) throw new Error('You can\'t switch off or demote your own account. Ask another admin.');
			if (u.role === 'admin' && u.active && (next.role !== 'admin' || next.active === false)) {
				const others = Number((await db.query("select count(*)::int as n from users where role = 'admin' and active and id <> $1", [id]))[0].n);
				if (!others) throw new Error('There must always be at least one active admin.');
			}
			const rows = await db.query('update users set name = $2, role = $3, active = $4 where id = $1 returning *', [id, String(next.name).trim().slice(0, 80), next.role, next.active]);
			if (next.active === false) await db.query('delete from sessions where user_id = $1', [id]);
			return publicUser(rows[0]);
		},

		/** An admin sets a temporary password; the person must choose their own at next sign-in. */
		async resetPassword(id, password) {
			const bad = checkPassword(password); if (bad) throw new Error(bad);
			const rows = await db.query('update users set password_hash = $2, must_change = true where id = $1 returning id', [id, await hashPassword(password)]);
			if (!rows.length) throw new Error('Account not found.');
			await db.query('delete from sessions where user_id = $1', [id]);
		},
		async changeOwnPassword(id, current, next, keepToken = '') {
			const u = (await db.query('select * from users where id = $1', [id]))[0];
			if (!u || !(await verifyPassword(current, u.password_hash))) throw new Error('Your current password isn\'t right.');
			const bad = checkPassword(next); if (bad) throw new Error(bad);
			if (await verifyPassword(next, u.password_hash)) throw new Error('Choose a password you haven\'t used on this account.');
			await db.query('update users set password_hash = $2, must_change = false where id = $1', [id, await hashPassword(next)]);
			await db.query('delete from sessions where user_id = $1 and token_hash <> $2', [id, keepToken ? sha(keepToken) : '']);
		},

		/**
		 * Step 1 of signing in: the password. Returns null (wrong), {locked:true}, or {token, user, need}.
		 * need = 'code' (they have 2FA), 'enroll' (they must set it up now) or null (fully signed in).
		 * Until step 2 is done the session is "pending": it can't open any page or API.
		 */
		async login(email, password, { ip = '', ua = '', bootstrapPassword = '' } = {}) {
			email = String(email || '').trim().toLowerCase();
			let u = (await db.query('select * from users where email = $1', [email]))[0];
			if (u && u.locked_until && new Date(u.locked_until) > new Date()) return { locked: true };
			let first = false;
			if (!u && bootstrapPassword && EMAIL_RE.test(email) && !(await self.userCount())) { // very first sign-in: the shared setup password creates the first admin
				if (String(password) !== bootstrapPassword) return null;
				u = (await db.query('insert into users (email, name, role, password_hash, must_change) values ($1,$2,$3,$4,true) returning *', [email, email.split('@')[0], 'admin', await hashPassword(password)]))[0];
				first = true;
			} else {
				// do the same work whether or not the account exists, so timing doesn't reveal which emails have accounts
				const ok = await verifyPassword(password, u?.password_hash || 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(32).toString('base64'));
				if (!u || !u.active) return null;
				if (!ok) { await self._fail(u); return null; }
			}
			const need = requireTwoFactor ? (u.totp_enabled ? 'code' : 'enroll') : null;
			const s = await self._session(u, ip, ua, need ? 'pending' : 'full');
			if (!need) await self._done(u.id);
			return { ...s, need, first, user: publicUser(u) };
		},
		async _fail(u) {
			const n = Number(u.failed_count) + 1;
			if (n >= LOCK_AFTER) { await db.query("update users set failed_count = 0, locked_until = now() + ($2::double precision * interval '1 minute') where id = $1", [u.id, LOCK_MINUTES]); await db.query('delete from sessions where user_id = $1', [u.id]); }
			else await db.query('update users set failed_count = $2 where id = $1', [u.id, n]);
			return n >= LOCK_AFTER;
		},
		async _done(id) { await db.query('update users set failed_count = 0, locked_until = null, last_login = now() where id = $1', [id]); },
		async _session(u, ip, ua, stage = 'full') {
			const token = crypto.randomBytes(32).toString('base64url'), ttl = stage === 'pending' ? 10 * 60 * 1000 : maxAgeMs;
			await db.query('insert into sessions (token_hash, user_id, expires_at, ip, ua, stage) values ($1,$2, now() + ($3::double precision * interval \'1 millisecond\'), $4, $5, $6)', [sha(token), u.id, ttl, String(ip).slice(0, 64), String(ua).slice(0, 200), stage]);
			await db.query('delete from sessions where expires_at < now()');
			return { token };
		},
		/** The person behind a pending (password-only) session, with their 2FA state, or null. */
		async pending(token) {
			if (!token) return null;
			const r = (await db.query("select u.* from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now() and s.stage = 'pending' and u.active", [sha(token)]))[0];
			return r || null;
		},
		async _promote(token, u, ip, ua) { // a brand-new token on success, so nothing set before sign-in can be reused
			await db.query('delete from sessions where token_hash = $1', [sha(token)]);
			const s = await self._session(u, ip, ua, 'full'); await self._done(u.id);
			return { token: s.token, user: publicUser((await db.query('select * from users where id = $1', [u.id]))[0]) };
		},
		/** Enrolment, step 1: make a secret and show it as a QR code. Nothing is switched on until a code from the app proves it works. */
		async enrolStart(token) {
			const u = await self.pending(token); if (!u) throw new Error('Sign in again.');
			if (u.totp_enabled) throw new Error('Two-factor is already set up on this account.');
			const secret = newTotpSecret();
			await db.query('update users set totp_pending = $2 where id = $1', [u.id, seal(secret, encryptionKey)]);
			return { secret, otpauth: otpauthUri(u.email, secret) };
		},
		async enrolFinish(token, code, { ip = '', ua = '' } = {}) {
			const u = await self.pending(token); if (!u || !u.totp_pending) throw new Error('Start the setup again.');
			const opened = openSecret(u.totp_pending); if (!opened) throw new Error('Start the setup again.'); const secret = opened.secret, step = checkTotp(secret, code, 0);
			if (!step) { if (await self._fail(u)) throw new Error('Too many wrong codes. The account is locked for ' + LOCK_MINUTES + ' minutes.'); throw new Error('That code isn\'t right. Check the 6 digits in your app and that your phone\'s clock is automatic.'); }
			const codes = newRecoveryCodes();
			await db.query('update users set totp_secret = $2, totp_pending = null, totp_enabled = true, totp_last_step = $3, recovery_codes = $4 where id = $1', [u.id, seal(secret, encryptionKey), step, JSON.stringify(codes.map((c) => sha(normCode(c))))]);
			return { ...(await self._promote(token, u, ip, ua)), recoveryCodes: codes };
		},
		/** Step 2 of signing in: the 6-digit code, or one of the single-use recovery codes. */
		async secondFactor(token, code, { ip = '', ua = '' } = {}) {
			const u = await self.pending(token); if (!u) throw new Error('Sign in again.');
			if (u.locked_until && new Date(u.locked_until) > new Date()) throw new Error('This account is locked for a few minutes after too many wrong codes.');
			const opened = u.totp_secret ? openSecret(u.totp_secret) : null, unreadable = !!u.totp_secret && !opened;
			const step = opened ? checkTotp(opened.secret, code, u.totp_last_step) : 0;
			if (step) {
				await db.query('update users set totp_last_step = $2 where id = $1', [u.id, step]);
				if (opened.old) await db.query('update users set totp_secret = $2 where id = $1', [u.id, seal(opened.secret, encryptionKey)]); // quietly move it to the current key
				return { ...(await self._promote(token, u, ip, ua)), usedRecovery: false }; }
			const h = sha(normCode(code)), rec = (u.recovery_codes || []);
			if (normCode(code).length === 10 && rec.includes(h)) { await db.query('update users set recovery_codes = $2 where id = $1', [u.id, JSON.stringify(rec.filter((x) => x !== h))]); return { ...(await self._promote(token, u, ip, ua)), usedRecovery: true, recoveryLeft: rec.length - 1 }; }
			if (await self._fail(u)) throw new Error('Too many wrong codes. The account is locked for ' + LOCK_MINUTES + ' minutes.');
			throw new Error(unreadable ? 'The portal can\'t read your authenticator setup (its encryption key changed). Use one of your recovery codes, or ask an admin to reset your two-step sign-in.' : 'That code isn\'t right.');
		},
		/** An admin clears someone's 2FA (lost phone). They must enrol again at their next sign-in. */
		async resetTwoFactor(id) {
			const rows = await db.query("update users set totp_secret = null, totp_pending = null, totp_enabled = false, totp_last_step = 0, recovery_codes = '[]'::jsonb where id = $1 returning id", [id]);
			if (!rows.length) throw new Error('Account not found.');
			await db.query('delete from sessions where user_id = $1', [id]);
		},
		async resetTwoFactorByEmail(email) { const u = (await db.query('select id from users where email = $1', [String(email).trim().toLowerCase()]))[0]; if (!u) return false; await self.resetTwoFactor(u.id); return true; },
		async recoveryLeft(id) { return ((await db.query('select recovery_codes from users where id = $1', [id]))[0]?.recovery_codes || []).length; },
		/** New recovery codes (the old ones stop working). Needs the password and a current code. */
		async regenerateRecovery(id, password, code) {
			const u = (await db.query('select * from users where id = $1', [id]))[0];
			if (!u || !u.totp_enabled || !(await verifyPassword(password, u.password_hash))) throw new Error('Your password isn\'t right.');
			const opened = openSecret(u.totp_secret), step = opened ? checkTotp(opened.secret, code, u.totp_last_step) : 0;
			if (!step) throw new Error('That code isn\'t right.');
			const codes = newRecoveryCodes();
			await db.query('update users set totp_last_step = $2, recovery_codes = $3 where id = $1', [id, step, JSON.stringify(codes.map((c) => sha(normCode(c))))]);
			return codes;
		},
		/** The person behind a full session cookie, or null. Extends the session while it is in use (up to 7 days in all). */
		async lookup(token) {
			if (!token) return null;
			const rows = await db.query("select u.*, s.created_at as s_created, s.last_seen as s_seen from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now() and s.stage = 'full' and u.active", [sha(token)]);
			if (!rows.length) return null;
			const r = rows[0];
			if (Date.now() - new Date(r.s_created).getTime() > absoluteMs) { await self.logout(token); return null; }
			if (Date.now() - new Date(r.s_seen).getTime() > 5 * 60 * 1000) await db.query('update sessions set last_seen = now(), expires_at = now() + ($2::double precision * interval \'1 millisecond\') where token_hash = $1', [sha(token), maxAgeMs]);
			return publicUser(r);
		},
		async logout(token) { if (token) await db.query('delete from sessions where token_hash = $1', [sha(token)]); },
	};
	return self;
}

/** The audit log: who did what, when, from where. Detail never holds passwords or tokens. */
export function createAudit(db) {
	return {
		async write({ user = null, action, target = '', status = null, detail = null, ip = '' }) {
			try { await db.query('insert into audit_log (user_id, user_email, action, target, status, detail, ip) values ($1,$2,$3,$4,$5,$6,$7)', [user?.id ?? null, user?.email || '', String(action).slice(0, 120), String(target).slice(0, 200), status, detail ? JSON.stringify(detail) : null, String(ip).slice(0, 64)]); }
			catch (e) { console.error('audit write failed:', e.message); }
		},
		async list({ q = '', user = '', limit = 100, offset = 0 } = {}) {
			const where = [], p = [];
			if (user) { p.push(user); where.push(`user_email = $${p.length}`); }
			if (q) { p.push('%' + String(q).replace(/[\\%_]/g, '\\$&') + '%'); where.push(`(action ilike $${p.length} or target ilike $${p.length} or user_email ilike $${p.length} or detail::text ilike $${p.length})`); }
			const w = where.length ? 'where ' + where.join(' and ') : '';
			const total = Number((await db.query(`select count(*)::int as n from audit_log ${w}`, p))[0].n);
			p.push(Math.min(500, Math.max(1, +limit || 100)), Math.max(0, +offset || 0));
			const rows = await db.query(`select id, at, user_email, action, target, status, detail, ip from audit_log ${w} order by at desc, id desc limit $${p.length - 1} offset $${p.length}`, p);
			return { total, rows };
		},
		users: async () => (await db.query("select distinct user_email from audit_log where user_email <> '' order by 1")).map((r) => r.user_email),
	};
}
