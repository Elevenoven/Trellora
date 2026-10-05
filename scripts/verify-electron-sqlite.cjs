const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const database = new Database(':memory:');
assert.equal(database.prepare('SELECT 1 AS value').get().value, 1);
database.close();

console.log('Electron SQLite runtime verification passed');
process.exit(0);
