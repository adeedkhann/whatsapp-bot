import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

try {
  const messages = await prisma.message.findMany({
    orderBy: { timestamp: 'desc' },
    take: 30,
    include: {
      sender: true,
      media: true,
      llmContextMetadata: true,
    },
  });

  console.table(messages.map((message) => ({
    time: message.timestamp.toISOString(),
    sender: message.sender.pushName,
    type: message.messageType,
    content: message.content,
    media: message.media?.cloudinaryUrl || '',
    contextEligible: message.llmContextMetadata?.isContextEligible ?? true,
  })));
} finally {
  await prisma.$disconnect();
}
