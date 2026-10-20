// Painel do desenvolvedor: visão geral, vendas, usuários e chamados de suporte.
// Protegido por ADMIN_TOKEN (variável de ambiente), enviado no header x-admin-token.
import { db, now } from "./db";
import { PRODUCTS, grantEntitlement } from "./store";
import { AuthError, normalizeNick, normalizePin, eraseUser, adminIssueCode } from "./auth";
import { timingSafeEqual } from "node:crypto";

const TOKEN = Bun.env.ADMIN_TOKEN || "";
export const adminEnabled = TOKEN.length >= 16;

export function adminAuthorized(req: Request) {
  if (!adminEnabled) return false;
  const given = Buffer.from(req.headers.get("x-admin-token") || "");
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const PAID = "('RECEIVED','CONFIRMED','RECEIVED_IN_CASH')";
const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const monthStart = () => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function overview() {
  const q = (sql: string, ...args: any[]) => (db.query(sql).get(...args) as any) || {};
  const revenue = (since: number) => q(`SELECT COALESCE(SUM(value),0) AS total, COUNT(*) AS n FROM orders WHERE status IN ${PAID} AND paid_at >= ?`, since);
  const byProduct = db.query(`SELECT product_id, COUNT(*) AS n, COALESCE(SUM(value),0) AS total FROM orders WHERE status IN ${PAID} GROUP BY product_id ORDER BY total DESC`).all() as any[];
  const daily = db.query("SELECT day, COUNT(*) AS n FROM results GROUP BY day ORDER BY day DESC LIMIT 14").all() as any[];
  return {
    users: { total: q("SELECT COUNT(*) AS n FROM users").n, today: q("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", dayStart()).n, active7d: q("SELECT COUNT(*) AS n FROM users WHERE last_seen >= ?", now() - 7 * 864e5).n, blocked: q("SELECT COUNT(*) AS n FROM users WHERE blocked = 1").n },
    tickets: { open: q("SELECT COUNT(*) AS n FROM tickets WHERE status = 'aberto'").n, total: q("SELECT COUNT(*) AS n FROM tickets").n },
    revenue: { all: revenue(0), month: revenue(monthStart()), today: revenue(dayStart()), pending: q("SELECT COUNT(*) AS n FROM orders WHERE status = 'PENDING'").n, byProduct: byProduct.map((r) => ({ ...r, name: PRODUCTS[r.product_id]?.name || r.product_id })) },
    daily,
  };
}

export function listOrders(limit = 200) {
  return db.query("SELECT o.payment_id, o.product_id, o.status, o.value, o.created_at, o.paid_at, u.nick_display AS nick, u.id AS user_id FROM orders o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT ?").all(limit).map((r: any) => ({ ...r, name: PRODUCTS[r.product_id]?.name || r.product_id }));
}

export function listUsers(qstr: string, page = 1) {
  const like = "%" + qstr.replace(/[%_!]/g, (c) => "!" + c) + "%";
  const per = 50, off = (Math.max(1, page) - 1) * per;
  const rows = db.query(`SELECT u.id, u.nick_display AS nick, u.email, u.email_verified, u.created_at, u.last_seen, u.favores, u.blocked, u.note,
      EXISTS(SELECT 1 FROM entitlements v WHERE v.user_id = u.id AND v.product_id = 'com.saldozero.vip') AS vip,
      (SELECT COUNT(*) FROM entitlements e WHERE e.user_id = u.id) AS items,
      (SELECT COALESCE(SUM(value),0) FROM orders o WHERE o.user_id = u.id AND o.status IN ${PAID}) AS spent,
      (SELECT COUNT(*) FROM results r WHERE r.user_id = u.id) AS games
    FROM users u WHERE u.nick LIKE ? ESCAPE '!' OR COALESCE(u.email,'') LIKE ? ESCAPE '!' ORDER BY u.last_seen DESC LIMIT ? OFFSET ?`).all(like, like, per, off);
  const total = (db.query("SELECT COUNT(*) AS n FROM users WHERE nick LIKE ? ESCAPE '!' OR COALESCE(email,'') LIKE ? ESCAPE '!'").get(like, like) as any).n;
  return { rows, total, page, per };
}

export function userDetail(id: number) {
  const user = db.query("SELECT id, nick_display AS nick, email, email_verified, created_at, last_seen, favores, blocked, note, progress, code_kind, code_expires, pin_fails, locked_until FROM users WHERE id = ?").get(id) as any;
  if (!user) throw new AuthError("Usuário não encontrado.", 404);
  return {
    user,
    entitlements: db.query("SELECT product_id, payment_id, created_at FROM entitlements WHERE user_id = ? ORDER BY created_at DESC").all(id),
    orders: db.query("SELECT payment_id, product_id, status, value, created_at, paid_at FROM orders WHERE user_id = ? ORDER BY created_at DESC").all(id),
    results: db.query("SELECT day, days, turns, ending FROM results WHERE user_id = ? ORDER BY day DESC LIMIT 30").all(id),
    tickets: db.query("SELECT id, subject, status, created_at FROM tickets WHERE user_id = ? ORDER BY created_at DESC").all(id),
  };
}

export async function userAction(id: number, input: any) {
  const action = String(input?.action || "");
  const exists = db.query("SELECT id, nick_display FROM users WHERE id = ?").get(id) as { id: number; nick_display: string } | null;
  if (!exists) throw new AuthError("Usuário não encontrado.", 404);
  switch (action) {
    case "block":
      db.run("UPDATE users SET blocked = 1 WHERE id = ?", [id]);
      db.run("DELETE FROM sessions WHERE user_id = ?", [id]);
      break;
    case "unblock":
      db.run("UPDATE users SET blocked = 0 WHERE id = ?", [id]);
      break;
    case "delete":
      eraseUser(id); // mesma exclusão do "Excluir minha conta": pedidos ficam anonimizados
      break;
    case "favores": {
      const n = Math.trunc(Number(input?.n));
      if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 1000) throw new AuthError("Quantidade inválida (±1 a 1000).");
      db.run("UPDATE users SET favores = MAX(0, favores + ?) WHERE id = ?", [n, id]);
      break;
    }
    case "grant": {
      const productId = String(input?.productId || "");
      if (!PRODUCTS[productId]) throw new AuthError("Produto inválido.");
      grantEntitlement(id, productId, "admin-" + now() + "-" + crypto.randomUUID().slice(0, 8));
      break;
    }
    case "revoke": {
      const productId = String(input?.productId || "");
      db.run("DELETE FROM entitlements WHERE user_id = ? AND product_id = ?", [id, productId]);
      break;
    }
    case "pin": {
      const pin = normalizePin(input?.pin, "new", exists.nick_display);
      const hash = await Bun.password.hash(pin, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
      db.run("UPDATE users SET pin_hash = ?, pin_fails = 0, locked_until = 0 WHERE id = ?", [hash, id]);
      db.run("DELETE FROM sessions WHERE user_id = ?", [id]);
      break;
    }
    case "rename": {
      const { key, display } = normalizeNick(input?.nick);
      try { db.run("UPDATE users SET nick = ?, nick_display = ? WHERE id = ?", [key, display, id]); } catch { throw new AuthError("Apelido já em uso.", 409); }
      break;
    }
    case "newcode": {
      // O código só é guardado como hash: o painel gera um novo e mostra uma única vez para repassar ao jogador.
      const kind = input?.kind === "reset" ? "reset" : "verify";
      const code = await adminIssueCode(id, kind);
      return { ok: true, code, kind };
    }
    case "unlock":
      db.run("UPDATE users SET pin_fails = 0, locked_until = 0 WHERE id = ?", [id]);
      break;
    case "verify":
      db.run("UPDATE users SET email_verified = 1 WHERE id = ?", [id]);
      break;
    case "note":
      db.run("UPDATE users SET note = ? WHERE id = ?", [String(input?.note || "").slice(0, 500), id]);
      break;
    default:
      throw new AuthError("Ação desconhecida.");
  }
  return { ok: true };
}

export function listTickets(status: string) {
  const where = ["aberto", "respondido", "fechado"].includes(status) ? "WHERE status = ?" : "";
  const sql = `SELECT t.*, u.nick_display AS user_nick FROM tickets t LEFT JOIN users u ON u.id = t.user_id ${where} ORDER BY CASE t.status WHEN 'aberto' THEN 0 WHEN 'respondido' THEN 1 ELSE 2 END, t.created_at DESC LIMIT 300`;
  return where ? db.query(sql).all(status) : db.query(sql).all();
}

export function answerTicket(id: number, input: any) {
  const t = db.query("SELECT id FROM tickets WHERE id = ?").get(id);
  if (!t) throw new AuthError("Chamado não encontrado.", 404);
  const status = String(input?.status || "respondido");
  if (!["aberto", "respondido", "fechado"].includes(status)) throw new AuthError("Status inválido.");
  const reply = input?.reply === undefined ? undefined : String(input.reply).slice(0, 2000);
  if (reply !== undefined) db.run("UPDATE tickets SET reply = ?, status = ?, updated_at = ? WHERE id = ?", [reply, status, now(), id]);
  else db.run("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?", [status, now(), id]);
  return { ok: true };
}
