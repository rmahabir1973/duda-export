<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Preview mode and go-live: a banner plus "do not index" while a site is a preview, a launch checklist, a one-click
 * launch, and a careful address swap (old staging host to the real domain) that can be reversed.
 */
final class CWAI_Golive {

	const OPT = 'cwai_golive';

	const STEPS = array(
		'dns'      => 'Point the domain name at the hosting account (DNS)',
		'address'  => 'Change the WordPress Address and Site Address to the real domain (Settings → General)',
		'perma'    => 'Open Settings → Permalinks and click Save once',
		'css'      => 'Ask the assistant to regenerate the builder CSS and clear caches',
		'gsc'      => 'Add the site to Google Search Console and submit the sitemap',
		'profiles' => 'Update the Google Business Profile, social profiles and email signatures',
		'forms'    => 'Send a test message through every form and confirm it arrives',
		'backups'  => 'Confirm the host takes backups and the SSL certificate is active',
	);

	public static function boot() {
		add_action( 'wp_footer', array( __CLASS__, 'banner' ), 99 );
		add_filter( 'wp_robots', array( __CLASS__, 'robots' ), 99 );
		add_action( 'send_headers', array( __CLASS__, 'headers' ) );
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 27 );
		add_action( 'admin_post_cwai_golive', array( __CLASS__, 'handle' ) );
	}

	public static function opts() {
		return array_merge( array( 'preview' => false, 'label' => 'Preview of a proposed new website. This is not the live site.', 'launched' => 0, 'steps' => array(), 'last_replace' => null, 'old_host' => '' ), (array) get_option( self::OPT, array() ) );
	}
	private static function save( array $o ) {
		update_option( self::OPT, $o, false );
	}
	public static function is_preview() {
		return (bool) self::opts()['preview'];
	}

	/* ------------------------------------------------------------------ */
	/* Preview mode (front end)                                            */
	/* ------------------------------------------------------------------ */

	public static function banner() {
		if ( ! self::is_preview() || is_admin() || is_feed() ) {
			return;
		}
		echo '<div style="position:fixed;left:12px;bottom:12px;z-index:99998;max-width:calc(100vw - 24px);background:#111;color:#fff;font:600 13px/1.3 system-ui,sans-serif;padding:8px 12px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.3)">' . esc_html( self::opts()['label'] ) . '</div>';
	}
	public static function robots( $r ) {
		if ( self::is_preview() ) {
			$r['noindex']  = true;
			$r['nofollow'] = true;
			unset( $r['max-image-preview'] );
		}
		return $r;
	}
	public static function headers() {
		if ( self::is_preview() && ! headers_sent() ) {
			header( 'X-Robots-Tag: noindex, nofollow', true );
		}
	}

	/* ------------------------------------------------------------------ */
	/* Checklist                                                           */
	/* ------------------------------------------------------------------ */

	private static function item( $id, $label, $level, $detail = '' ) {
		return array( 'id' => $id, 'label' => $label, 'level' => $level, 'detail' => $detail );
	}

	public static function normalize_host( $v ) {
		$v = trim( (string) $v );
		if ( '' === $v ) {
			return '';
		}
		$h = preg_match( '#^https?://#i', $v ) ? wp_parse_url( $v, PHP_URL_HOST ) : preg_replace( '#[/?\#].*$#', '', $v );
		$h = strtolower( (string) $h );
		return preg_match( '/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/', $h ) ? $h : '';
	}

	public static function check( $old_host = '' ) {
		$o     = self::opts();
		$items = array();
		$items[] = $o['preview']
			? self::item( 'preview', 'Preview mode is ON', 'warn', 'Visitors see a banner and search engines are told not to index the site. Launch turns this off.' )
			: self::item( 'preview', 'Preview mode is off', 'ok' );

		$name = trim( (string) get_option( 'blogname' ) );
		$items[] = ( '' === $name || preg_match( '/^(my wordpress site|wordpress|test|staging|build\d*)$/i', $name ) )
			? self::item( 'title', 'Site title needs to be set', 'bad', 'Currently: "' . $name . '" (Settings → General).' )
			: self::item( 'title', 'Site title: ' . $name, 'ok' );

		$fp  = get_option( 'show_on_front' ) === 'page' ? (int) get_option( 'page_on_front' ) : 0;
		$items[] = ( $fp && 'publish' === get_post_status( $fp ) )
			? self::item( 'front', 'Home page is set and published', 'ok' )
			: self::item( 'front', 'No published home page is selected', 'bad', 'Set it in Settings → Reading, or ask the assistant to do it.' );

		$items[] = get_option( 'permalink_structure' )
			? self::item( 'perma', 'Pretty permalinks are on', 'ok' )
			: self::item( 'perma', 'Permalinks are set to the plain default', 'warn', 'Choose "Post name" in Settings → Permalinks for readable addresses.' );

		foreach ( CWAI_Health::quick() as $c ) {
			if ( in_array( $c['id'], array( 'visibility', 'alt', 'seo', 'placeholder', 'basics' ), true ) ) {
				$lvl = $c['level'];
				if ( 'visibility' === $c['id'] && 'bad' === $lvl && $o['preview'] ) {
					$lvl = 'info';
				}
				$detail = $c['detail'];
				if ( $c['items'] && 'ok' !== $c['level'] ) {
					$detail .= ' ' . implode( '; ', array_slice( wp_list_pluck( $c['items'], 'label' ), 0, 4 ) );
				}
				$items[] = self::item( $c['id'], $c['title'], $lvl, trim( $detail ) );
			}
		}

		$d = wp_count_posts( 'page' );
		if ( ! empty( $d->draft ) ) {
			$items[] = self::item( 'drafts', (int) $d->draft . ' page(s) are still drafts', 'warn', 'Publish the ones visitors should see, or leave them hidden on purpose.' );
		}

		$old = self::normalize_host( $old_host ?: $o['old_host'] );
		if ( $old && $old !== strtolower( (string) wp_parse_url( home_url(), PHP_URL_HOST ) ) ) {
			$n = self::scan_host( $old );
			$items[] = ( $n['posts'] + $n['meta'] )
				? self::item( 'oldhost', 'The old address ' . $old . ' appears in ' . $n['posts'] . ' page(s) and ' . $n['meta'] . ' builder/setting value(s)', 'bad', 'Use "Move the address" to swap it for the live domain.' )
				: self::item( 'oldhost', 'No leftovers of ' . $old . ' found', 'ok' );
		}
		return array( 'items' => $items, 'launched' => (int) $o['launched'], 'ready' => ! array_filter( $items, static function ( $i ) {
			return 'bad' === $i['level'];
		} ) );
	}

	/* ------------------------------------------------------------------ */
	/* Address swap                                                        */
	/* ------------------------------------------------------------------ */

	private static function scan_host( $host ) {
		global $wpdb;
		$like = '%' . $wpdb->esc_like( $host ) . '%';
		$posts = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type NOT IN ('revision','auto-draft') AND (post_content LIKE %s OR post_excerpt LIKE %s)", $like, $like ) ); // phpcs:ignore
		$meta  = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_value LIKE %s", $like ) ); // phpcs:ignore
		return array( 'posts' => $posts, 'meta' => $meta );
	}

	private static function swap( $val, $old, $new, &$count ) {
		if ( is_string( $val ) ) {
			if ( is_serialized( $val ) ) {
				$u = @unserialize( $val, array( 'allowed_classes' => false ) ); // phpcs:ignore
				if ( false !== $u || 'b:0;' === $val ) {
					$c = 0;
					$r = self::swap( $u, $old, $new, $c );
					if ( $c ) {
						$count += $c;
						return serialize( $r ); // phpcs:ignore
					}
				}
				return $val;
			}
			$c = substr_count( $val, $old );
			if ( $c ) {
				$count += $c;
				return str_replace( $old, $new, $val );
			}
			return $val;
		}
		if ( is_array( $val ) ) {
			foreach ( $val as $k => $v ) {
				$val[ $k ] = self::swap( $v, $old, $new, $count );
			}
		}
		return $val;
	}

	/** Replace $old host with $new host in post content/excerpts and post meta. If $only is given, only those rows. */
	public static function replace_host( $old, $new, $only = null ) {
		global $wpdb;
		$old = self::normalize_host( $old );
		$new = self::normalize_host( $new );
		if ( ! $old || ! $new || $old === $new ) {
			return new WP_Error( 'cwai_golive', 'Give two different addresses, like staging.example.com and www.example.com.' );
		}
		$like  = '%' . $wpdb->esc_like( $old ) . '%';
		$total = 0;
		$log   = array( 'old' => $old, 'new' => $new, 'posts' => array(), 'meta' => array(), 'at' => time() );

		$rows = $wpdb->get_results( $wpdb->prepare( "SELECT ID, post_content, post_excerpt FROM {$wpdb->posts} WHERE post_type NOT IN ('revision','auto-draft') AND (post_content LIKE %s OR post_excerpt LIKE %s) LIMIT 5000", $like, $like ), ARRAY_A ); // phpcs:ignore
		foreach ( $rows as $r ) {
			if ( null !== $only && ! in_array( (int) $r['ID'], $only['posts'], true ) ) {
				continue;
			}
			$c       = 0;
			$content = self::swap( $r['post_content'], $old, $new, $c );
			$excerpt = self::swap( $r['post_excerpt'], $old, $new, $c );
			if ( $c ) {
				$wpdb->update( $wpdb->posts, array( 'post_content' => $content, 'post_excerpt' => $excerpt ), array( 'ID' => (int) $r['ID'] ) );
				clean_post_cache( (int) $r['ID'] );
				$log['posts'][] = (int) $r['ID'];
				$total         += $c;
			}
		}
		$rows = $wpdb->get_results( $wpdb->prepare( "SELECT meta_id, post_id, meta_value FROM {$wpdb->postmeta} WHERE meta_value LIKE %s LIMIT 20000", $like ), ARRAY_A ); // phpcs:ignore
		foreach ( $rows as $r ) {
			if ( null !== $only && ! in_array( (int) $r['meta_id'], $only['meta'], true ) ) {
				continue;
			}
			$c = 0;
			$v = self::swap( $r['meta_value'], $old, $new, $c );
			if ( $c ) {
				$wpdb->update( $wpdb->postmeta, array( 'meta_value' => $v ), array( 'meta_id' => (int) $r['meta_id'] ) );
				wp_cache_delete( (int) $r['post_id'], 'post_meta' );
				$log['meta'][] = (int) $r['meta_id'];
				$total        += $c;
			}
		}
		$log['replacements'] = $total;
		return $log;
	}

	/* ------------------------------------------------------------------ */
	/* Operations                                                          */
	/* ------------------------------------------------------------------ */

	private static function purge() {
		try {
			if ( class_exists( 'CWAI_Tools_Site' ) ) {
				CWAI_Tools_Site::purge( array(), true );
			}
		} catch ( Throwable $e ) { // phpcs:ignore
		}
	}

	public static function apply( $op, array $in = array() ) {
		$o = self::opts();
		switch ( $op ) {
			case 'preview_on':
				$o['preview'] = true;
				if ( ! empty( $in['label'] ) ) {
					$o['label'] = mb_substr( wp_strip_all_tags( (string) $in['label'] ), 0, 140 );
				}
				update_option( 'blog_public', 0 );
				self::save( $o );
				self::purge();
				return array( 'done' => true, 'note' => 'Preview mode is on: a banner shows and search engines are told not to index the site.' );
			case 'preview_off':
				$o['preview'] = false;
				self::save( $o );
				self::purge();
				return array( 'done' => true, 'note' => 'Preview mode is off. Search engine visibility was not changed.' );
			case 'launch':
				$o['preview']  = false;
				$o['launched'] = time();
				update_option( 'blog_public', 1 );
				self::save( $o );
				self::purge();
				return array( 'done' => true, 'note' => 'The site is live: the preview banner is gone and search engines are allowed. Work through the manual steps on the Go live page (domain, Search Console, forms).' );
			case 'allow_search':
				update_option( 'blog_public', 1 );
				return array( 'done' => true, 'note' => 'Search engines are allowed.' );
			case 'hide_search':
				update_option( 'blog_public', 0 );
				return array( 'done' => true, 'note' => 'Search engines are asked not to index the site.' );
			case 'replace_host':
				$res = self::replace_host( $in['old_host'] ?? '', $in['new_host'] ?? '' );
				if ( is_wp_error( $res ) ) {
					return $res;
				}
				$o['last_replace'] = $res;
				$o['old_host']     = $res['old'];
				self::save( $o );
				self::purge();
				return array( 'done' => true, 'replacements' => $res['replacements'], 'pages' => count( $res['posts'] ), 'values' => count( $res['meta'] ), 'note' => 'Swapped ' . $res['old'] . ' for ' . $res['new'] . '. This can be reversed once from the Go live page. Regenerate the builder CSS afterwards.' );
			case 'reverse_replace':
				$l = $o['last_replace'];
				if ( ! is_array( $l ) || empty( $l['old'] ) ) {
					return new WP_Error( 'cwai_golive', 'There is no address swap to reverse.' );
				}
				$res = self::replace_host( $l['new'], $l['old'], array( 'posts' => (array) $l['posts'], 'meta' => (array) $l['meta'] ) );
				if ( is_wp_error( $res ) ) {
					return $res;
				}
				$o['last_replace'] = null;
				self::save( $o );
				self::purge();
				return array( 'done' => true, 'replacements' => $res['replacements'], 'note' => 'Put ' . $l['old'] . ' back.' );
		}
		return new WP_Error( 'cwai_golive', 'Unknown action.' );
	}

	/* ------------------------------------------------------------------ */
	/* Tools                                                               */
	/* ------------------------------------------------------------------ */

	public static function register_tools() {
		$p = array( 'CWAI_Tools_Content', 'p' );
		$s = array( 'CWAI_Tools_Content', 'schema' );
		CWAI_Registry::add( 'cwai/golive-check', array(
			'label'       => 'Go-live check',
			'description' => 'Launch readiness: preview mode, site title, home page, permalinks, search-engine visibility, image alt text, SEO listings, placeholder text, draft pages and (when old_host is given) leftovers of the old staging address. Read-only. Returns items with level ok/warn/bad/info and ready=true when nothing is "bad".',
			'input'       => call_user_func( $s, array( 'old_host' => call_user_func( $p, 'string', 'The previous/staging address to look for, e.g. staging.example.com (optional).' ) ) ),
			'callback'    => array( __CLASS__, 't_check' ),
			'readonly'    => true,
		) );
		CWAI_Registry::add( 'cwai/golive-apply', array(
			'label'       => 'Preview mode, launch and address swap',
			'description' => 'Change launch state. op: preview_on (banner + noindex, for a site shown to a prospect or client before launch), preview_off, launch (preview off + allow search engines), allow_search, hide_search, replace_host (swap old_host for new_host inside pages and builder data; reversible once with reverse_replace), reverse_replace. Always needs the person\'s approval. Only run launch when they clearly ask to go live. Run cwai__golive-check first and report problems. replace_host does not change the WordPress address setting or DNS; those are manual steps.',
			'input'       => call_user_func( $s, array(
				'op'       => call_user_func( $p, 'string', 'preview_on, preview_off, launch, allow_search, hide_search, replace_host or reverse_replace.', array( 'enum' => array( 'preview_on', 'preview_off', 'launch', 'allow_search', 'hide_search', 'replace_host', 'reverse_replace' ) ) ),
				'label'    => call_user_func( $p, 'string', 'For preview_on: the banner text (optional).' ),
				'old_host' => call_user_func( $p, 'string', 'For replace_host: the address to replace.' ),
				'new_host' => call_user_func( $p, 'string', 'For replace_host: the live address.' ),
			), array( 'op' ) ),
			'callback'    => array( __CLASS__, 't_apply' ),
			'approval'    => true,
			'admin'       => true,
			'capability'  => 'manage_options',
		) );
	}

	public static function t_check( $in ) {
		return self::check( (string) ( $in['old_host'] ?? '' ) );
	}
	public static function t_apply( $in ) {
		return self::apply( (string) ( $in['op'] ?? '' ), $in );
	}

	public static function prompt_section() {
		$on = self::is_preview() ? ' Preview mode is currently ON for this site.' : '';
		return "## Previews and launching\n- A site can be a preview (a banner and noindex) or live. cwai__golive-apply changes that and always needs approval. When someone asks if the site is ready, run cwai__golive-check and cwai__site-health, summarise in priority order, and fix only what is safe. Never launch unless they clearly ask. After a launch, remind them of the manual steps (domain/DNS, Settings → General address, permalinks, Search Console, test the forms)." . $on;
	}

	/* ------------------------------------------------------------------ */
	/* Admin page                                                          */
	/* ------------------------------------------------------------------ */

	public static function menu() {
		add_submenu_page( 'cwai-chat', __( 'Go live', 'cwai' ), __( 'Go live', 'cwai' ), 'manage_options', 'cwai-golive', array( __CLASS__, 'render_page' ) );
	}

	public static function handle() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Not allowed.', 'cwai' ) );
		}
		check_admin_referer( 'cwai_golive' );
		$do  = isset( $_POST['do'] ) ? sanitize_key( wp_unslash( $_POST['do'] ) ) : ''; // phpcs:ignore
		$msg = '';
		$o   = self::opts();
		if ( 'steps' === $do ) {
			$o['steps'] = array();
			foreach ( (array) ( $_POST['step'] ?? array() ) as $k ) { // phpcs:ignore
				$k = sanitize_key( $k );
				if ( isset( self::STEPS[ $k ] ) ) {
					$o['steps'][ $k ] = true;
				}
			}
			self::save( $o );
			$msg = 'Saved.';
		} elseif ( 'scan' === $do ) {
			$o['old_host'] = self::normalize_host( wp_unslash( $_POST['old_host'] ?? '' ) ); // phpcs:ignore
			self::save( $o );
			$msg = $o['old_host'] ? 'Looked for ' . $o['old_host'] . '.' : 'That does not look like an address.';
		} else {
			$map = array( 'preview_on' => 'preview_on', 'preview_off' => 'preview_off', 'launch' => 'launch', 'replace' => 'replace_host', 'reverse' => 'reverse_replace' );
			if ( isset( $map[ $do ] ) ) {
				$res = self::apply( $map[ $do ], array( 'old_host' => wp_unslash( $_POST['old_host'] ?? '' ), 'new_host' => wp_unslash( $_POST['new_host'] ?? '' ), 'label' => wp_unslash( $_POST['label'] ?? '' ) ) ); // phpcs:ignore
				$msg = is_wp_error( $res ) ? $res->get_error_message() : $res['note'];
			}
		}
		set_transient( 'cwai_golive_msg_' . get_current_user_id(), $msg, 60 );
		wp_safe_redirect( admin_url( 'admin.php?page=cwai-golive' ) );
		exit;
	}

	private static function form( $do, $inner, $confirm = '' ) {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '"' . ( $confirm ? ' onsubmit="return confirm(' . esc_attr( wp_json_encode( $confirm ) ) . ')"' : '' ) . '><input type="hidden" name="action" value="cwai_golive"><input type="hidden" name="do" value="' . esc_attr( $do ) . '">';
		wp_nonce_field( 'cwai_golive' );
		echo $inner . '</form>'; // phpcs:ignore
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$o   = self::opts();
		$chk = self::check();
		$msg = get_transient( 'cwai_golive_msg_' . get_current_user_id() );
		delete_transient( 'cwai_golive_msg_' . get_current_user_id() );
		echo '<div class="wrap"><h1>' . esc_html__( 'Go live', 'cwai' ) . '</h1>';
		if ( $msg ) {
			echo '<div class="notice notice-info is-dismissible"><p>' . esc_html( $msg ) . '</p></div>';
		}
		$col = array( 'ok' => '#1a7f37', 'warn' => '#b26a00', 'bad' => '#b00020', 'info' => '#555' );
		$ico = array( 'ok' => '✔', 'warn' => '!', 'bad' => '✖', 'info' => 'i' );
		echo '<h2>' . esc_html__( '1. Launch checklist', 'cwai' ) . '</h2><div style="max-width:860px">';
		foreach ( $chk['items'] as $i ) {
			echo '<div style="padding:6px 10px;margin:4px 0;background:#fff;border-left:4px solid ' . esc_attr( $col[ $i['level'] ] ) . '"><strong style="color:' . esc_attr( $col[ $i['level'] ] ) . '">' . esc_html( $ico[ $i['level'] ] ) . '</strong> ' . esc_html( $i['label'] ) . ( $i['detail'] ? '<div class="description">' . esc_html( $i['detail'] ) . '</div>' : '' ) . '</div>';
		}
		echo '</div><p><a class="button" href="' . esc_url( admin_url( 'admin.php?page=cwai-health' ) ) . '">' . esc_html__( 'Run the full site health check', 'cwai' ) . '</a> <a class="button" href="' . esc_url( admin_url( 'admin.php?page=cwai-chat&cwai_prompt=' . rawurlencode( CWAI_Routines::defaults()[3]['prompt'] ) ) ) . '">' . esc_html__( 'Ask the assistant to get it ready', 'cwai' ) . '</a></p>';

		echo '<h2>' . esc_html__( '2. Preview mode', 'cwai' ) . '</h2><p class="description" style="max-width:780px">' . esc_html__( 'Use this while the site is a design preview for someone to review. A small banner shows on every page and search engines are told to ignore it.', 'cwai' ) . '</p>';
		if ( $o['preview'] ) {
			self::form( 'preview_off', '<p><button class="button">' . esc_html__( 'Turn preview mode off', 'cwai' ) . '</button></p>' );
		} else {
			self::form( 'preview_on', '<p><input type="text" class="regular-text" name="label" value="' . esc_attr( $o['label'] ) . '" maxlength="140"> <button class="button">' . esc_html__( 'Turn preview mode on', 'cwai' ) . '</button></p>' );
		}

		echo '<h2>' . esc_html__( '3. Launch', 'cwai' ) . '</h2>';
		if ( $o['launched'] ) {
			echo '<p>' . esc_html( sprintf( /* translators: %s: date */ __( 'Launched on %s.', 'cwai' ), wp_date( get_option( 'date_format' ), $o['launched'] ) ) ) . '</p>';
		}
		self::form( 'launch', '<p><button class="button button-primary">' . esc_html__( 'Launch the site', 'cwai' ) . '</button> <span class="description">' . esc_html__( 'Turns preview mode off and allows search engines.', 'cwai' ) . '</span></p>', $chk['ready'] ? 'Launch the site now?' : 'There are still problems marked in red. Launch anyway?' );

		echo '<h2>' . esc_html__( '4. Move the address', 'cwai' ) . '</h2><p class="description" style="max-width:780px">' . esc_html__( 'If pages or the builder still contain the old staging address, swap it for the live one. Take a backup first. You can reverse the last swap once.', 'cwai' ) . '</p>';
		self::form( 'scan', '<p><input type="text" class="regular-text" name="old_host" placeholder="staging.example.com" value="' . esc_attr( $o['old_host'] ) . '"> <button class="button">' . esc_html__( 'Look for it', 'cwai' ) . '</button></p>' );
		if ( $o['old_host'] ) {
			self::form( 'replace', '<p><input type="hidden" name="old_host" value="' . esc_attr( $o['old_host'] ) . '"> ' . esc_html__( 'Replace with:', 'cwai' ) . ' <input type="text" class="regular-text" name="new_host" placeholder="www.example.com"> <button class="button">' . esc_html__( 'Swap the address', 'cwai' ) . '</button></p>', 'Swap the address everywhere it appears? Take a backup first.' );
		}
		if ( ! empty( $o['last_replace']['old'] ) ) {
			self::form( 'reverse', '<p><button class="button">' . esc_html( sprintf( /* translators: 1: new host 2: old host */ __( 'Undo the last swap (put %2$s back instead of %1$s)', 'cwai' ), $o['last_replace']['new'], $o['last_replace']['old'] ) ) . '</button></p>', 'Reverse the last address swap?' );
		}

		echo '<h2>' . esc_html__( '5. Steps only you can do', 'cwai' ) . '</h2>';
		$inner = '';
		foreach ( self::STEPS as $k => $label ) {
			$inner .= '<p style="margin:4px 0"><label><input type="checkbox" name="step[]" value="' . esc_attr( $k ) . '"' . checked( ! empty( $o['steps'][ $k ] ), true, false ) . '> ' . esc_html( $label ) . '</label></p>';
		}
		self::form( 'steps', $inner . '<p><button class="button">' . esc_html__( 'Save progress', 'cwai' ) . '</button></p>' );
		echo '</div>';
	}
}
