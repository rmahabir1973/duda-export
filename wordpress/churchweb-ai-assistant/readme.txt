=== ChurchWeb AI Assistant ===
Contributors: churchwebglobal
Requires at least: 6.5
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 1.15.0
License: GPLv2 or later

An AI web assistant inside WordPress for churches: build and edit Oxygen pages, menus, blog posts, sermons and Rank Math SEO by describing what you want.

== Description ==

Staff describe a change in plain English and the assistant makes it using the same tools as Claude Desktop (Oxygen Builder, WordPress menus, posts, media, sermons and Rank Math), with approval prompts for risky actions and one-click undo.

Bring your own Anthropic API key. Choose the model (Sonnet, Haiku, Opus or any custom model ID) in Settings.

See README.md for setup, fleet deployment constants, the safety model and known limits.

== Changelog ==

= 1.15.0 =
* New: Convert to PDF. Word, Excel, PowerPoint and OpenDocument files can be turned into PDFs from the Media Library (hover action and bulk action), from a Convert to PDF screen under the assistant's menu, or by asking the assistant ("make this week's bulletin a PDF and link it from the Bulletins page"). The conversion runs on the ChurchWeb portal with the site's existing key; files are not kept there. Override the portal with CWAI_PORTAL_URL in wp-config.php.

= 1.14.1 =
* Fixed: much lower AI cost on long builds. Old tool results were trimmed one message at a time on every step, which changed the already-cached conversation and made each step re-pay for it at the prompt-cache write price. They are now trimmed in larger steps, so the cached history stays the same between trims.

= 1.14.0 =
* Changed: the portal's one-click WP-Admin sign-in opens the admin in "View as staff" when the simple staff view is on, so the church's colours and menu show straight away. "Exit staff preview" in the top bar returns to the full admin.

= 1.13.0 =
* New: the portal can put the export ZIP and design brief on the server itself (over SSH) and the build imports them from there, so a site that can't reach the portal over HTTPS still builds. Questions are kept in the saved build state (wp cwai portal-status), and once the portal is found unreachable the build stops waiting on it.

= 1.12.0 =
* New: one-click sign-in from the portal. `wp cwai portal-login` prints a single-use link (valid for two minutes) that signs the first administrator in and opens the dashboard. Nothing is stored except a hashed one-time token.

= 1.11.0 =
* New: portal bridge. The ChurchWeb Portal can now check a site over HTTPS (GET /wp-json/cwai/v1/portal/ping, authenticated with the site's own AI key) and start a build over WP-CLI (wp cwai portal-build). A build downloads the exported package, imports the content and images, runs the assistant on its own from the design brief (it approves its own steps but never deletes), and reports progress, questions and the result back to the portal. The assistant ends a message with QUESTION: when it needs a person and DONE: when the site is built.

= 1.10.4 =
* New: the plugin now looks for updates every hour (WordPress itself only looks twice a day) and, when a verified newer version exists and automatic install is on, starts WordPress's own updater. The Settings page now says why automatic updates would not run (automatic install switched off, AUTOMATIC_UPDATER_DISABLED, or WordPress scheduled tasks disabled) and when the next check is due.

= 1.10.3 =
* Fix (Staff view): button text could still be invisible on some sites because another plugin's admin styles painted it in the button's own colour. Primary buttons now force their text colour, and a small check in the browser measures every visible button and corrects any whose text is hard to read, whatever caused it.

= 1.10.2 =
* Fix (Staff view): buttons could show no text until clicked, because the secondary-button colour also hit primary buttons. Disabled primary buttons keep WordPress's grey. Links and third-party buttons keep their own colours.
* Fix (Staff view): "Hide plugin notices" no longer hides the "new version available" row on the Plugins screen; it only hides notices at the top of a page.

= 1.10.1 =
* Fix: a new release now shows up as soon as you open the Plugins or Updates screen (the update answer is cached for an hour and re-checked when those screens open), instead of after up to six hours.

= 1.10.0 =
* New: Reset site (administrators): clear a site's pages, posts, content types, media, menus, terms, comments and the assistant's per-build data so it can be built again, in the trash or permanently, in batches with progress. Needs a backup tick and the site name typed, refuses launched sites, and never runs from the chat.
* Fix: the stock-photo search and the new pages also work on sites that use plain permalinks.

= 1.9.1 =
* Fix: editors can now use the assistant to build pages, edit menus and add content. For the length of one assistant action the editor gets administrator-level permission, except installing plugins or themes and managing users; administrator-only tools stay blocked. New setting "Let staff use the page-building, menu and media tools" (on by default). Editors can also set up Sermons, Events, Staff and Ministries sections (with an approval click).

= 1.9.0 =
* New: Staff view. Administrators give editors a simplified, branded WordPress admin: chosen left-menu items hidden, your logo top left, your colours, a big-button home screen, a branded login page, and "View as staff" to preview it. The assistant can change it too.

= 1.8.0 =
* New: Activity page with a readable history of every change and one-click Undo, plus today's usage.
* New: Site health check (alt text, large images, search listings, placeholder text, broken links, launch basics) as a page and an assistant tool.
* New: Routines, saved one-click instructions such as the weekly update from the bulletin; the assistant can save new ones.
* New: Go live page and tools: preview mode (banner and noindex), launch checklist, one-click launch and a reversible old-address swap.
* Gateway: per-site usage tracking and optional daily caps.

= 1.7.1 =
* Test release to confirm the update channel works.

= 1.7.0 =
* New: signed plugin updates delivered through the gateway, with checksum verification, a Check for updates link, an auto-update setting and staged rollouts.

= 1.6.0 =
* New: Website chatbot for visitors, with a knowledge base the assistant manages (tools for knowledge, settings, unanswered questions and testing), page-linked knowledge that refreshes, rate limits and a daily cap.

= 1.5.0 =
* New: Stock photos (Pexels, Pixabay) and AI image generation (gateway or OpenAI) from an Images page and as assistant tools; the New website wizard can let the assistant fill missing pictures.

= 1.4.0 =
* New: New website wizard (details, one of 25 designs, images with roles, page list) that hands a full brief to the assistant.
* Change: in the chat, Enter now adds a new line; Ctrl/Cmd+Enter or Send sends. A checkbox switches Enter back to sending.

= 1.3.0 =
* Import: the export now carries the old site brand colours (from its logo and CSS); the assistant offers them as custom colours when choosing a design.

= 1.2.1 =
* Fix: asking for the chosen design before one is chosen is no longer shown as an error.

= 1.2.0 =
* New: Design gallery with 25 designs (5 families x 5 palettes), custom colours, and assistant tools that build the site in the chosen design.

= 1.1.0 =
* New: Import site. Upload a DUDA export ZIP, import its images/documents into the Media Library and let the assistant rebuild the old pages one by one with saved progress.

= 1.0.0 =
* Initial release.
