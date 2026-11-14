import crypto from 'node:crypto';
import type http from 'node:http';

const COOKIE_NAME = 'openrabbit_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function signature(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function tokensEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createSession(secret: string, nowMs = Date.now()): string {
  const expires = String(Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS);
  return `${expires}.${signature(expires, secret)}`;
}

export function isAuthenticated(
  req: http.IncomingMessage,
  adminToken: string | undefined,
  nowMs = Date.now()
): boolean {
  if (!adminToken) return process.env.NODE_ENV !== 'production';
  const cookies = (req.headers.cookie || '').split(';').map((part) => part.trim());
  const session = cookies
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  if (!session) return false;
  const [expires, providedSignature] = session.split('.');
  if (!/^\d+$/.test(expires || '') || !providedSignature) return false;
  if (Number(expires) <= Math.floor(nowMs / 1000)) return false;
  return tokensEqual(providedSignature, signature(expires, adminToken));
}

export function sessionCookie(secret: string, secure: boolean): string {
  return `${COOKIE_NAME}=${createSession(secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
