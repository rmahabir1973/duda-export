<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Thin Anthropic Messages API client (no SDK dependency).
 */
final class CWAI_Anthropic {

	const VERSION = '2023-06-01';

	private static function headers() {
		return array(
			'content-type'      => 'application/json',
			'x-api-key'         => CWAI_Settings::api_key(),
			'anthropic-version' => self::VERSION,
		);
	}

	/** @return array|WP_Error */
	public static function messages( array $body ) {
		if ( ! CWAI_Settings::api_key() ) {
			return new WP_Error( 'cwai_no_key', __( 'No Anthropic API key is configured. Ask your site administrator to add one under AI Assistant → Settings.', 'cwai' ) );
		}
		$url   = CWAI_Settings::base_url() . '/v1/messages';
		$delay = 2;
		for ( $attempt = 0; $attempt < 3; $attempt++ ) {
			$res = wp_remote_post(
				$url,
				array(
					'timeout' => 290,
					'headers' => self::headers(),
					'body'    => CWAI_Store::json( $body ),
				)
			);
			if ( is_wp_error( $res ) ) {
				if ( $attempt < 2 && false !== strpos( $res->get_error_message(), 'cURL error 28' ) ) {
					return new WP_Error( 'cwai_timeout', __( 'The AI took too long to answer. Try a smaller request.', 'cwai' ) );
				}
				if ( $attempt < 2 ) {
					sleep( $delay );
					$delay *= 2;
					continue;
				}
				return new WP_Error( 'cwai_http', $res->get_error_message() );
			}
			$code = (int) wp_remote_retrieve_response_code( $res );
			$data = json_decode( wp_remote_retrieve_body( $res ), true );
			if ( $code >= 200 && $code < 300 && is_array( $data ) ) {
				return $data;
			}
			if ( in_array( $code, array( 429, 500, 502, 503, 529 ), true ) && $attempt < 2 ) {
				$ra = (int) wp_remote_retrieve_header( $res, 'retry-after' );
				sleep( $ra > 0 ? min( $ra, 15 ) : $delay );
				$delay *= 2;
				continue;
			}
			return new WP_Error( 'cwai_api_' . $code, self::friendly_error( $code, $data ), array( 'status' => $code ) );
		}
		return new WP_Error( 'cwai_api', __( 'The AI service is busy. Please try again in a minute.', 'cwai' ) );
	}

	private static function friendly_error( $code, $data ) {
		$msg = is_array( $data ) && isset( $data['error']['message'] ) ? $data['error']['message'] : '';
		switch ( $code ) {
			case 401:
				return __( 'The Anthropic API key was rejected. Check the key under AI Assistant → Settings.', 'cwai' );
			case 403:
				return __( 'This API key is not allowed to use that model or feature.', 'cwai' ) . ( $msg ? ' (' . $msg . ')' : '' );
			case 404:
				return __( 'That model was not found. Pick another model in Settings.', 'cwai' ) . ( $msg ? ' (' . $msg . ')' : '' );
			case 429:
				return __( 'Rate limit reached. Please wait a minute and try again.', 'cwai' );
			case 529:
				return __( 'The AI service is overloaded right now. Please try again shortly.', 'cwai' );
			default:
				return $msg ? $msg : sprintf( __( 'AI service error (HTTP %d).', 'cwai' ), $code );
		}
	}

	/** Fetch live model list. @return array|WP_Error id => label */
	public static function list_models() {
		$res = wp_remote_get(
			CWAI_Settings::base_url() . '/v1/models?limit=100',
			array(
				'timeout' => 20,
				'headers' => self::headers(),
			)
		);
		if ( is_wp_error( $res ) ) {
			return $res;
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		$data = json_decode( wp_remote_retrieve_body( $res ), true );
		if ( 200 !== $code || empty( $data['data'] ) ) {
			return new WP_Error( 'cwai_models', self::friendly_error( $code, $data ) );
		}
		$out = array();
		foreach ( $data['data'] as $m ) {
			if ( ! empty( $m['id'] ) ) {
				$out[ $m['id'] ] = ! empty( $m['display_name'] ) ? $m['display_name'] : $m['id'];
			}
		}
		set_transient( 'cwai_models', $out, WEEK_IN_SECONDS );
		return $out;
	}

	/** Cheap connectivity probe. */
	public static function ping( $model ) {
		$r = self::messages(
			array(
				'model'      => $model,
				'max_tokens' => 16,
				'messages'   => array( array( 'role' => 'user', 'content' => 'Reply with OK.' ) ),
			)
		);
		return is_wp_error( $r ) ? $r : true;
	}
}
