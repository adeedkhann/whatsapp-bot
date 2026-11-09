import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';

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

async function fetchGroups() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      try {
        const groups = await fetchParticipatingGroups(sock);
        displayGroups(groups);
        process.exit(0);
      } catch (error) {
        console.error('Failed to fetch participating WhatsApp groups:', error);
        process.exitCode = 1;
      }
    }

    if (connection === 'close') {
      console.error('WhatsApp connection closed before the group list could be fetched.', lastDisconnect?.error);
      process.exitCode = 1;
    }
  });
}

fetchGroups().catch((error) => {
  console.error('Failed to start group JID discovery:', error);
  process.exitCode = 1;
});
