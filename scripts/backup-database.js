const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const databasePath = path.join(__dirname, '..', 'data', 'bureau-portal.sqlite');
const backupDirectory = path.join(__dirname, '..', 'backups');
fs.mkdirSync(backupDirectory, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDirectory, `bureau-portal-${stamp}.sqlite`);
const database = new DatabaseSync(databasePath);
database.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
database.close();
console.log(JSON.stringify({ event: 'database.backup.created', timestamp: new Date().toISOString(), path: backupPath }));
