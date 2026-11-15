// JWT do Cloudflare Access assinado no teste, com um verificador sem rede (#54, usado pelo #71).
import { createAccessVerifier, type FetchJwks } from '../../src/http/access.js';
import type { Env } from '../../src/env.js';

export const TEAM = 'barte-academy.cloudflareaccess.com';
export const AUD = 'aud-da-aplicacao';
export const accessEnv: Env = { ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM };

const ALG = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function utf8b64url(text: string): string {
  return b64url(String.fromCharCode(...new TextEncoder().encode(text)));
}

export type AccessKit = { verifier: ReturnType<typeof createAccessVerifier>; token: () => Promise<string> };

/** Gera um par de chaves, um verificador que confia nele e uma função que assina um token válido. */
export async function accessKit(email = 'cfo@jachegou.test'): Promise<AccessKit> {
  const key = (await crypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey('jwk', key.publicKey)) as JsonWebKey), kid: 'kid-1' };
  const fetchJwks: FetchJwks = async () => ({ keys: [jwk] });
  const token = async () => {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid: 'kid-1', typ: 'JWT' };
    const payload = { aud: [AUD], iss: `https://${TEAM}`, email, iat: now, nbf: now - 5, exp: now + 300 };
    const input = `${utf8b64url(JSON.stringify(header))}.${utf8b64url(JSON.stringify(payload))}`;
    const signature = await crypto.subtle.sign(ALG.name, key.privateKey, new TextEncoder().encode(input));
    return `${input}.${b64url(new Uint8Array(signature))}`;
  };
  return { verifier: createAccessVerifier(fetchJwks), token };
}
