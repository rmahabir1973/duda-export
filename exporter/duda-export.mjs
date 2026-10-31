#!/usr/bin/env node
/**
 * duda-export: pull a DUDA site into a ZIP package (Markdown pages, blog, images, documents, brief).
 *
 *   node duda-export.mjs --domain www.example.org [--site <duda_site_name>] [--out ./exports]
 *
 * Page text is taken from the rendered page DOM by code (no AI summarising), so it is verbatim.
 * DUDA access is optional: DUDA_MCP_TOKEN (+ DUDA_MCP_URL, default https://mcp.duda.co/mcp) or DUDA_API_USER / DUDA_API_PASS and add: draft/hidden pages, the
 * content library (official contact data), blog metadata (author, dates, tags), collections.
 */
import { chromium } from 'playwright';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import archiver from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* ------------------------------------------------------------------ args */
const argv = process.argv.slice(2);
const opt = { concurrency: 3, 'max-pages': 0, 'max-image-mb': 25, 'max-doc-mb': 50, out: './exports' };
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (!a.startsWith('--')) continue;
	const k = a.slice(2);
	const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
	opt[k] = v;
}
if (opt.help || (!opt.domain && !opt.site)) {
	console.log(`Usage: node duda-export.mjs --domain www.example.org [options]
  --domain <host>       Live domain of the DUDA site (required unless --site and a published default domain is found)
  --site <name>         DUDA site_name (enables API enrichment with DUDA_API_USER / DUDA_API_PASS)
  --find-site           With API credentials: look up --site from --domain automatically
  --out <dir>           Output folder (default ./exports)
  --max-pages <n>       Only crawl the first n pages (testing)
  --only </a,/b>        Only export these paths (comma separated), e.g. to re-run a few pages
  --concurrency <n>     Parallel browser pages (default 3)
  --include-noindex     Also export pages marked noindex (default: exported but flagged)
  --skip-images         Do not download images/documents
  --max-image-mb <n>    Skip images above this size (default 25)
  --max-doc-mb <n>      Skip documents above this size (default 50)
  --channel chrome      Use the Chrome/Edge already installed instead of downloading Playwright's browser (or set CHROMIUM_PATH)
  --api-base <url>      Override DUDA API base (default https://api.duda.co/api)`);
	process.exit(opt.help ? 0 : 1);
}

const API_BASE = (opt['api-base'] || process.env.DUDA_API_BASE || 'https://api.duda.co/api').replace(/\/$/, '');
const API_USER = process.env.DUDA_API_USER;
const API_PASS = process.env.DUDA_API_PASS;
const MCP_URL = (process.env.DUDA_MCP_URL || '').trim();
const MCP_TOKEN = (process.env.DUDA_MCP_TOKEN || '').trim();
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 DudaExport/1.0';
const NOW_YEAR = new Date().getFullYear();

/* ------------------------------------------------------------------ utils */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const slugify = (s) =>
	String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'page';
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 70) || 'file';
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
const yq = (v) => JSON.stringify(v ?? '');

async function pool(items, n, fn) {
	let i = 0;
	const workers = Array.from({ length: Math.max(1, n) }, async () => {
		while (i < items.length) {
			const idx = i++;
			await fn(items[idx], idx);
		}
	});
	await Promise.all(workers);
}

async function httpGet(url, { binary = false, timeout = 30000, headers = {} } = {}) {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), timeout);
	try {
		const r = await fetch(url, { headers: { 'user-agent': UA, ...headers }, redirect: 'follow', signal: ctl.signal });
		const body = binary ? Buffer.from(await r.arrayBuffer()) : await r.text();
		return { status: r.status, ok: r.ok, type: r.headers.get('content-type') || '', body, url: r.url };
	} finally {
		clearTimeout(t);
	}
}

/* ------------------------------------------------------------------ DUDA API (optional) */
const hasMcp = Boolean(MCP_TOKEN);
const hasRest = Boolean(API_USER && API_PASS);
const hasApi = hasMcp || hasRest;

// --- DUDA MCP client (streamable HTTP, JSON-RPC). Same data as the REST API, authenticated with the account MCP token.
let mcpSession = null, mcpId = 0, mcpAuth = null;
async function mcpPost(body, { retryAuth = true } = {}) {
	const url = MCP_URL || 'https://mcp.duda.co/mcp';
	const authVariants = mcpAuth ? [mcpAuth] : [MCP_TOKEN, 'Bearer ' + MCP_TOKEN];
	let lastErr;
	for (const auth of authVariants) {
		const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: auth, 'user-agent': UA };
		if (mcpSession) headers['mcp-session-id'] = mcpSession;
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), 60000);
		try {
			const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
			if (r.status === 401 || r.status === 403) {
				lastErr = new Error(`DUDA MCP HTTP ${r.status} (check DUDA_MCP_TOKEN)`);
				continue;
			}
			mcpAuth = auth;
			const sid = r.headers.get('mcp-session-id');
			if (sid) mcpSession = sid;
			const text = await r.text();
			if (!r.ok && r.status !== 202) throw new Error(`DUDA MCP HTTP ${r.status}`);
			if (!text.trim()) return null;
			const ct = r.headers.get('content-type') || '';
			let msgs = [];
			if (/text\/event-stream/.test(ct)) {
				for (const ev of text.split(/\n\n+/)) {
					const data = ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
					if (data) try { msgs.push(JSON.parse(data)); } catch {}
				}
			} else {
				const j = JSON.parse(text);
				msgs = Array.isArray(j) ? j : [j];
			}
			return msgs.find((m) => m.id === body.id) || msgs[0] || null;
		} finally {
			clearTimeout(t);
		}
	}
	throw lastErr || new Error('DUDA MCP authentication failed');
}
async function mcpInit() {
	if (mcpSession !== null) return;
	const r = await mcpPost({ jsonrpc: '2.0', id: ++mcpId, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'duda-export', version: '1.1' } } });
	if (r?.error) throw new Error('DUDA MCP initialize: ' + (r.error.message || JSON.stringify(r.error)));
	if (!mcpSession) mcpSession = '';
	await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {});
}
async function mcpTool(name, args) {
	await mcpInit();
	const r = await mcpPost({ jsonrpc: '2.0', id: ++mcpId, method: 'tools/call', params: { name, arguments: args } });
	if (!r) throw new Error(`DUDA MCP ${name}: empty response`);
	if (r.error) throw new Error(`DUDA MCP ${name}: ${r.error.message || JSON.stringify(r.error)}`);
	const txt = (r.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
	if (r.result?.isError) throw new Error(`DUDA MCP ${name}: ${txt.slice(0, 200)}`);
	try {
		return JSON.parse(txt);
	} catch {
		return txt;
	}
}
// Map the REST-style paths used below onto MCP tools (the JSON shapes are the same).
async function apiMcp(p) {
	let m;
	if ((m = p.match(/^\/sites\/multiscreen\/([^/?]+)\/pages/))) return mcpTool('list_pages', { site_name: m[1] });
	if ((m = p.match(/^\/sites\/multiscreen\/([^/?]+)\/content/))) return mcpTool('get_content_library', { site_name: m[1] });
	if ((m = p.match(/^\/sites\/multiscreen\/([^/?]+)\/blog\/posts\?limit=(\d+)&offset=(\d+)/))) return mcpTool('list_blog_posts', { site_name: m[1], limit: Number(m[2]), offset: Number(m[3]) });
	if ((m = p.match(/^\/sites\/multiscreen\/([^/?]+)\/collection/))) return mcpTool('get_collections', { site_name: m[1] });
	if ((m = p.match(/^\/sites\/multiscreen\/([^/?]+)$/))) return mcpTool('get_site_details', { site_name: m[1], fields: ['*'] });
	throw new Error('unsupported MCP mapping ' + p);
}

async function api(p) {
	if (hasMcp) return apiMcp(p);
	const r = await httpGet(API_BASE + p, {
		headers: { authorization: 'Basic ' + Buffer.from(`${API_USER}:${API_PASS}`).toString('base64'), accept: 'application/json' },
	});
	if (!r.ok) throw new Error(`DUDA API ${p} -> HTTP ${r.status}`);
	return JSON.parse(r.body);
}
const list = (x) => (Array.isArray(x) ? x : x?.results || x?.sites || x?.items || []);

async function findSiteByDomain(domain) {
	if (hasMcp) {
		const r = await mcpTool('get_site_details', { domain, fields: ['site_name'] });
		return (typeof r === 'object' && r?.site_name) || null;
	}
	const host = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*/, '').toLowerCase();
	for (let off = 0; off < 5000; off += 100) {
		const page = list(await api(`/sites/multiscreen?limit=100&offset=${off}`));
		for (const s of page) {
			if (JSON.stringify(s).toLowerCase().includes(host)) return s.site_name;
		}
		if (page.length < 100) break;
	}
	return null;
}

/* ------------------------------------------------------------------ in-page extractor (runs in the browser) */
function extractInPage() {
	const IMG_EXT = /\.(?:jpe?g|png|gif|webp|svg|avif)(?:[?#]|$)/i;
	const DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|rtf|txt|csv|zip|mp3|m4a|wav|mp4|mov)(?:[?#]|$)/i;
	const abs = (u) => {
		try {
			return new URL(u, location.href).href;
		} catch {
			return null;
		}
	};
	const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const escA = (s) => esc(s).replace(/"/g, '&quot;');
	const cf = (hex) => {
		const k = parseInt(hex.slice(0, 2), 16);
		let o = '';
		for (let i = 2; i < hex.length; i += 2) o += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k);
		return o;
	};
	const skip = 'script,style,noscript,template,svg,nav,header,footer,.dmPopup,[class*="dmHeader"],[class*="dmFooter"],[id*="cookie" i],[class*="cookie" i],[class*="dmAdminOnly"]';
	const root = document.querySelector('#dm_content') || document.querySelector('main') || document.body;
	const imgs = [], docs = [], embeds = [], forms = [], links = [], out = [];
	const KEEP = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'blockquote', 'strong', 'b', 'em', 'i', 'br', 'hr', 'pre', 'code', 'sup', 'sub', 'figure', 'figcaption']);
	const BLOCKISH = new Set(['div', 'section', 'article', 'aside', 'main', 'center', 'dl', 'dt', 'dd']);

	function bestImg(img) {
		let u = null;
		const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset');
		if (ss) {
			let bw = -1;
			ss.split(',').forEach((p) => {
				const [url, d] = p.trim().split(/\s+/);
				const w = parseFloat(d) || 0;
				if (url && w >= bw) {
					bw = w;
					u = url;
				}
			});
		}
		u = u || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
		if (!u || u.startsWith('data:')) u = img.currentSrc || img.getAttribute('src');
		return u && !u.startsWith('data:') ? abs(u) : null;
	}
	function pushImg(url, alt, how) {
		if (!url) return;
		imgs.push({ url, alt: alt || '', how });
		out.push(`<img src="${escA(url)}" alt="${escA(alt || '')}">`);
	}

	function walk(el) {
		if (el.nodeType === 3) {
			out.push(esc(el.nodeValue));
			return;
		}
		if (el.nodeType !== 1) return;
		const tag = el.tagName.toLowerCase();
		if (tag === 'iframe') {
			const s = abs(el.getAttribute('src') || el.getAttribute('data-src') || '');
			if (s && !s.startsWith('about:') && !/disqus\.com|facebook\.com\/v[\d.]+\/plugins\/comments|google\.com\/recaptcha|staticxx\.facebook/i.test(s)) {
				embeds.push(s);
				out.push(`<p>[EMBED: ${esc(s)}]</p>`);
			}
			return;
		}
		if (el.matches(skip)) return;
		const cs = getComputedStyle(el);
		if (cs.display === 'none' || el.hasAttribute('hidden')) return;

		if (tag === 'img') {
			pushImg(bestImg(el), el.getAttribute('alt'), 'img');
			return;
		}
		if (tag === 'video' || tag === 'audio') {
			const s = abs(el.getAttribute('src') || el.querySelector('source')?.getAttribute('src') || '');
			if (s) {
				embeds.push(s);
				out.push(`<p>[${tag.toUpperCase()}: ${esc(s)}]</p>`);
			}
			return;
		}
		if (tag === 'form') {
			const fields = [...el.querySelectorAll('input,textarea,select')].filter((f) => !['hidden', 'submit', 'button'].includes(f.type)).map((f) => (f.getAttribute('aria-label') || f.getAttribute('placeholder') || f.name || f.type || '').trim()).filter(Boolean);
			forms.push(fields);
			out.push(`<p>[FORM with fields: ${esc(fields.join(', ') || 'unknown')}]</p>`);
			return;
		}
		// background images (hero banners, galleries)
		const bg = cs.backgroundImage;
		if (bg && bg.includes('url(')) {
			for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
				const u = abs(m[1]);
				if (u && !u.startsWith('data:') && IMG_EXT.test(u)) pushImg(u, '', 'background');
			}
		}
		// full-size images held in attributes (lightbox/gallery plugins)
		for (const a of ['data-image-url', 'data-full', 'data-large', 'data-zoom-image', 'data-fullsize']) {
			const v = el.getAttribute(a);
			if (v && IMG_EXT.test(v)) pushImg(abs(v), el.getAttribute('title') || '', 'attr');
		}

		if (tag === 'a') {
			let href = el.getAttribute('href') || '';
			const cfm = href.match(/email-protection#([0-9a-f]+)/i);
			if (cfm) href = 'mailto:' + cf(cfm[1]);
			const full = href.startsWith('mailto:') || href.startsWith('tel:') ? href : abs(href);
			const inner = el.querySelector('img');
			let selfLink = false;
			try {
				selfLink = Boolean(full && full.startsWith('http') && new URL(full).pathname.replace(/\/$/, '') === location.pathname.replace(/\/$/, ''));
			} catch {}
			if (inner && !el.textContent.trim() && (selfLink || href === '' || href === '#')) {
				el.childNodes.forEach(walk);
				return;
			}
			if (inner && full && IMG_EXT.test(full) && !el.textContent.trim()) {
				pushImg(full, inner.getAttribute('alt'), 'lightbox');
				return;
			}
			if (full && DOC_EXT.test(full)) docs.push({ url: full, text: el.textContent.trim() });
			if (full) links.push(full);
			out.push(`<a href="${escA(full || '#')}">`);
			el.childNodes.forEach(walk);
			out.push('</a>');
			return;
		}
		if (tag === 'span' || tag === 'font' || tag === 'u') {
			const bold = parseInt(cs.fontWeight, 10) >= 600, ital = cs.fontStyle === 'italic';
			if (bold) out.push('<strong>');
			if (ital) out.push('<em>');
			el.childNodes.forEach(walk);
			if (ital) out.push('</em>');
			if (bold) out.push('</strong>');
			return;
		}
		if (el.hasAttribute('data-cfemail')) {
			out.push(esc(cf(el.getAttribute('data-cfemail'))));
			return;
		}
		if (tag === 'br' || tag === 'hr') {
			out.push(`<${tag}>`);
			return;
		}
		if (KEEP.has(tag)) {
			out.push(`<${tag}>`);
			el.childNodes.forEach(walk);
			out.push(`</${tag}>`);
			return;
		}
		if (BLOCKISH.has(tag) || true) {
			out.push('<div>');
			el.childNodes.forEach(walk);
			out.push('</div>');
		}
	}
	walk(root);

	// navigation (used for the home page only)
	function navTree(ul) {
		return [...ul.children].filter((li) => li.tagName === 'LI').map((li) => {
			const a = li.querySelector(':scope > a');
			const sub = li.querySelector(':scope > ul');
			return { text: (a?.textContent || '').trim().replace(/\s+/g, ' '), href: a ? abs(a.getAttribute('href') || '') : null, children: sub ? navTree(sub) : [] };
		}).filter((n) => n.text);
	}
	let nav = null;
	const navEl = document.querySelector('#unifiedNav ul, nav ul, [class*="dmNav"] ul, ul[class*="nav"]');
	if (navEl) nav = navTree(navEl);

	const cssOf = (sel, prop) => {
		const e = document.querySelector(sel);
		return e ? getComputedStyle(e)[prop] : null;
	};
	const design = {
		body_bg: getComputedStyle(document.body).backgroundColor,
		body_color: getComputedStyle(document.body).color,
		body_font: getComputedStyle(document.body).fontFamily,
		h1_font: cssOf('#dm_content h1, h1', 'fontFamily'),
		h1_color: cssOf('#dm_content h1, h1', 'color'),
		h2_color: cssOf('#dm_content h2, h2', 'color'),
		link_color: cssOf('#dm_content a, a', 'color'),
		button_bg: cssOf('.dmButtonLink, a[class*="button" i], .dmWidget a, button', 'backgroundColor'),
		button_color: cssOf('.dmButtonLink, a[class*="button" i], .dmWidget a, button', 'color'),
		header_bg: cssOf('#hcontainer, .dmHeaderContainer, header', 'backgroundColor'),
		footer_bg: cssOf('.dmFooterContainer, footer', 'backgroundColor'),
	};
	const footerText = (document.querySelector('.dmFooterContainer, footer')?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
	const headerLogo = document.querySelector('.dmHeaderContainer img, #hcontainer img, header img');
	const metaC = (n) => document.querySelector(`meta[name="${n}"],meta[property="${n}"]`)?.getAttribute('content') || '';

	return {
		html: out.join(''),
		text: (root.innerText || '').trim(),
		title: document.title,
		h1: (root.querySelector('h1')?.innerText || '').trim(),
		pageTitle: (document.querySelector('#pageTitleText')?.innerText || '').trim().replace(/\s+/g, ' '),
		description: metaC('description'),
		robots: metaC('robots'),
		ogImage: metaC('og:image'),
		canonical: document.querySelector('link[rel=canonical]')?.href || '',
		lang: document.documentElement.lang || '',
		passwordForm: Boolean(root.querySelector('input[type=password]')),
		imgs, docs, embeds, forms, links, nav, design, footerText,
		logo: headerLogo ? { url: bestImg(headerLogo), alt: headerLogo.getAttribute('alt') || '' } : null,
		editor: document.querySelector('#dmRoot, .dmRoot') ? 'legacy-advanced' : (document.querySelector('[data-flex-site], .flex-element') ? 'flex' : 'unknown'),
	};
}

async function autoScroll(page) {
	await page.evaluate(async () => {
		await new Promise((res) => {
			let y = 0;
			const step = () => {
				window.scrollTo(0, y);
				y += 700;
				if (y < document.body.scrollHeight + 700 && y < 40000) setTimeout(step, 120);
				else {
					window.scrollTo(0, 0);
					res();
				}
			};
			step();
		});
	});
}

/* ------------------------------------------------------------------ media helpers */
const isDudaCdn = (u) => /(^|\.)((irp|lirp|irp-cdn|static)\.)?(cdn-website\.com|multiscreensite\.com)$/i.test(new URL(u).hostname);
function imageCandidates(u) {
	u = u.replace(/(?<!:)\/{2,}/g, '/').replace(/#.*$/, '');
	const list = [];
	const m = u.match(/^(https?:\/\/[^/]+\/[^/]+\/dms3rep\/multi\/)(?:opt\/)?(.+?)(?:-(\d+)([wh]))?\.(jpe?g|png|gif|webp)(\?.*)?$/i);
	if (m) {
		list.push(`${m[1]}opt/${m[2]}-1920w.${m[5]}`);
		list.push(`${m[1]}${m[2]}.${m[5]}`);
	}
	list.push(u);
	return [...new Set(list)];
}
const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'application/pdf': 'pdf' };
function wantAsset(u, siteHost) {
	try {
		const h = new URL(u).hostname;
		const pth = new URL(u).pathname;
		return h === siteHost || h.replace(/^www\./, '') === siteHost.replace(/^www\./, '') || (isDudaCdn(u) && (/\/dms3rep\//.test(u) || (/^(irp|lirp|irp-cdn|vid)\./i.test(h) && /^\/[a-z0-9]{8}\/[^/]+/i.test(pth))));
	} catch {
		return false;
	}
}

/* ------------------------------------------------------------------ main */
const domain = String(opt.domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
let siteName = opt.site && opt.site !== true ? String(opt.site) : null;
const base = `https://${domain}`;
const siteHost = domain;
const stamp = domain.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-');
const outDir = path.resolve(String(opt.out), `${stamp}-duda-export`);
fs.rmSync(outDir, { recursive: true, force: true });
for (const d of ['pages', 'blog', 'images', 'documents', 'data']) fs.mkdirSync(path.join(outDir, d), { recursive: true });

const flags = [];
const flag = (severity, where, issue, detail = '') => flags.push({ severity, where, issue, detail });

log(`\nDUDA export for ${domain}\n  output: ${outDir}\n  API: ${hasMcp ? 'enabled (DUDA MCP)' : hasRest ? 'enabled (REST)' : 'off (set DUDA_MCP_TOKEN or DUDA_API_USER / DUDA_API_PASS for drafts, content library and blog metadata)'}`);

/* 1. inventory ---------------------------------------------------- */
const inv = new Map(); // normalized path -> record
const normPath = (p) => {
	let x = p.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0].replace(/\/+$/, '');
	return x === '' ? '/' : (x.startsWith('/') ? x : '/' + x);
};
const addInv = (p, rec) => {
	const k = normPath(p);
	inv.set(k, { path: k, ...(inv.get(k) || {}), ...rec });
};

let contentLibrary = null, blogMeta = [], collections = null, siteDetails = null, apiNote = '';
if (hasApi) {
	try {
		if (!siteName && (opt['find-site'] || hasMcp)) siteName = await findSiteByDomain(domain);
		if (siteName) {
			siteDetails = await api(`/sites/multiscreen/${siteName}`).catch((e) => (flag('warn', 'api', 'site details failed', e.message), null));
			for (const pg of list(await api(`/sites/multiscreen/${siteName}/pages`).catch((e) => (flag('warn', 'api', 'pages failed', e.message), [])))) {
				addInv(pg.path === 'home' ? '/' : pg.path, { title: pg.title, uuid: pg.uuid, draft: pg.draft_status, noindex: Boolean(pg.seo?.no_index), api: true, kind: 'page' });
			}
			contentLibrary = await api(`/sites/multiscreen/${siteName}/content`).catch((e) => (flag('warn', 'api', 'content library failed', e.message), null));
			for (let off = 0; off < 5000; off += 50) {
				const r = await api(`/sites/multiscreen/${siteName}/blog/posts?limit=50&offset=${off}`).catch(() => null);
				const rs = list(r);
				if (!rs.length) break;
				blogMeta.push(...rs);
				if (rs.length < 50) break;
			}
			for (const b of blogMeta) addInv(b.path, { title: b.title, kind: 'blog', blog: b, api: true });
			collections = await api(`/sites/multiscreen/${siteName}/collection`).catch(() => null);
			apiNote = `API site_name ${siteName}`;
		} else flag('warn', 'api', opt['find-site'] ? 'No DUDA site matched that domain' : 'No --site given', 'API enrichment skipped. Pass --site <site_name> (it is in the DUDA editor URL).');
	} catch (e) {
		flag('warn', 'api', 'API unavailable', e.message);
	}
}

// sitemap (works with or without the API)
try {
	const sm = await httpGet(`${base}/sitemap.xml`);
	if (sm.ok) {
		const locs = [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
		let nested = 0;
		for (const loc of locs) {
			if (/\.xml(\?|$)/i.test(loc)) {
				const sub = await httpGet(loc);
				if (sub.ok) for (const m of sub.body.matchAll(/<loc>([^<]+)<\/loc>/g)) addInv(m[1], { inSitemap: true });
				nested++;
			} else addInv(loc, { inSitemap: true });
		}
		for (const m of sm.body.matchAll(/<loc>([^<]+)<\/loc>[\s\S]*?<lastmod>([^<]+)<\/lastmod>/g)) addInv(m[1], { lastmod: m[2] });
	} else flag('warn', 'sitemap', `sitemap.xml returned HTTP ${sm.status}`, 'Only API pages (if enabled) and the home page will be crawled.');
} catch (e) {
	flag('warn', 'sitemap', 'sitemap fetch failed', e.message);
}
if (!inv.has('/')) addInv('/', { kind: 'page', inSitemap: false });
if (inv.get('/')) inv.get('/').kind ||= 'page';

let queue = [...inv.values()];
queue.sort((a, b) => (a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path)));
if (opt.only && opt.only !== true) {
	const want = new Set(String(opt.only).split(',').map((x) => normPath(x.trim())));
	queue = queue.filter((q) => want.has(q.path));
}
if (Number(opt['max-pages']) > 0) queue = queue.slice(0, Number(opt['max-pages']));
log(`  pages to crawl: ${queue.length} (${queue.filter((q) => q.kind === 'blog').length} blog posts from API)`);

/* 2. crawl -------------------------------------------------------- */
const browser = await chromium.launch({
	...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
	...(opt.channel && opt.channel !== true ? { channel: String(opt.channel) } : {}),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA, ignoreHTTPSErrors: true });
const results = [];
let navTree = null, design = null, footerText = '', logo = null, editor = 'unknown';
let done = 0;
await pool(queue, Number(opt.concurrency), async (rec) => {
	const url = base + (rec.path === '/' ? '/' : rec.path);
	const page = await context.newPage();
	try {
		let resp = null;
		for (let attempt = 0; attempt < 2 && !resp; attempt++) {
			try {
				resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
			} catch (e) {
				if (attempt) throw e;
				await sleep(1500);
			}
		}
		await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
		const status = resp ? resp.status() : 0;
		// DUDA renders content after load: wait until the content area's text is non-empty and stable
		let last = -1, stable = 0;
		for (let i = 0; i < 20 && stable < 3; i++) {
			const n = await page.evaluate(() => ((document.querySelector('#dm_content') || document.querySelector('main') || document.body).innerText || '').length).catch(() => 0);
			stable = n > 0 && n === last ? stable + 1 : 0;
			last = n;
			await page.waitForTimeout(400);
		}
		await autoScroll(page).catch(() => {});
		await page.waitForTimeout(500);
		let x = await page.evaluate(extractInPage);
		for (let retry = 0; retry < 2 && (x.text.match(/\S+/g) || []).length < 25 && !x.passwordForm; retry++) {
			await page.waitForTimeout(3000);
			await autoScroll(page).catch(() => {});
			const y = await page.evaluate(extractInPage);
			if (y.text.length > x.text.length) x = y;
		}
		results.push({ rec, status, finalUrl: page.url(), ...x });
		if (rec.path === '/') ({ nav: navTree, design, footerText, logo, editor } = x);
	} catch (e) {
		results.push({ rec, status: 0, error: String(e.message || e).split('\n')[0] });
		flag('error', rec.path, 'crawl failed', String(e.message || e).split('\n')[0]);
	} finally {
		await page.close();
		done++;
		if (done % 10 === 0 || done === queue.length) log(`  crawled ${done}/${queue.length}`);
	}
});
await browser.close();
results.sort((a, b) => (a.rec.path === '/' ? -1 : b.rec.path === '/' ? 1 : a.rec.path.localeCompare(b.rec.path)));

/* 3. media -------------------------------------------------------- */
const mediaMap = []; // {source, final, file, bytes, kind, pages[]}
const byFinal = new Map(), byHash = new Map(), usedNames = new Set();
const failedMedia = [];
async function fetchAsset(source, kind, pageSlug, idx, maxMb) {
	const key = kind + '|' + source;
	if (byFinal.has(key)) return byFinal.get(key);
	const cands = kind === 'image' ? imageCandidates(source) : [source.replace(/(?<!:)\/{2,}/g, '/')];
	for (const c of cands) {
		try {
			const r = await httpGet(c, { binary: true, timeout: 60000 });
			if (!r.ok || !r.body.length) continue;
			if (kind === 'image' && !/^image\//i.test(r.type) && !/\.(jpe?g|png|gif|webp|svg|avif)(\?|$)/i.test(c)) continue;
			if (r.body.length > maxMb * 1048576) {
				failedMedia.push({ source, reason: `larger than ${maxMb} MB (${(r.body.length / 1048576).toFixed(1)} MB)` });
				byFinal.set(key, null);
				return null;
			}
			if (kind === 'image' && r.body.length < 1200 && !/svg/i.test(r.type)) {
				failedMedia.push({ source, reason: 'tiny image skipped (probably an icon)', info: true });
				byFinal.set(key, null);
				return null;
			}
			const hash = crypto.createHash('sha1').update(r.body).digest('hex');
			if (byHash.has(hash)) {
				byFinal.set(key, byHash.get(hash));
				byHash.get(hash).sources.push(source);
				return byHash.get(hash);
			}
			let name = decodeURIComponent(path.basename(new URL(c).pathname)).replace(/-(\d+)[wh](?=\.[a-z0-9]+$)/i, '');
			let ext = (path.extname(name).slice(1) || EXT_BY_TYPE[r.type.split(';')[0]] || 'bin').toLowerCase();
			if (kind === 'image' && EXT_BY_TYPE[r.type.split(';')[0]]) ext = EXT_BY_TYPE[r.type.split(';')[0]];
			const stem = safeName(name.replace(/\.[^.]+$/, ''));
			let fname = kind === 'image' ? `${pageSlug}-${String(idx).padStart(2, '0')}-${stem}.${ext}` : `${stem}.${ext}`;
			for (let n = 2; usedNames.has(kind + fname); n++) fname = fname.replace(/(-\d+)?(\.[^.]+)$/, `-${n}$2`);
			usedNames.add(kind + fname);
			fs.writeFileSync(path.join(outDir, kind === 'image' ? 'images' : 'documents', fname), r.body);
			const m = { kind, source, sources: [source], final: c, file: `${kind === 'image' ? 'images' : 'documents'}/${fname}`, bytes: r.body.length, pages: [] };
			mediaMap.push(m);
			byHash.set(hash, m);
			byFinal.set(key, m);
			return m;
		} catch {
			/* try next candidate */
		}
	}
	failedMedia.push({ source, reason: 'download failed' });
	byFinal.set(key, null);
	return null;
}

const pageSlugs = new Map();
const usedSlugs = new Set();
for (const r of results) {
	const seg = r.rec.path === '/' ? 'home' : r.rec.path.split('/').filter(Boolean).pop();
	let s = slugify(seg);
	for (let n = 2; usedSlugs.has(s); n++) s = `${slugify(seg)}-${n}`;
	usedSlugs.add(s);
	pageSlugs.set(r.rec.path, s);
	r.slug = s;
}
const externalImages = [];
const JUNK_IMG = /marker-icon|marker-shadow|leaflet|spacer|blank\.gif|1x1|pixel|loading\.gif|\/dm\/images\//i;
if (!opt['skip-images']) {
	log('  downloading images and documents...');
	const jobs = [];
	for (const r of results) {
		if (!r.imgs) continue;
		let i = 0;
		const seen = new Set();
		for (const im of r.imgs) {
			if (seen.has(im.url)) continue;
			seen.add(im.url);
			if (JUNK_IMG.test(im.url)) continue;
			if (!wantAsset(im.url, siteHost)) {
				externalImages.push({ page: r.rec.path, url: im.url });
				continue;
			}
			jobs.push({ r, kind: 'image', url: im.url, idx: ++i, alt: im.alt });
		}
		for (const d of r.docs || []) if (wantAsset(d.url, siteHost) || isDudaCdn(d.url)) jobs.push({ r, kind: 'doc', url: d.url, idx: 0, text: d.text });
		if (r.rec.path === '/' && r.logo?.url && wantAsset(r.logo.url, siteHost)) jobs.push({ r, kind: 'image', url: r.logo.url, idx: 0, alt: r.logo.alt, logo: true });
		const fi = r.rec.blog?.main_image?.url || r.rec.blog?.thumbnail?.url;
		if (fi && wantAsset(fi, siteHost)) jobs.push({ r, kind: 'image', url: fi, idx: 0, alt: r.rec.blog?.thumbnail?.alt_text || '', featured: true });
	}
	await pool(jobs, 6, async (j) => {
		const m = await fetchAsset(j.url, j.kind === 'image' ? 'image' : 'document', j.r.slug, j.idx, j.kind === 'image' ? Number(opt['max-image-mb']) : Number(opt['max-doc-mb']));
		j.r.assets ||= {};
		j.r.assets[j.url] = m;
		if (m) {
			m.pages.push(j.r.rec.path);
			m.alt ||= j.alt || '';
			m.docText ||= j.text || '';
			if (j.logo) m.isLogo = true;
		}
	});
}
const resolveAsset = (r, u) => r.assets?.[u] || byFinal.get('image|' + u) || byFinal.get('document|' + u) || null;

/* 4. markdown ------------------------------------------------------ */
const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', strongDelimiter: '**', linkStyle: 'inlined' });
td.use(gfm);
const hostRe = new RegExp(`^https?://(www\\.)?${domain.replace(/^www\./, '').replace(/\./g, '\\.')}`, 'i');
const md = (html, r) => {
	const svc = td;
	svc.rules.array.length; // keep reference
	const rewritten = html
		.replace(/<img src="([^"]*)" alt="([^"]*)">/g, (m0, src, alt) => {
			const u = src.replace(/&amp;/g, '&');
			const a = resolveAsset(r, u);
			return a ? `<img src="${a.file}" alt="${alt}">` : `<img src="${src}" alt="${alt}" data-external="1">`;
		})
		.replace(/<a href="([^"]*)">/g, (m0, href) => {
			const u = href.replace(/&amp;/g, '&');
			const a = resolveAsset(r, u);
			if (a && a.kind === 'document') return `<a href="${a.file}">`;
			if (hostRe.test(u)) return `<a href="${normPath(u)}${(u.match(/#.*$/) || [''])[0]}">`;
			return m0;
		});
	return svc.turndown(rewritten).replace(/\[([\s|·•\-–—,;:/]+)\]\([^)]*\)/g, '$1').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
};

const emailsSeen = new Map(), phonesSeen = new Map();
const noteContacts = (r) => {
	const t = (r.text || '') + ' ' + (r.links || []).join(' ');
	for (const m of t.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
		const e = m[0].toLowerCase().replace(/^mailto:/, '');
		(emailsSeen.get(e) || emailsSeen.set(e, new Set()).get(e)).add(r.rec.path);
	}
	for (const m of (r.text || '').matchAll(/(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g)) {
		const ph = m[0].replace(/^\s+/, '');
		(phonesSeen.get(ph) || phonesSeen.set(ph, new Set()).get(ph)).add(r.rec.path);
	}
};

const navTitles = new Map();
(function walkNav(n) { for (const x of n || []) { if (x.href) navTitles.set(normPath(x.href), x.text); walkNav(x.children); } })(navTree);
const manifest = [];
const redirects = [['old_path', 'new_path', 'note']];
const suggest = (rec, title, words, r) => {
	if (/\b(practice|test page|sample page|copy of|draft|untitled|blank page)\b/i.test(`${title} ${rec.path}`)) return ['delete', 'looks like a practice/test page'];
	const yr = (`${title} ${rec.path}`.match(/\b(19|20)\d{2}\b/g) || []).map(Number).filter((y) => y <= NOW_YEAR).sort((a, b) => b - a)[0];
	if (yr && yr <= NOW_YEAR - 2) return ['archive', `year ${yr} in title/path`];
	if (words < 25) return ['review', 'very little text'];
	return ['migrate', ''];
};
const pagesOut = [];
for (const r of results) {
	const rec = r.rec;
	if (r.error || !r.html) {
		manifest.push({ path: rec.path, status: r.status || 'error', note: r.error || 'empty' });
		continue;
	}
	if (r.status >= 400) {
		flag(r.status === 401 || r.status === 403 ? 'warn' : 'error', rec.path, `HTTP ${r.status}`, rec.draft ? `API says draft: ${rec.draft}` : '');
		manifest.push({ path: rec.path, status: r.status });
		continue;
	}
	if (r.passwordForm) flag('warn', rec.path, 'password-protected or contains a password field', 'content may be incomplete');
	noteContacts(r);
	const human = (rec.path === '/' ? 'Home' : decodeURIComponent(rec.path.split('/').filter(Boolean).pop()).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
	const title = (rec.title || r.pageTitle || navTitles.get(rec.path) || r.h1 || human).trim();
	let body = md(r.html, r);
	const firstLine = body.split('\n').find((l) => l.trim()) || '';
	if (!/^#\s/.test(firstLine) || firstLine.replace(/^#\s+/, '').trim().toLowerCase() !== title.toLowerCase()) {
		if (/^#\s/.test(firstLine)) body = body.replace(/^#\s+(.*)$/m, (m0, t) => (t.trim().toLowerCase() === title.toLowerCase() ? m0 : `# ${title}\n\n## ${t}`));
		else body = `# ${title}\n\n${body}`;
	}
	const words = (r.text.match(/\S+/g) || []).length;
	const [action, why] = suggest(rec, title, words, r);
	const years = (r.text.match(/\b(19|20)\d{2}\b/g) || []).map(Number).filter((y) => y <= NOW_YEAR + 1);
	if (years.length && Math.max(...years) <= NOW_YEAR - 2 && words > 30) flag('info', rec.path, 'dated content', `newest year mentioned: ${Math.max(...years)}`);
	if (r.forms.length) flag('info', rec.path, `${r.forms.length} form(s)`, r.forms.map((f) => f.join('/')).join(' | '));
	if (r.embeds.length) flag('info', rec.path, 'embedded media/widgets', r.embeds.slice(0, 5).join(' '));
	const images = [...new Set((r.imgs || []).map((i) => resolveAsset(r, i.url)).filter(Boolean))].map((a) => ({ file: a.file, alt: a.alt || '' }));
	const docs = [...new Set((r.docs || []).map((d) => resolveAsset(r, d.url)).filter(Boolean))].map((a) => ({ file: a.file, text: a.docText || '' }));
	const slug = r.slug;
	const isBlog = rec.kind === 'blog';
	const newPath = rec.path === '/' ? '/' : `/${slugify(rec.path.split('/').filter(Boolean).pop())}/`;
	if (rec.path !== '/' && rec.path !== newPath.replace(/\/$/, '') && rec.path + '/' !== newPath) redirects.push([rec.path, newPath, 'slug changes (case/punctuation)']);
	const fm = [
		'---',
		`title: ${yq(title)}`,
		`type: ${isBlog ? 'blog-post' : 'page'}`,
		`old_url: ${yq(base + (rec.path === '/' ? '/' : rec.path))}`,
		`old_path: ${yq(rec.path)}`,
		`suggested_slug: ${yq(rec.path === '/' ? 'home' : slugify(rec.path.split('/').filter(Boolean).pop()))}`,
		`suggested_action: ${action}${why ? ` # ${why}` : ''}`,
		`meta_description: ${yq(r.description || rec.blog?.description || '')}`,
		`noindex: ${Boolean(rec.noindex || /noindex/i.test(r.robots))}`,
		`last_modified: ${yq(rec.lastmod || '')}`,
		...(isBlog ? [`published: ${yq(rec.blog?.publish_date || '')}`, `author: ${yq(rec.blog?.author_name || '')}`, `tags: ${yq(rec.blog?.tags || [])}`, `featured_image: ${yq((resolveAsset(r, rec.blog?.main_image?.url || '') || resolveAsset(r, rec.blog?.thumbnail?.url || '') || {}).file || '')}`] : []),
		`word_count: ${words}`,
		`images: ${yq(images)}`,
		`documents: ${yq(docs)}`,
		`embeds: ${yq(r.embeds)}`,
		'---',
		'',
	].join('\n');
	const full = fm + body + '\n';
	const dir = isBlog ? 'blog' : 'pages';
	const prefix = isBlog ? `${(rec.blog?.publish_date || rec.lastmod || '0000').slice(0, 10)}-` : `${String(pagesOut.length + 1).padStart(3, '0')}-`;
	const chunks = [];
	if (full.length <= 30000) chunks.push(full);
	else {
		// split on headings so each file stays under the assistant's 40k-character attachment limit
		const parts = body.split(/\n(?=#{1,3}\s)/);
		let cur = '';
		for (const p of parts) {
			if ((cur + '\n' + p).length > 26000 && cur) {
				chunks.push(cur);
				cur = '';
			}
			cur += (cur ? '\n' : '') + p;
		}
		if (cur) chunks.push(cur);
		chunks.forEach((c, i) => (chunks[i] = fm.replace('---\n', `---\npart: "${i + 1} of ${chunks.length}"\n`) + c + '\n'));
	}
	chunks.forEach((c, i) => fs.writeFileSync(path.join(outDir, dir, `${prefix}${slug}${chunks.length > 1 ? `-part${i + 1}` : ''}.md`), c));
	pagesOut.push({ path: rec.path, slug, title, kind: rec.kind || 'page', words, images: images.length, docs: docs.length, action, why, noindex: Boolean(rec.noindex), draft: rec.draft || '', lastmod: rec.lastmod || '', inSitemap: Boolean(rec.inSitemap), parts: chunks.length });
	manifest.push({ path: rec.path, status: r.status, file: `${dir}/${prefix}${slug}.md` });
	if (words < 25 && action !== 'delete') flag('warn', rec.path, 'very little text', 'check the live page: content may be images, a widget or a gallery');
}

/* 5. data files ---------------------------------------------------- */
fs.writeFileSync(path.join(outDir, 'data/pages.json'), JSON.stringify(pagesOut, null, 2));
fs.writeFileSync(path.join(outDir, 'data/images.csv'), csv([['file', 'kind', 'source_url', 'bytes', 'alt_text_from_duda', 'used_on_pages', 'document_link_text'], ...mediaMap.map((m) => [m.file, m.kind, m.sources[0], m.bytes, m.alt || '', [...new Set(m.pages)].join(' '), m.docText || ''])]));
fs.writeFileSync(path.join(outDir, 'data/media-map.json'), JSON.stringify(mediaMap.map((m) => ({ file: m.file, sources: m.sources, final: m.final })), null, 2));
fs.writeFileSync(path.join(outDir, 'data/redirects.csv'), csv(redirects));
fs.writeFileSync(path.join(outDir, 'data/flags.csv'), csv([['severity', 'where', 'issue', 'detail'], ...flags.map((f) => [f.severity, f.where, f.issue, f.detail]), ...failedMedia.map((f) => [f.info ? 'info' : 'warn', f.source, 'media not downloaded', f.reason])]));
fs.writeFileSync(path.join(outDir, 'data/external-images.csv'), csv([['page', 'url'], ...externalImages.map((e) => [e.page, e.url])]));
fs.writeFileSync(path.join(outDir, 'data/nav.json'), JSON.stringify(navTree, null, 2));
if (contentLibrary) fs.writeFileSync(path.join(outDir, 'data/content-library.json'), JSON.stringify(contentLibrary, null, 2));
if (blogMeta.length) fs.writeFileSync(path.join(outDir, 'data/blog-index.json'), JSON.stringify(blogMeta, null, 2));
if (collections) fs.writeFileSync(path.join(outDir, 'data/collections.json'), JSON.stringify(collections, null, 2));
fs.writeFileSync(path.join(outDir, 'data/manifest.json'), JSON.stringify(manifest, null, 2));

/* 6. brief + prompts + README -------------------------------------- */
const navLines = (n, d = 0) => (n || []).flatMap((x) => [`${'  '.repeat(d)}- ${x.text}${x.href ? ` (${normPath(x.href)})` : ''}`, ...navLines(x.children, d + 1)]);
const cl = contentLibrary?.location_data || {};
const emailRows = [...emailsSeen.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 30);
const phoneRows = [...phonesSeen.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 15);
const counts = { migrate: 0, archive: 0, delete: 0, review: 0 };
pagesOut.forEach((p) => (counts[p.action] = (counts[p.action] || 0) + 1));
const imgCount = mediaMap.filter((m) => m.kind === 'image').length, docCount = mediaMap.filter((m) => m.kind === 'document').length;
const brief = `# Site brief: ${domain}

Exported ${new Date().toISOString().slice(0, 10)} from the live DUDA site by duda-export. ${apiNote ? apiNote + '. ' : 'No API credentials were used (public pages and sitemap only). '}Editor type detected: ${siteDetails?.editor || editor}.

## At a glance
- Pages exported: ${pagesOut.filter((p) => p.kind !== 'blog').length}; blog posts: ${pagesOut.filter((p) => p.kind === 'blog').length}; images: ${imgCount}; documents: ${docCount}
- Suggested actions: migrate ${counts.migrate}, archive ${counts.archive}, delete ${counts.delete}, review ${counts.review} (suggestions only: a person decides)
- Flags needing attention: ${flags.filter((f) => f.severity !== 'info').length + failedMedia.filter((f) => !f.info).length} (see data/flags.csv)

## Contact details found
${contentLibrary ? '' : '(No API credentials, so the DUDA content library is not included; use the footer text and the numbers seen below.)\n'}${cl.address_geolocation ? `- Address (DUDA content library): ${cl.address_geolocation}\n` : ''}${(cl.phones || []).map((p) => `- Phone (content library): ${p.phoneNumber}`).join('\n')}
${(cl.emails || []).map((e) => `- Email (content library): ${e.emailAddress}`).join('\n')}

Phone numbers seen in page text (pages that contain them):
${phoneRows.map(([p, s]) => `- ${p} (${s.size} page${s.size > 1 ? 's' : ''})`).join('\n') || '- none'}

Email addresses seen on pages (confirm which are public before publishing):
${emailRows.map(([e, s]) => `- ${e} (${s.size} page${s.size > 1 ? 's' : ''})`).join('\n') || '- none'}

Footer text on the old site:
\`\`\`
${footerText || '(none found)'}
\`\`\`

## Navigation on the old site
${navLines(navTree).join('\n') || '(not detected)'}

## Look and feel observed on the old site (for reference only)
${design ? Object.entries(design).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '(not captured)'}
${logo?.url ? `- Logo: ${(resolveAsset(results[0] || {}, logo.url) || {}).file || logo.url}` : ''}

## Page inventory
| # | Old path | Title | Words | Images | Docs | Suggested | Notes |
|---|----------|-------|------:|-------:|-----:|-----------|-------|
${pagesOut.map((p, i) => `| ${i + 1} | ${p.path} | ${p.title.replace(/\|/g, '/')} | ${p.words} | ${p.images} | ${p.docs} | ${p.action} | ${[p.why, p.kind === 'blog' ? 'blog' : '', p.noindex ? 'noindex' : '', p.draft && p.draft !== 'PUBLISHED' ? p.draft : ''].filter(Boolean).join('; ')} |`).join('\n')}

## Things a person must check
${[...flags.filter((f) => f.severity !== 'info').slice(0, 60).map((f) => `- [${f.severity}] ${f.where}: ${f.issue}${f.detail ? ' (' + f.detail + ')' : ''}`), ...failedMedia.filter((f) => !f.info).slice(0, 20).map((f) => `- [warn] media: ${f.source} (${f.reason})`)].join('\n') || '- nothing flagged'}

## Notes on how this was extracted
- Text comes straight from the rendered page (no AI paraphrasing), but old DUDA pages often style text instead of using real headings, so "headings" may appear as bold text. Rebuild structure with judgement.
- Images are named \`<page>-<nn>-<original name>\`. DUDA alt text is usually empty: write real alt text when placing images.
- Pages marked "archive" or "delete" are still exported so nothing is lost; do not rebuild them without confirming with the church.
`;
fs.writeFileSync(path.join(outDir, 'site-brief.md'), brief);

fs.writeFileSync(path.join(outDir, 'assistant-prompts.md'), `# Using this package with the ChurchWeb AI Assistant

## Before you start (one-time, about 5 minutes)
1. In the new WordPress site go to **Media -> Add New** and drag in everything from the \`images/\` and \`documents/\` folders. File names become the media titles, so the assistant can find each picture by name.
2. Open the assistant (AI Assistant in the menu). Attach **site-brief.md**.

## Prompt 1: plan (attach site-brief.md)
> Read the attached site brief for the old church website. Do not build anything yet. Summarise the church's contact details and tell me which phone numbers and email addresses you would use (list any conflicts). Propose a page structure and menu based on the old navigation and the "Suggested" column, and list anything that needs a decision from me.

Answer its questions, then continue.

## Prompt 2: build one page (attach ONE file from \`pages/\`; up to 6 files at once works but one at a time gives the best result)
> Build this old page as a **draft** page on the new site. Keep the wording exactly as in the file (fix obvious typos only and tell me what you changed). Use the images listed in the file's front matter: find each one in the media library by its file name and place it sensibly, and write descriptive alt text. Keep the same style as the pages already built. Link documents to the uploaded files. Use the suggested slug. Set the SEO title and description (use the meta_description in the file if it is good). Tell me anything you could not do.

## Prompt 3: blog posts (attach up to 6 files from \`blog/\`)
> Create each attached blog post as a draft post with its original published date, the featured image named in the file, and a sensible category. Keep the wording exactly.

## Prompt 4: menu
> Rebuild the main menu to match the navigation in the site brief, using the new pages. Show me the structure before you apply it.

## Prompt 5: redirects (attach data/redirects.csv)
> Create a 301 redirect for every row in this file where the new page exists, and list any rows you could not match.

## Prompt 6: check
> Audit the SEO of every page we built and fix what you can. Then list any page from the brief that is still missing.

Tips: work one section at a time (about, worship, ministries...). Never rebuild pages marked archive or delete without asking the church first. Pages with \`[EMBED: ...]\`, \`[FORM ...]\` markers need those widgets recreated: ask the assistant what it can do and what must be set up by hand.
`);

fs.writeFileSync(path.join(outDir, 'README.md'), `# ${domain}: DUDA export

Generated by duda-export. Start with **site-brief.md** and **assistant-prompts.md**.

- \`pages/\` one Markdown file per page (front matter has old URL, suggested slug, images, documents)
- \`blog/\` one file per blog post (original date, author, tags, featured image)
- \`images/\` and \`documents/\` everything downloaded from the DUDA CDN (highest resolution available)
- \`data/\` machine-readable: pages.json, images.csv, media-map.json (old URL -> file), redirects.csv, flags.csv, nav.json, content-library.json (API only), blog-index.json (API only)
`);

/* 7. zip ------------------------------------------------------------ */
const zipPath = path.resolve(String(opt.out), `${stamp}-duda-export.zip`);
await new Promise((resolve, reject) => {
	const output = fs.createWriteStream(zipPath);
	const arc = archiver('zip', { zlib: { level: 6 } });
	output.on('close', resolve);
	arc.on('error', reject);
	arc.pipe(output);
	arc.directory(outDir, `${stamp}-duda-export`);
	arc.finalize();
});
log(`\nDone.\n  pages: ${pagesOut.length}  images: ${imgCount}  documents: ${docCount}  flags: ${flags.filter((f) => f.severity !== 'info').length + failedMedia.filter((f) => !f.info).length}\n  folder: ${outDir}\n  ZIP:    ${zipPath} (${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB)`);
