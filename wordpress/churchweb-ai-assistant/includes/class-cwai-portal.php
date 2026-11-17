<?php
/**
 * Portal bridge: lets the ChurchWeb Portal talk to this site.
 *
 *  - REST over HTTPS (the bearer token is this site's own AI key, so there is nothing new to store):
 *      GET /wp-json/cwai/v1/portal/ping    version, what the bridge can do, import and build state
 *      GET /wp-json/cwai/v1/portal/build   the current build state only
 *  - WP-CLI over SSH (long jobs: no web time limit):
 *      wp cwai portal-ping
 *      wp cwai portal-build --package=<url> --brief=<url> --callback=<url> --token=<token> [--mode=preview|full]
 *      wp cwai portal-build --resume --answer="..." --callback=<url> --token=<token>
 *
 * A build downloads the exported package, imports its content and images, then runs the assistant on its own with the
 * team's design brief (approving its steps, never deleting), and reports progress, questions and the result to the portal.
 *
 * Conversation with the assistant:  it ends a message with  "QUESTION: ..."  when it truly needs a person,
 * and with  "DONE: ..."  when the site is built. Anything else means "keep going".
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class CWAI_Portal {

	const BRIDGE      = 3;
	const OPT         = 'cwai_portal_build';
	const MAX_ITER    = 600;   // assistant steps in one run
	const MAX_NUDGES  = 6;     // "keep going" reminders before giving up
	const MAX_SECONDS = 3300;  // 55 minutes per run

	/** Set after the portal could not be reached, so the rest of the run doesn't wait on it. */
	private static $callback_down = false;

	public static function boot() {
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
		add_action( 'init', array( __CLASS__, 'login_link' ), 1 );
		if ( defined( 'WP_CLI' ) && WP_CLI && class_exists( 'CWAI_Portal_CLI' ) ) {
			WP_CLI::add_command( 'cwai', 'CWAI_Portal_CLI' );
		}
	}

	/* ------------------------------------------------------------------ REST */

	public static function routes() {
		$auth = array( __CLASS__, 'authorized' );
		register_rest_route( CWAI_REST::NS, '/portal/ping', array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'rest_ping' ), 'permission_callback' => $auth ) );
		register_rest_route( CWAI_REST::NS, '/portal/build', array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'rest_build' ), 'permission_callback' => $auth ) );
	}

	/** The portal proves who it is with this site's own AI key. */
	public static function authorized( $request ) {
		$key = CWAI_Settings::api_key();
		$h   = (string) $request->get_header( 'authorization' );
		if ( '' === $key || 0 !== stripos( $h, 'bearer ' ) ) {
			return false;
		}
		return hash_equals( $key, trim( substr( $h, 7 ) ) );
	}

	public static function ping_data() {
		return array(
			'plugin'       => CWAI_VERSION,
			'bridge'       => self::BRIDGE,
			'capabilities' => array( 'build', 'resume' ),
			'zip'          => class_exists( 'ZipArchive' ),
			'import'       => CWAI_Import::status(),
			'build'        => self::state(),
		);
	}

	public static function rest_ping() {
		return self::ping_data();
	}

	public static function rest_build() {
		return self::state();
	}

	/* ------------------------------------------------------------------ state */

	public static function state() {
		$s = get_option( self::OPT );
		return is_array( $s ) ? $s : array( 'state' => 'idle' );
	}

	private static function save( array $patch ) {
		$s = array_merge( self::state(), $patch, array( 'updated' => time() ) );
		update_option( self::OPT, $s, false );
		return $s;
	}

	/** Save the state and tell the portal. Never throws: a missed message must not stop the build. */
	private static function report( array $o, $state, $message = '', $pct = null, array $extra = array() ) {
		self::save( array( 'state' => $state, 'message' => $message, 'pct' => $pct, 'question' => isset( $extra['question'] ) ? $extra['question'] : null ) );
		if ( empty( $o['callback'] ) || self::$callback_down ) {
			return;
		}
		$body = array_merge( array( 'state' => $state, 'message' => mb_substr( (string) $message, 0, 280 ), 'pct' => $pct ), $extra );
		$r = wp_remote_post( $o['callback'], array(
			'timeout' => 10,
			'headers' => array( 'Authorization' => 'Bearer ' . ( $o['token'] ?? '' ), 'Content-Type' => 'application/json' ),
			'body'    => wp_json_encode( $body ),
		) );
		if ( is_wp_error( $r ) ) {
			// The portal can't be reached from this server. Stop trying (each try would wait): the portal reads the saved state over SSH instead.
			self::$callback_down = true;
			self::save( array( 'callback_error' => $r->get_error_message() ) );
		}
	}

	/* ------------------------------------------------------------------ one-click sign-in */

	const LOGIN_TTL = 120; // seconds a sign-in link stays valid

	/** Make a single-use sign-in link for the first administrator (or the named user). Called over WP-CLI by the portal. */
	public static function make_login( $user_login = '' ) {
		$user = $user_login ? get_user_by( 'login', $user_login ) : get_user_by( 'id', self::admin_id() );
		if ( ! $user ) {
			return new WP_Error( 'cwai_no_user', 'No administrator was found to sign in as.' );
		}
		$token = bin2hex( random_bytes( 32 ) );
		set_transient( 'cwai_login_' . hash( 'sha256', $token ), (int) $user->ID, self::LOGIN_TTL );
		return add_query_arg( 'cwai_login', $token, home_url( '/' ) );
	}

	/** Visiting the link signs the person in once, then sends them to the dashboard. */
	public static function login_link() {
		if ( empty( $_GET['cwai_login'] ) || ! is_string( $_GET['cwai_login'] ) ) {
			return;
		}
		nocache_headers();
		$token = $_GET['cwai_login'];
		if ( ! preg_match( '/^[a-f0-9]{64}$/', $token ) ) {
			wp_die( 'This sign-in link is not valid.', 'Sign-in link', array( 'response' => 403 ) );
		}
		$key = 'cwai_login_' . hash( 'sha256', $token );
		$uid = (int) get_transient( $key );
		delete_transient( $key ); // single use, whatever happens next
		$user = $uid ? get_user_by( 'id', $uid ) : false;
		if ( ! $user ) {
			wp_die( 'This sign-in link has expired or was already used. Go back to the portal and press WP-Admin again.', 'Sign-in link', array( 'response' => 403 ) );
		}
		wp_clear_auth_cookie();
		wp_set_current_user( $user->ID );
		wp_set_auth_cookie( $user->ID, false );
		do_action( 'wp_login', $user->user_login, $user );
		// When the simple staff view is on, open the admin the way staff will see it (their colours and menu). "Exit staff preview" in the top bar goes back to the full admin.
		if ( class_exists( 'CWAI_StaffView' ) && user_can( $user, 'manage_options' ) ) {
			$sv = CWAI_StaffView::opts();
			if ( ! empty( $sv['enabled'] ) ) {
				update_user_meta( $user->ID, CWAI_StaffView::META, 1 );
			}
		}
		wp_safe_redirect( admin_url() );
		exit;
	}

	/* ------------------------------------------------------------------ the build */

	private static function admin_id() {
		$id = get_current_user_id();
		if ( $id && CWAI_Plugin::can_use( $id ) ) {
			return $id;
		}
		$ids = get_users( array( 'role' => 'administrator', 'number' => 1, 'orderby' => 'ID', 'order' => 'ASC', 'fields' => 'ID' ) );
		return $ids ? (int) $ids[0] : 0;
	}

	/** True when the portal put the file on this server itself (a path) instead of giving a link. */
	private static function is_local( $ref ) {
		return is_string( $ref ) && '' !== $ref && ! preg_match( '#^https?://#i', $ref ) && '/' === $ref[0] && is_readable( $ref );
	}

	private static function download( $url ) {
		require_once ABSPATH . 'wp-admin/includes/file.php';
		if ( self::is_local( $url ) ) {
			$tmp = wp_tempnam( 'cwai-package.zip' );
			if ( ! $tmp || ! @copy( $url, $tmp ) || ! filesize( $tmp ) ) { // phpcs:ignore
				return new WP_Error( 'cwai_tmp', 'Could not read the package the portal uploaded.' );
			}
			return $tmp;
		}
		$tmp = wp_tempnam( 'cwai-package.zip' );
		if ( ! $tmp ) {
			return new WP_Error( 'cwai_tmp', 'Could not make a temporary file.' );
		}
		$r = wp_remote_get( $url, array( 'timeout' => 900, 'stream' => true, 'filename' => $tmp, 'redirection' => 3 ) );
		if ( is_wp_error( $r ) ) {
			@unlink( $tmp ); // phpcs:ignore
			return $r;
		}
		$code = (int) wp_remote_retrieve_response_code( $r );
		if ( 200 !== $code || ! filesize( $tmp ) ) {
			@unlink( $tmp ); // phpcs:ignore
			return new WP_Error( 'cwai_dl', 'The portal did not send the package (HTTP ' . $code . '). The link may have expired.' );
		}
		return $tmp;
	}

	private static function fetch_text( $url ) {
		if ( self::is_local( $url ) ) {
			return (string) file_get_contents( $url ); // phpcs:ignore
		}
		$r = wp_remote_get( $url, array( 'timeout' => 60 ) );
		if ( is_wp_error( $r ) || 200 !== (int) wp_remote_retrieve_response_code( $r ) ) {
			return new WP_Error( 'cwai_brief', 'Could not read the design brief from the portal.' );
		}
		return (string) wp_remote_retrieve_body( $r );
	}

	/** Download, extract and load every image into the media library (the same work the Import screen does from the browser). */
	private static function import_package( array $o ) {
		self::report( $o, 'working', 'Downloading the content package…', 3 );
		$tmp = self::download( $o['package'] );
		if ( is_wp_error( $tmp ) ) {
			return $tmp;
		}
		self::report( $o, 'working', 'Reading the content package…', 6 );
		$res = CWAI_Import::extract( $tmp );
		@unlink( $tmp ); // phpcs:ignore
		if ( is_wp_error( $res ) ) {
			return $res;
		}
		$last = -1;
		$stall = 0;
		for ( $i = 0; $i < 600; $i++ ) {
			$s = CWAI_Import::rest_media();
			if ( is_wp_error( $s ) ) {
				return $s;
			}
			$total = (int) ( $s['media_total'] ?? 0 );
			$done  = (int) ( $s['media_done'] ?? 0 ) + count( (array) ( $s['media_failed'] ?? array() ) );
			if ( $total < 1 || $done >= $total ) {
				break;
			}
			self::report( $o, 'working', sprintf( 'Adding images to the media library (%d of %d)…', $done, $total ), 8 + (int) round( 22 * $done / $total ) );
			$stall = ( $done === $last ) ? $stall + 1 : 0;
			$last  = $done;
			if ( $stall >= 4 ) {
				break; // some files cannot be imported: carry on without them
			}
		}
		return CWAI_Import::status();
	}

	private static function last_text( $conv_id ) {
		$c = CWAI_Store::get_conversation( (int) $conv_id );
		if ( ! $c ) {
			return '';
		}
		for ( $i = count( $c['messages'] ) - 1; $i >= 0; $i-- ) {
			$m = $c['messages'][ $i ];
			if ( 'assistant' !== ( $m['role'] ?? '' ) ) {
				continue;
			}
			$t = '';
			foreach ( (array) ( $m['content'] ?? array() ) as $b ) {
				if ( 'text' === ( $b['type'] ?? '' ) ) {
					$t .= $b['text'] . "\n";
				}
			}
			if ( '' !== trim( $t ) ) {
				return trim( $t );
			}
		}
		return '';
	}

	/** Approve what the assistant wants to do, except anything that deletes. */
	private static function approve_pending( $uid, $conv_id ) {
		$c = CWAI_Store::get_conversation( (int) $conv_id );
		$d = array();
		foreach ( (array) ( $c['pending']['tool_uses'] ?? array() ) as $tu ) {
			$name   = (string) ( $tu['name'] ?? '' );
			$status = (string) ( $tu['input']['status'] ?? ( $tu['input']['post_status'] ?? '' ) );
			$d[ $tu['id'] ] = ! ( false !== strpos( $name, 'delete' ) || in_array( $status, array( 'trash', 'delete' ), true ) );
		}
		return CWAI_Agent::approve( $uid, (int) $conv_id, $d );
	}

	/** Parse the assistant's closing message. Returns array( 'question'|'done'|'', text, options ). */
	public static function verdict( $text ) {
		$text = (string) $text;
		if ( preg_match( '/^[ \t]*QUESTION:/im', $text, $m, PREG_OFFSET_CAPTURE ) ) {
			$q   = trim( substr( $text, $m[0][1] + strlen( $m[0][0] ) ) );
			$opt = array();
			if ( preg_match( '/\n[ \t]*OPTIONS:[ \t]*(.+)$/is', $q, $om ) ) {
				$q   = trim( substr( $q, 0, strlen( $q ) - strlen( $om[0] ) ) );
				$opt = array_values( array_filter( array_map( 'trim', explode( '|', trim( $om[1] ) ) ) ) );
			}
			return array( 'question', $q, array_slice( $opt, 0, 6 ) );
		}
		if ( preg_match( '/^[ \t]*DONE:[ \t]*(.+)$/im', $text, $m ) ) {
			return array( 'done', trim( $m[1] ), array() );
		}
		return array( '', '', array() );
	}

	/**
	 * Run (or resume) a build. $o: package, brief, callback, token, mode, resume, answer.
	 * Returns array( 'state' => done|question|failed ).
	 */
	public static function run_build( array $o ) {
		@set_time_limit( 0 ); // phpcs:ignore
		ignore_user_abort( true );
		$started = time();
		$uid     = self::admin_id();
		if ( ! $uid ) {
			self::report( $o, 'failed', 'This site has no administrator the assistant can work as.' );
			return array( 'state' => 'failed' );
		}
		wp_set_current_user( $uid );
		if ( ! CWAI_Settings::api_key() ) {
			self::report( $o, 'failed', 'The AI Assistant is not connected on this site yet.' );
			return array( 'state' => 'failed' );
		}

		$resume = ! empty( $o['resume'] );
		$cid    = 0;
		if ( $resume ) {
			$cid = (int) ( self::state()['conv_id'] ?? 0 );
			$msg = trim( (string) ( $o['answer'] ?? '' ) );
			if ( ! $cid || '' === $msg ) {
				self::report( $o, 'failed', 'There is no build waiting for an answer on this site.' );
				return array( 'state' => 'failed' );
			}
			$msg = 'The team answered: ' . $msg . "\n\nCarry on building.";
			self::report( $o, 'working', 'Thanks. Carrying on with the build…', null );
		} else {
			if ( empty( $o['package'] ) || empty( $o['brief'] ) ) {
				self::report( $o, 'failed', 'The portal did not send the package and brief.' );
				return array( 'state' => 'failed' );
			}
			self::save( array( 'conv_id' => 0, 'mode' => $o['mode'] ?? 'preview', 'started' => time() ) );
			$imp = self::import_package( $o );
			if ( is_wp_error( $imp ) ) {
				self::report( $o, 'failed', $imp->get_error_message() );
				return array( 'state' => 'failed' );
			}
			$brief = self::fetch_text( $o['brief'] );
			if ( is_wp_error( $brief ) ) {
				self::report( $o, 'failed', $brief->get_error_message() );
				return array( 'state' => 'failed' );
			}
			$msg = $brief . "\n\nThe old site's package is loaded and its images are already in the media library. Start now.";
			self::report( $o, 'working', 'Content imported. The AI is planning the design…', 32 );
		}

		$nudges = 0;
		for ( $i = 0; $i < self::MAX_ITER; $i++ ) {
			if ( time() - $started > self::MAX_SECONDS ) {
				self::report( $o, 'failed', 'The build ran out of time. Press Try again to carry on.' );
				return array( 'state' => 'failed' );
			}
			$res = CWAI_Agent::step( $uid, array( 'conversation_id' => $cid, 'message' => $msg, 'attachments' => array(), 'context' => array(), 'model' => '' ) );
			$msg = '';
			if ( is_wp_error( $res ) ) {
				self::report( $o, 'failed', $res->get_error_message() );
				return array( 'state' => 'failed' );
			}
			$cid = (int) $res['conversation_id'];
			self::save( array( 'conv_id' => $cid ) );
			$status = $res['status'];
			if ( 'needs_approval' === $status ) {
				$res = self::approve_pending( $uid, $cid );
				if ( is_wp_error( $res ) ) {
					self::report( $o, 'failed', $res->get_error_message() );
					return array( 'state' => 'failed' );
				}
				$status = $res['status'];
			}
			if ( 'continue' === $status || 'needs_approval' === $status ) {
				if ( 0 === $i % 3 ) {
					self::report( $o, 'working', 'The AI is building the site… (step ' . ( $i + 1 ) . ')', min( 92, 32 + (int) floor( $i * 0.6 ) ) );
				}
				continue;
			}
			// the assistant stopped talking: a question, the end, or neither
			$text = self::last_text( $cid );
			list( $kind, $body, $options ) = self::verdict( $text );
			if ( 'question' === $kind ) {
				self::report( $o, 'question', 'The AI needs an answer to carry on.', null, array( 'question' => array( 'text' => $body, 'options' => $options ) ) );
				return array( 'state' => 'question' );
			}
			if ( 'done' === $kind ) {
				self::report( $o, 'done', $body, 100 );
				return array( 'state' => 'done' );
			}
			if ( ++$nudges > self::MAX_NUDGES ) {
				self::report( $o, 'failed', 'The AI stopped without finishing the site. Press Try again.' );
				return array( 'state' => 'failed' );
			}
			$msg = 'Keep going until the site is built. When completely finished, end your message with a line starting DONE: and a short summary. If you cannot go on without a person, end with a line starting QUESTION: and one clear question.';
		}
		self::report( $o, 'failed', 'The build took more steps than allowed. Press Try again to carry on.' );
		return array( 'state' => 'failed' );
	}
}

if ( defined( 'WP_CLI' ) && WP_CLI ) {
	/** Portal commands. */
	class CWAI_Portal_CLI extends WP_CLI_Command {

		/**
		 * Print the saved state of the last portal build as JSON (the portal reads this over SSH).
		 *
		 * @subcommand portal-status
		 */
		public function portal_status( $args, $assoc ) {
			WP_CLI::print_value( CWAI_Portal::state(), array( 'format' => 'json' ) );
		}

		/**
		 * Print a single-use sign-in link (good for two minutes) for the first administrator.
		 *
		 * ## OPTIONS
		 *
		 * [--user=<login>]
		 * : Sign in as this user instead.
		 *
		 * ## EXAMPLES
		 *     wp cwai portal-login
		 *
		 * @subcommand portal-login
		 */
		public function portal_login( $args, $assoc ) {
			$url = CWAI_Portal::make_login( isset( $assoc['user'] ) ? (string) $assoc['user'] : '' );
			if ( is_wp_error( $url ) ) {
				WP_CLI::error( $url->get_error_message() );
			}
			WP_CLI::line( $url );
		}

		/**
		 * Show what the portal bridge can do on this site.
		 *
		 * ## EXAMPLES
		 *     wp cwai portal-ping
		 *
		 * @subcommand portal-ping
		 */
		public function portal_ping( $args, $assoc ) {
			WP_CLI::print_value( CWAI_Portal::ping_data(), array( 'format' => 'json' ) );
		}

		/**
		 * Build the site from an exported package, on its own, and report to the portal.
		 *
		 * ## OPTIONS
		 *
		 * [--package=<url-or-path>]
		 * : Signed link to the export ZIP, or its path on this server.
		 *
		 * [--brief=<url-or-path>]
		 * : Signed link to the design brief, or its path on this server.
		 *
		 * [--callback=<url>]
		 * : Where to report progress.
		 *
		 * [--token=<token>]
		 * : Bearer token for the callback.
		 *
		 * [--mode=<mode>]
		 * : preview or full.
		 *
		 * [--resume]
		 * : Carry on an earlier build after a question.
		 *
		 * [--answer=<text>]
		 * : The team's answer (with --resume).
		 *
		 * @subcommand portal-build
		 */
		public function portal_build( $args, $assoc ) {
			$o = array(
				'package'  => (string) ( $assoc['package'] ?? '' ),
				'brief'    => (string) ( $assoc['brief'] ?? '' ),
				'callback' => (string) ( $assoc['callback'] ?? '' ),
				'token'    => (string) ( $assoc['token'] ?? '' ),
				'mode'     => 'full' === ( $assoc['mode'] ?? '' ) ? 'full' : 'preview',
				'resume'   => ! empty( $assoc['resume'] ),
				'answer'   => (string) ( $assoc['answer'] ?? '' ),
			);
			$r = CWAI_Portal::run_build( $o );
			WP_CLI::log( 'portal-build: ' . $r['state'] );
		}
	}
}
