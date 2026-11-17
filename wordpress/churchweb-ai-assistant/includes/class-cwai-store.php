<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Database layer: conversations, undo snapshots, audit log.
 */
final class CWAI_Store {

	public static function t( $name ) {
		global $wpdb;
		return $wpdb->prefix . 'cwai_' . $name;
	}

	public static function db_version() {
		return get_option( 'cwai_db_version', '' );
	}

	public static function install() {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$c = $wpdb->get_charset_collate();

		dbDelta(
			"CREATE TABLE " . self::t( 'conversations' ) . " (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  user_id bigint(20) unsigned NOT NULL DEFAULT 0,
  title varchar(190) NOT NULL DEFAULT '',
  model varchar(100) NOT NULL DEFAULT '',
  messages longtext NOT NULL,
  pending longtext NULL,
  meta longtext NULL,
  tokens_in bigint(20) unsigned NOT NULL DEFAULT 0,
  tokens_out bigint(20) unsigned NOT NULL DEFAULT 0,
  steps int(11) unsigned NOT NULL DEFAULT 0,
  created datetime NOT NULL,
  updated datetime NOT NULL,
  PRIMARY KEY  (id),
  KEY user_id (user_id)
) $c;"
		);
		dbDelta(
			"CREATE TABLE " . self::t( 'snapshots' ) . " (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  conversation_id bigint(20) unsigned NOT NULL DEFAULT 0,
  user_id bigint(20) unsigned NOT NULL DEFAULT 0,
  post_id bigint(20) unsigned NOT NULL DEFAULT 0,
  kind varchar(20) NOT NULL DEFAULT 'before',
  tool varchar(120) NOT NULL DEFAULT '',
  label varchar(255) NOT NULL DEFAULT '',
  data longtext NULL,
  restored tinyint(1) NOT NULL DEFAULT 0,
  created datetime NOT NULL,
  PRIMARY KEY  (id),
  KEY conversation_id (conversation_id),
  KEY post_id (post_id)
) $c;"
		);
		dbDelta(
			"CREATE TABLE " . self::t( 'audit' ) . " (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  user_id bigint(20) unsigned NOT NULL DEFAULT 0,
  conversation_id bigint(20) unsigned NOT NULL DEFAULT 0,
  tool varchar(120) NOT NULL DEFAULT '',
  status varchar(20) NOT NULL DEFAULT '',
  summary text NULL,
  created datetime NOT NULL,
  PRIMARY KEY  (id),
  KEY conversation_id (conversation_id)
) $c;"
		);
		update_option( 'cwai_db_version', CWAI_VERSION );
	}

	public static function deactivate() {
		wp_clear_scheduled_hook( 'cwai_daily' );
		wp_clear_scheduled_hook( 'cwai_update_tick' );
	}

	public static function now() {
		return gmdate( 'Y-m-d H:i:s' );
	}

	public static function json( $data ) {
		$flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR;
		if ( defined( 'JSON_INVALID_UTF8_SUBSTITUTE' ) ) {
			$flags |= JSON_INVALID_UTF8_SUBSTITUTE;
		}
		return wp_json_encode( $data, $flags );
	}

	/* ---------- conversations ---------- */

	public static function create_conversation( $user_id, $model, $title = '' ) {
		global $wpdb;
		$wpdb->insert(
			self::t( 'conversations' ),
			array(
				'user_id'  => (int) $user_id,
				'title'    => mb_substr( $title, 0, 120 ),
				'model'    => $model,
				'messages' => '[]',
				'meta'     => '{}',
				'created'  => self::now(),
				'updated'  => self::now(),
			)
		);
		return (int) $wpdb->insert_id;
	}

	/** @return array|null */
	public static function get_conversation( $id ) {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::t( 'conversations' ) . ' WHERE id = %d', $id ), ARRAY_A ); // phpcs:ignore
		if ( ! $row ) {
			return null;
		}
		$row['messages'] = json_decode( $row['messages'], true ) ?: array();
		$row['pending']  = $row['pending'] ? json_decode( $row['pending'], true ) : null;
		$row['meta']     = $row['meta'] ? ( json_decode( $row['meta'], true ) ?: array() ) : array();
		return $row;
	}

	/** Replace bulky base64 attachments in older messages with a short note (they stay in the media library). */
	private static function slim( array $messages ) {
		$n = count( $messages );
		foreach ( $messages as $i => &$m ) {
			if ( $i >= $n - 8 || ! is_array( $m['content'] ) ) {
				continue;
			}
			foreach ( $m['content'] as &$b ) {
				if ( in_array( $b['type'] ?? '', array( 'image', 'document' ), true ) && isset( $b['source']['data'] ) ) {
					$b = array( 'type' => 'text', 'text' => '[an attached ' . $b['type'] . ' from earlier in the chat; it is in the media library]' );
				}
			}
			unset( $b );
		}
		unset( $m );
		return $messages;
	}

	public static function save_conversation( array $conv ) {
		global $wpdb;
		$conv['messages'] = self::slim( $conv['messages'] );
		$wpdb->update(
			self::t( 'conversations' ),
			array(
				'title'      => mb_substr( (string) $conv['title'], 0, 120 ),
				'model'      => $conv['model'],
				'messages'   => self::json( $conv['messages'] ),
				'pending'    => empty( $conv['pending'] ) ? null : self::json( $conv['pending'] ),
				'meta'       => self::json( (object) ( $conv['meta'] ?: array() ) ),
				'tokens_in'  => (int) $conv['tokens_in'],
				'tokens_out' => (int) $conv['tokens_out'],
				'steps'      => (int) $conv['steps'],
				'updated'    => self::now(),
			),
			array( 'id' => (int) $conv['id'] )
		);
	}

	public static function list_conversations( $user_id, $limit = 40 ) {
		global $wpdb;
		return $wpdb->get_results(
			$wpdb->prepare( 'SELECT id, title, model, updated FROM ' . self::t( 'conversations' ) . ' WHERE user_id = %d ORDER BY updated DESC LIMIT %d', $user_id, $limit ), // phpcs:ignore
			ARRAY_A
		);
	}

	public static function delete_conversation( $id ) {
		global $wpdb;
		$wpdb->delete( self::t( 'conversations' ), array( 'id' => (int) $id ) );
	}

	/* ---------- snapshots (undo) ---------- */

	public static function add_snapshot( $conv_id, $user_id, $post_id, $kind, $tool, $label, $data ) {
		global $wpdb;
		$wpdb->insert(
			self::t( 'snapshots' ),
			array(
				'conversation_id' => (int) $conv_id,
				'user_id'         => (int) $user_id,
				'post_id'         => (int) $post_id,
				'kind'            => $kind,
				'tool'            => mb_substr( $tool, 0, 120 ),
				'label'           => mb_substr( $label, 0, 255 ),
				'data'            => self::json( $data ),
				'created'         => self::now(),
			)
		);
		return (int) $wpdb->insert_id;
	}

	public static function get_snapshot( $id ) {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::t( 'snapshots' ) . ' WHERE id = %d', $id ), ARRAY_A ); // phpcs:ignore
		if ( $row ) {
			$row['data'] = json_decode( (string) $row['data'], true ) ?: array();
		}
		return $row;
	}

	public static function list_snapshots( $user_id, $conv_id = 0, $limit = 30 ) {
		global $wpdb;
		$where = $conv_id ? $wpdb->prepare( 'AND conversation_id = %d', $conv_id ) : '';
		return $wpdb->get_results(
			$wpdb->prepare( 'SELECT id, conversation_id, post_id, kind, tool, label, restored, created FROM ' . self::t( 'snapshots' ) . " WHERE user_id = %d $where ORDER BY id DESC LIMIT %d", $user_id, $limit ), // phpcs:ignore
			ARRAY_A
		);
	}

	public static function mark_restored( $id ) {
		global $wpdb;
		$wpdb->update( self::t( 'snapshots' ), array( 'restored' => 1 ), array( 'id' => (int) $id ) );
	}

	/* ---------- audit ---------- */

	public static function audit( $user_id, $conv_id, $tool, $status, $summary ) {
		global $wpdb;
		$wpdb->insert(
			self::t( 'audit' ),
			array(
				'user_id'         => (int) $user_id,
				'conversation_id' => (int) $conv_id,
				'tool'            => mb_substr( $tool, 0, 120 ),
				'status'          => $status,
				'summary'         => mb_substr( (string) $summary, 0, 1000 ),
				'created'         => self::now(),
			)
		);
	}

	public static function purge_old() {
		global $wpdb;
		$days = max( 7, (int) CWAI_Settings::get( 'retention_days' ) );
		$cut  = gmdate( 'Y-m-d H:i:s', time() - $days * DAY_IN_SECONDS );
		foreach ( array( 'conversations' => 'updated', 'snapshots' => 'created', 'audit' => 'created' ) as $t => $col ) {
			$wpdb->query( $wpdb->prepare( 'DELETE FROM ' . self::t( $t ) . " WHERE $col < %s", $cut ) ); // phpcs:ignore
		}
	}

	/* ---------- usage ---------- */

	public static function add_usage( $tokens ) {
		$u     = get_option( 'cwai_usage', array() );
		$today = gmdate( 'Y-m-d' );
		$u[ $today ] = ( $u[ $today ] ?? 0 ) + (int) $tokens;
		$u = array_slice( $u, -45, null, true );
		update_option( 'cwai_usage', $u, false );
	}

	public static function usage_today() {
		$u = get_option( 'cwai_usage', array() );
		return (int) ( $u[ gmdate( 'Y-m-d' ) ] ?? 0 );
	}
}
