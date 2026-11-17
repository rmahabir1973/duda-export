<?php
/**
 * Plugin Name:       ChurchWeb AI Assistant
 * Description:       An AI web assistant inside WordPress. Staff describe a change in plain English and Claude builds it: Oxygen pages, menus, blog posts, sermons, media and Rank Math SEO.
 * Version:           1.15.0
 * Requires at least: 6.5
 * Requires PHP:      7.4
 * Author:            ChurchWeb Global
 * License:           GPL-2.0-or-later
 * Text Domain:       cwai
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'CWAI_VERSION', '1.15.0' );
define( 'CWAI_FILE', __FILE__ );
define( 'CWAI_DIR', plugin_dir_path( __FILE__ ) );
define( 'CWAI_URL', plugin_dir_url( __FILE__ ) );

foreach ( array( 'store', 'settings', 'anthropic', 'registry', 'agent', 'rest', 'import', 'portal', 'designs', 'wizard', 'images', 'bot', 'log', 'health', 'routines', 'golive', 'staffview', 'reset', 'pdf', 'ui', 'updater' ) as $cwai_f ) {
	require_once CWAI_DIR . 'includes/class-cwai-' . $cwai_f . '.php';
}
foreach ( array( 'content', 'menus', 'media', 'types', 'seo', 'site' ) as $cwai_f ) {
	require_once CWAI_DIR . 'includes/tools/class-cwai-tools-' . $cwai_f . '.php';
}
unset( $cwai_f );

register_activation_hook( __FILE__, array( 'CWAI_Store', 'install' ) );
register_deactivation_hook( __FILE__, array( 'CWAI_Store', 'deactivate' ) );

CWAI_Plugin::boot();

final class CWAI_Plugin {

	public static function boot() {
		add_action( 'init', array( __CLASS__, 'init' ), 5 );
		add_action( 'cwai_daily', array( 'CWAI_Store', 'purge_old' ) );
		add_action( 'wp_abilities_api_categories_init', array( __CLASS__, 'register_ability_category' ) );
		add_action( 'wp_abilities_api_init', array( 'CWAI_Registry', 'register_abilities' ) );
		CWAI_Settings::boot();
		CWAI_REST::boot();
		CWAI_UI::boot();
		CWAI_Import::boot();
		CWAI_Portal::boot();
		CWAI_Designs::boot();
		CWAI_Wizard::boot();
		CWAI_Images::boot();
		CWAI_Bot::boot();
		CWAI_Log::boot();
		CWAI_Health::boot();
		CWAI_Routines::boot();
		CWAI_Golive::boot();
		CWAI_StaffView::boot();
		CWAI_Reset::boot();
		CWAI_PDF::boot();
		CWAI_Updater::boot();
	}

	public static function init() {
		if ( CWAI_Store::db_version() !== CWAI_VERSION ) {
			CWAI_Store::install();
		}
		if ( ! wp_next_scheduled( 'cwai_daily' ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', 'cwai_daily' );
		}
		CWAI_Tools_Types::boot();
		self::load_tools();
	}

	/** Register built-in tools once (safe to call early or late). */
	public static function load_tools() {
		static $loaded = false;
		if ( $loaded ) {
			return;
		}
		$loaded = true;
		CWAI_Tools_Content::register();
		CWAI_Tools_Menus::register();
		CWAI_Tools_Media::register();
		CWAI_Tools_Types::register();
		CWAI_Tools_SEO::register();
		CWAI_Tools_Site::register();
		CWAI_PDF::register();
		CWAI_Import::register_tools();
		CWAI_Designs::register_tools();
		CWAI_Wizard::register_tools();
		CWAI_Images::register_tools();
		CWAI_Bot::register_tools();
		CWAI_Health::register_tools();
		CWAI_Routines::register_tools();
		CWAI_Golive::register_tools();
		CWAI_StaffView::register_tools();
	}

	public static function register_ability_category() {
		if ( function_exists( 'wp_register_ability_category' ) ) {
			wp_register_ability_category(
				'cwai',
				array(
					'label'       => __( 'Church website tools', 'cwai' ),
					'description' => __( 'Content, menus, media, sermons and SEO tools for church websites.', 'cwai' ),
				)
			);
		}
	}

	/** Who may use the assistant. */
	public static function can_use( $user_id = 0 ) {
		$user = $user_id ? get_userdata( $user_id ) : wp_get_current_user();
		if ( ! $user || ! $user->exists() ) {
			return false;
		}
		if ( user_can( $user, 'manage_options' ) ) {
			return true;
		}
		$roles = (array) CWAI_Settings::get( 'roles' );
		return (bool) array_intersect( $roles, (array) $user->roles );
	}

	/** Admin-tier tools: administrators, or everyone allowed when "full access" is on. */
	public static function is_admin_tier( $user_id = 0 ) {
		$user = $user_id ? get_userdata( $user_id ) : wp_get_current_user();
		if ( ! $user ) {
			return false;
		}
		return user_can( $user, 'manage_options' ) || (bool) CWAI_Settings::get( 'editor_full' );
	}
}
