import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient();
const TARGET_GROUP_JID = process.env.TARGET_GROUP_JID;

export async function getLLMContext(groupJid, limit = 50) {
  const messages = await prisma.message.findMany({
    where: {
      groupJid,
      llmContextMetadata: {
        isContextEligible: true,
      },
    },
    include: {
      sender: true,
      media: true,
      llmContextMetadata: true,
    },
    orderBy: {
      timestamp: 'asc',
    },
    take: limit,
  });

  const formattedLines = messages.map((msg) => {
    const timeStr = msg.timestamp.toISOString().replace('T', ' ').substring(0, 19);
    const senderName = msg.sender?.pushName || 'Unknown';
    let lineContent = msg.content;

    if (msg.media) {
      const summaryText = msg.llmContextMetadata?.extractedSummary
        ? ` | Summary: ${msg.llmContextMetadata.extractedSummary}`
        : '';
      lineContent += ` [ATTACHMENT: ${msg.messageType} | URL: ${msg.media.cloudinaryUrl}${summaryText}]`;
    }

    return `[${timeStr}] ${senderName}: ${lineContent}`;
  });

  return `
--- START WHATSAPP CHAT CONTEXT ---
${formattedLines.join('\n')}
--- END WHATSAPP CHAT CONTEXT ---
  `.trim();
}

// === ISS CALLING CODE KO FILE KE END MEIN ADD KARO ===
async function run() {
  if (!TARGET_GROUP_JID) {
    console.log('Error: .env mein TARGET_GROUP_JID missing hai.');
    return;
  }
  
  const contextText = await getLLMContext(TARGET_GROUP_JID, 50);
  console.log(contextText);
  await prisma.$disconnect();
}

run();