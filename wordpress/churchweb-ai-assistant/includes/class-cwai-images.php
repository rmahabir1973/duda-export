<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Images: free stock photos (Pexels, Pixabay) and AI image generation (through the ChurchWeb gateway on Cloudflare
 * Workers AI, or OpenAI), imported straight into the Media Library. Used by the assistant and by an admin page.
 */
final class CWAI_Images {

	const OPT   = 'cwai_images';
	const USAGE = 'cwai_img_usage';

	const STOCK_HOSTS = array( 'images.pexels.com', 'cdn.pixabay.com', 'pixabay.com' );

	public static function boot() {
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 22 );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
	}

	/* ------------------------------------------------------------------ */
	/* Settings                                                            */
	/* ------------------------------------------------------------------ */

	public static function defaults() {
		return array(
			'pexels_enc' => '', 'pixabay_enc' => '', 'openai_enc' => '',
			'ai_provider' => 'off', 'openai_model' => 'gpt-image-2', 'openai_quality' => 'low', 'daily_cap' => 30,
		);
	}

	public static function opts() {
		$o = get_option( self::OPT );
		return array_merge( self::defaults(), is_array( $o ) ? $o : array() );
	}

	private static function key( $name ) {
		$o = self::opts();
		return $o[ $name . '_enc' ] ? (string) CWAI_Settings::decrypt( $o[ $name . '_enc' ] ) : '';
	}

	public static function gateway_available() {
		$host = wp_parse_url( CWAI_Settings::base_url(), PHP_URL_HOST );
		return $host && 'api.anthropic.com' !== $host;
	}

	/** What is set up, for the UI and for the assistant. */
	public static function status() {
		$o = self::opts();
		$mask = static function ( $k ) {
			return $k ? '••••' . substr( $k, -4 ) : '';
		};
		$provider = $o['ai_provider'];
		if ( 'gateway' === $provider && ! self::gateway_available() ) {
			$provider = 'off';
		}
		if ( 'openai' === $provider && ! self::key( 'openai' ) ) {
			$provider = 'off';
		}
		return array(
			'pexels'          => (bool) self::key( 'pexels' ),
			'pixabay'         => (bool) self::key( 'pixabay' ),
			'pexels_mask'     => $mask( self::key( 'pexels' ) ),
			'pixabay_mask'    => $mask( self::key( 'pixabay' ) ),
			'openai_mask'     => $mask( self::key( 'openai' ) ),
			'ai_provider'     => $o['ai_provider'],
			'ai_ready'        => 'off' !== $provider,
			'ai_active'       => $provider,
			'gateway_ok'      => self::gateway_available(),
			'openai_model'    => $o['openai_model'],
			'openai_quality'  => $o['openai_quality'],
			'daily_cap'       => (int) $o['daily_cap'],
			'used_today'      => self::used_today(),
		);
	}

	public static function save_settings( array $in ) {
		$o = self::opts();
		foreach ( array( 'pexels', 'pixabay', 'openai' ) as $k ) {
			if ( isset( $in[ $k ] ) && '' !== trim( (string) $in[ $k ] ) ) {
				$o[ $k . '_enc' ] = CWAI_Settings::encrypt( trim( sanitize_text_field( $in[ $k ] ) ) );
			}
			if ( ! empty( $in[ 'clear_' . $k ] ) ) {
				$o[ $k . '_enc' ] = '';
			}
		}
		if ( isset( $in['ai_provider'] ) ) {
			$o['ai_provider'] = in_array( $in['ai_provider'], array( 'off', 'gateway', 'openai' ), true ) ? $in['ai_provider'] : 'off';
		}
		if ( isset( $in['openai_model'] ) ) {
			$o['openai_model'] = preg_match( '/^[a-z0-9._-]{3,40}$/i', (string) $in['openai_model'] ) ? $in['openai_model'] : $o['openai_model'];
		}
		if ( isset( $in['openai_quality'] ) ) {
			$o['openai_quality'] = in_array( $in['openai_quality'], array( 'low', 'medium', 'high' ), true ) ? $in['openai_quality'] : 'low';
		}
		if ( isset( $in['daily_cap'] ) ) {
			$o['daily_cap'] = max( 0, min( 1000, (int) $in['daily_cap'] ) );
		}
		update_option( self::OPT, $o, false );
		return self::status();
	}

	private static function used_today() {
		$u = get_option( self::USAGE );
		return (int) ( is_array( $u ) ? ( $u[ wp_date( 'Y-m-d' ) ] ?? 0 ) : 0 );
	}

	private static function bump_usage() {
		$u = get_option( self::USAGE );
		$u = is_array( $u ) ? $u : array();
		$d = wp_date( 'Y-m-d' );
		$u = array_slice( array_merge( $u, array( $d => ( $u[ $d ] ?? 0 ) + 1 ) ), -30, null, true );
		update_option( self::USAGE, $u, false );
	}

	/* ------------------------------------------------------------------ */
	/* Stock photos                                                        */
	/* ------------------------------------------------------------------ */

	private static function http_json( $url, array $headers = array() ) {
		$res = wp_remote_get( $url, array( 'timeout' => 25, 'headers' => $headers + array( 'Accept' => 'application/json' ) ) );
		if ( is_wp_error( $res ) ) {
			return $res;
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		$j    = json_decode( wp_remote_retrieve_body( $res ), true );
		if ( $code >= 400 || ! is_array( $j ) ) {
			return new WP_Error( 'cwai_http', 401 === $code || 403 === $code ? 'The key was rejected.' : ( 429 === $code ? 'Rate limit reached; try again in a few minutes.' : 'The service returned an error (HTTP ' . $code . ').' ), array( 'code' => $code ) );
		}
		return $j;
	}

	public static function stock_search( $q, $orientation = '', $source = 'any', $per_page = 8, $page = 1 ) {
		$q = trim( sanitize_text_field( (string) $q ) );
		if ( mb_strlen( $q ) < 2 ) {
			return new WP_Error( 'cwai_q', 'Enter what to search for.' );
		}
		$per_page = max( 1, min( 15, (int) $per_page ) );
		$page     = max( 1, (int) $page );
		$orient   = in_array( $orientation, array( 'landscape', 'portrait', 'square' ), true ) ? $orientation : '';
		$out      = array();
		$errors   = array();
		$st       = self::status();
		if ( ! $st['pexels'] && ! $st['pixabay'] ) {
			return new WP_Error( 'cwai_nokey', 'No stock photo key is set up. An administrator can add a free Pexels or Pixabay key under AI Assistant → Images.' );
		}
		if ( $st['pexels'] && in_array( $source, array( 'any', 'pexels' ), true ) ) {
			$url = add_query_arg( array_filter( array( 'query' => $q, 'per_page' => $per_page, 'page' => $page, 'orientation' => $orient ) ), 'https://api.pexels.com/v1/search' );
			$j   = self::http_json( $url, array( 'Authorization' => self::key( 'pexels' ) ) );
			if ( is_wp_error( $j ) ) {
				$errors[] = 'Pexels: ' . $j->get_error_message();
			} else {
				foreach ( (array) ( $j['photos'] ?? array() ) as $p ) {
					$out[] = array(
						'source' => 'pexels', 'id' => (string) $p['id'], 'preview_url' => $p['src']['medium'] ?? '', 'import_url' => $p['src']['large2x'] ?? ( $p['src']['large'] ?? '' ),
						'width' => (int) ( $p['width'] ?? 0 ), 'height' => (int) ( $p['height'] ?? 0 ), 'photographer' => (string) ( $p['photographer'] ?? '' ), 'page_url' => (string) ( $p['url'] ?? '' ), 'description' => (string) ( $p['alt'] ?? '' ),
					);
				}
			}
		}
		if ( $st['pixabay'] && in_array( $source, array( 'any', 'pixabay' ), true ) ) {
			$args = array( 'key' => self::key( 'pixabay' ), 'q' => $q, 'image_type' => 'photo', 'per_page' => max( 3, $per_page ), 'page' => $page, 'safesearch' => 'true' );
			if ( 'landscape' === $orient ) {
				$args['orientation'] = 'horizontal';
			} elseif ( 'portrait' === $orient ) {
				$args['orientation'] = 'vertical';
			}
			$j = self::http_json( add_query_arg( $args, 'https://pixabay.com/api/' ) );
			if ( is_wp_error( $j ) ) {
				$errors[] = 'Pixabay: ' . $j->get_error_message();
			} else {
				foreach ( array_slice( (array) ( $j['hits'] ?? array() ), 0, $per_page ) as $p ) {
					$out[] = array(
						'source' => 'pixabay', 'id' => (string) $p['id'], 'preview_url' => $p['webformatURL'] ?? '', 'import_url' => $p['largeImageURL'] ?? ( $p['webformatURL'] ?? '' ),
						'width' => (int) ( $p['imageWidth'] ?? 0 ), 'height' => (int) ( $p['imageHeight'] ?? 0 ), 'photographer' => (string) ( $p['user'] ?? '' ), 'page_url' => (string) ( $p['pageURL'] ?? '' ), 'description' => (string) ( $p['tags'] ?? '' ),
					);
				}
			}
		}
		if ( ! $out && $errors ) {
			return new WP_Error( 'cwai_stock', implode( ' ', $errors ) );
		}
		// Interleave so both sources show up near the top.
		$by = array();
		foreach ( $out as $o ) {
			$by[ $o['source'] ][] = $o;
		}
		if ( count( $by ) > 1 ) {
			$out = array();
			for ( $i = 0; $i < $per_page; $i++ ) {
				foreach ( $by as $list ) {
					if ( isset( $list[ $i ] ) ) {
						$out[] = $list[ $i ];
					}
				}
			}
		}
		return array( 'results' => $out, 'notes' => $errors );
	}

	private static function sideload( $tmp, $name, $title ) {
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';
		$id = media_handle_sideload( array( 'name' => $name, 'tmp_name' => $tmp ), 0, $title ?: null );
		if ( is_wp_error( $id ) ) {
			@unlink( $tmp ); // phpcs:ignore
		}
		return $id;
	}

	public static function stock_import( $source, $url, array $meta = array() ) {
		$url  = esc_url_raw( (string) $url );
		$host = strtolower( (string) wp_parse_url( $url, PHP_URL_HOST ) );
		if ( 'https' !== wp_parse_url( $url, PHP_URL_SCHEME ) || ! in_array( $host, self::STOCK_HOSTS, true ) ) {
			return new WP_Error( 'cwai_url', 'Only photos from Pexels or Pixabay (an import_url from the search results) can be imported.' );
		}
		$source = 'pixabay' === $source ? 'pixabay' : 'pexels';
		require_once ABSPATH . 'wp-admin/includes/file.php';
		$tmp = download_url( $url, 60 );
		if ( is_wp_error( $tmp ) ) {
			return $tmp;
		}
		$ext  = strtolower( pathinfo( wp_parse_url( $url, PHP_URL_PATH ), PATHINFO_EXTENSION ) );
		$name = 'stock-' . $source . '-' . sanitize_file_name( (string) ( $meta['id'] ?? wp_generate_password( 6, false ) ) ) . '.' . ( in_array( $ext, array( 'jpg', 'jpeg', 'png', 'webp' ), true ) ? $ext : 'jpg' );
		$id   = self::sideload( $tmp, $name, sanitize_text_field( $meta['title'] ?? '' ) );
		if ( is_wp_error( $id ) ) {
			return $id;
		}
		$by = sanitize_text_field( $meta['photographer'] ?? '' );
		wp_update_post( array( 'ID' => $id, 'post_excerpt' => ( $by ? 'Photo by ' . $by . ' on ' : 'Photo on ' ) . ucfirst( $source ) ) );
		if ( ! empty( $meta['alt'] ) ) {
			update_post_meta( $id, '_wp_attachment_image_alt', sanitize_text_field( $meta['alt'] ) );
		}
		update_post_meta( $id, '_cwai_stock_source', $source );
		update_post_meta( $id, '_cwai_stock_page', esc_url_raw( (string) ( $meta['page_url'] ?? '' ) ) );
		return self::row( $id ) + array( 'origin' => 'stock photo (' . $source . ')' );
	}

	/* ------------------------------------------------------------------ */
	/* AI images                                                           */
	/* ------------------------------------------------------------------ */

	private static function aspect_ratio( $a ) {
		return array( 'landscape' => 16 / 9, 'portrait' => 4 / 5, 'square' => 1 )[ $a ] ?? 1;
	}

	private static function crop_file( $file, $aspect ) {
		$ed = wp_get_image_editor( $file );
		if ( is_wp_error( $ed ) ) {
			return;
		}
		$s = $ed->get_size();
		$r = self::aspect_ratio( $aspect );
		$w = (int) $s['width'];
		$h = (int) $s['height'];
		if ( abs( $w / $h - $r ) < 0.02 ) {
			return;
		}
		if ( $w / $h > $r ) {
			$nw = (int) round( $h * $r );
			$ed->crop( (int) floor( ( $w - $nw ) / 2 ), 0, $nw, $h );
		} else {
			$nh = (int) round( $w / $r );
			$ed->crop( 0, (int) floor( ( $h - $nh ) / 3 ), $w, $nh ); // keep a little more of the top
		}
		$ed->save( $file );
	}

	private static function request_image( $prompt, $aspect ) {
		$st = self::status();
		if ( 'gateway' === $st['ai_active'] ) {
			$res = wp_remote_post( CWAI_Settings::base_url() . '/v1/images', array(
				'timeout' => 90,
				'headers' => array( 'x-api-key' => CWAI_Settings::api_key(), 'content-type' => 'application/json' ),
				'body'    => wp_json_encode( array( 'prompt' => $prompt, 'steps' => 4 ) ),
			) );
			if ( is_wp_error( $res ) ) {
				return $res;
			}
			$code = (int) wp_remote_retrieve_response_code( $res );
			$j    = json_decode( wp_remote_retrieve_body( $res ), true );
			if ( 200 !== $code || empty( $j['image'] ) ) {
				$msg = $j['error']['message'] ?? 'HTTP ' . $code;
				return new WP_Error( 'cwai_ai', 501 === $code ? 'Image generation is not switched on in the gateway yet. (' . $msg . ')' : 'Image generation failed: ' . $msg );
			}
			return array( 'bytes' => base64_decode( $j['image'] ), 'ext' => false !== strpos( (string) ( $j['mime'] ?? '' ), 'png' ) ? 'png' : 'jpg', 'provider' => 'gateway (FLUX.1 schnell)' );
		}
		if ( 'openai' === $st['ai_active'] ) {
			$o    = self::opts();
			$size = 'landscape' === $aspect ? '1536x1024' : ( 'portrait' === $aspect ? '1024x1536' : '1024x1024' );
			$base = defined( 'CWAI_OPENAI_BASE' ) ? CWAI_OPENAI_BASE : 'https://api.openai.com';
			$res  = wp_remote_post( $base . '/v1/images/generations', array(
				'timeout' => 120,
				'headers' => array( 'Authorization' => 'Bearer ' . self::key( 'openai' ), 'content-type' => 'application/json' ),
				'body'    => wp_json_encode( array( 'model' => $o['openai_model'], 'prompt' => $prompt, 'size' => $size, 'quality' => $o['openai_quality'], 'n' => 1 ) ),
			) );
			if ( is_wp_error( $res ) ) {
				return $res;
			}
			$code = (int) wp_remote_retrieve_response_code( $res );
			$j    = json_decode( wp_remote_retrieve_body( $res ), true );
			$b64  = $j['data'][0]['b64_json'] ?? '';
			if ( 200 !== $code || ! $b64 ) {
				return new WP_Error( 'cwai_ai', 'Image generation failed: ' . ( $j['error']['message'] ?? 'HTTP ' . $code ) );
			}
			return array( 'bytes' => base64_decode( $b64 ), 'ext' => 'png', 'provider' => 'OpenAI ' . $o['openai_model'] );
		}
		return new WP_Error( 'cwai_ai_off', 'AI image generation is not set up. An administrator can switch it on under AI Assistant → Images.' );
	}

	public static function generate( $prompt, $aspect = 'landscape', $style = 'photo', array $meta = array() ) {
		$prompt = trim( wp_strip_all_tags( (string) $prompt ) );
		if ( mb_strlen( $prompt ) < 5 ) {
			return new WP_Error( 'cwai_prompt', 'Describe the image you want (at least a few words).' );
		}
		$st = self::status();
		if ( ! $st['ai_ready'] ) {
			return new WP_Error( 'cwai_ai_off', 'AI image generation is not set up. An administrator can switch it on under AI Assistant → Images.' );
		}
		$cap = (int) $st['daily_cap'];
		if ( $cap > 0 && self::used_today() >= $cap ) {
			return new WP_Error( 'cwai_cap', 'The daily limit of ' . $cap . ' AI images has been reached. An administrator can raise it under AI Assistant → Images, or use stock photos.' );
		}
		$aspect = in_array( $aspect, array( 'landscape', 'portrait', 'square' ), true ) ? $aspect : 'landscape';
		$styles = array(
			'photo'        => 'Photorealistic photograph, natural light, high detail. ',
			'illustration' => 'Clean modern flat illustration, simple shapes, harmonious colours. ',
			'texture'      => 'Subtle abstract background, soft gradients and texture, no objects. ',
			'abstract'     => 'Abstract artistic composition, soft light and colour. ',
		);
		$final = ( $styles[ $style ] ?? $styles['photo'] ) . mb_substr( $prompt, 0, 900 ) . ' No text, no letters, no logos, no watermarks, no recognizable real people.';
		$img   = self::request_image( $final, $aspect );
		if ( is_wp_error( $img ) ) {
			return $img;
		}
		if ( strlen( (string) $img['bytes'] ) < 500 ) {
			return new WP_Error( 'cwai_ai', 'The image service returned an empty image.' );
		}
		require_once ABSPATH . 'wp-admin/includes/file.php';
		$tmp = wp_tempnam( 'ai-image' );
		file_put_contents( $tmp, $img['bytes'] ); // phpcs:ignore
		// wp_get_image_editor needs a real extension to pick the right format.
		$withExt = $tmp . '.' . $img['ext'];
		rename( $tmp, $withExt ); // phpcs:ignore
		self::crop_file( $withExt, $aspect );
		$id = self::sideload( $withExt, 'ai-' . sanitize_title( mb_substr( $prompt, 0, 40 ) ?: 'image' ) . '-' . wp_generate_password( 4, false ) . '.' . $img['ext'], sanitize_text_field( $meta['title'] ?? '' ) ?: mb_substr( $prompt, 0, 60 ) );
		if ( is_wp_error( $id ) ) {
			return $id;
		}
		wp_update_post( array( 'ID' => $id, 'post_content' => 'AI-generated image. Prompt: ' . mb_substr( $prompt, 0, 300 ) ) );
		if ( ! empty( $meta['alt'] ) ) {
			update_post_meta( $id, '_wp_attachment_image_alt', sanitize_text_field( $meta['alt'] ) );
		}
		update_post_meta( $id, '_cwai_ai_generated', 1 );
		update_post_meta( $id, '_cwai_ai_prompt', mb_substr( $prompt, 0, 500 ) );
		update_post_meta( $id, '_cwai_ai_provider', $img['provider'] );
		self::bump_usage();
		return self::row( $id ) + array( 'origin' => 'AI-generated (' . $img['provider'] . ')', 'ai_images_left_today' => $cap > 0 ? max( 0, $cap - self::used_today() ) : null );
	}

	private static function row( $id ) {
		$meta = wp_get_attachment_metadata( $id );
		return array(
			'id' => (int) $id, 'url' => wp_get_attachment_url( $id ), 'title' => get_the_title( $id ), 'alt' => get_post_meta( $id, '_wp_attachment_image_alt', true ),
			'width' => $meta['width'] ?? null, 'height' => $meta['height'] ?? null, 'thumb' => wp_get_attachment_image_url( $id, 'medium' ) ?: wp_get_attachment_url( $id ),
		);
	}

	/* ------------------------------------------------------------------ */
	/* Assistant tools + prompt                                            */
	/* ------------------------------------------------------------------ */

	public static function register_tools() {
		$p = array( 'CWAI_Tools_Content', 'p' );
		$s = array( 'CWAI_Tools_Content', 'schema' );
		CWAI_Registry::add( 'cwai/stock-search', array(
			'label' => 'Search free stock photos', 'description' => 'Search free stock photos (Pexels, Pixabay) for real-world scenes: nature, buildings, food, hands, generic community scenes. Returns previews with an import_url, size and photographer. Use it when the person has no suitable photo. Then call cwai__stock-import for the ones you choose. Do not present stock photos as the church\'s own people or building.',
			'input' => call_user_func( $s, array(
				'query'       => call_user_func( $p, 'string', 'What to search for, in English, e.g. "sunrise over a quiet lake" or "open Bible on a wooden table".' ),
				'orientation' => call_user_func( $p, 'string', 'landscape, portrait or square. Use landscape for banners.' ),
				'source'      => call_user_func( $p, 'string', 'any (default), pexels or pixabay.' ),
				'per_page'    => call_user_func( $p, 'integer', 'Default 8, max 15.' ),
				'page'        => call_user_func( $p, 'integer', 'Page number.' ),
			), array( 'query' ) ),
			'callback' => array( __CLASS__, 't_search' ), 'readonly' => true, 'capability' => 'upload_files',
		) );
		CWAI_Registry::add( 'cwai/stock-import', array(
			'label' => 'Add a stock photo to the media library', 'description' => 'Import one stock photo found with cwai__stock-search into the media library, with photographer credit in the caption. Always pass alt text. Returns the media id and url to use on pages.',
			'input' => call_user_func( $s, array(
				'source'       => call_user_func( $p, 'string', 'pexels or pixabay (from the search result).' ),
				'import_url'   => call_user_func( $p, 'string', 'The import_url from the search result.' ),
				'id'           => call_user_func( $p, 'string', 'The id from the search result.' ),
				'photographer' => call_user_func( $p, 'string', 'Photographer from the search result.' ),
				'page_url'     => call_user_func( $p, 'string', 'page_url from the search result.' ),
				'title'        => call_user_func( $p, 'string', 'A short title.' ),
				'alt'          => call_user_func( $p, 'string', 'Descriptive alt text.' ),
			), array( 'source', 'import_url' ) ),
			'callback' => array( __CLASS__, 't_import' ), 'capability' => 'upload_files',
		) );
		CWAI_Registry::add( 'cwai/generate-image', array(
			'label' => 'Create an AI image', 'description' => 'Generate an image from a text description and add it to the media library (AI-generated, flagged as such). Good for abstract backgrounds, soft textures, simple illustrations, scenery and objects. NEVER use it for photos of real people, the church\'s own building, logos or anything with text. Be specific about subject, mood, colours and composition. There is a daily limit; prefer an uploaded or stock photo when one fits.',
			'input' => call_user_func( $s, array(
				'prompt' => call_user_func( $p, 'string', 'Detailed description, in English.' ),
				'aspect' => call_user_func( $p, 'string', 'landscape (default, for banners), portrait or square.' ),
				'style'  => call_user_func( $p, 'string', 'photo (default), illustration, texture or abstract.' ),
				'title'  => call_user_func( $p, 'string', 'Short title.' ),
				'alt'    => call_user_func( $p, 'string', 'Descriptive alt text.' ),
			), array( 'prompt' ) ),
			'callback' => array( __CLASS__, 't_generate' ), 'capability' => 'upload_files',
		) );
	}

	public static function t_search( $in ) {
		$r = self::stock_search( $in['query'] ?? '', $in['orientation'] ?? '', $in['source'] ?? 'any', $in['per_page'] ?? 8, $in['page'] ?? 1 );
		if ( is_wp_error( $r ) && 'cwai_nokey' === $r->get_error_code() ) {
			return array( 'configured' => false, 'message' => $r->get_error_message() );
		}
		return $r;
	}

	public static function t_import( $in ) {
		return self::stock_import( (string) ( $in['source'] ?? '' ), (string) ( $in['import_url'] ?? '' ), (array) $in );
	}

	public static function t_generate( $in ) {
		$r = self::generate( $in['prompt'] ?? '', $in['aspect'] ?? 'landscape', $in['style'] ?? 'photo', (array) $in );
		if ( is_wp_error( $r ) && in_array( $r->get_error_code(), array( 'cwai_ai_off', 'cwai_cap' ), true ) ) {
			return array( 'generated' => false, 'message' => $r->get_error_message() );
		}
		return $r;
	}

	public static function prompt_section() {
		$st   = self::status();
		$have = array();
		if ( $st['pexels'] || $st['pixabay'] ) {
			$have[] = 'stock photos (cwai__stock-search then cwai__stock-import)';
		}
		if ( $st['ai_ready'] ) {
			$have[] = 'AI images (cwai__generate-image)';
		}
		$lines = "## When the person has no images\n";
		if ( ! $have ) {
			return $lines . "Neither stock photos nor AI images are set up. If the person needs pictures they do not have, tell them an administrator can switch these on under AI Assistant → Images.";
		}
		return $lines . 'Available: ' . implode( ' and ', $have ) . ". Always prefer the person's own images in the media library first. Use stock photos for real-world scenes (nature, hands, open Bible, coffee, generic buildings); use AI images only for abstract backgrounds, textures, simple illustrations and scenery. Never use stock or AI pictures to stand in for the church's own people, building or events, never generate logos or text, and always tell the person which images are stock or AI-generated and that they can swap them for real photos. Give every image meaningful alt text.";
	}

	/* ------------------------------------------------------------------ */
	/* REST + admin page                                                   */
	/* ------------------------------------------------------------------ */

	public static function routes() {
		$u = static function () {
			return current_user_can( 'upload_files' ) && CWAI_Plugin::can_use();
		};
		$a = static function () {
			return current_user_can( 'manage_options' ) && CWAI_Plugin::can_use();
		};
		register_rest_route( CWAI_REST::NS, '/images/status', array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'rest_status' ), 'permission_callback' => $u ) );
		register_rest_route( CWAI_REST::NS, '/images/search', array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'rest_search' ), 'permission_callback' => $u ) );
		register_rest_route( CWAI_REST::NS, '/images/import', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'rest_import' ), 'permission_callback' => $u ) );
		register_rest_route( CWAI_REST::NS, '/images/generate', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'rest_generate' ), 'permission_callback' => $u ) );
		register_rest_route( CWAI_REST::NS, '/images/settings', array( 'methods' => 'POST', 'callback' => array( __CLASS__, 'rest_settings' ), 'permission_callback' => $a ) );
	}

	private static function wrap( $r ) {
		return is_wp_error( $r ) ? new WP_Error( $r->get_error_code(), $r->get_error_message(), array( 'status' => 400 ) ) : $r;
	}

	public static function rest_status() {
		return self::status();
	}

	public static function rest_search( WP_REST_Request $r ) {
		return self::wrap( self::stock_search( $r->get_param( 'q' ), (string) $r->get_param( 'orientation' ), (string) ( $r->get_param( 'source' ) ?: 'any' ), 12, (int) ( $r->get_param( 'page' ) ?: 1 ) ) );
	}

	public static function rest_import( WP_REST_Request $r ) {
		$p = (array) $r->get_json_params();
		return self::wrap( self::stock_import( (string) ( $p['source'] ?? '' ), (string) ( $p['import_url'] ?? '' ), $p ) );
	}

	public static function rest_generate( WP_REST_Request $r ) {
		$p = (array) $r->get_json_params();
		return self::wrap( self::generate( $p['prompt'] ?? '', $p['aspect'] ?? 'landscape', $p['style'] ?? 'photo', $p ) );
	}

	public static function rest_settings( WP_REST_Request $r ) {
		return self::save_settings( (array) $r->get_json_params() );
	}

	public static function menu() {
		add_submenu_page( 'cwai-chat', __( 'Stock and AI images', 'cwai' ), __( 'Images', 'cwai' ), 'upload_files', 'cwai-images', array( __CLASS__, 'render_page' ) );
	}

	public static function enqueue() {
		if ( ! isset( $_GET['page'] ) || 'cwai-images' !== $_GET['page'] ) { // phpcs:ignore
			return;
		}
		wp_enqueue_style( 'cwai-images', CWAI_URL . 'assets/images.css', array(), CWAI_VERSION );
		wp_enqueue_script( 'cwai-images', CWAI_URL . 'assets/images.js', array(), CWAI_VERSION, true );
		wp_localize_script( 'cwai-images', 'CWAI_IMG', array(
			'root'    => esc_url_raw( rest_url( CWAI_REST::NS ) ),
			'nonce'   => wp_create_nonce( 'wp_rest' ),
			'status'  => self::status(),
			'isAdmin' => current_user_can( 'manage_options' ),
		) );
	}

	public static function render_page() {
		if ( ! current_user_can( 'upload_files' ) ) {
			return;
		}
		echo '<div class="wrap" id="cwai-images"><h1>' . esc_html__( 'Stock and AI images', 'cwai' ) . '</h1>';
		echo '<p class="description" style="max-width:780px">' . esc_html__( 'Find a free photo or create an image with AI. Whatever you pick is added to the Media Library and the assistant can use it too.', 'cwai' ) . '</p>';
		echo '<h2 class="nav-tab-wrapper" id="cwi-tabs"><a href="#" class="nav-tab nav-tab-active" data-t="stock">' . esc_html__( 'Free stock photos', 'cwai' ) . '</a><a href="#" class="nav-tab" data-t="ai">' . esc_html__( 'Create with AI', 'cwai' ) . '</a>';
		if ( current_user_can( 'manage_options' ) ) {
			echo '<a href="#" class="nav-tab" data-t="setup">' . esc_html__( 'Setup', 'cwai' ) . '</a>';
		}
		echo '</h2><div id="cwi-body"></div></div>';
	}
}
