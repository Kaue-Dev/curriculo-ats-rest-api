import 'dotenv/config';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import { resumeRoutes } from './routes/resumeRoutes.js';

const fastify = Fastify({
  logger: true
});

// CORS para o frontend em Next.js
await fastify.register(fastifyCors, {
  origin: true, // em produção, troque para o domínio do seu front
});

// Multipart para upload de arquivos
await fastify.register(fastifyMultipart, {
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 1,
  }
});

fastify.get('/health', async () => {
  return { status: 'ok' };
});

// Rotas de currículo
await fastify.register(resumeRoutes);

const PORT = process.env.PORT || 3001;

try {
  await fastify.listen({ port: Number(PORT), host: '0.0.0.0' });
  fastify.log.info(`Servidor rodando em http://localhost:${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

