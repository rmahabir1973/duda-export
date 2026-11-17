<?php
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}
global $wpdb;
if ( get_option( 'cwai_settings_keep_data' ) ) {
	return;
}
foreach ( array( 'cwai_conversations', 'cwai_snapshots', 'cwai_audit' ) as $t ) {
	$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}{$t}" ); // phpcs:ignore
}
foreach ( array( 'cwai_settings', 'cwai_db_version', 'cwai_usage', 'cwai_content_types', 'cwai_flush', 'cwai_import', 'cwai_import_state', 'cwai_design', 'cwai_wizard', 'cwai_images', 'cwai_img_usage', 'cwai_bot', 'cwai_bot_log', 'cwai_bot_usage', 'cwai_health', 'cwai_routines', 'cwai_golive', 'cwai_sv', 'cwai_sv_seen', 'cwai_reset_log' ) as $o ) {
	delete_option( $o );
}
$wpdb->query( "DELETE FROM {$wpdb->posts} WHERE post_type = 'cwai_kb'" ); // phpcs:ignore
delete_transient( 'cwai_models' );
$wpdb->query( "DELETE FROM {$wpdb->usermeta} WHERE meta_key = 'cwai_sv_preview'" ); // phpcs:ignore
delete_transient( 'cwai_gw_usage' );
delete_transient( 'cwai_health_links' );
delete_transient( 'cwai_health_links_found' );
