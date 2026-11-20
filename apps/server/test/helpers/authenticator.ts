import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

// A tiny software FIDO2 authenticator (ES256, "none" attestation) for tests: the server verifies REAL WebAuthn structures.
const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');

function cbor(v: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    throw new Error('too large for test encoder');
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  throw new Error('unsupported');
}

export interface Authenticator {
  credentialId: Buffer;
  counter: number;
  privateKey: KeyObject;
  register(opts: { challenge: string; origin: string; rpID: string; uv?: boolean }): unknown;
  assert(opts: { challenge: string; origin: string; rpID: string; uv?: boolean; counter?: number; userHandle?: Buffer; tamper?: boolean }): unknown;
}

export function newAuthenticator(): Authenticator {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const credentialId = randomBytes(32);
  const rpHash = (rpID: string) => createHash('sha256').update(rpID).digest();
  const flags = (uv: boolean, at: boolean) => (0x01 | (uv ? 0x04 : 0) | (at ? 0x40 : 0));
  const clientData = (type: string, challenge: string, origin: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  const a: Authenticator = {
    credentialId, counter: 0, privateKey,
    register({ challenge, origin, rpID, uv = true }) {
      const cd = clientData('webauthn.create', challenge, origin);
      const counter = Buffer.alloc(4);
      const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([rpHash(rpID), Buffer.from([flags(uv, true)]), counter, Buffer.alloc(16), idLen, credentialId, cose]);
      const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id: b64u(credentialId), rawId: b64u(credentialId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(cd), attestationObject: b64u(attestationObject), transports: ['internal'] },
      };
    },
    assert({ challenge, origin, rpID, uv = true, counter, userHandle, tamper }) {
      a.counter = counter ?? a.counter + 1;
      const cd = clientData('webauthn.get', challenge, origin);
      const ctr = Buffer.alloc(4); ctr.writeUInt32BE(a.counter);
      const authData = Buffer.concat([rpHash(rpID), Buffer.from([flags(uv, false)]), ctr]);
      const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(cd).digest()]), privateKey);
      if (tamper) signature[signature.length - 1] = signature[signature.length - 1]! ^ 0xff;
      return {
        id: b64u(credentialId), rawId: b64u(credentialId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature), ...(userHandle ? { userHandle: b64u(userHandle) } : {}) },
      };
    },
  };
  return a;
}
