import { hash, verify } from '@node-rs/argon2';

// argon2id (default algorithm of @node-rs/argon2), OWASP-recommended params.
const opts = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (pw: string) => hash(pw, opts);
export const verifyPassword = (hashed: string, pw: string) => verify(hashed, pw).catch(() => false);

let dummy: Promise<string> | undefined;
/** Burn equivalent time for unknown users to avoid user enumeration by timing. */
export async function dummyVerify(pw: string): Promise<void> {
  dummy ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummy, pw);
}

export const PASSWORD_MIN = 12;
