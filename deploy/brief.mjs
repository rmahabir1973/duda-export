// The design brief the AI Assistant gets when it builds a church's preview site from the exported ZIP.
// Pure text building (no I/O) so it can be tested. The mandate: build a modern, good-looking site on its own, choose the template and colours itself,
// and only ask a person when it truly cannot go on. A preview runs on its own; a full site may ask about duplicates and conflicts.

export const KEY_PAGES = ['Home', 'About', 'Worship or Services', 'Events', 'Contact', 'Ministries'];

/** Plain text of supporting documents, trimmed so the brief stays a sensible size. */
function docsBlock(docs) {
	const withText = (docs || []).filter((d) => d.text);
	const others = (docs || []).filter((d) => !d.text);
	const out = [];
	let room = 30000; // total characters of documents in one brief
	for (const d of withText) {
		const each = Math.max(1500, Math.min(12000, room));
		const t = String(d.text).slice(0, each);
		room -= t.length;
		out.push(`### ${d.name}\n${t}${String(d.text).length > t.length ? '\n[…shortened]' : ''}`);
	}
	if (others.length) out.push('Attached but could not be read (use only if the page text refers to them): ' + others.map((d) => d.name).join(', '));
	return out.length ? out.join('\n\n') : '';
}

export function buildBrief({ name, domain, platform, mode, notes, docs, existing }) {
	const preview = mode !== 'full';
	const extra = docsBlock(docs);
	const lines = [
		`# Build the website for ${name}`,
		'',
		'## Your mandate',
		`Build a **modern, welcoming, well-designed church website** for ${name}${domain ? ` (currently at ${domain}${platform ? `, built on ${platform}` : ''})` : ''} from the exported content package.`,
		'Use everything you know about church websites, good design and accessibility. Decide for yourself:',
		'- which template and page layouts suit this church (size, tone, denomination, how they describe themselves);',
		'- a colour scheme and fonts that fit them (use their existing logo and brand colours if the package shows them, otherwise choose well);',
		'- how to arrange the content so a first-time visitor finds service times, location, who they are and how to get in touch within seconds.',
		'',
		'## How to work',
		'- Work on your own from start to finish. Make sensible judgement calls and keep going.',
		'- **Only ask a person a question when you cannot go on without their help.** If you do ask, ask one clear question at a time, in plain words, and offer a suggested answer so they can reply with one click.',
		'- Nobody is watching this build live, so the usual advice to "plan first and wait for answers" does not apply. Choose the design (cwai__design-list, then apply it with your own colours if the church\'s brand colours suit), apply it, then build the pages one at a time without waiting.',
		'- Never delete anything. Build new pages as drafts, then publish the finished ones when the site is complete so the preview shows them.',
		'- Keep every real fact exactly as the church wrote it: times, addresses, names, phone numbers, email addresses. Never invent content. Where something is missing, leave it out rather than guess.',
		'- Do not use photos of identifiable people (members, children) unless the package clearly marks them as public-facing. Write real alt text for every image.',
		'- The site must be hidden from search engines (Preview Mode stays on) and use the simple staff view.',
		'',
		'## What to build',
	];
	if (preview) {
		lines.push(
			`This is a **preview** to show the church what is possible. Build only the key pages: ${KEY_PAGES.join(', ')}. If the package has no page for one of them, skip it.`,
			'Do not stop to ask about duplicates, extra pages or minor gaps. Pick the best version of anything repeated and move on.',
		);
	} else {
		if (existing) lines.push('A preview of this site already exists on this WordPress site: the key pages are built, the design (template, colours, fonts) is chosen and the header and footer are in place. **Keep that design and those pages exactly as they are, and add the rest of the site in the same style.** Do not rebuild or duplicate the pages that exist (check the existing pages first, then update them only if the package has clearly fuller content).', '');
		lines.push(
			'This is the **full site**. Build every page in the package.',
			'You may ask about things only the church can settle: pages that look like duplicates, pages that look out of date, or content that contradicts itself. Group these into as few questions as you can.',
		);
	}
	if (notes) lines.push('', '## Notes from our team', String(notes).slice(0, 2000));
	if (extra) lines.push('', '## Extra information supplied by the team', extra);
	lines.push(
		'', '## How to talk to the team (important)',
		'- If you truly need an answer from a person, end your message with a line starting `QUESTION:` followed by one clear question. Optionally add a next line starting `OPTIONS:` with up to 4 short suggested answers separated by `|`. Then stop.',
		'- When the whole site is built, end your message with a line starting `DONE:` followed by a short summary: pages built, the template and colours you chose, and anything a person should check.',
		'- Any other message means "keep going".',
	);
	return lines.join('\n');
}
