<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * What visitors get: the chat loader script, the optional customer recognition and the "chat with us" button.
 */
class Botwa_Chat_Frontend {

	const HANDLE = 'botwa-chat';

	public static function init() {
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
		add_filter( 'script_loader_tag', array( __CLASS__, 'script_tag' ), 10, 3 );
		add_action( 'rest_api_init', array( __CLASS__, 'register_rest' ) );
		add_shortcode( 'botwa_chat_button', array( __CLASS__, 'shortcode' ) );
	}

	/** Should the chat be on this request? Filterable: apply_filters( 'botwa_chat_should_load', $bool ). */
	public static function should_load() {
		$o = Botwa_Chat_Options::get();
		if ( empty( $o['enabled'] ) || '' === $o['server'] || '' === $o['key'] ) {
			return false;
		}
		if ( is_admin() || is_feed() || is_robots() || is_trackback() || wp_doing_ajax() || ( function_exists( 'wp_is_json_request' ) && wp_is_json_request() ) ) {
			return false;
		}
		if ( function_exists( 'is_customize_preview' ) && is_customize_preview() ) {
			return false;
		}
		if ( ! empty( $o['hide_admins'] ) && current_user_can( 'manage_options' ) ) {
			return false;
		}
		if ( ! empty( $o['only_front'] ) && ! is_front_page() ) {
			return false;
		}
		$uri  = isset( $_SERVER['REQUEST_URI'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '/';
		$path = (string) strtok( $uri, '?' );
		foreach ( preg_split( '/\r\n|\r|\n/', (string) $o['exclude'] ) as $prefix ) {
			if ( '' !== $prefix && 0 === strpos( $path, $prefix ) ) {
				return false;
			}
		}
		return (bool) apply_filters( 'botwa_chat_should_load', true );
	}

	public static function enqueue() {
		// the helper script is tiny and only wires up buttons; it is useful even when the chat itself waits for consent
		$o = Botwa_Chat_Options::get();
		if ( ! self::should_load() ) {
			return;
		}
		wp_enqueue_script( 'botwa-chat-frontend', BOTWA_CHAT_URL . 'assets/frontend.js', array(), BOTWA_CHAT_VERSION, true );
		$identity = ! empty( $o['identity_enabled'] ) && '' !== $o['identity_secret'] && is_user_logged_in();
		wp_localize_script(
			'botwa-chat-frontend',
			'BotwaChatWP',
			array(
				'server'   => $o['server'],
				'key'      => $o['key'],
				'consent'  => ! empty( $o['consent_mode'] ),
				'identity' => $identity ? array(
					'url'   => esc_url_raw( rest_url( 'botwa-chat/v1/identity' ) ),
					'nonce' => wp_create_nonce( 'wp_rest' ),
				) : null,
			)
		);
		if ( empty( $o['consent_mode'] ) ) {
			$args = version_compare( get_bloginfo( 'version' ), '6.3', '>=' ) ? array( 'in_footer' => true, 'strategy' => 'async' ) : true;
			// no version query string: the chat server controls its own caching
			wp_enqueue_script( self::HANDLE, $o['server'] . '/widget.js', array(), null, $args ); // phpcs:ignore WordPress.WP.EnqueuedResourceParameters.MissingVersion
		}
	}

	/** The loader reads data-key from its own tag. The extra attributes ask optimisation plugins to leave the tag alone. */
	public static function script_tag( $tag, $handle, $src ) {
		if ( self::HANDLE !== $handle ) {
			return $tag;
		}
		$o    = Botwa_Chat_Options::get();
		$attr = ' data-key="' . esc_attr( $o['key'] ) . '" data-cfasync="false" data-no-optimize="1" data-no-defer="1" data-no-minify="1"';
		if ( false === strpos( $tag, ' async' ) ) {
			$attr .= ' async';
		}
		return preg_replace( '/<script /', '<script' . $attr . ' ', $tag, 1 );
	}

	public static function register_rest() {
		register_rest_route(
			'botwa-chat/v1',
			'/identity',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'identity' ),
				'permission_callback' => 'is_user_logged_in',
			)
		);
	}

	/**
	 * Proof that this visitor is this logged-in user: signature = HMAC-SHA256(secret, id). Served on its own request with
	 * no-store headers, so page caches can never hand one customer's identity to another.
	 */
	public static function identity() {
		$o = Botwa_Chat_Options::get();
		if ( empty( $o['identity_enabled'] ) || '' === $o['identity_secret'] ) {
			return new WP_Error( 'botwa_disabled', 'disabled', array( 'status' => 404 ) );
		}
		nocache_headers();
		$user = wp_get_current_user();
		$id   = (string) apply_filters( 'botwa_chat_identity_id', 'wp-' . $user->ID, $user );
		if ( ! preg_match( '/^[\w.-]{1,64}$/', $id ) ) {
			return new WP_Error( 'botwa_bad_id', 'bad id', array( 'status' => 500 ) );
		}
		return array(
			'id'        => $id,
			'signature' => hash_hmac( 'sha256', $id, $o['identity_secret'] ),
			'name'      => $user->display_name,
			'email'     => $user->user_email,
		);
	}

	public static function shortcode( $atts ) {
		$a = shortcode_atts(
			array(
				'label' => __( 'Chat with us', 'botwa-chat' ),
				'class' => '',
			),
			$atts,
			'botwa_chat_button'
		);
		$classes = 'botwa-open';
		foreach ( preg_split( '/\s+/', (string) $a['class'] ) as $c ) {
			$c = sanitize_html_class( $c );
			if ( '' !== $c ) {
				$classes .= ' ' . $c;
			}
		}
		return '<button type="button" class="' . esc_attr( $classes ) . '">' . esc_html( $a['label'] ) . '</button>';
	}
}
