// Loja web do Saldo Zero com Asaas (Pix, cartão e boleto no checkout hospedado do Asaas).
//
// Fluxo:
//   1. POST /api/checkout  { productId, name, email, cpfCnpj }  (exige login e e-mail confirmado)
//        -> encontra/cria o cliente no Asaas, cria uma cobrança com billingType UNDEFINED
//           (o pagador escolhe Pix, cartão ou boleto na página do Asaas), grava o pedido com o dono e devolve invoiceUrl.
//   2. O jogo redireciona para invoiceUrl. Ao pagar, o Asaas devolve o jogador a SITE_URL/?pedido=<ref>.
//   3. GET /api/order/:id -> só o dono do pedido; responde pelo banco local e consulta o Asaas apenas se o pedido
//        está pendente há mais de 30 s (e no máximo a cada 15 s).
//   4. POST /api/restore { cpfCnpj } -> exige login; liga ao usuário só pedidos dele ou ainda sem dono cuja cobrança
//        é do mesmo CPF/CNPJ. Um pagamento libera produto para uma única conta.
//   5. POST /api/webhook/asaas -> confere o token (comparação em tempo constante), reconsulta a cobrança no Asaas e
//        registra; estorno e chargeback revogam o que foi liberado.
//
// O banco local (SQLite, tabelas orders e entitlements) é a fonte de verdade do que cada conta possui; o Asaas é a
// fonte de verdade do status de cada cobrança. O navegador só guarda cache e recebe a lista em /api/me.
//
// Variáveis de ambiente:
//   ASAAS_API_KEY        chave da API (sandbox ou produção). Sem ela a loja fica desligada.
//   ASAAS_ENV            "sandbox" (padrão) ou "production".
//   ASAAS_BASE_URL       opcional, sobrescreve a URL base (usado nos testes).
//   ASAAS_WEBHOOK_TOKEN  token configurado no webhook do Asaas (header asaas-access-token).
//   SITE_URL             domínio público, usado no redirecionamento de volta.

import { timingSafeEqual } from "node:crypto";
import { db, now } from "./db";

export const VIP = "com.saldozero.vip";
export const PRODUCTS: Record<string, { name: string; value: number; favores?: number; list?: number }> = {
  [VIP]: { name: "Saldo Zero · VIP para sempre", value: 19.9, list: 59.9 },
  "com.saldozero.favores10": { name: "Saldo Zero · 10 favores", value: 9.9, favores: 10 },
  "com.saldozero.favores30": { name: "Saldo Zero · 30 favores", value: 19.9, favores: 30 },
  "com.saldozero.deck.eleicao": { name: "Saldo Zero · Baralho Ano Eleitoral", value: 9.9 },
  "com.saldozero.capas": { name: "Saldo Zero · Pacote de capas", value: 5.9 },
};
export const PAID = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"]);
// Estorno e chargeback: o que foi liberado é revogado. Se o chargeback for revertido, o status volta a pago e o produto volta.
export const REVOKED = new Set(["REFUNDED", "REFUND_IN_PROGRESS", "CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE", "AWAITING_CHARGEBACK_REVERSAL"]);
/// Status nunca regride: pago não volta a pendente/vencido; REFUNDED é final; os demais seguem o Asaas.
export function nextStatus(old: string | null | undefined, incoming: string) {
  if (!old) return incoming;
  if (old === "REFUNDED") return old;
  if (PAID.has(old) && !PAID.has(incoming) && !REVOKED.has(incoming)) return old;
  return incoming;
}
const REF_PREFIX = "sz:";

const KEY = Bun.env.ASAAS_API_KEY || "";
const ENV = Bun.env.ASAAS_ENV || "sandbox";
const BASE = Bun.env.ASAAS_BASE_URL || (ENV === "production" ? "https://api.asaas.com/v3" : "https://api-sandbox.asaas.com/v3");

export const storeEnabled = KEY.length > 0;

export class StoreError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const brl = (v: number) => "R$ " + v.toFixed(2).replace(".", ",");

export function storeConfig() {
  return {
    enabled: storeEnabled,
    provider: "asaas",
    env: ENV,
    products: Object.entries(PRODUCTS).map(([id, p]) => ({ id, price: brl(p.value), value: p.value, favores: p.favores || 0, list: p.list ? brl(p.list) : null, discount: p.list ? Math.round((1 - p.value / p.list) * 100) : 0 })),
  };
}

async function asaas(path: string, init: RequestInit = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: { access_token: KEY, "content-type": "application/json", accept: "application/json", "user-agent": "SaldoZero/1.0", ...(init.headers || {}) },
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok) {
    const msg = json?.errors?.[0]?.description || ("Asaas respondeu " + res.status);
    throw new StoreError(msg, res.status >= 500 ? 502 : 400);
  }
  return json;
}

// ---- validação ----
const digits = (s: string) => (s || "").replace(/\D/g, "");
function validCPF(c: string) {
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  const calc = (n: number) => { let s = 0; for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return calc(9) === +c[9] && calc(10) === +c[10];
}
function validCNPJ(c: string) {
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = (len: number) => { const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; let s = 0; for (let i = 0; i < len; i++) s += +c[i] * w[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return calc(12) === +c[12] && calc(13) === +c[13];
}
export function validateBuyer(input: any) {
  const name = String(input?.name || "").trim().replace(/\s+/g, " ");
  const email = String(input?.email || "").trim().toLowerCase();
  const doc = digits(String(input?.cpfCnpj || ""));
  if (name.length < 3 || name.length > 80) throw new StoreError("Informe seu nome completo.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) throw new StoreError("Informe um e-mail válido.");
  if (!(validCPF(doc) || validCNPJ(doc))) throw new StoreError("CPF ou CNPJ inválido.");
  return { name, email, cpfCnpj: doc };
}

// ---- cliente ----
async function findOrCreateCustomer(b: { name: string; email: string; cpfCnpj: string }) {
  const found = await asaas("/customers?cpfCnpj=" + b.cpfCnpj + "&limit=1");
  if (found?.data?.length) return found.data[0].id as string;
  const created = await asaas("/customers", { method: "POST", body: JSON.stringify({ name: b.name, email: b.email, cpfCnpj: b.cpfCnpj, notificationDisabled: true, externalReference: "saldozero" }) });
  return created.id as string;
}

// ---- checkout ----
export async function createCheckout(input: any, siteURL: string, userId: number) {
  if (!storeEnabled) throw new StoreError("Loja desligada.", 503);
  const productId = String(input?.productId || "");
  const product = PRODUCTS[productId];
  if (!product) throw new StoreError("Produto desconhecido.");
  const buyer = validateBuyer(input);
  const customer = await findOrCreateCustomer(buyer);
  const ref = REF_PREFIX + productId + ":" + crypto.randomUUID().slice(0, 8);
  const due = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const payment = await asaas("/payments", {
    method: "POST",
    body: JSON.stringify({
      customer,
      billingType: "UNDEFINED",
      value: product.value,
      dueDate: due,
      description: product.name,
      externalReference: ref,
      callback: { successUrl: siteURL + "/?pedido=" + encodeURIComponent(ref), autoRedirect: true },
    }),
  });
  // O webhook pode chegar antes desta linha: nesse caso o pedido já existe sem dono e recebe o dono aqui
  // (sem trocar o dono de quem já tem; o status gravado pelo webhook é mantido).
  db.transaction(() => {
    db.run("INSERT INTO orders (payment_id, ref, user_id, product_id, status, created_at, value) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(payment_id) DO UPDATE SET user_id = COALESCE(orders.user_id, excluded.user_id)",
      [payment.id, ref, userId, productId, payment.status || "PENDING", now(), product.value]);
    syncEntitlement(payment.id);
  })();
  return { paymentId: payment.id as string, ref, invoiceUrl: payment.invoiceUrl as string, productId };
}

/// Registra o estado de uma cobrança (vindo do Asaas, nunca do navegador) e sincroniza o que a conta dona possui.
export function recordPayment(p: { id: string; status: string; externalReference?: string | null }) {
  const productId = productFromRef(p.externalReference);
  if (!productId || !p.id || !p.status) return null;
  return db.transaction(() => {
    const old = db.query("SELECT status FROM orders WHERE payment_id = ?").get(p.id) as { status: string } | null;
    const status = nextStatus(old?.status, p.status);
    const paid = PAID.has(status);
    db.run("INSERT INTO orders (payment_id, ref, user_id, product_id, status, created_at, paid_at, value, checked_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?) ON CONFLICT(payment_id) DO UPDATE SET status = excluded.status, paid_at = COALESCE(orders.paid_at, excluded.paid_at), checked_at = excluded.checked_at",
      [p.id, p.externalReference ?? "", productId, status, now(), paid ? now() : null, PRODUCTS[productId].value, now()]);
    syncEntitlement(p.id);
    return { productId, paid, status };
  })();
}
/// Deixa entitlements coerente com o pedido: pago e com dono -> libera; estornado/contestado -> revoga.
function syncEntitlement(paymentId: string) {
  const o = db.query("SELECT user_id, product_id, status FROM orders WHERE payment_id = ?").get(paymentId) as { user_id: number | null; product_id: string; status: string } | null;
  if (!o) return;
  if (PAID.has(o.status) && o.user_id) grantEntitlement(o.user_id, o.product_id, paymentId);
  else if (REVOKED.has(o.status)) revokeEntitlement(paymentId);
}
/// Idempotente: payment_id é único em entitlements (entre todas as contas), então um pacote de favores só é creditado
/// uma vez, e para uma conta só.
export function grantEntitlement(userId: number, productId: string, paymentId: string) {
  const r = db.run("INSERT OR IGNORE INTO entitlements (user_id, product_id, payment_id, created_at) VALUES (?, ?, ?, ?)", [userId, productId, paymentId, now()]);
  const favores = PRODUCTS[productId]?.favores || 0;
  if (favores && r.changes > 0) db.run("UPDATE users SET favores = favores + ? WHERE id = ?", [favores, userId]);
  return r.changes > 0;
}
/// Estorno/chargeback: remove o produto e desconta os favores do pacote. O saldo de favores PODE ficar negativo:
/// quem gastou os favores e depois estornou fica devendo; o servidor não deixa gastar sem saldo e a próxima compra
/// cobre a diferença. Produtos não consumíveis (VIP, baralho, capas) deixam de valer.
export function revokeEntitlement(paymentId: string) {
  const e = db.query("SELECT user_id, product_id FROM entitlements WHERE payment_id = ?").get(paymentId) as { user_id: number; product_id: string } | null;
  if (!e) return false;
  db.run("DELETE FROM entitlements WHERE payment_id = ?", [paymentId]);
  const favores = PRODUCTS[e.product_id]?.favores || 0;
  if (favores) db.run("UPDATE users SET favores = favores - ? WHERE id = ?", [favores, e.user_id]);
  console.warn("[loja] pagamento " + paymentId + " estornado/contestado: " + e.product_id + " revogado da conta " + e.user_id);
  return true;
}
/// Liga um pedido ainda sem dono ao usuário que acabou de entrar. Nunca troca o dono de um pedido que já tem dono.
export function claimOrder(ref: string, userId: number) {
  db.transaction(() => {
    db.run("UPDATE orders SET user_id = ? WHERE ref = ? AND user_id IS NULL AND erased = 0", [userId, ref]);
    const o = db.query("SELECT payment_id FROM orders WHERE ref = ? AND user_id = ?").get(ref, userId) as { payment_id: string } | null;
    if (o) syncEntitlement(o.payment_id);
  })();
}

// ---- consulta ----
function productFromRef(ref: string | null | undefined) {
  if (!ref || !ref.startsWith(REF_PREFIX)) return null;
  const id = ref.slice(REF_PREFIX.length).split(":")[0];
  return PRODUCTS[id] ? id : null;
}
type OrderRow = { payment_id: string; ref: string; user_id: number | null; product_id: string; status: string; created_at: number; checked_at: number };
/// Pedido do próprio usuário. Responde pelo banco; consulta o Asaas só se pendente há mais de 30 s (no máximo a cada 15 s).
export async function getOrder(idOrRef: string, userId: number) {
  if (!storeEnabled) throw new StoreError("Loja desligada.", 503);
  if (!/^[\w:.-]{3,80}$/.test(idOrRef)) throw new StoreError("Pedido inválido.");
  const find = () => db.query("SELECT payment_id, ref, user_id, product_id, status, created_at, checked_at FROM orders WHERE (payment_id = ? OR ref = ?) AND user_id = ?").get(idOrRef, idOrRef, userId) as OrderRow | null;
  let o = find();
  if (!o) throw new StoreError("Pedido não encontrado.", 404);
  const settled = PAID.has(o.status) || REVOKED.has(o.status);
  let invoiceUrl: string | undefined;
  if (!settled && now() - o.created_at > 30_000 && now() - o.checked_at > 15_000) {
    db.run("UPDATE orders SET checked_at = ? WHERE payment_id = ?", [now(), o.payment_id]);
    try {
      const p = await asaas("/payments/" + encodeURIComponent(o.payment_id));
      if (p?.id === o.payment_id) { recordPayment(p); invoiceUrl = p.invoiceUrl; }
    } catch (e) { console.error("[loja] consulta do pedido " + o.payment_id + " falhou: " + (e as Error).message); }
    o = find()!;
  }
  const granted = !!db.query("SELECT 1 FROM entitlements WHERE payment_id = ? AND user_id = ?").get(o.payment_id, userId);
  return { paymentId: o.payment_id, ref: o.ref, status: o.status, paid: PAID.has(o.status), granted, productId: o.product_id, ...(invoiceUrl ? { invoiceUrl } : {}) };
}

// ---- restauração ----
/// Exige login. Para cada cobrança paga do CPF/CNPJ informado: se o pedido é do usuário, garante o produto; se ainda
/// não tem dono (ou é anterior ao banco), grava o usuário como dono; se é de outra conta, ignora sem revelar nada.
export async function restorePurchases(input: any, userId: number) {
  if (!storeEnabled) throw new StoreError("Loja desligada.", 503);
  const doc = digits(String(input?.cpfCnpj || ""));
  if (!(validCPF(doc) || validCNPJ(doc))) throw new StoreError("CPF ou CNPJ inválido.");
  const customers = await asaas("/customers?cpfCnpj=" + doc + "&limit=5");
  const products = new Set<string>();
  let count = 0;
  for (const c of customers?.data || []) {
    if (digits(String(c?.cpfCnpj || "")) !== doc) continue;   // a cobrança precisa ser do mesmo CPF/CNPJ
    const payments = await asaas("/payments?customer=" + encodeURIComponent(c.id) + "&limit=100");
    for (const p of payments?.data || []) {
      const id = productFromRef(p.externalReference);
      if (!id || !PAID.has(p.status) || p.customer !== c.id) continue;
      const mine = db.transaction(() => {
        recordPayment(p);
        db.run("UPDATE orders SET user_id = ? WHERE payment_id = ? AND user_id IS NULL AND erased = 0", [userId, p.id]);
        const o = db.query("SELECT user_id, status FROM orders WHERE payment_id = ?").get(p.id) as { user_id: number | null; status: string } | null;
        if (!o || o.user_id !== userId || !PAID.has(o.status)) return false;
        syncEntitlement(p.id);
        return !!db.query("SELECT 1 FROM entitlements WHERE payment_id = ? AND user_id = ?").get(p.id, userId);
      })();
      if (mine) { count++; if (!PRODUCTS[id].favores) products.add(id); }
    }
  }
  return { products: [...products], count };
}

// ---- webhook ----
export function webhookAuthorized(req: Request) {
  const expected = Buffer.from(Bun.env.ASAAS_WEBHOOK_TOKEN || "");
  if (expected.length < 8) return false;
  const given = Buffer.from(req.headers.get("asaas-access-token") || "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
/// Webhook: não confia no corpo. Reconsulta a cobrança no Asaas e só então registra (libera ou revoga).
export async function handleWebhook(event: any) {
  const id = String(event?.payment?.id || "");
  if (!/^[\w-]{3,64}$/.test(id)) return { ignored: true };
  const p = await asaas("/payments/" + encodeURIComponent(id));
  if (p?.id !== id) throw new Error("Asaas devolveu outra cobrança");
  const r = recordPayment(p);
  console.log("[asaas webhook] " + event?.event + " " + id + " -> " + p.status + " " + (r ? r.productId : "(não é do jogo)"));
  return { ok: true };
}

// ---- conciliação ----
// O webhook sempre responde 200 (para o Asaas não pausar a fila), então um evento que falhou aqui se perderia.
// Ele fica em webhook_failures e esta rotina reconsulta: falhas e pedidos pendentes dos últimos 7 dias a cada hora;
// pedidos pagos dos últimos 60 dias uma vez por dia, para pegar estorno ou chargeback cujo aviso não chegou.
const RECHECK_OPEN = 7 * 86_400_000;
const RECHECK_PAID = 60 * 86_400_000;
let lastPaidSweep = 0;
export function noteWebhookFailure(paymentId: string, event: string) {
  if (!/^[\w-]{3,64}$/.test(paymentId)) return;
  db.run("INSERT INTO webhook_failures (payment_id, event, attempts, first_at, last_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT(payment_id) DO UPDATE SET event = excluded.event, last_at = excluded.last_at",
    [paymentId, event || "", now(), now()]);
}
export async function reconcilePayments() {
  if (!storeEnabled) return { checked: 0 };
  const t = now();
  const ids = new Set<string>();
  for (const r of db.query("SELECT payment_id FROM webhook_failures WHERE first_at > ?").all(t - RECHECK_OPEN) as { payment_id: string }[]) ids.add(r.payment_id);
  db.run("DELETE FROM webhook_failures WHERE first_at <= ?", [t - RECHECK_OPEN]);
  const open = db.query("SELECT payment_id FROM orders WHERE created_at > ? AND status NOT IN ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH','REFUNDED','DELETED')").all(t - RECHECK_OPEN) as { payment_id: string }[];
  for (const r of open) ids.add(r.payment_id);
  if (t - lastPaidSweep > 86_400_000) {
    lastPaidSweep = t;
    const paid = db.query("SELECT payment_id FROM orders WHERE status IN ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH') AND COALESCE(paid_at, created_at) > ?").all(t - RECHECK_PAID) as { payment_id: string }[];
    for (const r of paid) ids.add(r.payment_id);
  }
  let checked = 0, changed = 0, failed = 0;
  for (const id of ids) {
    try {
      const before = db.query("SELECT status FROM orders WHERE payment_id = ?").get(id) as { status: string } | null;
      const p = await asaas("/payments/" + encodeURIComponent(id));
      if (p?.id !== id) throw new Error("Asaas devolveu outra cobrança");
      recordPayment(p);
      db.run("DELETE FROM webhook_failures WHERE payment_id = ?", [id]);
      const after = db.query("SELECT status FROM orders WHERE payment_id = ?").get(id) as { status: string } | null;
      if (before?.status !== after?.status) { changed++; console.log("[conciliação] " + id + ": " + (before?.status || "novo") + " -> " + after?.status); }
      checked++;
    } catch (e) {
      failed++;
      // cobrança que o Asaas não conhece (ex.: webhook forjado) ou que já falhou demais: para de tentar
      db.run("UPDATE webhook_failures SET attempts = attempts + 1, last_at = ? WHERE payment_id = ?", [now(), id]);
      if (/not found|404/i.test((e as Error).message)) db.run("DELETE FROM webhook_failures WHERE payment_id = ?", [id]);
      db.run("DELETE FROM webhook_failures WHERE attempts >= 48");
      console.error("[conciliação] " + id + ": " + (e as Error).message);
    }
    await Bun.sleep(250);   // gentil com a API do Asaas
  }
  if (checked || failed) console.log("[conciliação] conferidas " + checked + ", mudaram " + changed + ", falharam " + failed);
  return { checked, changed, failed };
}

export function isVip(userId: number) {
  return !!db.query("SELECT 1 FROM entitlements WHERE user_id = ? AND product_id = ? LIMIT 1").get(userId, VIP);
}
