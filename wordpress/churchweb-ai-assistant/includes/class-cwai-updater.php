<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Plugin updates.
 *
 * Default channel: the ChurchWeb gateway (when the site uses one). The site asks the gateway for the newest release
 * with its normal site token. Every release is signed with the ChurchWeb release key (Ed25519); the plugin only offers
 * and installs a release whose signature verifies against the public key built in below and whose zip matches the signed
 * SHA-256, so a compromised server cannot push code to the site.
 *
 * Legacy channel: a plain JSON file ({"version","download_url"...}) set with CWAI_UPDATE_MANIFEST or in Settings
 * (unsigned, only used when an administrator sets it explicitly).
 */
final class CWAI_Updater {

	/** Release signing public key (base64, 32 bytes). Can be overridden in wp-config.php with CWAI_UPDATE_PUBKEY. */
	const PUBKEY = 'u4fjTswBXlGBqx9RPZTALISxKSWQX9EWvXaaQAFuCHI=';

	const TRANSIENT = 'cwai_upd';

	public static function boot() {
		add_filter( 'pre_set_site_transient_update_plugins', array( __CLASS__, 'check' ) );
		add_filter( 'plugins_api', array( __CLASS__, 'info' ), 10, 3 );
		add_filter( 'upgrader_pre_download', array( __CLASS__, 'pre_download' ), 10, 3 );
		add_filter( 'auto_update_plugin', array( __CLASS__, 'auto_update' ), 10, 2 );
		add_filter( 'plugin_action_links_' . plugin_basename( CWAI_FILE ), array( __CLASS__, 'row_links' ), 20 );
		add_action( 'admin_post_cwai_check_update', array( __CLASS__, 'check_now' ) );
		add_action( 'load-plugins.php', array( __CLASS__, 'refresh_if_stale' ), 5 );
		add_action( 'load-update-core.php', array( __CLASS__, 'refresh_if_stale' ), 5 );
		add_action( 'admin_notices', array( __CLASS__, 'notice' ) );
		add_action( 'cwai_update_tick', array( __CLASS__, 'tick' ) );
		add_action( 'init', array( __CLASS__, 'schedule' ) );
	}

	/** WordPress itself only looks for updates twice a day. This checks every hour, so a new release is installed within about an hour of someone visiting the site. */
	public static function schedule() {
		if ( ! wp_next_scheduled( 'cwai_update_tick' ) ) {
			wp_schedule_event( time() + 300, 'hourly', 'cwai_update_tick' );
		}
	}

	/** Ask for a fresh answer and, when a verified newer version exists and automatic updates are on, let WordPress's own updater install it (it takes its own lock and re-activates the plugin). */
	public static function tick() {
		if ( '' === self::channel() || ! CWAI_Settings::get( 'auto_update' ) ) {
			return;
		}
		delete_transient( self::TRANSIENT );
		delete_site_transient( 'update_plugins' );
		wp_update_plugins();
		$f = self::fetch();
		if ( 'ok' !== $f['state'] || empty( $f['verified'] ) || ! version_compare( $f['manifest']['version'], CWAI_VERSION, '>' ) ) {
			return;
		}
		do_action( 'wp_maybe_auto_update' );
	}

	private static function pubkey() {
		return defined( 'CWAI_UPDATE_PUBKEY' ) ? CWAI_UPDATE_PUBKEY : self::PUBKEY;
	}

	/** 'gateway', 'url' or '' (no channel configured). */
	public static function channel() {
		$url = defined( 'CWAI_UPDATE_MANIFEST' ) ? CWAI_UPDATE_MANIFEST : CWAI_Settings::get( 'update_manifest' );
		if ( $url ) {
			return 'url';
		}
		return CWAI_Images::gateway_available() && CWAI_Settings::api_key() ? 'gateway' : '';
	}

	private static function verify( $text, $sig ) {
		$key = base64_decode( self::pubkey(), true ); // phpcs:ignore
		$s   = base64_decode( (string) $sig, true ); // phpcs:ignore
		if ( ! function_exists( 'sodium_crypto_sign_verify_detached' ) || false === $key || 32 !== strlen( $key ) || false === $s || 64 !== strlen( $s ) ) {
			return false;
		}
		try {
			return sodium_crypto_sign_verify_detached( $s, $text, $key );
		} catch ( Exception $e ) {
			return false;
		}
	}

	/** @return array {state: ok|none|error, manifest?, download_url?, verified?, checked, message?} */
	public static function fetch( $force = false ) {
		if ( ! $force ) {
			$c = get_transient( self::TRANSIENT );
			if ( is_array( $c ) ) {
				return $c;
			}
		}
		$out     = array( 'state' => 'none', 'checked' => time(), 'channel' => self::channel() );
		$channel = $out['channel'];
		if ( '' === $channel ) {
			set_transient( self::TRANSIENT, $out, HOUR_IN_SECONDS );
			return $out;
		}
		if ( 'url' === $channel ) {
			$url = defined( 'CWAI_UPDATE_MANIFEST' ) ? CWAI_UPDATE_MANIFEST : CWAI_Settings::get( 'update_manifest' );
			$r   = wp_remote_get( $url, array( 'timeout' => 10 ) );
			$d   = is_wp_error( $r ) ? null : json_decode( wp_remote_retrieve_body( $r ), true );
			if ( is_array( $d ) && ! empty( $d['version'] ) && ! empty( $d['download_url'] ) ) {
				$out = array_merge( $out, array( 'state' => 'ok', 'manifest' => $d, 'download_url' => $d['download_url'], 'verified' => false ) );
			} else {
				$out = array_merge( $out, array( 'state' => 'error', 'message' => 'The update file could not be read.' ) );
			}
		} else {
			global $wp_version;
			$url = add_query_arg( array( 'v' => CWAI_VERSION, 'wp' => $wp_version, 'php' => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION ), CWAI_Settings::base_url() . '/v1/plugin/manifest' );
			$r   = wp_remote_get( $url, array( 'timeout' => 12, 'headers' => array( 'x-api-key' => CWAI_Settings::api_key() ) ) );
			if ( is_wp_error( $r ) ) {
				$out = array_merge( $out, array( 'state' => 'error', 'message' => $r->get_error_message() ) );
			} else {
				$code = (int) wp_remote_retrieve_response_code( $r );
				$d    = json_decode( wp_remote_retrieve_body( $r ), true );
				if ( 200 !== $code || ! is_array( $d ) ) {
					$msg = 401 === $code ? 'The gateway rejected this site\'s key.' : ( 501 === $code ? 'The gateway has no update channel switched on.' : 'The update server answered with an error (HTTP ' . $code . ').' );
					$out = array_merge( $out, array( 'state' => 'error', 'message' => $msg ) );
				} elseif ( ! empty( $d['none'] ) ) {
					$out['state'] = 'none';
				} elseif ( empty( $d['manifest_text'] ) || empty( $d['signature'] ) || empty( $d['download_url'] ) ) {
					$out = array_merge( $out, array( 'state' => 'error', 'message' => 'The update information was incomplete.' ) );
				} elseif ( ! self::verify( $d['manifest_text'], $d['signature'] ) ) {
					$out = array_merge( $out, array( 'state' => 'error', 'message' => 'The update was not signed with the ChurchWeb release key, so it was ignored.' ) );
				} else {
					$m = json_decode( $d['manifest_text'], true );
					if ( ! is_array( $m ) || empty( $m['version'] ) || empty( $m['sha256'] ) || 'churchweb-ai-assistant' !== ( $m['product'] ?? '' ) ) {
						$out = array_merge( $out, array( 'state' => 'error', 'message' => 'The update information was not valid.' ) );
					} else {
						$out = array_merge( $out, array( 'state' => 'ok', 'manifest' => $m, 'download_url' => $d['download_url'], 'verified' => true ) );
					}
				}
			}
		}
		set_transient( self::TRANSIENT, $out, 'error' === $out['state'] ? 30 * MINUTE_IN_SECONDS : HOUR_IN_SECONDS );
		return $out;
	}

	private static function plugin_item( array $f ) {
		$m = $f['manifest'];
		return (object) array(
			'id'          => 'cwai/' . dirname( plugin_basename( CWAI_FILE ) ),
			'slug'        => dirname( plugin_basename( CWAI_FILE ) ),
			'plugin'      => plugin_basename( CWAI_FILE ),
			'new_version' => $m['version'],
			'url'         => '',
			'package'     => $f['download_url'],
			'tested'      => $m['tested'] ?? '',
			'requires'    => $m['requires'] ?? '6.5',
			'requires_php' => $m['requires_php'] ?? '7.4',
		);
	}

	public static function check( $t ) {
		if ( ! is_object( $t ) ) {
			return $t;
		}
		$f    = self::fetch();
		$base = plugin_basename( CWAI_FILE );
		if ( 'ok' === $f['state'] && version_compare( $f['manifest']['version'], CWAI_VERSION, '>' ) ) {
			$t->response[ $base ] = self::plugin_item( $f );
			unset( $t->no_update[ $base ] );
		} elseif ( isset( $t->no_update ) ) {
			// Listing the plugin as "up to date" makes WordPress show its auto-update switch.
			$t->no_update[ $base ] = (object) array( 'id' => 'cwai/' . dirname( $base ), 'slug' => dirname( $base ), 'plugin' => $base, 'new_version' => CWAI_VERSION, 'url' => '', 'package' => '' );
		}
		return $t;
	}

	public static function info( $res, $action, $args ) {
		if ( 'plugin_information' !== $action || empty( $args->slug ) || dirname( plugin_basename( CWAI_FILE ) ) !== $args->slug ) {
			return $res;
		}
		$f = self::fetch();
		if ( 'ok' !== $f['state'] ) {
			return $res;
		}
		$m = $f['manifest'];
		return (object) array(
			'name' => 'ChurchWeb AI Assistant', 'slug' => $args->slug, 'version' => $m['version'], 'requires' => $m['requires'] ?? '6.5', 'tested' => $m['tested'] ?? '',
			'requires_php' => $m['requires_php'] ?? '7.4', 'author' => 'ChurchWeb Global', 'last_updated' => $m['released'] ?? '', 'download_link' => $f['download_url'],
			'sections' => array( 'changelog' => wpautop( esc_html( $m['changelog'] ?? '' ) ) ),
		);
	}

	/** Download the signed release ourselves, with a fresh link, and refuse it unless it matches the signed checksum. */
	public static function pre_download( $reply, $package, $upgrader ) {
		$gw = CWAI_Settings::base_url() . '/v1/plugin/download';
		if ( false !== $reply || ! is_string( $package ) || 0 !== strpos( $package, $gw ) ) {
			return $reply;
		}
		$f = self::fetch( true ); // the link in the cached answer may have expired
		if ( 'ok' !== $f['state'] || empty( $f['verified'] ) ) {
			return new WP_Error( 'cwai_update', 'The update could not be verified, so it was not installed.' );
		}
		require_once ABSPATH . 'wp-admin/includes/file.php';
		$tmp = download_url( $f['download_url'], 300 );
		if ( is_wp_error( $tmp ) ) {
			return $tmp;
		}
		if ( ! hash_equals( (string) $f['manifest']['sha256'], hash_file( 'sha256', $tmp ) ) ) {
			@unlink( $tmp ); // phpcs:ignore
			return new WP_Error( 'cwai_update', 'The downloaded update did not match its signed checksum, so it was not installed.' );
		}
		return $tmp;
	}

	public static function auto_update( $update, $item ) {
		if ( is_object( $item ) && isset( $item->plugin ) && plugin_basename( CWAI_FILE ) === $item->plugin ) {
			$f = self::fetch();
			if ( 'ok' === $f['state'] && ! empty( $f['verified'] ) ) {
				return (bool) CWAI_Settings::get( 'auto_update' );
			}
		}
		return $update;
	}

	/* ------------------------------------------------------------------ */
	/* UI                                                                  */
	/* ------------------------------------------------------------------ */

	public static function row_links( $links ) {
		$url     = wp_nonce_url( admin_url( 'admin-post.php?action=cwai_check_update' ), 'cwai_check_update' );
		$links[] = '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Check for updates', 'cwai' ) . '</a>';
		return $links;
	}

	/** Opening the Plugins or Updates screen shows what is current: re-ask the gateway if the last answer is over 15 minutes old. */
	public static function refresh_if_stale() {
		if ( '' === self::channel() || ! current_user_can( 'update_plugins' ) ) {
			return;
		}
		$c = get_transient( self::TRANSIENT );
		if ( is_array( $c ) && time() - (int) ( $c['checked'] ?? 0 ) < 15 * MINUTE_IN_SECONDS ) {
			return;
		}
		delete_transient( self::TRANSIENT );
		$t = get_site_transient( 'update_plugins' );
		if ( is_object( $t ) ) {
			set_site_transient( 'update_plugins', $t ); // runs check() with a fresh answer
		}
	}

	public static function check_now() {
		if ( ! current_user_can( 'update_plugins' ) || ! wp_verify_nonce( isset( $_GET['_wpnonce'] ) ? sanitize_text_field( wp_unslash( $_GET['_wpnonce'] ) ) : '', 'cwai_check_update' ) ) { // phpcs:ignore
			wp_die( esc_html__( 'Not allowed.', 'cwai' ), 403 );
		}
		delete_transient( self::TRANSIENT );
		delete_site_transient( 'update_plugins' );
		wp_update_plugins();
		$f   = self::fetch();
		$res = 'ok' === $f['state'] && version_compare( $f['manifest']['version'], CWAI_VERSION, '>' ) ? 'available' : ( 'error' === $f['state'] ? 'error' : 'current' );
		wp_safe_redirect( add_query_arg( 'cwai_upd', $res, admin_url( 'plugins.php' ) ) );
		exit;
	}

	public static function notice() {
		if ( empty( $_GET['cwai_upd'] ) || ! current_user_can( 'update_plugins' ) ) { // phpcs:ignore
			return;
		}
		$r = sanitize_key( wp_unslash( $_GET['cwai_upd'] ) ); // phpcs:ignore
		$f = self::fetch();
		if ( 'available' === $r ) {
			echo '<div class="notice notice-info is-dismissible"><p>' . esc_html( sprintf( __( 'ChurchWeb AI Assistant %s is available. Update it from the list below.', 'cwai' ), $f['manifest']['version'] ?? '' ) ) . '</p></div>';
		} elseif ( 'error' === $r ) {
			echo '<div class="notice notice-warning is-dismissible"><p>' . esc_html( 'ChurchWeb AI Assistant: ' . ( $f['message'] ?? 'the update check failed.' ) ) . '</p></div>';
		} else {
			echo '<div class="notice notice-success is-dismissible"><p>' . esc_html( sprintf( __( 'ChurchWeb AI Assistant is up to date (version %s).', 'cwai' ), CWAI_VERSION ) ) . '</p></div>';
		}
	}

	/** For the Settings page and diagnostics. */
	public static function status() {
		$f   = self::fetch();
		$ch  = $f['channel'] ?? self::channel();
		$out = array( 'installed' => CWAI_VERSION, 'channel' => $ch, 'checked' => (int) ( $f['checked'] ?? 0 ), 'state' => $f['state'], 'latest' => '', 'message' => $f['message'] ?? '', 'verified' => ! empty( $f['verified'] ) );
		if ( 'ok' === $f['state'] ) {
			$out['latest']    = $f['manifest']['version'];
			$out['changelog'] = $f['manifest']['changelog'] ?? '';
		}
		return $out;
	}

	public static function render_status() {
		$s    = self::status();
		$url  = wp_nonce_url( admin_url( 'admin-post.php?action=cwai_check_update' ), 'cwai_check_update' );
		$text = esc_html( sprintf( __( 'Installed: %s', 'cwai' ), $s['installed'] ) );
		if ( '' === $s['channel'] ) {
			$text .= ' · ' . esc_html__( 'Automatic updates are not set up for this site (it needs the ChurchWeb gateway).', 'cwai' );
		} elseif ( 'ok' === $s['state'] && version_compare( $s['latest'], $s['installed'], '>' ) ) {
			$text .= ' · <b>' . esc_html( sprintf( __( 'Version %s is available.', 'cwai' ), $s['latest'] ) ) . '</b>';
		} elseif ( 'error' === $s['state'] ) {
			$text .= ' · <span style="color:#b32d2e">' . esc_html( $s['message'] ) . '</span>';
		} else {
			$text .= ' · ' . esc_html__( 'Up to date.', 'cwai' );
		}
		if ( $s['checked'] ) {
			$text .= ' <span class="description">(' . esc_html( sprintf( __( 'checked %s ago', 'cwai' ), human_time_diff( $s['checked'] ) ) ) . ')</span>';
		}
		$why = array();
		if ( '' !== $s['channel'] && ! CWAI_Settings::get( 'auto_update' ) ) {
			$why[] = __( 'Automatic install is switched off in the settings above, so updates wait for you.', 'cwai' );
		}
		if ( defined( 'AUTOMATIC_UPDATER_DISABLED' ) && AUTOMATIC_UPDATER_DISABLED ) {
			$why[] = __( 'This site blocks automatic updates (AUTOMATIC_UPDATER_DISABLED), so you must press "update now" yourself.', 'cwai' );
		}
		if ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ) {
			$why[] = __( 'WordPress\'s scheduled tasks are switched off here (DISABLE_WP_CRON), so automatic updates only run if a real cron job calls wp-cron.php.', 'cwai' );
		}
		$next = wp_next_scheduled( 'cwai_update_tick' );
		if ( $next && empty( $why ) && '' !== $s['channel'] ) {
			$text .= ' <span class="description">(' . esc_html( sprintf( __( 'next automatic check in %s', 'cwai' ), human_time_diff( time(), max( time() + 60, $next ) ) ) ) . ')</span>';
		}
		echo '<p>' . $text . ' <a class="button" href="' . esc_url( $url ) . '">' . esc_html__( 'Check for updates now', 'cwai' ) . '</a></p>'; // phpcs:ignore
		foreach ( $why as $w ) {
			echo '<p class="description" style="color:#b32d2e">' . esc_html( $w ) . '</p>';
		}
	}
}
