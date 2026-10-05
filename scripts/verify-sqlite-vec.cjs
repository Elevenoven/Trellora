const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const database = new Database(':memory:');
try {
  sqliteVec.load(database);
  const version = database.prepare('SELECT vec_version() AS version').get().version;
  assert.match(version, /^v?0\.1\./);
  database.exec('CREATE VIRTUAL TABLE chunks USING vec0(embedding float[3])');
  database.prepare('INSERT INTO chunks(rowid, embedding) VALUES (?, ?)').run(1n, toVector([1, 0, 0]));
  database.prepare('INSERT INTO chunks(rowid, embedding) VALUES (?, ?)').run(2n, toVector([0, 1, 0]));
  const result = database.prepare(`
    SELECT rowid, distance FROM chunks
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT 1
  `).get(toVector([1, 0, 0]));
  assert.equal(result.rowid, 1);
  assert.equal(result.distance, 0);
  console.log(`sqlite-vec verification passed (${version})`);
} finally {
  database.close();
}
process.exit(0);

function toVector(values) {
  const floats = new Float32Array(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}
