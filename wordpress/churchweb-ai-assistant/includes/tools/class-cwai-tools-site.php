<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Site-level tools: page fetch/review, find & replace, cache, identity, undo.
 */
final class CWAI_Tools_Site {

	public static function register() {
		$p = array( 'CWAI_Tools_Content', 'p' );
		$s = array( 'CWAI_Tools_Content', 'schema' );

		CWAI_Registry::add( 'cwai/fetch-page', array(
			'label' => 'View live page', 'description' => 'Fetch a public page of this site and summarize what a visitor gets: HTTP status, title tag, meta description, headings, text excerpt, image/link counts. Use it to verify a change after publishing. Drafts are not public: for those use oxygen__preview-post.',
			'input' => call_user_func( $s, array(
				'post_id'      => call_user_func( $p, 'integer', 'Post ID.' ),
				'url'          => call_user_func( $p, 'string', 'URL on this site.' ),
				'include_html' => call_user_func( $p, 'boolean', 'Also return the (trimmed) HTML.' ),
			) ),
			'callback' => array( __CLASS__, 'fetch_page' ), 'readonly' => true,
		) );
		CWAI_Registry::add( 'cwai/search-site-text', array(
			'label' => 'Find and replace text across the site', 'description' => 'Find text (a phone number, address, service time, pastor name) in page content, titles and Oxygen layouts across the whole site, and optionally replace it. ALWAYS run first with apply=false and show the person what was found. To change it, call again with apply=true and the replacement; the person is asked to approve and every changed page gets an undo point. Matching ignores upper/lower case unless case_sensitive is true.',
			'input' => call_user_func( $s, array(
				'query'          => call_user_func( $p, 'string', 'Exact text to find (min 3 characters).' ),
				'replace'        => call_user_func( $p, 'string', 'Replacement text (required when apply is true).' ),
				'apply'          => call_user_func( $p, 'boolean', 'false = report only (default). true = make the replacement.' ),
				'case_sensitive' => call_user_func( $p, 'boolean', 'Default false.' ),
				'post_ids'       => call_user_func( $p, 'array', 'Limit the change to these post IDs (use after a dry run to exclude some).', array( 'items' => array( 'type' => 'integer' ) ) ),
			), array( 'query' ) ),
			'callback' => array( __CLASS__, 'search_text' ), 'capability' => 'edit_pages',
			'approval' => static function ( $in ) {
				return ! empty( $in['apply'] );
			},
			'touches'  => static function () {
				return array();
			},
		) );
		CWAI_Registry::add( 'cwai/clear-cache', array(
			'label' => 'Clear caches', 'description' => 'Clear page caches (LiteSpeed, WP Rocket, W3 Total Cache) and the object cache. Done automatically after changes; use if a change does not appear.',
			'input' => call_user_func( $s, array( 'post_ids' => call_user_func( $p, 'array', 'Only these posts (default: everything).', array( 'items' => array( 'type' => 'integer' ) ) ) ) ),
			'callback' => static function ( $in ) {
				CWAI_Tools_Site::purge( array_map( 'intval', (array) ( $in['post_ids'] ?? array() ) ), empty( $in['post_ids'] ) );
				return array( 'cleared' => true );
			},
			'capability' => 'edit_posts',
		) );
		CWAI_Registry::add( 'cwai/update-site-identity', array(
			'label' => 'Site title, tagline and logo', 'description' => 'ADMIN. Change the site title, tagline, logo or site icon (favicon).',
			'input' => call_user_func( $s, array(
				'site_title'   => call_user_func( $p, 'string', 'Site title.' ),
				'tagline'      => call_user_func( $p, 'string', 'Tagline.' ),
				'logo_id'      => call_user_func( $p, 'integer', 'Media ID for the theme logo (0 removes).' ),
				'site_icon_id' => call_user_func( $p, 'integer', 'Media ID for the favicon, square, 512px+ (0 removes).' ),
			) ),
			'callback' => array( __CLASS__, 'identity' ), 'admin' => true, 'capability' => 'manage_options',
		) );
		CWAI_Registry::add( 'cwai/list-changes', array(
			'label' => 'List recent changes', 'description' => 'List recent undo points (what was changed, when, and the undo ID). Use to answer "what did you change?" or before undoing.',
			'input' => call_user_func( $s, array( 'limit' => call_user_func( $p, 'integer', 'Default 15.' ), 'this_chat_only' => call_user_func( $p, 'boolean', 'Only changes made in this conversation.' ) ) ),
			'callback' => array( __CLASS__, 'list_changes' ), 'readonly' => true,
		) );
		CWAI_Registry::add( 'cwai/undo-change', array(
			'label' => 'Undo a change', 'description' => 'Restore a page/post to how it was before an earlier change (or trash an item the assistant created), using an undo ID from cwai__list-changes. Restoring again undoes the undo only if a new change is made first.',
			'input' => call_user_func( $s, array( 'snapshot_id' => call_user_func( $p, 'integer', 'Undo ID.' ) ), array( 'snapshot_id' ) ),
			'callback' => static function ( $in ) {
				return CWAI_Registry::restore( (int) ( $in['snapshot_id'] ?? 0 ) );
			},
		) );
	}

	/* ------------------------------------------------------------------ */
	/* Cache                                                               */
	/* ------------------------------------------------------------------ */

	public static function purge( array $ids = array(), $all = false ) {
		foreach ( $ids as $id ) {
			clean_post_cache( (int) $id );
		}
		if ( $all || ! $ids ) {
			do_action( 'litespeed_purge_all' );
			if ( function_exists( 'rocket_clean_domain' ) ) {
				rocket_clean_domain();
			}
			if ( function_exists( 'w3tc_flush_all' ) ) {
				w3tc_flush_all();
			}
			if ( function_exists( 'wp_cache_clear_cache' ) ) {
				wp_cache_clear_cache();
			}
		} else {
			foreach ( $ids as $id ) {
				do_action( 'litespeed_purge_post', (int) $id );
				if ( function_exists( 'rocket_clean_post' ) ) {
					rocket_clean_post( (int) $id );
				}
				if ( function_exists( 'w3tc_flush_post' ) ) {
					w3tc_flush_post( (int) $id );
				}
			}
			do_action( 'litespeed_purge_url', home_url( '/' ) );
		}
		do_action( 'cwai_purged', $ids, $all );
	}

	/* ------------------------------------------------------------------ */
	/* Fetch                                                               */
	/* ------------------------------------------------------------------ */

	public static function fetch_html( $url ) {
		$host = wp_parse_url( $url, PHP_URL_HOST );
		$mine = array_filter( array( wp_parse_url( home_url(), PHP_URL_HOST ), wp_parse_url( site_url(), PHP_URL_HOST ) ) );
		if ( ! $host || ! in_array( $host, $mine, true ) ) {
			return new WP_Error( 'cwai_host', 'Only pages on this website can be fetched.' );
		}
		$url  = add_query_arg( 'cwai_nocache', time(), $url );
		$t0   = microtime( true );
		$args = array(
			'timeout'     => 25,
			'redirection' => 3,
			'sslverify'   => apply_filters( 'https_local_ssl_verify', false ),
			'user-agent'  => 'ChurchWebAI/' . CWAI_VERSION . '; ' . home_url(),
			'headers'     => array( 'Cache-Control' => 'no-cache' ),
		);
		if ( defined( 'CWAI_BASIC_AUTH' ) && CWAI_BASIC_AUTH ) {
			$args['headers']['Authorization'] = 'Basic ' . base64_encode( CWAI_BASIC_AUTH ); // phpcs:ignore
		}
		$r = wp_remote_get( $url, $args );
		if ( is_wp_error( $r ) ) {
			return $r;
		}
		return array( 'code' => (int) wp_remote_retrieve_response_code( $r ), 'html' => (string) wp_remote_retrieve_body( $r ), 'ms' => (int) ( ( microtime( true ) - $t0 ) * 1000 ) );
	}

	public static function fetch_page( $in ) {
		if ( ! empty( $in['post_id'] ) ) {
			$p = get_post( (int) $in['post_id'] );
			if ( ! $p || ! current_user_can( 'read_post', $p->ID ) ) {
				return new WP_Error( 'cwai_nf', 'Content not found.' );
			}
			if ( 'publish' !== $p->post_status ) {
				return new WP_Error( 'cwai_draft', 'This item is not published, so it has no public page yet. Use oxygen__preview-post to check how it renders.' );
			}
			$url = get_permalink( $p );
		} else {
			$url = esc_url_raw( (string) ( $in['url'] ?? '' ) );
		}
		if ( ! $url ) {
			return new WP_Error( 'cwai_args', 'Give post_id or url.' );
		}
		$f = self::fetch_html( $url );
		if ( is_wp_error( $f ) ) {
			return $f;
		}
		$out = array( 'url' => $url, 'status' => $f['code'], 'load_ms' => $f['ms'] );
		if ( $f['code'] >= 400 || '' === $f['html'] ) {
			return $out + array( 'note' => 'The page did not load correctly.' );
		}
		$d = new DOMDocument();
		libxml_use_internal_errors( true );
		$d->loadHTML( '<?xml encoding="utf-8" ?>' . $f['html'] );
		libxml_clear_errors();
		$x    = new DOMXPath( $d );
		$q1   = static function ( $q ) use ( $x ) {
			$n = $x->query( $q );
			return $n && $n->length ? trim( preg_replace( '/\s+/', ' ', $n->item( 0 )->textContent ) ) : '';
		};
		$out['title']       = $q1( '//title' );
		$m                  = $x->query( '//meta[@name="description"]/@content' );
		$out['description'] = $m && $m->length ? $m->item( 0 )->nodeValue : '';
		$heads              = array();
		foreach ( $x->query( '//h1|//h2|//h3' ) as $h ) {
			$heads[] = strtoupper( $h->nodeName ) . ': ' . mb_substr( trim( preg_replace( '/\s+/', ' ', $h->textContent ) ), 0, 120 );
		}
		$out['headings'] = array_slice( $heads, 0, 40 );
		$out['images']   = $x->query( '//img' )->length;
		$out['images_without_alt'] = $x->query( '//img[not(@alt) or @alt=""]' )->length;
		$out['links']    = $x->query( '//a[@href]' )->length;
		foreach ( $x->query( '//script|//style|//noscript|//template' ) as $n ) {
			$n->parentNode->removeChild( $n ); // phpcs:ignore
		}
		$mainq = $x->query( '//main' )->length ? '//main' : '//body';
		$out['text_excerpt'] = mb_substr( trim( preg_replace( '/\s+/', ' ', $q1( $mainq ) ) ), 0, 2500 );
		if ( ! empty( $in['include_html'] ) ) {
			$out['html'] = mb_substr( $f['html'], 0, 30000 );
		}
		return $out;
	}

	/* ------------------------------------------------------------------ */
	/* Find & replace                                                      */
	/* ------------------------------------------------------------------ */

	private static function variants( $q ) {
		return array_values( array_unique( array(
			$q,
			trim( wp_json_encode( $q, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES ), '"' ),
			trim( wp_json_encode( $q, JSON_UNESCAPED_UNICODE ), '"' ),
			trim( wp_json_encode( $q ), '"' ),
			htmlspecialchars( $q, ENT_QUOTES ),
		) ) );
	}

	private static function count_in( $val, $needle, $ci, &$snippet ) {
		$n = 0;
		if ( is_string( $val ) ) {
			$pos = $ci ? mb_stripos( $val, $needle ) : mb_strpos( $val, $needle );
			if ( false !== $pos ) {
				$n = $ci ? mb_substr_count( mb_strtolower( $val ), mb_strtolower( $needle ) ) : mb_substr_count( $val, $needle );
				if ( '' === $snippet ) {
					$snippet = trim( preg_replace( '/\s+/', ' ', wp_strip_all_tags( mb_substr( $val, max( 0, $pos - 50 ), mb_strlen( $needle ) + 100 ) ) ) );
				}
			}
		} elseif ( is_array( $val ) || is_object( $val ) ) {
			foreach ( $val as $v ) {
				$n += self::count_in( $v, $needle, $ci, $snippet );
			}
		}
		return $n;
	}

	/** Return [mode, decoded] for a meta value. */
	private static function parse_value( $raw ) {
		if ( is_string( $raw ) && '' !== $raw && ( '{' === $raw[0] || '[' === $raw[0] ) ) {
			$j = json_decode( $raw );
			if ( JSON_ERROR_NONE === json_last_error() && ( is_array( $j ) || is_object( $j ) ) ) {
				return array( 'json', $j );
			}
		}
		if ( is_serialized( $raw ) ) {
			$u = @unserialize( $raw, array( 'allowed_classes' => false ) ); // phpcs:ignore
			if ( false !== $u || 'b:0;' === $raw ) {
				return array( 'ser', $u );
			}
		}
		return array( 'str', $raw );
	}

	private static function replace_str( $str, $needle, $repl, $ci ) {
		$c = 0;
		$out = $ci ? str_ireplace( $needle, $repl, $str, $c ) : str_replace( $needle, $repl, $str, $c );
		return array( $out, $c );
	}

	private static function walk_replace( $val, $needle, $repl, $ci, &$count ) {
		if ( is_string( $val ) ) {
			list( $out, $c ) = self::replace_str( $val, $needle, $repl, $ci );
			$count          += $c;
			return $out;
		}
		if ( is_array( $val ) ) {
			foreach ( $val as $k => $v ) {
				$val[ $k ] = self::walk_replace( $v, $needle, $repl, $ci, $count );
			}
		} elseif ( is_object( $val ) ) {
			foreach ( get_object_vars( $val ) as $k => $v ) {
				$val->$k = self::walk_replace( $v, $needle, $repl, $ci, $count );
			}
		}
		return $val;
	}

	public static function search_text( $in ) {
		global $wpdb;
		$q = (string) ( $in['query'] ?? '' );
		if ( mb_strlen( $q ) < 3 ) {
			return new WP_Error( 'cwai_short', 'Search text must be at least 3 characters.' );
		}
		$apply = ! empty( $in['apply'] );
		$repl  = $in['replace'] ?? null;
		if ( $apply && null === $repl ) {
			return new WP_Error( 'cwai_repl', 'Provide "replace" when apply is true.' );
		}
		$ci     = empty( $in['case_sensitive'] );
		$only   = ! empty( $in['post_ids'] ) ? array_map( 'intval', (array) $in['post_ids'] ) : array();
		$likes  = array();
		foreach ( self::variants( $q ) as $v ) {
			$likes[] = '%' . $wpdb->esc_like( $v ) . '%';
		}
		$skip_types = "'revision','auto-draft','customize_changeset','oembed_cache','attachment','wp_global_styles'";

		// Candidate posts (post fields).
		$cands = array(); // id => ['fields'=>[], 'meta'=>[meta_id=>key]]
		foreach ( $likes as $like ) {
			$rows = $wpdb->get_results( $wpdb->prepare( "SELECT ID FROM {$wpdb->posts} WHERE post_status NOT IN ('auto-draft','inherit') AND post_type NOT IN ($skip_types) AND (post_content LIKE %s OR post_title LIKE %s OR post_excerpt LIKE %s) LIMIT 400", $like, $like, $like ) ); // phpcs:ignore
			foreach ( $rows as $r ) {
				$cands[ (int) $r->ID ] = $cands[ (int) $r->ID ] ?? array( 'meta' => array() );
			}
			$rows = $wpdb->get_results( $wpdb->prepare( "SELECT m.meta_id, m.post_id, m.meta_key FROM {$wpdb->postmeta} m JOIN {$wpdb->posts} p ON p.ID = m.post_id WHERE m.meta_value LIKE %s AND p.post_status NOT IN ('auto-draft','inherit') AND p.post_type NOT IN ($skip_types) AND m.meta_key NOT IN ('_edit_lock','_wp_attachment_metadata','_wp_attached_file','rank_math_seo_score') LIMIT 400", $like ) ); // phpcs:ignore
			foreach ( $rows as $r ) {
				$cands[ (int) $r->post_id ]['meta'][ (int) $r->meta_id ] = $r->meta_key;
			}
		}
		if ( $only ) {
			$cands = array_intersect_key( $cands, array_flip( $only ) );
		}

		$report  = array();
		$total   = 0;
		$changed = 0;
		$unresolved = array();
		foreach ( $cands as $pid => $c ) {
			$post = get_post( $pid );
			if ( ! $post || ! current_user_can( 'edit_post', $pid ) ) {
				continue;
			}
			$where = array();
			$snip  = '';
			$cnt   = 0;
			foreach ( array( 'post_title', 'post_content', 'post_excerpt' ) as $f ) {
				$n = self::count_in( $post->$f, $q, $ci, $snip );
				if ( $n ) {
					$where[ $f ] = $n;
					$cnt        += $n;
				}
			}
			$meta_hits = array();
			foreach ( (array) ( $c['meta'] ?? array() ) as $mid => $mkey ) {
				$raw = $wpdb->get_var( $wpdb->prepare( "SELECT meta_value FROM {$wpdb->postmeta} WHERE meta_id = %d", $mid ) ); // phpcs:ignore
				list( $mode, $val ) = self::parse_value( $raw );
				$n = self::count_in( $val, $q, $ci, $snip );
				if ( $n ) {
					$where[ 'meta:' . $mkey ] = $n;
					$cnt                     += $n;
					$meta_hits[ $mid ]        = array( $mode, $val, $raw );
				}
			}
			if ( ! $cnt ) {
				$unresolved[] = $pid;
				continue;
			}
			$total += $cnt;
			$row    = array( 'post_id' => $pid, 'type' => $post->post_type, 'title' => get_the_title( $post ), 'status' => $post->post_status, 'matches' => $cnt, 'where' => array_keys( $where ), 'snippet' => $snip );
			if ( $apply ) {
				if ( count( $report ) >= 150 ) {
					return new WP_Error( 'cwai_many', 'More than 150 items match. Narrow the search text or pass post_ids.' );
				}
				CWAI_Registry::snapshot_post( $pid, 'Find & replace', 'cwai/search-text' );
				$upd = array();
				foreach ( array( 'post_title', 'post_content', 'post_excerpt' ) as $f ) {
					if ( isset( $where[ $f ] ) ) {
						list( $upd[ $f ], ) = self::replace_str( $post->$f, $q, (string) $repl, $ci );
					}
				}
				if ( $upd ) {
					$upd['post_modified']     = current_time( 'mysql' );
					$upd['post_modified_gmt'] = current_time( 'mysql', 1 );
					$wpdb->update( $wpdb->posts, $upd, array( 'ID' => $pid ) ); // phpcs:ignore
				}
				foreach ( $meta_hits as $mid => $h ) {
					list( $mode, $val, $raw ) = $h;
					$n = 0;
					$new = self::walk_replace( $val, $q, (string) $repl, $ci, $n );
					if ( 'json' === $mode ) {
						$new = wp_json_encode( $new, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION );
					} elseif ( 'ser' === $mode ) {
						$new = maybe_serialize( $new );
					}
					if ( is_string( $new ) && '' !== $new ) {
						$wpdb->update( $wpdb->postmeta, array( 'meta_value' => $new ), array( 'meta_id' => $mid ) ); // phpcs:ignore
					}
				}
				clean_post_cache( $pid );
				$changed++;
				$row['replaced'] = true;
			}
			$report[] = $row;
		}
		$out = array(
			'query'         => $q,
			'items_found'   => count( $report ),
			'total_matches' => $total,
			'applied'       => $apply,
			'items'         => array_slice( $report, 0, 100 ),
		);
		if ( $apply ) {
			$out['items_changed'] = $changed;
			$out['note'] = 'Replaced. Each changed item has an undo point. Page caches were cleared. Header/footer text lives in Oxygen templates and is included in this search. Text inside theme settings, widgets or plugin options is not searched.';
			if ( ( $ab = CWAI_Registry::ability( 'oxygen/run-site-tool' ) ) && CWAI_Plugin::is_admin_tier() && $changed ) { // phpcs:ignore
				$ab->execute( array( 'tool' => 'regenerate-css-cache', 'post_ids' => array_slice( array_column( $report, 'post_id' ), 0, 50 ) ) );
			}
			CWAI_Registry::$ctx['touched'] = array_column( $report, 'post_id' );
		} elseif ( ! $report ) {
			$out['note'] = 'No matches. Try a shorter piece of the text, or check spelling/punctuation.';
		}
		if ( $unresolved ) {
			$out['note_unmatched'] = count( $unresolved ) . ' item(s) contained the text only in an encoded form that could not be read safely and were skipped.';
		}
		return $out;
	}

	/* ------------------------------------------------------------------ */

	public static function identity( $in ) {
		$done = array();
		if ( isset( $in['site_title'] ) ) {
			update_option( 'blogname', sanitize_text_field( $in['site_title'] ) );
			$done[] = 'site_title';
		}
		if ( isset( $in['tagline'] ) ) {
			update_option( 'blogdescription', sanitize_text_field( $in['tagline'] ) );
			$done[] = 'tagline';
		}
		if ( array_key_exists( 'logo_id', $in ) ) {
			$id = (int) $in['logo_id'];
			$id ? set_theme_mod( 'custom_logo', $id ) : remove_theme_mod( 'custom_logo' );
			$done[] = 'logo';
		}
		if ( array_key_exists( 'site_icon_id', $in ) ) {
			$id = (int) $in['site_icon_id'];
			$id ? update_option( 'site_icon', $id ) : delete_option( 'site_icon' );
			$done[] = 'site_icon';
		}
		return array( 'changed' => $done, 'title' => get_bloginfo( 'name' ), 'tagline' => get_bloginfo( 'description' ) );
	}

	public static function list_changes( $in ) {
		$rows = CWAI_Store::list_snapshots( get_current_user_id(), ! empty( $in['this_chat_only'] ) ? (int) CWAI_Registry::$ctx['conv_id'] : 0, min( 50, max( 1, (int) ( $in['limit'] ?? 15 ) ) ) );
		return array_map( static function ( $r ) {
			return array( 'undo_id' => (int) $r['id'], 'what' => $r['label'], 'kind' => 'created' === $r['kind'] ? 'item created' : 'before change', 'when' => $r['created'] . ' UTC', 'already_restored' => (bool) $r['restored'] );
		}, $rows );
	}
}
