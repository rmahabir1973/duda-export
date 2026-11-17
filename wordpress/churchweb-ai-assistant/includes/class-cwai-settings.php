<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Settings: API key (encrypted at rest), model selection, behaviour switches.
 */
final class CWAI_Settings {

	const OPT = 'cwai_settings';

	public static function defaults() {
		return array(
			'api_key_enc'     => '',
			'api_base_url'    => 'https://api.anthropic.com',
			'model'           => 'claude-sonnet-5-5',
			'custom_model'    => '',
			'allow_user_model' => 1,
			'max_tokens'      => 16000,
			'max_steps'       => 30,
			'roles'           => array( 'administrator', 'editor' ),
			'brand_name'      => 'Site Assistant',
			'church_profile'  => '',
			'show_frontend'   => 1,
			'approve_publish' => 0,
			'auto_draft'      => 1,
			'auto_seo'        => 1,
			'purge_cache'     => 1,
			'web_search'      => 0,
			'daily_token_cap' => 0,
			'editor_full'     => 0,
			'staff_elevate'   => 1,
			'extra_prefixes'  => '',
			'update_manifest' => '',
			'auto_update'     => 1,
			'retention_days'  => 90,
		);
	}

	public static function get( $key = null ) {
		$s = wp_parse_args( get_option( self::OPT, array() ), self::defaults() );
		return null === $key ? $s : ( $s[ $key ] ?? null );
	}

	/** The model id actually used. */
	public static function model( $override = '' ) {
		$allowed = self::model_ids();
		if ( $override && self::get( 'allow_user_model' ) && in_array( $override, $allowed, true ) ) {
			return $override;
		}
		$custom = trim( (string) self::get( 'custom_model' ) );
		return $custom ? $custom : (string) self::get( 'model' );
	}

	public static function known_models() {
		$base = array(
			'claude-sonnet-5-5' => 'Claude Sonnet 5.5 (recommended)',
			'claude-haiku-5-5'  => 'Claude Haiku 5.5 (fastest, lowest cost)',
			'claude-opus-5-5'   => 'Claude Opus 5.5 (most capable)',
			'claude-fable-5-1'  => 'Claude Fable 5.1 (highest capability)',
		);
		$live = get_transient( 'cwai_models' );
		if ( is_array( $live ) ) {
			foreach ( $live as $id => $label ) {
				if ( ! isset( $base[ $id ] ) ) {
					$base[ $id ] = $label;
				}
			}
		}
		return apply_filters( 'cwai_models', $base );
	}

	public static function model_ids() {
		$ids = array_keys( self::known_models() );
		$c   = trim( (string) self::get( 'custom_model' ) );
		if ( $c ) {
			$ids[] = $c;
		}
		return $ids;
	}

	/* ---------- API key ---------- */

	private static function crypto_key() {
		$salt = ( defined( 'AUTH_KEY' ) ? AUTH_KEY : '' ) . ( defined( 'SECURE_AUTH_KEY' ) ? SECURE_AUTH_KEY : '' ) . 'cwai';
		return hash( 'sha256', $salt, true );
	}

	public static function encrypt( $plain ) {
		if ( '' === $plain ) {
			return '';
		}
		if ( function_exists( 'sodium_crypto_secretbox' ) ) {
			$nonce = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
			return 's:' . base64_encode( $nonce . sodium_crypto_secretbox( $plain, $nonce, self::crypto_key() ) );
		}
		if ( function_exists( 'openssl_encrypt' ) ) {
			$iv = random_bytes( 16 );
			return 'o:' . base64_encode( $iv . openssl_encrypt( $plain, 'aes-256-cbc', self::crypto_key(), OPENSSL_RAW_DATA, $iv ) );
		}
		return 'p:' . base64_encode( $plain );
	}

	public static function decrypt( $stored ) {
		if ( ! $stored || strlen( $stored ) < 3 ) {
			return '';
		}
		$mode = substr( $stored, 0, 2 );
		$raw  = base64_decode( substr( $stored, 2 ), true );
		if ( false === $raw ) {
			return '';
		}
		if ( 's:' === $mode && function_exists( 'sodium_crypto_secretbox_open' ) ) {
			$n = SODIUM_CRYPTO_SECRETBOX_NONCEBYTES;
			$p = sodium_crypto_secretbox_open( substr( $raw, $n ), substr( $raw, 0, $n ), self::crypto_key() );
			return false === $p ? '' : $p;
		}
		if ( 'o:' === $mode && function_exists( 'openssl_decrypt' ) ) {
			$p = openssl_decrypt( substr( $raw, 16 ), 'aes-256-cbc', self::crypto_key(), OPENSSL_RAW_DATA, substr( $raw, 0, 16 ) );
			return false === $p ? '' : $p;
		}
		return 'p:' === $mode ? $raw : '';
	}

	/** wp-config.php constant wins; recommended for fleets. */
	public static function api_key() {
		if ( defined( 'CWAI_API_KEY' ) && CWAI_API_KEY ) {
			return trim( CWAI_API_KEY );
		}
		return trim( self::decrypt( (string) self::get( 'api_key_enc' ) ) );
	}

	public static function key_source() {
		if ( defined( 'CWAI_API_KEY' ) && CWAI_API_KEY ) {
			return 'constant';
		}
		return self::get( 'api_key_enc' ) ? 'database' : 'none';
	}

	public static function base_url() {
		if ( defined( 'CWAI_API_BASE_URL' ) && CWAI_API_BASE_URL ) {
			return untrailingslashit( CWAI_API_BASE_URL );
		}
		return untrailingslashit( self::get( 'api_base_url' ) ?: 'https://api.anthropic.com' );
	}

	/* ---------- admin screen ---------- */

	public static function boot() {
		add_action( 'admin_init', array( __CLASS__, 'register' ) );
	}

	public static function register() {
		register_setting( 'cwai', self::OPT, array( 'sanitize_callback' => array( __CLASS__, 'sanitize' ) ) );
	}

	public static function sanitize( $in ) {
		$cur = self::get();
		$out = $cur;
		$in  = is_array( $in ) ? wp_unslash( $in ) : array();

		if ( ! empty( $in['remove_key'] ) ) {
			$out['api_key_enc'] = '';
		} elseif ( ! empty( $in['api_key_new'] ) ) {
			$out['api_key_enc'] = self::encrypt( trim( $in['api_key_new'] ) );
		}
		$out['api_base_url']  = esc_url_raw( $in['api_base_url'] ?? $cur['api_base_url'] ) ?: 'https://api.anthropic.com';
		$out['model']         = sanitize_text_field( $in['model'] ?? $cur['model'] );
		$out['custom_model']  = preg_replace( '/[^A-Za-z0-9._:\-]/', '', $in['custom_model'] ?? '' );
		foreach ( array( 'allow_user_model', 'show_frontend', 'approve_publish', 'auto_draft', 'auto_seo', 'purge_cache', 'web_search', 'editor_full', 'staff_elevate' ) as $b ) {
			$out[ $b ] = empty( $in[ $b ] ) ? 0 : 1;
		}
		$out['max_tokens']      = min( 64000, max( 2000, (int) ( $in['max_tokens'] ?? $cur['max_tokens'] ) ) );
		$out['max_steps']       = min( 100, max( 3, (int) ( $in['max_steps'] ?? $cur['max_steps'] ) ) );
		$out['daily_token_cap'] = max( 0, (int) ( $in['daily_token_cap'] ?? 0 ) );
		$out['retention_days']  = min( 365, max( 7, (int) ( $in['retention_days'] ?? 90 ) ) );
		$out['roles']           = array_values( array_intersect( array_keys( wp_roles()->roles ), (array) ( $in['roles'] ?? array() ) ) );
		$out['brand_name']      = sanitize_text_field( $in['brand_name'] ?? 'Site Assistant' ) ?: 'Site Assistant';
		$out['church_profile']  = sanitize_textarea_field( $in['church_profile'] ?? '' );
		$out['extra_prefixes']  = sanitize_textarea_field( $in['extra_prefixes'] ?? '' );
		$out['update_manifest'] = esc_url_raw( $in['update_manifest'] ?? '' );
		$out['auto_update']     = ! empty( $in['auto_update'] ) ? 1 : 0;
		unset( $out['api_key_new'], $out['remove_key'] );
		return $out;
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$s      = self::get();
		$models = self::known_models();
		$name   = self::OPT;
		$src    = self::key_source();
		?>
		<div class="wrap cwai-settings">
			<h1><?php echo esc_html( $s['brand_name'] ); ?> &mdash; <?php esc_html_e( 'Settings', 'cwai' ); ?></h1>
			<form method="post" action="options.php">
				<?php settings_fields( 'cwai' ); ?>

				<h2><?php esc_html_e( 'Anthropic connection', 'cwai' ); ?></h2>
				<table class="form-table" role="presentation">
					<tr>
						<th><label for="cwai-key"><?php esc_html_e( 'Anthropic API key', 'cwai' ); ?></label></th>
						<td>
							<?php if ( 'constant' === $src ) : ?>
								<p><strong><?php esc_html_e( 'Set in wp-config.php (CWAI_API_KEY). This is the most secure option.', 'cwai' ); ?></strong></p>
							<?php else : ?>
								<input type="password" id="cwai-key" class="regular-text" name="<?php echo esc_attr( $name ); ?>[api_key_new]" autocomplete="new-password" placeholder="<?php echo 'database' === $src ? esc_attr__( '•••••••• saved (leave blank to keep)', 'cwai' ) : 'sk-ant-...'; ?>">
								<?php if ( 'database' === $src ) : ?>
									<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[remove_key]" value="1"> <?php esc_html_e( 'Remove saved key', 'cwai' ); ?></label>
								<?php endif; ?>
								<p class="description"><?php esc_html_e( 'Stored encrypted. For fleets, define CWAI_API_KEY in wp-config.php instead.', 'cwai' ); ?></p>
							<?php endif; ?>
							<p><button type="button" class="button" id="cwai-test"><?php esc_html_e( 'Test connection', 'cwai' ); ?></button> <span id="cwai-test-result"></span></p>
						</td>
					</tr>
					<tr>
						<th><label for="cwai-base"><?php esc_html_e( 'API base URL', 'cwai' ); ?></label></th>
						<td><input type="url" id="cwai-base" class="regular-text" name="<?php echo esc_attr( $name ); ?>[api_base_url]" value="<?php echo esc_attr( $s['api_base_url'] ); ?>">
						<p class="description"><?php esc_html_e( 'Leave as https://api.anthropic.com unless you route through your own gateway that holds the real key.', 'cwai' ); ?></p></td>
					</tr>
				</table>

				<h2><?php esc_html_e( 'AI model', 'cwai' ); ?></h2>
				<table class="form-table" role="presentation">
					<tr>
						<th><label for="cwai-model"><?php esc_html_e( 'Default model', 'cwai' ); ?></label></th>
						<td>
							<select id="cwai-model" name="<?php echo esc_attr( $name ); ?>[model]">
								<?php foreach ( $models as $id => $label ) : ?>
									<option value="<?php echo esc_attr( $id ); ?>" <?php selected( $s['model'], $id ); ?>><?php echo esc_html( $label ); ?></option>
								<?php endforeach; ?>
							</select>
							<button type="button" class="button" id="cwai-refresh-models"><?php esc_html_e( 'Refresh list from Anthropic', 'cwai' ); ?></button>
							<p class="description"><?php esc_html_e( 'Sonnet is the best balance for building pages. Haiku is faster and cheaper and is usually enough for text edits, blog posts, sermons and SEO.', 'cwai' ); ?></p>
						</td>
					</tr>
					<tr>
						<th><label for="cwai-custom"><?php esc_html_e( 'Custom model ID', 'cwai' ); ?></label></th>
						<td><input type="text" id="cwai-custom" class="regular-text" name="<?php echo esc_attr( $name ); ?>[custom_model]" value="<?php echo esc_attr( $s['custom_model'] ); ?>"> <p class="description"><?php esc_html_e( 'Optional. Overrides the default above (for example a dated snapshot).', 'cwai' ); ?></p></td>
					</tr>
					<tr>
						<th><?php esc_html_e( 'Model switcher', 'cwai' ); ?></th>
						<td><label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[allow_user_model]" value="1" <?php checked( $s['allow_user_model'] ); ?>> <?php esc_html_e( 'Let staff pick the model inside the chat', 'cwai' ); ?></label></td>
					</tr>
					<tr>
						<th><label for="cwai-mt"><?php esc_html_e( 'Limits', 'cwai' ); ?></label></th>
						<td>
							<?php esc_html_e( 'Max output tokens per step', 'cwai' ); ?> <input type="number" id="cwai-mt" name="<?php echo esc_attr( $name ); ?>[max_tokens]" value="<?php echo (int) $s['max_tokens']; ?>" min="2000" max="64000" style="width:90px">
							&nbsp; <?php esc_html_e( 'Max tool steps per request', 'cwai' ); ?> <input type="number" name="<?php echo esc_attr( $name ); ?>[max_steps]" value="<?php echo (int) $s['max_steps']; ?>" min="3" max="100" style="width:70px">
							&nbsp; <?php esc_html_e( 'Daily token cap (0 = none)', 'cwai' ); ?> <input type="number" name="<?php echo esc_attr( $name ); ?>[daily_token_cap]" value="<?php echo (int) $s['daily_token_cap']; ?>" min="0" style="width:110px">
							<p class="description"><?php printf( esc_html__( 'Tokens used today on this site: %s', 'cwai' ), esc_html( number_format_i18n( CWAI_Store::usage_today() ) ) ); ?></p>
						</td>
					</tr>
				</table>

				<h2><?php esc_html_e( 'About this church', 'cwai' ); ?></h2>
				<table class="form-table" role="presentation">
					<tr>
						<th><label for="cwai-brand"><?php esc_html_e( 'Assistant name', 'cwai' ); ?></label></th>
						<td><input type="text" id="cwai-brand" class="regular-text" name="<?php echo esc_attr( $name ); ?>[brand_name]" value="<?php echo esc_attr( $s['brand_name'] ); ?>"></td>
					</tr>
					<tr>
						<th><label for="cwai-profile"><?php esc_html_e( 'Church profile & voice', 'cwai' ); ?></label></th>
						<td><textarea id="cwai-profile" name="<?php echo esc_attr( $name ); ?>[church_profile]" rows="7" class="large-text" placeholder="<?php esc_attr_e( "Name, denomination, address, service times, pastor names, tone of voice (warm, plain language), things to never say...", 'cwai' ); ?>"><?php echo esc_textarea( $s['church_profile'] ); ?></textarea>
						<p class="description"><?php esc_html_e( 'Given to the assistant on every request so new content matches your church.', 'cwai' ); ?></p></td>
					</tr>
				</table>

				<h2><?php esc_html_e( 'Behaviour & safety', 'cwai' ); ?></h2>
				<table class="form-table" role="presentation">
					<tr>
						<th><?php esc_html_e( 'Who can use it', 'cwai' ); ?></th>
						<td>
							<?php foreach ( wp_roles()->roles as $slug => $role ) : ?>
								<label style="margin-right:14px"><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[roles][]" value="<?php echo esc_attr( $slug ); ?>" <?php checked( in_array( $slug, (array) $s['roles'], true ) || 'administrator' === $slug ); ?> <?php disabled( 'administrator' === $slug ); ?>> <?php echo esc_html( translate_user_role( $role['name'] ) ); ?></label>
							<?php endforeach; ?>
							<p class="description"><?php esc_html_e( 'The assistant can only do what the signed-in person is allowed to do in WordPress.', 'cwai' ); ?></p>
						</td>
					</tr>
					<tr>
						<th><?php esc_html_e( 'Switches', 'cwai' ); ?></th>
						<td>
							<?php
							$flags = array(
								'auto_draft'      => __( 'Create new pages and posts as drafts unless staff say "publish"', 'cwai' ),
								'approve_publish' => __( 'Always ask for approval before publishing', 'cwai' ),
								'auto_seo'        => __( 'Fill in Rank Math SEO title, description and focus keyword on new content', 'cwai' ),
								'purge_cache'     => __( 'Clear caches (LiteSpeed, WP Rocket, etc.) after changes', 'cwai' ),
								'show_frontend'   => __( 'Show the assistant button on the live site for signed-in staff', 'cwai' ),
								'web_search'      => __( 'Allow web research (Anthropic web search; must be enabled in your Anthropic console)', 'cwai' ),
								'staff_elevate'   => __( 'Let staff (editors) use the assistant\'s page-building, menu and media tools without being administrators. The assistant runs those tools with extra permission, but never installs plugins or themes or manages users.', 'cwai' ),
								'editor_full'     => __( 'Give every allowed user admin-level tools (global CSS, Oxygen settings, content types). Not recommended.', 'cwai' ),
							);
							foreach ( $flags as $k => $label ) :
								?>
								<label style="display:block;margin:3px 0"><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[<?php echo esc_attr( $k ); ?>]" value="1" <?php checked( $s[ $k ] ); ?>> <?php echo esc_html( $label ); ?></label>
							<?php endforeach; ?>
							<p class="description"><?php esc_html_e( 'Deleting, trashing, site-wide find & replace and settings changes always require approval.', 'cwai' ); ?></p>
						</td>
					</tr>
					<tr>
						<th><label for="cwai-prefix"><?php esc_html_e( 'Extra tool namespaces', 'cwai' ); ?></label></th>
						<td><textarea id="cwai-prefix" name="<?php echo esc_attr( $name ); ?>[extra_prefixes]" rows="2" class="regular-text" placeholder="woocommerce/"><?php echo esc_textarea( $s['extra_prefixes'] ); ?></textarea>
						<p class="description"><?php esc_html_e( 'Advanced. WordPress Abilities (one prefix per line) beyond Oxygen, Rank Math and the built-in tools. Server shell/PHP/file abilities are never exposed.', 'cwai' ); ?></p></td>
					</tr>
					<tr>
						<th><label for="cwai-ret"><?php esc_html_e( 'History retention (days)', 'cwai' ); ?></label></th>
						<td><input type="number" id="cwai-ret" name="<?php echo esc_attr( $name ); ?>[retention_days]" value="<?php echo (int) $s['retention_days']; ?>" min="7" max="365" style="width:80px"> <span class="description"><?php esc_html_e( 'Chats, undo points and the audit log are deleted after this long.', 'cwai' ); ?></span></td>
					</tr>
					<tr>
						<th><?php esc_html_e( 'Plugin updates', 'cwai' ); ?></th>
						<td>
							<?php CWAI_Updater::render_status(); ?>
							<input type="hidden" name="<?php echo esc_attr( $name ); ?>[auto_update]" value="0">
							<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[auto_update]" value="1" <?php checked( ! empty( $s['auto_update'] ) ); ?>> <?php esc_html_e( 'Install plugin updates automatically', 'cwai' ); ?></label>
							<p class="description"><?php esc_html_e( 'Signed updates from ChurchWeb arrive through the gateway. New versions reach a few sites first and everyone else within days.', 'cwai' ); ?></p>
						</td>
					</tr>
					<tr>
						<th><label for="cwai-upd"><?php esc_html_e( 'Update manifest URL', 'cwai' ); ?></label></th>
						<td><input type="url" id="cwai-upd" class="regular-text" name="<?php echo esc_attr( $name ); ?>[update_manifest]" value="<?php echo esc_attr( $s['update_manifest'] ); ?>"> <p class="description"><?php esc_html_e( 'Advanced and optional: an unsigned JSON file ({"version","download_url"}) used instead of the gateway channel.', 'cwai' ); ?></p></td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>

			<h2><?php esc_html_e( 'Diagnostics', 'cwai' ); ?></h2>
			<?php self::render_diagnostics(); ?>
		</div>
		<?php
	}

	private static function render_diagnostics() {
		$tools = CWAI_Registry::discover();
		$ns    = array();
		foreach ( $tools as $t ) {
			$p          = strstr( $t['name'], '/', true );
			$ns[ $p ][] = $t['name'];
		}
		echo '<table class="widefat striped" style="max-width:760px"><thead><tr><th>' . esc_html__( 'Tool group', 'cwai' ) . '</th><th>' . esc_html__( 'Tools', 'cwai' ) . '</th></tr></thead><tbody>';
		foreach ( $ns as $p => $list ) {
			echo '<tr><td><code>' . esc_html( $p ) . '/</code></td><td>' . (int) count( $list ) . '</td></tr>';
		}
		echo '</tbody></table>';
		if ( ! function_exists( 'wp_get_abilities' ) ) {
			echo '<p class="notice notice-warning" style="padding:8px">' . esc_html__( 'This WordPress version has no Abilities API (needs 6.9+). Oxygen tools are unavailable; built-in tools still work.', 'cwai' ) . '</p>';
		} elseif ( empty( $ns['oxygen'] ) ) {
			echo '<p class="notice notice-warning" style="padding:8px">' . esc_html__( 'No Oxygen abilities found. Make sure Oxygen 6 is active and its Agents & MCP setting is enabled.', 'cwai' ) . '</p>';
		}
		$rm = CWAI_Tools_SEO::state();
		if ( 'not_connected' === $rm ) {
			echo '<p class="notice notice-warning" style="padding:8px">' . esc_html( CWAI_Tools_SEO::state_note() ) . '</p>';
		}
		echo '<p>' . esc_html( sprintf( 'Rank Math: %s · Sermon Manager: %s · Oxygen: %s', 'active' === $rm ? 'active' : ( 'not_connected' === $rm ? 'installed, not connected' : 'not installed' ), post_type_exists( 'wpfc_sermon' ) ? 'active' : 'not active', empty( $ns['oxygen'] ) ? 'no abilities' : 'connected' ) ) . '</p>';
	}
}
