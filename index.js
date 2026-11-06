import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import Database from 'better-sqlite3';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

// Ensure media download directory exists
const MEDIA_DIR = './downloads';
if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// Initialize SQLite database connection
const db = new Database('mlcoe_archive.db');

// Ensure base schema exists
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    sender TEXT,
    push_name TEXT,
    content TEXT,
    timestamp INTEGER
  )
`);

// Auto-migration for existing tables missing media_path
try {
  db.exec(`ALTER TABLE messages ADD COLUMN media_path TEXT;`);
} catch (err) {
  // Column already exists, safe to ignore
}

// Prepare insert statement
const insertMessage = db.prepare(`
  INSERT OR IGNORE INTO messages (id, sender, push_name, content, media_path, timestamp)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const TARGET_GROUP_JID = process.env.TARGET_GROUP_JID;

/**
 * Recursively unwraps ephemeral, view-once, edited, and container payloads.
 */
function unwrapMessage(msgPayload) {
  if (!msgPayload) return null;
  if (msgPayload.ephemeralMessage?.message) return unwrapMessage(msgPayload.ephemeralMessage.message);
  if (msgPayload.viewOnceMessage?.message) return unwrapMessage(msgPayload.viewOnceMessage.message);
  if (msgPayload.viewOnceMessageV2?.message) return unwrapMessage(msgPayload.viewOnceMessageV2.message);
  if (msgPayload.documentWithCaptionMessage?.message) return unwrapMessage(msgPayload.documentWithCaptionMessage.message);
  if (msgPayload.editedMessage?.message?.protocolMessage?.editedMessage) {
    return unwrapMessage(msgPayload.editedMessage.message.protocolMessage.editedMessage);
  }
  return msgPayload;
}

/**
 * Safely extracts exact text string from any message payload.
 */
function extractContent(unwrappedPayload) {
  if (!unwrappedPayload) return '';

  // 1. Direct Text Message
  if (unwrappedPayload.conversation) {
    return unwrappedPayload.conversation;
  }

  // 2. Extended Text Message (Mentions, Emojis, Links, Replies)
  if (unwrappedPayload.extendedTextMessage) {
    return (
      unwrappedPayload.extendedTextMessage.text ||
      unwrappedPayload.extendedTextMessage.matchedText ||
      ''
    );
  }

  // 3. Media Captions & Documents
  if (unwrappedPayload.imageMessage) {
    const caption = unwrappedPayload.imageMessage.caption || '';
    return caption ? `[Image] ${caption}` : '[Image]';
  }

  if (unwrappedPayload.videoMessage) {
    const caption = unwrappedPayload.videoMessage.caption || '';
    return caption ? `[Video] ${caption}` : '[Video]';
  }

  if (unwrappedPayload.documentMessage) {
    const fileName = unwrappedPayload.documentMessage.fileName || '';
    const caption = unwrappedPayload.documentMessage.caption || '';
    return `[Document: ${fileName}] ${caption}`.trim();
  }

  if (unwrappedPayload.audioMessage) {
    return unwrappedPayload.audioMessage.ptt ? '[Voice Note]' : '[Audio File]';
  }

  if (unwrappedPayload.stickerMessage) {
    return '[Sticker]';
  }

  if (unwrappedPayload.reactionMessage) {
    return `[Reaction] ${unwrappedPayload.reactionMessage.text || ''}`.trim();
  }

  return '';
}

/**
 * Downloads media payload (Image, Video, PDF/Doc, Audio) to disk and returns local file path.
 */
async function handleMediaDownload(msg, msgType, rawDocumentName) {
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    
    let ext = '.bin';
    if (msgType === 'imageMessage') ext = '.jpg';
    else if (msgType === 'videoMessage') ext = '.mp4';
    else if (msgType === 'audioMessage') ext = '.ogg';
    else if (msgType === 'stickerMessage') ext = '.webp';
    else if (msgType === 'documentMessage') {
      ext = rawDocumentName ? path.extname(rawDocumentName) || '.pdf' : '.pdf';
    }

    const fileName = `${msg.key.id}${ext}`;
    const filePath = path.join(MEDIA_DIR, fileName);

    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (err) {
    console.error('Failed to download media file:', err.message);
    return null;
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan the QR Code to authenticate WhatsApp session:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('WhatsApp connection successfully established.');
      console.log(`Messaging listener active for target group: ${TARGET_GROUP_JID}`);
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`Connection dropped. Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg || !msg.message || !msg.key.remoteJid) return;

    if (TARGET_GROUP_JID && msg.key.remoteJid === TARGET_GROUP_JID) {
      const msgId = msg.key.id;
      const sender = msg.key.participant || msg.key.remoteJid;
      const pushName = msg.pushName || 'Unknown';
      const timestamp = msg.messageTimestamp;

      const unwrappedPayload = unwrapMessage(msg.message);
      if (!unwrappedPayload) return;

      const msgType = Object.keys(unwrappedPayload)[0];
      const content = extractContent(unwrappedPayload);
      let mediaPath = null;

      // Handle file download if message type contains media
      if (['imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage', 'audioMessage'].includes(msgType)) {
        const rawDocName = unwrappedPayload[msgType]?.fileName || '';
        mediaPath = await handleMediaDownload(msg, msgType, rawDocName);
      }

      // Ignore empty system protocol updates
      if (!content && !mediaPath) return;

      try {
        insertMessage.run(msgId, sender, pushName, content, mediaPath, timestamp);
        console.log(`Saved message [${msgId}] from ${pushName}: "${content.substring(0, 30)}..." | Storage: ${mediaPath ? mediaPath : 'Text Only'}`);
      } catch (err) {
        console.error('Failed to write message to database:', err.message);
      }
    }
  });
}

startBot();