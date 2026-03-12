import { extractTextFromFile, evaluateResume } from '../services/resumeService.js';

export async function resumeRoutes(fastify) {
  fastify.post('/resume/evaluate', async (request, reply) => {
    const parts = await request.parts();

    let file = null;
    for await (const part of parts) {
      if (part.type === 'file' && !file) {
        file = part;
      }
    }

    if (!file) {
      return reply.status(400).send({ error: 'Arquivo de currículo é obrigatório.' });
    }

    try {
      const text = await extractTextFromFile(file);

      if (!text || !text.trim()) {
        return reply.status(400).send({
          error: 'Não foi possível extrair texto do arquivo enviado. Verifique se o PDF/DOCX não está protegido ou somente-imagem.'
        });
      }

      const evaluation = await evaluateResume(text);

      return reply.send({
        success: true,
        evaluation,
      });
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: 'Erro ao processar currículo.' });
    }
  });
}

