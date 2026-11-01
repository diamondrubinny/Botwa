<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Settings screen (Settings > Botwa Chat) and the "test connection" helper.
 */
class Botwa_Chat_Settings {

	const PAGE = 'botwa-chat';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_init', array( __CLASS__, 'register' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
		add_action( 'wp_ajax_botwa_chat_test', array( __CLASS__, 'ajax_test' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( BOTWA_CHAT_FILE ), array( __CLASS__, 'action_links' ) );
		add_action( 'admin_init', array( __CLASS__, 'privacy_text' ) );
	}

	public static function menu() {
		add_options_page( __( 'Botwa Chat', 'botwa-chat' ), __( 'Botwa Chat', 'botwa-chat' ), 'manage_options', self::PAGE, array( __CLASS__, 'render' ) );
	}

	public static function action_links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'options-general.php?page=' . self::PAGE ) ) . '">' . esc_html__( 'Settings', 'botwa-chat' ) . '</a>' );
		return $links;
	}

	public static function register() {
		register_setting(
			'botwa_chat_group',
			BOTWA_CHAT_OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( __CLASS__, 'sanitize' ),
				'default'           => Botwa_Chat_Options::defaults(),
			)
		);
	}

	public static function sanitize( $input ) {
		$old = Botwa_Chat_Options::get();
		$in  = is_array( $input ) ? $input : array();
		$new = Botwa_Chat_Options::defaults();

		$new['enabled']          = empty( $in['enabled'] ) ? 0 : 1;
		$new['hide_admins']      = empty( $in['hide_admins'] ) ? 0 : 1;
		$new['only_front']       = empty( $in['only_front'] ) ? 0 : 1;
		$new['consent_mode']     = empty( $in['consent_mode'] ) ? 0 : 1;
		$new['identity_enabled'] = empty( $in['identity_enabled'] ) ? 0 : 1;
		$new['exclude']          = Botwa_Chat_Options::clean_paths( isset( $in['exclude'] ) ? $in['exclude'] : '' );

		$server = Botwa_Chat_Options::clean_server( isset( $in['server'] ) ? $in['server'] : '' );
		if ( '' === $server && ! empty( $in['server'] ) ) {
			add_settings_error( BOTWA_CHAT_OPTION, 'botwa_server', __( 'The server address must be an https address such as https://chat.example.com. The previous value was kept.', 'botwa-chat' ) );
			$server = $old['server'];
		}
		$new['server'] = $server;

		$key = Botwa_Chat_Options::clean_key( isset( $in['key'] ) ? $in['key'] : '' );
		if ( '' === $key && ! empty( $in['key'] ) ) {
			$kind = Botwa_Chat_Options::wrong_key_kind( $in['key'] );
			add_settings_error( BOTWA_CHAT_OPTION, 'botwa_key', self::wrong_key_message( $kind ) . ' ' . __( 'The previous value was kept.', 'botwa-chat' ) );
			$key = $old['key'];
		}
		$new['key'] = $key;

		// The secret is never printed back into the form: leaving the field empty keeps the saved one.
		$secret = isset( $in['identity_secret'] ) ? trim( (string) $in['identity_secret'] ) : '';
		if ( '' === $secret ) {
			$new['identity_secret'] = $old['identity_secret'];
		} else {
			$clean = Botwa_Chat_Options::clean_secret( $secret );
			if ( '' === $clean ) {
				add_settings_error( BOTWA_CHAT_OPTION, 'botwa_secret', __( 'The identity secret looks wrong and was not saved.', 'botwa-chat' ) );
			}
			$new['identity_secret'] = '' !== $clean ? $clean : $old['identity_secret'];
		}
		if ( ! empty( $in['identity_clear'] ) ) {
			$new['identity_secret']  = '';
			$new['identity_enabled'] = 0;
		}
		if ( $new['enabled'] && ( '' === $new['server'] || '' === $new['key'] ) ) {
			add_settings_error( BOTWA_CHAT_OPTION, 'botwa_incomplete', __( 'Enter the server address and the site key, otherwise the chat cannot appear.', 'botwa-chat' ), 'warning' );
		}
		return $new;
	}

	/** Explains what is wrong with the site key field; "webhook" / "api" mean another Botwa secret was pasted by mistake. */
	private static function wrong_key_message( $kind ) {
		if ( 'webhook' === $kind ) {
			return __( 'This is a webhook secret (it starts with whsec_), not the site key. The site key starts with wc_ and is in the embed code of the website chat in Botwa: data-key="wc_…". Keep the webhook secret private.', 'botwa-chat' );
		}
		if ( 'api' === $kind ) {
			return __( 'This is an API key (it starts with bk_), not the site key. The site key starts with wc_ and is in the embed code of the website chat in Botwa: data-key="wc_…". Keep the API key private.', 'botwa-chat' );
		}
		return __( 'The site key looks wrong. It starts with wc_ and is shown in the embed code in Botwa.', 'botwa-chat' );
	}

	public static function assets( $hook ) {
		if ( 'settings_page_' . self::PAGE !== $hook ) {
			return;
		}
		wp_enqueue_script( 'botwa-chat-admin', BOTWA_CHAT_URL . 'assets/admin.js', array(), BOTWA_CHAT_VERSION, true );
		wp_localize_script(
			'botwa-chat-admin',
			'BotwaChatAdmin',
			array(
				'ajax'  => admin_url( 'admin-ajax.php' ),
				'nonce' => wp_create_nonce( 'botwa_chat_test' ),
				'i18n'  => array(
					'testing' => __( 'Testing…', 'botwa-chat' ),
					'failed'  => __( 'The test could not be completed.', 'botwa-chat' ),
				),
			)
		);
	}

	/**
	 * "Test connection": asks the chat server for the widget configuration the way a visitor's browser would, including
	 * this site's origin, so a missing "allowed sites" entry shows up here and not as a silent missing chat button.
	 */
	public static function ajax_test() {
		check_ajax_referer( 'botwa_chat_test', 'nonce' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_send_json_error( array( 'message' => __( 'Not allowed.', 'botwa-chat' ) ), 403 );
		}
		$server = Botwa_Chat_Options::clean_server( isset( $_POST['server'] ) ? wp_unslash( $_POST['server'] ) : '' );
		$key    = Botwa_Chat_Options::clean_key( isset( $_POST['key'] ) ? wp_unslash( $_POST['key'] ) : '' );
		if ( '' === $key && isset( $_POST['key'] ) && '' !== Botwa_Chat_Options::wrong_key_kind( wp_unslash( $_POST['key'] ) ) ) {
			wp_send_json_error( array( 'message' => self::wrong_key_message( Botwa_Chat_Options::wrong_key_kind( wp_unslash( $_POST['key'] ) ) ) ) );
		}
		if ( '' === $server || '' === $key ) {
			wp_send_json_error( array( 'message' => __( 'Enter a valid server address and site key first.', 'botwa-chat' ) ) );
		}
		$origin = Botwa_Chat_Options::site_origin();
		// wp_safe_remote_get refuses private and loopback addresses, so this helper cannot be pointed at the internal network.
		$res = wp_safe_remote_get(
			$server . '/widget/config?key=' . rawurlencode( $key ),
			array(
				'timeout'     => 8,
				'redirection' => 0,
				'headers'     => array( 'Origin' => $origin ),
			)
		);
		if ( is_wp_error( $res ) ) {
			wp_send_json_error( array( 'message' => sprintf( /* translators: %s: error text */ __( 'Could not reach the server: %s', 'botwa-chat' ), $res->get_error_message() ) ) );
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		if ( 404 === $code ) {
			wp_send_json_error( array( 'message' => __( 'The server answered, but there is no chat with this site key.', 'botwa-chat' ) ) );
		}
		if ( 200 !== $code ) {
			wp_send_json_error( array( 'message' => sprintf( /* translators: %d: HTTP status */ __( 'The server answered with status %d.', 'botwa-chat' ), $code ) ) );
		}
		$data = json_decode( wp_remote_retrieve_body( $res ), true );
		if ( ! is_array( $data ) || empty( $data['design']['title'] ) ) {
			wp_send_json_error( array( 'message' => __( 'The server answer was not what a Botwa chat server returns.', 'botwa-chat' ) ) );
		}
		$allowed = wp_remote_retrieve_header( $res, 'access-control-allow-origin' );
		if ( '' === $allowed ) {
			wp_send_json_error(
				array(
					'message' => sprintf(
						/* translators: %s: this site's address */
						__( 'Connected, but this site (%s) is not in the allowed sites list of the chat in Botwa, so visitors will not see the chat. Add it there and test again.', 'botwa-chat' ),
						$origin
					),
				)
			);
		}
		wp_send_json_success(
			array(
				'message' => sprintf(
					/* translators: 1: chat title 2: yes/no */
					__( 'Connected. Chat: "%1$s". Available now: %2$s.', 'botwa-chat' ),
					sanitize_text_field( $data['design']['title'] ),
					! empty( $data['available'] ) ? __( 'yes', 'botwa-chat' ) : __( 'no (start the channel in Botwa)', 'botwa-chat' )
				),
			)
		);
	}

	public static function privacy_text() {
		if ( ! function_exists( 'wp_add_privacy_policy_content' ) ) {
			return;
		}
		wp_add_privacy_policy_content(
			__( 'Botwa Chat', 'botwa-chat' ),
			wp_kses_post(
				'<p class="privacy-policy-tutorial">' . __( 'Suggested text, to be reviewed for your situation:', 'botwa-chat' ) . '</p><p>' .
				__( 'This site offers a chat with our team. When you open the chat, a connection is made to our chat server and a random identifier is stored in your browser so that your conversation can continue. If you write to us, we store your messages and the details you enter (such as name, email or phone) to answer you.', 'botwa-chat' ) . '</p>'
			)
		);
	}

	private static function field( $name, $label, $input, $help = '' ) {
		echo '<tr><th scope="row"><label for="botwa-' . esc_attr( $name ) . '">' . esc_html( $label ) . '</label></th><td>' . $input; // phpcs:ignore WordPress.Security.EscapeOutput -- built from escaped parts below.
		if ( '' !== $help ) {
			echo '<p class="description">' . esc_html( $help ) . '</p>';
		}
		echo '</td></tr>';
	}

	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$o    = Botwa_Chat_Options::get();
		$name = BOTWA_CHAT_OPTION;
		$site = Botwa_Chat_Options::site_origin();
		$www  = preg_match( '#^(https?://)www\.#', $site ) ? preg_replace( '#^(https?://)www\.#', '$1', $site ) : preg_replace( '#^(https?://)#', '$1www.', $site );
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Botwa Chat', 'botwa-chat' ); ?></h1>
			<p><?php esc_html_e( 'Shows your Botwa website chat on this site. In Botwa: Channels > your website chat > widget settings, copy the site key from the embed code (data-key="wc_…") and add this site to the allowed sites.', 'botwa-chat' ); ?></p>
			<div class="notice notice-info inline"><p>
				<?php
				printf(
					/* translators: 1: this site's address 2: the same address with/without www */
					esc_html__( 'Add to "allowed sites" in Botwa: %1$s (and %2$s if visitors can reach the site that way).', 'botwa-chat' ),
					'<code>' . esc_html( $site ) . '</code>',
					'<code>' . esc_html( $www ) . '</code>'
				); // phpcs:ignore WordPress.Security.EscapeOutput -- both parts escaped above.
				?>
			</p></div>
			<?php settings_errors( BOTWA_CHAT_OPTION ); ?>
			<form method="post" action="options.php">
				<?php settings_fields( 'botwa_chat_group' ); ?>
				<h2 class="title"><?php esc_html_e( 'Connection', 'botwa-chat' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php
					self::field( 'enabled', __( 'Show the chat', 'botwa-chat' ), '<label><input type="checkbox" id="botwa-enabled" name="' . esc_attr( $name ) . '[enabled]" value="1"' . checked( 1, (int) $o['enabled'], false ) . '> ' . esc_html__( 'Enabled', 'botwa-chat' ) . '</label>' );
					self::field( 'server', __( 'Chat server address', 'botwa-chat' ), '<input type="url" class="regular-text" dir="ltr" id="botwa-server" name="' . esc_attr( $name ) . '[server]" value="' . esc_attr( $o['server'] ) . '" placeholder="https://chat.example.com">', __( 'The address of your Botwa server, without a path.', 'botwa-chat' ) );
					self::field( 'key', __( 'Site key', 'botwa-chat' ), '<input type="text" class="regular-text" dir="ltr" id="botwa-key" name="' . esc_attr( $name ) . '[key]" value="' . esc_attr( $o['key'] ) . '" placeholder="wc_…" autocomplete="off">', __( 'Public identifier of the chat. It is visible in your page source by design; it is not a secret.', 'botwa-chat' ) );
					?>
					<tr><th scope="row"><?php esc_html_e( 'Check', 'botwa-chat' ); ?></th><td>
						<button type="button" class="button" id="botwa-test"><?php esc_html_e( 'Test connection', 'botwa-chat' ); ?></button>
						<p id="botwa-test-result" role="status" aria-live="polite"></p>
					</td></tr>
				</table>

				<h2 class="title"><?php esc_html_e( 'Where it appears', 'botwa-chat' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php
					self::field( 'only_front', __( 'Front page only', 'botwa-chat' ), '<label><input type="checkbox" id="botwa-only_front" name="' . esc_attr( $name ) . '[only_front]" value="1"' . checked( 1, (int) $o['only_front'], false ) . '> ' . esc_html__( 'Show only on the home page', 'botwa-chat' ) . '</label>' );
					self::field( 'hide_admins', __( 'Administrators', 'botwa-chat' ), '<label><input type="checkbox" id="botwa-hide_admins" name="' . esc_attr( $name ) . '[hide_admins]" value="1"' . checked( 1, (int) $o['hide_admins'], false ) . '> ' . esc_html__( 'Do not show to logged-in administrators', 'botwa-chat' ) . '</label>' );
					self::field( 'exclude', __( 'Hide on these pages', 'botwa-chat' ), '<textarea id="botwa-exclude" name="' . esc_attr( $name ) . '[exclude]" rows="4" class="large-text code" dir="ltr" placeholder="/checkout&#10;/privacy">' . esc_textarea( $o['exclude'] ) . '</textarea>', __( 'One path per line. Everything that starts with the path is excluded.', 'botwa-chat' ) );
					?>
				</table>

				<h2 class="title"><?php esc_html_e( 'Privacy', 'botwa-chat' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php
					self::field( 'consent_mode', __( 'Wait for consent', 'botwa-chat' ), '<label><input type="checkbox" id="botwa-consent_mode" name="' . esc_attr( $name ) . '[consent_mode]" value="1"' . checked( 1, (int) $o['consent_mode'], false ) . '> ' . esc_html__( 'Load the chat only after your consent tool calls botwaChatLoad()', 'botwa-chat' ) . '</label>', __( 'For sites that must not contact other servers before the visitor agrees. Your cookie or consent plugin should call window.botwaChatLoad() once consent is given.', 'botwa-chat' ) );
					?>
				</table>

				<h2 class="title"><?php esc_html_e( 'Recognize logged-in customers (optional)', 'botwa-chat' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php
					self::field( 'identity_enabled', __( 'Recognition', 'botwa-chat' ), '<label><input type="checkbox" id="botwa-identity_enabled" name="' . esc_attr( $name ) . '[identity_enabled]" value="1"' . checked( 1, (int) $o['identity_enabled'], false ) . '> ' . esc_html__( 'Link the chat to the logged-in WordPress user', 'botwa-chat' ) . '</label>', __( 'The same customer then sees the same conversation on every device. The signature is computed on this server; the secret never reaches the browser.', 'botwa-chat' ) );
					self::field( 'identity_secret', __( 'Identity secret', 'botwa-chat' ), '<input type="password" class="regular-text" dir="ltr" id="botwa-identity_secret" name="' . esc_attr( $name ) . '[identity_secret]" value="" autocomplete="new-password" placeholder="' . esc_attr( '' !== $o['identity_secret'] ? __( 'Saved. Leave empty to keep it.', 'botwa-chat' ) : '' ) . '">', __( 'Create it in Botwa: widget settings > "Recognize a logged-in customer" > new secret.', 'botwa-chat' ) );
					if ( '' !== $o['identity_secret'] ) {
						self::field( 'identity_clear', __( 'Remove secret', 'botwa-chat' ), '<label><input type="checkbox" id="botwa-identity_clear" name="' . esc_attr( $name ) . '[identity_clear]" value="1"> ' . esc_html__( 'Delete the saved secret', 'botwa-chat' ) . '</label>' );
					}
					?>
				</table>
				<?php submit_button(); ?>
			</form>

			<h2 class="title"><?php esc_html_e( 'A "chat with us" button', 'botwa-chat' ); ?></h2>
			<p><?php esc_html_e( 'Place this shortcode anywhere, or give any link the address #botwa-chat, or any element the class botwa-open:', 'botwa-chat' ); ?></p>
			<p><code>[botwa_chat_button label="<?php echo esc_html( __( 'Chat with us', 'botwa-chat' ) ); ?>"]</code></p>
		</div>
		<?php
	}
}
