<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Media library tools.
 */
final class CWAI_Tools_Media {

	public static function register() {
		$p = array( 'CWAI_Tools_Content', 'p' );
		$s = array( 'CWAI_Tools_Content', 'schema' );

		CWAI_Registry::add( 'cwai/search-media', array(
			'label'       => 'Search media library',
			'description' => 'Find images, PDFs, audio or video already in the media library. Returns id, url, title, alt text, size and available image sizes. Prefer reusing existing media over importing new files.',
			'input'       => call_user_func( $s, array(
				'search'    => call_user_func( $p, 'string', 'Keywords in title/filename/caption.' ),
				'type'      => call_user_func( $p, 'string', 'image, video, audio, application/pdf ...' ),
				'per_page'  => call_user_func( $p, 'integer', 'Max 40, default 15.' ),
				'page'      => call_user_func( $p, 'integer', 'Page number.' ),
			) ),
			'callback'    => array( __CLASS__, 'search' ),
			'readonly'    => true,
			'capability'  => 'upload_files',
		) );
		CWAI_Registry::add( 'cwai/import-media-from-url', array(
			'label'       => 'Import media from URL',
			'description' => 'Download an image or document from a web address the person provided into the media library and optionally set alt text. Only use URLs the person gave you or approved.',
			'input'       => call_user_func( $s, array(
				'url'     => call_user_func( $p, 'string', 'https URL of the file.' ),
				'title'   => call_user_func( $p, 'string', 'Title.' ),
				'alt'     => call_user_func( $p, 'string', 'Alt text for images.' ),
				'caption' => call_user_func( $p, 'string', 'Caption.' ),
			), array( 'url' ) ),
			'callback'    => array( __CLASS__, 'import' ),
			'capability'  => 'upload_files',
		) );
		CWAI_Registry::add( 'cwai/update-media', array(
			'label'       => 'Edit media details',
			'description' => 'Set alt text, title, caption or description for a media item. Always give images meaningful alt text (it helps accessibility and SEO).',
			'input'       => call_user_func( $s, array(
				'id'          => call_user_func( $p, 'integer', 'Media ID.' ),
				'alt'         => call_user_func( $p, 'string', 'Alt text.' ),
				'title'       => call_user_func( $p, 'string', 'Title.' ),
				'caption'     => call_user_func( $p, 'string', 'Caption.' ),
				'description' => call_user_func( $p, 'string', 'Description.' ),
			), array( 'id' ) ),
			'callback'    => array( __CLASS__, 'update' ),
			'capability'  => 'upload_files',
		) );
	}

	private static function row( $id ) {
		$meta  = wp_get_attachment_metadata( $id );
		$sizes = array();
		foreach ( (array) ( $meta['sizes'] ?? array() ) as $name => $sz ) {
			$src = wp_get_attachment_image_src( $id, $name );
			if ( $src ) {
				$sizes[ $name ] = $src[0];
			}
		}
		return array(
			'id'     => (int) $id,
			'url'    => wp_get_attachment_url( $id ),
			'title'  => get_the_title( $id ),
			'alt'    => get_post_meta( $id, '_wp_attachment_image_alt', true ),
			'mime'   => get_post_mime_type( $id ),
			'width'  => $meta['width'] ?? null,
			'height' => $meta['height'] ?? null,
			'sizes'  => $sizes,
		);
	}

	public static function search( $in ) {
		$args = array(
			'post_type'      => 'attachment',
			'post_status'    => 'inherit',
			'posts_per_page' => min( 40, max( 1, (int) ( $in['per_page'] ?? 15 ) ) ),
			'paged'          => max( 1, (int) ( $in['page'] ?? 1 ) ),
			'orderby'        => 'date',
			'order'          => 'DESC',
		);
		if ( ! empty( $in['search'] ) ) {
			$args['s'] = sanitize_text_field( $in['search'] );
		}
		if ( ! empty( $in['type'] ) ) {
			$args['post_mime_type'] = sanitize_text_field( $in['type'] );
		}
		$q = new WP_Query( $args );
		return array( 'total' => (int) $q->found_posts, 'items' => array_map( array( __CLASS__, 'row' ), wp_list_pluck( $q->posts, 'ID' ) ) );
	}

	public static function import( $in ) {
		$url = esc_url_raw( (string) ( $in['url'] ?? '' ) );
		if ( ! preg_match( '#^https?://#i', $url ) ) {
			return new WP_Error( 'cwai_url', 'Only http(s) URLs are allowed.' );
		}
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';
		$tmp = download_url( $url, 60 );
		if ( is_wp_error( $tmp ) ) {
			return $tmp;
		}
		$name = basename( wp_parse_url( $url, PHP_URL_PATH ) ?: 'file' );
		$id   = media_handle_sideload( array( 'name' => $name, 'tmp_name' => $tmp ), 0, ! empty( $in['title'] ) ? (string) $in['title'] : null );
		if ( is_wp_error( $id ) ) {
			@unlink( $tmp ); // phpcs:ignore
			return $id;
		}
		self::update( array( 'id' => $id, 'alt' => $in['alt'] ?? null, 'caption' => $in['caption'] ?? null ) );
		return self::row( $id );
	}

	public static function update( $in ) {
		$id = (int) ( $in['id'] ?? 0 );
		if ( 'attachment' !== get_post_type( $id ) || ! current_user_can( 'edit_post', $id ) ) {
			return new WP_Error( 'cwai_nf', 'Media item not found or not editable.' );
		}
		$post = array( 'ID' => $id );
		foreach ( array( 'title' => 'post_title', 'caption' => 'post_excerpt', 'description' => 'post_content' ) as $k => $f ) {
			if ( isset( $in[ $k ] ) && null !== $in[ $k ] ) {
				$post[ $f ] = (string) $in[ $k ];
			}
		}
		if ( count( $post ) > 1 ) {
			wp_update_post( wp_slash( $post ) );
		}
		if ( isset( $in['alt'] ) && null !== $in['alt'] ) {
			update_post_meta( $id, '_wp_attachment_image_alt', sanitize_text_field( $in['alt'] ) );
		}
		return self::row( $id );
	}
}
