import { getPrisma } from '../db/prisma.js';

export async function getCreditsBalance(sessionId) {
  const prisma = getPrisma();

  const [grants, usages] = await Promise.all([
    prisma.creditGrant.aggregate({
      where: { sessionId },
      _sum: { credits: true },
    }),
    prisma.creditUsage.aggregate({
      where: { sessionId },
      _sum: { credits: true },
    }),
  ]);

  const granted = grants._sum.credits || 0;
  const used = usages._sum.credits || 0;
  return granted - used;
}

export async function grantCredits(sessionId, credits, reason = 'manual') {
  const prisma = getPrisma();
  return prisma.creditGrant.create({
    data: {
      sessionId,
      credits,
      reason,
    },
  });
}

export async function consumeCredit(sessionId, analysisId, reason = 'analysis') {
  const prisma = getPrisma();
  return prisma.creditUsage.create({
    data: {
      sessionId,
      analysisId,
      credits: 1,
      reason,
    },
  });
}

export async function resetCredits(sessionId, reason = 'admin_reset') {
  const prisma = getPrisma();
  const balance = await getCreditsBalance(sessionId);
  if (balance <= 0) return { balance };

  await prisma.creditUsage.create({
    data: {
      sessionId,
      credits: balance,
      reason,
    },
  });

  return { balance: 0 };
}
