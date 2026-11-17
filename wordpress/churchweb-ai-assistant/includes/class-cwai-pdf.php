<?php
/**
 * Convert to PDF: Word, Excel, PowerPoint and OpenDocument files → PDF, from the Media Library, from a "Convert to PDF"
 * screen under the assistant's menu, and as an assistant tool ("turn this week's bulletin into a PDF and put it on the
 * Bulletins page"). The conversion itself runs on the ChurchWeb portal (LibreOffice behind it), authenticated with this
 * site's own AI key, so there is nothing new to configure. Files are converted in memory there and not kept.
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class CWAI_PDF {

	const TYPES     = array( 'doc', 'docx', 'dot', 'dotx', 'odt', 'rtf', 'txt', 'html', 'htm', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp', 'pages', 'wpd' );
	const MAX_BYTES = 26214400; // 25 MB, the portal's limit
	const CAP       = 'upload_files'; // the church's own Editor login and above

	public static function boot() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 20 );
		add_filter( 'media_row_actions', array( __CLASS__, 'row_action' ), 10, 2 );
		add_filter( 'bulk_actions-upload', array( __CLASS__, 'bulk_action' ) );
		add_filter( 'handle_bulk_actions-upload', array( __CLASS__, 'handle_bulk' ), 10, 3 );
		add_action( 'admin_post_cwai_pdf_convert', array( __CLASS__, 'handle_single' ) );
		add_action( 'admin_post_cwai_pdf_upload', array( __CLASS__, 'handle_upload' ) );
		add_action( 'admin_notices', array( __CLASS__, 'notices' ) );
		add_action( 'rest_api_init', array( __CLASS__, 'rest' ) );
	}

	/** The portal that does the converting. Override with CWAI_PORTAL_URL in wp-config.php (rebranded builds point it elsewhere). */
	public static function portal_url() {
		$u = defined( 'CWAI_PORTAL_URL' ) && CWAI_PORTAL_URL ? CWAI_PORTAL_URL : apply_filters( 'cwai_portal_url', 'https://portal.churchwebglobal.com' );
		return untrailingslashit( $u );
	}

	public static function convertible( $filename ) {
		return in_array( strtolower( pathinfo( (string) $filename, PATHINFO_EXTENSION ) ), self::TYPES, true );
	}

	/* ---------- the conversion ---------- */

	/** One file → PDF bytes. Returns array( 'pdf' => bytes, 'name' => 'x.pdf' ) or WP_Error. */
	public static function convert_file( $path, $filename = '' ) {
		$filename = $filename ?: basename( $path );
		$key      = CWAI_Settings::api_key();
		if ( ! $key ) {
			return new WP_Error( 'cwai_pdf_no_key', __( 'This site is not connected to ChurchWeb (no AI key), so files cannot be converted. Contact support.', 'cwai' ) );
		}
		if ( ! self::convertible( $filename ) ) {
			/* translators: %s: file name */
			return new WP_Error( 'cwai_pdf_type', sprintf( __( '"%s" is not a type that can be converted (Word, Excel, PowerPoint, OpenDocument).', 'cwai' ), $filename ) );
		}
		if ( ! is_readable( $path ) ) {
			return new WP_Error( 'cwai_pdf_read', __( 'The file could not be read.', 'cwai' ) );
		}
		if ( filesize( $path ) > self::MAX_BYTES ) {
			return new WP_Error( 'cwai_pdf_size', __( 'The file is over 25 MB.', 'cwai' ) );
		}
		$boundary = wp_generate_password( 24, false );
		$body     = "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" . str_replace( '"', '', $filename ) . "\"\r\nContent-Type: application/octet-stream\r\n\r\n" . file_get_contents( $path ) . "\r\n--$boundary--\r\n";
		$r        = wp_remote_post( self::portal_url() . '/api/v1/convert/pdf', array(
			'timeout' => 120,
			'headers' => array( 'Authorization' => 'Bearer ' . $key, 'Content-Type' => 'multipart/form-data; boundary=' . $boundary ),
			'body'    => $body,
		) );
		if ( is_wp_error( $r ) ) {
			return new WP_Error( 'cwai_pdf_http', __( 'Could not reach the ChurchWeb converter: ', 'cwai' ) . $r->get_error_message() );
		}
		$code = wp_remote_retrieve_response_code( $r );
		$data = wp_remote_retrieve_body( $r );
		if ( 200 !== $code ) {
			$j = json_decode( $data, true );
			/* translators: %d: HTTP status */
			return new WP_Error( 'cwai_pdf_remote', isset( $j['error'] ) ? $j['error'] : sprintf( __( 'The converter answered %d.', 'cwai' ), $code ) );
		}
		if ( false === strpos( (string) wp_remote_retrieve_header( $r, 'content-type' ), 'application/pdf' ) || '%PDF' !== substr( $data, 0, 4 ) ) {
			return new WP_Error( 'cwai_pdf_notpdf', __( 'The converter did not return a PDF.', 'cwai' ) );
		}
		return array( 'pdf' => $data, 'name' => preg_replace( '/\.[^.]+$/', '', $filename ) . '.pdf' );
	}

	/** Convert a Media Library item and add the PDF beside it. Returns the PDF's attachment ID or WP_Error. Converting the same unchanged file twice returns the earlier PDF. */
	public static function convert_attachment( $attachment_id ) {
		$attachment_id = (int) $attachment_id;
		$path          = get_attached_file( $attachment_id );
		if ( ! $path || ! file_exists( $path ) ) {
			return new WP_Error( 'cwai_pdf_missing', __( 'That file is not in the Media Library.', 'cwai' ) );
		}
		$existing = (int) get_post_meta( $attachment_id, '_cwai_pdf_id', true );
		if ( $existing && get_post( $existing ) && (int) get_post_meta( $existing, '_cwai_pdf_source_mtime', true ) === (int) filemtime( $path ) ) {
			return $existing;
		}
		$out = self::convert_file( $path, basename( $path ) );
		if ( is_wp_error( $out ) ) {
			return $out;
		}
		return self::save_pdf( $out['pdf'], $out['name'], $attachment_id, (int) get_post_field( 'post_parent', $attachment_id ) );
	}

	public static function save_pdf( $bytes, $name, $source_id = 0, $parent = 0 ) {
		$up = wp_upload_bits( sanitize_file_name( $name ), null, $bytes );
		if ( ! empty( $up['error'] ) ) {
			return new WP_Error( 'cwai_pdf_save', $up['error'] );
		}
		$id = wp_insert_attachment( array(
			'post_mime_type' => 'application/pdf',
			'post_title'     => preg_replace( '/\.pdf$/i', '', $name ),
			'post_status'    => 'inherit',
			'post_parent'    => (int) $parent,
		), $up['file'], (int) $parent, true );
		if ( is_wp_error( $id ) ) {
			return $id;
		}
		require_once ABSPATH . 'wp-admin/includes/image.php';
		wp_update_attachment_metadata( $id, wp_generate_attachment_metadata( $id, $up['file'] ) );
		if ( $source_id ) {
			update_post_meta( $source_id, '_cwai_pdf_id', $id );
			update_post_meta( $id, '_cwai_pdf_source_id', $source_id );
			update_post_meta( $id, '_cwai_pdf_source_mtime', (int) filemtime( get_attached_file( $source_id ) ) );
		}
		return $id;
	}

	/* ---------- assistant tool ---------- */

	public static function register() {
		$p = array( 'CWAI_Tools_Content', 'p' );
		$s = array( 'CWAI_Tools_Content', 'schema' );
		CWAI_Registry::add( 'cwai/convert-to-pdf', array(
			'label'       => 'Convert a document to PDF',
			'description' => 'Convert a Word, Excel, PowerPoint or OpenDocument file already in the media library into a PDF (added to the media library beside it). Use search-media first to find the file\'s id. Typical use: a bulletin, newsletter or form the church uploaded as .docx that should be linked from a page as a PDF. Returns the new PDF\'s id and url.',
			'input'       => call_user_func( $s, array(
				'id' => call_user_func( $p, 'integer', 'Media ID of the Word/Excel/PowerPoint/OpenDocument file.' ),
			), array( 'id' ) ),
			'callback'    => array( __CLASS__, 'tool' ),
			'capability'  => self::CAP,
		) );
	}

	public static function tool( $in ) {
		$r = self::convert_attachment( (int) ( $in['id'] ?? 0 ) );
		if ( is_wp_error( $r ) ) {
			return $r;
		}
		return array( 'id' => $r, 'url' => wp_get_attachment_url( $r ), 'title' => get_the_title( $r ), 'source_id' => (int) ( $in['id'] ?? 0 ) );
	}

	/* ---------- Media Library ---------- */

	public static function row_action( $actions, $post ) {
		$file = get_attached_file( $post->ID );
		if ( $file && current_user_can( self::CAP ) && self::convertible( $file ) ) {
			$url = wp_nonce_url( admin_url( 'admin-post.php?action=cwai_pdf_convert&id=' . (int) $post->ID ), 'cwai_pdf_' . (int) $post->ID );
			$actions['cwai_pdf'] = '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Convert to PDF', 'cwai' ) . '</a>';
		}
		return $actions;
	}

	public static function bulk_action( $actions ) {
		if ( current_user_can( self::CAP ) ) {
			$actions['cwai_pdf_bulk'] = __( 'Convert to PDF', 'cwai' );
		}
		return $actions;
	}

	public static function handle_bulk( $redirect, $action, $ids ) {
		if ( 'cwai_pdf_bulk' !== $action || ! current_user_can( self::CAP ) ) {
			return $redirect;
		}
		$ok = 0;
		$errors = array();
		foreach ( (array) $ids as $id ) {
			$r = self::convert_attachment( (int) $id );
			if ( is_wp_error( $r ) ) {
				$errors[] = basename( (string) get_attached_file( $id ) ) . ': ' . $r->get_error_message();
			} else {
				$ok++;
			}
		}
		return add_query_arg( array( 'cwai_pdf_ok' => $ok, 'cwai_pdf_err' => rawurlencode( implode( ' | ', array_slice( $errors, 0, 5 ) ) ) ), $redirect );
	}

	public static function handle_single() {
		$id = (int) ( $_GET['id'] ?? 0 );
		if ( ! current_user_can( self::CAP ) || ! wp_verify_nonce( (string) ( $_GET['_wpnonce'] ?? '' ), 'cwai_pdf_' . $id ) ) {
			wp_die( esc_html__( 'Not allowed.', 'cwai' ) );
		}
		$r    = self::convert_attachment( $id );
		$back = wp_get_referer() ?: admin_url( 'upload.php' );
		wp_safe_redirect( is_wp_error( $r )
			? add_query_arg( array( 'cwai_pdf_ok' => 0, 'cwai_pdf_err' => rawurlencode( $r->get_error_message() ) ), $back )
			: add_query_arg( array( 'cwai_pdf_ok' => 1, 'cwai_pdf_new' => (int) $r ), $back ) );
		exit;
	}

	/* ---------- Convert to PDF screen ---------- */

	public static function menu() {
		add_submenu_page( 'cwai-chat', __( 'Convert to PDF', 'cwai' ), __( 'Convert to PDF', 'cwai' ), self::CAP, 'cwai-pdf', array( __CLASS__, 'page' ) );
	}

	public static function page() {
		$connected = (bool) CWAI_Settings::api_key();
		echo '<div class="wrap"><h1>' . esc_html__( 'Convert to PDF', 'cwai' ) . '</h1>';
		if ( ! $connected ) {
			echo '<div class="notice notice-error"><p>' . esc_html__( 'This site is not connected to ChurchWeb yet, so conversion is unavailable.', 'cwai' ) . '</p></div>';
		}
		echo '<p>' . esc_html__( 'Upload a Word, Excel, PowerPoint or OpenDocument file. The PDF lands in your Media Library, ready to link from a page (bulletins, newsletters, forms). Files up to 25 MB.', 'cwai' ) . '</p>';
		echo '<form method="post" enctype="multipart/form-data" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'cwai_pdf_upload' );
		echo '<input type="hidden" name="action" value="cwai_pdf_upload">';
		echo '<p><input type="file" name="files[]" multiple accept=".' . esc_attr( implode( ',.', self::TYPES ) ) . '" required' . ( $connected ? '' : ' disabled' ) . '></p>';
		echo '<p><label><input type="checkbox" name="keep" value="1" checked> ' . esc_html__( 'Also keep the original file in the Media Library', 'cwai' ) . '</label></p>';
		submit_button( __( 'Convert', 'cwai' ), 'primary', 'submit', true, $connected ? array() : array( 'disabled' => 'disabled' ) );
		echo '</form><p class="description">' . esc_html__( 'You can also tick files in the Media Library and choose "Convert to PDF" from Bulk actions, hover a file and click "Convert to PDF", or just ask the assistant.', 'cwai' ) . '</p></div>';
	}

	public static function handle_upload() {
		if ( ! current_user_can( self::CAP ) || ! check_admin_referer( 'cwai_pdf_upload' ) ) {
			wp_die( esc_html__( 'Not allowed.', 'cwai' ) );
		}
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';
		$keep   = ! empty( $_POST['keep'] );
		$ok     = 0;
		$last   = 0;
		$errors = array();
		$files  = isset( $_FILES['files'] ) ? $_FILES['files'] : null; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		$n      = $files ? count( (array) $files['name'] ) : 0;
		for ( $i = 0; $i < $n && $i < 10; $i++ ) {
			$name = sanitize_file_name( (string) $files['name'][ $i ] );
			$tmp  = (string) $files['tmp_name'][ $i ];
			if ( ! is_uploaded_file( $tmp ) ) {
				$errors[] = "$name: upload failed";
				continue;
			}
			if ( $keep ) {
				$aid = media_handle_sideload( array( 'name' => $name, 'tmp_name' => $tmp ), 0 );
				$r   = is_wp_error( $aid ) ? $aid : self::convert_attachment( (int) $aid );
			} else {
				$out = self::convert_file( $tmp, $name );
				$r   = is_wp_error( $out ) ? $out : self::save_pdf( $out['pdf'], $out['name'] );
			}
			if ( is_wp_error( $r ) ) {
				$errors[] = "$name: " . $r->get_error_message();
			} else {
				$ok++;
				$last = (int) $r;
			}
		}
		wp_safe_redirect( add_query_arg( array( 'cwai_pdf_ok' => $ok, 'cwai_pdf_err' => rawurlencode( implode( ' | ', array_slice( $errors, 0, 5 ) ) ), 'cwai_pdf_new' => 1 === $ok ? $last : 0 ), admin_url( 'upload.php' ) ) );
		exit;
	}

	public static function notices() {
		if ( ! isset( $_GET['cwai_pdf_ok'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification
			return;
		}
		$ok  = (int) $_GET['cwai_pdf_ok'];
		$err = isset( $_GET['cwai_pdf_err'] ) ? sanitize_text_field( rawurldecode( (string) $_GET['cwai_pdf_err'] ) ) : '';
		$new = (int) ( $_GET['cwai_pdf_new'] ?? 0 );
		if ( $ok ) {
			/* translators: %d: number of PDFs */
			echo '<div class="notice notice-success is-dismissible"><p>' . esc_html( 1 === $ok ? __( 'PDF created', 'cwai' ) : sprintf( __( '%d PDFs created', 'cwai' ), $ok ) )
				. ( $new ? ' — <a href="' . esc_url( get_edit_post_link( $new ) ) . '">' . esc_html__( 'open it', 'cwai' ) . '</a> · <a href="' . esc_url( wp_get_attachment_url( $new ) ) . '" target="_blank" rel="noopener">' . esc_html__( 'view', 'cwai' ) . '</a>' : '' ) . '</p></div>';
		}
		if ( $err ) {
			echo '<div class="notice notice-error is-dismissible"><p>' . esc_html( $err ) . '</p></div>';
		}
	}

	/* ---------- REST (chat panel, staff view, scripts) ---------- */

	public static function rest() {
		register_rest_route( 'cwai/v1', '/pdf/(?P<id>\d+)', array(
			'methods'             => 'POST',
			'permission_callback' => function () { return current_user_can( self::CAP ); },
			'callback'            => function ( $req ) {
				$r = self::convert_attachment( (int) $req['id'] );
				if ( is_wp_error( $r ) ) {
					return new WP_REST_Response( array( 'error' => $r->get_error_message() ), 400 );
				}
				return array( 'id' => $r, 'url' => wp_get_attachment_url( $r ), 'title' => get_the_title( $r ) );
			},
		) );
	}
}
