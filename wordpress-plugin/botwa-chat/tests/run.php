<?php
/**
 * Plain-PHP tests with a tiny stand-in for the WordPress functions the plugin uses (no WordPress needed):
 *   php tests/run.php
 * They check the plugin's own logic: validation, visibility rules, output escaping, signatures and the connection test.
 * They do NOT replace trying the plugin on a real WordPress site.
 */
define( 'ABSPATH', __DIR__ . '/' );
define( 'WP_UNINSTALL_PLUGIN', false );
$GLOBALS['t'] = array( 'opts' => array(), 'actions' => array(), 'filters' => array(), 'scripts' => array(), 'locals' => array(), 'errors' => array(), 'http' => null, 'json' => null, 'cap' => true, 'logged_in' => false, 'front' => true, 'admin' => false, 'user' => null, 'rest' => array(), 'version' => '6.5.0' );

class WP_Error { public $c; public $m; public function __construct( $c = '', $m = '', $d = null ) { $this->c = $c; $this->m = $m; } public function get_error_message() { return $this->m; } }
class Json_Stop extends Exception {}
function plugin_dir_path( $f ) { return dirname( $f ) . '/'; }
function plugin_dir_url( $f ) { return 'https://site.test/wp-content/plugins/botwa-chat/'; }
function plugin_basename( $f ) { return 'botwa-chat/botwa-chat.php'; }
function add_action( $h, $cb, $p = 10, $n = 1 ) { $GLOBALS['t']['actions'][ $h ][] = $cb; }
function add_filter( $h, $cb, $p = 10, $n = 1 ) { $GLOBALS['t']['filters'][ $h ][] = $cb; }
function add_shortcode( $n, $cb ) { $GLOBALS['t']['shortcodes'][ $n ] = $cb; }
function register_activation_hook( $f, $cb ) {}
function load_plugin_textdomain() {}
function __( $s ) { return $s; }
function esc_html__( $s ) { return htmlspecialchars( $s, ENT_QUOTES ); }
function esc_html_e( $s ) { echo htmlspecialchars( $s, ENT_QUOTES ); }
function esc_html( $s ) { return htmlspecialchars( (string) $s, ENT_QUOTES ); }
function esc_attr( $s ) { return htmlspecialchars( (string) $s, ENT_QUOTES ); }
function esc_url( $s ) { return $s; }
function esc_url_raw( $s ) { return $s; }
function esc_textarea( $s ) { return htmlspecialchars( (string) $s, ENT_QUOTES ); }
function wp_kses_post( $s ) { return $s; }
function checked( $a, $b, $echo = true ) { $r = ( (string) $a === (string) $b ) ? ' checked="checked"' : ''; if ( $echo ) { echo $r; } return $r; }
function get_option( $k, $d = false ) { return array_key_exists( $k, $GLOBALS['t']['opts'] ) ? $GLOBALS['t']['opts'][ $k ] : $d; }
function add_option( $k, $v ) { $GLOBALS['t']['opts'][ $k ] = $v; return true; }
function wp_parse_url( $u ) { return parse_url( $u ); }
function home_url() { return 'https://www.shop.test'; }
function admin_url( $p = '' ) { return 'https://www.shop.test/wp-admin/' . $p; }
function rest_url( $p = '' ) { return 'https://www.shop.test/wp-json/' . $p; }
function sanitize_text_field( $s ) { return trim( strip_tags( (string) $s ) ); }
function sanitize_html_class( $s ) { return preg_replace( '/[^A-Za-z0-9_-]/', '', (string) $s ); }
function wp_unslash( $s ) { return $s; }
function add_settings_error( $a, $b, $m, $t = 'error' ) { $GLOBALS['t']['errors'][] = $b; }
function is_admin() { return $GLOBALS['t']['admin']; }
function is_feed() { return false; }
function is_robots() { return false; }
function is_trackback() { return false; }
function wp_doing_ajax() { return false; }
function wp_is_json_request() { return false; }
function is_customize_preview() { return false; }
function is_front_page() { return $GLOBALS['t']['front']; }
function current_user_can( $c ) { return $GLOBALS['t']['cap']; }
function is_user_logged_in() { return $GLOBALS['t']['logged_in']; }
function wp_get_current_user() { return $GLOBALS['t']['user']; }
function apply_filters( $h, $v, ...$args ) { foreach ( $GLOBALS['t']['filters'][ $h ] ?? array() as $cb ) { $v = $cb( $v, ...$args ); } return $v; }
function get_bloginfo( $k ) { return $GLOBALS['t']['version']; }
function wp_enqueue_script( $h, $src, $deps = array(), $ver = false, $args = array() ) { $GLOBALS['t']['scripts'][ $h ] = $src; }
function wp_localize_script( $h, $name, $data ) { $GLOBALS['t']['locals'][ $h ] = $data; }
function wp_create_nonce( $a ) { return 'nonce-' . $a; }
function nocache_headers() { $GLOBALS['t']['nocache'] = true; }
function register_rest_route( $ns, $r, $a ) { $GLOBALS['t']['rest'][ $ns . $r ] = $a; }
function shortcode_atts( $d, $a, $s = '' ) { return array_merge( $d, is_array( $a ) ? $a : array() ); }
function check_ajax_referer( $a, $b ) { return true; }
function wp_safe_remote_get( $url, $args = array() ) { $GLOBALS['t']['http_calls'][] = array( $url, $args ); $r = $GLOBALS['t']['http']; return is_callable( $r ) ? $r( $url, $args ) : $r; }
function is_wp_error( $x ) { return $x instanceof WP_Error; }
function wp_remote_retrieve_response_code( $r ) { return $r['code']; }
function wp_remote_retrieve_body( $r ) { return $r['body']; }
function wp_remote_retrieve_header( $r, $h ) { return $r['headers'][ $h ] ?? ''; }
function wp_send_json_error( $d = null, $code = null ) { $GLOBALS['t']['json'] = array( false, $d, $code ); throw new Json_Stop(); }
function wp_send_json_success( $d = null ) { $GLOBALS['t']['json'] = array( true, $d, null ); throw new Json_Stop(); }
function register_setting() {}
function wp_add_privacy_policy_content() {}

$fails = 0; $n = 0;
function ok( $cond, $name ) { global $fails, $n; $n++; if ( ! $cond ) { $fails++; echo "FAIL $name\n"; } }
function eq( $a, $b, $name ) { ok( $a === $b, $name . ' (got ' . var_export( $a, true ) . ')' ); }
function reset_t() { $t = &$GLOBALS['t']; $t['opts'] = array(); $t['scripts'] = array(); $t['locals'] = array(); $t['errors'] = array(); $t['cap'] = false; $t['logged_in'] = false; $t['front'] = true; $t['admin'] = false; $t['filters'] = array(); $_SERVER['REQUEST_URI'] = '/'; }
function set_opts( $o ) { $GLOBALS['t']['opts']['botwa_chat_options'] = array_merge( Botwa_Chat_Options::defaults(), $o ); }

require dirname( __DIR__ ) . '/botwa-chat.php';

// ---- validation ----
eq( Botwa_Chat_Options::clean_server( 'https://Chat.Example.com/' ), 'https://chat.example.com', 'server: normalises case and slash' );
eq( Botwa_Chat_Options::clean_server( 'chat.example.com' ), 'https://chat.example.com', 'server: assumes https' );
eq( Botwa_Chat_Options::clean_server( 'https://chat.example.com:8443/path?x=1' ), 'https://chat.example.com:8443', 'server: drops path and query, keeps port' );
eq( Botwa_Chat_Options::clean_server( 'http://localhost:3077' ), 'http://localhost:3077', 'server: http only for localhost' );
foreach ( array( 'http://chat.example.com', 'ftp://x.com', 'javascript:alert(1)', 'https://user:pw@x.com', 'https://', 'https://exa mple.com', 'https://x.com:99999', "https://x.com\"><script>" ) as $bad ) {
	eq( Botwa_Chat_Options::clean_server( $bad ), '', 'server rejects ' . $bad );
}
eq( Botwa_Chat_Options::clean_key( ' wc_abcDEF123-_xyz ' ), 'wc_abcDEF123-_xyz', 'key: valid' );
foreach ( array( 'abc', 'wc_short', 'wc_' . str_repeat( 'a', 80 ), 'wc_abc"><script>alert(1)</script>', "wc_abcdefghij\nx" ) as $bad ) {
	eq( Botwa_Chat_Options::clean_key( $bad ), '', 'key rejects ' . $bad );
}
eq( Botwa_Chat_Options::clean_paths( "checkout\n/privacy\n\n<b>/x</b>\n/privacy" ), "/checkout\n/privacy\n/x", 'paths: slash added, tags stripped, deduplicated' );
eq( Botwa_Chat_Options::site_origin(), 'https://www.shop.test', 'site origin' );

// ---- saving ----
reset_t();
set_opts( array( 'server' => 'https://old.example.com', 'key' => 'wc_oldkeyoldkey1', 'identity_secret' => 'oldsecretoldsecretoldsecret' ) );
$r = Botwa_Chat_Settings::sanitize( array( 'enabled' => '1', 'server' => 'http://evil.com', 'key' => 'nope', 'identity_secret' => '' ) );
eq( $r['server'], 'https://old.example.com', 'save: bad server keeps the old one' );
eq( $r['key'], 'wc_oldkeyoldkey1', 'save: bad key keeps the old one' );
eq( $r['identity_secret'], 'oldsecretoldsecretoldsecret', 'save: empty secret field keeps the saved secret' );
ok( in_array( 'botwa_server', $GLOBALS['t']['errors'], true ) && in_array( 'botwa_key', $GLOBALS['t']['errors'], true ), 'save: tells the admin what was refused' );
$r = Botwa_Chat_Settings::sanitize( array( 'server' => 'https://new.example.com', 'key' => 'wc_newkeynewkey1', 'identity_secret' => 'a b', 'identity_enabled' => '1' ) );
eq( $r['identity_secret'], 'oldsecretoldsecretoldsecret', 'save: malformed secret is not stored' );
$r = Botwa_Chat_Settings::sanitize( array( 'identity_clear' => '1', 'identity_enabled' => '1' ) );
eq( array( $r['identity_secret'], $r['identity_enabled'] ), array( '', 0 ), 'save: removing the secret also turns recognition off' );
eq( Botwa_Chat_Settings::sanitize( 'garbage' )['enabled'], 0, 'save: non-array input is harmless' );

// ---- visibility ----
$base = array( 'enabled' => 1, 'server' => 'https://chat.example.com', 'key' => 'wc_abcdefghijk1', 'hide_admins' => 1 );
reset_t(); set_opts( $base ); ok( Botwa_Chat_Frontend::should_load(), 'visible to a normal visitor' );
reset_t(); set_opts( array_merge( $base, array( 'enabled' => 0 ) ) ); ok( ! Botwa_Chat_Frontend::should_load(), 'off when disabled' );
reset_t(); set_opts( array_merge( $base, array( 'key' => '' ) ) ); ok( ! Botwa_Chat_Frontend::should_load(), 'off without a key' );
reset_t(); set_opts( $base ); $GLOBALS['t']['cap'] = true; ok( ! Botwa_Chat_Frontend::should_load(), 'hidden from administrators' );
reset_t(); set_opts( array_merge( $base, array( 'hide_admins' => 0 ) ) ); $GLOBALS['t']['cap'] = true; ok( Botwa_Chat_Frontend::should_load(), 'administrators see it when allowed' );
reset_t(); set_opts( $base ); $GLOBALS['t']['admin'] = true; ok( ! Botwa_Chat_Frontend::should_load(), 'never in wp-admin' );
reset_t(); set_opts( array_merge( $base, array( 'only_front' => 1 ) ) ); $GLOBALS['t']['front'] = false; ok( ! Botwa_Chat_Frontend::should_load(), 'front page only' );
reset_t(); set_opts( array_merge( $base, array( 'exclude' => "/checkout\n/privacy" ) ) ); $_SERVER['REQUEST_URI'] = '/checkout/step-2?x=1'; ok( ! Botwa_Chat_Frontend::should_load(), 'excluded path prefix' );
$_SERVER['REQUEST_URI'] = '/shop/checkout'; ok( Botwa_Chat_Frontend::should_load(), 'a path that merely contains the word is not excluded' );
add_filter( 'botwa_chat_should_load', function () { return false; } ); ok( ! Botwa_Chat_Frontend::should_load(), 'developers can veto via filter' );

// ---- script output ----
reset_t(); set_opts( $base ); Botwa_Chat_Frontend::enqueue();
eq( $GLOBALS['t']['scripts']['botwa-chat'] ?? '', 'https://chat.example.com/widget.js', 'enqueues the widget script from the chat server' );
eq( $GLOBALS['t']['locals']['botwa-chat-frontend']['identity'], null, 'no identity request for anonymous visitors' );
$tag = Botwa_Chat_Frontend::script_tag( '<script src="https://chat.example.com/widget.js" id="botwa-chat-js"></script>', 'botwa-chat', '' );
ok( strpos( $tag, 'data-key="wc_abcdefghijk1"' ) !== false && strpos( $tag, ' async' ) !== false && strpos( $tag, 'data-no-optimize="1"' ) !== false, 'tag carries the key, async and optimiser opt-out' );
eq( Botwa_Chat_Frontend::script_tag( '<script src="x"></script>', 'other', '' ), '<script src="x"></script>', 'other scripts are untouched' );
reset_t(); set_opts( array_merge( $base, array( 'consent_mode' => 1 ) ) ); Botwa_Chat_Frontend::enqueue();
ok( ! isset( $GLOBALS['t']['scripts']['botwa-chat'] ) && true === $GLOBALS['t']['locals']['botwa-chat-frontend']['consent'], 'consent mode: nothing is loaded until botwaChatLoad() is called' );
reset_t(); set_opts( array_merge( $base, array( 'identity_enabled' => 1, 'identity_secret' => 'secretsecretsecretsecret1' ) ) ); $GLOBALS['t']['logged_in'] = true; Botwa_Chat_Frontend::enqueue();
ok( ! empty( $GLOBALS['t']['locals']['botwa-chat-frontend']['identity']['url'] ), 'identity request is set up for logged-in users' );
ok( strpos( json_encode( $GLOBALS['t']['locals'] ), 'secretsecret' ) === false, 'the identity secret is never put into the page' );

// ---- identity endpoint ----
reset_t(); set_opts( array_merge( $base, array( 'identity_enabled' => 1, 'identity_secret' => 'secretsecretsecretsecret1' ) ) );
$GLOBALS['t']['user'] = (object) array( 'ID' => 42, 'display_name' => 'Dana', 'user_email' => 'dana@example.com' );
$who = Botwa_Chat_Frontend::identity();
eq( $who['id'], 'wp-42', 'identity id' );
eq( $who['signature'], hash_hmac( 'sha256', 'wp-42', 'secretsecretsecretsecret1' ), 'identity signature = HMAC-SHA256(secret, id) (same as the Botwa server expects)' );
ok( ! empty( $GLOBALS['t']['nocache'] ), 'identity answer is not cacheable' );
add_filter( 'botwa_chat_identity_id', function () { return 'bad id!'; } ); ok( Botwa_Chat_Frontend::identity() instanceof WP_Error, 'a malformed id from a filter is refused' );
reset_t(); set_opts( $base ); ok( Botwa_Chat_Frontend::identity() instanceof WP_Error, 'identity is unavailable when not enabled' );
Botwa_Chat_Frontend::register_rest(); eq( $GLOBALS['t']['rest']['botwa-chat/v1/identity']['permission_callback'], 'is_user_logged_in', 'identity route needs a logged-in user' );

// ---- shortcode ----
reset_t();
$html = Botwa_Chat_Frontend::shortcode( array( 'label' => '<img src=x onerror=alert(1)>', 'class' => 'big "x" btn' ) );
ok( strpos( $html, '<img' ) === false && strpos( $html, 'class="botwa-open big x btn"' ) !== false, 'shortcode escapes the label and the classes' );

// ---- connection test ----
function run_test( $post ) { $_POST = $post; $GLOBALS['t']['cap'] = true; $GLOBALS['t']['json'] = null; try { Botwa_Chat_Settings::ajax_test(); } catch ( Json_Stop $e ) {} return $GLOBALS['t']['json']; }
$good = array( 'server' => 'https://chat.example.com', 'key' => 'wc_abcdefghijk1' );
$GLOBALS['t']['http'] = array( 'code' => 200, 'body' => json_encode( array( 'design' => array( 'title' => 'Support' ), 'available' => true ) ), 'headers' => array( 'access-control-allow-origin' => 'https://www.shop.test' ) );
$j = run_test( $good ); ok( $j[0] && strpos( $j[1]['message'], 'Support' ) !== false, 'test: connected' );
eq( $GLOBALS['t']['http_calls'][0][1]['headers']['Origin'], 'https://www.shop.test', 'test: asks as this site (Origin header)' );
eq( $GLOBALS['t']['http_calls'][0][1]['redirection'], 0, 'test: does not follow redirects' );
$GLOBALS['t']['http']['headers'] = array(); $j = run_test( $good ); ok( ! $j[0] && strpos( $j[1]['message'], 'allowed sites' ) !== false, 'test: tells when this site is not allowed in Botwa' );
$GLOBALS['t']['http'] = array( 'code' => 404, 'body' => '', 'headers' => array() ); $j = run_test( $good ); ok( ! $j[0], 'test: unknown key' );
$GLOBALS['t']['http'] = array( 'code' => 200, 'body' => '<html>', 'headers' => array() ); $j = run_test( $good ); ok( ! $j[0], 'test: not a Botwa server' );
$GLOBALS['t']['http'] = new WP_Error( 'x', 'timeout' ); $j = run_test( $good ); ok( ! $j[0] && strpos( $j[1]['message'], 'timeout' ) !== false, 'test: network error is reported' );
$j = run_test( array( 'server' => 'http://169.254.169.254', 'key' => 'wc_abcdefghijk1' ) ); ok( ! $j[0], 'test: refuses a non-https, non-localhost address before any request' );
$GLOBALS['t']['cap'] = false; $_POST = $good; $GLOBALS['t']['json'] = null; try { Botwa_Chat_Settings::ajax_test(); } catch ( Json_Stop $e ) {} ok( false === $GLOBALS['t']['json'][0] && 403 === $GLOBALS['t']['json'][2], 'test: only administrators' );

// ---- settings page renders without notices and escapes stored values ----
reset_t(); $GLOBALS['t']['cap'] = true; set_opts( array_merge( $base, array( 'exclude' => '/a"><script>alert(1)</script>', 'server' => 'https://chat.example.com' ) ) );
function settings_fields() {} function submit_button() {} function settings_errors() {}
ob_start(); Botwa_Chat_Settings::render(); $page = ob_get_clean();
ok( strpos( $page, '<script>alert(1)' ) === false, 'settings page escapes stored values' );
ok( strpos( $page, 'https://shop.test' ) !== false && strpos( $page, 'https://www.shop.test' ) !== false, 'settings page shows this site with and without www' );
ok( strpos( $page, 'value="wc_abcdefghijk1"' ) !== false, 'settings page shows the key' );

// ---- the wrong Botwa value pasted into the key field is recognised ----
reset_t(); set_opts( array( 'server' => 'https://chat.example.com', 'key' => 'wc_goodkeygoodkey1' ) );
$r = Botwa_Chat_Settings::sanitize( array( 'server' => 'https://chat.example.com', 'key' => 'whsec_EXAMPLEEXAMPLEEXAMPLEEXAMPLE000' ) );
eq( $r['key'], 'wc_goodkeygoodkey1', 'webhook secret in the key field is refused and the old key kept' );
eq( Botwa_Chat_Options::wrong_key_kind( 'whsec_abc' ) . '/' . Botwa_Chat_Options::wrong_key_kind( 'bk_abc_def' ) . '/' . Botwa_Chat_Options::wrong_key_kind( 'wc_ok' ), 'webhook/api/', 'wrong_key_kind' );
$j = run_test( array( 'server' => 'https://chat.example.com', 'key' => 'whsec_EXAMPLEEXAMPLEEXAMPLEEXAMPLE000' ) );
ok( ! $j[0] && strpos( $j[1]['message'], 'webhook secret' ) !== false, 'connection test names the mistake' );

// ---- forgiving paste handling, specific messages ----
eq( Botwa_Chat_Options::clean_key( "\u{200F}wc_abcDEF123-_xyz\u{200E} " ), 'wc_abcDEF123-_xyz', 'key: direction marks from a right-to-left page are ignored' );
eq( Botwa_Chat_Options::clean_key( '"wc_abcDEF123-_xyz"' ), 'wc_abcDEF123-_xyz', 'key: quotes are ignored' );
eq( Botwa_Chat_Options::clean_key( 'data-key="wc_abcDEF123-_xyz"' ), 'wc_abcDEF123-_xyz', 'key: the data-key attribute can be pasted' );
eq( Botwa_Chat_Options::clean_key( '<script src="https://chat.example.com/widget.js" data-key="wc_abcDEF123-_xyz" async></script>' ), 'wc_abcDEF123-_xyz', 'key: the whole embed code can be pasted' );
eq( Botwa_Chat_Options::clean_key( 'whsec_xxxxxxxxwc_abcDEF123-_xyzxxxx' ), '', 'key: a webhook secret is never accepted, even if it contains wc_' );
eq( Botwa_Chat_Options::clean_server( '<script src="https://chat.example.com/widget.js" data-key="wc_x"></script>' ), 'https://chat.example.com', 'server: the embed code can be pasted' );
eq( Botwa_Chat_Options::clean_server( "\u{200E}https://chat.example.com/widget.js" ), 'https://chat.example.com', 'server: a full widget.js address is reduced to the origin' );
$j = run_test( array( 'server' => '', 'key' => 'wc_abcdefghijk1' ) ); ok( ! $j[0] && strpos( $j[1]['message'], 'server address first' ) !== false, 'test message: missing server' );
$j = run_test( array( 'server' => 'http://chat.example.com', 'key' => 'wc_abcdefghijk1' ) ); ok( ! $j[0] && strpos( $j[1]['message'], 'not valid' ) !== false, 'test message: invalid server' );
$j = run_test( array( 'server' => 'https://chat.example.com', 'key' => '' ) ); ok( ! $j[0] && strpos( $j[1]['message'], 'site key first' ) !== false, 'test message: missing key' );
$j = run_test( array( 'server' => 'https://chat.example.com', 'key' => 'abc-123' ) ); ok( ! $j[0] && strpos( $j[1]['message'], 'looks wrong' ) !== false, 'test message: invalid key' );

// ---- packaged defaults (plugin downloaded from Botwa for one chat) ----
$f = dirname( __DIR__ ) . '/botwa-chat-defaults.php';
file_put_contents( $f, "<?php return array( 'server' => 'https://chat.example.com/', 'key' => 'wc_packagedkey123' );" );
reset_t();
$d = Botwa_Chat_Options::defaults();
eq( array( $d['enabled'], $d['server'], $d['key'] ), array( 1, 'https://chat.example.com', 'wc_packagedkey123' ), 'packaged: works right after activation' );
file_put_contents( $f, "<?php return array( 'server' => 'http://evil.example.com', 'key' => '\"><script>' );" );
$d = Botwa_Chat_Options::defaults();
eq( array( $d['enabled'], $d['server'], $d['key'] ), array( 0, '', '' ), 'packaged: a damaged file enables nothing' );
unlink( $f );

echo "$n checks, $fails failed\n";
exit( $fails ? 1 : 0 );
