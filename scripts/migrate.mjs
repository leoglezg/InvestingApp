#!/usr/bin/env node
// Aplica los .sql de db/schema en orden lexicográfico, una sola vez cada uno.
// Cada archivo corre dentro de su propia transacción: o se aplica entero o no
// se aplica nada.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(root, 'db', 'schema');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('FALTA DATABASE_URL. Copia .env.example a .env y rellénala.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    sha256      text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`);

const applied = new Map(
  (await client.query('SELECT filename, sha256 FROM schema_migrations')).rows
    .map(r => [r.filename, r.sha256])
);

const files = readdirSync(schemaDir).filter(f => f.endsWith('.sql')).sort();
let count = 0;

for (const file of files) {
  const sql = readFileSync(join(schemaDir, file), 'utf8');
  const sha = createHash('sha256').update(sql).digest('hex');
  const prev = applied.get(file);

  if (prev === sha) {
    console.log(`  = ${file} (ya aplicada)`);
    continue;
  }
  // Una migración aplicada que cambia de contenido significa que alguien editó
  // el pasado. Se detiene: la corrección va en una migración nueva.
  if (prev) {
    console.error(`\n  ! ${file} ya se aplicó con otro contenido.`);
    console.error('    Crea una migración nueva en lugar de editar una aplicada.');
    await client.end();
    process.exit(1);
  }

  process.stdout.write(`  + ${file} ... `);
  try {
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)',
      [file, sha]
    );
    console.log('OK');
    count++;
  } catch (err) {
    console.log('FALLO');
    console.error(`\n${err.message}\n`);
    await client.end();
    process.exit(1);
  }
}

console.log(`\n${count} migración(es) aplicada(s), ${files.length} en total.`);
await client.end();
