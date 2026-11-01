<?php
/**
 * Plugin Name:       Botwa Chat
 * Description:       Adds your Botwa website chat widget to this WordPress site: one setting, optional logged-in customer recognition, and a shortcode for a "chat with us" button.
 * Version:           1.0.1
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Botwa
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       botwa-chat
 * Domain Path:       /languages
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BOTWA_CHAT_VERSION', '1.0.1' );
define( 'BOTWA_CHAT_FILE', __FILE__ );
define( 'BOTWA_CHAT_DIR', plugin_dir_path( __FILE__ ) );
define( 'BOTWA_CHAT_URL', plugin_dir_url( __FILE__ ) );
define( 'BOTWA_CHAT_OPTION', 'botwa_chat_options' );

require_once BOTWA_CHAT_DIR . 'includes/class-botwa-chat-options.php';
require_once BOTWA_CHAT_DIR . 'includes/class-botwa-chat-settings.php';
require_once BOTWA_CHAT_DIR . 'includes/class-botwa-chat-frontend.php';

add_action(
	'plugins_loaded',
	function () {
		load_plugin_textdomain( 'botwa-chat', false, dirname( plugin_basename( BOTWA_CHAT_FILE ) ) . '/languages' );
	}
);

Botwa_Chat_Settings::init();
Botwa_Chat_Frontend::init();

register_activation_hook(
	__FILE__,
	function () {
		if ( false === get_option( BOTWA_CHAT_OPTION ) ) {
			add_option( BOTWA_CHAT_OPTION, Botwa_Chat_Options::defaults(), '', false );
		}
	}
);
