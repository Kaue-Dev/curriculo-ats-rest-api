import { getPrisma } from '../db/prisma.js';
import crypto from 'node:crypto';

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const MP_WEBHOOK_URL = process.env.MP_WEBHOOK_URL || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';

const PRICE_BRL = Number(process.env.PRICE_BRL || 7.9);
const CREDITS_PER_PURCHASE = Number(process.env.CREDITS_PER_PURCHASE || 3);

function assertConfigured() {
  if (!MP_ACCESS_TOKEN) throw new Error('MP_ACCESS_TOKEN não configurado.');
}

function buildBackUrls() {
  let baseUrl;
  try {
    baseUrl = new URL(FRONTEND_URL);
  } catch {
    throw new Error(`FRONTEND_URL inválida: "${FRONTEND_URL}". Use algo como http://localhost:3000`);
  }

  const isTestToken = MP_ACCESS_TOKEN?.includes('TEST');
  if (!isTestToken && baseUrl.protocol !== 'https:') {
    throw new Error('FRONTEND_URL deve usar https em produção (token APP_USR).');
  }

  return {
    success: new URL('/?mp=success', baseUrl.origin).toString(),
    pending: new URL('/?mp=pending', baseUrl.origin).toString(),
    failure: new URL('/?mp=failure', baseUrl.origin).toString(),
  };
}

function parseWebhookSignatureHeader(signatureHeader) {
  const out = {};
  for (const part of String(signatureHeader || '').split(',')) {
    const [k, v] = part.split('=');
    if (!k || !v) continue;
    out[k.trim()] = v.trim();
  }
  return { ts: out.ts, v1: out.v1 };
}

export function verifyMercadoPagoWebhookSignature({ signatureHeader, requestIdHeader, dataId }) {
  if (!MP_WEBHOOK_SECRET) return { ok: true, skipped: true };

  const signature = String(signatureHeader || '').trim();
  const requestId = String(requestIdHeader || '').trim();
  const id = String(dataId || '').trim();

  if (!signature || !requestId || !id) {
    return { ok: false, reason: 'missing_signature_or_request_id_or_data_id' };
  }

  const { ts, v1 } = parseWebhookSignatureHeader(signature);
  if (!ts || !v1) return { ok: false, reason: 'invalid_signature_header_format' };

  let tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'invalid_ts' };
  if (tsNum < 1e12) tsNum *= 1000; // seconds -> ms

  const now = Date.now();
  const skewMs = Math.abs(now - tsNum);
  if (skewMs > 10 * 60 * 1000) {
    return { ok: false, reason: 'ts_out_of_tolerance' };
  }

  // Docs mention: if the ID is strictly alphanumeric, convert to lowercase.
  const idForManifest = /^[A-Z0-9]+$/.test(id) ? id.toLowerCase() : id;

  const manifest = `id:${idForManifest};request-id:${requestId};ts:${ts};`;
  const expectedHex = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');

  if (!/^[0-9a-fA-F]{64}$/.test(v1) || !/^[0-9a-f]{64}$/.test(expectedHex)) {
    return { ok: false, reason: 'invalid_hex' };
  }

  const expected = Buffer.from(expectedHex, 'hex');
  const received = Buffer.from(v1, 'hex');
  if (expected.length !== received.length) return { ok: false, reason: 'length_mismatch' };

  const ok = crypto.timingSafeEqual(expected, received);
  return ok ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

export async function createCheckoutPreference({ sessionId }) {
  assertConfigured();

  const body = {
    items: [
      {
        title: `Desbloqueio premium (3 créditos)`,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: PRICE_BRL,
      },
    ],
    payment_methods: {
      // Keep only PIX + credit card
      excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }, { id: 'debit_card' }, { id: 'prepaid_card' }],
      installments: 1,
    },
    external_reference: sessionId,
    back_urls: buildBackUrls(),
    auto_return: 'approved',
    statement_descriptor: 'Curriculo ATS',
    ...(MP_WEBHOOK_URL ? { notification_url: MP_WEBHOOK_URL } : {}),
    metadata: {
      sessionId,
      credits: CREDITS_PER_PURCHASE,
    },
  };

  const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = json?.message || json?.error || response.statusText || 'Erro Mercado Pago.';
    const err = new Error(`[MercadoPago] ${message}`);
    err.status = response.status;
    err.raw = json;
    throw err;
  }

  const prisma = getPrisma();
  await prisma.payment.create({
    data: {
      provider: 'mercadopago',
      sessionId,
      amount: PRICE_BRL,
      currency: 'BRL',
      preferenceId: json.id || null,
      status: 'created',
      raw: json,
    },
  });

  return {
    preferenceId: json.id,
    initPoint: json.init_point,
    sandboxInitPoint: json.sandbox_init_point,
  };
}

export async function fetchPayment(paymentId) {
  assertConfigured();

  const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
    },
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = json?.message || json?.error || response.statusText || 'Erro Mercado Pago.';
    const err = new Error(`[MercadoPago] ${message}`);
    err.status = response.status;
    err.raw = json;
    throw err;
  }

  return json;
}
