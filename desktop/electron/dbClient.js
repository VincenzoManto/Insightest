// dbClient: thin multi-engine SQL client for the "DB" test action (query + before/after diffing).
// Drivers are required lazily so a project that never uses "DB" doesn't need all four installed.
//
// Mirrored at backend/public/ci-runner/dbClient.js (served statically to CI) and
// desktop/electron/dbClient.js (local runs); keep all three in sync.
'use strict';

function engineOf(connectionString) {
  const scheme = String(connectionString).split(':')[0].toLowerCase();
  if (scheme === 'postgres' || scheme === 'postgresql') return 'pg';
  if (scheme === 'mysql' || scheme === 'mariadb') return 'mysql';
  if (scheme === 'mssql' || scheme === 'sqlserver') return 'mssql';
  if (scheme === 'sqlite' || scheme === 'file' || /\.(sqlite3?|db)$/i.test(connectionString)) return 'sqlite';
  throw new Error(`dbClient: unrecognized connection string scheme "${scheme}"`);
}

async function runPg(connectionString, sql, params) {
  const { Client } = require('pg');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount };
  } finally {
    await client.end();
  }
}

async function runMysql(connectionString, sql, params) {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection(connectionString);
  try {
    const [rows] = await conn.execute(sql, params);
    return { rows, rowCount: Array.isArray(rows) ? rows.length : 0 };
  } finally {
    await conn.end();
  }
}

async function runMssql(connectionString, sql, params) {
  const mssql = require('mssql');
  const pool = await mssql.connect(connectionString);
  try {
    const request = pool.request();
    (params || []).forEach((p, i) => request.input(`p${i}`, p));
    const result = await request.query(sql);
    return { rows: result.recordset || [], rowCount: result.rowsAffected?.[0] ?? (result.recordset || []).length };
  } finally {
    await pool.close();
  }
}

async function runSqlite(connectionString, sql, params) {
  const Database = require('better-sqlite3');
  const path = connectionString.replace(/^sqlite:\/\//, '').replace(/^file:/, '');
  const db = new Database(path);
  try {
    const stmt = db.prepare(sql);
    const rows = stmt.reader ? stmt.all(...(params || [])) : (stmt.run(...(params || [])), []);
    return { rows, rowCount: rows.length };
  } finally {
    db.close();
  }
}

/** Runs `sql` against `connectionString` (engine auto-detected from its scheme) and returns
 * { rows, rowCount }. `params` are positional bind parameters, driver-dependent. */
async function runQuery(connectionString, sql, params = []) {
  if (!connectionString) {
    throw new Error('dbClient: no DB connection string configured on this project');
  }
  switch (engineOf(connectionString)) {
    case 'pg':
      return runPg(connectionString, sql, params);
    case 'mysql':
      return runMysql(connectionString, sql, params);
    case 'mssql':
      return runMssql(connectionString, sql, params);
    case 'sqlite':
      return runSqlite(connectionString, sql, params);
  }
}

/** Diffs two row sets (arrays of plain objects) by `keyColumn`, returning counts and the
 * offending rows: keys only in `after` are inserted, only in `before` are deleted, present in
 * both but with different column values are updated. */
function diffRows(before, after, keyColumn) {
  const beforeByKey = new Map(before.map((r) => [String(r[keyColumn]), r]));
  const afterByKey = new Map(after.map((r) => [String(r[keyColumn]), r]));

  const insertedKeys = [...afterByKey.keys()].filter((k) => !beforeByKey.has(k));
  const deletedKeys = [...beforeByKey.keys()].filter((k) => !afterByKey.has(k));
  const updatedKeys = [...afterByKey.keys()].filter((k) => {
    if (!beforeByKey.has(k)) return false;
    return JSON.stringify(beforeByKey.get(k)) !== JSON.stringify(afterByKey.get(k));
  });

  return {
    inserted: insertedKeys.length,
    updated: updatedKeys.length,
    deleted: deletedKeys.length,
    insertedRows: insertedKeys.map((k) => afterByKey.get(k)),
    updatedRows: updatedKeys.map((k) => afterByKey.get(k)),
    deletedRows: deletedKeys.map((k) => beforeByKey.get(k)),
  };
}

module.exports = { runQuery, diffRows, engineOf };
