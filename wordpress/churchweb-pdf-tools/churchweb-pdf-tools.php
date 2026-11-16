<?php
/**
 * Plugin Name: ChurchWeb PDF Tools
 * Description: Convert Word, Excel, PowerPoint and OpenDocument files to PDF from the Media Library or the ChurchWeb menu. Conversion runs on ChurchWeb's servers using this site's existing AI Assistant key; nothing is stored there.
 * Version: 1.0.0
 * Author: ChurchWeb Global
 * Requires PHP: 7.4
 *
 * Works on its own or inside the ChurchWeb AI Assistant plugin: include this file from the assistant and it registers the same
 * screens. It needs two constants the assistant already defines in wp-config.php: CWAI_API_KEY (the site's gateway token) and,
 * optionally, CWAI_PORTAL_URL (defaults to https://portal.churchwebglobal.com).
 */
if (!defined('ABSPATH')) exit;
if (defined('CWPDF_LOADED')) return;
define('CWPDF_LOADED', true);

final class ChurchWeb_PDF_Tools {
	const TYPES = ['doc', 'docx', 'dot', 'dotx', 'odt', 'rtf', 'txt', 'html', 'htm', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp', 'pages', 'wpd'];
	const MAX_BYTES = 26214400; // 25 MB, same as the portal
	const CAP = 'upload_files'; // Editors (the church's own login) and above

	public static function boot() {
		add_action('admin_menu', [__CLASS__, 'menu'], 30);
		add_filter('media_row_actions', [__CLASS__, 'row_action'], 10, 2);
		add_filter('bulk_actions-upload', [__CLASS__, 'bulk_action']);
		add_filter('handle_bulk_actions-upload', [__CLASS__, 'handle_bulk'], 10, 3);
		add_action('admin_post_cwpdf_convert', [__CLASS__, 'handle_single']);
		add_action('admin_post_cwpdf_upload', [__CLASS__, 'handle_upload']);
		add_action('admin_notices', [__CLASS__, 'notices']);
		add_action('rest_api_init', [__CLASS__, 'rest']);
		// Lets the in-site AI Assistant (and WP-CLI) convert by attachment ID: do_action('churchweb_convert_to_pdf', $attachment_id) or apply_filters('churchweb_pdf_from_attachment', null, $id)
		add_filter('churchweb_pdf_from_attachment', function ($r, $id) { return self::convert_attachment((int) $id); }, 10, 2);
	}

	/* ---------- where the conversion happens ---------- */

	public static function portal_url() { return rtrim(defined('CWAI_PORTAL_URL') && CWAI_PORTAL_URL ? CWAI_PORTAL_URL : 'https://portal.churchwebglobal.com', '/'); }
	public static function token() { return defined('CWAI_API_KEY') ? (string) CWAI_API_KEY : ''; }
	public static function convertible($filename) { return in_array(strtolower(pathinfo($filename, PATHINFO_EXTENSION)), self::TYPES, true); }

	/** Send one file to the portal; returns ['pdf' => bytes, 'name' => 'x.pdf'] or WP_Error. */
	public static function convert_file($path, $filename = '') {
		$filename = $filename ?: basename($path);
		if (!self::token()) return new WP_Error('cwpdf_no_key', 'This site is not connected to ChurchWeb (no AI Assistant key). Ask support@churchwebglobal.com.');
		if (!self::convertible($filename)) return new WP_Error('cwpdf_type', sprintf('"%s" is not a type that can be converted (Word, Excel, PowerPoint, OpenDocument).', $filename));
		if (!is_readable($path)) return new WP_Error('cwpdf_read', 'The file could not be read.');
		if (filesize($path) > self::MAX_BYTES) return new WP_Error('cwpdf_size', 'The file is over 25 MB.');
		$boundary = wp_generate_password(24, false);
		$body = "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" . str_replace('"', '', $filename) . "\"\r\nContent-Type: application/octet-stream\r\n\r\n" . file_get_contents($path) . "\r\n--$boundary--\r\n";
		$r = wp_remote_post(self::portal_url() . '/api/v1/convert/pdf', ['timeout' => 120, 'headers' => ['Authorization' => 'Bearer ' . self::token(), 'Content-Type' => 'multipart/form-data; boundary=' . $boundary], 'body' => $body]);
		if (is_wp_error($r)) return new WP_Error('cwpdf_http', 'Could not reach the ChurchWeb converter: ' . $r->get_error_message());
		$code = wp_remote_retrieve_response_code($r); $data = wp_remote_retrieve_body($r);
		if ($code !== 200) { $j = json_decode($data, true); return new WP_Error('cwpdf_remote', isset($j['error']) ? $j['error'] : "The converter answered $code."); }
		if (strpos(wp_remote_retrieve_header($r, 'content-type'), 'application/pdf') === false || substr($data, 0, 4) !== '%PDF') return new WP_Error('cwpdf_notpdf', 'The converter did not return a PDF.');
		return ['pdf' => $data, 'name' => preg_replace('/\.[^.]+$/', '', $filename) . '.pdf'];
	}

	/** Convert a Media Library attachment and add the PDF beside it. Returns the new attachment ID or WP_Error. */
	public static function convert_attachment($attachment_id) {
		$path = get_attached_file($attachment_id);
		if (!$path) return new WP_Error('cwpdf_missing', 'That file is not in the Media Library.');
		$existing = (int) get_post_meta($attachment_id, '_cwpdf_pdf_id', true);
		if ($existing && get_post($existing) && (int) get_post_meta($existing, '_cwpdf_source_mtime', true) === (int) filemtime($path)) return $existing; // already converted this exact file
		$out = self::convert_file($path, basename($path));
		if (is_wp_error($out)) return $out;
		return self::save_pdf($out['pdf'], $out['name'], $attachment_id, get_post_field('post_parent', $attachment_id));
	}

	public static function save_pdf($bytes, $name, $source_id = 0, $parent = 0) {
		$up = wp_upload_bits(sanitize_file_name($name), null, $bytes);
		if (!empty($up['error'])) return new WP_Error('cwpdf_save', $up['error']);
		$id = wp_insert_attachment(['post_mime_type' => 'application/pdf', 'post_title' => preg_replace('/\.pdf$/i', '', $name), 'post_status' => 'inherit', 'post_parent' => (int) $parent], $up['file'], (int) $parent);
		if (is_wp_error($id)) return $id;
		require_once ABSPATH . 'wp-admin/includes/image.php';
		wp_update_attachment_metadata($id, wp_generate_attachment_metadata($id, $up['file']));
		if ($source_id) { update_post_meta($source_id, '_cwpdf_pdf_id', $id); update_post_meta($id, '_cwpdf_source_id', $source_id); update_post_meta($id, '_cwpdf_source_mtime', (int) filemtime(get_attached_file($source_id))); }
		return $id;
	}

	/* ---------- Media Library: row action + bulk action ---------- */

	public static function row_action($actions, $post) {
		if (current_user_can(self::CAP) && self::convertible($post->post_title . '.' . pathinfo(get_attached_file($post->ID), PATHINFO_EXTENSION))) {
			$url = wp_nonce_url(admin_url('admin-post.php?action=cwpdf_convert&id=' . $post->ID), 'cwpdf_' . $post->ID);
			$actions['cwpdf'] = '<a href="' . esc_url($url) . '">Convert to PDF</a>';
		}
		return $actions;
	}
	public static function bulk_action($actions) { if (current_user_can(self::CAP)) $actions['cwpdf_bulk'] = 'Convert to PDF'; return $actions; }
	public static function handle_bulk($redirect, $action, $ids) {
		if ($action !== 'cwpdf_bulk' || !current_user_can(self::CAP)) return $redirect;
		$ok = 0; $errors = [];
		foreach ($ids as $id) { $r = self::convert_attachment((int) $id); if (is_wp_error($r)) $errors[] = basename((string) get_attached_file($id)) . ': ' . $r->get_error_message(); else $ok++; }
		return add_query_arg(['cwpdf_ok' => $ok, 'cwpdf_err' => rawurlencode(implode(' | ', array_slice($errors, 0, 5)))], $redirect);
	}
	public static function handle_single() {
		$id = (int) ($_GET['id'] ?? 0);
		if (!current_user_can(self::CAP) || !wp_verify_nonce($_GET['_wpnonce'] ?? '', 'cwpdf_' . $id)) wp_die('Not allowed.');
		$r = self::convert_attachment($id);
		$back = wp_get_referer() ?: admin_url('upload.php');
		wp_safe_redirect(is_wp_error($r) ? add_query_arg(['cwpdf_ok' => 0, 'cwpdf_err' => rawurlencode($r->get_error_message())], $back) : add_query_arg(['cwpdf_ok' => 1, 'cwpdf_new' => (int) $r], $back));
		exit;
	}

	/* ---------- ChurchWeb menu: upload and convert in one go ---------- */

	public static function menu() {
		$parent = menu_page_url('churchweb-assistant', false) ? 'churchweb-assistant' : 'upload.php';
		add_submenu_page($parent, 'Convert to PDF', 'Convert to PDF', self::CAP, 'cwpdf', [__CLASS__, 'page']);
	}
	public static function page() {
		$connected = (bool) self::token();
		echo '<div class="wrap"><h1>Convert to PDF</h1>';
		if (!$connected) echo '<div class="notice notice-error"><p>This site is not connected to ChurchWeb yet, so conversion is unavailable. Email support@churchwebglobal.com.</p></div>';
		echo '<p>Upload a Word, Excel, PowerPoint or OpenDocument file. The PDF lands in your Media Library, ready to link from a page (bulletins, newsletters, forms). Files up to 25 MB. The original is kept too unless you untick it.</p>';
		echo '<form method="post" enctype="multipart/form-data" action="' . esc_url(admin_url('admin-post.php')) . '">';
		wp_nonce_field('cwpdf_upload'); echo '<input type="hidden" name="action" value="cwpdf_upload">';
		echo '<p><input type="file" name="files[]" multiple accept=".' . implode(',.', self::TYPES) . '" required ' . ($connected ? '' : 'disabled') . '></p>';
		echo '<p><label><input type="checkbox" name="keep" value="1" checked> Also keep the original file in the Media Library</label></p>';
		submit_button('Convert', 'primary', 'submit', true, $connected ? [] : ['disabled' => 'disabled']);
		echo '</form><p class="description">You can also tick files in the Media Library and choose <em>Convert to PDF</em> from Bulk actions, or hover a file and click <em>Convert to PDF</em>.</p></div>';
	}
	public static function handle_upload() {
		if (!current_user_can(self::CAP) || !check_admin_referer('cwpdf_upload')) wp_die('Not allowed.');
		require_once ABSPATH . 'wp-admin/includes/file.php'; require_once ABSPATH . 'wp-admin/includes/media.php'; require_once ABSPATH . 'wp-admin/includes/image.php';
		$keep = !empty($_POST['keep']); $ok = 0; $errors = []; $last = 0;
		$files = $_FILES['files'] ?? null;
		$n = $files ? count((array) $files['name']) : 0;
		for ($i = 0; $i < $n && $i < 10; $i++) {
			$name = (string) $files['name'][$i]; $tmp = (string) $files['tmp_name'][$i];
			if (!is_uploaded_file($tmp)) { $errors[] = "$name: upload failed"; continue; }
			if ($keep) {
				$aid = media_handle_sideload(['name' => $name, 'tmp_name' => $tmp], 0);
				$r = is_wp_error($aid) ? $aid : self::convert_attachment((int) $aid);
			} else {
				$out = self::convert_file($tmp, $name);
				$r = is_wp_error($out) ? $out : self::save_pdf($out['pdf'], $out['name']);
			}
			if (is_wp_error($r)) $errors[] = "$name: " . $r->get_error_message(); else { $ok++; $last = (int) $r; }
		}
		wp_safe_redirect(add_query_arg(['cwpdf_ok' => $ok, 'cwpdf_err' => rawurlencode(implode(' | ', array_slice($errors, 0, 5))), 'cwpdf_new' => $ok === 1 ? $last : 0], admin_url('upload.php')));
		exit;
	}
	public static function notices() {
		if (!isset($_GET['cwpdf_ok'])) return;
		$ok = (int) $_GET['cwpdf_ok']; $err = isset($_GET['cwpdf_err']) ? sanitize_text_field(rawurldecode($_GET['cwpdf_err'])) : ''; $new = (int) ($_GET['cwpdf_new'] ?? 0);
		if ($ok) echo '<div class="notice notice-success is-dismissible"><p>' . esc_html($ok === 1 ? 'PDF created' : "$ok PDFs created") . ($new ? ' — <a href="' . esc_url(get_edit_post_link($new)) . '">open it</a> · <a href="' . esc_url(wp_get_attachment_url($new)) . '" target="_blank">view</a>' : '') . '</p></div>';
		if ($err) echo '<div class="notice notice-error is-dismissible"><p>' . esc_html($err) . '</p></div>';
	}

	/* ---------- REST, for the AI Assistant's chat panel and other in-site tooling ---------- */

	public static function rest() {
		register_rest_route('churchweb/v1', '/convert/(?P<id>\d+)', ['methods' => 'POST', 'permission_callback' => function () { return current_user_can(self::CAP); }, 'callback' => function ($req) {
			$r = self::convert_attachment((int) $req['id']);
			if (is_wp_error($r)) return new WP_REST_Response(['error' => $r->get_error_message()], 400);
			return ['id' => $r, 'url' => wp_get_attachment_url($r), 'title' => get_the_title($r)];
		}]);
	}
}
ChurchWeb_PDF_Tools::boot();
