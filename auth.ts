// Login de jogo: apelido único + PIN numérico. Contas novas usam PIN de 6 a 8 dígitos; contas antigas com PIN de 4
// continuam entrando normalmente. E-mail é opcional (serve para confirmar a conta e recuperar o PIN).
// O servidor devolve um token guardado no navegador; no banco fica só o hash SHA-256 dele.
import { db, now, sha256 } from "./db";
import { sendMail, verifyEmailTemplate, resetPinTemplate, emailInUseTemplate } from "./mail";
import { isVip } from "./store";

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const RESERVED = new Set(["admin", "administrador", "vorkaro", "saldozero", "maxter", "suporte", "moderador", "sistema", "root"]);
const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;

export function normalizeNick(raw: unknown) {
  const nick = String(raw || "").trim();
  if (!NICK_RE.test(nick)) throw new AuthError("Apelido: 3 a 16 letras, números ou _ (sem espaços nem acentos).");
  if (RESERVED.has(nick.toLowerCase())) throw new AuthError("Esse apelido é reservado.");
  return { key: nick.toLowerCase(), display: nick };
}

// ---- PIN ----
const COMMON_PINS = new Set(["123123", "321321", "112233", "332211", "121212", "212121", "101010", "010101", "102030", "147258", "159753", "357159", "147852", "258369", "123321", "654456", "696969", "777777", "131313", "202020", "100200", "123654", "789456", "456789", "987654"]);
/// PIN óbvio: todos iguais, sequência crescente/decrescente, padrão repetido (1212.., 123123) ou lista comum.
export function obviousPin(pin: string) {
  if (/^(\d)\1+$/.test(pin)) return true;
  const d = [...pin].map(Number);
  const step = d[1] - d[0];
  if ((step === 1 || step === -1) && d.every((x, i) => i === 0 || (x - d[i - 1] + 10) % 10 === (step + 10) % 10)) return true;
  for (const len of [2, 3, 4]) if (pin.length % len === 0 && pin.length > len && pin === pin.slice(0, len).repeat(pin.length / len)) return true;
  return COMMON_PINS.has(pin) || COMMON_PINS.has(pin.slice(0, 6));
}
/// "login": aceita PINs antigos (4 a 8). "new": cadastro e troca exigem 6 a 8 números e bloqueiam PINs óbvios.
export function normalizePin(raw: unknown, mode: "login" | "new" = "login") {
  const pin = String(raw || "").trim();
  if (mode === "login") {
    if (!/^\d{4,8}$/.test(pin)) throw new AuthError("PIN: de 4 a 8 números.");
    return pin;
  }
  if (!/^\d{6,8}$/.test(pin)) throw new AuthError("Escolha um PIN de 6 números (até 8).");
  if (obviousPin(pin)) throw new AuthError("Esse PIN é fácil de adivinhar (sequência ou repetição). Escolha outro.");
  return pin;
}
const hashPin = (pin: string) => Bun.password.hash(pin, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });

export type UserRow = { id: number; nick: string; nick_display: string; pin_hash: string; progress: string; created_at: number; last_seen: number; favores: number; blocked: number; note: string; email: string | null; email_verified: number; code: string | null; code_kind: string | null; code_expires: number; code_attempts: number; pin_fails: number; locked_until: number; code_window: number; code_sends: number };
const DEV_CODES = Bun.env.DEV_CODES === "1";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function normalizeEmail(raw: unknown) {
  const email = String(raw || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 120) throw new AuthError("Informe um e-mail válido.");
  return email;
}

// ---- códigos por e-mail (6 dígitos, aleatórios de verdade, guardados como hash, 30 min) ----
const CODE_TTL = 30 * 60_000;
const DAY = 864e5;
const MAX_SENDS_PER_DAY = 5;      // códigos enviados por conta em 24 h (confirmação + troca de PIN)
const MAX_CODE_FAILS_PER_DAY = 10; // erros de código por conta em 24 h; pedir código novo NÃO zera
function newCode() {
  const buf = new Uint32Array(1);
  let n: number;
  do { crypto.getRandomValues(buf); n = buf[0]; } while (n >= 4_294_000_000); // evita viés do módulo
  return String(n % 1_000_000).padStart(6, "0");
}
const codeHash = (userId: number, kind: string, code: string) => sha256("sz-code:" + userId + ":" + kind + ":" + code);
/// Abre uma janela nova de 24 h quando a anterior venceu (zera os contadores só então).
function rollWindow(userId: number) {
  db.run("UPDATE users SET code_window = ?, code_sends = 0, code_attempts = 0 WHERE id = ? AND code_window < ?", [now(), userId, now() - DAY]);
}
async function issueCode(userId: number, kind: "verify" | "reset") {
  rollWindow(userId);
  const r = db.run("UPDATE users SET code_sends = code_sends + 1 WHERE id = ? AND code_sends < ?", [userId, MAX_SENDS_PER_DAY]);
  if (r.changes === 0) return { code: null, sent: false, limited: true };
  const code = newCode();
  db.run("UPDATE users SET code = ?, code_kind = ?, code_expires = ? WHERE id = ?", [codeHash(userId, kind, code), kind, now() + CODE_TTL, userId]);
  const u = db.query("SELECT nick_display, email FROM users WHERE id = ?").get(userId) as { nick_display: string; email: string | null };
  let sent = false;
  if (u?.email) {
    const tpl = kind === "verify" ? verifyEmailTemplate(u.nick_display, code) : resetPinTemplate(u.nick_display, code);
    sent = (await sendMail(u.email, tpl.subject, tpl.html, tpl.text)).sent;
  }
  return { code, sent, limited: false };
}
function consumeCode(user: UserRow, kind: string, given: unknown) {
  const code = String(given || "").trim();
  if (!/^\d{6}$/.test(code)) throw new AuthError("Código: 6 números.");
  rollWindow(user.id);
  const fresh = db.query("SELECT code, code_kind, code_expires, code_attempts FROM users WHERE id = ?").get(user.id) as any;
  if (fresh.code_attempts >= MAX_CODE_FAILS_PER_DAY) throw new AuthError("Muitas tentativas erradas. Tente de novo amanhã ou fale com o suporte.", 429);
  if (!fresh?.code || fresh.code_kind !== kind || fresh.code_expires < now()) throw new AuthError("Código expirado. Peça um novo.", 410);
  if (fresh.code !== codeHash(user.id, kind, code)) {
    db.run("UPDATE users SET code_attempts = code_attempts + 1 WHERE id = ?", [user.id]);
    throw new AuthError("Código incorreto.", 401);
  }
  db.run("UPDATE users SET code = NULL, code_kind = NULL, code_expires = 0, code_attempts = 0 WHERE id = ?", [user.id]);
}
const codeExtras = (r: { code: string | null; sent: boolean; limited: boolean }) => ({ sent: r.sent, ...(r.limited ? { limited: true } : {}), ...(DEV_CODES && r.code ? { devCode: r.code } : {}) });

export function nickAvailable(raw: unknown) {
  const { key, display } = normalizeNick(raw);
  const row = db.query("SELECT id FROM users WHERE nick = ?").get(key) as { id: number } | null;
  return { nick: display, available: !row };
}

// ---- bloqueio progressivo do PIN, persistido por conta ----
// 5 erros seguidos: 1 min; cada erro seguinte dobra (2, 4, 8 min...) até 60 min. Acertar zera.
// O teto curto evita que alguém bloqueie por um dia a conta de outro pelo apelido público do ranking.
const FREE_FAILS = 5;
function lockMinutes(fails: number) { return fails < FREE_FAILS ? 0 : Math.min(60, 2 ** (fails - FREE_FAILS)); }
function checkLock(row: UserRow) {
  if (row.locked_until > now()) {
    const min = Math.ceil((row.locked_until - now()) / 60_000);
    throw new AuthError("Muitas tentativas erradas. Tente de novo em " + min + " min ou use \"Esqueci o PIN\".", 429);
  }
}
/// Reserva a tentativa ANTES de conferir o PIN, de forma atômica: tentativas em paralelo não escapam do contador.
/// Se acertar, quem chamou zera pin_fails/locked_until.
function reserveAttempt(row: UserRow) {
  checkLock(row);
  const r = db.query("UPDATE users SET pin_fails = pin_fails + 1 WHERE id = ? AND locked_until <= ? RETURNING pin_fails").get(row.id, now()) as { pin_fails: number } | null;
  if (!r) throw new AuthError("Muitas tentativas erradas. Tente de novo em alguns minutos ou use \"Esqueci o PIN\".", 429);
  const min = lockMinutes(r.pin_fails);
  if (min) db.run("UPDATE users SET locked_until = ? WHERE id = ?", [now() + min * 60_000, row.id]);
}
const clearFailures = (id: number) => db.run("UPDATE users SET pin_fails = 0, locked_until = 0 WHERE id = ?", [id]);

// ---- sessões ----
export const SESSION_MAX_AGE = 90 * DAY;   // expiração absoluta
export const SESSION_IDLE = 30 * DAY;      // expiração por inatividade
const TOUCH_EVERY = 60 * 60_000;           // last_seen é atualizado no máximo 1x por hora
function newSession(userId: number) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Buffer.from(bytes).toString("base64url") + Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  db.run("INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)", [sha256(token), userId, now(), now()]);
  return token;
}
export function cleanupSessions() {
  const r = db.run("DELETE FROM sessions WHERE created_at < ? OR last_seen < ?", [now() - SESSION_MAX_AGE, now() - SESSION_IDLE]);
  return r.changes;
}
function tokenOf(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return /^[\w-]{40,120}$/.test(token) ? token : "";
}

/// Entra se o apelido existe (PIN precisa bater); cria a conta se não existe.
export async function enter(input: any) {
  const { key, display } = normalizeNick(input?.nick);
  const row = db.query("SELECT * FROM users WHERE nick = ?").get(key) as UserRow | null;
  if (row) {
    const pin = normalizePin(input?.pin, "login");
    if (row.blocked) throw new AuthError("Esta conta foi bloqueada. Fale com o suporte pelo menu Ajuda.", 403);
    reserveAttempt(row);
    const ok = await Bun.password.verify(pin, row.pin_hash);
    if (!ok) { throw new AuthError("PIN incorreto para este apelido.", 401); }
    db.run("UPDATE users SET last_seen = ?, pin_fails = 0, locked_until = 0 WHERE id = ?", [now(), row.id]);
    return { token: newSession(row.id), user: publicUser(row), created: false };
  }
  if (input?.create !== true) throw new AuthError("Apelido livre. Confirme para criar sua conta.", 404);
  const pin = normalizePin(input?.pin, "new");
  // E-mail é opcional no cadastro; o jogo pede depois, com um lembrete fixo.
  const email = String(input?.email || "").trim() ? normalizeEmail(input?.email) : null;
  const hash = await hashPin(pin);
  try {
    db.run("INSERT INTO users (nick, nick_display, pin_hash, created_at, last_seen, email) VALUES (?, ?, ?, ?, ?, ?)", [key, display, hash, now(), now(), email]);
  } catch {
    throw new AuthError("Esse apelido acabou de ser escolhido por outra pessoa.", 409);
  }
  const created = db.query("SELECT * FROM users WHERE nick = ?").get(key) as UserRow;
  const extras = email ? await startEmailVerification(created.id, email) : {};
  return { token: newSession(created.id), user: publicUser(created), created: true, ...extras };
}

/// Resposta igual para e-mail livre ou já confirmado em outra conta (não revela cadastros). Se já estiver em uso,
/// o dono do endereço recebe um aviso em vez do código.
async function startEmailVerification(userId: number, email: string) {
  const owner = db.query("SELECT id FROM users WHERE email = ? AND email_verified = 1 AND id != ?").get(email, userId);
  if (owner) {
    const tpl = emailInUseTemplate();
    return { sent: (await sendMail(email, tpl.subject, tpl.html, tpl.text)).sent };
  }
  return codeExtras(await issueCode(userId, "verify"));
}

export function userFromRequest(req: Request): UserRow | null {
  const token = tokenOf(req);
  if (!token) return null;
  const h = sha256(token);
  const row = db.query("SELECT u.*, s.created_at AS s_created, s.last_seen AS s_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?").get(h) as (UserRow & { s_created: number; s_seen: number }) | null;
  if (!row || row.blocked) return null;
  if (row.s_created < now() - SESSION_MAX_AGE || row.s_seen < now() - SESSION_IDLE) {
    db.run("DELETE FROM sessions WHERE token_hash = ?", [h]);
    return null;
  }
  if (now() - row.s_seen > TOUCH_EVERY) {
    db.run("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", [now(), h]);
    db.run("UPDATE users SET last_seen = ? WHERE id = ?", [now(), row.id]);
  }
  return row;
}
export function requireUser(req: Request) {
  const u = userFromRequest(req);
  if (!u) throw new AuthError("Entre com seu apelido para continuar.", 401);
  return u;
}
export function logout(req: Request) {
  const token = tokenOf(req);
  if (token) db.run("DELETE FROM sessions WHERE token_hash = ?", [sha256(token)]);
}
/// "Sair de todos os aparelhos": encerra todas as sessões da conta, inclusive a atual.
export function logoutAll(user: UserRow) {
  const r = db.run("DELETE FROM sessions WHERE user_id = ?", [user.id]);
  return { ok: true, sessions: r.changes };
}

export function publicUser(row: UserRow) {
  const fresh = db.query("SELECT favores, email, email_verified FROM users WHERE id = ?").get(row.id) as { favores: number; email: string | null; email_verified: number } | null;
  return { id: row.id, nick: row.nick_display, createdAt: row.created_at, progress: safeJSON(row.progress), favores: fresh?.favores ?? 0, email: fresh?.email ? maskEmail(fresh.email) : null, emailVerified: !!fresh?.email_verified, vip: isVip(row.id) };
}
export const maskEmail = (e: string) => { const [u, d] = e.split("@"); return (u.length <= 2 ? u[0] + "*" : u.slice(0, 2) + "***") + "@" + d; };
export function requireVerified(user: UserRow) {
  const fresh = db.query("SELECT email_verified FROM users WHERE id = ?").get(user.id) as { email_verified: number };
  if (!fresh?.email_verified) throw new AuthError("Confirme seu e-mail para continuar (menu da conta).", 403);
}

// ---- e-mail: confirmação, reenvio, troca e recuperação de PIN ----
export async function verifyEmail(user: UserRow, input: any) {
  consumeCode(user, "verify", input?.code);
  try {
    db.run("UPDATE users SET email_verified = 1 WHERE id = ?", [user.id]);
  } catch {
    throw new AuthError("Este e-mail já está confirmado em outra conta. Use \"Esqueci o PIN\" com o apelido dela.", 409);
  }
  return { ok: true };
}
export async function resendVerification(user: UserRow) {
  const fresh = db.query("SELECT email, email_verified FROM users WHERE id = ?").get(user.id) as any;
  if (!fresh?.email) throw new AuthError("Cadastre um e-mail primeiro.");
  if (fresh.email_verified) return { ok: true, already: true };
  const r = await startEmailVerification(user.id, fresh.email);
  if ((r as any).limited) throw new AuthError("Limite de códigos de hoje atingido. Tente amanhã ou fale com o suporte.", 429);
  return { ok: true, ...r };
}
export async function setEmail(user: UserRow, input: any) {
  const email = normalizeEmail(input?.email);
  db.run("UPDATE users SET email = ?, email_verified = 0 WHERE id = ?", [email, user.id]);
  const r = await startEmailVerification(user.id, email);
  if ((r as any).limited) throw new AuthError("Limite de códigos de hoje atingido. Tente amanhã ou fale com o suporte.", 429);
  return { ok: true, ...r };
}
export async function forgotPin(input: any) {
  const { key } = normalizeNick(input?.nick);
  const row = db.query("SELECT * FROM users WHERE nick = ?").get(key) as UserRow | null;
  // Resposta igual com ou sem conta (e com ou sem limite atingido), para não revelar apelidos.
  let devCode: string | null = null;
  if (row && row.email && !row.blocked) devCode = (await issueCode(row.id, "reset")).code;
  return { ok: true, ...(DEV_CODES && devCode ? { devCode } : {}) };
}
export async function resetPin(input: any) {
  const { key } = normalizeNick(input?.nick);
  const row = db.query("SELECT * FROM users WHERE nick = ?").get(key) as UserRow | null;
  if (!row) throw new AuthError("Código incorreto.", 401);
  const pin = normalizePin(input?.pin, "new");
  consumeCode(row, "reset", input?.code);
  const hash = await hashPin(pin);
  db.run("UPDATE users SET pin_hash = ?, email_verified = 1, pin_fails = 0, locked_until = 0 WHERE id = ?", [hash, row.id]);
  db.run("DELETE FROM sessions WHERE user_id = ?", [row.id]);
  return { ok: true };
}
function safeJSON(s: string) { try { return JSON.parse(s || "{}"); } catch { return {}; } }

/// Exclusão de conta (LGPD art. 18, VI). Apaga conta, sessões, chamados, resultados e itens. Os pedidos pagos
/// ficam no banco apenas com id da cobrança, produto, valor, status e datas, SEM vínculo com a pessoa (user_id NULL),
/// porque a cobrança é registro fiscal da Ebenix (obrigação legal, art. 16, I).
export async function deleteAccount(user: UserRow, input: any, requirePin = true) {
  if (requirePin) {
    const pin = normalizePin(input?.pin, "login");
    reserveAttempt(user);
    const ok = await Bun.password.verify(pin, user.pin_hash);
    // 403 (e não 401): o jogo trata 401 como sessão perdida e deslogaria a pessoa por um PIN digitado errado.
    if (!ok) throw new AuthError("PIN incorreto.", 403);
    clearFailures(user.id);
  }
  eraseUser(user.id);
  return { ok: true };
}
export function eraseUser(userId: number) {
  db.transaction(() => {
    db.run("DELETE FROM tickets WHERE user_id = ?", [userId]);
    db.run("UPDATE orders SET user_id = NULL, erased = 1 WHERE user_id = ?", [userId]);
    db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    db.run("DELETE FROM results WHERE user_id = ?", [userId]);
    db.run("DELETE FROM entitlements WHERE user_id = ?", [userId]);
    db.run("DELETE FROM users WHERE id = ?", [userId]);
  })();
}

/// Gasta favores da conta de forma atômica; devolve o saldo novo ou lança se não houver saldo.
export function spendFavores(user: UserRow, n: unknown) {
  const qty = Math.floor(Number(n));
  if (!(qty >= 1 && qty <= 10)) throw new AuthError("Quantidade inválida.");
  const r = db.run("UPDATE users SET favores = favores - ? WHERE id = ? AND favores >= ?", [qty, user.id, qty]);
  if (r.changes === 0) throw new AuthError("Você não tem favores suficientes.", 402);
  return (db.query("SELECT favores FROM users WHERE id = ?").get(user.id) as { favores: number }).favores;
}

export function entitlementsOf(userId: number) {
  const rows = db.query("SELECT DISTINCT product_id FROM entitlements WHERE user_id = ?").all(userId) as { product_id: string }[];
  return rows.map((r) => r.product_id);
}

// Partida em andamento: guardada como veio do jogo (só para continuar em outro aparelho; o ranking valida à parte).
const MAX_RUN = 300_000;
export function getRun(userId: number) {
  const r = db.query("SELECT run_state, run_at FROM users WHERE id = ?").get(userId) as { run_state: string; run_at: number } | null;
  if (!r || !r.run_state) return null;
  try { return { state: JSON.parse(r.run_state), at: r.run_at }; } catch { return null; }
}
export function saveRun(user: UserRow, input: any) {
  const state = input?.state;
  if (state === null) { db.run("UPDATE users SET run_state = '', run_at = ? WHERE id = ?", [now(), user.id]); return { ok: true }; }
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new AuthError("Partida inválida.", 400);
  const txt = JSON.stringify(state);
  if (txt.length > MAX_RUN) throw new AuthError("Partida grande demais para salvar.", 413);
  db.run("UPDATE users SET run_state = ?, run_at = ? WHERE id = ?", [txt, now(), user.id]);
  return { ok: true };
}

// Progresso (finais, conquistas, recorde): o servidor guarda a união com o que já tinha.
export function mergeProgress(user: UserRow, incoming: any) {
  const cur = safeJSON(user.progress);
  const strList = (list: unknown) => (Array.isArray(list) ? list : []).filter((a) => typeof a === "string" && /^[a-z0-9_]{2,24}$/.test(a)).slice(0, 100);
  const next: any = { ends: { ...(cur.ends || {}) }, ach: [...new Set([...strList(cur.ach), ...strList(incoming?.ach)])], items: [...new Set([...strList(cur.items), ...strList(incoming?.items)])], best: Math.max(cur.best || 0, Math.min(MAX_DAYS, Number(incoming?.best) || 0)) };
  for (const [k, v] of Object.entries(incoming?.ends || {})) if (ENDINGS.has(k)) next.ends[k] = Math.max(next.ends[k] || 0, Math.min(10_000, Number(v) || 0));
  db.run("UPDATE users SET progress = ? WHERE id = ?", [JSON.stringify(next), user.id]);
  return next;
}

// ---- Desafio diário ----
// O dia é sempre o de Brasília (America/Sao_Paulo), calculado no servidor.
export function spDay(t = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
}
// Limites do motor (game.html): cada decisão avança 5–9 dias (capítulo 1, dia < 80), 8–15 (capítulo 2, < 320) ou
// 14–27 (capítulo 3); o jogo acaba ao chegar no dia 730 ("lenda"). No diário só há os 2 favores da partida
// (jogadas do Vorkaro: +2 dias cada) e não há recurso. Daí:
//   dias >= 1 + 5 × decisões;   dias <= 1 + 27 × decisões + 2 × 2;   dias <= 729 + 27 + 4 = 760;
//   final "lenda" exige dias >= 730; os demais finais acontecem no máximo na decisão que cruza o dia 730.
const ENDINGS = new Set(["preso", "falencia", "miami", "dono", "descartado", "cancelado", "idolo", "delator", "exilio", "lenda"]);
export const MAX_DAYS = 760;
const DAILY_GRACE = 10 * 60_000; // quem começou antes da meia-noite tem 10 min para enviar o resultado de "ontem"
export function plausibleRun(days: number, turns: number, ending: string) {
  if (!Number.isInteger(days) || !Number.isInteger(turns)) return false;
  if (!ENDINGS.has(ending)) return false;
  if (days < 1 || days > MAX_DAYS || turns < 0 || turns > 160) return false;
  if (days < 1 + 5 * turns) return false;
  if (days > 1 + 27 * turns + 4) return false;
  if (ending === "lenda" && days < 730) return false;
  return true;
}
export function submitDaily(user: UserRow, input: any) {
  const day = String(input?.day || "");
  const today = spDay(), yesterday = spDay(Date.now() - DAILY_GRACE);
  if (day !== today && day !== yesterday) throw new AuthError("Este desafio diário já fechou. Jogue o de hoje.", 409);
  const days = Number(input?.days), turns = Number(input?.turns);
  const ending = String(input?.ending || "");
  if (!plausibleRun(days, turns, ending)) {
    console.warn("[diário] resultado impossível recusado: conta " + user.id + " dias=" + input?.days + " decisões=" + input?.turns + " final=" + ending);
    throw new AuthError("Resultado inválido.", 422);
  }
  db.run("INSERT OR IGNORE INTO results (user_id, day, days, turns, ending, created_at) VALUES (?, ?, ?, ?, ?, ?)", [user.id, day, days, turns, ending, now()]);
  return leaderboard(day, user.id);
}

export function leaderboard(day: string, userId?: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AuthError("Dia inválido.");
  const top = db.query("SELECT u.nick_display AS nick, r.days, r.ending, r.turns, EXISTS(SELECT 1 FROM entitlements e WHERE e.user_id = u.id AND e.product_id = 'com.saldozero.vip') AS vip FROM results r JOIN users u ON u.id = r.user_id WHERE r.day = ? ORDER BY r.days DESC, r.turns ASC, r.created_at ASC LIMIT 50").all(day) as any[];
  const total = (db.query("SELECT COUNT(*) AS n FROM results WHERE day = ?").get(day) as { n: number }).n;
  let me: any = null;
  if (userId) {
    const mine = db.query("SELECT days, turns, ending, created_at FROM results WHERE day = ? AND user_id = ?").get(day, userId) as any;
    if (mine) {
      const better = (db.query("SELECT COUNT(*) AS n FROM results WHERE day = ? AND (days > ? OR (days = ? AND turns < ?) OR (days = ? AND turns = ? AND created_at < ?))").get(day, mine.days, mine.days, mine.turns, mine.days, mine.turns, mine.created_at) as { n: number }).n;
      me = { rank: better + 1, days: mine.days, ending: mine.ending, percentile: total > 1 ? Math.round((1 - better / (total - 1)) * 100) : 100 };
    }
  }
  return { day, total, top, me };
}

// ---- Suporte: chamados abertos pelo jogo ----
const SUBJECTS = new Set(["pagamento", "bug", "conta", "conteudo", "sugestao", "outro"]);
export function createTicket(user: UserRow | null, input: any) {
  const subject = String(input?.subject || "outro");
  if (!SUBJECTS.has(subject)) throw new AuthError("Assunto inválido.");
  const message = String(input?.message || "").trim();
  if (message.length < 10 || message.length > 2000) throw new AuthError("Escreva pelo menos 10 caracteres (máximo 2000).");
  const email = String(input?.email || "").trim().toLowerCase();
  if (email && (!EMAIL_RE.test(email) || email.length > 120)) throw new AuthError("E-mail inválido.");
  if (!user && !email) throw new AuthError("Sem conta, informe um e-mail para receber a resposta.");
  const nick = user ? user.nick_display : String(input?.nick || "").trim().slice(0, 16);
  const r = db.run("INSERT INTO tickets (user_id, nick, email, subject, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [user?.id ?? null, nick || null, email || null, subject, message, now(), now()]);
  return { id: Number(r.lastInsertRowid) };
}
export function myTickets(user: UserRow) {
  return db.query("SELECT id, subject, message, status, reply, created_at, updated_at FROM tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(user.id);
}

// ---- Painel: código novo para o jogador cujo e-mail não chegou (mostrado uma vez ao administrador) ----
export async function adminIssueCode(userId: number, kind: "verify" | "reset") {
  db.run("UPDATE users SET code_sends = 0 WHERE id = ?", [userId]);
  const r = await issueCode(userId, kind);
  return r.code;
}
