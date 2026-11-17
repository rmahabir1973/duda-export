<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Saved routines: named, reusable instructions for recurring jobs (a weekly update from a bulletin or newsletter,
 * a monthly post, a site check-up). They appear as one-click starters in the chat, and administrators can edit them
 * or ask the assistant to save a new one.
 */
final class CWAI_Routines {

	const OPT = 'cwai_routines';
	const MAX = 12;

	public static function boot() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 26 );
		add_action( 'admin_post_cwai_routines', array( __CLASS__, 'handle_save' ) );
	}

	public static function defaults() {
		return array(
			array(
				'id'     => 'weekly-update',
				'name'   => 'Weekly update from the bulletin',
				'prompt' => "Do this week's website update from the bulletin, newsletter or notes I have attached or pasted.\n1. Read it carefully and list what affects the website: this week's message or sermon, upcoming events, announcements, service times and news.\n2. Compare with what is already on the site (cwai__find-content, cwai__search-site-text) so you update existing items instead of creating duplicates.\n3. Make the changes. New items go in as drafts for me to check.\n4. Never invent details that are not in the source (dates, times, names, scripture). If something is unclear, list it for me instead of guessing.\n5. Finish with a short list of exactly what you changed or added, with links, and anything you could not find.",
			),
			array(
				'id'     => 'newsletter-to-post',
				'name'   => 'Turn a newsletter into a blog post',
				'prompt' => "Turn the text or document I attached into a blog post. Keep the author's words and facts. Write a clear title, add headings where they help, write a one or two sentence excerpt, choose a category, pick a featured image from the media library (or tell me what is missing), set the search listing, and save it as a draft. Show me the draft link.",
			),
			array(
				'id'     => 'site-checkup',
				'name'   => 'Site check-up',
				'prompt' => "Run a site health check. Fix the safe things (missing image alt text, missing search listings) and tell me exactly what you changed. For everything else, list it in priority order and ask what I want to do.",
			),
			array(
				'id'     => 'launch-prep',
				'name'   => 'Get this site ready to launch',
				'prompt' => "Get this site ready to go live. Run the go-live check and the site health check, fix what is safe, and give me a short ordered list of what is left for me to do. Do not switch the site live yourself; tell me when everything is ready.",
			),
		);
	}

	public static function all() {
		$o = get_option( self::OPT, null );
		return is_array( $o ) ? $o : self::defaults();
	}

	private static function clean( $id, $name, $prompt ) {
		$name   = trim( mb_substr( wp_strip_all_tags( (string) $name ), 0, 60 ) );
		$prompt = trim( mb_substr( (string) $prompt, 0, 3000 ) );
		$prompt = preg_replace( "/\r\n?/", "\n", $prompt );
		if ( '' === $name || '' === $prompt ) {
			return null;
		}
		$id = sanitize_title( $id ?: $name );
		return array( 'id' => $id ?: 'routine', 'name' => $name, 'prompt' => $prompt );
	}

	public static function save_all( array $list ) {
		$out  = array();
		$seen = array();
		foreach ( $list as $r ) {
			$c = self::clean( $r['id'] ?? '', $r['name'] ?? '', $r['prompt'] ?? '' );
			if ( ! $c ) {
				continue;
			}
			$base = $c['id'];
			$n    = 2;
			while ( isset( $seen[ $c['id'] ] ) ) {
				$c['id'] = $base . '-' . $n++;
			}
			$seen[ $c['id'] ] = true;
			$out[]            = $c;
			if ( count( $out ) >= self::MAX ) {
				break;
			}
		}
		update_option( self::OPT, $out, false );
		return $out;
	}

	/** One-click starters for the chat panel. */
	public static function chips() {
		$out = array();
		foreach ( array_slice( self::all(), 0, 4 ) as $r ) {
			$out[] = array( 'label' => $r['name'], 'prompt' => $r['prompt'] );
		}
		return $out;
	}

	/* ------------------------------------------------------------------ */
	/* Tools                                                               */
	/* ------------------------------------------------------------------ */

	public static function register_tools() {
		$p = array( 'CWAI_Tools_Content', 'p' );
		$s = array( 'CWAI_Tools_Content', 'schema' );
		CWAI_Registry::add( 'cwai/list-routines', array(
			'label'       => 'List saved routines',
			'description' => 'List the saved routines (named, reusable instructions for recurring jobs such as the weekly update). Returns id, name and the full instruction text.',
			'input'       => array(),
			'callback'    => array( __CLASS__, 't_list' ),
			'readonly'    => true,
		) );
		CWAI_Registry::add( 'cwai/save-routine', array(
			'label'       => 'Save a routine',
			'description' => 'Create or update a saved routine so the person can run a recurring job in one click. Pass id to update an existing routine, otherwise a new one is added (max ' . self::MAX . '). Write the prompt as the instruction you would want to receive: numbered steps, what to check, what never to guess, and what to report back.',
			'input'       => call_user_func( $s, array(
				'id'     => call_user_func( $p, 'string', 'Existing routine id to replace (optional).' ),
				'name'   => call_user_func( $p, 'string', 'Short name shown on the button, max 60 characters.' ),
				'prompt' => call_user_func( $p, 'string', 'The full instruction.' ),
			), array( 'name', 'prompt' ) ),
			'callback'    => array( __CLASS__, 't_save' ),
			'admin'       => true,
			'capability'  => 'manage_options',
		) );
		CWAI_Registry::add( 'cwai/delete-routine', array(
			'label'       => 'Delete a routine',
			'description' => 'Delete a saved routine by id.',
			'input'       => call_user_func( $s, array( 'id' => call_user_func( $p, 'string', 'Routine id from cwai__list-routines.' ) ), array( 'id' ) ),
			'callback'    => array( __CLASS__, 't_delete' ),
			'admin'       => true,
			'capability'  => 'manage_options',
		) );
	}

	public static function t_list() {
		return array( 'routines' => self::all() );
	}

	public static function t_save( $in ) {
		$c = self::clean( $in['id'] ?? '', $in['name'] ?? '', $in['prompt'] ?? '' );
		if ( ! $c ) {
			return new WP_Error( 'cwai_routine', 'A routine needs a name and instructions.' );
		}
		$list  = self::all();
		$found = false;
		foreach ( $list as &$r ) {
			if ( ! empty( $in['id'] ) && $r['id'] === sanitize_title( $in['id'] ) ) {
				$r     = $c;
				$found = true;
			}
		}
		unset( $r );
		if ( ! $found ) {
			if ( count( $list ) >= self::MAX ) {
				return new WP_Error( 'cwai_routine', 'There is a limit of ' . self::MAX . ' routines. Delete one first.' );
			}
			$list[] = $c;
		}
		$saved = self::save_all( $list );
		return array( 'saved' => true, 'routines' => wp_list_pluck( $saved, 'name', 'id' ) );
	}

	public static function t_delete( $in ) {
		$id   = sanitize_title( $in['id'] ?? '' );
		$list = array_values( array_filter( self::all(), static function ( $r ) use ( $id ) {
			return $r['id'] !== $id;
		} ) );
		if ( count( $list ) === count( self::all() ) ) {
			return new WP_Error( 'cwai_routine', 'No routine with that id.' );
		}
		self::save_all( $list );
		return array( 'deleted' => true );
	}

	public static function prompt_section() {
		$names = wp_list_pluck( self::all(), 'name' );
		$s     = "## Routines and weekly updates\n- The person can start saved routines with one click (" . ( $names ? implode( '; ', array_map( static function ( $n ) {
			return '"' . $n . '"';
		}, $names ) ) : 'none saved yet' ) . '). If they ask for one by name, read it with cwai__list-routines and follow it.';
		$s .= "\n- Weekly bulletin, newsletter or notes (attached PDFs, photos, documents or pasted text): read the whole source first, extract only what is there, update existing items rather than duplicating them, make new items drafts, never invent dates, times, names or scripture, and finish with a plain list of what you changed with links and what you could not find or were unsure about.";
		$s .= "\n- If the person describes a job they do again and again, offer to save it as a routine with cwai__save-routine (administrators only).";
		return $s;
	}

	/* ------------------------------------------------------------------ */
	/* Admin page                                                          */
	/* ------------------------------------------------------------------ */

	public static function menu() {
		add_submenu_page( 'cwai-chat', __( 'Routines', 'cwai' ), __( 'Routines', 'cwai' ), 'manage_options', 'cwai-routines', array( __CLASS__, 'render_page' ) );
	}

	public static function handle_save() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Not allowed.', 'cwai' ) );
		}
		check_admin_referer( 'cwai_routines' );
		$names   = isset( $_POST['name'] ) ? (array) wp_unslash( $_POST['name'] ) : array(); // phpcs:ignore
		$prompts = isset( $_POST['prompt'] ) ? (array) wp_unslash( $_POST['prompt'] ) : array(); // phpcs:ignore
		$ids     = isset( $_POST['rid'] ) ? (array) wp_unslash( $_POST['rid'] ) : array(); // phpcs:ignore
		$del     = isset( $_POST['del'] ) ? array_map( 'strval', (array) wp_unslash( $_POST['del'] ) ) : array(); // phpcs:ignore
		$list    = array();
		foreach ( $names as $i => $n ) {
			if ( in_array( (string) $i, $del, true ) ) {
				continue;
			}
			$list[] = array( 'id' => $ids[ $i ] ?? '', 'name' => $n, 'prompt' => $prompts[ $i ] ?? '' );
		}
		self::save_all( $list );
		wp_safe_redirect( add_query_arg( 'saved', 1, admin_url( 'admin.php?page=cwai-routines' ) ) );
		exit;
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$list   = self::all();
		$list[] = array( 'id' => '', 'name' => '', 'prompt' => '' );
		echo '<div class="wrap"><h1>' . esc_html__( 'Routines', 'cwai' ) . '</h1>';
		if ( ! empty( $_GET['saved'] ) ) { // phpcs:ignore
			echo '<div class="notice notice-success is-dismissible"><p>' . esc_html__( 'Saved.', 'cwai' ) . '</p></div>';
		}
		echo '<p class="description" style="max-width:780px">' . esc_html__( 'A routine is a saved instruction for a job you repeat, such as the weekly update. The first four appear as buttons in the assistant chat. Leave the last box empty unless you are adding one.', 'cwai' ) . '</p>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '"><input type="hidden" name="action" value="cwai_routines">';
		wp_nonce_field( 'cwai_routines' );
		foreach ( $list as $i => $r ) {
			echo '<div class="card" style="max-width:900px;margin:10px 0;padding:10px 14px"><input type="hidden" name="rid[' . (int) $i . ']" value="' . esc_attr( $r['id'] ) . '">';
			echo '<p><label><strong>' . esc_html__( 'Name', 'cwai' ) . '</strong><br><input type="text" class="regular-text" maxlength="60" name="name[' . (int) $i . ']" value="' . esc_attr( $r['name'] ) . '"></label></p>';
			echo '<p><label><strong>' . esc_html__( 'Instructions for the assistant', 'cwai' ) . '</strong><br><textarea class="large-text" rows="6" name="prompt[' . (int) $i . ']">' . esc_textarea( $r['prompt'] ) . '</textarea></label></p>';
			if ( $r['id'] ) {
				echo '<p><label><input type="checkbox" name="del[]" value="' . (int) $i . '"> ' . esc_html__( 'Delete this routine', 'cwai' ) . '</label></p>';
			}
			echo '</div>';
		}
		submit_button( __( 'Save routines', 'cwai' ) );
		echo '</form></div>';
	}
}
