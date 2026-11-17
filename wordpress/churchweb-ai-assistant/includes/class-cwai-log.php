<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Activity page: a readable history of what the assistant changed (with Undo), plus usage.
 * Staff see their own changes; administrators see everyone's.
 */
final class CWAI_Log {

	const READ_RE = '#(^|[/_-])(get|search|list|preview|discover|find|read|fetch|check|audit|analy[sz]e|info|status|overview|stock-search|site-health)(-|$)#';

	public static function boot() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 24 );
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
	}

	public static function menu() {
		add_submenu_page( 'cwai-chat', __( 'Activity', 'cwai' ), __( 'Activity', 'cwai' ), 'read', 'cwai-activity', array( __CLASS__, 'render_page' ) );
	}

	public static function routes() {
		register_rest_route( CWAI_REST::NS, '/activity', array(
			'methods'             => 'GET',
			'callback'            => array( __CLASS__, 'rest_activity' ),
			'permission_callback' => static function () {
				return CWAI_Plugin::can_use();
			},
		) );
	}

	public static function is_change( $tool ) {
		$tool = (string) $tool;
		if ( isset( CWAI_Registry::internal()[ $tool ] ) ) {
			return ! CWAI_Registry::internal()[ $tool ]['readonly'];
		}
		return ! preg_match( self::READ_RE, $tool );
	}

	/** Recent actions as plain rows. $all: also read-only lookups. */
	public static function activity( $user_id, $all_users = false, $everything = false, $limit = 100 ) {
		global $wpdb;
		$t     = CWAI_Store::t( 'audit' );
		$where = $all_users ? '' : $wpdb->prepare( 'WHERE user_id = %d', $user_id );
		$rows  = $wpdb->get_results( $wpdb->prepare( "SELECT id, user_id, conversation_id, tool, status, summary, created FROM $t $where ORDER BY id DESC LIMIT %d", 400 ), ARRAY_A ); // phpcs:ignore
		$out   = array();
		foreach ( (array) $rows as $r ) {
			if ( ! $everything && ( ! self::is_change( $r['tool'] ) || 'ok' !== $r['status'] && 'error' !== $r['status'] && 'denied' !== $r['status'] ) ) {
				continue;
			}
			$out[] = $r;
			if ( count( $out ) >= $limit ) {
				break;
			}
		}
		if ( ! $out ) {
			return array();
		}
		// Attach the undo points created by the same call (same conversation, same tool, within seconds).
		$convs = array_values( array_unique( array_map( 'intval', wp_list_pluck( $out, 'conversation_id' ) ) ) );
		$snaps = array();
		if ( $convs ) {
			$in    = implode( ',', $convs );
			$snaps = $wpdb->get_results( 'SELECT id, conversation_id, tool, label, restored, created FROM ' . CWAI_Store::t( 'snapshots' ) . " WHERE conversation_id IN ($in) ORDER BY id DESC LIMIT 1000", ARRAY_A ); // phpcs:ignore
		}
		foreach ( $out as &$r ) {
			$ts         = strtotime( $r['created'] . ' UTC' );
			$r['undo']  = array();
			foreach ( (array) $snaps as $s ) {
				if ( (int) $s['conversation_id'] === (int) $r['conversation_id'] && $s['tool'] === $r['tool'] && abs( strtotime( $s['created'] . ' UTC' ) - $ts ) <= 15 ) {
					$r['undo'][] = array( 'id' => (int) $s['id'], 'label' => $s['label'], 'restored' => (bool) $s['restored'] );
				}
			}
			$u            = get_userdata( (int) $r['user_id'] );
			$r['user']    = $u ? $u->display_name : '';
			$r['label']   = self::tool_label( $r['tool'] );
			$r['when']    = get_date_from_gmt( $r['created'], 'M j, g:i a' );
			$r['change']  = self::is_change( $r['tool'] );
		}
		unset( $r );
		return $out;
	}

	private static function tool_label( $tool ) {
		$i = CWAI_Registry::internal();
		if ( isset( $i[ $tool ] ) ) {
			return $i[ $tool ]['label'];
		}
		$n = preg_replace( '#^[a-z0-9-]+/#', '', (string) $tool );
		return ucfirst( str_replace( '-', ' ', $n ) );
	}

	public static function rest_activity( WP_REST_Request $r ) {
		return self::activity( get_current_user_id(), current_user_can( 'manage_options' ), (bool) $r->get_param( 'all' ) );
	}

	/** Gateway usage for this site (null when not on a gateway). */
	public static function gateway_usage() {
		if ( ! CWAI_Images::gateway_available() || ! CWAI_Settings::api_key() ) {
			return null;
		}
		$c = get_transient( 'cwai_gw_usage' );
		if ( is_array( $c ) ) {
			return $c;
		}
		$r = wp_remote_get( CWAI_Settings::base_url() . '/v1/usage', array( 'timeout' => 8, 'headers' => array( 'x-api-key' => CWAI_Settings::api_key() ) ) );
		$d = is_wp_error( $r ) || 200 !== (int) wp_remote_retrieve_response_code( $r ) ? null : json_decode( wp_remote_retrieve_body( $r ), true );
		$d = is_array( $d ) && ! empty( $d['metering'] ) ? $d : array( 'metering' => false );
		set_transient( 'cwai_gw_usage', $d, 5 * MINUTE_IN_SECONDS );
		return $d;
	}

	public static function render_page() {
		if ( ! CWAI_Plugin::can_use() ) {
			echo '<div class="wrap"><p>' . esc_html__( 'You do not have access to the assistant.', 'cwai' ) . '</p></div>';
			return;
		}
		$admin = current_user_can( 'manage_options' );
		$all   = ! empty( $_GET['all'] ); // phpcs:ignore
		$rows  = self::activity( get_current_user_id(), $admin, $all );
		echo '<div class="wrap" id="cwai-activity"><h1>' . esc_html__( 'Activity', 'cwai' ) . '</h1>';
		echo '<p class="description" style="max-width:780px">' . esc_html( $admin ? __( 'Everything the assistant changed on this site, newest first. Click Undo to put a page back the way it was.', 'cwai' ) : __( 'Everything the assistant changed for you, newest first. Click Undo to put a page back the way it was.', 'cwai' ) ) . '</p>';

		$u = self::gateway_usage();
		if ( $u && ! empty( $u['metering'] ) ) {
			$cap = (int) ( $u['caps']['tokens'] ?? 0 );
			$ic  = (int) ( $u['caps']['images'] ?? 0 );
			echo '<div class="notice notice-info inline" style="max-width:780px"><p><strong>' . esc_html__( 'Today', 'cwai' ) . ':</strong> '
				. esc_html( number_format_i18n( (int) $u['today']['tokens'] ) ) . ' ' . esc_html__( 'words-worth of assistant use (tokens)', 'cwai' )
				. ( $cap ? ' ' . esc_html( sprintf( /* translators: %s: number */ __( 'of a %s daily limit', 'cwai' ), number_format_i18n( $cap ) ) ) : '' )
				. '; ' . esc_html( number_format_i18n( (int) $u['today']['images'] ) ) . ' ' . esc_html__( 'AI images', 'cwai' )
				. ( $ic ? ' ' . esc_html( sprintf( __( 'of %s', 'cwai' ), number_format_i18n( $ic ) ) ) : '' ) . '.</p></div>';
		} else {
			echo '<p class="description">' . esc_html( sprintf( /* translators: %s: number */ __( 'Assistant use today: %s tokens.', 'cwai' ), number_format_i18n( CWAI_Store::usage_today() ) ) ) . '</p>';
		}

		$base = admin_url( 'admin.php?page=cwai-activity' );
		echo '<p><a class="button' . ( $all ? '' : ' button-primary' ) . '" href="' . esc_url( $base ) . '">' . esc_html__( 'Changes only', 'cwai' ) . '</a> <a class="button' . ( $all ? ' button-primary' : '' ) . '" href="' . esc_url( add_query_arg( 'all', 1, $base ) ) . '">' . esc_html__( 'Everything the assistant did', 'cwai' ) . '</a></p>';

		if ( ! $rows ) {
			echo '<p>' . esc_html__( 'Nothing yet. Changes appear here as the assistant makes them.', 'cwai' ) . '</p></div>';
			return;
		}
		echo '<table class="widefat striped" style="max-width:1100px"><thead><tr><th>' . esc_html__( 'When', 'cwai' ) . '</th>' . ( $admin ? '<th>' . esc_html__( 'Who', 'cwai' ) . '</th>' : '' ) . '<th>' . esc_html__( 'What', 'cwai' ) . '</th><th>' . esc_html__( 'Result', 'cwai' ) . '</th><th></th></tr></thead><tbody>';
		foreach ( $rows as $r ) {
			$res = 'ok' === $r['status'] ? __( 'Done', 'cwai' ) : ( 'denied' === $r['status'] ? __( 'Declined', 'cwai' ) : __( 'Failed', 'cwai' ) );
			echo '<tr><td>' . esc_html( $r['when'] ) . '</td>' . ( $admin ? '<td>' . esc_html( $r['user'] ) . '</td>' : '' )
				. '<td><strong>' . esc_html( $r['label'] ) . '</strong><br><span class="description">' . esc_html( $r['summary'] ) . '</span></td><td>' . esc_html( $res ) . '</td><td>';
			foreach ( $r['undo'] as $s ) {
				if ( $s['restored'] ) {
					echo '<span class="description">' . esc_html__( 'Undone', 'cwai' ) . '</span> ';
				} else {
					echo '<button type="button" class="button cwai-undo" data-id="' . (int) $s['id'] . '" title="' . esc_attr( $s['label'] ) . '">' . esc_html__( 'Undo', 'cwai' ) . '</button> ';
				}
			}
			echo '</td></tr>';
		}
		echo '</tbody></table></div>';
		$js = 'document.querySelectorAll(".cwai-undo").forEach(function(b){b.addEventListener("click",function(){if(!confirm("Put this back the way it was?"))return;b.disabled=true;fetch(' . wp_json_encode( esc_url_raw( rest_url( CWAI_REST::NS . '/undo/' ) ) ) . '+b.dataset.id,{method:"POST",headers:{"X-WP-Nonce":' . wp_json_encode( wp_create_nonce( 'wp_rest' ) ) . '}}).then(function(r){return r.json()}).then(function(j){if(j&&j.restored){b.outerHTML="<span class=\"description\">Undone</span>"}else{b.disabled=false;alert((j&&j.message)||"Could not undo.")}}).catch(function(){b.disabled=false;alert("Could not undo.")})})});';
		wp_register_script( 'cwai-activity', false, array(), CWAI_VERSION, true );
		wp_enqueue_script( 'cwai-activity' );
		wp_add_inline_script( 'cwai-activity', $js );
	}
}
