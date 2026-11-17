<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * New Website wizard: collects the facts, design, images and page list for a brand-new site, then hands the whole
 * brief to the assistant, which builds it page by page with progress saved.
 */
final class CWAI_Wizard {

	const OPT = 'cwai_wizard';

	public static function boot() {
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 19 );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
	}

	/* ------------------------------------------------------------------ */
	/* Presets                                                             */
	/* ------------------------------------------------------------------ */

	public static function types() {
		return array(
			'church'   => array( 'label' => 'Church', 'name' => 'Church name', 'kind' => 'Denomination or tradition (optional)', 'times' => 'Service times', 'about' => 'Tell us about your church: its story, values and who you serve' ),
			'org'      => array( 'label' => 'Ministry or non-profit', 'name' => 'Organization name', 'kind' => 'What the organization does (one line)', 'times' => 'Opening hours or meeting times', 'about' => 'Tell us about your mission, programs and who you serve' ),
			'business' => array( 'label' => 'Business', 'name' => 'Business name', 'kind' => 'Industry or what you sell (one line)', 'times' => 'Opening hours', 'about' => 'Tell us about your business: what you do, who you serve and what makes you different' ),
		);
	}

	/** key => [label, description, default-on types] */
	public static function pages() {
		$c = array( 'church', 'org', 'business' );
		return array(
			'home'         => array( 'Home', 'The front page: welcome, key times, and ways to connect.', $c, true ),
			'about'        => array( 'About us', 'Who we are, our story and values.', $c, false ),
			'worship'      => array( 'Worship and service times', 'When and where we gather and what to expect.', array( 'church' ), false ),
			'visit'        => array( 'Plan your visit', 'Directions, parking, what to expect, accessibility.', array( 'church' ), false ),
			'beliefs'      => array( 'What we believe', 'Beliefs, denomination, statement of faith.', array(), false ),
			'ministries'   => array( 'Ministries and groups', 'An overview of ministries, groups and programs.', array( 'church' ), false ),
			'children'     => array( 'Children and youth', 'Sunday school, youth group and family programs.', array(), false ),
			'music'        => array( 'Music and arts', 'Choir, band, organ and special music.', array(), false ),
			'outreach'     => array( 'Outreach and mission', 'Community service, missions and social action.', array(), false ),
			'sermons'      => array( 'Sermons and media', 'Sermon archive with audio/video and series.', array( 'church' ), false ),
			'events'       => array( 'Events and calendar', 'Upcoming events and regular gatherings.', array( 'church', 'org' ), false ),
			'give'         => array( 'Give', 'Ways to give or donate, with a clear call to action.', array( 'church', 'org' ), false ),
			'team'         => array( 'Our team and leadership', 'Clergy, staff and leaders with short bios.', array( 'church', 'org', 'business' ), false ),
			'news'         => array( 'News and blog', 'Posts and announcements.', array(), false ),
			'programs'     => array( 'Programs', 'What the organization offers.', array( 'org' ), false ),
			'involved'     => array( 'Get involved', 'Volunteer, partner and join.', array( 'org' ), false ),
			'services'     => array( 'Services', 'What the business offers, with benefits for each.', array( 'business' ), false ),
			'testimonials' => array( 'Testimonials', 'Customer quotes (only real ones supplied by you).', array(), false ),
			'gallery'      => array( 'Photo gallery', 'A gallery of the images you upload.', array(), false ),
			'faq'          => array( 'FAQ', 'Common questions and answers.', array( 'business' ), false ),
			'contact'      => array( 'Contact', 'Address, phone, email, map and a contact form.', $c, false ),
			'privacy'      => array( 'Privacy policy', 'A plain-language privacy policy page.', array(), false ),
		);
	}

	public static function roles() {
		return array( 'logo' => 'Logo', 'hero' => 'Top banner (wide photo)', 'building' => 'Building or place', 'people' => 'People or community', 'activity' => 'Activity or ministry', 'other' => 'Other' );
	}

	public static function defaults() {
		return array(
			'type' => 'church', 'name' => '', 'tagline' => '', 'kind' => '', 'about' => '', 'tone' => 'warm',
			'address' => '', 'city' => '', 'phone' => '', 'email' => '', 'times' => '', 'extra' => '',
			'social' => array( 'facebook' => '', 'instagram' => '', 'youtube' => '', 'x' => '' ),
			'design' => array( 'id' => '', 'primary' => '', 'accent' => '' ),
			'images' => array(), 'image_stock' => true, 'image_ai' => false, 'pages' => array(), 'custom_pages' => array(),
			'started' => false, 'started_at' => 0, 'progress' => array(), 'step' => 1,
		);
	}

	/* ------------------------------------------------------------------ */
	/* Data                                                                */
	/* ------------------------------------------------------------------ */

	public static function get() {
		$d = get_option( self::OPT );
		return is_array( $d ) ? array_replace_recursive( self::defaults(), $d ) : self::defaults();
	}

	private static function txt( $v, $max = 200 ) {
		return mb_substr( sanitize_text_field( (string) $v ), 0, $max );
	}

	private static function area( $v, $max = 4000 ) {
		return mb_substr( sanitize_textarea_field( (string) $v ), 0, $max );
	}

	private static function url( $v ) {
		$v = trim( (string) $v );
		if ( '' === $v ) {
			return '';
		}
		if ( preg_match( '#^([a-z][a-z0-9+.-]*):(?!\d)#i', $v, $m ) && ! in_array( strtolower( $m[1] ), array( 'http', 'https' ), true ) ) {
			return ''; // javascript:, data:, mailto: and friends are not social links.
		}
		if ( ! preg_match( '#^https?://#i', $v ) ) {
			$v = 'https://' . $v;
		}
		return mb_substr( esc_url_raw( $v ), 0, 300 );
	}

	/** Validate and clean a payload from the browser. Keeps server-owned fields (started, progress). */
	public static function sanitize( array $in, array $cur ) {
		$d    = $cur;
		$type = (string) ( $in['type'] ?? $cur['type'] );
		$d['type']    = isset( self::types()[ $type ] ) ? $type : 'church';
		foreach ( array( 'name' => 120, 'tagline' => 160, 'kind' => 160, 'address' => 200, 'city' => 100, 'phone' => 40 ) as $k => $max ) {
			if ( isset( $in[ $k ] ) ) {
				$d[ $k ] = self::txt( $in[ $k ], $max );
			}
		}
		foreach ( array( 'about' => 4000, 'times' => 1500, 'extra' => 4000 ) as $k => $max ) {
			if ( isset( $in[ $k ] ) ) {
				$d[ $k ] = self::area( $in[ $k ], $max );
			}
		}
		if ( isset( $in['email'] ) ) {
			$d['email'] = is_email( (string) $in['email'] ) ? sanitize_email( $in['email'] ) : '';
		}
		if ( isset( $in['tone'] ) ) {
			$d['tone'] = in_array( $in['tone'], array( 'warm', 'formal', 'contemporary', 'plain' ), true ) ? $in['tone'] : 'warm';
		}
		if ( isset( $in['social'] ) && is_array( $in['social'] ) ) {
			foreach ( array( 'facebook', 'instagram', 'youtube', 'x' ) as $k ) {
				if ( isset( $in['social'][ $k ] ) ) {
					$d['social'][ $k ] = self::url( $in['social'][ $k ] );
				}
			}
		}
		if ( isset( $in['design'] ) && is_array( $in['design'] ) ) {
			$id = (string) ( $in['design']['id'] ?? '' );
			$d['design'] = array(
				'id'      => CWAI_Designs::get( $id ) ? $id : '',
				'primary' => CWAI_Designs::valid_hex( $in['design']['primary'] ?? '' ) ? strtoupper( $in['design']['primary'] ) : '',
				'accent'  => CWAI_Designs::valid_hex( $in['design']['accent'] ?? '' ) ? strtoupper( $in['design']['accent'] ) : '',
			);
		}
		if ( isset( $in['images'] ) && is_array( $in['images'] ) ) {
			$imgs = array();
			foreach ( array_slice( $in['images'], 0, 40 ) as $im ) {
				$id = (int) ( $im['id'] ?? 0 );
				if ( $id && 'attachment' === get_post_type( $id ) && wp_attachment_is_image( $id ) && current_user_can( 'edit_post', $id ) ) {
					$role   = (string) ( $im['role'] ?? 'other' );
					$imgs[] = array( 'id' => $id, 'role' => isset( self::roles()[ $role ] ) ? $role : 'other', 'note' => self::txt( $im['note'] ?? '', 200 ) );
				}
			}
			$d['images'] = $imgs;
		}
		foreach ( array( 'image_stock', 'image_ai' ) as $k ) {
			if ( array_key_exists( $k, $in ) ) {
				$d[ $k ] = ! empty( $in[ $k ] );
			}
		}
		if ( isset( $in['pages'] ) && is_array( $in['pages'] ) ) {
			$pg = array();
			foreach ( $in['pages'] as $p ) {
				$key = sanitize_key( $p['key'] ?? '' );
				if ( ! isset( self::pages()[ $key ] ) ) {
					continue;
				}
				$pg[] = array( 'key' => $key, 'label' => self::pages()[ $key ][0], 'include' => ! empty( $p['include'] ), 'notes' => self::txt( $p['notes'] ?? '', 400 ) );
			}
			$d['pages'] = $pg;
		}
		if ( isset( $in['custom_pages'] ) && is_array( $in['custom_pages'] ) ) {
			$cp = array();
			foreach ( array_slice( $in['custom_pages'], 0, 20 ) as $c ) {
				$t = self::txt( is_array( $c ) ? ( $c['label'] ?? '' ) : $c, 80 );
				if ( '' !== $t ) {
					$cp[] = array( 'label' => $t, 'notes' => self::txt( is_array( $c ) ? ( $c['notes'] ?? '' ) : '', 400 ) );
				}
			}
			$d['custom_pages'] = $cp;
		}
		if ( isset( $in['step'] ) ) {
			$d['step'] = max( 1, min( 5, (int) $in['step'] ) );
		}
		return $d;
	}

	/** Pages to build, in order, with a stable key each. */
	public static function page_list( array $d ) {
		$out = array();
		foreach ( $d['pages'] as $p ) {
			if ( ! empty( $p['include'] ) ) {
				$out[] = array( 'key' => $p['key'], 'label' => $p['label'], 'notes' => $p['notes'] ?? '' );
			}
		}
		foreach ( $d['custom_pages'] as $i => $c ) {
			$out[] = array( 'key' => 'custom-' . ( $i + 1 ), 'label' => $c['label'], 'notes' => $c['notes'] ?? '' );
		}
		return $out;
	}

	private static function profile_text( array $d ) {
		$t   = self::types()[ $d['type'] ];
		$out = array( $d['name'] . ' (' . strtolower( $t['label'] ) . ( $d['kind'] ? ', ' . $d['kind'] : '' ) . ')' );
		if ( $d['tagline'] ) {
			$out[] = 'Tagline: ' . $d['tagline'];
		}
		$addr = trim( $d['address'] . ( $d['city'] ? ', ' . $d['city'] : '' ), ', ' );
		if ( $addr ) {
			$out[] = 'Address: ' . $addr;
		}
		if ( $d['phone'] ) {
			$out[] = 'Phone: ' . $d['phone'];
		}
		if ( $d['email'] ) {
			$out[] = 'Email: ' . $d['email'];
		}
		if ( $d['times'] ) {
			$out[] = $t['times'] . ': ' . str_replace( "\n", '; ', $d['times'] );
		}
		$out[] = 'Tone of voice: ' . $d['tone'] . '.';
		return implode( "\n", $out );
	}

	/* ------------------------------------------------------------------ */
	/* REST                                                                */
	/* ------------------------------------------------------------------ */

	public static function routes() {
		$a = static function () {
			return current_user_can( 'manage_options' ) && CWAI_Plugin::can_use();
		};
		register_rest_route( CWAI_REST::NS, '/wizard', array(
			array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'rest_get' ), 'permission_callback' => $a ),
			array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'rest_save' ), 'permission_callback' => $a ),
		) );
		register_rest_route( CWAI_REST::NS, '/wizard/start', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'rest_start' ), 'permission_callback' => $a ) );
		register_rest_route( CWAI_REST::NS, '/wizard/reset', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'rest_reset' ), 'permission_callback' => $a ) );
	}

	private static function public_view( array $d ) {
		foreach ( $d['images'] as $i => $im ) {
			$d['images'][ $i ]['url']   = wp_get_attachment_image_url( $im['id'], 'medium' ) ?: wp_get_attachment_url( $im['id'] );
			$d['images'][ $i ]['title'] = get_the_title( $im['id'] );
		}
		return $d;
	}

	public static function rest_get() {
		return self::public_view( self::get() );
	}

	public static function rest_save( WP_REST_Request $r ) {
		$d = self::sanitize( (array) $r->get_json_params(), self::get() );
		update_option( self::OPT, $d, false );
		return self::public_view( $d );
	}

	public static function build_prompt( array $d ) {
		return 'Build my new website from the New Website wizard answers. First read them with the wizard tool, then apply the chosen design (styles, header, footer), set the logo, build the home page as a draft and show it to me before you build the other pages. Follow the page list, and tell me anything you could not do.';
	}

	public static function rest_start( WP_REST_Request $r ) {
		$d = self::sanitize( (array) $r->get_json_params(), self::get() );
		$problems = array();
		if ( '' === $d['name'] ) {
			$problems[] = 'Enter the name (step 1).';
		}
		if ( '' === $d['design']['id'] ) {
			$problems[] = 'Choose a design (step 2).';
		}
		if ( ! self::page_list( $d ) ) {
			$problems[] = 'Choose at least one page (step 4).';
		}
		if ( $problems ) {
			update_option( self::OPT, $d, false );
			return new WP_Error( 'cwai_wizard', implode( ' ', $problems ), array( 'status' => 400 ) );
		}
		CWAI_Designs::select( $d['design']['id'], $d['design']['primary'], $d['design']['accent'] );
		$d['started']    = true;
		$d['started_at'] = time();
		$d['progress']   = array();
		update_option( self::OPT, $d, false );

		// Give the assistant the basics in every future chat when no profile exists yet.
		$o = get_option( CWAI_Settings::OPT );
		$o = is_array( $o ) ? $o : array();
		$kept = false;
		if ( '' === trim( (string) ( $o['church_profile'] ?? '' ) ) ) {
			$o['church_profile'] = self::profile_text( $d );
			update_option( CWAI_Settings::OPT, $o );
		} else {
			$kept = true;
		}
		return array( 'ok' => true, 'prompt' => self::build_prompt( $d ), 'chat' => admin_url( 'admin.php?page=cwai-chat' ), 'profile_kept' => $kept );
	}

	public static function rest_reset() {
		delete_option( self::OPT );
		return self::public_view( self::defaults() );
	}

	/* ------------------------------------------------------------------ */
	/* Assistant tools + prompt                                            */
	/* ------------------------------------------------------------------ */

	public static function active() {
		$d = self::get();
		return ! empty( $d['started'] );
	}

	public static function register_tools() {
		$p = array( 'CWAI_Tools_Content', 'p' );
		$s = array( 'CWAI_Tools_Content', 'schema' );
		CWAI_Registry::add( 'cwai/wizard-get', array(
			'label' => 'Read the new-website brief', 'description' => 'The answers from the New Website wizard: organization details, tone, contact details, service times, the chosen design, uploaded images with their media IDs and roles (logo, banner, building, people...), and the list of pages to build with progress. Read this first when asked to build the new site.',
			'input' => call_user_func( $s, array() ), 'callback' => array( __CLASS__, 't_get' ), 'readonly' => true, 'capability' => 'edit_pages',
		) );
		CWAI_Registry::add( 'cwai/wizard-mark-page', array(
			'label' => 'Record a wizard page as built', 'description' => 'Record that a page from the wizard list has been built (built, with the new post_id), skipped, or needs review. Call after finishing each page so progress is kept and work can resume. Does not change the website.',
			'input' => call_user_func( $s, array(
				'key'     => call_user_func( $p, 'string', 'Page key from cwai__wizard-get (for example home, about, custom-1).' ),
				'status'  => call_user_func( $p, 'string', 'built, skipped, needs_review or pending.' ),
				'post_id' => call_user_func( $p, 'integer', 'The new WordPress page ID.' ),
				'note'    => call_user_func( $p, 'string', 'Short note.' ),
			), array( 'key', 'status' ) ),
			'callback' => array( __CLASS__, 't_mark' ), 'capability' => 'edit_pages', 'touches' => static function () {
				return array();
			},
		) );
	}

	public static function t_get() {
		$d = self::get();
		if ( '' === $d['name'] ) {
			return array( 'started' => false, 'message' => 'The New Website wizard has not been filled in yet. An administrator can complete it under AI Assistant → New website.' );
		}
		$imgs = array();
		foreach ( $d['images'] as $im ) {
			$meta   = wp_get_attachment_metadata( $im['id'] );
			$imgs[] = array( 'media_id' => $im['id'], 'role' => $im['role'], 'note' => $im['note'], 'url' => wp_get_attachment_url( $im['id'] ), 'width' => $meta['width'] ?? null, 'height' => $meta['height'] ?? null, 'title' => get_the_title( $im['id'] ) );
		}
		$pages = array();
		foreach ( self::page_list( $d ) as $pg ) {
			$pr      = $d['progress'][ $pg['key'] ] ?? array();
			$pages[] = $pg + array( 'what_it_covers' => self::pages()[ $pg['key'] ][1] ?? 'Custom page', 'status' => $pr['status'] ?? 'pending', 'post_id' => $pr['post_id'] ?? null );
		}
		$t = self::types()[ $d['type'] ];
		return array(
			'started'      => (bool) $d['started'],
			'type'         => $t['label'],
			'name'         => $d['name'],
			'tagline'      => $d['tagline'],
			'kind'         => $d['kind'],
			'tone'         => $d['tone'],
			'about'        => $d['about'],
			'address'      => $d['address'],
			'city'         => $d['city'],
			'phone'        => $d['phone'],
			'email'        => $d['email'],
			'times_label'  => $t['times'],
			'times'        => $d['times'],
			'social'       => array_filter( $d['social'] ),
			'extra_notes'  => $d['extra'],
			'design'       => $d['design'],
			'images'       => $imgs,
			'image_policy' => array( 'use_stock_photos_to_fill_gaps' => (bool) $d['image_stock'], 'use_ai_images_for_backgrounds' => (bool) $d['image_ai'], 'stock_ready' => CWAI_Images::status()['pexels'] || CWAI_Images::status()['pixabay'], 'ai_ready' => CWAI_Images::status()['ai_ready'] ),
			'pages'        => $pages,
		);
	}

	public static function t_mark( $in ) {
		$d    = self::get();
		$keys = wp_list_pluck( self::page_list( $d ), 'key' );
		$key  = sanitize_key( $in['key'] ?? '' );
		if ( ! in_array( $key, $keys, true ) ) {
			return new WP_Error( 'cwai_nf', 'That page is not in the wizard list. Use cwai__wizard-get to see the keys.' );
		}
		$st = (string) ( $in['status'] ?? '' );
		if ( ! in_array( $st, array( 'pending', 'built', 'skipped', 'needs_review' ), true ) ) {
			return new WP_Error( 'cwai_status', 'status must be built, skipped, needs_review or pending.' );
		}
		$d['progress'][ $key ] = array( 'status' => $st, 'post_id' => ! empty( $in['post_id'] ) ? (int) $in['post_id'] : ( $d['progress'][ $key ]['post_id'] ?? null ), 'note' => self::txt( $in['note'] ?? '', 300 ), 'time' => time() );
		update_option( self::OPT, $d, false );
		return array( 'key' => $key, 'status' => $st );
	}

	public static function prompt_section() {
		$d = self::get();
		if ( empty( $d['started'] ) ) {
			return '';
		}
		$left = 0;
		foreach ( self::page_list( $d ) as $pg ) {
			if ( ! in_array( $d['progress'][ $pg['key'] ]['status'] ?? 'pending', array( 'built', 'skipped' ), true ) ) {
				$left++;
			}
		}
		if ( ! $left ) {
			return '';
		}
		return '## New website build (from the wizard)
An administrator filled in the New Website wizard; ' . $left . ' page(s) are still to build. When asked to build the new site, or to continue, work like this:
- Read the brief with cwai__wizard-get, and the design with cwai__design-active. Use ONLY the facts in the brief (names, address, times, contact details, story). Never invent staff, testimonials, statistics, events, scripture quotes or addresses. If something needed is missing, write an obvious placeholder in square brackets (for example [Pastor name]) and tell the person.
- Write the page copy yourself in the requested tone: clear, original and specific to this organization, with a heading structure that suits the page. Keep it concise.
- First apply the design if it is not applied yet (styles, header, footer; set the logo from the image with role logo using cwai__update-site-identity; create the main menu from the page list). Then build the Home page as a DRAFT and show it to the person before building any other page.
- Missing pictures: use the uploaded images first. If a page needs one and none fits, follow image_policy in the brief: when use_stock_photos_to_fill_gaps is true (and stock_ready), add stock photos with cwai__stock-search and cwai__stock-import; when use_ai_images_for_backgrounds is true (and ai_ready), create abstract backgrounds, textures or simple illustrations with cwai__generate-image. If neither is allowed or set up, leave a clearly marked placeholder. At the end, list which images are stock or AI-generated so the person can replace them with real photos.
- Use the uploaded images by role: banner/hero images for page tops, building and activity photos in sections, people photos only where they obviously fit. Reuse media IDs from the brief; give every image alt text. Do not use images of identifiable people unless the person uploaded them for this purpose.
- Then build the remaining pages one at a time as drafts, in the same design. After each page call cwai__wizard-mark-page (built, with the new post_id) so progress is kept.
- Sermons: use the sermon tools (cwai__add-sermon) and a sermons archive page. Events and staff: use the matching content types when they exist.
- Set the Home page as the site front page (oxygen__set-home-page) when the person approves the home page.';
	}

	/* ------------------------------------------------------------------ */
	/* Admin page                                                          */
	/* ------------------------------------------------------------------ */

	public static function menu() {
		add_submenu_page( 'cwai-chat', __( 'New website', 'cwai' ), __( 'New website', 'cwai' ), 'manage_options', 'cwai-wizard', array( __CLASS__, 'render_page' ) );
	}

	public static function enqueue() {
		if ( ! isset( $_GET['page'] ) || 'cwai-wizard' !== $_GET['page'] ) { // phpcs:ignore
			return;
		}
		wp_enqueue_style( 'cwai-designs', CWAI_URL . 'assets/designs.css', array(), CWAI_VERSION );
		wp_enqueue_style( 'cwai-wizard', CWAI_URL . 'assets/wizard.css', array( 'cwai-designs' ), CWAI_VERSION );
		wp_enqueue_script( 'cwai-wizard', CWAI_URL . 'assets/wizard.js', array(), CWAI_VERSION, true );
		$pages = array();
		foreach ( self::pages() as $k => $p ) {
			$pages[] = array( 'key' => $k, 'label' => $p[0], 'desc' => $p[1], 'types' => $p[2], 'req' => $p[3] );
		}
		wp_localize_script( 'cwai-wizard', 'CWAI_W', array(
			'root'   => esc_url_raw( rest_url( CWAI_REST::NS ) ),
			'nonce'  => wp_create_nonce( 'wp_rest' ),
			'data'   => self::public_view( self::get() ),
			'types'  => self::types(),
			'pages'  => $pages,
			'roles'  => self::roles(),
			'images' => CWAI_Images::status(),
			'chat'   => admin_url( 'admin.php?page=cwai-chat' ),
		) );
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		echo '<div class="wrap" id="cwai-wizard"><h1>' . esc_html__( 'New website', 'cwai' ) . '</h1>';
		echo '<p class="description" style="max-width:760px">' . esc_html__( 'Answer a few questions, choose a design, upload your photos and pick your pages. The assistant then builds the site for you, one page at a time, and shows you the home page first.', 'cwai' ) . '</p>';
		echo '<ol class="cww-steps" id="cww-steps"></ol><div id="cww-body"></div>';
		// Design grid is rendered here (server side) and moved into step 2 by the script.
		echo '<div id="cww-design-src" hidden><div id="cwai-designs"><div class="cwd-tabs"><button type="button" class="button button-primary" data-fam="">' . esc_html__( 'All 25', 'cwai' ) . '</button>';
		foreach ( CWAI_Designs::families() as $k => $f ) {
			echo '<button type="button" class="button" data-fam="' . esc_attr( $k ) . '">' . esc_html( $f['name'] ) . '</button>';
		}
		echo '</div><div class="cwd-grid">';
		foreach ( CWAI_Designs::all() as $d ) {
			$r = CWAI_Designs::resolve( $d['id'] );
			$f = $r['family'];
			echo '<div class="cwd-item" data-fam="' . esc_attr( $d['family'] ) . '" data-id="' . esc_attr( $d['id'] ) . '" data-p="' . esc_attr( $r['tokens']['primary'] ) . '" data-a="' . esc_attr( $r['tokens']['accent'] ) . '">';
			echo CWAI_Designs::preview( $r ); // phpcs:ignore
			echo '<div class="cwd-meta"><h3>' . esc_html( $d['name'] ) . '</h3><span class="cwd-tag">' . esc_html( $f['name'] ) . '</span><p>' . esc_html( $d['summary'] ) . '</p>';
			echo '<div class="cwd-sw">';
			foreach ( array( $r['tokens']['primary'], $r['tokens']['accent'], $r['tokens']['bg'], $r['tokens']['surface'], $r['tokens']['text'] ) as $c ) {
				echo '<i style="background:' . esc_attr( $c ) . '"></i>';
			}
			echo '</div><button type="button" class="button button-primary cww-pick">' . esc_html__( 'Choose this design', 'cwai' ) . '</button></div></div>';
		}
		echo '</div></div></div></div>';
	}
}
