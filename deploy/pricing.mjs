// What a build cost in AI usage. The AI gateway counts every call per site and model, including the cache tokens, and the portal prices the difference between two readings.
// Prices are USD per million tokens (Anthropic's list prices). Override with the AI_PRICES variable: {"model-id": {"in": 2, "out": 10, "cw": 2.5, "cr": 0.1}}.
// Claude Haiku 5.5 charges 5x more for a request whose prompt is over 100,000 tokens; the gateway doesn't record prompt size, so Haiku is priced at the lower rate (a floor, marked as an estimate).
export const DEFAULT_PRICES = {
	'claude-sonnet-5-5': { in: 2, out: 10, cw: 2.5, cr: 0.1 },
	'claude-haiku-5-5': { in: 0.1, out: 0.5, cw: 0.125, cr: 0.01, approx: true },
	'claude-opus-5-5': { in: 4, out: 20, cw: 5, cr: 0.2 },
	'claude-fable-5-1': { in: 10, out: 50, cw: 12.5, cr: 0.25 },
};

export function priceTable(json) {
	let extra = {};
	try { extra = json ? JSON.parse(json) : {}; } catch { extra = {}; }
	const t = { ...DEFAULT_PRICES };
	for (const [m, p] of Object.entries(extra || {})) if (p && Number.isFinite(Number(p.in)) && Number.isFinite(Number(p.out))) t[m] = { in: Number(p.in), out: Number(p.out), cw: Number(p.cw ?? p.in * 1.25), cr: Number(p.cr ?? p.in * 0.1) };
	return t;
}

/** The gateway's rows ({site, model, req, tin, tout, cr, cw, img}) for one site, as {model: {req, tin, tout, cr, cw, img}}. */
export function snapshot(rows, site) {
	const out = {};
	for (const r of rows || []) {
		if (site && r.site !== site) continue;
		const m = (out[r.model || 'unknown'] ||= { req: 0, tin: 0, tout: 0, cr: 0, cw: 0, img: 0 });
		for (const k of Object.keys(m)) m[k] += Number(r[k]) || 0;
	}
	return out;
}

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** The cost of what happened between two snapshots. `estimated` is set when a model has no price of its own or is priced at its lower rate. */
export function priceDelta(now, base, table = DEFAULT_PRICES) {
	let usd = 0, calls = 0, images = 0, estimated = false;
	const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, byModel = [];
	for (const [model, n] of Object.entries(now || {})) {
		const b = (base || {})[model] || {};
		const d = (k) => Math.max(0, (n[k] || 0) - (b[k] || 0));
		const row = { req: d('req'), tin: d('tin'), tout: d('tout'), cr: d('cr'), cw: d('cw'), img: d('img') };
		if (!row.req && !row.tin && !row.tout && !row.cr && !row.cw && !row.img) continue;
		let p = table[model];
		if (!p) { p = table['claude-sonnet-5-5']; estimated = true; } else if (p.approx) estimated = true;
		const cost = (row.tin * p.in + row.tout * p.out + row.cw * p.cw + row.cr * p.cr) / 1e6;
		usd += cost; calls += row.req; images += row.img;
		tokens.input += row.tin; tokens.output += row.tout; tokens.cacheWrite += row.cw; tokens.cacheRead += row.cr;
		byModel.push({ model, usd: round(cost), calls: row.req });
	}
	return { usd: round(usd), calls, images, tokens, byModel, estimated };
}
