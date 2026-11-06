// check_db.js
import Database from 'better-sqlite3';

const db = new Database('mlcoe_archive.db');

// Database se latest 10 messages fetch karne ke liye query
const rows = db.prepare(`
  SELECT id, sender, push_name, content, datetime(timestamp, 'unixepoch', 'localtime') as time 
  FROM messages 
  ORDER BY timestamp DESC 
  LIMIT 10
`).all();

console.log('\n--- LATEST MLCOE GROUP MESSAGES ---');
console.table(rows);