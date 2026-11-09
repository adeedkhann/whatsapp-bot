import 'dotenv/config';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { v2 as cloudinary } from 'cloudinary';
import { PrismaClient } from '@prisma/client';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

const requiredEnvironment = [
  'DATABASE_URL',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];

for (const variable of requiredEnvironment) {
  if (!process.env[variable]) {
    throw new Error(`Missing required environment variable: ${variable}`);
  }
}

const prisma = new PrismaClient();
const TARGET_GROUP_JID = process.env.TARGET_GROUP_JID?.trim();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

function unwrapMessage(msgPayload) {
  if (!msgPayload) return null;
  if (msgPayload.ephemeralMessage?.message) {
    return unwrapMessage(msgPayload.ephemeralMessage.message);
  }
  if (msgPayload.viewOnceMessage?.message) {
    return unwrapMessage(msgPayload.viewOnceMessage.message);
  }
  if (msgPayload.viewOnceMessageV2?.message) {
    return unwrapMessage(msgPayload.viewOnceMessageV2.message);
  }
  if (msgPayload.documentWithCaptionMessage?.message) {
    return unwrapMessage(msgPayload.documentWithCaptionMessage.message);
  }
  if (msgPayload.editedMessage?.message?.protocolMessage?.editedMessage) {
    return unwrapMessage(msgPayload.editedMessage.message.protocolMessage.editedMessage);
  }
  return msgPayload;
}

function extractContent(payload) {
  if (!payload) return '';
  if (payload.conversation) return payload.conversation;
  if (payload.extendedTextMessage) {
    return payload.extendedTextMessage.text || payload.extendedTextMessage.matchedText || '';
  }
  if (payload.imageMessage) {
    return payload.imageMessage.caption ? `[Image] ${payload.imageMessage.caption}` : '[Image]';
  }
  if (payload.videoMessage) {
    return payload.videoMessage.caption ? `[Video] ${payload.videoMessage.caption}` : '[Video]';
  }
  if (payload.documentMessage) {
    const name = payload.documentMessage.fileName || '';
    const caption = payload.documentMessage.caption || '';
    return `[Document: ${name}] ${caption}`.trim();
  }
  if (payload.audioMessage) return payload.audioMessage.ptt ? '[Voice Note]' : '[Audio File]';
  if (payload.stickerMessage) return '[Sticker]';
  if (payload.reactionMessage) {
    return `[Reaction] ${payload.reactionMessage.text || ''}`.trim();
  }
  return '';
}

function messageTypeFor(payload) {
  const type = Object.keys(payload)[0];
  const types = {
    conversation: 'TEXT',
    extendedTextMessage: 'TEXT',
    imageMessage: 'IMAGE',
    videoMessage: 'VIDEO',
    documentMessage: 'DOCUMENT',
    audioMessage: 'AUDIO',
    stickerMessage: 'STICKER',
    reactionMessage: 'REACTION',
  };
  return types[type] || 'TEXT';
}

function toJsonValue(value) {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      output[key] = toJsonValue(nestedValue);
    }
    return output;
  }
  return value;
}

function timestampToDate(timestamp) {
  const seconds = typeof timestamp === 'object' && timestamp !== null
    ? Number(timestamp.toString())
    : Number(timestamp);
  if (!Number.isFinite(seconds)) throw new Error(`Invalid WhatsApp message timestamp: ${timestamp}`);
  return new Date(seconds * 1000);
}

const GROUP_SYNC_DELAY_MS = 3000;
const GROUP_FETCH_ATTEMPTS = 3;

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

async function fetchParticipatingGroups(sock) {
  let groups = {};

  for (let attempt = 1; attempt <= GROUP_FETCH_ATTEMPTS; attempt += 1) {
    await wait(GROUP_SYNC_DELAY_MS);
    groups = await sock.groupFetchAllParticipating();

    if (Object.keys(groups).length > 0 || attempt === GROUP_FETCH_ATTEMPTS) {
      return groups;
    }

    console.log(`Group list is still synchronizing; retrying (${attempt + 1}/${GROUP_FETCH_ATTEMPTS})...`);
  }

  return groups;
}

function displayGroups(groups) {
  const participatingGroups = Object.values(groups);

  console.log('\n==========================================');
  console.log(`📋 TOTAL PARTICIPATING GROUPS: ${participatingGroups.length}`);
  console.log('==========================================');

  if (participatingGroups.length === 0) {
    console.log('No participating WhatsApp groups were found for this account.');
    return;
  }

  participatingGroups.forEach((group, index) => {
    console.log(`${index + 1}. Group Name: "${group.subject || 'Unnamed group'}"`);
    console.log(`   JID: ${group.id}`);
    console.log('------------------------------------------');
  });
}

function uploadBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      { folder: 'mlcoe-whatsapp', resource_type: 'auto', ...options },
      (error, result) => {
        if (error) reject(error);
        else if (!result?.secure_url || !result.public_id) {
          reject(new Error('Cloudinary returned an incomplete upload result'));
        } else resolve(result);
      },
    );
    upload.end(buffer);
  });
}

async function uploadMedia(msg, payload, messageType) {
  const media = payload[Object.keys(payload)[0]];
  const buffer = await downloadMediaMessage(msg, 'buffer', {});
  const result = await uploadBuffer(buffer, {
    public_id: msg.key.id,
    format: media?.fileName?.split('.').pop(),
  });
  return {
    cloudinaryUrl: result.secure_url,
    publicId: result.public_id,
    fileType: media?.mimetype || `application/octet-stream`,
    fileName: media?.fileName || null,
    fileSize: buffer.length,
    messageType,
  };
}

async function archiveMessage(msg) {
  if (!msg?.message || msg.key.remoteJid !== TARGET_GROUP_JID) return;

  const payload = unwrapMessage(msg.message);
  if (!payload) return;

  const messageType = messageTypeFor(payload);
  const content = extractContent(payload);
  const mediaTypes = ['IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO', 'STICKER'];
  const media = mediaTypes.includes(messageType)
    ? await uploadMedia(msg, payload, messageType)
    : null;

  if (!content && !media) return;

  const senderId = msg.key.participant || msg.key.remoteJid;
  const timestamp = timestampToDate(msg.messageTimestamp);
  const rawPayload = toJsonValue(msg.message);

  await prisma.$transaction([
    prisma.user.upsert({
      where: { id: senderId },
      create: { id: senderId, pushName: msg.pushName || 'Unknown' },
      update: { pushName: msg.pushName || 'Unknown' },
    }),
    prisma.message.create({
      data: {
        id: msg.key.id,
        senderId,
        groupJid: TARGET_GROUP_JID,
        content,
        messageType,
        rawPayload,
        timestamp,
        media: media ? {
          create: {
            cloudinaryUrl: media.cloudinaryUrl,
            publicId: media.publicId,
            fileType: media.fileType,
            fileName: media.fileName,
            fileSize: media.fileSize,
          },
        } : undefined,
        llmContextMetadata: {
          create: { isContextEligible: messageType !== 'REACTION' },
        },
      },
    }),
  ]);

  console.log(`Archived ${msg.key.id} from ${msg.pushName || 'Unknown'} as ${messageType}`);
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });
  let groupDiscoveryStarted = false;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nScan the QR Code to authenticate WhatsApp session:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      if (!TARGET_GROUP_JID) {
        if (groupDiscoveryStarted) return;
        groupDiscoveryStarted = true;

        try {
          const groups = await fetchParticipatingGroups(sock);
          displayGroups(groups);
          console.log('\nSet TARGET_GROUP_JID=<group JID> in .env and restart the archive service.');
        } catch (error) {
          console.error('Failed to discover participating groups:', error);
        }
      } else {
        console.log(`WhatsApp connected; listening to ${TARGET_GROUP_JID}`);
      }
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`Connection dropped. Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) void startBot();
    }
  });
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        await archiveMessage(msg);
      } catch (error) {
        console.error(`Failed to archive message ${msg?.key?.id || 'unknown'}:`, error);
      }
    }
  });
}

startBot().catch(async (error) => {
  console.error('Failed to start archive service:', error);
  await prisma.$disconnect();
  process.exitCode = 1;
});

process.once('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
