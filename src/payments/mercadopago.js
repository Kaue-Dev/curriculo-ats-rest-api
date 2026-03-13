import { getPrisma } from '../db/prisma.js';

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const MP_WEBHOOK_URL = process.env.MP_WEBHOOK_URL || '';

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
