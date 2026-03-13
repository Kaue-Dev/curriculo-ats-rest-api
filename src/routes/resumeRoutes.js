import { extractTextFromFile, evaluateResume, evaluateResumeFree } from '../services/resumeService.js';
import { getOrCreateSessionId, isAdminRequest } from '../auth/session.js';
import { consumeCredit, getCreditsBalance, grantCredits } from '../billing/credits.js';
import { getPrisma } from '../db/prisma.js';

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
}

