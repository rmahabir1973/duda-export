<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Staff view: a simplified, branded WordPress admin for editors (people who run the site day to day).
 * Administrators choose which left-menu items to hide, set a logo and colours, and can preview it as staff.
 * It is a visual simplification: staff keep exactly the permissions their role has.
 */
final class CWAI_StaffView {

	const OPT  = 'cwai_sv';
	const SEEN = 'cwai_sv_seen';
	const META = 'cwai_sv_preview';

	/** Menus that should never be hidden: they would trap staff. */
	const PROTECTED = array( 'index.php', 'cwai-chat', 'profile.php' );
	/** Menus most sites will want to hide from staff (used by the "hide the technical menus" button). */
	const TECH_RE = '#^(tools|plugins|themes|users|options-general|import|export|site-health)\.php|oxygen|rank-?math|litespeed|updraft|agent-?connector|wp-?mail-?smtp|acf|cwai-(settings|designs|import|wizard|images|bot|routines|golive|staffview|reset)|customize\.php|nav-menus|edit\.php\?post_type=(acf|oxygen)#i';

	public static function defaults() {
		return array(
			'enabled'      => false,
			'roles'        => array( 'editor' ),
			'accent'       => '#74277C',
			'highlight'    => '#CE9621',
			'logo_id'      => 0,
			'logo_url'     => 'https://media.churchwebglobal.com/church-web-global-logo2.png',
			'hide_menu'    => array(),
			'hide_sub'     => array(),
			'hide_bar'     => true,
			'clean_dash'   => true,
			'hide_notices' => true,
			'login'        => true,
			'footer'       => '',
		);
	}

	public static function opts() {
		$o = array_merge( self::defaults(), (array) get_option( self::OPT, array() ) );
		return $o;
	}

	public static function boot() {
		add_action( 'admin_menu', array( __CLASS__, 'remember_menu' ), 10000 );
		add_action( 'admin_menu', array( __CLASS__, 'apply_menu' ), 10001 );
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 28 );
		add_action( 'admin_bar_menu', array( __CLASS__, 'bar_brand' ), 0 );
		add_action( 'admin_bar_menu', array( __CLASS__, 'bar' ), 9999 );
		add_action( 'admin_head', array( __CLASS__, 'head' ), 99 );
		add_action( 'admin_print_footer_scripts', array( __CLASS__, 'contrast_guard' ), 99 );
		add_action( 'wp_head', array( __CLASS__, 'head_front' ), 99 );
		add_action( 'wp_dashboard_setup', array( __CLASS__, 'dashboard' ), 9999 );
		add_filter( 'admin_footer_text', array( __CLASS__, 'footer' ), 99 );
		add_filter( 'update_footer', array( __CLASS__, 'version_footer' ), 99 );
		add_action( 'login_enqueue_scripts', array( __CLASS__, 'login_css' ) );
		add_filter( 'login_headerurl', array( __CLASS__, 'login_url' ) );
		add_filter( 'login_headertext', array( __CLASS__, 'login_text' ) );
		add_action( 'admin_post_cwai_sv', array( __CLASS__, 'handle_save' ) );
		add_action( 'admin_post_cwai_sv_preview', array( __CLASS__, 'handle_preview' ) );
		add_action( 'init', array( __CLASS__, 'escape_hatch' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
	}

	/** Does the simple view apply to the current user right now? */
	public static function applies( $user = null ) {
		$o = self::opts();
		if ( ! $o['enabled'] || ! is_user_logged_in() ) {
			return false;
		}
		$user = $user ?: wp_get_current_user();
		if ( get_user_meta( $user->ID, self::META, true ) && user_can( $user, 'manage_options' ) ) {
			return true;
		}
		if ( user_can( $user, 'manage_options' ) ) {
			return false;
		}
		return (bool) array_intersect( (array) $o['roles'], (array) $user->roles );
	}

	private static function previewing() {
		return is_user_logged_in() && current_user_can( 'manage_options' ) && get_user_meta( get_current_user_id(), self::META, true );
	}

	/* ------------------------------------------------------------------ */
	/* Colour maths                                                        */
	/* ------------------------------------------------------------------ */

	private static function rgb( $hex ) {
		$h = ltrim( $hex, '#' );
		if ( 3 === strlen( $h ) ) {
			$h = $h[0] . $h[0] . $h[1] . $h[1] . $h[2] . $h[2];
		}
		return array( hexdec( substr( $h, 0, 2 ) ), hexdec( substr( $h, 2, 2 ) ), hexdec( substr( $h, 4, 2 ) ) );
	}
	private static function hex( array $c ) {
		return sprintf( '#%02x%02x%02x', max( 0, min( 255, (int) round( $c[0] ) ) ), max( 0, min( 255, (int) round( $c[1] ) ) ), max( 0, min( 255, (int) round( $c[2] ) ) ) );
	}
	public static function mix( $a, $b, $t ) {
		$x = self::rgb( $a );
		$y = self::rgb( $b );
		return self::hex( array( $x[0] + ( $y[0] - $x[0] ) * $t, $x[1] + ( $y[1] - $x[1] ) * $t, $x[2] + ( $y[2] - $x[2] ) * $t ) );
	}
	private static function lum( $hex ) {
		$f = static function ( $c ) {
			$c /= 255;
			return $c <= 0.03928 ? $c / 12.92 : pow( ( $c + 0.055 ) / 1.055, 2.4 );
		};
		list( $r, $g, $b ) = self::rgb( $hex );
		return 0.2126 * $f( $r ) + 0.7152 * $f( $g ) + 0.0722 * $f( $b );
	}
	public static function contrast( $a, $b ) {
		$l1 = self::lum( $a );
		$l2 = self::lum( $b );
		if ( $l1 < $l2 ) {
			list( $l1, $l2 ) = array( $l2, $l1 );
		}
		return ( $l1 + 0.05 ) / ( $l2 + 0.05 );
	}
	public static function on( $hex ) {
		return self::contrast( $hex, '#ffffff' ) >= self::contrast( $hex, '#111111' ) ? '#ffffff' : '#111111';
	}

	public static function palette( array $o = null ) {
		$o      = $o ?: self::opts();
		$accent = sanitize_hex_color( $o['accent'] ) ?: '#74277C';
		$hi     = sanitize_hex_color( $o['highlight'] ) ?: '#CE9621';
		$link   = $accent;
		for ( $i = 0; $i < 12 && self::contrast( $link, '#ffffff' ) < 4.5; $i++ ) {
			$link = self::mix( $link, '#000000', 0.12 );
		}
		return array(
			'accent'    => $accent,
			'accent_d'  => self::mix( $accent, '#000000', 0.25 ),
			'dark'      => self::mix( $accent, '#000000', 0.78 ),
			'hi'        => $hi,
			'link'      => $link,
			'on_accent' => self::on( $accent ),
			'on_hi'     => self::on( $hi ),
			'tint'      => self::mix( $accent, '#ffffff', 0.94 ),
		);
	}

	public static function css() {
		$p   = self::palette();
		$o   = self::opts();
		$css = ':root{--cwsv-accent:' . $p['accent'] . ';--cwsv-dark:' . $p['dark'] . ';--cwsv-hi:' . $p['hi'] . ';--cwsv-link:' . $p['link'] . ';}'
			. 'body.wp-admin{background:' . $p['tint'] . '}'
			. '#adminmenuback,#adminmenuwrap,#adminmenu{background:' . $p['dark'] . '}'
			. '#adminmenu a{color:rgba(255,255,255,.88)}'
			. '#adminmenu div.wp-menu-image:before{color:rgba(255,255,255,.7)}'
			. '#adminmenu li.menu-top:hover,#adminmenu li.opensub>a.menu-top,#adminmenu li>a.menu-top:focus{background:' . $p['accent_d'] . ';color:#fff}'
			. '#adminmenu li.current a.menu-top,#adminmenu li.wp-has-current-submenu a.wp-has-current-submenu,#adminmenu li.wp-has-current-submenu .wp-submenu .wp-submenu-head{background:' . $p['accent'] . ';color:' . $p['on_accent'] . '}'
			. '#adminmenu li.current a.menu-top,#adminmenu li.wp-has-current-submenu a.wp-has-current-submenu{box-shadow:inset 4px 0 0 ' . $p['hi'] . '}'
			. '#adminmenu li.current div.wp-menu-image:before,#adminmenu li.wp-has-current-submenu div.wp-menu-image:before,#adminmenu li.menu-top:hover div.wp-menu-image:before{color:' . $p['on_accent'] . '}'
			. '#adminmenu .wp-submenu,#adminmenu .wp-has-current-submenu .wp-submenu,#adminmenu a.wp-has-current-submenu:focus+.wp-submenu{background:rgba(0,0,0,.25)}'
			. '#adminmenu .wp-submenu a{color:rgba(255,255,255,.8)}#adminmenu .wp-submenu li.current a,#adminmenu .wp-submenu a:hover{color:#fff;font-weight:600}'
			. '#adminmenu .awaiting-mod,#adminmenu .update-plugins{background:' . $p['hi'] . ';color:' . $p['on_hi'] . '}'
			. '#collapse-button{color:rgba(255,255,255,.7)}#collapse-button:hover{color:#fff}'
			. '#wpadminbar{background:' . $p['dark'] . '}'
			. '#wpadminbar .ab-item,#wpadminbar a.ab-item,#wpadminbar>#wp-toolbar span.ab-label,#wpadminbar>#wp-toolbar span.noticon{color:rgba(255,255,255,.92)}'
			. '#wpadminbar .ab-top-menu>li:hover>.ab-item,#wpadminbar .ab-top-menu>li.hover>.ab-item,#wpadminbar .ab-top-menu>li>.ab-item:focus{background:' . $p['accent'] . ';color:' . $p['on_accent'] . '}'
			. '#wpadminbar .menupop .ab-sub-wrapper{background:' . $p['dark'] . '}'
			. '#wpadminbar .ab-sub-wrapper .ab-item{color:rgba(255,255,255,.88)!important}'
			. '#wpadminbar .quicklinks .menupop ul li a:hover{color:' . $p['hi'] . '!important}'
			. '#wpadminbar #wp-admin-bar-cwai-brand>.ab-item{padding:0 12px 0 10px;display:flex;align-items:center;height:32px}'
			. '#wpadminbar #wp-admin-bar-cwai-brand img{max-height:22px;width:auto;display:block}'
			. '#wpadminbar #wp-admin-bar-cwai-brand .cwsv-name{font-weight:700;letter-spacing:.2px}'
			. '#wpadminbar #wp-admin-bar-cwai-sv-exit>.ab-item{background:' . $p['hi'] . ';color:' . $p['on_hi'] . '!important}'
			. '#wpbody-content a:not([class]):not([style]),.subsubsub a,.row-actions a,.wp-list-table a.row-title{color:' . $p['link'] . '}#wpbody-content a:not([class]):not([style]):hover,.subsubsub a:hover,.row-actions a:hover,.wp-list-table a.row-title:hover{color:' . $p['accent_d'] . '}'
			. '.wp-core-ui .button-primary,#wpbody-content .button.button-primary{background:' . $p['accent'] . ';border-color:' . $p['accent_d'] . ';color:' . $p['on_accent'] . '!important;-webkit-text-fill-color:' . $p['on_accent'] . ';text-shadow:none;box-shadow:none}'
			. '.wp-core-ui .button-primary:hover,.wp-core-ui .button-primary:focus,.wp-core-ui .button-primary:active,#wpbody-content .button.button-primary:hover,#wpbody-content .button.button-primary:focus{background:' . $p['accent_d'] . ';border-color:' . $p['accent_d'] . ';color:' . $p['on_accent'] . '!important;-webkit-text-fill-color:' . $p['on_accent'] . '}'
			. '.wp-core-ui .button:not(.button-primary):not(.button-link):not(.button-hero),.wp-core-ui .button-secondary:not(.button-primary){border-color:' . $p['link'] . ';color:' . $p['link'] . '}.wp-core-ui .button:not(.button-primary):not(.button-link):not(.button-hero):hover{border-color:' . $p['accent_d'] . ';color:' . $p['accent_d'] . '}'
			. '.wp-core-ui .button-primary[disabled],.wp-core-ui .button-primary:disabled,.wp-core-ui .button-primary.disabled{background:#f6f7f7!important;border-color:#dcdcde!important;color:#a7aaad!important}'
			. 'input[type=checkbox]:checked::before{color:' . $p['link'] . '}input[type=radio]:checked::before{background:' . $p['link'] . '}'
			. 'input:focus,select:focus,textarea:focus{border-color:' . $p['accent'] . ';box-shadow:0 0 0 1px ' . $p['accent'] . '}'
			. '.nav-tab-active,.wp-filter .current{border-bottom-color:' . $p['hi'] . '}'
			. '#screen-meta-links,#contextual-help-link-wrap{display:none!important}'
			. '#wpfooter #footer-upgrade{display:none}';
		if ( $o['hide_notices'] ) {
			$css .= '.wrap>.notice-info:not(.inline):not(.cwai-keep):not(.update-message),.wrap>.notice-warning:not(.inline):not(.cwai-keep):not(.update-message),#wpbody-content>.notice-info:not(.inline):not(.cwai-keep),#wpbody-content>.notice-warning:not(.inline):not(.cwai-keep),.update-nag:not(.update-message),#wpbody-content>.updated:not(.cwai-keep):not(.notice-success):not(.inline){display:none!important}';
		}
		$css .= '#cwsv-welcome .cwsv-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin-top:6px}'
			. '#cwsv-welcome a.cwsv-tile{display:flex;flex-direction:column;gap:6px;padding:16px;border-radius:10px;background:#fff;border:1px solid #e6dfe8;border-top:4px solid ' . $p['accent'] . ';text-decoration:none;color:#1d2327;box-shadow:0 1px 2px rgba(0,0,0,.04);transition:transform .08s,box-shadow .08s}'
			. '#cwsv-welcome a.cwsv-tile:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.1);color:#1d2327}'
			. '#cwsv-welcome a.cwsv-tile.primary{background:' . $p['accent'] . ';border-color:' . $p['accent'] . ';border-top-color:' . $p['hi'] . ';color:' . $p['on_accent'] . '}#cwsv-welcome a.cwsv-tile.primary:hover{color:' . $p['on_accent'] . '}'
			. '#cwsv-welcome .cwsv-t{font-weight:600;font-size:15px}#cwsv-welcome .cwsv-d{font-size:12.5px;opacity:.8}'
			. '#cwsv-welcome .cwsv-hello{font-size:15px;margin:2px 0 6px}'
			. '#dashboard-widgets-wrap #dashboard-widgets.metabox-holder .postbox-container{width:100%!important;max-width:1100px}#dashboard-widgets-wrap #dashboard-widgets.metabox-holder #postbox-container-1{float:none}#dashboard-widgets-wrap #postbox-container-2,#dashboard-widgets-wrap #postbox-container-3,#dashboard-widgets-wrap #postbox-container-4{display:none}'
			. '#dashboard-widgets .postbox{border-radius:10px;border-color:#e6dfe8}#dashboard-widgets .postbox .hndle{display:none}#dashboard-widgets .postbox .postbox-header{display:none}';
		return $css;
	}

	public static function head() {
		if ( ! self::applies() ) {
			return;
		}
		echo '<style id="cwai-sv-css">' . self::css() . '</style>'; // phpcs:ignore
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( $screen && method_exists( $screen, 'remove_help_tabs' ) ) {
			$screen->remove_help_tabs();
		}
	}

	/**
	 * Safety net: another plugin's admin CSS can still end up painting a button's text in its own background colour.
	 * This measures every visible button in the browser and, if the text is hard to read, sets a readable colour.
	 */
	public static function contrast_guard() {
		if ( ! self::applies() ) {
			return;
		}
		echo '<script id="cwai-sv-guard">' . "(function(){function n(s){var m=(s||'').match(/[\\d.]+/g);return m?m.slice(0,4).map(Number):null}function L(c){var f=function(v){v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(c[0])+.7152*f(c[1])+.0722*f(c[2])}function R(a,b){var x=L(a),y=L(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}function bg(e){while(e&&e.nodeType===1){var c=n(getComputedStyle(e).backgroundColor);if(c&&(c.length<4||c[3]>.5))return c;e=e.parentElement}return [255,255,255]}function fix(){var l=document.querySelectorAll('.button,.button-primary,.button-secondary,input[type=submit],input[type=button],#wpbody-content button');for(var i=0;i<l.length;i++){var b=l[i];if(b.disabled||b.offsetParent===null)continue;var f=n(getComputedStyle(b).color),g=bg(b);if(!f||!g||R(f,g)>=3)continue;var o=R([255,255,255],g)>=R([17,17,17],g)?'#fff':'#111';b.style.setProperty('color',o,'important');b.style.setProperty('-webkit-text-fill-color',o,'important')}}var t;function q(){clearTimeout(t);t=setTimeout(fix,120)}if(document.readyState!=='loading')fix();else document.addEventListener('DOMContentLoaded',fix);window.addEventListener('load',q);new MutationObserver(q).observe(document.documentElement,{childList:true,subtree:true})})();" . '</script>'; // phpcs:ignore
	}

	public static function head_front() {
		if ( ! self::applies() || ! is_admin_bar_showing() ) {
			return;
		}
		echo '<style id="cwai-sv-css">' . self::css() . '</style>'; // phpcs:ignore
	}

	/* ------------------------------------------------------------------ */
	/* Left menu                                                           */
	/* ------------------------------------------------------------------ */

	private static function clean_title( $t ) {
		$t = preg_replace( '#<span[^>]*>.*?</span>#is', '', (string) $t );
		return trim( html_entity_decode( wp_strip_all_tags( $t ) ) );
	}

	/** Top-level menus and their submenus as the current user sees them. */
	public static function menu_tree() {
		global $menu, $submenu;
		$out = array();
		foreach ( (array) $menu as $m ) {
			if ( empty( $m[0] ) || empty( $m[2] ) || ( isset( $m[4] ) && false !== strpos( (string) $m[4], 'wp-menu-separator' ) ) ) {
				continue;
			}
			$slug = (string) $m[2];
			$subs = array();
			foreach ( (array) ( $submenu[ $slug ] ?? array() ) as $s ) {
				if ( ! empty( $s[0] ) && ! empty( $s[2] ) && $s[2] !== $slug ) {
					$subs[] = array( 'slug' => (string) $s[2], 'title' => self::clean_title( $s[0] ) );
				}
			}
			$out[] = array( 'slug' => $slug, 'title' => self::clean_title( $m[0] ), 'subs' => $subs );
		}
		return $out;
	}

	/** Administrators' menus are remembered, so the assistant and the settings page know the names. */
	public static function remember_menu() {
		if ( ! current_user_can( 'manage_options' ) || self::previewing() ) {
			return;
		}
		$tree = self::menu_tree();
		if ( $tree && $tree !== get_option( self::SEEN ) ) {
			update_option( self::SEEN, $tree, false );
		}
	}

	public static function apply_menu() {
		if ( ! self::applies() ) {
			return;
		}
		$o = self::opts();
		foreach ( (array) $o['hide_menu'] as $slug ) {
			if ( ! in_array( $slug, self::PROTECTED, true ) ) {
				remove_menu_page( $slug );
			}
		}
		foreach ( (array) $o['hide_sub'] as $pair ) {
			$x = explode( '||', (string) $pair, 2 );
			if ( 2 === count( $x ) && ! in_array( $x[1], self::PROTECTED, true ) ) {
				remove_submenu_page( $x[0], $x[1] );
			}
		}
	}

	/* ------------------------------------------------------------------ */
	/* Top bar                                                             */
	/* ------------------------------------------------------------------ */

	public static function logo_url() {
		$o = self::opts();
		if ( $o['logo_id'] ) {
			$u = wp_get_attachment_image_url( (int) $o['logo_id'], 'medium' );
			if ( $u ) {
				return $u;
			}
		}
		return esc_url_raw( $o['logo_url'] );
	}

	/** Added first, so the logo sits at the far left. */
	public static function bar_brand( $bar ) {
		if ( ! self::applies() ) {
			return;
		}
		$brand = CWAI_Settings::get( 'brand_name' );
		$logo  = self::logo_url();
		$title = ( $logo ? '<img src="' . esc_url( $logo ) . '" alt="' . esc_attr( $brand ) . '">' : '<span class="cwsv-name">' . esc_html( $brand ) . '</span>' );
		$bar->add_node( array( 'id' => 'cwai-brand', 'title' => $title, 'href' => admin_url(), 'meta' => array( 'title' => $brand ) ) );
	}

	public static function bar( $bar ) {
		if ( ! is_user_logged_in() ) {
			return;
		}
		// Administrators get a switch to preview what staff see.
		if ( current_user_can( 'manage_options' ) && self::opts()['enabled'] ) {
			if ( self::previewing() ) {
				$bar->add_node( array( 'id' => 'cwai-sv-exit', 'title' => esc_html__( 'Exit staff preview', 'cwai' ), 'href' => wp_nonce_url( admin_url( 'admin-post.php?action=cwai_sv_preview&on=0' ), 'cwai_sv_preview' ), 'parent' => 'top-secondary' ) );
			} else {
				$bar->add_node( array( 'id' => 'cwai-sv-preview', 'title' => esc_html__( 'View as staff', 'cwai' ), 'href' => wp_nonce_url( admin_url( 'admin-post.php?action=cwai_sv_preview&on=1' ), 'cwai_sv_preview' ), 'parent' => 'top-secondary' ) );
			}
		}
		if ( ! self::applies() ) {
			return;
		}
		$o = self::opts();
		$bar->remove_node( 'wp-logo' );
		$me = $bar->get_node( 'my-account' );
		if ( $me ) {
			$u = wp_get_current_user();
			$bar->add_node( array( 'id' => 'my-account', 'title' => esc_html( $u->display_name ) . get_avatar( $u->ID, 26 ) ) );
		}
		if ( $o['hide_bar'] ) {
			$keep = array( 'cwai-brand', 'site-name', 'my-account', 'menu-toggle', 'edit', 'view', 'cwai-toggle', 'cwai-sv-exit', 'cwai-sv-preview', 'top-secondary', 'search' );
			foreach ( $bar->get_nodes() as $n ) {
				if ( ! $n->parent && ! in_array( $n->id, $keep, true ) ) {
					$bar->remove_node( $n->id );
				}
			}
			$bar->remove_node( 'search' );
		}
		$bar->remove_node( 'wp-logo-external' );
	}

	/* ------------------------------------------------------------------ */
	/* Dashboard                                                           */
	/* ------------------------------------------------------------------ */

	public static function dashboard() {
		if ( ! self::applies() || ! self::opts()['clean_dash'] ) {
			return;
		}
		global $wp_meta_boxes;
		remove_action( 'welcome_panel', 'wp_welcome_panel' );
		if ( ! empty( $wp_meta_boxes['dashboard'] ) ) {
			$wp_meta_boxes['dashboard'] = array();
		}
		wp_add_dashboard_widget( 'cwsv-welcome', esc_html( CWAI_Settings::get( 'brand_name' ) ), array( __CLASS__, 'welcome' ) );
	}

	public static function tiles() {
		$t = array();
		if ( CWAI_Plugin::can_use() ) {
			$t[] = array( 'Ask the assistant', 'Describe a change in plain words', admin_url( 'admin.php?page=cwai-chat' ), true );
		}
		if ( current_user_can( 'edit_pages' ) ) {
			$t[] = array( 'Edit a page', 'Change text, images or layout', admin_url( 'edit.php?post_type=page' ), false );
		}
		if ( current_user_can( 'edit_posts' ) ) {
			$t[] = array( 'Write a post', 'News, blog or announcements', admin_url( 'post-new.php' ), false );
		}
		$n = 0;
		foreach ( get_post_types( array( 'show_ui' => true, '_builtin' => false ), 'objects' ) as $pt ) {
			if ( $n >= 3 || in_array( $pt->name, array( 'cwai_kb', 'oxygen_template', 'oxygen_part', 'acf-field-group', 'acf-field', 'wpcf7_contact_form' ), true ) || 0 === strpos( $pt->name, 'oxygen' ) || 0 === strpos( $pt->name, 'acf' ) || ! current_user_can( $pt->cap->edit_posts ) ) {
				continue;
			}
			$t[] = array( $pt->labels->name, 'Add or change ' . strtolower( $pt->labels->name ), admin_url( 'edit.php?post_type=' . $pt->name ), false );
			$n++;
		}
		if ( current_user_can( 'upload_files' ) ) {
			$t[] = array( 'Photos and files', 'Your media library', admin_url( 'upload.php' ), false );
		}
		if ( CWAI_Plugin::can_use() ) {
			$t[] = array( 'Recent changes', 'See and undo what changed', admin_url( 'admin.php?page=cwai-activity' ), false );
			$t[] = array( 'Site check-up', 'Find broken links and gaps', admin_url( 'admin.php?page=cwai-health' ), false );
		}
		$t[] = array( 'View the website', 'See it as visitors do', home_url( '/' ), false );
		return $t;
	}

	public static function welcome() {
		$u = wp_get_current_user();
		echo '<div class="cwsv-welcome-inner"><p class="cwsv-hello">' . esc_html( sprintf( /* translators: %s: name */ __( 'Hello, %s. What would you like to do?', 'cwai' ), $u->display_name ) ) . '</p><div class="cwsv-tiles">';
		foreach ( self::tiles() as $t ) {
			echo '<a class="cwsv-tile' . ( $t[3] ? ' primary' : '' ) . '" href="' . esc_url( $t[2] ) . '"><span class="cwsv-t">' . esc_html( $t[0] ) . '</span><span class="cwsv-d">' . esc_html( $t[1] ) . '</span></a>';
		}
		echo '</div></div>';
	}

	/* ------------------------------------------------------------------ */
	/* Footer and login                                                    */
	/* ------------------------------------------------------------------ */

	public static function footer( $text ) {
		if ( ! self::applies() ) {
			return $text;
		}
		$o = self::opts();
		return esc_html( $o['footer'] ?: sprintf( /* translators: %s: brand */ __( 'Managed with %s', 'cwai' ), CWAI_Settings::get( 'brand_name' ) ) );
	}
	public static function version_footer( $t ) {
		return self::applies() ? '' : $t;
	}

	private static function login_on() {
		$o = self::opts();
		return $o['enabled'] && $o['login'];
	}
	public static function login_css() {
		if ( ! self::login_on() ) {
			return;
		}
		$p    = self::palette();
		$logo = self::logo_url();
		echo '<style id="cwai-sv-login">body.login{background:' . $p['tint'] . '}'
			. 'body.login #login h1 a{' . ( $logo ? 'background-image:url(' . esc_url( $logo ) . ');background-size:contain;background-position:center;background-repeat:no-repeat;width:100%;height:70px;' : '' ) . '}'
			. 'body.login form{border:1px solid #e6dfe8;border-top:4px solid ' . $p['accent'] . ';border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.06)}'
			. 'body.login .button-primary{background:' . $p['accent'] . ';border-color:' . $p['accent_d'] . ';color:' . $p['on_accent'] . ';text-shadow:none;box-shadow:none}body.login .button-primary:hover{background:' . $p['accent_d'] . '}'
			. 'body.login a{color:' . $p['link'] . '}body.login input:focus{border-color:' . $p['accent'] . ';box-shadow:0 0 0 1px ' . $p['accent'] . '}</style>'; // phpcs:ignore
	}
	public static function login_url( $u ) {
		return self::login_on() ? home_url( '/' ) : $u;
	}
	public static function login_text( $t ) {
		return self::login_on() ? CWAI_Settings::get( 'brand_name' ) : $t;
	}

	/* ------------------------------------------------------------------ */
	/* Preview as staff + escape hatch                                     */
	/* ------------------------------------------------------------------ */

	public static function handle_preview() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Not allowed.', 'cwai' ) );
		}
		check_admin_referer( 'cwai_sv_preview' );
		if ( ! empty( $_GET['on'] ) ) { // phpcs:ignore
			update_user_meta( get_current_user_id(), self::META, 1 );
		} else {
			delete_user_meta( get_current_user_id(), self::META );
		}
		wp_safe_redirect( admin_url( ! empty( $_GET['on'] ) ? 'index.php' : 'admin.php?page=cwai-staffview' ) ); // phpcs:ignore
		exit;
	}

	/** If an administrator ever hides something they need while previewing: ?cwai_sv_off=1 turns the preview off. */
	public static function escape_hatch() {
		if ( isset( $_GET['cwai_sv_off'] ) && is_user_logged_in() && current_user_can( 'manage_options' ) ) { // phpcs:ignore
			delete_user_meta( get_current_user_id(), self::META );
		}
	}

	/* ------------------------------------------------------------------ */
	/* Settings page                                                       */
	/* ------------------------------------------------------------------ */

	public static function sanitize( array $in ) {
		$d  = self::defaults();
		$o  = array();
		$o['enabled']      = ! empty( $in['enabled'] );
		$roles             = array_keys( wp_roles()->get_names() );
		$o['roles']        = array_values( array_diff( array_intersect( array_map( 'sanitize_key', (array) ( $in['roles'] ?? array() ) ), $roles ), array( 'administrator' ) ) );
		$o['accent']       = sanitize_hex_color( $in['accent'] ?? '' ) ?: $d['accent'];
		$o['highlight']    = sanitize_hex_color( $in['highlight'] ?? '' ) ?: $d['highlight'];
		$o['logo_id']      = absint( $in['logo_id'] ?? 0 );
		$url               = esc_url_raw( trim( (string) ( $in['logo_url'] ?? '' ) ), array( 'https', 'http' ) );
		$o['logo_url']     = $url;
		$clean             = static function ( $list, $max = 300 ) {
			$out = array();
			foreach ( array_slice( (array) $list, 0, $max ) as $s ) {
				$s = trim( (string) $s );
				if ( '' !== $s && strlen( $s ) <= 200 && ! preg_match( '/[\x00-\x1f<>"]/', $s ) && ! in_array( $s, self::PROTECTED, true ) ) {
					$out[] = $s;
				}
			}
			return array_values( array_unique( $out ) );
		};
		$o['hide_menu']    = $clean( $in['hide_menu'] ?? array() );
		$o['hide_sub']     = $clean( $in['hide_sub'] ?? array() );
		foreach ( array( 'hide_bar', 'clean_dash', 'hide_notices', 'login' ) as $k ) {
			$o[ $k ] = ! empty( $in[ $k ] );
		}
		$o['footer']       = mb_substr( sanitize_text_field( $in['footer'] ?? '' ), 0, 140 );
		return $o;
	}

	public static function handle_save() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Not allowed.', 'cwai' ) );
		}
		check_admin_referer( 'cwai_sv' );
		update_option( self::OPT, self::sanitize( (array) wp_unslash( $_POST['sv'] ?? array() ) ), false ); // phpcs:ignore
		wp_safe_redirect( admin_url( 'admin.php?page=cwai-staffview&saved=1' ) );
		exit;
	}

	public static function menu() {
		add_submenu_page( 'cwai-chat', __( 'Staff view', 'cwai' ), __( 'Staff view', 'cwai' ), 'manage_options', 'cwai-staffview', array( __CLASS__, 'render_page' ) );
	}

	public static function enqueue() {
		if ( ! isset( $_GET['page'] ) || 'cwai-staffview' !== $_GET['page'] ) { // phpcs:ignore
			return;
		}
		wp_enqueue_style( 'wp-color-picker' );
		wp_enqueue_media();
		wp_enqueue_script( 'cwai-staffview', CWAI_URL . 'assets/staffview.js', array( 'jquery', 'wp-color-picker' ), CWAI_VERSION, true );
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$o    = self::opts();
		$tree = self::previewing() ? (array) get_option( self::SEEN, array() ) : self::menu_tree();
		if ( ! $tree ) {
			$tree = (array) get_option( self::SEEN, array() );
		}
		$name = esc_attr( self::OPT ) . '';
		echo '<div class="wrap" id="cwsv"><h1>' . esc_html__( 'Staff view', 'cwai' ) . '</h1>';
		if ( ! empty( $_GET['saved'] ) ) { // phpcs:ignore
			echo '<div class="notice notice-success is-dismissible cwai-keep"><p>' . esc_html__( 'Saved.', 'cwai' ) . '</p></div>';
		}
		echo '<p class="description" style="max-width:800px">' . esc_html__( 'Give the people who run the website day to day a simpler, branded WordPress: only the menu items you choose, a clean home screen and your logo and colours. This changes what they see, not what they are allowed to do; their role keeps the same permissions. Administrators always see everything.', 'cwai' ) . '</p>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '"><input type="hidden" name="action" value="cwai_sv">';
		wp_nonce_field( 'cwai_sv' );
		echo '<table class="form-table" role="presentation"><tbody>';
		echo '<tr><th>' . esc_html__( 'Turn it on', 'cwai' ) . '</th><td><label><input type="checkbox" name="sv[enabled]" value="1"' . checked( $o['enabled'], true, false ) . '> ' . esc_html__( 'Use the staff view', 'cwai' ) . '</label></td></tr>';
		echo '<tr><th>' . esc_html__( 'Who sees it', 'cwai' ) . '</th><td>';
		foreach ( wp_roles()->get_names() as $slug => $rname ) {
			if ( 'administrator' === $slug ) {
				continue;
			}
			echo '<label style="margin-right:14px"><input type="checkbox" name="sv[roles][]" value="' . esc_attr( $slug ) . '"' . checked( in_array( $slug, (array) $o['roles'], true ), true, false ) . '> ' . esc_html( translate_user_role( $rname ) ) . '</label>';
		}
		echo '<p class="description">' . esc_html__( 'Administrators never get the simplified view, but you can try it with "View as staff" in the top bar.', 'cwai' ) . '</p></td></tr>';
		echo '<tr><th>' . esc_html__( 'Logo', 'cwai' ) . '</th><td><input type="hidden" name="sv[logo_id]" id="cwsv-logo-id" value="' . (int) $o['logo_id'] . '"><input type="url" class="regular-text" name="sv[logo_url]" id="cwsv-logo-url" value="' . esc_attr( $o['logo_url'] ) . '" placeholder="https://"> <button type="button" class="button" id="cwsv-pick">' . esc_html__( 'Choose from the media library', 'cwai' ) . '</button><p><img id="cwsv-logo-prev" src="' . esc_url( self::logo_url() ) . '" alt="" style="max-height:44px;background:' . esc_attr( self::palette()['dark'] ) . ';padding:8px 12px;border-radius:6px"></p><p class="description">' . esc_html__( 'Shown top left. A wide logo on a transparent background works best (about 22 pixels tall in the bar). Leave empty to show the name instead.', 'cwai' ) . '</p></td></tr>';
		echo '<tr><th>' . esc_html__( 'Colours', 'cwai' ) . '</th><td><label>' . esc_html__( 'Main', 'cwai' ) . ' <input type="text" class="cwsv-color" name="sv[accent]" value="' . esc_attr( $o['accent'] ) . '" data-default-color="#74277C"></label> &nbsp; <label>' . esc_html__( 'Highlight', 'cwai' ) . ' <input type="text" class="cwsv-color" name="sv[highlight]" value="' . esc_attr( $o['highlight'] ) . '" data-default-color="#CE9621"></label><p class="description">' . esc_html__( 'The menu and top bar use a deep shade of the main colour. Text colours are chosen automatically so everything stays readable.', 'cwai' ) . '</p></td></tr>';
		echo '<tr><th>' . esc_html__( 'Clean-up', 'cwai' ) . '</th><td>';
		foreach ( array( 'hide_bar' => 'Simplify the top bar (hide plugin shortcuts, comments and "New")', 'clean_dash' => 'Replace the home screen with big buttons for common jobs', 'hide_notices' => 'Hide plugin notices and update nags', 'login' => 'Brand the login page with the logo and colours' ) as $k => $label ) {
			echo '<label style="display:block;margin:3px 0"><input type="checkbox" name="sv[' . esc_attr( $k ) . ']" value="1"' . checked( ! empty( $o[ $k ] ), true, false ) . '> ' . esc_html( $label ) . '</label>';
		}
		echo '</td></tr>';
		echo '<tr><th>' . esc_html__( 'Footer text', 'cwai' ) . '</th><td><input type="text" class="regular-text" maxlength="140" name="sv[footer]" value="' . esc_attr( $o['footer'] ) . '" placeholder="' . esc_attr( sprintf( 'Managed with %s', CWAI_Settings::get( 'brand_name' ) ) ) . '"></td></tr>';
		echo '</tbody></table>';

		echo '<h2>' . esc_html__( 'Left menu: tick what staff should NOT see', 'cwai' ) . '</h2><p><button type="button" class="button" id="cwsv-tech">' . esc_html__( 'Tick the technical menus', 'cwai' ) . '</button> <button type="button" class="button" id="cwsv-none">' . esc_html__( 'Clear all', 'cwai' ) . '</button> <span class="description">' . esc_html__( 'Dashboard, the Assistant and Profile can never be hidden. Hiding a menu removes the link; it does not take away permission.', 'cwai' ) . '</span></p>';
		if ( ! $tree ) {
			echo '<p>' . esc_html__( 'The menu list appears after you open any admin page once.', 'cwai' ) . '</p>';
		}
		echo '<div style="columns:2;max-width:900px;column-gap:40px">';
		foreach ( $tree as $m ) {
			$prot = in_array( $m['slug'], self::PROTECTED, true );
			$tech = preg_match( self::TECH_RE, $m['slug'] ) ? '1' : '0';
			echo '<div style="break-inside:avoid;margin-bottom:8px"><label><input type="checkbox" class="cwsv-top" data-tech="' . esc_attr( $tech ) . '" name="sv[hide_menu][]" value="' . esc_attr( $m['slug'] ) . '"' . checked( in_array( $m['slug'], (array) $o['hide_menu'], true ), true, false ) . ( $prot ? ' disabled' : '' ) . '> <strong>' . esc_html( $m['title'] ) . '</strong></label>';
			foreach ( $m['subs'] as $s ) {
				$val = $m['slug'] . '||' . $s['slug'];
				echo '<div style="margin-left:22px"><label><input type="checkbox" class="cwsv-sub" name="sv[hide_sub][]" value="' . esc_attr( $val ) . '"' . checked( in_array( $val, (array) $o['hide_sub'], true ), true, false ) . '> ' . esc_html( $s['title'] ) . '</label></div>';
			}
			echo '</div>';
		}
		echo '</div>';
		submit_button( __( 'Save staff view', 'cwai' ) );
		echo '</form>';
		if ( $o['enabled'] ) {
			echo '<p><a class="button" href="' . esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=cwai_sv_preview&on=1' ), 'cwai_sv_preview' ) ) . '">' . esc_html__( 'Preview it as staff', 'cwai' ) . '</a> <span class="description">' . esc_html__( 'Use "Exit staff preview" in the top bar to come back.', 'cwai' ) . '</span></p>';
		}
		echo '</div>';
	}

	/* ------------------------------------------------------------------ */
	/* Assistant tools                                                     */
	/* ------------------------------------------------------------------ */

	public static function register_tools() {
		$p = array( 'CWAI_Tools_Content', 'p' );
		$s = array( 'CWAI_Tools_Content', 'schema' );
		CWAI_Registry::add( 'cwai/staff-view-get', array(
			'label'       => 'Staff view settings',
			'description' => 'Read the staff view (the simplified, branded admin for editors): whether it is on, which roles, colours, logo, which menus are hidden, and the full list of left-menu items (title and slug) as an administrator sees them.',
			'input'       => array(),
			'callback'    => array( __CLASS__, 't_get' ),
			'readonly'    => true,
			'admin'       => true,
			'capability'  => 'manage_options',
		) );
		CWAI_Registry::add( 'cwai/staff-view-set', array(
			'label'       => 'Change the staff view',
			'description' => 'Change the staff view for editors. hide_menus / show_menus take menu titles or slugs from cwai__staff-view-get (e.g. "Comments", "Tools"); the Dashboard, the Assistant and Profile cannot be hidden. This only hides links; it does not change permissions. Tell the person they can try it with "View as staff" in the top bar. Always needs approval.',
			'input'       => call_user_func( $s, array(
				'enabled'      => call_user_func( $p, 'boolean', 'Turn the staff view on or off.' ),
				'roles'        => array( 'type' => 'array', 'items' => array( 'type' => 'string' ), 'description' => 'Role slugs that get it, e.g. ["editor"]. Never administrator.' ),
				'accent'       => call_user_func( $p, 'string', 'Main colour as #rrggbb.' ),
				'highlight'    => call_user_func( $p, 'string', 'Highlight colour as #rrggbb.' ),
				'logo_url'     => call_user_func( $p, 'string', 'Logo image address (https).' ),
				'hide_menus'   => array( 'type' => 'array', 'items' => array( 'type' => 'string' ), 'description' => 'Top-level menus to hide, by title or slug.' ),
				'show_menus'   => array( 'type' => 'array', 'items' => array( 'type' => 'string' ), 'description' => 'Top-level menus to show again.' ),
				'hide_bar'     => call_user_func( $p, 'boolean', 'Simplify the top bar.' ),
				'clean_dash'   => call_user_func( $p, 'boolean', 'Replace the home screen with big buttons.' ),
				'hide_notices' => call_user_func( $p, 'boolean', 'Hide plugin notices and update nags.' ),
				'footer'       => call_user_func( $p, 'string', 'Footer text.' ),
			) ),
			'callback'    => array( __CLASS__, 't_set' ),
			'approval'    => true,
			'admin'       => true,
			'capability'  => 'manage_options',
		) );
	}

	public static function t_get() {
		$o = self::opts();
		return array( 'settings' => $o, 'menus' => get_option( self::SEEN, array() ), 'note' => 'Menus are listed once an administrator has opened a wp-admin page. Hiding only removes links; permissions are unchanged.' );
	}

	private static function resolve( $name, array $seen ) {
		$name = trim( (string) $name );
		foreach ( $seen as $m ) {
			if ( 0 === strcasecmp( $m['slug'], $name ) || 0 === strcasecmp( $m['title'], $name ) ) {
				return $m['slug'];
			}
		}
		return '';
	}

	public static function t_set( $in ) {
		$o    = self::opts();
		$seen = (array) get_option( self::SEEN, array() );
		$miss = array();
		foreach ( array( 'enabled', 'hide_bar', 'clean_dash', 'hide_notices' ) as $k ) {
			if ( isset( $in[ $k ] ) ) {
				$o[ $k ] = (bool) $in[ $k ];
			}
		}
		foreach ( array( 'roles', 'accent', 'highlight', 'logo_url', 'footer' ) as $k ) {
			if ( isset( $in[ $k ] ) ) {
				$o[ $k ] = $in[ $k ];
			}
		}
		$hide = (array) $o['hide_menu'];
		foreach ( (array) ( $in['hide_menus'] ?? array() ) as $n ) {
			$slug = self::resolve( $n, $seen );
			if ( '' === $slug ) {
				$miss[] = $n;
			} elseif ( ! in_array( $slug, self::PROTECTED, true ) ) {
				$hide[] = $slug;
			}
		}
		foreach ( (array) ( $in['show_menus'] ?? array() ) as $n ) {
			$slug = self::resolve( $n, $seen );
			$hide = array_values( array_diff( $hide, array( $slug ?: $n ) ) );
		}
		$o['hide_menu'] = $hide;
		$clean          = self::sanitize( $o );
		update_option( self::OPT, $clean, false );
		return array( 'saved' => true, 'enabled' => $clean['enabled'], 'hidden_menus' => $clean['hide_menu'], 'not_found' => $miss, 'note' => 'Try it with "View as staff" in the top bar.' );
	}

	public static function prompt_section() {
		return "## Staff view\n- Administrators can give editors a simplified, branded admin (hidden menus, logo, colours, big-button home screen). Use cwai__staff-view-get to see what is hidden and the menu names, and cwai__staff-view-set to change it (it needs approval). It only hides links; it never changes permissions, so do not describe it as a security measure.";
	}
}
