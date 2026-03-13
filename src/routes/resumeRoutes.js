import { extractTextFromFile, evaluateResume, evaluateResumeFree } from '../services/resumeService.js';
import { getOrCreateSessionId, isAdminRequest } from '../auth/session.js';
import { consumeCredit, getCreditsBalance, grantCredits, resetCredits } from '../billing/credits.js';
import { getPrisma } from '../db/prisma.js';
import { createCheckoutPreference, fetchPayment } from '../payments/mercadopago.js';

export async function resumeRoutes(fastify) {
  const DATA_RETENTION_DAYS = Number(process.env.DATA_RETENTION_DAYS || 1);

  function buildResponse({
    evaluation,
    analysis,
    isUnlocked,
    lockedSectionsCount,
    lockedTipsCount,
    creditsBalance,
  }) {
    const base = {
      success: true,
      analysis: analysis
        ? {
            id: analysis.id,
            filename: analysis.filename,
            createdAt: analysis.createdAt,
          }
        : null,
      premium: {
        unlocked: isUnlocked,
        lockedSectionsCount,
        lockedTipsCount,
      },
      credits: {
        balance: creditsBalance,
      },
    };

    if (isUnlocked) return { ...base, evaluation };

    const sections = Array.isArray(evaluation?.sections) ? evaluation.sections : [];
    const lockedSections = Array.isArray(evaluation?.lockedSections)
      ? evaluation.lockedSections
      : sections.slice(2);
    const lockedTips = lockedSections.reduce((sum, section) => {
      const tipCount =
        typeof section?.tipCount === 'number'
          ? section.tipCount
          : Array.isArray(section?.tips)
            ? section.tips.length
            : 0;
      return sum + tipCount;
    }, 0);
    return {
      ...base,
      evaluation: {
        ...evaluation,
        sections: sections.slice(0, 2),
      },
      premium: {
        ...base.premium,
        lockedTipsCount: lockedTips,
      },
    };
  }

  fastify.post('/resume/evaluate', async (request, reply) => {
    const isProd = process.env.NODE_ENV === 'production';
    const isAdmin = isAdminRequest(request);
    const { sessionId } = await getOrCreateSessionId(request, reply);
    let file = null;

    try {
      file = await request.file();
    } catch {
      return reply.status(400).send({ error: 'Envie um arquivo via multipart/form-data.' });
    }

    if (!file) {
      return reply.status(400).send({ error: 'Arquivo de currículo é obrigatório.' });
    }

    try {
      request.log.info(
        {
          filename: file.filename,
          mimetype: file.mimetype,
        },
        'Processando currículo'
      );

      const text = await extractTextFromFile(file);

      if (!text || !text.trim()) {
        return reply.status(400).send({
          error: 'Não foi possível extrair texto do arquivo enviado. Verifique se o PDF/DOCX não está protegido ou somente-imagem.'
        });
      }

      request.log.info({ extractedChars: text.length }, 'Texto extraído do currículo');

      const creditsBalanceBefore = isAdmin ? 999999 : await getCreditsBalance(sessionId);
      const evaluation =
        isAdmin || creditsBalanceBefore > 0 ? await evaluateResume(text) : await evaluateResumeFree(text);

      const prisma = getPrisma();
      const analysis = await prisma.analysis.create({
        data: {
          sessionId,
          filename: file.filename || null,
          model: process.env.GEMINI_MODEL || null,
          resumeText: text,
          evaluation,
        },
      });

      let creditsBalance = creditsBalanceBefore;
      let isUnlocked = isAdmin;

      if (!isAdmin && creditsBalance > 0) {
        await consumeCredit(sessionId, analysis.id, 'analysis');
        creditsBalance -= 1;
        isUnlocked = true;
      }

      const sections = Array.isArray(evaluation?.sections) ? evaluation.sections : [];
      const lockedSectionsCount = isUnlocked
        ? 0
        : Array.isArray(evaluation?.lockedSections)
          ? evaluation.lockedSections.length
          : Math.max(0, sections.length - 2);
      const lockedTipsCount = isUnlocked
        ? 0
        : Array.isArray(evaluation?.lockedSections)
          ? evaluation.lockedSections.reduce((sum, section) => sum + (section?.tipCount || 0), 0)
          : sections.slice(2).reduce((sum, section) => sum + (section?.tips?.length || 0), 0);

      if (Number.isFinite(DATA_RETENTION_DAYS) && DATA_RETENTION_DAYS > 0) {
        const cutoff = new Date(Date.now() - DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        await prisma.analysis.deleteMany({
          where: {
            sessionId,
            createdAt: { lt: cutoff },
          },
        });
      }

      return reply.send(
        buildResponse({
          evaluation,
          analysis,
          isUnlocked,
          lockedSectionsCount,
          lockedTipsCount,
          creditsBalance,
        })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || '');
      const status =
        err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
          ? err.status
          : undefined;

      const retryAfterSeconds = (() => {
        const match = message.match(/Please retry in ([0-9.]+)s/i);
        if (!match) return null;
        const seconds = Number(match[1]);
        if (!Number.isFinite(seconds) || seconds <= 0) return null;
        return Math.ceil(seconds);
      })();
      request.log.error({ err }, 'Erro ao processar currículo');

      if (message.includes('GEMINI_API_KEY')) {
        return reply.status(503).send({ error: message });
      }

      if (message.toLowerCase().includes('timeout')) {
        return reply.status(504).send({ error: message });
      }

      if (status === 429 || message.includes('[429') || message.includes('429 Too Many Requests')) {
        if (retryAfterSeconds) reply.header('Retry-After', String(retryAfterSeconds));
        return reply.status(429).send({
          error: 'Limite de uso (quota) excedido na API do Gemini. Tente novamente mais tarde.',
          ...(isProd ? {} : { details: message }),
          reqId: request.id,
        });
      }

      return reply.status(500).send({
        error: 'Erro ao processar currículo.',
        ...(isProd ? {} : { details: message || String(err) }),
        reqId: request.id,
      });
    }
  });

  fastify.get('/resume/latest', async (request, reply) => {
    const isAdmin = isAdminRequest(request);
    const { sessionId } = await getOrCreateSessionId(request, reply);

    const prisma = getPrisma();
    const analysis = await prisma.analysis.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
    });

    if (!analysis) {
      return reply.status(404).send({ error: 'Nenhuma análise encontrada.' });
    }

    const evaluation = analysis.evaluation;
    const creditsBalance = isAdmin ? 999999 : await getCreditsBalance(sessionId);
    const usage = isAdmin
      ? null
      : await prisma.creditUsage.findFirst({ where: { sessionId, analysisId: analysis.id } });
    const isUnlocked = isAdmin || !!usage;
    const sections = Array.isArray(evaluation?.sections) ? evaluation.sections : [];
    const lockedSectionsCount = isUnlocked
      ? 0
      : Array.isArray(evaluation?.lockedSections)
        ? evaluation.lockedSections.length
        : Math.max(0, sections.length - 2);
    const lockedTipsCount = isUnlocked
      ? 0
      : Array.isArray(evaluation?.lockedSections)
        ? evaluation.lockedSections.reduce((sum, section) => sum + (section?.tipCount || 0), 0)
        : sections.slice(2).reduce((sum, section) => sum + (section?.tips?.length || 0), 0);

    return reply.send(
      buildResponse({
        evaluation,
        analysis,
        isUnlocked,
        lockedSectionsCount,
        lockedTipsCount,
        creditsBalance,
      })
    );
  });

  fastify.post('/resume/unlock-latest', async (request, reply) => {
    const isAdmin = isAdminRequest(request);
    const { sessionId } = await getOrCreateSessionId(request, reply);

    const prisma = getPrisma();
    const analysis = await prisma.analysis.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
    });

    if (!analysis) {
      return reply.status(404).send({ error: 'Nenhuma análise encontrada.' });
    }

    if (isAdmin) {
      // Admin can always see full, but if this analysis was generated in free-mode we still need resumeText.
      if (!analysis.resumeText) {
        return reply.status(400).send({ error: 'Não foi possível desbloquear sem reavaliar. Envie o currículo novamente.' });
      }

      const evaluation = await evaluateResume(analysis.resumeText);
      const updated = await prisma.analysis.update({
        where: { id: analysis.id },
        data: { evaluation },
      });

      return reply.send(
        buildResponse({
          evaluation: updated.evaluation,
          analysis: updated,
          isUnlocked: true,
          lockedSectionsCount: 0,
          lockedTipsCount: 0,
          creditsBalance: 999999,
        })
      );
    }

    const creditsBalance = await getCreditsBalance(sessionId);
    if (creditsBalance <= 0) {
      return reply.status(402).send({ error: 'Sem créditos.' });
    }

    const alreadyUnlocked = await prisma.creditUsage.findFirst({
      where: { sessionId, analysisId: analysis.id },
    });
    if (alreadyUnlocked) {
      return reply.send(
        buildResponse({
          evaluation: analysis.evaluation,
          analysis,
          isUnlocked: true,
          lockedSectionsCount: 0,
          lockedTipsCount: 0,
          creditsBalance,
        })
      );
    }

    if (!analysis.resumeText) {
      return reply.status(400).send({ error: 'Não foi possível desbloquear sem reavaliar. Envie o currículo novamente.' });
    }

    const evaluation = await evaluateResume(analysis.resumeText);
    const updated = await prisma.analysis.update({
      where: { id: analysis.id },
      data: { evaluation },
    });

    await consumeCredit(sessionId, analysis.id, 'unlock');
    const newBalance = creditsBalance - 1;

    return reply.send(
      buildResponse({
        evaluation: updated.evaluation,
        analysis: updated,
        isUnlocked: true,
        lockedSectionsCount: 0,
        lockedTipsCount: 0,
        creditsBalance: newBalance,
      })
    );
  });

  fastify.get('/credits', async (request, reply) => {
    const isAdmin = isAdminRequest(request);
    const { sessionId } = await getOrCreateSessionId(request, reply);
    const balance = isAdmin ? 999999 : await getCreditsBalance(sessionId);
    return reply.send({ success: true, balance });
  });

  fastify.post('/credits/grant', async (request, reply) => {
    if (!isAdminRequest(request)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const { sessionId } = await getOrCreateSessionId(request, reply);
    const credits = Number(request.body?.credits ?? 3);
    const safeCredits = Number.isFinite(credits) && credits > 0 ? Math.floor(credits) : 3;

    await grantCredits(sessionId, safeCredits, 'admin_grant');
    const balance = await getCreditsBalance(sessionId);
    return reply.send({ success: true, balance });
  });

  fastify.post('/credits/reset', async (request, reply) => {
    if (!isAdminRequest(request)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const { sessionId } = await getOrCreateSessionId(request, reply);
    const result = await resetCredits(sessionId, 'admin_reset');
    return reply.send({ success: true, balance: result.balance });
  });

  fastify.post('/payments/mercadopago/create-checkout', async (request, reply) => {
    const { sessionId } = await getOrCreateSessionId(request, reply);

    try {
      const pref = await createCheckoutPreference({ sessionId });
      return reply.send({ success: true, ...pref });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || '');
      const status =
        err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
          ? err.status
          : 500;
      return reply.status(status).send({ error: 'Falha ao criar checkout.', details: message });
    }
  });

  fastify.post('/webhooks/mercadopago', async (request, reply) => {
    const prisma = getPrisma();

    // Mercado Pago can send notification as query params or JSON payload.
    const q = request.query || {};
    const b = request.body || {};
    const type = q.type || b.type;
    const dataId = q['data.id'] || q['data_id'] || b?.data?.id || b?.id;

    if (!dataId) {
      return reply.status(200).send({ ok: true });
    }

    if (type && type !== 'payment') {
      return reply.status(200).send({ ok: true });
    }

    const paymentId = String(dataId);

    // Idempotency: if we already processed this payment as approved, ignore.
    const existing = await prisma.payment.findFirst({
      where: { provider: 'mercadopago', paymentId },
    });
    if (existing?.processedAt) {
      return reply.status(200).send({ ok: true });
    }

    let payment;
    try {
      payment = await fetchPayment(paymentId);
    } catch (err) {
      request.log.error({ err }, 'Falha ao buscar payment no Mercado Pago');
      return reply.status(200).send({ ok: true });
    }

    const status = payment?.status;
    const externalReference = payment?.external_reference;
    const sessionId = externalReference ? String(externalReference) : null;

    if (!sessionId) {
      await prisma.payment.upsert({
        where: { paymentId },
        update: { status: status || 'unknown', raw: payment },
        create: {
          provider: 'mercadopago',
          sessionId: 'unknown',
          amount: payment?.transaction_amount || 0,
          currency: payment?.currency_id || 'BRL',
          paymentId,
          status: status || 'unknown',
          raw: payment,
        },
      });
      return reply.status(200).send({ ok: true });
    }

    // Persist payment record (even if not approved yet)
    await prisma.payment.upsert({
      where: { paymentId },
      update: { status: status || 'unknown', raw: payment, sessionId },
      create: {
        provider: 'mercadopago',
        sessionId,
        amount: payment?.transaction_amount || 0,
        currency: payment?.currency_id || 'BRL',
        paymentId,
        status: status || 'unknown',
        raw: payment,
      },
    });

    if (status !== 'approved') {
      return reply.status(200).send({ ok: true });
    }

    const credits = Number(process.env.CREDITS_PER_PURCHASE || 3);
    const safeCredits = Number.isFinite(credits) && credits > 0 ? Math.floor(credits) : 3;

    // Exactly-once processing: mark processed inside a transaction and only grant if we won the race.
    await prisma.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { paymentId, processedAt: null },
        data: { processedAt: new Date(), status: 'approved', raw: payment, sessionId },
      });

      if (updated.count === 0) return;

      await tx.creditGrant.create({
        data: {
          sessionId,
          credits: safeCredits,
          reason: 'mercadopago',
        },
      });
    });

    return reply.status(200).send({ ok: true });
  });
}

