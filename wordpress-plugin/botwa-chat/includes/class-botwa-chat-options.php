<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Reading and validating the plugin settings. Everything that reaches the page or the HTTP client goes through here.
 */
class Botwa_Chat_Options {

	/**
	 * A plugin package downloaded from Botwa carries botwa-chat-defaults.php with the server address and the site key of
	 * the chat it was made for, so it works as soon as it is activated. Manual installs have no such file.
	 */
	private static function packaged() {
		$file = BOTWA_CHAT_DIR . 'botwa-chat-defaults.php';
		if ( ! is_readable( $file ) ) {
			return array();
		}
		$d      = include $file;
		$server = is_array( $d ) && isset( $d['server'] ) ? self::clean_server( $d['server'] ) : '';
		$key    = is_array( $d ) && isset( $d['key'] ) ? self::clean_key( $d['key'] ) : '';
		return ( '' !== $server && '' !== $key ) ? array( 'enabled' => 1, 'server' => $server, 'key' => $key ) : array();
	}

	public static function defaults() {
		return array_merge( self::base_defaults(), self::packaged() );
	}

	private static function base_defaults() {
		return array(
			'enabled'          => 0,
			'server'           => '',
			'key'              => '',
			'hide_admins'      => 1,
			'only_front'       => 0,
			'exclude'          => '',
			'consent_mode'     => 0,
			'identity_enabled' => 0,
			'identity_secret'  => '',
		);
	}

	public static function get() {
		$saved = get_option( BOTWA_CHAT_OPTION, array() );
		return array_merge( self::defaults(), is_array( $saved ) ? $saved : array() );
	}

	/**
	 * Server address as an origin: https://chat.example.com (no path). http is accepted only for localhost (development).
	 *
	 * @return string Empty string when the value is not acceptable.
	 */
	public static function clean_server( $value ) {
		$value = trim( (string) $value );
		if ( '' === $value ) {
			return '';
		}
		if ( ! preg_match( '#^[a-z][a-z0-9+.-]*://#i', $value ) ) {
			$value = 'https://' . $value;
		}
		$parts = wp_parse_url( $value );
		if ( empty( $parts['scheme'] ) || empty( $parts['host'] ) || ! empty( $parts['user'] ) || ! empty( $parts['pass'] ) ) {
			return '';
		}
		$scheme = strtolower( $parts['scheme'] );
		$host   = strtolower( $parts['host'] );
		$local  = in_array( $host, array( 'localhost', '127.0.0.1' ), true );
		if ( 'https' !== $scheme && ! ( 'http' === $scheme && $local ) ) {
			return '';
		}
		if ( ! preg_match( '/^[a-z0-9.-]+$/', $host ) ) {
			return '';
		}
		$origin = $scheme . '://' . $host;
		if ( ! empty( $parts['port'] ) ) {
			$port = (int) $parts['port'];
			if ( $port < 1 || $port > 65535 ) {
				return '';
			}
			$origin .= ':' . $port;
		}
		return $origin;
	}

	public static function clean_key( $value ) {
		$value = trim( (string) $value );
		return preg_match( '/^wc_[\w-]{10,60}$/', $value ) ? $value : '';
	}

	public static function clean_secret( $value ) {
		$value = trim( (string) $value );
		return preg_match( '/^[\w-]{20,200}$/', $value ) ? $value : '';
	}

	/** One path prefix per line, each starting with "/". */
	public static function clean_paths( $value ) {
		$out = array();
		foreach ( preg_split( '/\r\n|\r|\n/', (string) $value ) as $line ) {
			$line = trim( sanitize_text_field( $line ) );
			if ( '' === $line ) {
				continue;
			}
			if ( '/' !== $line[0] ) {
				$line = '/' . $line;
			}
			$out[] = substr( $line, 0, 200 );
			if ( count( $out ) >= 50 ) {
				break;
			}
		}
		return implode( "\n", array_unique( $out ) );
	}

	/** This site as the chat server sees it (scheme + host [+ port]). Add it to "allowed sites" in Botwa. */
	public static function site_origin() {
		$parts = wp_parse_url( home_url() );
		$o     = $parts['scheme'] . '://' . $parts['host'];
		if ( ! empty( $parts['port'] ) ) {
			$o .= ':' . $parts['port'];
		}
		return $o;
	}
}
