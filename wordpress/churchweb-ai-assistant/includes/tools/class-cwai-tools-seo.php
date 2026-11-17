<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Rank Math SEO tools. Per-page SEO is stored in Rank Math's own post meta, so it
 * works with Rank Math exactly as if it had been typed into its editor panel.
 */
final class CWAI_Tools_SEO {

	const META = array(
		'title'            => 'rank_math_title',
		'description'      => 'rank_math_description',
		'focus_keyword'    => 'rank_math_focus_keyword',
		'canonical'        => 'rank_math_canonical_url',
		'og_title'         => 'rank_math_facebook_title',
		'og_description'   => 'rank_math_facebook_description',
		'og_image'         => 'rank_math_facebook_image',
		'og_image_id'      => 'rank_math_facebook_image_id',
		'breadcrumb_title' => 'rank_math_breadcrumb_title',
	);

	const OPTIONS = array(
		'titles'  => 'rank-math-options-titles',
		'general' => 'rank-math-options-general',
		'sitemap' => 'rank-math-options-sitemap',
	);

	public static function register() {
		$p = array( 'CWAI_Tools_Content', 'p' );
		$s = array( 'CWAI_Tools_Content', 'schema' );

		$set_props = array(
			'post_id'          => call_user_func( $p, 'integer', 'Page/post/sermon ID.' ),
			'title'            => call_user_func( $p, 'string', 'SEO title shown in Google, up to 60 characters. Written literally (include the church name if wanted), or use %title% %sep% %sitename%.' ),
			'description'      => call_user_func( $p, 'string', 'Meta description, 120–155 characters, written for a person.' ),
			'focus_keyword'    => call_user_func( $p, 'string', 'Primary focus keyword/phrase (add up to 4 more separated by commas).' ),
			'canonical'        => call_user_func( $p, 'string', 'Canonical URL (rarely needed).' ),
			'noindex'          => call_user_func( $p, 'boolean', 'true hides the page from search engines.' ),
			'nofollow'         => call_user_func( $p, 'boolean', 'true tells search engines not to follow links.' ),
			'og_title'         => call_user_func( $p, 'string', 'Facebook/social share title.' ),
			'og_description'   => call_user_func( $p, 'string', 'Social share description.' ),
			'og_image_id'      => call_user_func( $p, 'integer', 'Media ID for the social share image.' ),
			'breadcrumb_title' => call_user_func( $p, 'string', 'Breadcrumb label.' ),
		);

		CWAI_Registry::add( 'cwai/seo-get', array(
			'label' => 'Read SEO settings', 'description' => 'Read a page\'s Rank Math SEO fields (title, description, focus keyword, robots, social) plus the final resolved title and lengths.',
			'input' => call_user_func( $s, array( 'post_id' => call_user_func( $p, 'integer', 'Post ID.' ) ), array( 'post_id' ) ),
			'callback' => array( __CLASS__, 'get' ), 'readonly' => true,
		) );
		CWAI_Registry::add( 'cwai/seo-set', array(
			'label' => 'Set SEO', 'description' => 'Set Rank Math SEO for one page/post/sermon. Only fields you pass change. Returns warnings about lengths. Per-page schema markup is handled by Rank Math defaults (see cwai__seo-settings-get).',
			'input' => call_user_func( $s, $set_props, array( 'post_id' ) ),
			'callback' => array( __CLASS__, 'set' ),
			'touches' => static function ( $in ) {
				return array( (int) ( $in['post_id'] ?? 0 ) );
			},
		) );
		CWAI_Registry::add( 'cwai/seo-bulk-set', array(
			'label' => 'Set SEO for many pages', 'description' => 'Set SEO fields for up to 40 items in one call.',
			'input' => call_user_func( $s, array( 'items' => array( 'type' => 'array', 'description' => 'Each item has post_id plus any seo-set fields.', 'items' => array( 'type' => 'object', 'properties' => $set_props, 'required' => array( 'post_id' ) ) ) ), array( 'items' ) ),
			'callback' => array( __CLASS__, 'bulk_set' ),
			'touches' => static function ( $in ) {
				return array_map( static function ( $i ) {
					return (int) ( $i['post_id'] ?? 0 );
				}, (array) ( $in['items'] ?? array() ) );
			},
		) );
		CWAI_Registry::add( 'cwai/seo-audit', array(
			'label' => 'SEO audit of a page', 'description' => 'Audit a live page the way a visitor/search engine sees it (including Oxygen output): title and description length, focus keyword placement (title, description, URL, intro, headings, image alt), heading structure, word count, image alt text, internal/external links, schema, indexability. Returns passed checks, prioritized issues with concrete fixes, and a 0–100 score. Rank Math\'s own editor score is not updated by this tool.',
			'input' => call_user_func( $s, array( 'post_id' => call_user_func( $p, 'integer', 'Post ID.' ), 'url' => call_user_func( $p, 'string', 'Or a URL on this site.' ) ) ),
			'callback' => array( __CLASS__, 'audit' ), 'readonly' => true,
		) );
		CWAI_Registry::add( 'cwai/seo-find-issues', array(
			'label' => 'Find SEO gaps across the site', 'description' => 'Site-wide SEO check. With issue="summary" returns counts of published items missing a description or focus keyword, noindexed items, and badly sized descriptions. Otherwise lists the affected items so you can fix them with cwai__seo-bulk-set.',
			'input' => call_user_func( $s, array(
				'issue'     => call_user_func( $p, 'string', 'summary, missing_description, missing_focus_keyword, noindex or description_length.', array( 'enum' => array( 'summary', 'missing_description', 'missing_focus_keyword', 'noindex', 'description_length' ) ) ),
				'post_type' => call_user_func( $p, 'string', 'Post type (default page, post and sermons).' ),
				'per_page'  => call_user_func( $p, 'integer', 'Max 50, default 30.' ),
				'page'      => call_user_func( $p, 'integer', 'Page number.' ),
			) ),
			'callback' => array( __CLASS__, 'find_issues' ), 'readonly' => true,
		) );
		CWAI_Registry::add( 'cwai/seo-redirects', array(
			'label' => 'Redirects (Rank Math)', 'description' => 'List, add or remove Rank Math redirections (for example when a page was moved/renamed). Requires Rank Math\'s Redirections module. Removing asks for approval.',
			'input' => call_user_func( $s, array(
				'action' => call_user_func( $p, 'string', 'list, create or remove.', array( 'enum' => array( 'list', 'create', 'remove' ) ) ),
				'from'   => call_user_func( $p, 'string', 'Old path like /old-page/ (create).' ),
				'to'     => call_user_func( $p, 'string', 'New URL or path (create).' ),
				'type'   => call_user_func( $p, 'integer', '301 (default), 302 or 307.' ),
				'id'     => call_user_func( $p, 'integer', 'Redirection ID (remove).' ),
			), array( 'action' ) ),
			'callback' => array( __CLASS__, 'redirects' ), 'capability' => 'edit_pages',
			'approval' => static function ( $in ) {
				return 'remove' === ( $in['action'] ?? '' );
			},
		) );
		CWAI_Registry::add( 'cwai/seo-settings-get', array(
			'label' => 'Read Rank Math site settings', 'description' => 'Read global Rank Math settings: option "titles" (home page title/description, title templates per type, separator, social defaults, Local SEO/church business details, default schema types), "general", or "sitemap". Pass keys to read a subset.',
			'input' => call_user_func( $s, array(
				'option' => call_user_func( $p, 'string', 'titles, general or sitemap.', array( 'enum' => array( 'titles', 'general', 'sitemap' ) ) ),
				'keys'   => call_user_func( $p, 'array', 'Optional list of keys.', array( 'items' => array( 'type' => 'string' ) ) ),
			), array( 'option' ) ),
			'callback' => array( __CLASS__, 'settings_get' ), 'readonly' => true, 'admin' => true, 'capability' => 'manage_options',
		) );
		CWAI_Registry::add( 'cwai/seo-settings-set', array(
			'label' => 'Change Rank Math site settings', 'description' => 'ADMIN. Change global Rank Math settings, e.g. homepage_title, homepage_description, title templates (pt_page_title), knowledgegraph_name/logo, local business details for a church. ALWAYS read the option with cwai__seo-settings-get first and change only keys that exist there. Each key you pass replaces that key\'s whole value. The person is asked to approve.',
			'input' => call_user_func( $s, array(
				'option'  => call_user_func( $p, 'string', 'titles, general or sitemap.', array( 'enum' => array( 'titles', 'general', 'sitemap' ) ) ),
				'changes' => call_user_func( $p, 'object', 'Key/value pairs to set.' ),
			), array( 'option', 'changes' ) ),
			'callback' => array( __CLASS__, 'settings_set' ), 'admin' => true, 'approval' => true, 'capability' => 'manage_options',
		) );
	}

	/* ------------------------------------------------------------------ */

	/** 'active' | 'not_connected' | 'missing' */
	public static function state() {
		if ( ! defined( 'RANK_MATH_VERSION' ) ) {
			return 'missing';
		}
		if ( class_exists( 'RankMath\\Helper' ) && is_callable( array( 'RankMath\\Helper', 'is_plugin_ready' ) ) && ! \RankMath\Helper::is_plugin_ready() ) {
			return 'not_connected';
		}
		return 'active';
	}

	public static function active() {
		return 'active' === self::state();
	}

	public static function state_note() {
		switch ( self::state() ) {
			case 'missing':
				return 'Rank Math is not installed, so SEO values are saved but have no effect until it is installed and activated.';
			case 'not_connected':
				return 'Rank Math is installed but not connected to a Rank Math account (Rank Math → Dashboard → Connect, or "Skip" registration), so it is not yet adding SEO tags to pages.';
		}
		return '';
	}

	private static function titles_opt() {
		$o = get_option( self::OPTIONS['titles'], array() );
		return is_array( $o ) ? $o : array();
	}

	public static function resolve_title( WP_Post $p ) {
		$raw = (string) get_post_meta( $p->ID, self::META['title'], true );
		if ( '' === $raw ) {
			$o   = self::titles_opt();
			$raw = (string) ( $o[ 'pt_' . $p->post_type . '_title' ] ?? '%title% %sep% %sitename%' );
		}
		$o   = self::titles_opt();
		$sep = (string) ( $o['title_separator'] ?? '-' );
		$map = array( '%title%' => get_the_title( $p ), '%sep%' => $sep, '%sitename%' => get_bloginfo( 'name' ), '%sitedesc%' => get_bloginfo( 'description' ), '%page%' => '', '%pagenumber%' => '', '%currentyear%' => wp_date( 'Y' ) );
		$out = strtr( $raw, $map );
		$out = preg_replace( '/%[a-z_0-9()\-]+%/i', '', $out );
		return trim( preg_replace( '/\s+/', ' ', $out ) );
	}

	public static function get( $in ) {
		$p = get_post( (int) ( $in['post_id'] ?? 0 ) );
		if ( ! $p || ! current_user_can( 'edit_post', $p->ID ) ) {
			return new WP_Error( 'cwai_nf', 'Content not found.' );
		}
		$out = array( 'post_id' => $p->ID, 'rank_math_active' => self::active(), 'rank_math_state' => self::state(), 'url' => get_permalink( $p ) );
		foreach ( self::META as $k => $meta ) {
			$out[ $k ] = get_post_meta( $p->ID, $meta, true );
		}
		$robots            = get_post_meta( $p->ID, 'rank_math_robots', true );
		$out['robots']     = is_array( $robots ) ? $robots : array();
		$out['noindex']    = in_array( 'noindex', $out['robots'], true );
		$out['resolved_title'] = self::resolve_title( $p );
		$out['title_length']   = mb_strlen( $out['resolved_title'] );
		$out['description_length'] = mb_strlen( (string) $out['description'] );
		$out['rank_math_score'] = get_post_meta( $p->ID, 'rank_math_seo_score', true );
		return $out;
	}

	public static function set( $in ) {
		$id = (int) ( $in['post_id'] ?? 0 );
		$p  = get_post( $id );
		if ( ! $p || ! current_user_can( 'edit_post', $id ) ) {
			return new WP_Error( 'cwai_nf', 'Content not found or not editable.' );
		}
		$warn    = array();
		$changed = array();
		foreach ( array( 'title', 'description', 'canonical', 'og_title', 'og_description', 'breadcrumb_title' ) as $k ) {
			if ( array_key_exists( $k, $in ) ) {
				$v = 'canonical' === $k ? esc_url_raw( (string) $in[ $k ] ) : sanitize_text_field( (string) $in[ $k ] );
				update_post_meta( $id, self::META[ $k ], wp_slash( $v ) );
				$changed[] = $k;
			}
		}
		if ( array_key_exists( 'focus_keyword', $in ) ) {
			$kw = is_array( $in['focus_keyword'] ) ? implode( ',', $in['focus_keyword'] ) : (string) $in['focus_keyword'];
			$kw = implode( ',', array_slice( array_filter( array_map( 'trim', explode( ',', sanitize_text_field( $kw ) ) ) ), 0, 5 ) );
			update_post_meta( $id, self::META['focus_keyword'], wp_slash( $kw ) );
			$changed[] = 'focus_keyword';
		}
		if ( ! empty( $in['og_image_id'] ) && 'attachment' === get_post_type( (int) $in['og_image_id'] ) ) {
			update_post_meta( $id, self::META['og_image_id'], (int) $in['og_image_id'] );
			update_post_meta( $id, self::META['og_image'], wp_get_attachment_url( (int) $in['og_image_id'] ) );
			$changed[] = 'og_image';
		}
		if ( array_key_exists( 'noindex', $in ) || array_key_exists( 'nofollow', $in ) ) {
			$cur = get_post_meta( $id, 'rank_math_robots', true );
			$cur = is_array( $cur ) ? $cur : array();
			$set = static function ( array $list, $add, $remove ) {
				$list = array_diff( $list, $remove );
				if ( $add ) {
					$list[] = $add;
				}
				return array_values( array_unique( $list ) );
			};
			if ( array_key_exists( 'noindex', $in ) ) {
				$cur = $in['noindex'] ? $set( $cur, 'noindex', array( 'index' ) ) : $set( $cur, 'index', array( 'noindex' ) );
			}
			if ( array_key_exists( 'nofollow', $in ) ) {
				$cur = $in['nofollow'] ? $set( $cur, 'nofollow', array() ) : $set( $cur, '', array( 'nofollow' ) );
			}
			update_post_meta( $id, 'rank_math_robots', array_values( array_filter( $cur ) ) );
			$changed[] = 'robots';
		}

		$desc_len = mb_strlen( (string) get_post_meta( $id, self::META['description'], true ) );
		if ( in_array( 'description', $changed, true ) ) {
			if ( $desc_len > 160 ) {
				$warn[] = "Description is $desc_len characters; Google usually cuts it at about 155–160.";
			} elseif ( $desc_len < 70 ) {
				$warn[] = "Description is short ($desc_len characters); 120–155 works best.";
			}
		}
		if ( in_array( 'title', $changed, true ) || in_array( 'description', $changed, true ) ) {
			$tl = mb_strlen( self::resolve_title( $p ) );
			if ( $tl > 60 ) {
				$warn[] = "The final page title is $tl characters; keep it under about 60.";
			}
		}
		if ( self::state_note() ) {
			$warn[] = self::state_note();
		}
		return array( 'post_id' => $id, 'changed' => $changed, 'warnings' => $warn, 'seo' => self::get( array( 'post_id' => $id ) ) );
	}

	public static function bulk_set( $in ) {
		$out = array();
		foreach ( array_slice( (array) ( $in['items'] ?? array() ), 0, 40 ) as $item ) {
			$r     = self::set( (array) $item );
			$out[] = is_wp_error( $r ) ? array( 'post_id' => $item['post_id'] ?? 0, 'error' => $r->get_error_message() ) : array( 'post_id' => $r['post_id'], 'changed' => $r['changed'], 'warnings' => $r['warnings'] );
		}
		return array( 'results' => $out );
	}

	/* ------------------------------------------------------------------ */
	/* Audit                                                               */
	/* ------------------------------------------------------------------ */

	public static function audit( $in ) {
		$post = null;
		$url  = '';
		if ( ! empty( $in['post_id'] ) ) {
			$post = get_post( (int) $in['post_id'] );
			if ( ! $post || ! current_user_can( 'edit_post', $post->ID ) ) {
				return new WP_Error( 'cwai_nf', 'Content not found.' );
			}
			$url = get_permalink( $post );
		} elseif ( ! empty( $in['url'] ) ) {
			$url  = esc_url_raw( $in['url'] );
			$pid  = url_to_postid( $url );
			$post = $pid ? get_post( $pid ) : null;
		} else {
			return new WP_Error( 'cwai_args', 'Give post_id or url.' );
		}

		$fetched = CWAI_Tools_Site::fetch_html( $url );
		$live    = ! is_wp_error( $fetched ) && 200 === $fetched['code'];
		$html    = $live ? $fetched['html'] : ( $post ? apply_filters( 'the_content', $post->post_content ) : '' );
		$notes   = array();
		if ( ! $live ) {
			$notes[] = 'The live page could not be fetched (' . ( is_wp_error( $fetched ) ? $fetched->get_error_message() : 'HTTP ' . $fetched['code'] ) . '; drafts are not public). The audit used the stored body text only, so builder content, title tag and schema are not checked.';
		}
		if ( '' === trim( $html ) ) {
			return new WP_Error( 'cwai_empty', 'Nothing to audit: the page has no readable content.' );
		}

		$d = new DOMDocument();
		libxml_use_internal_errors( true );
		$d->loadHTML( '<?xml encoding="utf-8" ?>' . $html );
		libxml_clear_errors();
		$x = new DOMXPath( $d );

		$txt = static function ( $q ) use ( $x ) {
			$n = $x->query( $q );
			return $n && $n->length ? trim( preg_replace( '/\s+/', ' ', $n->item( 0 )->textContent ) ) : '';
		};
		$attr = static function ( $q, $a ) use ( $x ) {
			$n = $x->query( $q );
			return $n && $n->length ? trim( (string) $n->item( 0 )->getAttribute( $a ) ) : '';
		};

		$title = $live ? $txt( '//title' ) : ( $post ? self::resolve_title( $post ) : '' );
		$desc  = $live ? $attr( '//meta[@name="description"]', 'content' ) : ( $post ? (string) get_post_meta( $post->ID, self::META['description'], true ) : '' );
		$robots = strtolower( $attr( '//meta[@name="robots"]', 'content' ) );
		$canon  = $attr( '//link[@rel="canonical"]', 'href' );
		$h1s    = array();
		foreach ( $x->query( '//h1' ) as $h ) {
			$h1s[] = trim( preg_replace( '/\s+/', ' ', $h->textContent ) );
		}
		$h2s = array();
		foreach ( $x->query( '//h2|//h3' ) as $h ) {
			$h2s[] = trim( preg_replace( '/\s+/', ' ', $h->textContent ) );
		}
		foreach ( $x->query( '//script|//style|//noscript|//nav|//header|//footer|//template' ) as $n ) {
			$n->parentNode->removeChild( $n ); // phpcs:ignore
		}
		$main = $x->query( '//main' )->length ? $x->query( '//main' )->item( 0 ) : ( $x->query( '//body' )->length ? $x->query( '//body' )->item( 0 ) : $d->documentElement );
		$text = trim( preg_replace( '/\s+/', ' ', $main ? $main->textContent : '' ) );
		$words = str_word_count( $text );

		$imgs = $x->query( '//img' );
		$noalt = 0;
		$kw_alt = false;
		$kw = '';
		if ( $post ) {
			$kw = trim( explode( ',', (string) get_post_meta( $post->ID, self::META['focus_keyword'], true ) )[0] );
		}
		foreach ( $imgs as $im ) {
			$alt = trim( (string) $im->getAttribute( 'alt' ) );
			if ( '' === $alt ) {
				$noalt++;
			} elseif ( $kw && false !== mb_stripos( $alt, $kw ) ) {
				$kw_alt = true;
			}
		}
		$host = wp_parse_url( home_url(), PHP_URL_HOST );
		$int = 0;
		$ext = 0;
		foreach ( $x->query( '//a[@href]' ) as $a ) {
			$h = $a->getAttribute( 'href' );
			if ( preg_match( '#^(\#|mailto:|tel:|javascript:)#i', $h ) ) {
				continue;
			}
			$ah = wp_parse_url( $h, PHP_URL_HOST );
			( ! $ah || $ah === $host ) ? $int++ : $ext++;
		}
		$schema = 0;
		if ( $live ) {
			$schema = preg_match_all( '#<script[^>]+application/ld\+json#i', $html );
		}

		$pass   = array();
		$issues = array();
		$chk    = static function ( $ok, $good, $sev, $bad, $fix ) use ( &$pass, &$issues ) {
			if ( $ok ) {
				$pass[] = $good;
			} else {
				$issues[] = array( 'severity' => $sev, 'problem' => $bad, 'fix' => $fix );
			}
		};
		$tl = mb_strlen( $title );
		$dl = mb_strlen( $desc );
		$chk( $tl >= 25 && $tl <= 62, "Title length OK ($tl)", 'high', "Title is $tl characters", 'Aim for 30–60 characters (cwai__seo-set title).' );
		$chk( $dl >= 110 && $dl <= 162, "Description length OK ($dl)", 'high', "Meta description is $dl characters" . ( 0 === $dl ? ' (missing)' : '' ), 'Write 120–155 characters that make someone want to click (cwai__seo-set description).' );
		$chk( 1 === count( $h1s ), 'Exactly one H1', 'high', count( $h1s ) . ' H1 headings found', 'Use exactly one H1 describing the page; make other headings H2/H3 (oxygen__edit-post).' );
		$chk( count( $h2s ) >= 2 || $words < 300, 'Sub-headings used', 'medium', 'Few or no H2/H3 sub-headings', 'Break content into sections with H2 headings.' );
		$min = ( $post && 'post' === $post->post_type ) ? 600 : 250;
		$chk( $words >= $min, "Enough content ($words words)", 'medium', "Only $words words of content", "Add useful detail; about $min+ words suits this type of page." );
		$chk( 0 === $noalt, 'All images have alt text', 'medium', "$noalt image(s) without alt text", 'Add alt text (cwai__update-media, or the image element in Oxygen).' );
		$chk( $int >= 2 || $words < 200, "Internal links present ($int)", 'medium', 'Very few internal links', 'Link to related pages (visit us, ministries, contact).' );
		$chk( false === strpos( $robots, 'noindex' ), 'Page is indexable', 'high', 'Page is set to NOINDEX', 'If unintended, use cwai__seo-set noindex=false.' );
		if ( $live ) {
			$chk( $schema > 0, "Structured data present ($schema)", 'low', 'No structured data (schema) found', 'Enable schema in Rank Math (Titles & Meta / Local SEO) for the church.' );
			$chk( '' !== $canon, 'Canonical URL set', 'low', 'No canonical URL', 'Rank Math normally adds one; check that Rank Math is active.' );
		}
		if ( $kw ) {
			$slug = $post ? $post->post_name : '';
			$kws  = sanitize_title( $kw );
			$intro = mb_substr( $text, 0, max( 120, (int) ( mb_strlen( $text ) * 0.1 ) ) );
			$chk( false !== mb_stripos( $title, $kw ), 'Keyword in title', 'high', "Focus keyword “{$kw}” not in the title", 'Put the keyword near the start of the SEO title.' );
			$chk( false !== mb_stripos( $desc, $kw ), 'Keyword in description', 'medium', 'Keyword missing from meta description', 'Mention it naturally in the description.' );
			$chk( $kws && false !== strpos( $slug, $kws ), 'Keyword in URL', 'low', 'Keyword not in the URL slug', 'Consider a shorter slug containing the keyword (only for new pages; changing live URLs needs a redirect).' );
			$chk( false !== mb_stripos( $intro, $kw ), 'Keyword in the introduction', 'medium', 'Keyword missing from the first paragraph', 'Use it in the opening sentences.' );
			$chk( false !== mb_stripos( implode( ' ', array_merge( $h1s, $h2s ) ), $kw ), 'Keyword in a heading', 'medium', 'Keyword not in any heading', 'Use it in the H1 or an H2.' );
			$chk( $kw_alt || 0 === $imgs->length, 'Keyword in an image alt', 'low', 'No image alt mentions the keyword', 'Describe one image using the keyword naturally.' );
			$cnt = mb_substr_count( mb_strtolower( $text ), mb_strtolower( $kw ) );
			$den = $words ? round( $cnt / $words * 100, 2 ) : 0;
			$chk( $den >= 0.3 && $den <= 2.5, "Keyword density OK ($den%)", 'low', "Keyword density is $den%", 'Aim for roughly 0.5–1.5%; avoid stuffing.' );
		} else {
			$issues[] = array( 'severity' => 'high', 'problem' => 'No focus keyword is set', 'fix' => 'Choose the phrase people would search for (e.g. "church in Stoney Creek") and set it with cwai__seo-set.' );
		}
		$total = count( $pass ) + count( $issues );
		$weights = array( 'high' => 3, 'medium' => 2, 'low' => 1 );
		usort( $issues, static function ( $a, $b ) use ( $weights ) {
			return $weights[ $b['severity'] ] <=> $weights[ $a['severity'] ];
		} );
		return array(
			'url'       => $url,
			'post_id'   => $post ? $post->ID : null,
			'score'     => $total ? (int) round( count( $pass ) / $total * 100 ) : 0,
			'title'     => $title,
			'description' => $desc,
			'focus_keyword' => $kw,
			'h1'        => $h1s,
			'word_count' => $words,
			'images'    => $imgs->length,
			'passed'    => $pass,
			'issues'    => $issues,
			'notes'     => $notes,
		);
	}

	/* ------------------------------------------------------------------ */
	/* Site-wide                                                           */
	/* ------------------------------------------------------------------ */

	private static function default_types() {
		$t = array( 'page', 'post' );
		if ( $s = CWAI_Tools_Content::sermon_type() ) { // phpcs:ignore
			$t[] = $s;
		}
		return $t;
	}

	private static function missing_query( $key, $types, $per, $page ) {
		return new WP_Query( array(
			'post_type' => $types, 'post_status' => 'publish', 'posts_per_page' => $per, 'paged' => $page, 'orderby' => 'modified',
			'meta_query' => array( 'relation' => 'OR', array( 'key' => $key, 'compare' => 'NOT EXISTS' ), array( 'key' => $key, 'value' => '', 'compare' => '=' ) ), // phpcs:ignore
		) );
	}

	public static function find_issues( $in ) {
		$types = ! empty( $in['post_type'] ) ? array( sanitize_key( $in['post_type'] ) ) : self::default_types();
		$issue = $in['issue'] ?? 'summary';
		$per   = min( 50, max( 1, (int) ( $in['per_page'] ?? 30 ) ) );
		$page  = max( 1, (int) ( $in['page'] ?? 1 ) );

		if ( 'summary' === $issue ) {
			$total = new WP_Query( array( 'post_type' => $types, 'post_status' => 'publish', 'posts_per_page' => 1, 'fields' => 'ids' ) );
			$nd    = self::missing_query( self::META['description'], $types, 1, 1 );
			$nk    = self::missing_query( self::META['focus_keyword'], $types, 1, 1 );
			$ni    = new WP_Query( array( 'post_type' => $types, 'post_status' => 'publish', 'posts_per_page' => 1, 'fields' => 'ids', 'meta_query' => array( array( 'key' => 'rank_math_robots', 'value' => 'noindex', 'compare' => 'LIKE' ) ) ) ); // phpcs:ignore
			return array(
				'rank_math_active' => self::active(),
				'published_items'  => (int) $total->found_posts,
				'missing_description' => (int) $nd->found_posts,
				'missing_focus_keyword' => (int) $nk->found_posts,
				'noindex'          => (int) $ni->found_posts,
				'types_checked'    => $types,
			);
		}
		if ( 'missing_description' === $issue || 'missing_focus_keyword' === $issue ) {
			$q = self::missing_query( 'missing_description' === $issue ? self::META['description'] : self::META['focus_keyword'], $types, $per, $page );
		} elseif ( 'noindex' === $issue ) {
			$q = new WP_Query( array( 'post_type' => $types, 'post_status' => 'publish', 'posts_per_page' => $per, 'paged' => $page, 'meta_query' => array( array( 'key' => 'rank_math_robots', 'value' => 'noindex', 'compare' => 'LIKE' ) ) ) ); // phpcs:ignore
		} else {
			$q = new WP_Query( array( 'post_type' => $types, 'post_status' => 'publish', 'posts_per_page' => 200, 'meta_query' => array( array( 'key' => self::META['description'], 'value' => '', 'compare' => '!=' ) ) ) ); // phpcs:ignore
		}
		$items = array();
		foreach ( $q->posts as $p ) {
			$dl = mb_strlen( (string) get_post_meta( $p->ID, self::META['description'], true ) );
			if ( 'description_length' === $issue && $dl >= 110 && $dl <= 162 ) {
				continue;
			}
			$items[] = array( 'post_id' => $p->ID, 'type' => $p->post_type, 'title' => get_the_title( $p ), 'url' => get_permalink( $p ), 'description_length' => $dl, 'focus_keyword' => get_post_meta( $p->ID, self::META['focus_keyword'], true ) );
		}
		return array( 'issue' => $issue, 'total' => (int) $q->found_posts, 'items' => $items );
	}

	/* ------------------------------------------------------------------ */
	/* Redirects / settings                                                */
	/* ------------------------------------------------------------------ */

	public static function redirects( $in ) {
		if ( ! class_exists( 'RankMath\\Redirections\\DB' ) ) {
			return new WP_Error( 'cwai_rm', 'Rank Math\'s Redirections module is not available. Enable it in Rank Math → Dashboard, or add the redirect manually.' );
		}
		$DB = 'RankMath\\Redirections\\DB';
		try {
			switch ( $in['action'] ?? 'list' ) {
				case 'list':
					$r = $DB::get_redirections( array( 'limit' => 100 ) );
					return array( 'total' => $r['count'] ?? null, 'redirections' => array_map( static function ( $x ) {
						return array( 'id' => $x['id'] ?? null, 'sources' => $x['sources'] ?? null, 'to' => $x['url_to'] ?? null, 'type' => $x['header_code'] ?? null, 'hits' => $x['hits'] ?? null );
					}, (array) ( $r['redirections'] ?? array() ) ) );
				case 'create':
					$from = '/' . ltrim( (string) ( $in['from'] ?? '' ), '/' );
					$to   = (string) ( $in['to'] ?? '' );
					if ( '/' === $from || '' === $to ) {
						return new WP_Error( 'cwai_args', 'Give both from and to.' );
					}
					$type = in_array( (int) ( $in['type'] ?? 301 ), array( 301, 302, 307 ), true ) ? (int) ( $in['type'] ?? 301 ) : 301;
					$id   = $DB::add( array(
						'sources'     => array( array( 'pattern' => trim( $from, '/' ), 'comparison' => 'exact' ) ),
						'url_to'      => $to,
						'header_code' => $type,
						'status'      => 'active',
					) );
					return array( 'created' => (bool) $id, 'id' => $id, 'from' => $from, 'to' => $to, 'type' => $type );
				case 'remove':
					$DB::delete( (int) ( $in['id'] ?? 0 ) );
					return array( 'removed' => (int) ( $in['id'] ?? 0 ) );
			}
		} catch ( \Throwable $e ) {
			return new WP_Error( 'cwai_rm', 'Rank Math rejected the redirect change (' . $e->getMessage() . '). Add it in Rank Math → Redirections instead.' );
		}
		return new WP_Error( 'cwai_action', 'Unknown action.' );
	}

	private static function opt_name( $k ) {
		return self::OPTIONS[ $k ] ?? null;
	}

	public static function settings_get( $in ) {
		$name = self::opt_name( $in['option'] ?? '' );
		if ( ! $name ) {
			return new WP_Error( 'cwai_opt', 'Unknown option.' );
		}
		$o = get_option( $name, array() );
		$o = is_array( $o ) ? $o : array();
		if ( ! empty( $in['keys'] ) ) {
			$o = array_intersect_key( $o, array_flip( (array) $in['keys'] ) );
		}
		foreach ( array_keys( $o ) as $k ) {
			if ( preg_match( '/license|api_?key|secret|password|token/i', $k ) ) {
				unset( $o[ $k ] );
			}
		}
		return array( 'option' => $in['option'], 'rank_math_active' => self::active(), 'values' => $o );
	}

	public static function settings_set( $in ) {
		$name = self::opt_name( $in['option'] ?? '' );
		if ( ! $name ) {
			return new WP_Error( 'cwai_opt', 'Unknown option.' );
		}
		$cur     = get_option( $name, array() );
		$cur     = is_array( $cur ) ? $cur : array();
		$changed = array();
		foreach ( (array) ( $in['changes'] ?? array() ) as $k => $v ) {
			if ( preg_match( '/license|api_?key|secret|password|token|connect/i', (string) $k ) ) {
				continue;
			}
			$cur[ $k ] = is_string( $v ) ? sanitize_textarea_field( $v ) : $v;
			$changed[] = $k;
		}
		if ( ! $changed ) {
			return new WP_Error( 'cwai_nochange', 'No valid keys to change.' );
		}
		update_option( $name, $cur );
		return array( 'option' => $in['option'], 'changed' => $changed );
	}
}
