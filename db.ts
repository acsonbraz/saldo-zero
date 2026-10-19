// Banco local (SQLite via bun:sqlite). Em produção o arquivo fica num volume do Railway (DATA_DIR=/data).
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";

const DIR = Bun.env.DATA_DIR || "./data";
mkdirSync(DIR, { recursive: true });
export const DATA_DIR = DIR;
export const db = new Database(DIR + "/saldozero.sqlite", { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nick TEXT NOT NULL UNIQUE,            -- minúsculo, para unicidade
  nick_display TEXT NOT NULL,           -- como o jogador digitou
  pin_hash TEXT NOT NULL,
  progress TEXT NOT NULL DEFAULT '{}',  -- finais, conquistas, recorde (JSON)
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,          -- SHA-256 do token; o token em si só existe no navegador
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  payment_id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE TABLE IF NOT EXISTS entitlements (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, payment_id)
);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                    -- AAAA-MM-DD do desafio diário
  days INTEGER NOT NULL,
  turns INTEGER NOT NULL,
  ending TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, day)
);
CREATE INDEX IF NOT EXISTS results_day ON results(day, days DESC);
CREATE TABLE IF NOT EXISTS webhook_failures (  -- eventos do Asaas que falharam ao processar; a rotina de conciliação reconsulta
  payment_id TEXT PRIMARY KEY,
  event TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  nick TEXT,
  email TEXT,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberto',   -- aberto | respondido | fechado
  reply TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status, created_at DESC);
`);

// Migrações simples (colunas novas em bancos já existentes). Todas idempotentes e sem perda de dados.
const cols = (table: string) => (db.query("PRAGMA table_info(" + table + ")").all() as { name: string }[]).map((c) => c.name);
const addCol = (table: string, col: string, def: string) => { if (!cols(table).includes(col)) db.exec("ALTER TABLE " + table + " ADD COLUMN " + col + " " + def); };
addCol("users", "favores", "INTEGER NOT NULL DEFAULT 0");
addCol("users", "blocked", "INTEGER NOT NULL DEFAULT 0");
addCol("users", "note", "TEXT NOT NULL DEFAULT ''");
addCol("orders", "value", "REAL NOT NULL DEFAULT 0");
addCol("orders", "erased", "INTEGER NOT NULL DEFAULT 0");   // pedido de conta excluída: não pode ser restaurado por CPF
addCol("users", "email", "TEXT");
addCol("users", "email_verified", "INTEGER NOT NULL DEFAULT 0");
addCol("users", "run_state", "TEXT NOT NULL DEFAULT ''");   // partida em andamento (JSON), para continuar em outro aparelho
addCol("users", "run_at", "INTEGER NOT NULL DEFAULT 0");
if (!cols("users").includes("code")) db.exec("ALTER TABLE users ADD COLUMN code TEXT; ALTER TABLE users ADD COLUMN code_kind TEXT; ALTER TABLE users ADD COLUMN code_expires INTEGER NOT NULL DEFAULT 0; ALTER TABLE users ADD COLUMN code_attempts INTEGER NOT NULL DEFAULT 0");
// Bloqueio progressivo do PIN (persistido por conta) e limites dos códigos por e-mail (janela de 24 h).
addCol("users", "pin_fails", "INTEGER NOT NULL DEFAULT 0");
addCol("users", "locked_until", "INTEGER NOT NULL DEFAULT 0");
addCol("users", "code_window", "INTEGER NOT NULL DEFAULT 0");   // início da janela de 24 h dos contadores abaixo
addCol("users", "code_sends", "INTEGER NOT NULL DEFAULT 0");    // códigos enviados na janela
// Pedidos: última consulta ao Asaas (evita consultar a cada polling).
addCol("orders", "checked_at", "INTEGER NOT NULL DEFAULT 0");

// E-mail único só entre contas que confirmaram o endereço: um cadastro não confirmado não revela nem bloqueia o e-mail de ninguém.
db.exec("DROP INDEX IF EXISTS users_email");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_email_verified ON users(email) WHERE email IS NOT NULL AND email_verified = 1");
db.exec("CREATE INDEX IF NOT EXISTS users_email_any ON users(email)");

// Códigos antigos guardados em claro: invalida (o jogador pede outro). Os novos são guardados como hash SHA-256.
db.exec("UPDATE users SET code = NULL, code_kind = NULL, code_expires = 0 WHERE code IS NOT NULL AND length(code) < 64");

// Sessões: o banco guarda só o hash SHA-256 do token. Migra as sessões existentes sem deslogar ninguém.
if (cols("sessions").includes("token")) {
  db.transaction(() => {
    db.exec(`CREATE TABLE sessions_new (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    )`);
    const rows = db.query("SELECT token, user_id, created_at, last_seen FROM sessions").all() as { token: string; user_id: number; created_at: number; last_seen: number }[];
    const ins = db.prepare("INSERT OR IGNORE INTO sessions_new (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)");
    for (const r of rows) ins.run(sha256(r.token), r.user_id, r.created_at, r.last_seen);
    db.exec("DROP TABLE sessions; ALTER TABLE sessions_new RENAME TO sessions");
    console.log("[db] sessões migradas para hash: " + rows.length);
  })();
}
db.exec("CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)");

// Um pagamento libera produto para uma única conta. Se houver duplicatas antigas, mantém a primeira e registra no log.
{
  const dups = db.query("SELECT payment_id, COUNT(*) AS n FROM entitlements GROUP BY payment_id HAVING n > 1").all() as { payment_id: string; n: number }[];
  for (const d of dups) {
    const rows = db.query("SELECT rowid, user_id, product_id FROM entitlements WHERE payment_id = ? ORDER BY created_at ASC, rowid ASC").all(d.payment_id) as { rowid: number; user_id: number; product_id: string }[];
    const [keep, ...drop] = rows;
    for (const r of drop) db.run("DELETE FROM entitlements WHERE rowid = ?", [r.rowid]);
    console.warn("[db] pagamento " + d.payment_id + " estava em " + rows.length + " contas; mantido na conta " + keep.user_id + ", removido de " + drop.map((r) => r.user_id).join(",") + " (favores já creditados não foram alterados: revisar no /admin)");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS entitlements_payment ON entitlements(payment_id)");
}

export function sha256(s: string) {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}
export const now = () => Date.now();

// ---- backup diário (VACUUM INTO gera uma cópia consistente com o banco em uso) ----
// Fica em DATA_DIR/backups, com rotação de 7 arquivos. Protege contra erro lógico/corrupção, não contra perda do volume:
// cópia externa (bucket) depende de aprovação de gasto.
const BACKUP_DIR = DIR + "/backups";
export function backupNow() {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = BACKUP_DIR + "/saldozero-" + day + ".sqlite";
    if (!existsSync(file)) {
      db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");
      console.log("[backup] gerado " + file);
    }
    const files = readdirSync(BACKUP_DIR).filter((f) => /^saldozero-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 7))) { unlinkSync(BACKUP_DIR + "/" + f); console.log("[backup] removido " + f); }
    return file;
  } catch (e) {
    console.error("[backup] falhou", e);
    return null;
  }
}
