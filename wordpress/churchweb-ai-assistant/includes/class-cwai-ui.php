<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Admin pages, the floating chat panel (wp-admin and front end) and assets.
 */
final class CWAI_UI {

	private static $printed = false;

	public static function boot() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
		add_action( 'admin_footer', array( __CLASS__, 'panel' ) );
		add_action( 'wp_footer', array( __CLASS__, 'panel' ) );
		add_action( 'admin_bar_menu', array( __CLASS__, 'admin_bar' ), 90 );
		add_filter( 'plugin_action_links_' . plugin_basename( CWAI_FILE ), array( __CLASS__, 'links' ) );
	}

	public static function links( $l ) {
		array_unshift( $l, '<a href="' . esc_url( admin_url( 'admin.php?page=cwai-settings' ) ) . '">' . esc_html__( 'Settings', 'cwai' ) . '</a>' );
		return $l;
	}

	public static function menu() {
		$brand = CWAI_Settings::get( 'brand_name' );
		add_menu_page( $brand, $brand, 'read', 'cwai-chat', array( __CLASS__, 'page' ), 'dashicons-format-chat', 3 );
		add_submenu_page( 'cwai-chat', $brand, __( 'Chat', 'cwai' ), 'read', 'cwai-chat', array( __CLASS__, 'page' ) );
		add_submenu_page( 'cwai-chat', __( 'Settings', 'cwai' ), __( 'Settings', 'cwai' ), 'manage_options', 'cwai-settings', array( 'CWAI_Settings', 'render_page' ) );
	}

	public static function page() {
		if ( ! CWAI_Plugin::can_use() ) {
			echo '<div class="wrap"><p>' . esc_html__( 'You do not have access to the assistant.', 'cwai' ) . '</p></div>';
			return;
		}
		echo '<div class="wrap cwai-wrap"><div id="cwai-app" data-mode="page"></div></div>';
	}

	private static function should_load() {
		if ( ! is_user_logged_in() || ! CWAI_Plugin::can_use() ) {
			return false;
		}
		if ( ! is_admin() && ( ! CWAI_Settings::get( 'show_frontend' ) || ! is_admin_bar_showing() ) ) {
			return false;
		}
		return true;
	}

	public static function enqueue( $hook = '' ) {
		if ( is_admin() && 'cwai-ai-settings' !== $hook && isset( $_GET['page'] ) && 'cwai-settings' === $_GET['page'] ) { // phpcs:ignore
			wp_enqueue_script( 'cwai-settings', CWAI_URL . 'assets/settings.js', array(), CWAI_VERSION, true );
			wp_localize_script( 'cwai-settings', 'CWAI_S', array(
				'root'  => esc_url_raw( rest_url( CWAI_REST::NS ) ),
				'nonce' => wp_create_nonce( 'wp_rest' ),
			) );
		}
		if ( ! self::should_load() ) {
			return;
		}
		wp_enqueue_style( 'cwai-chat', CWAI_URL . 'assets/chat.css', array(), CWAI_VERSION );
		wp_enqueue_script( 'cwai-chat', CWAI_URL . 'assets/chat.js', array(), CWAI_VERSION, true );

		$post_id = 0;
		if ( is_admin() ) {
			$post_id = isset( $_GET['post'] ) ? (int) $_GET['post'] : 0; // phpcs:ignore
		} elseif ( is_singular() ) {
			$post_id = get_queried_object_id();
		}
		$can_switch = (bool) CWAI_Settings::get( 'allow_user_model' );
		wp_localize_script( 'cwai-chat', 'CWAI', array(
			'root'       => esc_url_raw( rest_url( CWAI_REST::NS ) ),
			'nonce'      => wp_create_nonce( 'wp_rest' ),
			'brand'      => CWAI_Settings::get( 'brand_name' ),
			'model'      => CWAI_Settings::model(),
			'models'     => $can_switch ? CWAI_Settings::known_models() : new stdClass(),
			'postId'     => $post_id,
			'chatUrl'    => admin_url( 'admin.php?page=cwai-chat' ),
			'hasKey'     => (bool) CWAI_Settings::api_key(),
			'isAdmin'    => current_user_can( 'manage_options' ),
			'settingsUrl' => admin_url( 'admin.php?page=cwai-settings' ),
			'suggestions' => array_merge( CWAI_Routines::chips(), array(
				__( 'Add this Sunday’s sermon', 'cwai' ),
				__( 'Write a blog post about our upcoming event', 'cwai' ),
				__( 'Update our service times everywhere', 'cwai' ),
			) ),
			'i18n'       => array(
				'placeholder' => __( 'Describe the change you want…', 'cwai' ),
				'send'        => __( 'Send', 'cwai' ),
				'stop'        => __( 'Stop', 'cwai' ),
				'new'         => __( 'New chat', 'cwai' ),
				'history'     => __( 'History', 'cwai' ),
				'undo'        => __( 'Undo', 'cwai' ),
				'approve'     => __( 'Approve', 'cwai' ),
				'decline'     => __( 'Decline', 'cwai' ),
				'working'     => __( 'Working…', 'cwai' ),
				'attach'      => __( 'Attach a photo or document', 'cwai' ),
				'enterSends'  => __( 'Press Enter to send', 'cwai' ),
				'enterHint'   => __( 'Off: Enter adds a new line, then click Send (or press Ctrl+Enter). On: Enter sends and Shift+Enter adds a new line.', 'cwai' ),
			),
		) );
	}

	public static function panel() {
		if ( self::$printed || ! self::should_load() ) {
			return;
		}
		if ( is_admin() && isset( $_GET['page'] ) && 'cwai-chat' === $_GET['page'] ) { // phpcs:ignore
			return;
		}
		self::$printed = true;
		echo '<div id="cwai-panel-root"></div>';
	}

	public static function admin_bar( $bar ) {
		if ( ! self::should_load() ) {
			return;
		}
		$bar->add_node( array(
			'id'    => 'cwai-toggle',
			'title' => '<span class="ab-icon dashicons dashicons-format-chat" style="font-family:dashicons;margin-top:2px"></span> ' . esc_html( CWAI_Settings::get( 'brand_name' ) ),
			'href'  => '#cwai',
			'meta'  => array( 'class' => 'cwai-toggle' ),
		) );
	}
}
