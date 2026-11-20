/* Botwa Chat for WordPress: consent-gated loading, "open chat" buttons and logged-in customer recognition. */
( function () {
	'use strict';
	var cfg = window.BotwaChatWP;
	if ( ! cfg ) { return; }

	function loadWidget() {
		if ( document.getElementById( 'botwa-chat-js' ) ) { return; }
		var s = document.createElement( 'script' );
		s.id = 'botwa-chat-js';
		s.async = true;
		s.src = cfg.server + '/widget.js';
		s.setAttribute( 'data-key', cfg.key );
		document.body.appendChild( s );
	}
	// For consent tools: call botwaChatLoad() once the visitor agrees.
	window.botwaChatLoad = loadWidget;

	function whenReady( fn, tries ) {
		if ( window.BotwaChat && window.BotwaChat.on ) { fn( window.BotwaChat ); return; }
		if ( ( tries || 0 ) > 100 ) { return; }
		setTimeout( function () { whenReady( fn, ( tries || 0 ) + 1 ); }, 100 );
	}

	function openChat() {
		if ( cfg.consent && ! window.BotwaChat ) { return; } // not loaded: no consent yet
		whenReady( function ( chat ) { chat.open(); } );
	}

	document.addEventListener( 'click', function ( e ) {
		var el = e.target && e.target.closest ? e.target.closest( '.botwa-open, a[href="#botwa-chat"]' ) : null;
		if ( ! el ) { return; }
		e.preventDefault();
		openChat();
	} );

	if ( cfg.identity ) {
		fetch( cfg.identity.url, { credentials: 'same-origin', headers: { 'X-WP-Nonce': cfg.identity.nonce }, cache: 'no-store' } )
			.then( function ( r ) { return r.ok ? r.json() : null; } )
			.then( function ( who ) {
				if ( who && who.id && who.signature ) { whenReady( function ( chat ) { chat.identify( who ); } ); }
			} )
			.catch( function () { /* anonymous chat still works */ } );
	}
}() );
