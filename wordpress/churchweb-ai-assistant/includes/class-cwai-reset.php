<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Reset site: clear a site's content so it can be built again from scratch (a preview that is finished, a bad migration,
 * a new build). Administrators only, from one admin page. It never runs from the chat, never on a launched (live) site, and
 * only after a typed confirmation and a "I have a backup" tick. Users, plugins, settings and the assistant's connection stay.
 * Work runs in small batches from the browser so it cannot time out.
 */
final class CWAI_Reset {

	const LOG  = 'cwai_reset_log';
	const LOCK = 'cwai_reset_lock';

	/** Post types that are configuration, not content: never touched here. */
	const PROTECT = array( 'attachment', 'nav_menu_item', 'revision', 'customize_changeset', 'wp_global_styles', 'wp_template', 'wp_template_part', 'wp_navigation', 'wp_block', 'wp_font_family', 'wp_font_face', 'user_request', 'oembed_cache', 'custom_css', 'cwai_kb', 'wpcf7_contact_form' );
	const PROTECT_RE = '#^(acf-|oxygen|rank_math|elementor|e-floating|jet-|fl-builder)#i';
	const SKIP_TAX = array( 'post_format', 'nav_menu', 'link_category', 'wp_theme', 'wp_template_part_area', 'wp_pattern_category' );

	/** Options holding the assistant's per-build data (settings, keys and staff view are kept). */
	const ASSISTANT_OPTIONS = array( 'cwai_import', 'cwai_import_state', 'cwai_wizard', 'cwai_design', 'cwai_img_usage', 'cwai_health', 'cwai_bot_log', 'cwai_bot_usage', 'cwai_usage', 'cwai_flush', 'cwai_sv_seen' );

	public static function boot() {
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 29 );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
	}

	/* ------------------------------------------------------------------ */
	/* What can be cleared                                                 */
	/* ------------------------------------------------------------------ */

	public static function content_types() {
		$out = array();
		foreach ( get_post_types( array(), 'objects' ) as $pt ) {
			if ( in_array( $pt->name, self::PROTECT, true ) || preg_match( self::PROTECT_RE, $pt->name ) || ! ( $pt->public || $pt->show_ui ) ) {
				continue;
			}
			$out[ $pt->name ] = $pt;
		}
		return $out;
	}

	private static function oxygen_types() {
		$o = array();
		foreach ( get_post_types( array(), 'names' ) as $n ) {
			if ( 0 === strpos( $n, 'oxygen' ) ) {
				$o[] = $n;
			}
		}
		return $o;
	}

	private static function stati( $mode ) {
		return 'trash' === $mode ? array( 'publish', 'future', 'draft', 'pending', 'private' ) : array_values( get_post_stati() );
	}

	private static function count_posts( array $types, $mode ) {
		if ( ! $types ) {
			return 0;
		}
		$q = new WP_Query( array( 'post_type' => $types, 'post_status' => self::stati( $mode ), 'posts_per_page' => 1, 'fields' => 'ids', 'suppress_filters' => true, 'no_found_rows' => false ) );
		return (int) $q->found_posts;
	}

	private static function term_ids( $limit, &$remaining = null ) {
		$ids  = array();
		$all  = 0;
		$keep = array_filter( array( (int) get_option( 'default_category' ), (int) get_option( 'default_link_category' ) ) );
		foreach ( get_taxonomies( array(), 'names' ) as $tax ) {
			if ( in_array( $tax, self::SKIP_TAX, true ) ) {
				continue;
			}
			$t = get_terms( array( 'taxonomy' => $tax, 'hide_empty' => false, 'fields' => 'ids', 'exclude' => $keep, 'number' => 0 ) );
			if ( is_wp_error( $t ) ) {
				continue;
			}
			$all += count( $t );
			foreach ( $t as $id ) {
				if ( count( $ids ) < $limit ) {
					$ids[] = array( (int) $id, $tax );
				}
			}
		}
		$remaining = $all;
		return $ids;
	}

	private static function count_comments() {
		global $wpdb;
		return (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->comments}" ); // phpcs:ignore
	}

	private static function count_media() {
		global $wpdb;
		return (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'attachment'" ); // phpcs:ignore
	}

	private static function count_kb() {
		return self::count_posts( array( 'cwai_kb' ), 'permanent' );
	}

	/** Everything the page offers, with live counts. */
	public static function inventory( $mode = 'trash' ) {
		$types = array();
		foreach ( self::content_types() as $pt ) {
			$n = self::count_posts( array( $pt->name ), $mode );
			$all = self::count_posts( array( $pt->name ), 'permanent' );
			$types[] = array( 'slug' => $pt->name, 'label' => $pt->labels->name, 'count' => $n, 'total' => $all );
		}
		$ox = self::oxygen_types();
		self::term_ids( 1, $tr );
		return array(
			'types'     => $types,
			'media'     => self::count_media(),
			'menus'     => count( wp_get_nav_menus() ),
			'terms'     => (int) $tr,
			'comments'  => self::count_comments(),
			'assistant' => array( 'chats' => self::count_table( 'conversations' ), 'knowledge' => self::count_kb() ),
			'oxygen'    => $ox ? self::count_posts( $ox, 'permanent' ) : 0,
			'oxygen_types' => $ox,
			'has_types_def' => (bool) get_option( 'cwai_content_types' ),
		);
	}

	private static function count_table( $t ) {
		global $wpdb;
		return (int) $wpdb->get_var( 'SELECT COUNT(*) FROM ' . CWAI_Store::t( $t ) ); // phpcs:ignore
	}

	/** Why a reset must not run now (null when it may). */
	public static function blocked() {
		$g = CWAI_Golive::opts();
		if ( (int) $g['launched'] > 0 && empty( $g['preview'] ) ) {
			return 'This site was launched, so it cannot be reset. If you really need a clean slate, turn on preview mode on the Go live page first.';
		}
		$l = get_transient( self::LOCK );
		if ( is_array( $l ) && time() - (int) $l['at'] < 120 ) {
			return 'A reset is already running. Wait for it to finish (or two minutes if it was interrupted).';
		}
		return null;
	}

	/* ------------------------------------------------------------------ */
	/* Start and step                                                      */
	/* ------------------------------------------------------------------ */

	public static function start( array $in ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			return new WP_Error( 'cwai_reset', 'Only administrators can reset the site.', array( 'status' => 403 ) );
		}
		$b = self::blocked();
		if ( $b ) {
			return new WP_Error( 'cwai_reset', $b, array( 'status' => 409 ) );
		}
		$name = trim( (string) get_option( 'blogname' ) );
		$want = '' !== $name ? $name : 'RESET';
		if ( trim( (string) ( $in['confirm'] ?? '' ) ) !== $want ) {
			return new WP_Error( 'cwai_reset', 'Type the site name exactly as shown to confirm.', array( 'status' => 400 ) );
		}
		if ( empty( $in['backup'] ) ) {
			return new WP_Error( 'cwai_reset', 'Confirm that you have a recent backup.', array( 'status' => 400 ) );
		}
		$mode = 'permanent' === ( $in['mode'] ?? '' ) ? 'permanent' : 'trash';
		$inv  = self::inventory( $mode );
		$valid = wp_list_pluck( $inv['types'], 'slug' );
		$types = array_values( array_intersect( array_map( 'sanitize_key', (array) ( $in['types'] ?? array() ) ), $valid ) );
		$scopes = array();
		foreach ( array( 'media', 'menus', 'terms', 'comments', 'assistant', 'oxygen', 'typedefs' ) as $s ) {
			if ( ! empty( $in['scopes'][ $s ] ) ) {
				$scopes[] = $s;
			}
		}
		if ( ! $types && ! $scopes ) {
			return new WP_Error( 'cwai_reset', 'Choose something to clear.', array( 'status' => 400 ) );
		}
		$token = wp_generate_password( 24, false );
		$job   = array( 'user' => get_current_user_id(), 'mode' => $mode, 'types' => $types, 'scopes' => $scopes, 'at' => time(), 'done' => array(), 'before' => $inv );
		set_transient( 'cwai_reset_' . $token, $job, HOUR_IN_SECONDS );
		set_transient( self::LOCK, array( 'at' => time(), 'user' => get_current_user_id() ), 30 * MINUTE_IN_SECONDS );
		CWAI_Store::audit( get_current_user_id(), 0, 'cwai/reset-site', 'ok', 'Started a site reset (' . $mode . '): ' . implode( ', ', array_merge( $types, $scopes ) ) );
		return array( 'token' => $token, 'plan' => self::remaining( $job ) );
	}

	/** Items still to clear, by step. */
	private static function remaining( array $job ) {
		$r = array();
		if ( $job['types'] ) {
			$r['content'] = array( 'label' => 'Pages, posts and other content', 'left' => self::count_posts( $job['types'], $job['mode'] ) );
		}
		foreach ( $job['scopes'] as $s ) {
			switch ( $s ) {
				case 'terms':
					self::term_ids( 1, $n );
					$r['terms'] = array( 'label' => 'Categories, tags and other terms', 'left' => (int) $n );
					break;
				case 'menus':
					$r['menus'] = array( 'label' => 'Menus', 'left' => count( wp_get_nav_menus() ) );
					break;
				case 'comments':
					$r['comments'] = array( 'label' => 'Comments', 'left' => self::count_comments() );
					break;
				case 'media':
					$r['media'] = array( 'label' => 'Media files', 'left' => self::count_media() );
					break;
				case 'oxygen':
					$ox = self::oxygen_types();
					$r['oxygen'] = array( 'label' => 'Oxygen templates and parts', 'left' => $ox ? self::count_posts( $ox, 'permanent' ) : 0 );
					break;
				case 'assistant':
					$r['assistant'] = array( 'label' => 'Assistant data (imports, chats, knowledge)', 'left' => ( ! empty( $job['done']['assistant'] ) ) ? 0 : 1 );
					break;
				case 'typedefs':
					$r['typedefs'] = array( 'label' => 'Content-type definitions', 'left' => get_option( 'cwai_content_types' ) ? 1 : 0 );
					break;
			}
		}
		return $r;
	}

	public static function step( $token ) {
		$job = get_transient( 'cwai_reset_' . sanitize_key( $token ) );
		if ( ! is_array( $job ) || (int) $job['user'] !== get_current_user_id() || ! current_user_can( 'manage_options' ) ) {
			return new WP_Error( 'cwai_reset', 'This reset is not active. Start it again.', array( 'status' => 410 ) );
		}
		set_time_limit( 60 ); // phpcs:ignore
		$deadline = microtime( true ) + 4.0;
		$mode     = $job['mode'];
		$log      = array();
		// Order: content, terms, menus, comments, media, oxygen, assistant, definitions.
		if ( $job['types'] ) {
			$log['content'] = self::clear_content( $job['types'], $mode, $deadline );
		}
		foreach ( array( 'terms', 'menus', 'comments', 'media', 'oxygen', 'assistant', 'typedefs' ) as $s ) {
			if ( microtime( true ) > $deadline || ! in_array( $s, $job['scopes'], true ) ) {
				continue;
			}
			$log[ $s ] = call_user_func( array( __CLASS__, 'clear_' . $s ), $job, $deadline );
		}
		foreach ( $log as $k => $n ) {
			$job['totals'][ $k ] = ( $job['totals'][ $k ] ?? 0 ) + (int) $n;
		}
		if ( in_array( 'assistant', $job['scopes'], true ) && isset( $log['assistant'] ) ) {
			$job['done']['assistant'] = true;
		}
		$rem  = self::remaining( $job );
		$left = array_sum( wp_list_pluck( $rem, 'left' ) );
		if ( $left > 0 ) {
			// A batch that removed nothing but left work behind would loop forever: stop and say so.
			if ( ! array_sum( $log ) ) {
				$job['stalls'] = ( $job['stalls'] ?? 0 ) + 1;
				if ( $job['stalls'] >= 3 ) {
					delete_transient( 'cwai_reset_' . sanitize_key( $token ) );
					delete_transient( self::LOCK );
					return new WP_Error( 'cwai_reset', 'Some items could not be removed, so the reset stopped. What is left is shown in the list above.', array( 'status' => 500, 'remaining' => $rem ) );
				}
			} else {
				$job['stalls'] = 0;
			}
			set_transient( 'cwai_reset_' . sanitize_key( $token ), $job, HOUR_IN_SECONDS );
			set_transient( self::LOCK, array( 'at' => time(), 'user' => get_current_user_id() ), 30 * MINUTE_IN_SECONDS );
			return array( 'done' => false, 'remaining' => $rem );
		}
		return self::finish( $token, $job );
	}

	private static function finish( $token, array $job ) {
		// A front page that no longer exists would leave the site pointing at nothing.
		$fp = (int) get_option( 'page_on_front' );
		if ( $fp && ( ! get_post( $fp ) || 'trash' === get_post_status( $fp ) ) ) {
			update_option( 'show_on_front', 'posts' );
			update_option( 'page_on_front', 0 );
		}
		$pp = (int) get_option( 'page_for_posts' );
		if ( $pp && ( ! get_post( $pp ) || 'trash' === get_post_status( $pp ) ) ) {
			update_option( 'page_for_posts', 0 );
		}
		flush_rewrite_rules( false );
		CWAI_Tools_Site::purge( array(), true );
		delete_transient( 'cwai_reset_' . sanitize_key( $token ) );
		delete_transient( self::LOCK );
		$summary = array( 'at' => time(), 'user' => get_current_user_id(), 'mode' => $job['mode'], 'totals' => (array) ( $job['totals'] ?? array() ) );
		update_option( self::LOG, $summary, false );
		CWAI_Store::audit( get_current_user_id(), 0, 'cwai/reset-site', 'ok', 'Finished a site reset (' . $job['mode'] . '): ' . wp_json_encode( $summary['totals'] ) );
		return array( 'done' => true, 'summary' => $summary );
	}

	/* ------------------------------------------------------------------ */
	/* The clearing steps                                                  */
	/* ------------------------------------------------------------------ */

	private static function clear_content( array $types, $mode, $deadline ) {
		$n = 0;
		while ( microtime( true ) < $deadline ) {
			$ids = get_posts( array( 'post_type' => $types, 'post_status' => self::stati( $mode ), 'posts_per_page' => 25, 'fields' => 'ids', 'suppress_filters' => true, 'orderby' => 'ID', 'order' => 'DESC' ) );
			if ( ! $ids ) {
				break;
			}
			foreach ( $ids as $id ) {
				$ok = 'trash' === $mode ? wp_trash_post( $id ) : wp_delete_post( $id, true );
				if ( $ok ) {
					$n++;
				}
			}
			if ( ! $n ) {
				break;
			}
		}
		return $n;
	}

	private static function clear_terms( array $job, $deadline ) {
		$n = 0;
		while ( microtime( true ) < $deadline ) {
			$batch = self::term_ids( 100 );
			if ( ! $batch ) {
				break;
			}
			$did = 0;
			foreach ( $batch as $t ) {
				$r = wp_delete_term( $t[0], $t[1] );
				if ( $r && ! is_wp_error( $r ) ) {
					$did++;
				}
			}
			$n += $did;
			if ( ! $did ) {
				break;
			}
		}
		return $n;
	}

	private static function clear_menus( array $job, $deadline ) {
		$n = 0;
		foreach ( wp_get_nav_menus() as $m ) {
			if ( wp_delete_nav_menu( $m->term_id ) ) {
				$n++;
			}
		}
		return $n;
	}

	private static function clear_comments( array $job, $deadline ) {
		global $wpdb;
		$n = 0;
		while ( microtime( true ) < $deadline ) {
			$ids = $wpdb->get_col( "SELECT comment_ID FROM {$wpdb->comments} ORDER BY comment_ID DESC LIMIT 200" ); // phpcs:ignore
			if ( ! $ids ) {
				break;
			}
			$did = 0;
			foreach ( $ids as $id ) {
				if ( wp_delete_comment( (int) $id, true ) ) {
					$did++;
				}
			}
			$n += $did;
			if ( ! $did ) {
				break;
			}
		}
		return $n;
	}

	private static function clear_media( array $job, $deadline ) {
		$n = 0;
		while ( microtime( true ) < $deadline ) {
			$ids = get_posts( array( 'post_type' => 'attachment', 'post_status' => array_values( get_post_stati() ), 'posts_per_page' => 15, 'fields' => 'ids', 'suppress_filters' => true ) );
			if ( ! $ids ) {
				break;
			}
			$did = 0;
			foreach ( $ids as $id ) {
				if ( wp_delete_attachment( $id, true ) ) {
					$did++;
				}
			}
			$n += $did;
			if ( ! $did ) {
				break;
			}
		}
		return $n;
	}

	private static function clear_oxygen( array $job, $deadline ) {
		$types = self::oxygen_types();
		return $types ? self::clear_content( $types, 'permanent', $deadline ) : 0;
	}

	private static function clear_assistant( array $job, $deadline ) {
		global $wpdb;
		$n = 0;
		foreach ( self::ASSISTANT_OPTIONS as $o ) {
			if ( false !== get_option( $o, false ) ) {
				delete_option( $o );
				$n++;
			}
		}
		foreach ( array( 'conversations', 'snapshots', 'audit' ) as $t ) {
			$n += (int) $wpdb->query( 'DELETE FROM ' . CWAI_Store::t( $t ) ); // phpcs:ignore
		}
		self::clear_content( array( 'cwai_kb' ), 'permanent', $deadline + 5 );
		$g = get_option( CWAI_Golive::OPT, array() );
		if ( is_array( $g ) ) {
			$g['last_replace'] = null;
			$g['old_host']     = '';
			$g['steps']        = array();
			update_option( CWAI_Golive::OPT, $g, false );
		}
		delete_transient( 'cwai_health_links' );
		delete_transient( 'cwai_health_links_found' );
		delete_transient( 'cwai_gw_usage' );
		return max( 1, $n );
	}

	private static function clear_typedefs( array $job, $deadline ) {
		if ( false === get_option( 'cwai_content_types', false ) ) {
			return 0;
		}
		delete_option( 'cwai_content_types' );
		return 1;
	}

	/* ------------------------------------------------------------------ */
	/* REST and page                                                       */
	/* ------------------------------------------------------------------ */

	public static function routes() {
		$a = static function () {
			return current_user_can( 'manage_options' );
		};
		register_rest_route( CWAI_REST::NS, '/reset/inventory', array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'rest_inventory' ), 'permission_callback' => $a ) );
		register_rest_route( CWAI_REST::NS, '/reset/start', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'rest_start' ), 'permission_callback' => $a ) );
		register_rest_route( CWAI_REST::NS, '/reset/step', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'rest_step' ), 'permission_callback' => $a ) );
	}

	public static function rest_inventory( WP_REST_Request $r ) {
		return array( 'inventory' => self::inventory( 'permanent' === $r->get_param( 'mode' ) ? 'permanent' : 'trash' ), 'blocked' => self::blocked() );
	}
	public static function rest_start( WP_REST_Request $r ) {
		return self::start( (array) $r->get_json_params() );
	}
	public static function rest_step( WP_REST_Request $r ) {
		return self::step( (string) $r->get_param( 'token' ) );
	}

	public static function menu() {
		add_submenu_page( 'cwai-chat', __( 'Reset site', 'cwai' ), __( 'Reset site', 'cwai' ), 'manage_options', 'cwai-reset', array( __CLASS__, 'render_page' ) );
	}

	public static function enqueue() {
		if ( ! isset( $_GET['page'] ) || 'cwai-reset' !== $_GET['page'] ) { // phpcs:ignore
			return;
		}
		wp_enqueue_script( 'cwai-reset', CWAI_URL . 'assets/reset.js', array(), CWAI_VERSION, true );
		$name = trim( (string) get_option( 'blogname' ) );
		wp_localize_script( 'cwai-reset', 'CWAI_R', array(
			'root'    => esc_url_raw( rest_url( CWAI_REST::NS ) ),
			'nonce'   => wp_create_nonce( 'wp_rest' ),
			'want'    => '' !== $name ? $name : 'RESET',
			'blocked' => self::blocked(),
		) );
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$name = trim( (string) get_option( 'blogname' ) );
		$want = '' !== $name ? $name : 'RESET';
		$log  = get_option( self::LOG );
		echo '<div class="wrap" id="cwr"><h1>' . esc_html__( 'Reset site', 'cwai' ) . '</h1>';
		echo '<div class="notice notice-warning inline" style="max-width:860px"><p><strong>' . esc_html__( 'This clears content from this site so it can be built again.', 'cwai' ) . '</strong> ' . esc_html__( 'Users, plugins, settings and the assistant connection are kept. It cannot run on a launched site, and it never runs from the chat.', 'cwai' ) . '</p></div>';
		if ( is_array( $log ) ) {
			echo '<p class="description">' . esc_html( sprintf( /* translators: 1: time ago 2: mode */ __( 'Last reset: %1$s ago (%2$s).', 'cwai' ), human_time_diff( (int) $log['at'] ), 'permanent' === $log['mode'] ? __( 'permanent', 'cwai' ) : __( 'to trash', 'cwai' ) ) ) . '</p>';
		}
		$b = self::blocked();
		if ( $b ) {
			echo '<div class="notice notice-error inline" style="max-width:860px"><p>' . esc_html( $b ) . '</p></div>';
		}
		echo '<div id="cwr-form" style="max-width:860px' . ( $b ? ';opacity:.5;pointer-events:none' : '' ) . '">';
		echo '<h2>' . esc_html__( '1. How', 'cwai' ) . '</h2>';
		echo '<label style="display:block;margin:4px 0"><input type="radio" name="cwr-mode" value="trash" checked> <strong>' . esc_html__( 'Move to the trash', 'cwai' ) . '</strong> ' . esc_html__( '(pages and posts can be restored from the trash; media files cannot)', 'cwai' ) . '</label>';
		echo '<label style="display:block;margin:4px 0"><input type="radio" name="cwr-mode" value="permanent"> <strong>' . esc_html__( 'Delete permanently', 'cwai' ) . '</strong> ' . esc_html__( '(also empties anything already in the trash)', 'cwai' ) . '</label>';
		echo '<h2>' . esc_html__( '2. What to clear', 'cwai' ) . '</h2><div id="cwr-list"><p class="description">' . esc_html__( 'Counting…', 'cwai' ) . '</p></div>';
		echo '<h2>' . esc_html__( '3. Confirm', 'cwai' ) . '</h2>';
		echo '<label style="display:block;margin:6px 0"><input type="checkbox" id="cwr-backup"> ' . esc_html__( 'I have a recent backup of this site.', 'cwai' );
		if ( class_exists( 'UpdraftPlus' ) || defined( 'UPDRAFTPLUS_DIR' ) ) {
			echo ' <a href="' . esc_url( admin_url( 'options-general.php?page=updraftplus' ) ) . '">' . esc_html__( 'Open UpdraftPlus to take one', 'cwai' ) . '</a>';
		}
		echo '</label>';
		echo '<p><label>' . esc_html( sprintf( /* translators: %s: site name */ __( 'Type %s to confirm:', 'cwai' ), $want ) ) . '<br><input type="text" id="cwr-confirm" class="regular-text" autocomplete="off" placeholder="' . esc_attr( $want ) . '"></label></p>';
		echo '<p><button class="button button-primary" id="cwr-go" disabled>' . esc_html__( 'Reset the site', 'cwai' ) . '</button> <span id="cwr-status" class="description"></span></p>';
		echo '<div id="cwr-progress"></div></div></div>';
	}

	public static function prompt_section() {
		return "## Resetting the site\n- You cannot reset or wipe the site, and you must not try to do it by trashing items one by one. If asked to start over, tell them an administrator can use AI Assistant → Reset site (it asks for a backup and a typed confirmation), or restore a clean copy.";
	}
}
