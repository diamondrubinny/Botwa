( function () {
	'use strict';
	var btn = document.getElementById( 'botwa-test' );
	var out = document.getElementById( 'botwa-test-result' );
	if ( ! btn || ! out || ! window.BotwaChatAdmin ) { return; }
	btn.addEventListener( 'click', function () {
		var body = new URLSearchParams();
		body.set( 'action', 'botwa_chat_test' );
		body.set( 'nonce', window.BotwaChatAdmin.nonce );
		body.set( 'server', document.getElementById( 'botwa-server' ).value );
		body.set( 'key', document.getElementById( 'botwa-key' ).value );
		out.textContent = window.BotwaChatAdmin.i18n.testing;
		out.style.color = '';
		btn.disabled = true;
		fetch( window.BotwaChatAdmin.ajax, { method: 'POST', credentials: 'same-origin', body: body } )
			.then( function ( r ) { return r.json(); } )
			.then( function ( j ) {
				out.textContent = ( j && j.data && j.data.message ) || window.BotwaChatAdmin.i18n.failed;
				out.style.color = j && j.success ? '#007017' : '#b32d2e';
			} )
			.catch( function () { out.textContent = window.BotwaChatAdmin.i18n.failed; out.style.color = '#b32d2e'; } )
			.then( function () { btn.disabled = false; } );
	} );
}() );
