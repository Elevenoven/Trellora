const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const database = new Database(':memory:');
assert.equal(database.prepare('SELECT 1 AS value').get().value, 1);
sqliteVec.load(database);
assert.match(database.prepare('SELECT vec_version() AS version').get().version, /^v?0\.1\./);
database.exec('CREATE VIRTUAL TABLE chunks USING vec0(embedding float[3] distance_metric=cosine)');
const vector = Buffer.from(new Float32Array([1, 0, 0]).buffer);
database.prepare('INSERT INTO chunks(rowid, embedding) VALUES (?, ?)').run(1n, vector);
assert.equal(database.prepare('SELECT rowid FROM chunks WHERE embedding MATCH ? AND k = 1').get(vector).rowid, 1);
database.close();

console.log('Packaged Electron SQLite and sqlite-vec verification passed');
process.exit(0);
