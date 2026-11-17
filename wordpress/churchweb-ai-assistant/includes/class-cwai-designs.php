<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Design library: 25 designs (5 families x 5 palettes). A design is a build specification (colours, type, shape,
 * header/hero/footer rules, section recipes and ready-made CSS) that the assistant follows when it builds the site.
 */
final class CWAI_Designs {

	const OPT = 'cwai_design';

	private static $data = null;

	public static function boot() {
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 21 );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
	}

	/* ------------------------------------------------------------------ */
	/* Data and colour maths                                               */
	/* ------------------------------------------------------------------ */

	private static function data() {
		if ( null === self::$data ) {
			self::$data = require CWAI_DIR . 'includes/data/designs.php';
		}
		return self::$data;
	}

	public static function families() {
		return self::data()['families'];
	}

	public static function all() {
		return self::data()['designs'];
	}

	public static function get( $id ) {
		$all = self::all();
		return $all[ $id ] ?? null;
	}

	private static function rgb( $hex ) {
		$hex = ltrim( $hex, '#' );
		return array( hexdec( substr( $hex, 0, 2 ) ), hexdec( substr( $hex, 2, 2 ) ), hexdec( substr( $hex, 4, 2 ) ) );
	}

	private static function hex( array $c ) {
		return sprintf( '#%02X%02X%02X', max( 0, min( 255, (int) round( $c[0] ) ) ), max( 0, min( 255, (int) round( $c[1] ) ) ), max( 0, min( 255, (int) round( $c[2] ) ) ) );
	}

	/** Mix $a toward $b by $t (0..1). */
	private static function mix( $a, $b, $t ) {
		$x = self::rgb( $a );
		$y = self::rgb( $b );
		return self::hex( array( $x[0] + ( $y[0] - $x[0] ) * $t, $x[1] + ( $y[1] - $x[1] ) * $t, $x[2] + ( $y[2] - $x[2] ) * $t ) );
	}

	private static function lum( $hex ) {
		$out = array();
		foreach ( self::rgb( $hex ) as $v ) {
			$v     = $v / 255;
			$out[] = $v <= 0.03928 ? $v / 12.92 : pow( ( $v + 0.055 ) / 1.055, 2.4 );
		}
		return 0.2126 * $out[0] + 0.7152 * $out[1] + 0.0722 * $out[2];
	}

	public static function contrast( $a, $b ) {
		$l1 = self::lum( $a );
		$l2 = self::lum( $b );
		return ( max( $l1, $l2 ) + 0.05 ) / ( min( $l1, $l2 ) + 0.05 );
	}

	private static function on( $bg ) {
		return self::contrast( '#FFFFFF', $bg ) >= self::contrast( '#111111', $bg ) ? '#FFFFFF' : '#111111';
	}

	public static function valid_hex( $v ) {
		return is_string( $v ) && preg_match( '/^#[0-9a-fA-F]{6}$/', $v );
	}

	/** Full token set for a design, with optional primary/accent overrides. */
	public static function resolve( $id, array $over = array() ) {
		$d = self::get( $id );
		if ( ! $d ) {
			return null;
		}
		$f   = self::families()[ $d['family'] ];
		$p   = $d['palette'];
		$warn = array();
		foreach ( array( 'primary', 'accent' ) as $k ) {
			if ( ! empty( $over[ $k ] ) && self::valid_hex( $over[ $k ] ) ) {
				$p[ $k ] = strtoupper( $over[ $k ] );
			}
		}
		$bg   = strtoupper( $p['bg'] );
		$text = strtoupper( $p['text'] );
		$t    = array(
			'primary'      => strtoupper( $p['primary'] ),
			'primary_dark' => self::mix( $p['primary'], '#000000', 0.22 ),
			'accent'       => strtoupper( $p['accent'] ),
			'bg'           => $bg,
			'surface'      => strtoupper( $p['surface'] ),
			'text'         => $text,
		);
		$t['on_primary'] = self::on( $t['primary'] );
		$t['on_accent']  = self::on( $t['accent'] );
		$m = 0.34;
		$t['muted'] = self::mix( $text, $bg, $m );
		while ( ( self::contrast( $t['muted'], $bg ) < 4.6 || self::contrast( $t['muted'], $t['surface'] ) < 4.6 ) && $m > 0.02 ) {
			$m         -= 0.04;
			$t['muted'] = self::mix( $text, $bg, max( 0, $m ) );
		}
		$t['border'] = self::mix( $bg, $text, 0.14 );
		if ( self::contrast( $t['primary'], $bg ) >= 4.5 ) {
			$t['link'] = $t['primary'];
		} elseif ( self::contrast( $t['accent'], $bg ) >= 4.5 ) {
			$t['link'] = $t['accent'];
			$warn[]    = 'The primary colour is too light/low-contrast on the page background for text links, so links use the accent colour.';
		} else {
			$t['link'] = $text;
			$warn[]    = 'Neither primary nor accent has enough contrast for text links on the page background; links use the body text colour with an underline.';
		}
		if ( self::contrast( $t['primary'], $t['bg'] ) < 3 ) {
			$warn[] = 'The primary colour is close to the page background; large blocks will look washed out. Consider a darker primary.';
		}
		$btn = $f['button'];
		$t['btn_radius'] = 'pill' === $btn ? '999px' : ( 'outline' === $btn ? '0' : max( 2, (int) $f['radius'] ) . 'px' );
		return array( 'design' => $d, 'family' => $f, 'tokens' => $t, 'warnings' => $warn );
	}

	/* ------------------------------------------------------------------ */
	/* CSS and brief                                                       */
	/* ------------------------------------------------------------------ */

	public static function css( array $r ) {
		$d = $r['design'];
		$f = $r['family'];
		$t = $r['tokens'];
		$h = $f['heading'];
		$big = 'bold' === $d['family'] ? 'clamp(2.6rem, 8vw, 6rem)' : 'clamp(2.1rem, 5vw, 3.5rem)';
		$css  = ':root{--cw-primary:' . $t['primary'] . ';--cw-primary-dark:' . $t['primary_dark'] . ';--cw-accent:' . $t['accent'] . ';--cw-bg:' . $t['bg'] . ';--cw-surface:' . $t['surface'] . ';--cw-text:' . $t['text'] . ';--cw-muted:' . $t['muted'] . ';--cw-border:' . $t['border'] . ';--cw-link:' . $t['link'] . ';--cw-on-primary:' . $t['on_primary'] . ';--cw-on-accent:' . $t['on_accent'] . ';';
		$css .= '--cw-radius:' . (int) $f['radius'] . 'px;--cw-radius-lg:' . (int) $f['radius_lg'] . 'px;--cw-btn-radius:' . $t['btn_radius'] . ';--cw-shadow:' . $f['shadow'] . ';--cw-section-y:' . $f['section_y'] . ';--cw-container:' . (int) $f['container'] . 'px;';
		$css .= '--cw-font-heading:' . $d['fonts']['heading']['stack'] . ';--cw-font-body:' . $d['fonts']['body']['stack'] . ";}\n";
		$css .= 'body{background:var(--cw-bg);color:var(--cw-text);font-family:var(--cw-font-body);font-size:1.0625rem;line-height:1.65}' . "\n";
		$css .= 'h1,h2,h3,h4,h5{font-family:var(--cw-font-heading);font-weight:' . (int) $h['weight'] . ';line-height:1.15;letter-spacing:' . $h['tracking'] . ';text-transform:' . $h['case'] . ';color:var(--cw-text);margin:0 0 .5em}' . "\n";
		$css .= 'h1{font-size:' . $big . '}h2{font-size:clamp(1.7rem,3.4vw,2.5rem)}h3{font-size:1.35rem}' . "\n";
		$css .= 'a{color:var(--cw-link)}a:focus-visible,.cw-btn:focus-visible{outline:3px solid var(--cw-accent);outline-offset:3px}' . "\n";
		$css .= '.cw-container{width:100%;max-width:var(--cw-container);margin:0 auto;padding:0 clamp(16px,4vw,32px);box-sizing:border-box}' . "\n";
		$css .= '.cw-section{padding:var(--cw-section-y) 0}.cw-section--alt{background:var(--cw-surface)}.cw-section--primary{background:var(--cw-primary);color:var(--cw-on-primary)}.cw-section--primary h1,.cw-section--primary h2,.cw-section--primary h3,.cw-section--primary a{color:inherit}' . "\n";
		$css .= '.cw-eyebrow{font-size:.8rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--cw-link);margin:0 0 .75rem}.cw-muted{color:var(--cw-muted)}.cw-rule{height:3px;width:56px;background:var(--cw-accent);border:0;margin:1rem 0}' . "\n";
		if ( 'outline' === $f['button'] ) {
			$css .= '.cw-btn{display:inline-block;padding:.8em 1.5em;border:1px solid var(--cw-text);border-radius:var(--cw-btn-radius);background:transparent;color:var(--cw-text);font-weight:600;text-decoration:none;transition:background .15s,color .15s}.cw-btn:hover{background:var(--cw-text);color:var(--cw-bg)}.cw-btn--accent{border-color:var(--cw-accent);color:var(--cw-accent)}.cw-btn--accent:hover{background:var(--cw-accent);color:var(--cw-on-accent)}.cw-btn--outline{}' . "\n";
		} else {
			$css .= '.cw-btn{display:inline-block;padding:.85em 1.7em;border:2px solid var(--cw-primary);border-radius:var(--cw-btn-radius);background:var(--cw-primary);color:var(--cw-on-primary);font-weight:700;text-decoration:none;transition:background .15s,border-color .15s}.cw-btn:hover{background:var(--cw-primary-dark);border-color:var(--cw-primary-dark);color:var(--cw-on-primary)}.cw-btn--accent{background:var(--cw-accent);border-color:var(--cw-accent);color:var(--cw-on-accent)}.cw-btn--accent:hover{filter:brightness(.92);background:var(--cw-accent);border-color:var(--cw-accent);color:var(--cw-on-accent)}.cw-btn--outline{background:transparent;color:var(--cw-link)}.cw-btn--outline:hover{background:var(--cw-primary);color:var(--cw-on-primary)}' . "\n";
		}
		$css .= '.cw-card{background:var(--cw-surface);border:1px solid var(--cw-border);border-radius:var(--cw-radius-lg);box-shadow:var(--cw-shadow);overflow:hidden}.cw-card__body{padding:1.4rem 1.5rem}.cw-grid{display:grid;gap:clamp(16px,3vw,32px);grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}' . "\n";
		$css .= '.cw-hero{position:relative;display:flex;align-items:center;min-height:' . ( 'bold' === $d['family'] ? '100vh' : '68vh' ) . '}.cw-hero--overlay{color:#fff}.cw-hero--overlay::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.25),' . self::mix( $t['primary_dark'], '#000000', 0.2 ) . 'CC)}.cw-hero--overlay>*{position:relative}.cw-hero--overlay h1{color:#fff}' . "\n";
		$css .= '@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}';
		return $css;
	}

	public static function brief( $id, array $over = array() ) {
		$r = self::resolve( $id, $over );
		if ( ! $r ) {
			return null;
		}
		$d = $r['design'];
		$f = $r['family'];
		$t = $r['tokens'];
		return array(
			'design'      => $d['id'],
			'name'        => $d['name'],
			'family'      => $d['family'],
			'family_name' => $f['name'],
			'mood'        => $f['mood'],
			'summary'     => $d['summary'],
			'colours'     => $t,
			'fonts'       => array(
				'heading' => $d['fonts']['heading']['family'],
				'body'    => $d['fonts']['body']['family'],
				'note'    => 'Use these Google fonts if the Oxygen settings allow adding fonts (check oxygen__get-settings); otherwise the CSS falls back to good system fonts, and you should tell the person the web fonts still need to be added.',
			),
			'shape'       => array( 'radius' => $f['radius'] . 'px', 'large_radius' => $f['radius_lg'] . 'px', 'buttons' => $f['button'], 'shadow' => $f['shadow'], 'headings' => $f['heading'] ),
			'css'         => self::css( $r ),
			'header'      => $f['header'],
			'hero'        => $f['hero'],
			'page_header' => $f['page_header'],
			'footer'      => $f['footer'],
			'home_sections' => $f['sections'],
			'warnings'    => $r['warnings'],
			'rules'       => array(
				'Use only the CSS variables (var(--cw-*)) and classes (.cw-*) in the CSS. Never introduce other colours or fonts; use primary for actions, accent sparingly, surface for alternating sections.',
				'Keep text on backgrounds at the contrast the tokens provide (use on_primary on primary blocks, on_accent on accent blocks).',
				'One H1 per page. Sections are full width with a .cw-container inside. Keep spacing from --cw-section-y.',
				'Use real photos from the media library for heroes and cards; never invent photos of people.',
				'Build responsive: check oxygen__get-breakpoints and make the hero, grids and header work on tablet and phone.',
			),
			'how_to_apply' => array(
				'Call oxygen__get-instructions once, and load oxygen__get-skill design-first-build (and building-templates for the header and footer).',
				'Enable the builder\'s Modern Normalize setting if it is off (oxygen__set-settings; see the Margins and padding section of the instructions).',
				'Add the "css" above as a global stylesheet with oxygen__insert-stylesheet (name it "Church design"), or put the :root variables in oxygen__insert-css-variables and the rest in the stylesheet.',
				'Fonts: see fonts.note.',
				'Create the site header and footer as Oxygen templates (oxygen__create-template) following "header" and "footer", set to display on the whole site, with the real menu and the church name/logo and contact details.',
				'Build the home page as a DRAFT from "home_sections", then preview it (oxygen__preview-post) on desktop and mobile widths and fix problems.',
				'Show the person the home page and wait for their approval before building other pages. Then build the rest in the same design.',
				'Call cwai__design-mark-applied when the styles, header, footer and home page are done.',
			),
		);
	}

	/* ------------------------------------------------------------------ */
	/* Selection                                                           */
	/* ------------------------------------------------------------------ */

	public static function selected() {
		$s = get_option( self::OPT );
		return is_array( $s ) && ! empty( $s['id'] ) && self::get( $s['id'] ) ? $s : null;
	}

	public static function select( $id, $primary = '', $accent = '' ) {
		if ( ! self::get( $id ) ) {
			return new WP_Error( 'cwai_design', 'Unknown design.' );
		}
		$prev = self::selected();
		$s    = array(
			'id'      => $id,
			'primary' => self::valid_hex( $primary ) ? strtoupper( $primary ) : '',
			'accent'  => self::valid_hex( $accent ) ? strtoupper( $accent ) : '',
			'applied' => $prev && $prev['id'] === $id ? ! empty( $prev['applied'] ) : false,
			'time'    => time(),
		);
		update_option( self::OPT, $s, false );
		return $s;
	}

	private static function overrides( array $s = null ) {
		$s = $s ?: self::selected();
		return $s ? array( 'primary' => $s['primary'] ?? '', 'accent' => $s['accent'] ?? '' ) : array();
	}

	public static function prompt_section() {
		$s = self::selected();
		if ( ! $s ) {
			return "## Site design\nNo design has been chosen for this site. When asked to build or rebuild a whole site, first offer the design library: cwai__design-list shows 25 designs in 5 families; the person can also pick one in the Design gallery (AI Assistant menu). Do not mention this for small edits.";
		}
		$r = self::resolve( $s['id'], self::overrides( $s ) );
		$t = $r['tokens'];
		$d = $r['design'];
		return '## Site design: ' . $d['name'] . ' (' . $r['family']['name'] . ")\n"
			. 'The person chose this design' . ( ! empty( $s['applied'] ) ? ' and its base styles, header, footer and home page have been applied.' : '; it has not been applied to the site yet.' ) . ' Everything you build must follow it: use the --cw-* variables and .cw-* classes from the design brief, never other colours or fonts. '
			. 'Key tokens: primary ' . $t['primary'] . ', accent ' . $t['accent'] . ', background ' . $t['bg'] . ', text ' . $t['text'] . '; headings ' . $d['fonts']['heading']['family'] . ', body ' . $d['fonts']['body']['family'] . '; ' . $r['family']['button'] . ' buttons. '
			. 'Call cwai__design-active for the full brief (CSS, header, hero, footer, section recipes) before the first build in a conversation.'
			. ( empty( $s['applied'] ) ? ' If asked to build the site or apply the design, follow its how_to_apply steps; call cwai__design-mark-applied afterwards.' : '' );
	}

	/* ------------------------------------------------------------------ */
	/* Assistant tools                                                     */
	/* ------------------------------------------------------------------ */

	public static function register_tools() {
		$p = array( 'CWAI_Tools_Content', 'p' );
		$s = array( 'CWAI_Tools_Content', 'schema' );
		$id = call_user_func( $p, 'string', 'Design id, e.g. modern-1 (from cwai__design-list).' );
		$pc = call_user_func( $p, 'string', 'Optional primary colour override as #RRGGBB (for example from the church logo).' );
		$ac = call_user_func( $p, 'string', 'Optional accent colour override as #RRGGBB.' );

		CWAI_Registry::add( 'cwai/design-list', array(
			'label' => 'Browse site designs', 'description' => 'List the 25 ready-made site designs (5 families: classic, modern, community, bold, minimal) with name, mood, colours and fonts. Offer these when the person wants a new or rebuilt site. They can also pick one in the Design gallery.',
			'input' => call_user_func( $s, array( 'family' => call_user_func( $p, 'string', 'classic, modern, community, bold or minimal. Omit for all.' ) ) ),
			'callback' => array( __CLASS__, 't_list' ), 'readonly' => true, 'capability' => 'edit_pages',
		) );
		CWAI_Registry::add( 'cwai/design-get', array(
			'label' => 'Read a site design', 'description' => 'Full build brief for one design (tokens, CSS, header, hero, footer, home section recipes, apply steps) without choosing it. Optional colour overrides show how it would look in the church\'s own colours.',
			'input' => call_user_func( $s, array( 'id' => $id, 'primary' => $pc, 'accent' => $ac ), array( 'id' ) ),
			'callback' => array( __CLASS__, 't_get' ), 'readonly' => true, 'capability' => 'edit_pages',
		) );
		CWAI_Registry::add( 'cwai/design-select', array(
			'label' => 'Choose the site design', 'description' => 'ADMIN. Choose the design for this site (optionally with the church\'s own primary/accent colours). The person approves it. Afterwards follow the returned how_to_apply steps. Only call this when the person has said which design they want.',
			'input' => call_user_func( $s, array( 'id' => $id, 'primary' => $pc, 'accent' => $ac ), array( 'id' ) ),
			'callback' => array( __CLASS__, 't_select' ), 'admin' => true, 'capability' => 'manage_options', 'approval' => true,
			'touches' => static function () {
				return array();
			},
		) );
		CWAI_Registry::add( 'cwai/design-active', array(
			'label' => 'Read the chosen design', 'description' => 'The design chosen for this site, with its full build brief. Call before the first build in a conversation when a design is chosen.',
			'input' => call_user_func( $s, array() ),
			'callback' => array( __CLASS__, 't_active' ), 'readonly' => true, 'capability' => 'edit_pages',
		) );
		CWAI_Registry::add( 'cwai/design-mark-applied', array(
			'label' => 'Record that the design is applied', 'description' => 'Record that the chosen design\'s styles, header, footer and home page have been built. Does not change the website.',
			'input' => call_user_func( $s, array( 'applied' => call_user_func( $p, 'boolean', 'true (default) or false.' ) ) ),
			'callback' => array( __CLASS__, 't_mark' ), 'capability' => 'edit_pages',
			'touches' => static function () {
				return array();
			},
		) );
	}

	public static function t_list( $in ) {
		$rows = array();
		foreach ( self::all() as $d ) {
			if ( ! empty( $in['family'] ) && $in['family'] !== $d['family'] ) {
				continue;
			}
			$f      = self::families()[ $d['family'] ];
			$rows[] = array(
				'id' => $d['id'], 'name' => $d['name'], 'family' => $d['family'], 'family_name' => $f['name'],
				'summary' => $d['summary'], 'mood' => $f['mood'], 'best_for' => $f['best_for'],
				'colours' => $d['palette'], 'fonts' => $d['fonts']['heading']['family'] . ' + ' . $d['fonts']['body']['family'],
			);
		}
		$sel = self::selected();
		return array( 'chosen' => $sel ? $sel['id'] : null, 'designs' => $rows );
	}

	public static function t_get( $in ) {
		$b = self::brief( (string) ( $in['id'] ?? '' ), array( 'primary' => $in['primary'] ?? '', 'accent' => $in['accent'] ?? '' ) );
		return $b ?: new WP_Error( 'cwai_design', 'Unknown design id. Use cwai__design-list.' );
	}

	public static function t_select( $in ) {
		$s = self::select( (string) ( $in['id'] ?? '' ), (string) ( $in['primary'] ?? '' ), (string) ( $in['accent'] ?? '' ) );
		if ( is_wp_error( $s ) ) {
			return $s;
		}
		return array( 'chosen' => $s['id'], 'brief' => self::brief( $s['id'], self::overrides( $s ) ) );
	}

	public static function t_active() {
		$s = self::selected();
		if ( ! $s ) {
			return array( 'chosen' => false, 'message' => 'No design has been chosen yet. Offer the options with cwai__design-list (or the Design gallery in the AI Assistant menu) and wait for the person to choose before building pages.' );
		}
		return array( 'chosen' => true, 'applied' => ! empty( $s['applied'] ), 'brief' => self::brief( $s['id'], self::overrides( $s ) ) );
	}

	public static function t_mark( $in ) {
		$s = self::selected();
		if ( ! $s ) {
			return array( 'chosen' => false, 'message' => 'No design is chosen, so there is nothing to mark.' );
		}
		$s['applied'] = ! array_key_exists( 'applied', (array) $in ) || ! empty( $in['applied'] );
		update_option( self::OPT, $s, false );
		return array( 'design' => $s['id'], 'applied' => $s['applied'] );
	}

	/* ------------------------------------------------------------------ */
	/* REST                                                                */
	/* ------------------------------------------------------------------ */

	public static function routes() {
		$a = static function () {
			return current_user_can( 'manage_options' ) && CWAI_Plugin::can_use();
		};
		register_rest_route( CWAI_REST::NS, '/design', array(
			array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'rest_get' ), 'permission_callback' => $a ),
			array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'rest_post' ), 'permission_callback' => $a ),
		) );
	}

	public static function rest_get() {
		$s = self::selected();
		return array( 'selected' => $s );
	}

	public static function rest_post( WP_REST_Request $r ) {
		if ( $r->get_param( 'clear' ) ) {
			delete_option( self::OPT );
			return array( 'selected' => null );
		}
		$s = self::select( (string) $r->get_param( 'id' ), (string) $r->get_param( 'primary' ), (string) $r->get_param( 'accent' ) );
		if ( is_wp_error( $s ) ) {
			return new WP_Error( 'cwai_design', $s->get_error_message(), array( 'status' => 400 ) );
		}
		return array( 'selected' => $s );
	}

	/* ------------------------------------------------------------------ */
	/* Gallery page                                                        */
	/* ------------------------------------------------------------------ */

	public static function menu() {
		add_submenu_page( 'cwai-chat', __( 'Design gallery', 'cwai' ), __( 'Design gallery', 'cwai' ), 'manage_options', 'cwai-designs', array( __CLASS__, 'render_page' ) );
	}

	public static function enqueue() {
		if ( ! isset( $_GET['page'] ) || 'cwai-designs' !== $_GET['page'] ) { // phpcs:ignore
			return;
		}
		wp_enqueue_style( 'cwai-designs', CWAI_URL . 'assets/designs.css', array(), CWAI_VERSION );
		wp_enqueue_script( 'cwai-designs', CWAI_URL . 'assets/designs.js', array(), CWAI_VERSION, true );
		$sel = self::selected();
		wp_localize_script( 'cwai-designs', 'CWAI_D', array(
			'root'     => esc_url_raw( rest_url( CWAI_REST::NS ) ),
			'nonce'    => wp_create_nonce( 'wp_rest' ),
			'selected' => $sel,
			'chat'     => admin_url( 'admin.php?page=cwai-chat' ),
		) );
	}

	/** Inline CSS variables for a resolved design (used by the previews). */
	public static function preview_vars( array $r ) {
		$t = $r['tokens'];
		$f = $r['family'];
		$d = $r['design'];
		$pairs = array(
			'p' => $t['primary'], 'pd' => $t['primary_dark'], 'a' => $t['accent'], 'bg' => $t['bg'], 's' => $t['surface'], 't' => $t['text'], 'm' => $t['muted'], 'b' => $t['border'],
			'op' => $t['on_primary'], 'oa' => $t['on_accent'], 'l' => $t['link'], 'r' => (int) $f['radius'] . 'px', 'rl' => (int) $f['radius_lg'] . 'px', 'br' => $t['btn_radius'],
			'sh' => $f['shadow'], 'hf' => $d['fonts']['heading']['stack'], 'bf' => $d['fonts']['body']['stack'], 'hw' => (int) $f['heading']['weight'], 'hc' => $f['heading']['case'],
		);
		$o = '';
		foreach ( $pairs as $k => $v ) {
			$o .= '--' . $k . ':' . esc_attr( $v ) . ';';
		}
		return $o;
	}

	public static function preview( array $r ) {
		$d    = $r['design'];
		$name = 'Grace Church';
		$h    = '<div class="cwd-p cwd-fam-' . esc_attr( $d['family'] ) . '" style="' . self::preview_vars( $r ) . '">';
		$h   .= '<div class="cwd-hd"><span class="cwd-logo">' . esc_html( $name ) . '</span><span class="cwd-nav"><i>About</i><i>Worship</i><i>Events</i><i>Contact</i></span><b class="cwd-hbtn">Visit</b></div>';
		$h   .= '<div class="cwd-hero"><div class="cwd-hero-t"><small>Sundays at 10:30</small><h4>Welcome home</h4><p>A place to belong, grow and serve.</p><span><b class="cwd-btn">Plan your visit</b><b class="cwd-btn o">Times</b></span></div><div class="cwd-hero-img"><u></u></div></div>';
		$h   .= '<div class="cwd-cards">';
		foreach ( array( array( 'Worship', 'Join us each week.' ), array( 'Families', 'Programs for all ages.' ), array( 'Serve', 'Make a difference.' ) ) as $c ) {
			$h .= '<div class="cwd-card"><div class="cwd-ci"></div><h5>' . esc_html( $c[0] ) . '</h5><p>' . esc_html( $c[1] ) . '</p></div>';
		}
		$h .= '</div><div class="cwd-ft"><span>' . esc_html( $name ) . '</span><i></i><i></i><i></i></div></div>';
		return $h;
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$fams = self::families();
		echo '<div class="wrap" id="cwai-designs"><h1>' . esc_html__( 'Design gallery', 'cwai' ) . '</h1>';
		echo '<p>' . esc_html__( 'Pick a look for the website. The assistant builds the styles, header, footer and pages to match, in your church\'s colours if you like. You can change your mind later.', 'cwai' ) . '</p>';
		echo '<div id="cwd-current" class="cwd-current" hidden></div>';
		echo '<div class="cwd-tabs"><button class="button button-primary" data-fam="">' . esc_html__( 'All 25', 'cwai' ) . '</button>';
		foreach ( $fams as $k => $f ) {
			echo '<button class="button" data-fam="' . esc_attr( $k ) . '">' . esc_html( $f['name'] ) . '</button>';
		}
		echo '</div><div class="cwd-grid">';
		foreach ( self::all() as $d ) {
			$r = self::resolve( $d['id'] );
			$f = $r['family'];
			echo '<div class="cwd-item" data-fam="' . esc_attr( $d['family'] ) . '" data-id="' . esc_attr( $d['id'] ) . '" data-p="' . esc_attr( $r['tokens']['primary'] ) . '" data-a="' . esc_attr( $r['tokens']['accent'] ) . '">';
			echo self::preview( $r ); // phpcs:ignore
			echo '<div class="cwd-meta"><h3>' . esc_html( $d['name'] ) . '</h3><span class="cwd-tag">' . esc_html( $f['name'] ) . '</span>';
			echo '<p>' . esc_html( $d['summary'] ) . '</p><p class="cwd-fonts">' . esc_html( $d['fonts']['heading']['family'] . ' + ' . $d['fonts']['body']['family'] ) . '</p>';
			echo '<div class="cwd-sw">';
			foreach ( array( $r['tokens']['primary'], $r['tokens']['accent'], $r['tokens']['bg'], $r['tokens']['surface'], $r['tokens']['text'] ) as $c ) {
				echo '<i style="background:' . esc_attr( $c ) . '" title="' . esc_attr( $c ) . '"></i>';
			}
			echo '</div><p class="cwd-feat">' . esc_html( implode( ' · ', $f['features'] ) ) . '</p>';
			echo '<button class="button button-primary cwd-choose">' . esc_html__( 'Choose this design', 'cwai' ) . '</button></div></div>';
		}
		echo '</div></div>';
	}
}
