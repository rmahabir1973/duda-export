<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Tool registry. Merges (1) built-in church tools and (2) WordPress Abilities
 * (Oxygen, Rank Math, ...) into one list the model can call. Enforces tiers,
 * approvals and undo snapshots around every call.
 */
final class CWAI_Registry {

	/** @var array name => definition */
	private static $internal = array();

	/** @var array execution context */
	public static $ctx = array(
		'user_id' => 0,
		'conv_id' => 0,
		'touched' => array(),
	);

	/** Ability namespaces exposed to the model. */
	const DEFAULT_PREFIXES = array( 'oxygen/', 'cwai/', 'core/get-', 'rank-math/', 'rankmath/' );

	/** Never exposed, regardless of settings. */
	const HARD_DENY = array( 'agent-connector-for-wp/', 'mcp-adapter/', 'oxygen/report-bug' );

	/** Only for administrators (or "full access" mode). */
	const ADMIN_ONLY = array(
		'oxygen/set-settings',
		'oxygen/run-site-tool',
		'oxygen/delete-css-selectors',
		'oxygen/delete-css-variables',
	);

	/** Always need an explicit click from the person. */
	const ALWAYS_APPROVE = array(
		'oxygen/set-settings',
		'oxygen/run-site-tool',
		'oxygen/delete-css-selectors',
		'oxygen/delete-css-variables',
	);

	/** Registered built-in tools (name => definition). */
	public static function internal() {
		CWAI_Plugin::load_tools();
		return self::$internal;
	}

	public static function add( $name, array $def ) {
		$def += array(
			'label'       => $name,
			'description' => '',
			'input'       => array(),
			'callback'    => null,
			'capability'  => 'edit_posts',
			'readonly'    => false,
			'admin'       => false,
			'approval'    => false,
			'touches'     => null,
		);
		self::$internal[ $name ] = $def;
	}

	/** Register the built-in tools as WordPress Abilities too, so Claude Desktop / MCP can use them. */
	/** Safe ability lookup (core logs a notice for unknown names). */
	public static function ability( $name ) {
		return function_exists( 'wp_has_ability' ) && wp_has_ability( $name ) ? wp_get_ability( $name ) : null;
	}

	public static function register_abilities() {
		if ( ! function_exists( 'wp_register_ability' ) ) {
			return;
		}
		CWAI_Plugin::load_tools();
		foreach ( self::$internal as $name => $def ) {
			if ( function_exists( 'wp_has_ability' ) && wp_has_ability( $name ) ) {
				continue;
			}
			$cap = $def['admin'] ? 'manage_options' : $def['capability'];
			$cb  = $def['callback'];
			wp_register_ability(
				$name,
				array(
					'label'               => $def['label'],
					'description'         => $def['description'],
					'category'            => 'cwai',
					'input_schema'        => self::clean_schema( $def['input'] ),
					'execute_callback'    => static function ( $input = null ) use ( $cb ) {
						return call_user_func( $cb, is_array( $input ) ? $input : array() );
					},
					'permission_callback' => static function () use ( $cap ) {
						return current_user_can( $cap );
					},
					'meta'                => array(
						'public'       => true,
						'show_in_rest' => true,
						'annotations'  => array(
							'readonly'    => (bool) $def['readonly'],
							'destructive' => ! $def['readonly'] && false !== strpos( $name, 'delete' ),
						),
						'mcp'          => array( 'public' => true ),
					),
				)
			);
		}
	}

	/* ------------------------------------------------------------------ */
	/* Discovery                                                           */
	/* ------------------------------------------------------------------ */

	private static function prefixes() {
		$p     = self::DEFAULT_PREFIXES;
		$extra = preg_split( '/[\s,]+/', (string) CWAI_Settings::get( 'extra_prefixes' ), -1, PREG_SPLIT_NO_EMPTY );
		foreach ( $extra as $e ) {
			if ( preg_match( '#^[a-z0-9\-]+/[a-z0-9\-]*$#', $e ) ) {
				$p[] = $e;
			}
		}
		return apply_filters( 'cwai_tool_prefixes', $p );
	}

	private static function starts_with_any( $name, array $list ) {
		foreach ( $list as $p ) {
			if ( 0 === strpos( $name, $p ) ) {
				return true;
			}
		}
		return false;
	}

	/** @return array name => descriptor */
	public static function discover() {
		CWAI_Plugin::load_tools();
		$out = array();

		foreach ( self::$internal as $name => $d ) {
			$out[ $name ] = array(
				'name'        => $name,
				'api_name'    => self::api_name( $name ),
				'label'       => $d['label'],
				'description' => $d['description'],
				'schema'      => self::clean_schema( $d['input'] ),
				'readonly'    => (bool) $d['readonly'],
				'admin'       => (bool) $d['admin'],
				'approval'    => $d['approval'],
				'type'        => 'internal',
				'def'         => $d,
			);
		}

		if ( function_exists( 'wp_get_abilities' ) ) {
			$deny = apply_filters( 'cwai_tool_denylist', self::HARD_DENY );
			if ( ! class_exists( 'WooCommerce' ) ) {
				$deny[] = 'oxygen/get-ecommerce-instructions';
			}
			$allow = self::prefixes();
			foreach ( wp_get_abilities() as $ability ) {
				$name = $ability->get_name();
				if ( isset( $out[ $name ] ) || self::starts_with_any( $name, $deny ) || ! self::starts_with_any( $name, $allow ) ) {
					continue;
				}
				$meta = (array) $ability->get_meta();
				$ro   = $meta['annotations']['readonly'] ?? null;
				if ( null === $ro ) {
					$ro = (bool) preg_match( '#/(get|search|list|preview|discover|find)-#', $name );
				}
				$schema = $ability->get_input_schema();
				$rm_write = 0 === strpos( $name, 'rank-math/set-' ) || 'rank-math/fix-site-seo' === $name;
				$out[ $name ] = array(
					'name'        => $name,
					'api_name'    => self::api_name( $name ),
					'label'       => $ability->get_label(),
					'description' => $ability->get_description(),
					'schema'      => self::clean_schema( $schema ),
					'has_input'   => ! empty( $schema ),
					'readonly'    => (bool) $ro,
					'admin'       => $rm_write || in_array( $name, self::ADMIN_ONLY, true ),
					'approval'    => $rm_write || in_array( $name, self::ALWAYS_APPROVE, true ),
					'type'        => 'ability',
					'ability'     => $ability,
				);
			}
		}
		// Rank Math ships its own settings abilities: prefer them over our fallbacks.
		if ( isset( $out['rank-math/get-settings'], $out['rank-math/set-global-seo-settings'] ) ) {
			unset( $out['cwai/seo-settings-get'], $out['cwai/seo-settings-set'] );
		}
		return apply_filters( 'cwai_tools', $out );
	}

	public static function api_name( $name ) {
		$n = str_replace( '/', '__', $name );
		if ( strlen( $n ) > 64 ) {
			$n = substr( $n, 0, 55 ) . '_' . substr( md5( $name ), 0, 8 );
		}
		return preg_replace( '/[^A-Za-z0-9_\-]/', '_', $n );
	}

	/** Tools visible to the current user, in Anthropic API shape + lookup map. */
	public static function for_user( $user_id ) {
		$admin = CWAI_Plugin::is_admin_tier( $user_id );
		$tools = array();
		$map   = array();
		foreach ( self::discover() as $name => $d ) {
			if ( $d['admin'] && ! $admin ) {
				continue;
			}
			$desc = (string) $d['description'];
			if ( strlen( $desc ) > 6000 ) {
				$desc = substr( $desc, 0, 6000 ) . '…';
			}
			$tools[] = array(
				'name'         => $d['api_name'],
				'description'  => $desc ?: $d['label'],
				'input_schema' => $d['schema'],
			);
			$map[ $d['api_name'] ] = $d;
		}
		usort( $tools, static function ( $a, $b ) {
			return strcmp( $a['name'], $b['name'] );
		} );
		return array( $tools, $map );
	}

	/* ------------------------------------------------------------------ */
	/* Schema clean-up (WordPress schemas -> what the API accepts)         */
	/* ------------------------------------------------------------------ */

	public static function clean_schema( $schema ) {
		if ( ! is_array( $schema ) || empty( $schema ) ) {
			return array( 'type' => 'object', 'properties' => new stdClass() );
		}
		$schema = self::clean_node( $schema );
		if ( ( $schema['type'] ?? '' ) !== 'object' ) {
			$schema = array(
				'type'       => 'object',
				'properties' => array( 'value' => $schema ),
			);
		}
		if ( empty( $schema['properties'] ) ) {
			$schema['properties'] = new stdClass();
		}
		return $schema;
	}

	private static function clean_node( $node ) {
		if ( ! is_array( $node ) ) {
			return $node;
		}
		$is_list = array_keys( $node ) === range( 0, count( $node ) - 1 );
		if ( $is_list ) {
			return array_map( array( __CLASS__, 'clean_node' ), $node );
		}
		unset( $node['$schema'], $node['context'], $node['arg_options'], $node['readonly'], $node['sanitize_callback'], $node['validate_callback'] );

		$required_from_props = array();
		foreach ( array( 'properties', 'patternProperties', '$defs', 'definitions' ) as $k ) {
			if ( isset( $node[ $k ] ) && is_array( $node[ $k ] ) ) {
				foreach ( $node[ $k ] as $pk => $pv ) {
					if ( is_array( $pv ) && isset( $pv['required'] ) && is_bool( $pv['required'] ) ) {
						if ( $pv['required'] && 'properties' === $k ) {
							$required_from_props[] = $pk;
						}
						unset( $pv['required'] );
					}
					$node[ $k ][ $pk ] = self::clean_node( $pv );
				}
				if ( empty( $node[ $k ] ) ) {
					$node[ $k ] = new stdClass();
				}
			}
		}
		foreach ( $node as $k => $v ) {
			if ( in_array( $k, array( 'properties', 'patternProperties', '$defs', 'definitions', 'enum', 'default', 'examples', 'const' ), true ) ) {
				continue;
			}
			if ( 'required' === $k && is_bool( $v ) ) {
				unset( $node[ $k ] );
				continue;
			}
			if ( is_array( $v ) ) {
				$node[ $k ] = self::clean_node( $v );
			}
		}
		if ( $required_from_props ) {
			$existing         = isset( $node['required'] ) && is_array( $node['required'] ) ? $node['required'] : array();
			$node['required'] = array_values( array_unique( array_merge( $existing, $required_from_props ) ) );
		}
		if ( isset( $node['required'] ) && is_array( $node['required'] ) && empty( $node['required'] ) ) {
			unset( $node['required'] );
		}
		return $node;
	}

	/* ------------------------------------------------------------------ */
	/* Approval + description                                              */
	/* ------------------------------------------------------------------ */

	public static function needs_approval( array $d, array $input ) {
		if ( $d['readonly'] ) {
			return false;
		}
		if ( is_callable( $d['approval'] ) ) {
			if ( call_user_func( $d['approval'], $input ) ) {
				return true;
			}
		} elseif ( $d['approval'] ) {
			return true;
		}
		$name = $d['name'];
		if ( false !== strpos( $name, 'delete' ) ) {
			return true;
		}
		$status = $input['status'] ?? ( $input['post_status'] ?? '' );
		if ( 'change-post-status' === substr( $name, -18 ) && in_array( $status, array( 'trash', 'delete' ), true ) ) {
			return true;
		}
		if ( CWAI_Settings::get( 'approve_publish' ) && in_array( $status, array( 'publish', 'future' ), true ) ) {
			if ( false !== strpos( $name, 'status' ) || false !== strpos( $name, 'save-content' ) || false !== strpos( $name, 'create-post' ) || false !== strpos( $name, 'add-sermon' ) ) {
				return true;
			}
		}
		return false;
	}

	public static function describe_call( array $d, array $input ) {
		$bits = array();
		foreach ( array( 'post_id', 'id', 'item_id', 'menu', 'title', 'name', 'status', 'query', 'replace', 'tool', 'action' ) as $k ) {
			if ( isset( $input[ $k ] ) && is_scalar( $input[ $k ] ) && '' !== (string) $input[ $k ] ) {
				$v = (string) $input[ $k ];
				if ( in_array( $k, array( 'post_id', 'id' ), true ) && ( $p = get_post( (int) $v ) ) ) { // phpcs:ignore
					$v .= ' “' . wp_strip_all_tags( get_the_title( $p ) ) . '”';
				}
				$bits[] = $k . ': ' . mb_substr( $v, 0, 80 );
			}
		}
		return $d['label'] . ( $bits ? ' — ' . implode( ', ', $bits ) : '' );
	}

	/* ------------------------------------------------------------------ */
	/* Execution                                                           */
	/* ------------------------------------------------------------------ */

	/**
	 * @return array{ok:bool,data?:mixed,error?:string,snapshots:int[],touched:int[]}
	 */
	public static function execute( array $d, array $input ) {
		self::$ctx['touched'] = array();
		$snaps                = array();

		if ( $d['admin'] && ! CWAI_Plugin::is_admin_tier() ) {
			return array( 'ok' => false, 'error' => 'This action is limited to site administrators.', 'snapshots' => array(), 'touched' => array() );
		}
		$restore = self::elevate();
		try {
			if ( 'internal' === $d['type'] ) {
				$cap = $d['def']['capability'];
				if ( $cap && ! current_user_can( $cap ) ) {
					return array( 'ok' => false, 'error' => 'Your WordPress account is not allowed to do this.', 'snapshots' => array(), 'touched' => array() );
				}
			}
			return self::run( $d, $input, $snaps );
		} finally {
			if ( $restore ) {
				$restore();
			}
		}
	}

	/**
	 * Staff who are not administrators (editors) can use the assistant's curated tools: for the length of one tool call
	 * they are given the administrator role's capabilities, minus anything that installs code, switches themes or manages
	 * users. Administrator-only tools stay blocked before this point. Returns a function that ends the elevation.
	 */
	private static function elevate() {
		if ( ! CWAI_Settings::get( 'staff_elevate' ) || ! is_user_logged_in() || current_user_can( 'manage_options' ) ) {
			return null;
		}
		$uid  = get_current_user_id();
		$role = get_role( 'administrator' );
		if ( ! $role ) {
			return null;
		}
		$deny = array( 'install_plugins', 'activate_plugins', 'edit_plugins', 'delete_plugins', 'update_plugins', 'install_themes', 'switch_themes', 'edit_themes', 'delete_themes', 'update_themes', 'update_core', 'create_users', 'delete_users', 'edit_users', 'promote_users', 'remove_users', 'list_users', 'import', 'export', 'edit_files', 'unfiltered_upload', 'manage_network', 'manage_network_options', 'manage_network_plugins', 'manage_network_themes', 'manage_network_users', 'manage_sites', 'setup_network', 'upgrade_network' );
		$f    = static function ( $all, $caps, $args, $user ) use ( $uid, $role, $deny ) {
			if ( (int) $user->ID !== $uid ) {
				return $all;
			}
			foreach ( $role->capabilities as $c => $grant ) {
				if ( $grant && ! in_array( $c, $deny, true ) ) {
					$all[ $c ] = true;
				}
			}
			return $all;
		};
		add_filter( 'user_has_cap', $f, 99, 4 );
		return static function () use ( $f ) {
			remove_filter( 'user_has_cap', $f, 99 );
		};
	}

	private static function run( array $d, array $input, array $snaps ) {
		// Snapshot posts that are about to change.
		if ( ! $d['readonly'] ) {
			foreach ( self::target_ids( $d, $input ) as $pid ) {
				$sid = self::snapshot_post( $pid, $d['label'], $d['name'] );
				if ( $sid ) {
					$snaps[] = $sid;
				}
			}
		}

		try {
			if ( 'internal' === $d['type'] ) {
				$res = call_user_func( $d['def']['callback'], $input );
			} else {
				$arg = ! empty( $d['has_input'] ) ? $input : null;
				$res = $d['ability']->execute( $arg );
			}
		} catch ( \Throwable $e ) {
			return array( 'ok' => false, 'error' => 'Tool crashed: ' . $e->getMessage(), 'snapshots' => $snaps, 'touched' => array() );
		}

		if ( is_wp_error( $res ) ) {
			return array( 'ok' => false, 'error' => $res->get_error_code() . ': ' . $res->get_error_message(), 'snapshots' => $snaps, 'touched' => array() );
		}

		$touched = self::$ctx['touched'];
		if ( ! $d['readonly'] ) {
			foreach ( self::created_ids( $res, $d, $input ) as $pid ) {
				$sid = CWAI_Store::add_snapshot( self::$ctx['conv_id'], self::$ctx['user_id'], $pid, 'created', $d['name'], 'Created: ' . get_the_title( $pid ), array() );
				$snaps[] = $sid;
				$touched[] = $pid;
			}
			foreach ( self::target_ids( $d, $input ) as $pid ) {
				$touched[] = $pid;
			}
		}
		return array( 'ok' => true, 'data' => $res, 'snapshots' => $snaps, 'touched' => array_values( array_unique( array_map( 'intval', $touched ) ) ) );
	}

	/** Post IDs an invocation will modify (from input). */
	private static function target_ids( array $d, array $input ) {
		$ids = array();
		if ( 'internal' === $d['type'] ) {
			// Built-in tools say exactly which posts they change (none by default).
			$ids = is_callable( $d['def']['touches'] ) ? (array) call_user_func( $d['def']['touches'], $input ) : array();
		} else {
			foreach ( array( 'post_id', 'postId', 'id', 'ID' ) as $k ) {
				if ( isset( $input[ $k ] ) && is_numeric( $input[ $k ] ) ) {
					$ids[] = (int) $input[ $k ];
				}
			}
			if ( ! empty( $input['post_ids'] ) && is_array( $input['post_ids'] ) ) {
				$ids = array_merge( $ids, array_map( 'intval', $input['post_ids'] ) );
			}
		}
		$ids = array_slice( array_unique( array_filter( array_map( 'intval', $ids ) ) ), 0, 25 );
		return array_values(
			array_filter(
				$ids,
				static function ( $id ) {
					$p = get_post( $id );
					return $p && ! in_array( $p->post_type, array( 'attachment', 'nav_menu_item' ), true ) && current_user_can( 'edit_post', $id );
				}
			)
		);
	}

	/** Detect posts newly created by a call (an id in the result that was not in the input). */
	private static function created_ids( $res, array $d, array $input ) {
		if ( ! preg_match( '#/(save-content|duplicate-content|add-sermon|create-post|create-template|create-reusable-component|bot-kb-save)$#', $d['name'] ) ) {
			return array();
		}
		$in = array();
		foreach ( array( 'post_id', 'postId', 'id', 'ID' ) as $k ) {
			if ( isset( $input[ $k ] ) && is_numeric( $input[ $k ] ) ) {
				$in[] = (int) $input[ $k ];
			}
		}
		$out = array();
		if ( is_array( $res ) ) {
			foreach ( array( 'post_id', 'id', 'ID' ) as $k ) {
				if ( isset( $res[ $k ] ) && is_numeric( $res[ $k ] ) && ! in_array( (int) $res[ $k ], $in, true ) ) {
					$p = get_post( (int) $res[ $k ] );
					if ( $p && ! in_array( $p->post_type, array( 'nav_menu_item', 'attachment', 'revision' ), true ) && 'trash' !== $p->post_status && ( time() - (int) get_gmt_from_date( $p->post_modified, 'U' ) ) < 300 ) {
						$out[] = (int) $res[ $k ];
					}
				}
			}
		}
		return array_values( array_unique( $out ) );
	}

	/* ------------------------------------------------------------------ */
	/* Snapshots / undo                                                    */
	/* ------------------------------------------------------------------ */

	public static function snapshot_post( $post_id, $label, $tool ) {
		$p = get_post( $post_id );
		if ( ! $p ) {
			return 0;
		}
		$meta = array();
		foreach ( get_post_meta( $post_id ) as $k => $vals ) {
			if ( in_array( $k, array( '_edit_lock', '_edit_last', '_wp_old_slug' ), true ) ) {
				continue;
			}
			$meta[ $k ] = $vals;
		}
		$terms = array();
		foreach ( get_object_taxonomies( $p->post_type ) as $tax ) {
			$terms[ $tax ] = wp_get_object_terms( $post_id, $tax, array( 'fields' => 'ids' ) );
		}
		$data = array(
			'post'  => array(
				'post_title'     => $p->post_title,
				'post_content'   => $p->post_content,
				'post_excerpt'   => $p->post_excerpt,
				'post_status'    => $p->post_status,
				'post_name'      => $p->post_name,
				'post_parent'    => $p->post_parent,
				'menu_order'     => $p->menu_order,
				'post_date'      => $p->post_date,
				'post_date_gmt'  => $p->post_date_gmt,
				'comment_status' => $p->comment_status,
			),
			'meta'  => $meta,
			'terms' => $terms,
		);
		return CWAI_Store::add_snapshot( self::$ctx['conv_id'], self::$ctx['user_id'], $post_id, 'before', $tool, $label . ': ' . get_the_title( $post_id ), $data );
	}

	/** Restore a snapshot (undo). */
	public static function restore( $snapshot_id ) {
		$s = CWAI_Store::get_snapshot( $snapshot_id );
		if ( ! $s ) {
			return new WP_Error( 'cwai_snap', 'Undo point not found.' );
		}
		if ( (int) $s['user_id'] !== get_current_user_id() && ! current_user_can( 'manage_options' ) ) {
			return new WP_Error( 'cwai_snap', 'That undo point belongs to someone else.' );
		}
		if ( $s['restored'] ) {
			return new WP_Error( 'cwai_snap', 'Already restored.' );
		}
		$post_id = (int) $s['post_id'];
		if ( ! current_user_can( 'edit_post', $post_id ) ) {
			return new WP_Error( 'cwai_snap', 'You are not allowed to edit that item.' );
		}

		if ( 'created' === $s['kind'] ) {
			wp_trash_post( $post_id );
			CWAI_Store::mark_restored( $snapshot_id );
			return array( 'restored' => true, 'note' => 'The item that was created has been moved to the trash.', 'post_id' => $post_id );
		}

		$d = $s['data'];
		if ( empty( $d['post'] ) ) {
			return new WP_Error( 'cwai_snap', 'Undo data is empty.' );
		}
		$post            = wp_slash( $d['post'] );
		$post['ID']      = $post_id;
		$r               = wp_update_post( $post, true );
		if ( is_wp_error( $r ) ) {
			return $r;
		}
		// Meta: replace everything with the snapshot.
		foreach ( array_keys( get_post_meta( $post_id ) ) as $k ) {
			if ( in_array( $k, array( '_edit_lock', '_edit_last', '_wp_old_slug' ), true ) ) {
				continue;
			}
			delete_post_meta( $post_id, $k );
		}
		foreach ( (array) $d['meta'] as $k => $vals ) {
			foreach ( (array) $vals as $v ) {
				add_post_meta( $post_id, $k, wp_slash( maybe_unserialize( $v ) ) );
			}
		}
		foreach ( (array) ( $d['terms'] ?? array() ) as $tax => $ids ) {
			if ( taxonomy_exists( $tax ) ) {
				wp_set_object_terms( $post_id, array_map( 'intval', (array) $ids ), $tax );
			}
		}
		CWAI_Store::mark_restored( $snapshot_id );
		CWAI_Tools_Site::purge( array( $post_id ) );
		return array( 'restored' => true, 'post_id' => $post_id, 'note' => 'Restored to how it was before the change. If the page looks unstyled, ask the assistant to regenerate the Oxygen CSS for it.' );
	}
}
