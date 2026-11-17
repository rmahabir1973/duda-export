<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Site health check: missing alt text, large images, missing SEO titles/descriptions, placeholder text,
 * broken links, search-engine visibility and a few launch basics. Works from the admin page (stepwise, so it
 * never times out) and as an assistant tool.
 */
final class CWAI_Health {

	const OPT   = 'cwai_health';
	const LINKS = 'cwai_health_links';
	const BIG   = 1572864; // 1.5 MB

	const SKIP_HOSTS = array( 'www.w3.org', 'w3.org', 'schema.org', 'gmpg.org', 'fonts.googleapis.com', 'fonts.gstatic.com', 'api.w.org', 'ogp.me', 'purl.org' );
	const PLACEHOLDERS = array( 'lorem ipsum', 'example.com', 'your church name', 'your business name', 'your company name', 'company name here', '[placeholder', 'placeholder text', 'insert text here' );

	public static function boot() {
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 25 );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
	}

	/* ------------------------------------------------------------------ */
	/* Quick checks                                                        */
	/* ------------------------------------------------------------------ */

	private static function check( $id, $title, $level, $detail, array $items = array(), $count = null, $fix = '' ) {
		return array( 'id' => $id, 'title' => $title, 'level' => $level, 'detail' => $detail, 'count' => null === $count ? count( $items ) : (int) $count, 'items' => array_slice( $items, 0, 15 ), 'fix' => $fix );
	}

	private static function public_types() {
		$t = array_values( array_diff( get_post_types( array( 'public' => true ) ), array( 'attachment' ) ) );
		return $t ?: array( 'page', 'post' );
	}

	private static function published_ids( $limit = 300 ) {
		return get_posts( array( 'post_type' => self::public_types(), 'post_status' => 'publish', 'posts_per_page' => $limit, 'fields' => 'ids', 'no_found_rows' => true, 'orderby' => 'modified', 'order' => 'DESC' ) );
	}

	public static function quick() {
		$out = array();

		// Search engines.
		if ( ! get_option( 'blog_public' ) ) {
			$out[] = self::check( 'visibility', 'Search engines are blocked', 'bad', 'The site is set to discourage search engines (Settings → Reading). That is right for a draft or preview, but a live site needs it off.', array(), 1, '' );
		} else {
			$out[] = self::check( 'visibility', 'Search engines can find the site', 'ok', '', array(), 0 );
		}

		// Alt text.
		$q = new WP_Query( array(
			'post_type' => 'attachment', 'post_status' => 'inherit', 'post_mime_type' => 'image', 'posts_per_page' => 15, 'fields' => 'ids',
			'meta_query' => array( 'relation' => 'OR', array( 'key' => '_wp_attachment_image_alt', 'compare' => 'NOT EXISTS' ), array( 'key' => '_wp_attachment_image_alt', 'value' => '' ) ),
		) );
		$items = array();
		foreach ( $q->posts as $id ) {
			$items[] = array( 'id' => $id, 'label' => get_the_title( $id ) ?: basename( (string) get_attached_file( $id ) ), 'url' => get_edit_post_link( $id, 'raw' ) );
		}
		$out[] = $q->found_posts
			? self::check( 'alt', 'Images without alt text', 'warn', 'Alt text helps people using screen readers and helps Google understand the picture.', $items, $q->found_posts, 'Add meaningful alt text to every image in the media library that is missing it. Describe each picture; look at the file name, title and the pages that use it. Show me what you set.' )
			: self::check( 'alt', 'All images have alt text', 'ok', '', array(), 0 );

		// Large images.
		$ids   = get_posts( array( 'post_type' => 'attachment', 'post_status' => 'inherit', 'post_mime_type' => 'image', 'posts_per_page' => 300, 'fields' => 'ids', 'no_found_rows' => true, 'orderby' => 'date', 'order' => 'DESC' ) );
		$big   = array();
		foreach ( $ids as $id ) {
			$f = get_attached_file( $id );
			$z = $f && file_exists( $f ) ? (int) filesize( $f ) : 0;
			if ( $z > self::BIG ) {
				$big[] = array( 'id' => $id, 'label' => basename( $f ) . ' (' . size_format( $z ) . ')', 'url' => get_edit_post_link( $id, 'raw' ), 'size' => $z );
			}
		}
		usort( $big, static function ( $a, $b ) {
			return $b['size'] <=> $a['size'];
		} );
		$out[] = $big
			? self::check( 'large', 'Very large images', 'warn', 'Pictures over 1.5 MB slow the site down, especially on phones. Compress or resize them (an image optimisation plugin can do this automatically).', $big, count( $big ) )
			: self::check( 'large', 'No oversized images', 'ok', '', array(), 0 );

		// SEO titles and descriptions (Rank Math).
		if ( defined( 'RANK_MATH_VERSION' ) || class_exists( 'RankMath' ) ) {
			$miss = array();
			foreach ( self::published_ids( 200 ) as $id ) {
				if ( '' === (string) get_post_meta( $id, 'rank_math_description', true ) || '' === (string) get_post_meta( $id, 'rank_math_title', true ) ) {
					$miss[] = array( 'id' => $id, 'label' => get_the_title( $id ), 'url' => get_permalink( $id ) );
				}
			}
			$out[] = $miss
				? self::check( 'seo', 'Pages without a custom search listing', 'warn', 'These have no SEO title or description set, so Google will guess one.', $miss, count( $miss ), 'Set the SEO title, meta description and focus keyword (cwai__seo-set) for every published page and post that is missing them. Start with the most important pages and tell me what you wrote.' )
				: self::check( 'seo', 'Every page has a search listing', 'ok', '', array(), 0 );
		} else {
			$out[] = self::check( 'seo', 'SEO plugin not active', 'info', 'Rank Math is not active, so search titles and descriptions were not checked.', array(), 0 );
		}

		// Placeholder text.
		$ph = self::placeholders();
		$out[] = $ph
			? self::check( 'placeholder', 'Placeholder text still on the site', 'bad', 'Sample text such as "lorem ipsum" or example.com was found on published pages.', $ph, count( $ph ), 'Find the placeholder text listed here (lorem ipsum, example.com, "your church name" and similar) and replace it with real content. If you do not have the real details, ask me.' )
			: self::check( 'placeholder', 'No placeholder text found', 'ok', '', array(), 0 );

		// Basics.
		$basics = array();
		if ( '' === trim( (string) get_option( 'blogdescription' ) ) ) {
			$basics[] = array( 'label' => 'The site tagline is empty (Settings → General).' );
		}
		if ( ! has_site_icon() ) {
			$basics[] = array( 'label' => 'No site icon (favicon) is set.' );
		}
		if ( 0 !== strpos( home_url(), 'https://' ) ) {
			$basics[] = array( 'label' => 'The site address does not use https.' );
		}
		$out[] = $basics
			? self::check( 'basics', 'A few basics to finish', 'warn', '', $basics, count( $basics ), 'Help me finish the site basics: write a short tagline for the site and set it, and tell me how to add a site icon.' )
			: self::check( 'basics', 'Site basics are in place', 'ok', '', array(), 0 );

		$drafts = get_posts( array( 'post_type' => 'page', 'post_status' => 'draft', 'posts_per_page' => 15, 'fields' => 'ids', 'no_found_rows' => true ) );
		if ( $drafts ) {
			$out[] = self::check( 'drafts', 'Draft pages', 'info', 'Pages that exist but are not published yet.', array_map( static function ( $id ) {
				return array( 'id' => $id, 'label' => get_the_title( $id ) ?: '(no title)', 'url' => get_edit_post_link( $id, 'raw' ) );
			}, $drafts ), (int) wp_count_posts( 'page' )->draft );
		}
		return $out;
	}

	/** Published posts/pages containing sample text (in the body or in builder data). */
	public static function placeholders() {
		global $wpdb;
		$found = array();
		$types = "'" . implode( "','", array_map( 'esc_sql', self::public_types() ) ) . "'";
		foreach ( self::PLACEHOLDERS as $needle ) {
			$like = '%' . $wpdb->esc_like( $needle ) . '%';
			$ids  = $wpdb->get_col( $wpdb->prepare( "SELECT ID FROM {$wpdb->posts} WHERE post_status = 'publish' AND post_type IN ($types) AND (post_content LIKE %s OR post_title LIKE %s) LIMIT 20", $like, $like ) ); // phpcs:ignore
			$more = $wpdb->get_col( $wpdb->prepare( "SELECT DISTINCT m.post_id FROM {$wpdb->postmeta} m JOIN {$wpdb->posts} p ON p.ID = m.post_id WHERE p.post_status = 'publish' AND p.post_type IN ($types) AND m.meta_key LIKE %s AND m.meta_value LIKE %s LIMIT 20", '%oxy%', $like ) ); // phpcs:ignore
			foreach ( array_unique( array_merge( $ids, $more ) ) as $id ) {
				$id = (int) $id;
				if ( ! isset( $found[ $id ] ) ) {
					$found[ $id ] = array( 'id' => $id, 'label' => get_the_title( $id ) . ' (“' . $needle . '”)', 'url' => get_permalink( $id ) );
				}
			}
		}
		return array_values( $found );
	}

	/* ------------------------------------------------------------------ */
	/* Links                                                               */
	/* ------------------------------------------------------------------ */

	/** Unique links found on published content: [ [url, posts[]] ]. */
	public static function link_list( $max = 400 ) {
		global $wpdb;
		$ids  = self::published_ids( 200 );
		if ( ! $ids ) {
			return array();
		}
		$home = wp_parse_url( home_url(), PHP_URL_HOST );
		$map  = array();
		$add  = static function ( $url, $id ) use ( &$map, $home ) {
			$url = trim( html_entity_decode( $url ) );
			$url = rtrim( $url, '.,;)' );
			if ( '' === $url || preg_match( '#^(mailto:|tel:|sms:|javascript:|data:|\#)#i', $url ) ) {
				return;
			}
			if ( 0 === strpos( $url, '//' ) ) {
				$url = 'https:' . $url;
			} elseif ( '/' === $url[0] ) {
				$url = untrailingslashit( home_url() ) . $url;
			}
			if ( ! preg_match( '#^https?://#i', $url ) ) {
				return;
			}
			$h = strtolower( (string) wp_parse_url( $url, PHP_URL_HOST ) );
			if ( ! $h || in_array( $h, CWAI_Health::SKIP_HOSTS, true ) ) {
				return;
			}
			$url = preg_replace( '/#.*$/', '', $url );
			if ( ! isset( $map[ $url ] ) ) {
				$map[ $url ] = array();
			}
			if ( count( $map[ $url ] ) < 3 && ! in_array( $id, $map[ $url ], true ) ) {
				$map[ $url ][] = $id;
			}
		};
		foreach ( array_chunk( $ids, 50 ) as $chunk ) {
			$in = implode( ',', array_map( 'intval', $chunk ) );
			foreach ( $wpdb->get_results( "SELECT ID, post_content FROM {$wpdb->posts} WHERE ID IN ($in)", ARRAY_A ) as $row ) { // phpcs:ignore
				if ( preg_match_all( '#(?:href|src)=["\']([^"\']+)["\']#i', $row['post_content'], $m ) ) {
					foreach ( $m[1] as $u ) {
						$add( $u, (int) $row['ID'] );
					}
				}
			}
			foreach ( $wpdb->get_results( "SELECT post_id, meta_value FROM {$wpdb->postmeta} WHERE post_id IN ($in) AND meta_key LIKE '%oxy%'", ARRAY_A ) as $row ) { // phpcs:ignore
				$v = str_replace( '\\/', '/', (string) $row['meta_value'] );
				if ( preg_match_all( '#https?://[^\s"\'<>\\\\]+#i', $v, $m ) ) {
					foreach ( $m[0] as $u ) {
						$add( $u, (int) $row['post_id'] );
					}
				}
			}
			if ( count( $map ) >= $max ) {
				break;
			}
		}
		$out = array();
		foreach ( array_slice( $map, 0, $max, true ) as $url => $posts ) {
			$out[] = array( $url, $posts );
		}
		return $out;
	}

	/** @return array {status: ok|broken|warn|unverified, code, note} */
	public static function check_link( $url ) {
		$home = wp_parse_url( home_url(), PHP_URL_HOST );
		if ( wp_parse_url( $url, PHP_URL_HOST ) === $home && url_to_postid( $url ) ) {
			return array( 'status' => 'ok', 'code' => 200, 'note' => '' );
		}
		$args = array( 'timeout' => 6, 'redirection' => 3, 'user-agent' => 'Mozilla/5.0 (compatible; SiteHealthCheck)', 'reject_unsafe_urls' => true );
		$r    = wp_remote_head( $url, $args );
		if ( is_wp_error( $r ) ) {
			$msg = $r->get_error_message();
			if ( preg_match( '/resolve host|name or service not known|getaddrinfo/i', $msg ) ) {
				return array( 'status' => 'broken', 'code' => 0, 'note' => 'The website address does not exist.' );
			}
			return array( 'status' => 'unverified', 'code' => 0, 'note' => 'Could not connect (' . mb_substr( $msg, 0, 80 ) . ').' );
		}
		$code = (int) wp_remote_retrieve_response_code( $r );
		if ( $code >= 400 && ! in_array( $code, array( 404, 410 ), true ) ) {
			$g = wp_remote_get( $url, $args + array( 'limit_response_size' => 4096 ) );
			if ( ! is_wp_error( $g ) ) {
				$code = (int) wp_remote_retrieve_response_code( $g );
			}
		}
		if ( $code < 400 ) {
			return array( 'status' => 'ok', 'code' => $code, 'note' => '' );
		}
		if ( 404 === $code || 410 === $code ) {
			return array( 'status' => 'broken', 'code' => $code, 'note' => 'Page not found.' );
		}
		if ( $code >= 500 ) {
			return array( 'status' => 'warn', 'code' => $code, 'note' => 'The other site has a server problem right now.' );
		}
		return array( 'status' => 'unverified', 'code' => $code, 'note' => 'The site refused the check (it may still work in a browser).' );
	}

	/** Check a slice of the link list; returns the problems found. */
	public static function scan_links( array $list, $offset, $batch ) {
		$bad = array();
		foreach ( array_slice( $list, $offset, $batch ) as $row ) {
			list( $url, $posts ) = $row;
			$c = self::check_link( $url );
			if ( in_array( $c['status'], array( 'broken', 'warn' ), true ) ) {
				$bad[] = array(
					'url'    => $url,
					'code'   => $c['code'],
					'status' => $c['status'],
					'note'   => $c['note'],
					'pages'  => array_map( static function ( $id ) {
						return array( 'id' => $id, 'title' => get_the_title( $id ), 'url' => get_permalink( $id ) );
					}, $posts ),
				);
			}
		}
		return $bad;
	}

	public static function links_check( array $bad, $total, $scanned ) {
		$items = array();
		foreach ( $bad as $b ) {
			$items[] = array( 'label' => $b['url'] . ' — ' . $b['note'] . ' (on: ' . implode( ', ', wp_list_pluck( $b['pages'], 'title' ) ) . ')', 'url' => $b['url'] );
		}
		$broken = count( array_filter( $bad, static function ( $b ) {
			return 'broken' === $b['status'];
		} ) );
		$t = sprintf( 'Checked %d of %d links.', $scanned, $total );
		if ( $broken ) {
			return self::check( 'links', 'Broken links', 'bad', $t, $items, count( $bad ), 'Fix the broken links listed in the site health check: for each one find the right page or the new address and update it, or remove the link. Show me what you changed.' );
		}
		if ( $bad ) {
			return self::check( 'links', 'Links worth a second look', 'warn', $t . ' None are definitely broken.', $items, count( $bad ) );
		}
		return self::check( 'links', 'No broken links found', 'ok', $t, array(), 0 );
	}

	/* ------------------------------------------------------------------ */
	/* Assistant tool                                                      */
	/* ------------------------------------------------------------------ */

	public static function register_tools() {
		$p = array( 'CWAI_Tools_Content', 'p' );
		$s = array( 'CWAI_Tools_Content', 'schema' );
		CWAI_Registry::add( 'cwai/site-health', array(
			'label'       => 'Site health check',
			'description' => 'Check the site for problems: images without alt text (with ids), very large images, published pages without an SEO title/description, leftover placeholder text, broken links, search-engine visibility and launch basics. Returns checks with level ok/warn/bad/info and the affected items. Read-only: it never changes anything. After reporting, offer to fix what can be fixed (cwai__update-media for alt text, cwai__seo-set for SEO, cwai__save-content or the Oxygen tools for text and links). Skipped link checks (unverified) are not errors.',
			'input'       => call_user_func( $s, array(
				'links'     => call_user_func( $p, 'boolean', 'Also check links (default true). Slower.' ),
				'max_links' => call_user_func( $p, 'integer', 'How many links to test (default 40, max 120). The full scan is on the Site health page.' ),
			) ),
			'callback'    => array( __CLASS__, 't_check' ),
			'readonly'    => true,
			'capability'  => 'edit_posts',
		) );
	}

	public static function t_check( $in ) {
		$checks = self::quick();
		$note   = '';
		if ( ! isset( $in['links'] ) || $in['links'] ) {
			$list = self::link_list();
			$max  = min( 120, max( 10, (int) ( $in['max_links'] ?? 40 ) ) );
			$bad  = self::scan_links( $list, 0, $max );
			$checks[] = self::links_check( $bad, count( $list ), min( $max, count( $list ) ) );
			if ( count( $list ) > $max ) {
				$note = 'Only the first ' . $max . ' of ' . count( $list ) . ' links were tested. The Site health page can scan all of them.';
			}
		}
		$sum = array( 'bad' => 0, 'warn' => 0, 'ok' => 0, 'info' => 0 );
		foreach ( $checks as $c ) {
			$sum[ $c['level'] ] = ( $sum[ $c['level'] ] ?? 0 ) + 1;
		}
		return array( 'summary' => $sum, 'checks' => $checks, 'note' => $note );
	}

	public static function prompt_section() {
		return "## Site health\n- cwai__site-health checks the site and never changes it. When asked to \"check\", \"audit\" or \"review\" the site, or before a launch, run it, then report plainly: what is fine, what needs attention, in priority order (bad before warn). Offer to fix, and fix only what the person agrees to. Alt text: look at the picture's title, file name and where it is used, and write a short factual description. Do not guess about people in photos. Links reported as 'unverified' are not errors.";
	}

	/* ------------------------------------------------------------------ */
	/* REST + page                                                         */
	/* ------------------------------------------------------------------ */

	public static function routes() {
		$u = static function () {
			return current_user_can( 'edit_posts' ) && CWAI_Plugin::can_use();
		};
		register_rest_route( CWAI_REST::NS, '/health/start', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'rest_start' ), 'permission_callback' => $u ) );
		register_rest_route( CWAI_REST::NS, '/health/links', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'rest_links' ), 'permission_callback' => $u ) );
		register_rest_route( CWAI_REST::NS, '/health/last', array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'rest_last' ), 'permission_callback' => $u ) );
	}

	public static function rest_start() {
		$list = self::link_list();
		set_transient( self::LINKS, $list, 15 * MINUTE_IN_SECONDS );
		set_transient( self::LINKS . '_found', array(), 15 * MINUTE_IN_SECONDS );
		$checks = self::quick();
		update_option( self::OPT, array( 'time' => time(), 'checks' => $checks, 'partial' => true ), false );
		return array( 'checks' => $checks, 'link_total' => count( $list ) );
	}

	public static function rest_links( WP_REST_Request $r ) {
		$list = get_transient( self::LINKS );
		if ( ! is_array( $list ) ) {
			return new WP_Error( 'cwai_health', 'The scan expired. Start it again.', array( 'status' => 410 ) );
		}
		$off   = max( 0, (int) $r->get_param( 'offset' ) );
		$batch = 8;
		$bad   = self::scan_links( $list, $off, $batch );
		$all   = array_merge( (array) get_transient( self::LINKS . '_found' ), $bad );
		set_transient( self::LINKS . '_found', $all, 15 * MINUTE_IN_SECONDS );
		$next  = $off + $batch;
		$done  = $next >= count( $list );
		$res   = array( 'found' => $bad, 'next' => $done ? count( $list ) : $next, 'total' => count( $list ), 'done' => $done );
		if ( $done ) {
			$o        = get_option( self::OPT, array() );
			$checks   = array_values( array_filter( (array) ( $o['checks'] ?? array() ), static function ( $c ) {
				return 'links' !== $c['id'];
			} ) );
			$check    = self::links_check( $all, count( $list ), count( $list ) );
			$checks[] = $check;
			update_option( self::OPT, array( 'time' => time(), 'checks' => $checks ), false );
			$res['check'] = $check;
		}
		return $res;
	}

	public static function rest_last() {
		return get_option( self::OPT, array( 'time' => 0, 'checks' => array() ) );
	}

	public static function menu() {
		add_submenu_page( 'cwai-chat', __( 'Site health', 'cwai' ), __( 'Site health', 'cwai' ), 'edit_posts', 'cwai-health', array( __CLASS__, 'render_page' ) );
	}

	public static function enqueue() {
		if ( ! isset( $_GET['page'] ) || 'cwai-health' !== $_GET['page'] ) { // phpcs:ignore
			return;
		}
		wp_enqueue_script( 'cwai-health', CWAI_URL . 'assets/health.js', array(), CWAI_VERSION, true );
		wp_localize_script( 'cwai-health', 'CWAI_H', array(
			'root'  => esc_url_raw( rest_url( CWAI_REST::NS ) ),
			'nonce' => wp_create_nonce( 'wp_rest' ),
			'chat'  => admin_url( 'admin.php?page=cwai-chat' ),
			'last'  => self::rest_last(),
		) );
	}

	public static function render_page() {
		if ( ! CWAI_Plugin::can_use() ) {
			echo '<div class="wrap"><p>' . esc_html__( 'You do not have access to the assistant.', 'cwai' ) . '</p></div>';
			return;
		}
		echo '<div class="wrap" id="cwai-health"><h1>' . esc_html__( 'Site health', 'cwai' ) . '</h1>';
		echo '<p class="description" style="max-width:780px">' . esc_html__( 'Checks images, search listings, placeholder text, links and launch basics. Nothing is changed. Use the fix buttons to have the assistant correct what it can.', 'cwai' ) . '</p>';
		echo '<p><button class="button button-primary" id="cwh-run">' . esc_html__( 'Run the check', 'cwai' ) . '</button> <span id="cwh-status" class="description"></span></p><div id="cwh-out"></div></div>';
	}
}
