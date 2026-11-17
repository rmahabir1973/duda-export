<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Content types (sermons, events, staff, ministries or anything custom) plus
 * the sermon tools. Works with the Sermon Manager plugin if it is installed,
 * otherwise provides a built-in Sermons type.
 */
final class CWAI_Tools_Types {

	const OPT = 'cwai_content_types';

	public static function presets() {
		return array(
			'sermon'   => array(
				'slug' => 'cwai_sermon', 'label' => 'Sermons', 'singular' => 'Sermon', 'rewrite' => 'sermons', 'icon' => 'dashicons-microphone', 'has_archive' => true,
				'supports' => array( 'title', 'editor', 'excerpt', 'thumbnail', 'revisions' ),
				'taxonomies' => array(
					'sermon_series'  => array( 'label' => 'Series', 'singular' => 'Series', 'hierarchical' => true ),
					'sermon_speaker' => array( 'label' => 'Speakers', 'singular' => 'Speaker', 'hierarchical' => false ),
					'sermon_topic'   => array( 'label' => 'Topics', 'singular' => 'Topic', 'hierarchical' => false ),
				),
				'fields' => array(
					'sermon_date' => array( 'label' => 'Sermon date', 'type' => 'date' ),
					'scripture'   => array( 'label' => 'Scripture', 'type' => 'text' ),
					'video_url'   => array( 'label' => 'Video URL (YouTube/Vimeo)', 'type' => 'url' ),
					'audio_url'   => array( 'label' => 'Audio URL', 'type' => 'url' ),
					'notes_url'   => array( 'label' => 'Notes / bulletin URL', 'type' => 'url' ),
				),
			),
			'event'    => array(
				'slug' => 'cwai_event', 'label' => 'Events', 'singular' => 'Event', 'rewrite' => 'events', 'icon' => 'dashicons-calendar-alt', 'has_archive' => true,
				'supports' => array( 'title', 'editor', 'excerpt', 'thumbnail', 'revisions' ),
				'taxonomies' => array( 'event_category' => array( 'label' => 'Event categories', 'singular' => 'Event category', 'hierarchical' => true ) ),
				'fields' => array(
					'event_start'      => array( 'label' => 'Starts (YYYY-MM-DD HH:MM)', 'type' => 'text' ),
					'event_end'        => array( 'label' => 'Ends (YYYY-MM-DD HH:MM)', 'type' => 'text' ),
					'event_location'   => array( 'label' => 'Location', 'type' => 'text' ),
					'registration_url' => array( 'label' => 'Registration URL', 'type' => 'url' ),
				),
			),
			'staff'    => array(
				'slug' => 'cwai_staff', 'label' => 'Staff', 'singular' => 'Staff member', 'rewrite' => 'staff', 'icon' => 'dashicons-groups', 'has_archive' => true,
				'supports' => array( 'title', 'editor', 'thumbnail', 'page-attributes' ),
				'taxonomies' => array( 'staff_group' => array( 'label' => 'Groups', 'singular' => 'Group', 'hierarchical' => true ) ),
				'fields' => array(
					'role_title' => array( 'label' => 'Role / title', 'type' => 'text' ),
					'email'      => array( 'label' => 'Email', 'type' => 'text' ),
					'phone'      => array( 'label' => 'Phone', 'type' => 'text' ),
				),
			),
			'ministry' => array(
				'slug' => 'cwai_ministry', 'label' => 'Ministries', 'singular' => 'Ministry', 'rewrite' => 'ministries', 'icon' => 'dashicons-heart', 'has_archive' => true,
				'supports' => array( 'title', 'editor', 'excerpt', 'thumbnail', 'page-attributes' ),
				'taxonomies' => array(),
				'fields' => array(
					'ministry_leader' => array( 'label' => 'Leader', 'type' => 'text' ),
					'meeting_time'    => array( 'label' => 'When it meets', 'type' => 'text' ),
					'contact_email'   => array( 'label' => 'Contact email', 'type' => 'text' ),
				),
			),
		);
	}

	public static function defs() {
		$d = get_option( self::OPT, array() );
		return is_array( $d ) ? $d : array();
	}

	/* ------------------------------------------------------------------ */
	/* WordPress registration                                              */
	/* ------------------------------------------------------------------ */

	public static function boot() {
		self::register_types();
		add_action( 'wp_loaded', array( __CLASS__, 'maybe_flush' ) );
		add_action( 'add_meta_boxes', array( __CLASS__, 'meta_boxes' ) );
		add_action( 'save_post', array( __CLASS__, 'save_meta_box' ), 10, 2 );
	}

	public static function maybe_flush() {
		if ( get_option( 'cwai_flush' ) ) {
			flush_rewrite_rules( false );
			delete_option( 'cwai_flush' );
		}
	}

	public static function register_types() {
		foreach ( self::defs() as $slug => $d ) {
			if ( post_type_exists( $slug ) ) {
				continue;
			}
			$sing = $d['singular'];
			register_post_type( $slug, array(
				'labels'       => array(
					'name' => $d['label'], 'singular_name' => $sing, 'add_new_item' => "Add New $sing", 'edit_item' => "Edit $sing",
					'new_item' => "New $sing", 'view_item' => "View $sing", 'search_items' => 'Search ' . $d['label'], 'not_found' => 'None found',
				),
				'public'       => true,
				'show_in_rest' => true,
				'has_archive'  => ! empty( $d['has_archive'] ),
				'rewrite'      => array( 'slug' => $d['rewrite'] ?? $slug ),
				'supports'     => $d['supports'] ?? array( 'title', 'editor', 'thumbnail' ),
				'menu_icon'    => $d['icon'] ?? 'dashicons-admin-post',
				'menu_position' => 6,
			) );
			foreach ( (array) ( $d['taxonomies'] ?? array() ) as $tslug => $t ) {
				register_taxonomy( $tslug, array( $slug ), array(
					'labels'       => array( 'name' => $t['label'], 'singular_name' => $t['singular'] ?? $t['label'] ),
					'public'       => true,
					'hierarchical' => ! empty( $t['hierarchical'] ),
					'show_in_rest' => true,
					'show_admin_column' => true,
					'rewrite'      => array( 'slug' => $tslug ),
				) );
			}
			foreach ( (array) ( $d['fields'] ?? array() ) as $key => $f ) {
				register_post_meta( $slug, $key, array(
					'single'       => true,
					'type'         => 'number' === ( $f['type'] ?? '' ) ? 'number' : 'string',
					'show_in_rest' => true,
					'auth_callback' => static function () use ( $slug ) {
						return current_user_can( 'edit_posts' );
					},
				) );
			}
		}
	}

	public static function meta_boxes() {
		foreach ( self::defs() as $slug => $d ) {
			if ( ! empty( $d['fields'] ) ) {
				add_meta_box( 'cwai_fields', $d['singular'] . ' details', array( __CLASS__, 'render_box' ), $slug, 'normal', 'high' );
			}
		}
	}

	public static function render_box( $post ) {
		$d = self::defs()[ $post->post_type ] ?? null;
		if ( ! $d ) {
			return;
		}
		wp_nonce_field( 'cwai_fields', 'cwai_fields_nonce' );
		echo '<table class="form-table">';
		foreach ( $d['fields'] as $key => $f ) {
			$type = in_array( $f['type'] ?? 'text', array( 'date', 'url', 'number' ), true ) ? $f['type'] : 'text';
			printf(
				'<tr><th><label for="cwai_f_%1$s">%2$s</label></th><td><input type="%3$s" class="regular-text" id="cwai_f_%1$s" name="cwai_f[%1$s]" value="%4$s"></td></tr>',
				esc_attr( $key ), esc_html( $f['label'] ), esc_attr( $type ), esc_attr( (string) get_post_meta( $post->ID, $key, true ) )
			);
		}
		echo '</table>';
	}

	public static function save_meta_box( $post_id, $post ) {
		if ( empty( $_POST['cwai_fields_nonce'] ) || ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['cwai_fields_nonce'] ) ), 'cwai_fields' ) || ! current_user_can( 'edit_post', $post_id ) ) {
			return;
		}
		$d = self::defs()[ $post->post_type ] ?? null;
		if ( ! $d ) {
			return;
		}
		foreach ( array_keys( $d['fields'] ) as $key ) {
			if ( isset( $_POST['cwai_f'][ $key ] ) ) {
				$v = sanitize_text_field( wp_unslash( $_POST['cwai_f'][ $key ] ) );
				'url' === ( $d['fields'][ $key ]['type'] ?? '' ) ? update_post_meta( $post_id, $key, esc_url_raw( $v ) ) : update_post_meta( $post_id, $key, $v );
			}
		}
	}

	/* ------------------------------------------------------------------ */
	/* Tools                                                               */
	/* ------------------------------------------------------------------ */

	public static function register() {
		$p = array( 'CWAI_Tools_Content', 'p' );
		$s = array( 'CWAI_Tools_Content', 'schema' );

		CWAI_Registry::add( 'cwai/list-content-types', array(
			'label' => 'List content types', 'description' => 'List every public content type (pages, posts, sermons, events, staff, ...), whether it was created by this assistant, its taxonomies and custom fields, and which type holds sermons.',
			'input' => array(), 'callback' => array( __CLASS__, 'list_types' ), 'readonly' => true,
		) );
		CWAI_Registry::add( 'cwai/define-content-type', array(
			'label' => 'Create content type', 'description' => 'Create (or update) a content type such as Sermons, Events, Staff or Ministries, or a fully custom one (e.g. "Prayer requests") with its own categories and fields. Use preset for the common ones. After creating, items are added with cwai__save-content (or cwai__add-sermon).',
			'input' => call_user_func( $s, array(
				'preset'      => call_user_func( $p, 'string', 'sermon, event, staff or ministry.', array( 'enum' => array( 'sermon', 'event', 'staff', 'ministry' ) ) ),
				'slug'        => call_user_func( $p, 'string', 'Custom type slug (letters/numbers/underscore, max 15; "cwai_" is added).' ),
				'label'       => call_user_func( $p, 'string', 'Plural label, e.g. "Prayer Requests".' ),
				'singular'    => call_user_func( $p, 'string', 'Singular label.' ),
				'icon'        => call_user_func( $p, 'string', 'Dashicon class, e.g. dashicons-heart.' ),
				'has_archive' => call_user_func( $p, 'boolean', 'Public archive page (default true).' ),
				'taxonomies'  => call_user_func( $p, 'object', '{"slug": {"label":"Plural","singular":"Singular","hierarchical":true}}' ),
				'fields'      => call_user_func( $p, 'object', '{"meta_key": {"label":"Label","type":"text|textarea|url|date|number"}}' ),
			) ),
			'callback' => array( __CLASS__, 'define_type' ), 'approval' => true, 'capability' => 'edit_pages',
		) );
		CWAI_Registry::add( 'cwai/remove-content-type', array(
			'label' => 'Remove content type', 'description' => 'ADMIN. Stop registering an assistant-created content type. Existing entries stay in the database (nothing is deleted) and reappear if the type is created again.',
			'input' => call_user_func( $s, array( 'slug' => call_user_func( $p, 'string', 'Full post type slug (e.g. cwai_event).' ) ), array( 'slug' ) ),
			'callback' => array( __CLASS__, 'remove_type' ), 'admin' => true, 'approval' => true, 'capability' => 'manage_options',
		) );
		CWAI_Registry::add( 'cwai/add-sermon', array(
			'label' => 'Add sermon', 'description' => 'Add (or with id, update) a sermon with date, speaker, series, scripture, topics, video/audio links, summary and notes. Works with the Sermon Manager plugin or the built-in Sermons type (created automatically for administrators if none exists). Video/audio URLs: a YouTube or Vimeo link works as-is.',
			'input' => call_user_func( $s, array(
				'id'                => call_user_func( $p, 'integer', 'Existing sermon ID to update.' ),
				'title'             => call_user_func( $p, 'string', 'Sermon title.' ),
				'date'              => call_user_func( $p, 'string', 'Date preached, e.g. 2026-11-08 (default today).' ),
				'speaker'           => call_user_func( $p, 'string', 'Speaker name.' ),
				'series'            => call_user_func( $p, 'string', 'Series name.' ),
				'scripture'         => call_user_func( $p, 'string', 'Scripture reference, e.g. John 3:1-17.' ),
				'topics'            => call_user_func( $p, 'array', 'Topic names.', array( 'items' => array( 'type' => 'string' ) ) ),
				'video_url'         => call_user_func( $p, 'string', 'YouTube/Vimeo/Facebook video link.' ),
				'audio_url'         => call_user_func( $p, 'string', 'Audio file or podcast URL.' ),
				'notes_url'         => call_user_func( $p, 'string', 'Sermon notes / bulletin PDF URL.' ),
				'summary'           => call_user_func( $p, 'string', 'Short description for lists and search results.' ),
				'content'           => call_user_func( $p, 'string', 'Full body HTML (outline, transcript).' ),
				'featured_image_id' => call_user_func( $p, 'integer', 'Media ID of the thumbnail.' ),
				'embed_video'       => call_user_func( $p, 'boolean', 'Built-in type only: also put the video link at the top of the body so it plays on the sermon page (default true).' ),
				'status'            => call_user_func( $p, 'string', 'draft or publish.' ),
			) ),
			'callback' => array( __CLASS__, 'add_sermon' ),
			'touches'  => static function ( $in ) {
				return ! empty( $in['id'] ) ? array( (int) $in['id'] ) : array();
			},
		) );
		CWAI_Registry::add( 'cwai/list-sermons', array(
			'label' => 'List sermons', 'description' => 'List sermons newest first with speaker, series, scripture and media links.',
			'input' => call_user_func( $s, array(
				'search'   => call_user_func( $p, 'string', 'Keyword.' ),
				'series'   => call_user_func( $p, 'string', 'Series name or slug.' ),
				'speaker'  => call_user_func( $p, 'string', 'Speaker name or slug.' ),
				'status'   => call_user_func( $p, 'string', 'any (default), publish, draft.' ),
				'per_page' => call_user_func( $p, 'integer', 'Max 40, default 15.' ),
			) ),
			'callback' => array( __CLASS__, 'list_sermons' ), 'readonly' => true,
		) );
	}

	public static function list_types( $in = array() ) {
		$mine = self::defs();
		$out  = array();
		foreach ( CWAI_Tools_Content::public_types() as $slug => $o ) {
			$row = array(
				'slug'       => $slug,
				'label'      => $o->labels->name,
				'hierarchical' => (bool) $o->hierarchical,
				'created_by_assistant' => isset( $mine[ $slug ] ),
				'taxonomies' => array_values( get_object_taxonomies( $slug ) ),
			);
			if ( isset( $mine[ $slug ] ) ) {
				$row['fields'] = array_map( static function ( $f ) {
					return $f['label'] . ' (' . ( $f['type'] ?? 'text' ) . ')';
				}, $mine[ $slug ]['fields'] ?? array() );
			}
			$out[] = $row;
		}
		return array( 'types' => $out, 'sermon_type' => CWAI_Tools_Content::sermon_type() ?: null, 'presets_available' => array_keys( self::presets() ) );
	}

	public static function define_type( $in ) {
		$presets = self::presets();
		if ( ! empty( $in['preset'] ) ) {
			if ( ! isset( $presets[ $in['preset'] ] ) ) {
				return new WP_Error( 'cwai_preset', 'Unknown preset.' );
			}
			$d = $presets[ $in['preset'] ];
		} else {
			$raw = preg_replace( '/[^a-z0-9_]/', '', strtolower( (string) ( $in['slug'] ?? '' ) ) );
			$raw = preg_replace( '/^cwai_/', '', $raw );
			if ( '' === $raw || strlen( $raw ) > 15 ) {
				return new WP_Error( 'cwai_slug', 'Give a short slug (letters, numbers, underscore; max 15).' );
			}
			if ( empty( $in['label'] ) ) {
				return new WP_Error( 'cwai_label', 'A label is required.' );
			}
			$d = array(
				'slug' => 'cwai_' . $raw, 'label' => (string) $in['label'], 'singular' => (string) ( $in['singular'] ?? $in['label'] ),
				'rewrite' => str_replace( '_', '-', $raw ), 'icon' => preg_match( '/^dashicons-[a-z0-9\-]+$/', (string) ( $in['icon'] ?? '' ) ) ? $in['icon'] : 'dashicons-admin-post',
				'has_archive' => ! isset( $in['has_archive'] ) || (bool) $in['has_archive'],
				'supports' => array( 'title', 'editor', 'excerpt', 'thumbnail', 'revisions' ),
				'taxonomies' => array(), 'fields' => array(),
			);
			foreach ( (array) ( $in['taxonomies'] ?? array() ) as $ts => $t ) {
				$ts = sanitize_key( $ts );
				if ( $ts && ! in_array( $ts, array( 'category', 'post_tag', 'nav_menu', 'link_category', 'post_format' ), true ) && strlen( $ts ) <= 32 ) {
					$d['taxonomies'][ $ts ] = array( 'label' => sanitize_text_field( $t['label'] ?? $ts ), 'singular' => sanitize_text_field( $t['singular'] ?? ( $t['label'] ?? $ts ) ), 'hierarchical' => ! empty( $t['hierarchical'] ) );
				}
			}
			foreach ( (array) ( $in['fields'] ?? array() ) as $k => $f ) {
				$k = sanitize_key( $k );
				if ( $k && '_' !== $k[0] ) {
					$type = in_array( $f['type'] ?? 'text', array( 'text', 'textarea', 'url', 'date', 'number' ), true ) ? $f['type'] : 'text';
					$d['fields'][ $k ] = array( 'label' => sanitize_text_field( $f['label'] ?? $k ), 'type' => $type );
				}
			}
		}
		if ( post_type_exists( $d['slug'] ) && ! isset( self::defs()[ $d['slug'] ] ) ) {
			return new WP_Error( 'cwai_exists', 'A content type with that name already exists and was not created by the assistant.' );
		}
		$defs                = self::defs();
		$defs[ $d['slug'] ]  = $d;
		update_option( self::OPT, $defs, false );
		update_option( 'cwai_flush', 1, false );
		self::register_types();
		flush_rewrite_rules( false );
		delete_option( 'cwai_flush' );
		return array( 'slug' => $d['slug'], 'label' => $d['label'], 'archive_url' => get_post_type_archive_link( $d['slug'] ), 'taxonomies' => array_keys( $d['taxonomies'] ), 'fields' => array_keys( $d['fields'] ), 'note' => 'Created. Add entries with cwai__save-content. To list them on a page, build an Oxygen loop over this post type.' );
	}

	public static function remove_type( $in ) {
		$slug = (string) ( $in['slug'] ?? '' );
		$defs = self::defs();
		if ( ! isset( $defs[ $slug ] ) ) {
			return new WP_Error( 'cwai_nf', 'That content type was not created by the assistant.' );
		}
		unset( $defs[ $slug ] );
		update_option( self::OPT, $defs, false );
		update_option( 'cwai_flush', 1, false );
		return array( 'removed' => $slug, 'note' => 'Existing entries are kept in the database.' );
	}

	/* ------------------------------------------------------------------ */
	/* Sermons                                                             */
	/* ------------------------------------------------------------------ */

	private static function adapter() {
		$t = CWAI_Tools_Content::sermon_type();
		if ( 'wpfc_sermon' === $t ) {
			return array(
				'type' => $t, 'mode' => 'sermon_manager',
				'tax' => array( 'series' => 'wpfc_sermon_series', 'speaker' => 'wpfc_preacher', 'topics' => 'wpfc_sermon_topics' ),
				'meta' => array( 'date' => 'sermon_date', 'scripture' => 'bible_passage', 'video' => 'sermon_video_link', 'audio' => 'sermon_audio', 'notes' => 'sermon_notes', 'summary' => 'sermon_description' ),
			);
		}
		if ( $t ) {
			return array(
				'type' => $t, 'mode' => 'builtin',
				'tax' => array( 'series' => 'sermon_series', 'speaker' => 'sermon_speaker', 'topics' => 'sermon_topic' ),
				'meta' => array( 'date' => 'sermon_date', 'scripture' => 'scripture', 'video' => 'video_url', 'audio' => 'audio_url', 'notes' => 'notes_url', 'summary' => '' ),
			);
		}
		return null;
	}

	public static function add_sermon( $in ) {
		$ad = self::adapter();
		if ( ! $ad ) {
			if ( ! current_user_can( 'manage_options' ) ) {
				return new WP_Error( 'cwai_nosermon', 'This site has no Sermons section yet. Create it first with cwai__define-content-type (preset sermon; it asks for approval), then add the sermon.' );
			}
			$r = self::define_type( array( 'preset' => 'sermon' ) );
			if ( is_wp_error( $r ) ) {
				return $r;
			}
			$ad = self::adapter();
		}
		$id = (int) ( $in['id'] ?? 0 );
		if ( ! $id && empty( $in['title'] ) ) {
			return new WP_Error( 'cwai_title', 'A sermon title is required.' );
		}
		$m    = $ad['meta'];
		$meta = array();
		if ( ! empty( $in['date'] ) || ! $id ) {
			try {
				$dt = new DateTime( (string) ( $in['date'] ?? 'today' ), wp_timezone() );
			} catch ( Exception $e ) {
				return new WP_Error( 'cwai_date', 'Could not read that date. Use a format like 2026-11-08.' );
			}
			$meta[ $m['date'] ] = 'sermon_manager' === $ad['mode'] ? $dt->getTimestamp() : $dt->format( 'Y-m-d' );
		}
		foreach ( array( 'scripture' => 'scripture', 'video' => 'video_url', 'audio' => 'audio_url', 'notes' => 'notes_url' ) as $slot => $k ) {
			if ( isset( $in[ $k ] ) ) {
				$meta[ $m[ $slot ] ] = in_array( $slot, array( 'video', 'audio', 'notes' ), true ) ? esc_url_raw( $in[ $k ] ) : sanitize_text_field( $in[ $k ] );
			}
		}
		$content = $in['content'] ?? null;
		if ( 'builtin' === $ad['mode'] && ! empty( $in['video_url'] ) && ( ! isset( $in['embed_video'] ) || $in['embed_video'] ) ) {
			$content = esc_url_raw( $in['video_url'] ) . "\n\n" . ( $content ?? '' );
		}
		$save = array( 'post_type' => $ad['type'], 'meta' => $meta );
		if ( $id ) {
			$save['id'] = $id;
		}
		foreach ( array( 'title', 'status', 'featured_image_id' ) as $k ) {
			if ( isset( $in[ $k ] ) ) {
				$save[ $k ] = $in[ $k ];
			}
		}
		if ( null !== $content ) {
			$save['content'] = $content;
		}
		if ( isset( $in['summary'] ) ) {
			if ( $m['summary'] ) {
				$save['meta'][ $m['summary'] ] = wp_kses_post( $in['summary'] );
			}
			$save['excerpt'] = wp_strip_all_tags( $in['summary'] );
		}
		$terms = array();
		foreach ( array( 'series', 'speaker' ) as $k ) {
			if ( ! empty( $in[ $k ] ) ) {
				$terms[ $ad['tax'][ $k ] ] = array( (string) $in[ $k ] );
			}
		}
		if ( ! empty( $in['topics'] ) ) {
			$terms[ $ad['tax']['topics'] ] = (array) $in['topics'];
		}
		if ( $terms ) {
			$save['terms'] = $terms;
		}
		$r = CWAI_Tools_Content::save( $save );
		if ( is_array( $r ) ) {
			$r['sermon_source'] = $ad['mode'];
		}
		return $r;
	}

	private static function names( $post_id, $tax ) {
		$t = wp_get_object_terms( $post_id, $tax, array( 'fields' => 'names' ) );
		return is_wp_error( $t ) ? '' : implode( ', ', $t );
	}

	public static function list_sermons( $in = array() ) {
		$ad = self::adapter();
		if ( ! $ad ) {
			return array( 'sermons' => array(), 'note' => 'No sermon content type exists yet.' );
		}
		$status = $in['status'] ?? 'any';
		$args   = array(
			'post_type'      => $ad['type'],
			'post_status'    => 'any' === $status ? array( 'publish', 'draft', 'pending', 'private', 'future' ) : $status,
			'posts_per_page' => min( 40, max( 1, (int) ( $in['per_page'] ?? 15 ) ) ),
			'orderby'        => 'date',
			'order'          => 'DESC',
		);
		if ( ! empty( $in['search'] ) ) {
			$args['s'] = sanitize_text_field( $in['search'] );
		}
		$tq = array();
		foreach ( array( 'series', 'speaker' ) as $k ) {
			if ( ! empty( $in[ $k ] ) ) {
				$tq[] = array( 'taxonomy' => $ad['tax'][ $k ], 'field' => preg_match( '/^[a-z0-9\-]+$/', (string) $in[ $k ] ) ? 'slug' : 'name', 'terms' => $in[ $k ] ); // phpcs:ignore
			}
		}
		if ( $tq ) {
			$args['tax_query'] = $tq; // phpcs:ignore
		}
		$q   = new WP_Query( $args );
		$out = array();
		foreach ( $q->posts as $p ) {
			$m     = $ad['meta'];
			$date  = get_post_meta( $p->ID, $m['date'], true );
			$out[] = array(
				'id'        => $p->ID,
				'title'     => get_the_title( $p ),
				'status'    => $p->post_status,
				'date'      => is_numeric( $date ) ? wp_date( 'Y-m-d', (int) $date ) : $date,
				'speaker'   => self::names( $p->ID, $ad['tax']['speaker'] ),
				'series'    => self::names( $p->ID, $ad['tax']['series'] ),
				'scripture' => get_post_meta( $p->ID, $m['scripture'], true ),
				'video_url' => get_post_meta( $p->ID, $m['video'], true ),
				'audio_url' => get_post_meta( $p->ID, $m['audio'], true ),
				'url'       => 'publish' === $p->post_status ? get_permalink( $p ) : get_preview_post_link( $p ),
			);
		}
		return array( 'type' => $ad['type'], 'total' => (int) $q->found_posts, 'sermons' => $out );
	}
}
