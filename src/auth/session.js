import crypto from 'node:crypto';
import { getPrisma } from '../db/prisma.js';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'cv_session';

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;

  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function buildSetCookie({ name, value, isProd }) {
  const chunks = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 365}`, // 1 year
  ];
  if (isProd) chunks.push('Secure');
  return chunks.join('; ');
}

export function getAdminTokenFromRequest(request) {
  const header = request.headers['x-admin-token'];
  if (!header) return null;
  if (Array.isArray(header)) return header[0] || null;
  return String(header);
}

export function isAdminRequest(request) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = getAdminTokenFromRequest(request);
  if (!provided) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function getOrCreateSessionId(request, reply) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieHeader = request.headers.cookie;
  const cookies = parseCookies(cookieHeader);
  const existing = cookies[SESSION_COOKIE_NAME];

  const prisma = getPrisma();

  if (existing) {
    const session = await prisma.session.findUnique({ where: { id: existing } });
    if (session) return { sessionId: session.id };
  }

  const sessionId = crypto.randomUUID();
  await prisma.session.create({ data: { id: sessionId } });

  const setCookie = buildSetCookie({ name: SESSION_COOKIE_NAME, value: sessionId, isProd });
  reply.header('Set-Cookie', setCookie);

  return { sessionId };
}

