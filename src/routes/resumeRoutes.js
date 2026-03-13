import { extractTextFromFile, evaluateResume } from '../services/resumeService.js';

export async function resumeRoutes(fastify) {
  fastify.post('/resume/evaluate', async (request, reply) => {
    const isProd = process.env.NODE_ENV === 'production';
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

      const evaluation = await evaluateResume(text);

      return reply.send({
        success: true,
        evaluation,
      });
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
}

