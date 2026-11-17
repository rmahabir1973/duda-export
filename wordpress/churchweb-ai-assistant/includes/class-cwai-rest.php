<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class CWAI_REST {

	const NS = 'cwai/v1';

	public static function boot() {
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
	}

	public static function can_use() {
		return CWAI_Plugin::can_use();
	}

	public static function is_admin() {
		return current_user_can( 'manage_options' );
	}

	public static function routes() {
		$u = array( __CLASS__, 'can_use' );
		register_rest_route( self::NS, '/chat', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'chat' ), 'permission_callback' => $u ) );
		register_rest_route( self::NS, '/approve', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'approve' ), 'permission_callback' => $u ) );
		register_rest_route( self::NS, '/conversations', array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'conversations' ), 'permission_callback' => $u ) );
		register_rest_route( self::NS, '/conversations/(?P<id>\d+)', array(
			array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'conversation' ), 'permission_callback' => $u ),
			array( 'methods' => 'DELETE', 'callback' => array( __CLASS__, 'conversation_delete' ), 'permission_callback' => $u ),
		) );
		register_rest_route( self::NS, '/upload', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'upload' ), 'permission_callback' => static function () {
			return CWAI_Plugin::can_use() && current_user_can( 'upload_files' );
		} ) );
		register_rest_route( self::NS, '/undo', array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'undo_list' ), 'permission_callback' => $u ) );
		register_rest_route( self::NS, '/undo/(?P<id>\d+)', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'undo' ), 'permission_callback' => $u ) );
		register_rest_route( self::NS, '/admin/test', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'test' ), 'permission_callback' => array( __CLASS__, 'is_admin' ) ) );
		register_rest_route( self::NS, '/admin/models', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'refresh_models' ), 'permission_callback' => array( __CLASS__, 'is_admin' ) ) );
	}

	public static function chat( WP_REST_Request $r ) {
		$res = CWAI_Agent::step(
			get_current_user_id(),
			array(
				'conversation_id' => (int) $r->get_param( 'conversation_id' ),
				'message'         => mb_substr( (string) $r->get_param( 'message' ), 0, 20000 ),
				'attachments'     => array_map( 'intval', (array) $r->get_param( 'attachments' ) ),
				'context'         => array(
					'url'     => (string) ( $r->get_param( 'context' )['url'] ?? '' ),
					'post_id' => (int) ( $r->get_param( 'context' )['post_id'] ?? 0 ),
				),
				'model'           => sanitize_text_field( (string) $r->get_param( 'model' ) ),
			)
		);
		return self::out( $res );
	}

	public static function approve( WP_REST_Request $r ) {
		$dec = array();
		foreach ( (array) $r->get_param( 'decisions' ) as $id => $v ) {
			$dec[ sanitize_text_field( $id ) ] = (bool) $v;
		}
		return self::out( CWAI_Agent::approve( get_current_user_id(), (int) $r->get_param( 'conversation_id' ), $dec ) );
	}

	private static function out( $res ) {
		if ( is_wp_error( $res ) ) {
			$st = (int) ( $res->get_error_data()['status'] ?? 400 );
			return new WP_REST_Response( array( 'status' => 'error', 'message' => $res->get_error_message(), 'code' => $res->get_error_code() ), $st >= 400 ? $st : 400 );
		}
		return new WP_REST_Response( $res, 200 );
	}

	public static function conversations() {
		return CWAI_Store::list_conversations( get_current_user_id() );
	}

	private static function own( $id ) {
		$c = CWAI_Store::get_conversation( (int) $id );
		return ( $c && (int) $c['user_id'] === get_current_user_id() ) ? $c : null;
	}

	public static function conversation( WP_REST_Request $r ) {
		$c = self::own( $r['id'] );
		return $c ? CWAI_Agent::payload( $c ) : new WP_Error( 'cwai_nf', 'Not found', array( 'status' => 404 ) );
	}

	public static function conversation_delete( WP_REST_Request $r ) {
		if ( ! self::own( $r['id'] ) ) {
			return new WP_Error( 'cwai_nf', 'Not found', array( 'status' => 404 ) );
		}
		CWAI_Store::delete_conversation( (int) $r['id'] );
		return array( 'deleted' => true );
	}

	public static function upload( WP_REST_Request $r ) {
		if ( empty( $_FILES['file'] ) ) {
			return new WP_Error( 'cwai_nofile', 'No file received.', array( 'status' => 400 ) );
		}
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';
		$id = media_handle_upload( 'file', 0 );
		if ( is_wp_error( $id ) ) {
			return new WP_Error( 'cwai_upload', $id->get_error_message(), array( 'status' => 400 ) );
		}
		return array(
			'id'   => $id,
			'url'  => wp_get_attachment_url( $id ),
			'name' => basename( get_attached_file( $id ) ),
			'mime' => get_post_mime_type( $id ),
		);
	}

	public static function undo_list( WP_REST_Request $r ) {
		return CWAI_Store::list_snapshots( get_current_user_id(), (int) $r->get_param( 'conversation_id' ) );
	}

	public static function undo( WP_REST_Request $r ) {
		$res = CWAI_Registry::restore( (int) $r['id'] );
		return is_wp_error( $res ) ? new WP_Error( 'cwai_undo', $res->get_error_message(), array( 'status' => 400 ) ) : $res;
	}

	public static function test() {
		$res = CWAI_Anthropic::ping( CWAI_Settings::model() );
		if ( is_wp_error( $res ) ) {
			return new WP_REST_Response( array( 'ok' => false, 'message' => $res->get_error_message() ), 200 );
		}
		return array( 'ok' => true, 'message' => sprintf( __( 'Connected. Model %s responded.', 'cwai' ), CWAI_Settings::model() ) );
	}

	public static function refresh_models() {
		$res = CWAI_Anthropic::list_models();
		if ( is_wp_error( $res ) ) {
			return new WP_REST_Response( array( 'ok' => false, 'message' => $res->get_error_message() ), 200 );
		}
		return array( 'ok' => true, 'models' => CWAI_Settings::known_models() );
	}
}
