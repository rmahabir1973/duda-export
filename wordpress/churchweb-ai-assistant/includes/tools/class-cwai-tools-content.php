<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Content tools: find / read / save / duplicate / status / terms / overview.
 */
final class CWAI_Tools_Content {

	/* schema helpers shared by all tool classes */
	public static function p( $type, $desc, array $extra = array() ) {
		return array( 'type' => $type, 'description' => $desc ) + $extra;
	}
	public static function schema( array $props, array $req = array() ) {
		return array( 'type' => 'object', 'properties' => $props, 'required' => $req );
	}

	public static function register() {
		$p = array( __CLASS__, 'p' );

		CWAI_Registry::add( 'cwai/site-overview', array(
			'label'       => 'Site overview',
			'description' => 'One-call orientation: site name/URL, front page, theme, builder, relevant plugins, content types with counts, menus and their locations, and the current user. Call this first when you need to understand the site.',
			'input'       => array(),
			'callback'    => array( __CLASS__, 'overview' ),
			'readonly'    => true,
			'capability'  => 'edit_posts',
		) );

		CWAI_Registry::add( 'cwai/find-content', array(
			'label'       => 'Find content',
			'description' => 'List/search pages, posts, sermons, events or any content type (including Oxygen templates when post_type is given). Returns id, type, title, slug, status, url, parent, dates. Use "search" for keywords. Excludes trash unless status is "trash".',
			'input'       => self::schema( array(
				'post_type' => self::p( 'string', 'Post type slug, or "any" for all public types (default).' ),
				'status'    => self::p( 'string', 'publish, draft, pending, private, future, trash or any (default any, without trash).' ),
				'search'    => self::p( 'string', 'Keyword(s) to search in title and content.' ),
				'parent'    => self::p( 'integer', 'Only children of this parent ID.' ),
				'taxonomy'  => self::p( 'string', 'Taxonomy slug to filter by (with "term").' ),
				'term'      => self::p( 'string', 'Term slug or name for the taxonomy filter.' ),
				'orderby'   => self::p( 'string', 'date, modified, title, menu_order or ID.', array( 'enum' => array( 'date', 'modified', 'title', 'menu_order', 'ID' ) ) ),
				'order'     => self::p( 'string', 'ASC or DESC.', array( 'enum' => array( 'ASC', 'DESC' ) ) ),
				'per_page'  => self::p( 'integer', 'Max 50, default 20.' ),
				'page'      => self::p( 'integer', 'Page number, default 1.' ),
			) ),
			'callback'    => array( __CLASS__, 'find' ),
			'readonly'    => true,
		) );

		CWAI_Registry::add( 'cwai/get-content', array(
			'label'       => 'Read content',
			'description' => 'Get one item: fields, classic body HTML (for Oxygen-built pages the layout lives in the builder, read it with oxygen__get-post-tree), categories/tags/terms, public custom fields, featured image and links.',
			'input'       => self::schema( array( 'id' => self::p( 'integer', 'Post ID.' ) ), array( 'id' ) ),
			'callback'    => array( __CLASS__, 'get' ),
			'readonly'    => true,
		) );

		CWAI_Registry::add( 'cwai/save-content', array(
			'label'       => 'Create or update content',
			'description' => 'Create (omit id) or update a page, blog post, sermon-like item or any custom post type: title, body HTML, excerpt, slug, status, schedule date, parent, categories, tags, other taxonomies, custom fields and featured image. New items default to draft when the site is set that way. For Oxygen layouts use the oxygen__ tools instead; this is for titles, settings, blog/post bodies and metadata. Body should be clean HTML (p, h2-h4, ul, ol, a, img, blockquote, figure).',
			'input'       => self::schema( array(
				'id'                => self::p( 'integer', 'Existing post ID to update. Omit to create.' ),
				'post_type'         => self::p( 'string', 'post, page or a custom type slug. Default post.' ),
				'title'             => self::p( 'string', 'Title.' ),
				'content'           => self::p( 'string', 'Body HTML.' ),
				'excerpt'           => self::p( 'string', 'Short summary shown in lists.' ),
				'slug'              => self::p( 'string', 'URL slug.' ),
				'status'            => self::p( 'string', 'draft, pending, publish, private or future.' ),
				'publish_date'      => self::p( 'string', 'Site-local date/time like 2026-11-08 09:00 to schedule or backdate.' ),
				'parent'            => self::p( 'integer', 'Parent page ID.' ),
				'menu_order'        => self::p( 'integer', 'Sort order.' ),
				'categories'        => self::p( 'array', 'Category names or IDs (blog posts). Missing names are created.', array( 'items' => array( 'type' => array( 'string', 'integer' ) ) ) ),
				'tags'              => self::p( 'array', 'Tag names.', array( 'items' => array( 'type' => 'string' ) ) ),
				'terms'             => self::p( 'object', 'Other taxonomies: {"taxonomy_slug": ["Term", ...]}.' ),
				'meta'              => self::p( 'object', 'Custom fields {"key": value}. Protected (underscore) keys are ignored.' ),
				'featured_image_id' => self::p( 'integer', 'Media library ID; 0 removes.' ),
				'comment_status'    => self::p( 'string', 'open or closed.' ),
			) ),
			'callback'    => array( __CLASS__, 'save' ),
			'touches'     => static function ( $in ) {
				return ! empty( $in['id'] ) ? array( (int) $in['id'] ) : array();
			},
		) );

		CWAI_Registry::add( 'cwai/set-content-status', array(
			'label'       => 'Change status',
			'description' => 'Publish, unpublish (draft), set private/pending, schedule, move to trash, or restore from trash. Nothing is ever permanently deleted.',
			'input'       => self::schema( array(
				'id'           => self::p( 'integer', 'Post ID.' ),
				'status'       => self::p( 'string', 'publish, draft, pending, private, future, trash or restore.', array( 'enum' => array( 'publish', 'draft', 'pending', 'private', 'future', 'trash', 'restore' ) ) ),
				'publish_date' => self::p( 'string', 'Site-local date/time, required for future.' ),
			), array( 'id', 'status' ) ),
			'callback'    => array( __CLASS__, 'set_status' ),
			'touches'     => static function ( $in ) {
				return array( (int) ( $in['id'] ?? 0 ) );
			},
			'approval'    => static function ( $in ) {
				return 'trash' === ( $in['status'] ?? '' );
			},
		) );

		CWAI_Registry::add( 'cwai/duplicate-content', array(
			'label'       => 'Duplicate page or post',
			'description' => 'Copy an existing page/post (including its Oxygen layout, settings, taxonomies and featured image) into a new DRAFT. Use this to make "a new page like that one", then edit the copy.',
			'input'       => self::schema( array(
				'id'    => self::p( 'integer', 'Source post ID.' ),
				'title' => self::p( 'string', 'Title for the copy (default: "Copy of ...").' ),
				'slug'  => self::p( 'string', 'Slug for the copy.' ),
			), array( 'id' ) ),
			'callback'    => array( __CLASS__, 'duplicate' ),
			'capability'  => 'edit_pages',
		) );

		CWAI_Registry::add( 'cwai/manage-terms', array(
			'label'       => 'Manage categories and tags',
			'description' => 'List, create, rename or delete terms in any taxonomy (categories, tags, sermon series, speakers, ...). Deleting asks the person to approve.',
			'input'       => self::schema( array(
				'action'      => self::p( 'string', 'list, create, update or delete.', array( 'enum' => array( 'list', 'create', 'update', 'delete' ) ) ),
				'taxonomy'    => self::p( 'string', 'Taxonomy slug, e.g. category, post_tag.' ),
				'id'          => self::p( 'integer', 'Term ID (update/delete).' ),
				'name'        => self::p( 'string', 'Term name.' ),
				'slug'        => self::p( 'string', 'Term slug.' ),
				'parent'      => self::p( 'integer', 'Parent term ID.' ),
				'description' => self::p( 'string', 'Description.' ),
				'search'      => self::p( 'string', 'Filter for list.' ),
			), array( 'action', 'taxonomy' ) ),
			'callback'    => array( __CLASS__, 'terms' ),
			'capability'  => 'edit_posts',
			'approval'    => static function ( $in ) {
				return 'delete' === ( $in['action'] ?? '' );
			},
			'readonly'    => false,
		) );
	}

	/* ------------------------------------------------------------------ */

	public static function builder_label() {
		foreach ( (array) get_option( 'active_plugins', array() ) as $pl ) {
			if ( false !== stripos( $pl, 'oxygen' ) ) {
				return 'Oxygen';
			}
			if ( false !== stripos( $pl, 'breakdance' ) ) {
				return 'Breakdance';
			}
		}
		return function_exists( 'wp_get_abilities' ) && wp_has_ability( 'oxygen/html-to-page' ) ? 'Oxygen' : 'none detected (block/classic editor)';
	}

	public static function sermon_type() {
		if ( post_type_exists( 'wpfc_sermon' ) ) {
			return 'wpfc_sermon';
		}
		if ( post_type_exists( 'cwai_sermon' ) ) {
			return 'cwai_sermon';
		}
		foreach ( get_post_types( array( 'public' => true ) ) as $t ) {
			if ( false !== strpos( $t, 'sermon' ) ) {
				return $t;
			}
		}
		return '';
	}

	public static function public_types() {
		$t = get_post_types( array( 'public' => true ), 'objects' );
		unset( $t['attachment'] );
		return $t;
	}

	public static function menus_summary() {
		$locs = get_nav_menu_locations();
		$reg  = get_registered_nav_menus();
		$out  = array();
		foreach ( wp_get_nav_menus() as $m ) {
			$where = array();
			foreach ( $locs as $loc => $mid ) {
				if ( (int) $mid === (int) $m->term_id ) {
					$where[] = $reg[ $loc ] ?? $loc;
				}
			}
			$out[] = array( 'id' => $m->term_id, 'name' => $m->name, 'slug' => $m->slug, 'items' => (int) $m->count, 'locations' => $where );
		}
		return $out;
	}

	/** Compact text for the system prompt. */
	public static function site_context() {
		$front = (int) get_option( 'page_on_front' );
		$lines = array(
			'- Name: ' . get_bloginfo( 'name' ) . ' — ' . get_bloginfo( 'description' ),
			'- URL: ' . home_url( '/' ),
			'- Front page: ' . ( 'page' === get_option( 'show_on_front' ) && $front ? get_the_title( $front ) . " (ID $front)" : 'latest posts' ),
			'- Page builder: ' . self::builder_label(),
			'- Theme: ' . wp_get_theme()->get( 'Name' ),
			'- Rank Math SEO: ' . ( CWAI_Tools_SEO::active() ? 'active' : CWAI_Tools_SEO::state_note() ),
		);
		$types = array();
		foreach ( self::public_types() as $slug => $o ) {
			$c       = wp_count_posts( $slug );
			$types[] = "{$o->labels->name} [{$slug}] " . (int) ( $c->publish ?? 0 ) . ' live';
		}
		$lines[] = '- Content types: ' . implode( '; ', $types );
		$st      = self::sermon_type();
		$lines[] = '- Sermons: ' . ( $st ? "stored as [{$st}]" : 'no sermon content type yet (cwai__add-sermon will set one up)' );
		$mm = array();
		foreach ( self::menus_summary() as $m ) {
			$mm[] = $m['name'] . ' (' . $m['items'] . ' items' . ( $m['locations'] ? '; ' . implode( ', ', $m['locations'] ) : '' ) . ')';
		}
		$lines[] = '- Menus: ' . ( $mm ? implode( '; ', $mm ) : 'none' );
		return implode( "\n", $lines );
	}

	public static function overview( $in = array() ) {
		$front = (int) get_option( 'page_on_front' );
		$user  = wp_get_current_user();
		$types = array();
		foreach ( self::public_types() as $slug => $o ) {
			$c       = wp_count_posts( $slug );
			$types[] = array( 'slug' => $slug, 'label' => $o->labels->name, 'publish' => (int) ( $c->publish ?? 0 ), 'draft' => (int) ( $c->draft ?? 0 ), 'pending' => (int) ( $c->pending ?? 0 ), 'future' => (int) ( $c->future ?? 0 ) );
		}
		return array(
			'name'          => get_bloginfo( 'name' ),
			'tagline'       => get_bloginfo( 'description' ),
			'url'           => home_url( '/' ),
			'language'      => get_locale(),
			'timezone'      => wp_timezone_string(),
			'wordpress'     => get_bloginfo( 'version' ),
			'theme'         => wp_get_theme()->get( 'Name' ),
			'builder'       => self::builder_label(),
			'front_page'    => 'page' === get_option( 'show_on_front' ) && $front ? array( 'id' => $front, 'title' => get_the_title( $front ) ) : 'latest posts',
			'posts_page'    => (int) get_option( 'page_for_posts' ),
			'rank_math'     => defined( 'RANK_MATH_VERSION' ) ? RANK_MATH_VERSION : false,
			'rank_math_state' => CWAI_Tools_SEO::state(),
			'sermon_type'   => self::sermon_type(),
			'content_types' => $types,
			'menus'         => self::menus_summary(),
			'menu_locations' => get_registered_nav_menus(),
			'taxonomies'    => array_values( array_map( static function ( $t ) {
				return array( 'slug' => $t->name, 'label' => $t->label, 'for' => array_values( $t->object_type ) );
			}, get_taxonomies( array( 'public' => true ), 'objects' ) ) ),
			'current_user'  => array( 'name' => $user->display_name, 'roles' => $user->roles, 'is_admin' => current_user_can( 'manage_options' ) ),
			'now'           => wp_date( 'c' ),
		);
	}

	private static function item( WP_Post $p ) {
		return array(
			'id'       => $p->ID,
			'type'     => $p->post_type,
			'title'    => get_the_title( $p ),
			'slug'     => $p->post_name,
			'status'   => $p->post_status,
			'url'      => 'publish' === $p->post_status ? get_permalink( $p ) : get_preview_post_link( $p ),
			'parent'   => $p->post_parent,
			'date'     => $p->post_date,
			'modified' => $p->post_modified,
		);
	}

	public static function find( $in ) {
		$type = $in['post_type'] ?? 'any';
		if ( 'any' === $type ) {
			$type = array_keys( self::public_types() );
		}
		$status = $in['status'] ?? 'any';
		$args   = array(
			'post_type'      => $type,
			'post_status'    => 'any' === $status ? array( 'publish', 'draft', 'pending', 'private', 'future' ) : $status,
			'posts_per_page' => min( 50, max( 1, (int) ( $in['per_page'] ?? 20 ) ) ),
			'paged'          => max( 1, (int) ( $in['page'] ?? 1 ) ),
			'orderby'        => $in['orderby'] ?? 'modified',
			'order'          => $in['order'] ?? 'DESC',
			'no_found_rows'  => false,
		);
		if ( ! empty( $in['search'] ) ) {
			$args['s'] = sanitize_text_field( $in['search'] );
		}
		if ( isset( $in['parent'] ) ) {
			$args['post_parent'] = (int) $in['parent'];
		}
		if ( ! empty( $in['taxonomy'] ) && ! empty( $in['term'] ) && taxonomy_exists( $in['taxonomy'] ) ) {
			$field = is_numeric( $in['term'] ) ? 'term_id' : 'slug';
			$args['tax_query'] = array( array( 'taxonomy' => $in['taxonomy'], 'field' => $field, 'terms' => $in['term'] ) ); // phpcs:ignore
		}
		$q     = new WP_Query( $args );
		$items = array();
		foreach ( $q->posts as $p ) {
			if ( current_user_can( 'read_post', $p->ID ) || 'publish' === $p->post_status ) {
				$items[] = self::item( $p );
			}
		}
		return array( 'total' => (int) $q->found_posts, 'pages' => (int) $q->max_num_pages, 'items' => $items );
	}

	public static function get( $in ) {
		$p = get_post( (int) ( $in['id'] ?? 0 ) );
		if ( ! $p || ! current_user_can( 'read_post', $p->ID ) ) {
			return new WP_Error( 'cwai_nf', 'Content not found.' );
		}
		$meta = array();
		$builder = false;
		foreach ( get_post_meta( $p->ID ) as $k => $v ) {
			if ( preg_match( '/^_?(oxygen|breakdance)/i', $k ) ) {
				$builder = true;
			}
			if ( '_' !== $k[0] || 0 === strpos( $k, 'rank_math' ) ) {
				$val         = maybe_unserialize( $v[0] );
				$meta[ $k ] = is_string( $val ) ? mb_substr( $val, 0, 500 ) : $val;
			}
		}
		$terms = array();
		foreach ( get_object_taxonomies( $p->post_type, 'objects' ) as $tax ) {
			$t = wp_get_object_terms( $p->ID, $tax->name );
			if ( ! is_wp_error( $t ) && $t ) {
				$terms[ $tax->name ] = wp_list_pluck( $t, 'name' );
			}
		}
		$out = self::item( $p ) + array(
			'excerpt'        => $p->post_excerpt,
			'content'        => mb_substr( $p->post_content, 0, 20000 ),
			'built_with_oxygen' => $builder,
			'terms'          => $terms,
			'custom_fields'  => $meta,
			'featured_image' => ( $tid = get_post_thumbnail_id( $p ) ) ? array( 'id' => $tid, 'url' => wp_get_attachment_url( $tid ) ) : null, // phpcs:ignore
			'edit_url'       => get_edit_post_link( $p->ID, 'raw' ),
			'author'         => get_the_author_meta( 'display_name', $p->post_author ),
		);
		if ( $builder ) {
			$out['note'] = 'This item is built with the page builder; edit its layout with the oxygen__ tools (get-post-tree, edit-post).';
		}
		return $out;
	}

	public static function save( $in ) {
		$id       = (int) ( $in['id'] ?? 0 );
		$warnings = array();
		$arr      = array();
		if ( $id ) {
			$cur = get_post( $id );
			if ( ! $cur ) {
				return new WP_Error( 'cwai_nf', 'Content not found.' );
			}
			if ( ! current_user_can( 'edit_post', $id ) ) {
				return new WP_Error( 'cwai_cap', 'You are not allowed to edit this item.' );
			}
			$type      = $cur->post_type;
			$arr['ID'] = $id;
		} else {
			$type = sanitize_key( $in['post_type'] ?? 'post' );
			if ( ! post_type_exists( $type ) ) {
				return new WP_Error( 'cwai_type', "Unknown content type '$type'. Use cwai__list-content-types." );
			}
			if ( ! current_user_can( get_post_type_object( $type )->cap->create_posts ) ) {
				return new WP_Error( 'cwai_cap', 'You are not allowed to create this type of content.' );
			}
			$arr['post_type'] = $type;
		}
		$pto = get_post_type_object( $type );
		foreach ( array( 'title' => 'post_title', 'content' => 'post_content', 'excerpt' => 'post_excerpt', 'slug' => 'post_name', 'parent' => 'post_parent', 'menu_order' => 'menu_order', 'comment_status' => 'comment_status' ) as $k => $f ) {
			if ( array_key_exists( $k, $in ) ) {
				$arr[ $f ] = in_array( $k, array( 'parent', 'menu_order' ), true ) ? (int) $in[ $k ] : (string) $in[ $k ];
			}
		}
		if ( isset( $arr['post_name'] ) ) {
			$arr['post_name'] = sanitize_title( $arr['post_name'] );
		}

		$status = $in['status'] ?? null;
		if ( ! $id && ! $status ) {
			$status = CWAI_Settings::get( 'auto_draft' ) ? 'draft' : 'publish';
		}
		if ( ! empty( $in['publish_date'] ) ) {
			$ts = strtotime( (string) $in['publish_date'] . ' ' . wp_timezone_string() );
			$ts = $ts ? $ts : strtotime( (string) $in['publish_date'] );
			if ( $ts ) {
				$arr['post_date']     = wp_date( 'Y-m-d H:i:s', $ts );
				$arr['post_date_gmt'] = gmdate( 'Y-m-d H:i:s', $ts );
				if ( $ts > time() && ( ! $status || 'publish' === $status ) ) {
					$status = 'future';
				}
			}
		}
		if ( $status ) {
			if ( ! in_array( $status, array( 'draft', 'pending', 'publish', 'private', 'future' ), true ) ) {
				return new WP_Error( 'cwai_status', 'Invalid status.' );
			}
			if ( in_array( $status, array( 'publish', 'future', 'private' ), true ) && ! current_user_can( $pto->cap->publish_posts ) ) {
				$status     = 'pending';
				$warnings[] = 'You cannot publish, so it was saved as pending review.';
			}
			$arr['post_status'] = $status;
		}
		if ( ! $id && empty( $arr['post_title'] ) ) {
			return new WP_Error( 'cwai_title', 'A title is required.' );
		}

		$res = $id ? wp_update_post( wp_slash( $arr ), true ) : wp_insert_post( wp_slash( $arr ), true );
		if ( is_wp_error( $res ) ) {
			return $res;
		}
		$id = (int) $res;

		// Taxonomies.
		$sets = array();
		if ( ! empty( $in['categories'] ) && is_object_in_taxonomy( $type, 'category' ) ) {
			$sets['category'] = (array) $in['categories'];
		}
		if ( ! empty( $in['tags'] ) && is_object_in_taxonomy( $type, 'post_tag' ) ) {
			$sets['post_tag'] = (array) $in['tags'];
		}
		foreach ( (array) ( $in['terms'] ?? array() ) as $tax => $list ) {
			if ( taxonomy_exists( $tax ) && is_object_in_taxonomy( $type, $tax ) ) {
				$sets[ $tax ] = (array) $list;
			} else {
				$warnings[] = "Taxonomy '$tax' does not apply to $type.";
			}
		}
		foreach ( $sets as $tax => $list ) {
			$list = array_map( static function ( $v ) {
				return is_numeric( $v ) ? (int) $v : sanitize_text_field( $v );
			}, $list );
			wp_set_object_terms( $id, $list, $tax );
		}

		// Custom fields.
		foreach ( (array) ( $in['meta'] ?? array() ) as $k => $v ) {
			$k = (string) $k;
			if ( '' === $k || ( is_protected_meta( $k, 'post' ) && 0 !== strpos( $k, 'rank_math_' ) ) ) {
				$warnings[] = "Skipped protected field '$k'.";
				continue;
			}
			update_post_meta( $id, $k, wp_slash( $v ) );
		}
		if ( array_key_exists( 'featured_image_id', $in ) ) {
			$mid = (int) $in['featured_image_id'];
			if ( $mid > 0 && 'attachment' === get_post_type( $mid ) ) {
				set_post_thumbnail( $id, $mid );
			} elseif ( 0 === $mid ) {
				delete_post_thumbnail( $id );
			}
		}

		$p = get_post( $id );
		return array(
			'id'       => $id,
			'post_id'  => $id,
			'type'     => $p->post_type,
			'title'    => get_the_title( $p ),
			'status'   => $p->post_status,
			'url'      => 'publish' === $p->post_status ? get_permalink( $p ) : get_preview_post_link( $p ),
			'edit_url' => get_edit_post_link( $id, 'raw' ),
			'warnings' => $warnings,
		);
	}

	public static function set_status( $in ) {
		$id = (int) ( $in['id'] ?? 0 );
		$p  = get_post( $id );
		if ( ! $p ) {
			return new WP_Error( 'cwai_nf', 'Content not found.' );
		}
		$status = $in['status'] ?? '';
		if ( 'trash' === $status ) {
			if ( ! current_user_can( 'delete_post', $id ) ) {
				return new WP_Error( 'cwai_cap', 'You are not allowed to remove this item.' );
			}
			if ( (int) get_option( 'page_on_front' ) === $id ) {
				return new WP_Error( 'cwai_front', 'This is the home page. Set a different home page first.' );
			}
			wp_trash_post( $id );
			return array( 'id' => $id, 'status' => 'trash', 'note' => 'Moved to trash. It can be restored.' );
		}
		if ( 'restore' === $status ) {
			if ( ! current_user_can( 'delete_post', $id ) ) {
				return new WP_Error( 'cwai_cap', 'Not allowed.' );
			}
			wp_untrash_post( $id );
			return array( 'id' => $id, 'status' => get_post_status( $id ) );
		}
		return self::save( array( 'id' => $id, 'status' => $status, 'publish_date' => $in['publish_date'] ?? null ) );
	}

	public static function duplicate( $in ) {
		$src = get_post( (int) ( $in['id'] ?? 0 ) );
		if ( ! $src || ! current_user_can( 'read_post', $src->ID ) ) {
			return new WP_Error( 'cwai_nf', 'Source not found.' );
		}
		$pto = get_post_type_object( $src->post_type );
		if ( ! current_user_can( $pto->cap->create_posts ) ) {
			return new WP_Error( 'cwai_cap', 'You are not allowed to create this type of content.' );
		}
		$new = wp_insert_post( wp_slash( array(
			'post_type'      => $src->post_type,
			'post_title'     => ! empty( $in['title'] ) ? (string) $in['title'] : 'Copy of ' . $src->post_title,
			'post_name'      => ! empty( $in['slug'] ) ? sanitize_title( $in['slug'] ) : '',
			'post_content'   => $src->post_content,
			'post_excerpt'   => $src->post_excerpt,
			'post_parent'    => $src->post_parent,
			'menu_order'     => $src->menu_order,
			'post_status'    => 'draft',
			'comment_status' => $src->comment_status,
		) ), true );
		if ( is_wp_error( $new ) ) {
			return $new;
		}
		foreach ( get_post_meta( $src->ID ) as $k => $vals ) {
			if ( in_array( $k, array( '_edit_lock', '_edit_last', '_wp_old_slug', '_wp_trash_meta_status', '_wp_trash_meta_time' ), true ) || 0 === strpos( $k, 'rank_math_seo_score' ) ) {
				continue;
			}
			foreach ( $vals as $v ) {
				add_post_meta( $new, $k, wp_slash( maybe_unserialize( $v ) ) );
			}
		}
		foreach ( get_object_taxonomies( $src->post_type ) as $tax ) {
			$ids = wp_get_object_terms( $src->ID, $tax, array( 'fields' => 'ids' ) );
			if ( ! is_wp_error( $ids ) ) {
				wp_set_object_terms( $new, $ids, $tax );
			}
		}
		$note = 'Created as a draft.';
		if ( ( $ab = CWAI_Registry::ability( 'oxygen/run-site-tool' ) ) && CWAI_Plugin::is_admin_tier() ) { // phpcs:ignore
			$ab->execute( array( 'tool' => 'regenerate-css-cache', 'post_ids' => array( (int) $new ) ) );
			$note .= ' Oxygen CSS was rebuilt for the copy.';
		}
		return array( 'id' => $new, 'post_id' => $new, 'title' => get_the_title( $new ), 'status' => 'draft', 'edit_url' => get_edit_post_link( $new, 'raw' ), 'url' => get_preview_post_link( $new ), 'note' => $note );
	}

	public static function terms( $in ) {
		$tax = sanitize_key( $in['taxonomy'] ?? '' );
		if ( ! taxonomy_exists( $tax ) ) {
			return new WP_Error( 'cwai_tax', "Unknown taxonomy '$tax'." );
		}
		$to     = get_taxonomy( $tax );
		$action = $in['action'] ?? 'list';
		if ( 'list' === $action ) {
			$t = get_terms( array( 'taxonomy' => $tax, 'hide_empty' => false, 'number' => 200, 'search' => $in['search'] ?? '' ) );
			return is_wp_error( $t ) ? $t : array_map( static function ( $x ) {
				return array( 'id' => $x->term_id, 'name' => $x->name, 'slug' => $x->slug, 'parent' => $x->parent, 'count' => $x->count );
			}, $t );
		}
		if ( ! current_user_can( $to->cap->manage_terms ) ) {
			return new WP_Error( 'cwai_cap', 'You are not allowed to manage these terms.' );
		}
		$args = array_filter( array(
			'slug'        => isset( $in['slug'] ) ? sanitize_title( $in['slug'] ) : null,
			'parent'      => isset( $in['parent'] ) ? (int) $in['parent'] : null,
			'description' => $in['description'] ?? null,
		), static function ( $v ) {
			return null !== $v;
		} );
		if ( 'create' === $action ) {
			$r = wp_insert_term( (string) ( $in['name'] ?? '' ), $tax, $args );
			return is_wp_error( $r ) ? $r : array( 'id' => $r['term_id'], 'name' => $in['name'] );
		}
		$id = (int) ( $in['id'] ?? 0 );
		if ( 'update' === $action ) {
			if ( isset( $in['name'] ) ) {
				$args['name'] = (string) $in['name'];
			}
			$r = wp_update_term( $id, $tax, $args );
			return is_wp_error( $r ) ? $r : array( 'id' => $id, 'updated' => true );
		}
		if ( 'delete' === $action ) {
			$r = wp_delete_term( $id, $tax );
			return is_wp_error( $r ) ? $r : array( 'id' => $id, 'deleted' => (bool) $r );
		}
		return new WP_Error( 'cwai_action', 'Unknown action.' );
	}
}
