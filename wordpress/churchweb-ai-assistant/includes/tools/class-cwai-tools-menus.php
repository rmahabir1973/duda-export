<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * WordPress navigation menu tools.
 */
final class CWAI_Tools_Menus {

	public static function register() {
		$p   = array( 'CWAI_Tools_Content', 'p' );
		$s   = array( 'CWAI_Tools_Content', 'schema' );
		$cap = 'edit_theme_options';
		$menu = call_user_func( $p, 'string', 'Menu ID, slug or name.' );

		CWAI_Registry::add( 'cwai/list-menus', array(
			'label' => 'List menus', 'description' => 'List all WordPress menus, item counts, and which theme location each is assigned to. Also lists available locations.',
			'input' => array(), 'callback' => array( __CLASS__, 'list_menus' ), 'readonly' => true, 'capability' => $cap,
		) );
		CWAI_Registry::add( 'cwai/get-menu', array(
			'label' => 'Read menu', 'description' => 'Get a menu as a nested tree: each item with id, title, url, linked page/post, parent, position, target and CSS classes.',
			'input' => call_user_func( $s, array( 'menu' => $menu ), array( 'menu' ) ), 'callback' => array( __CLASS__, 'get_menu' ), 'readonly' => true, 'capability' => $cap,
		) );
		CWAI_Registry::add( 'cwai/create-menu', array(
			'label' => 'Create menu', 'description' => 'Create an empty menu, optionally assigning it to a theme location.',
			'input' => call_user_func( $s, array( 'name' => call_user_func( $p, 'string', 'Menu name.' ), 'location' => call_user_func( $p, 'string', 'Theme location slug (see cwai__list-menus).' ) ), array( 'name' ) ),
			'callback' => array( __CLASS__, 'create_menu' ), 'capability' => $cap,
		) );
		CWAI_Registry::add( 'cwai/rename-menu', array(
			'label' => 'Rename menu', 'description' => 'Rename a menu.',
			'input' => call_user_func( $s, array( 'menu' => $menu, 'name' => call_user_func( $p, 'string', 'New name.' ) ), array( 'menu', 'name' ) ),
			'callback' => array( __CLASS__, 'rename_menu' ), 'capability' => $cap,
		) );
		CWAI_Registry::add( 'cwai/set-menu-location', array(
			'label' => 'Assign menu to location', 'description' => 'Assign a menu to a registered theme location (e.g. primary). Oxygen menu elements instead pick a menu by name inside the element (use oxygen__get-dropdown-options).',
			'input' => call_user_func( $s, array( 'menu' => $menu, 'location' => call_user_func( $p, 'string', 'Location slug.' ) ), array( 'menu', 'location' ) ),
			'callback' => array( __CLASS__, 'set_location' ), 'capability' => $cap,
		) );
		CWAI_Registry::add( 'cwai/add-menu-item', array(
			'label' => 'Add menu item', 'description' => 'Add an item to a menu. Link a page/post/custom-type entry with post_id, a category/term with term_id+taxonomy, or any URL with url. Use parent_item_id for sub-menu items and position to order.',
			'input' => call_user_func( $s, array(
				'menu'           => $menu,
				'title'          => call_user_func( $p, 'string', 'Label (defaults to the page title).' ),
				'post_id'        => call_user_func( $p, 'integer', 'Page/post to link.' ),
				'term_id'        => call_user_func( $p, 'integer', 'Term to link.' ),
				'taxonomy'       => call_user_func( $p, 'string', 'Taxonomy of term_id.' ),
				'url'            => call_user_func( $p, 'string', 'Custom URL (mailto:, tel:, external, #anchor).' ),
				'parent_item_id' => call_user_func( $p, 'integer', 'Menu item ID of the parent (0 = top level).' ),
				'position'       => call_user_func( $p, 'integer', 'Order, starting at 1.' ),
				'target'         => call_user_func( $p, 'string', '"_blank" to open in a new tab.' ),
				'classes'        => call_user_func( $p, 'string', 'CSS classes.' ),
				'description'    => call_user_func( $p, 'string', 'Description.' ),
			), array( 'menu' ) ),
			'callback' => array( __CLASS__, 'add_item' ), 'capability' => $cap,
		) );
		CWAI_Registry::add( 'cwai/update-menu-item', array(
			'label' => 'Edit menu item', 'description' => 'Change a menu item label, link, parent, position, target or classes. Only the fields you pass change.',
			'input' => call_user_func( $s, array(
				'item_id'        => call_user_func( $p, 'integer', 'Menu item ID.' ),
				'title'          => call_user_func( $p, 'string', 'New label.' ),
				'url'            => call_user_func( $p, 'string', 'New URL (custom links only).' ),
				'parent_item_id' => call_user_func( $p, 'integer', 'New parent item ID (0 = top level).' ),
				'position'       => call_user_func( $p, 'integer', 'New order.' ),
				'target'         => call_user_func( $p, 'string', '"_blank" or empty.' ),
				'classes'        => call_user_func( $p, 'string', 'CSS classes.' ),
				'description'    => call_user_func( $p, 'string', 'Description.' ),
			), array( 'item_id' ) ),
			'callback' => array( __CLASS__, 'update_item' ), 'capability' => $cap,
		) );
		CWAI_Registry::add( 'cwai/reorder-menu', array(
			'label' => 'Reorder menu', 'description' => 'Set order and nesting for many items in one call. Pass every item you want to place: {"item_id","parent_item_id","position"}.',
			'input' => call_user_func( $s, array(
				'menu'  => $menu,
				'order' => array( 'type' => 'array', 'description' => 'Items in the desired structure.', 'items' => array( 'type' => 'object', 'properties' => array(
					'item_id'        => array( 'type' => 'integer' ),
					'parent_item_id' => array( 'type' => 'integer' ),
					'position'       => array( 'type' => 'integer' ),
				), 'required' => array( 'item_id' ) ) ),
			), array( 'menu', 'order' ) ),
			'callback' => array( __CLASS__, 'reorder' ), 'capability' => $cap,
		) );
		CWAI_Registry::add( 'cwai/delete-menu-item', array(
			'label' => 'Remove menu item', 'description' => 'Remove an item from a menu (the linked page is not deleted). The person is asked to approve.',
			'input' => call_user_func( $s, array( 'item_id' => call_user_func( $p, 'integer', 'Menu item ID.' ) ), array( 'item_id' ) ),
			'callback' => array( __CLASS__, 'delete_item' ), 'capability' => $cap, 'approval' => true,
		) );
		CWAI_Registry::add( 'cwai/delete-menu', array(
			'label' => 'Delete menu', 'description' => 'Delete an entire menu and its items. The person is asked to approve.',
			'input' => call_user_func( $s, array( 'menu' => $menu ), array( 'menu' ) ),
			'callback' => array( __CLASS__, 'delete_menu' ), 'capability' => $cap, 'approval' => true,
		) );
	}

	private static function find_menu( $ref ) {
		$m = wp_get_nav_menu_object( is_numeric( $ref ) ? (int) $ref : (string) $ref );
		return $m ? $m : null;
	}

	public static function list_menus() {
		return array(
			'menus'     => CWAI_Tools_Content::menus_summary(),
			'locations' => get_registered_nav_menus(),
			'assigned'  => get_nav_menu_locations(),
		);
	}

	private static function tree( array $items, $parent = 0 ) {
		$out = array();
		foreach ( $items as $it ) {
			if ( (int) $it->menu_item_parent === (int) $parent ) {
				$node = array(
					'item_id'  => (int) $it->ID,
					'title'    => $it->title,
					'url'      => $it->url,
					'type'     => $it->type,
					'object'   => $it->object,
					'object_id' => (int) $it->object_id,
					'position' => (int) $it->menu_order,
					'target'   => $it->target,
					'classes'  => implode( ' ', array_filter( (array) $it->classes ) ),
				);
				$kids = self::tree( $items, $it->ID );
				if ( $kids ) {
					$node['children'] = $kids;
				}
				$out[] = $node;
			}
		}
		return $out;
	}

	public static function get_menu( $in ) {
		$m = self::find_menu( $in['menu'] ?? '' );
		if ( ! $m ) {
			return new WP_Error( 'cwai_nf', 'Menu not found.' );
		}
		$items = wp_get_nav_menu_items( $m->term_id, array( 'post_status' => 'any' ) ) ?: array();
		return array( 'id' => $m->term_id, 'name' => $m->name, 'slug' => $m->slug, 'items' => self::tree( $items ) );
	}

	public static function create_menu( $in ) {
		$id = wp_create_nav_menu( (string) $in['name'] );
		if ( is_wp_error( $id ) ) {
			return $id;
		}
		if ( ! empty( $in['location'] ) ) {
			$r = self::set_location( array( 'menu' => $id, 'location' => $in['location'] ) );
			if ( is_wp_error( $r ) ) {
				return $r;
			}
		}
		return array( 'id' => $id, 'name' => $in['name'] );
	}

	public static function rename_menu( $in ) {
		$m = self::find_menu( $in['menu'] ?? '' );
		if ( ! $m ) {
			return new WP_Error( 'cwai_nf', 'Menu not found.' );
		}
		$r = wp_update_nav_menu_object( $m->term_id, array( 'menu-name' => (string) $in['name'] ) );
		return is_wp_error( $r ) ? $r : array( 'id' => $m->term_id, 'name' => $in['name'] );
	}

	public static function set_location( $in ) {
		$m = self::find_menu( $in['menu'] ?? '' );
		if ( ! $m ) {
			return new WP_Error( 'cwai_nf', 'Menu not found.' );
		}
		$loc = (string) ( $in['location'] ?? '' );
		if ( ! array_key_exists( $loc, get_registered_nav_menus() ) ) {
			return new WP_Error( 'cwai_loc', 'Unknown location. Available: ' . implode( ', ', array_keys( get_registered_nav_menus() ) ?: array( '(none registered by the theme)' ) ) );
		}
		$locs         = get_nav_menu_locations();
		$locs[ $loc ] = $m->term_id;
		set_theme_mod( 'nav_menu_locations', $locs );
		return array( 'menu' => $m->name, 'location' => $loc );
	}

	public static function add_item( $in ) {
		$m = self::find_menu( $in['menu'] ?? '' );
		if ( ! $m ) {
			return new WP_Error( 'cwai_nf', 'Menu not found.' );
		}
		$args = array(
			'menu-item-status'    => 'publish',
			'menu-item-parent-id' => (int) ( $in['parent_item_id'] ?? 0 ),
		);
		if ( ! empty( $in['position'] ) ) {
			$args['menu-item-position'] = (int) $in['position'];
		}
		foreach ( array( 'target' => 'menu-item-target', 'classes' => 'menu-item-classes', 'description' => 'menu-item-description' ) as $k => $f ) {
			if ( isset( $in[ $k ] ) ) {
				$args[ $f ] = (string) $in[ $k ];
			}
		}
		if ( ! empty( $in['post_id'] ) ) {
			$p = get_post( (int) $in['post_id'] );
			if ( ! $p ) {
				return new WP_Error( 'cwai_nf', 'Linked page not found.' );
			}
			$args += array(
				'menu-item-type'      => 'post_type',
				'menu-item-object'    => $p->post_type,
				'menu-item-object-id' => $p->ID,
				'menu-item-title'     => ! empty( $in['title'] ) ? (string) $in['title'] : get_the_title( $p ),
			);
		} elseif ( ! empty( $in['term_id'] ) && ! empty( $in['taxonomy'] ) && taxonomy_exists( $in['taxonomy'] ) ) {
			$t = get_term( (int) $in['term_id'], $in['taxonomy'] );
			if ( ! $t || is_wp_error( $t ) ) {
				return new WP_Error( 'cwai_nf', 'Term not found.' );
			}
			$args += array(
				'menu-item-type'      => 'taxonomy',
				'menu-item-object'    => $in['taxonomy'],
				'menu-item-object-id' => $t->term_id,
				'menu-item-title'     => ! empty( $in['title'] ) ? (string) $in['title'] : $t->name,
			);
		} elseif ( ! empty( $in['url'] ) ) {
			$args += array(
				'menu-item-type'  => 'custom',
				'menu-item-url'   => (string) $in['url'],
				'menu-item-title' => (string) ( $in['title'] ?? $in['url'] ),
			);
		} else {
			return new WP_Error( 'cwai_args', 'Give post_id, term_id+taxonomy, or url.' );
		}
		$id = wp_update_nav_menu_item( $m->term_id, 0, $args );
		return is_wp_error( $id ) ? $id : array( 'item_id' => $id, 'menu' => $m->name, 'title' => $args['menu-item-title'] );
	}

	public static function update_item( $in ) {
		$id = (int) ( $in['item_id'] ?? 0 );
		$it = get_post( $id );
		if ( ! $it || 'nav_menu_item' !== $it->post_type ) {
			return new WP_Error( 'cwai_nf', 'Menu item not found.' );
		}
		$it    = wp_setup_nav_menu_item( $it );
		$terms = wp_get_object_terms( $id, 'nav_menu' );
		if ( empty( $terms[0] ) ) {
			return new WP_Error( 'cwai_nf', 'Menu not found for this item.' );
		}
		$args = array(
			'menu-item-type'        => $it->type,
			'menu-item-object'      => $it->object,
			'menu-item-object-id'   => $it->object_id,
			'menu-item-parent-id'   => array_key_exists( 'parent_item_id', $in ) ? (int) $in['parent_item_id'] : (int) $it->menu_item_parent,
			'menu-item-position'    => array_key_exists( 'position', $in ) ? (int) $in['position'] : (int) $it->menu_order,
			'menu-item-title'       => $in['title'] ?? $it->title,
			'menu-item-url'         => 'custom' === $it->type ? ( $in['url'] ?? $it->url ) : '',
			'menu-item-target'      => $in['target'] ?? $it->target,
			'menu-item-classes'     => $in['classes'] ?? implode( ' ', (array) $it->classes ),
			'menu-item-description' => $in['description'] ?? $it->description,
			'menu-item-attr-title'  => $it->attr_title,
			'menu-item-xfn'         => $it->xfn,
			'menu-item-status'      => 'publish',
		);
		$r = wp_update_nav_menu_item( $terms[0]->term_id, $id, $args );
		return is_wp_error( $r ) ? $r : array( 'item_id' => $id, 'updated' => true );
	}

	public static function reorder( $in ) {
		$m = self::find_menu( $in['menu'] ?? '' );
		if ( ! $m ) {
			return new WP_Error( 'cwai_nf', 'Menu not found.' );
		}
		$n = 0;
		foreach ( (array) ( $in['order'] ?? array() ) as $row ) {
			$r = self::update_item( array(
				'item_id'        => (int) $row['item_id'],
				'parent_item_id' => (int) ( $row['parent_item_id'] ?? 0 ),
				'position'       => (int) ( $row['position'] ?? ++$n ),
			) );
			if ( is_wp_error( $r ) ) {
				return $r;
			}
		}
		return self::get_menu( array( 'menu' => $m->term_id ) );
	}

	public static function delete_item( $in ) {
		$id = (int) ( $in['item_id'] ?? 0 );
		$it = get_post( $id );
		if ( ! $it || 'nav_menu_item' !== $it->post_type ) {
			return new WP_Error( 'cwai_nf', 'Menu item not found.' );
		}
		wp_delete_post( $id, true );
		return array( 'item_id' => $id, 'removed' => true );
	}

	public static function delete_menu( $in ) {
		$m = self::find_menu( $in['menu'] ?? '' );
		if ( ! $m ) {
			return new WP_Error( 'cwai_nf', 'Menu not found.' );
		}
		$r = wp_delete_nav_menu( $m->term_id );
		return is_wp_error( $r ) ? $r : array( 'deleted' => $m->name );
	}
}
