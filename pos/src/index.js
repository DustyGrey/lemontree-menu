// Lemon Tree House POS — API ฝั่งเซิร์ฟเวอร์
// ทุกบิลบันทึกลง D1 ก่อนเสมอ แล้วค่อยส่งต่อเข้า Notion (ถ้าส่งไม่ผ่าน cron จะลองใหม่ทุก 5 นาที)

const NOTION_API = "https://api.notion.com/v1"; // ทดสอบในเครื่องชี้ไป Notion ปลอมได้ด้วยตัวแปร NOTION_API_BASE
const NOTION_VERSION = "2025-09-03";
const TZ_OFFSET_MS = 7 * 60 * 60 * 1000; // เวลาไทย UTC+7
const SESSION_DAYS = 30;
const MENU_TTL_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_SYNC_ATTEMPTS = 50;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      await ensureSchema(env);
      return await route(request, env, ctx, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code }, err.status);
      console.error(err);
      return json({ error: "server_error" }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    await ensureSchema(env);
    ctx.waitUntil(syncPending(env));
  },
};

async function route(request, env, ctx, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/login" && method === "POST") return login(request, env);

  await requireSession(request, env);

  if (pathname === "/api/menu" && method === "GET") return json({ menu: await getMenu(env) });
  if (pathname === "/api/orders" && method === "POST") return createOrder(request, env, ctx);
  if (pathname === "/api/today" && method === "GET") return json(await today(env));
  if (pathname === "/api/sync" && method === "POST") {
    ctx.waitUntil(syncPending(env));
    return json({ ok: true });
  }
  const voidMatch = pathname.match(/^\/api\/orders\/([\w-]{8,64})\/void$/);
  if (voidMatch && method === "POST") return voidOrder(voidMatch[1], env, ctx);

  throw new HttpError(404, "not_found");
}

// ---------- ฐานข้อมูล D1 ----------

let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      bill_no TEXT NOT NULL,
      created_at TEXT NOT NULL,
      day TEXT NOT NULL,
      total INTEGER NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      sync TEXT NOT NULL DEFAULT 'pending',
      sync_error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      sync_lock INTEGER
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS order_items (
      order_id TEXT NOT NULL,
      line INTEGER NOT NULL,
      menu_id TEXT NOT NULL,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      notion_page_id TEXT,
      PRIMARY KEY (order_id, line)
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS orders_day ON orders (day)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS orders_sync ON orders (sync)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, fails INTEGER NOT NULL, window_start INTEGER NOT NULL)`),
  ]);
  schemaReady = true;
}

// ---------- เข้าสู่ระบบด้วย PIN ----------

async function login(request, env) {
  if (!env.APP_PIN) throw new HttpError(500, "pin_not_configured");
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const now = Date.now();

  const row = await env.DB.prepare("SELECT fails, window_start FROM login_attempts WHERE ip = ?").bind(ip).first();
  const inWindow = row && now - row.window_start < LOGIN_WINDOW_MS;
  if (inWindow && row.fails >= LOGIN_MAX_FAILS) throw new HttpError(429, "too_many_attempts");

  const body = await readJson(request);
  const pin = typeof body.pin === "string" ? body.pin : "";
  if (!(await safeEqual(pin, env.APP_PIN))) {
    await env.DB.prepare(
      `INSERT INTO login_attempts (ip, fails, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(ip) DO UPDATE SET
         fails = CASE WHEN ?2 - window_start < ?3 THEN fails + 1 ELSE 1 END,
         window_start = CASE WHEN ?2 - window_start < ?3 THEN window_start ELSE ?2 END`
    ).bind(ip, now, LOGIN_WINDOW_MS).run();
    throw new HttpError(401, "wrong_pin");
  }

  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
  const exp = now + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return json({ token: `${exp}.${await sign(env, String(exp))}` });
}

async function requireSession(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !env.APP_PIN || Number(exp) < Date.now()) throw new HttpError(401, "login_required");
  const key = await hmacKey(env);
  const ok = await crypto.subtle.verify("HMAC", key, base64urlDecode(sig), new TextEncoder().encode(`pos:${exp}`));
  if (!ok) throw new HttpError(401, "login_required");
}

// กุญแจเซ็น session ผูกกับ PIN — เปลี่ยน PIN เมื่อไหร่ ทุกเครื่องต้องล็อกอินใหม่
async function hmacKey(env) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(`session:${env.APP_PIN}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(env, exp) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(`pos:${exp}`));
  return base64urlEncode(new Uint8Array(sig));
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// ---------- เมนู (ดึงจาก Notion, เก็บสำรองใน D1) ----------

async function getMenu(env) {
  const cached = await env.DB.prepare("SELECT value, updated_at FROM kv WHERE key = 'menu'").first();
  if (cached && Date.now() - cached.updated_at < MENU_TTL_MS) return JSON.parse(cached.value);

  try {
    const menu = await fetchMenuFromNotion(env);
    await env.DB.prepare(
      "INSERT INTO kv (key, value, updated_at) VALUES ('menu', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2"
    ).bind(JSON.stringify(menu), Date.now()).run();
    return menu;
  } catch (err) {
    console.error("menu fetch failed", err);
    if (cached) return JSON.parse(cached.value); // Notion ล่ม ใช้เมนูชุดล่าสุดที่เคยดึงได้
    throw new HttpError(503, "menu_unavailable");
  }
}

async function fetchMenuFromNotion(env) {
  const menu = [];
  let cursor;
  do {
    const res = await notion(env, "POST", `/data_sources/${env.NOTION_MENU_DS}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const page of res.results) {
      const p = page.properties;
      const name = (p["ชื่อเมนู"]?.title || []).map((t) => t.plain_text).join("").trim();
      const price = p["ราคา"]?.number;
      if (!name || typeof price !== "number") continue;
      menu.push({
        id: page.id,
        name,
        price,
        category: p["หมวด"]?.select?.name || "อื่น ๆ",
        emoji: page.icon?.type === "emoji" ? page.icon.emoji : "",
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return menu;
}

// ---------- บิล ----------

async function createOrder(request, env, ctx) {
  const body = await readJson(request);
  const id = typeof body.id === "string" && /^[\w-]{8,64}$/.test(body.id) ? body.id : null;
  if (!id) throw new HttpError(400, "bad_order_id");

  // ส่งซ้ำ (เช่นเน็ตหลุดตอนรอคำตอบ) ให้ตอบบิลเดิม ไม่สร้างใหม่
  const existing = await env.DB.prepare("SELECT bill_no, total FROM orders WHERE id = ?").bind(id).first();
  if (existing) return json({ ok: true, billNo: existing.bill_no, total: existing.total, duplicate: true });

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length < 1 || items.length > 50) throw new HttpError(400, "bad_items");

  const menu = new Map((await getMenu(env)).map((m) => [m.id, m]));
  const lines = items.map((it) => {
    const m = menu.get(it.menuId);
    const qty = Number(it.qty);
    if (!m) throw new HttpError(409, "menu_changed");
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new HttpError(400, "bad_qty");
    return { menuId: m.id, name: m.name, price: m.price, qty }; // ราคายึดตามเซิร์ฟเวอร์ ไม่เชื่อราคาจากเครื่อง
  });
  const total = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";

  // บิลที่ค้างส่งจากเครื่อง (ออฟไลน์) ใช้เวลาที่กดจบบิลจริง ถ้าไม่เก่าเกิน 48 ชม.
  const now = Date.now();
  const clientTime = Date.parse(body.createdAt);
  const at = Number.isFinite(clientTime) && clientTime <= now + 5 * 60 * 1000 && now - clientTime < 48 * 3600 * 1000 ? clientTime : now;
  const createdAt = toThaiIso(at);
  const day = createdAt.slice(0, 10);

  const seqRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE day = ?").bind(day).first();
  const billNo = `${day.slice(2).replaceAll("-", "")}-${String(seqRow.n + 1).padStart(3, "0")}`;

  await env.DB.batch([
    env.DB.prepare("INSERT INTO orders (id, bill_no, created_at, day, total, note) VALUES (?, ?, ?, ?, ?, ?)").bind(id, billNo, createdAt, day, total, note || null),
    ...lines.map((l, i) =>
      env.DB.prepare("INSERT INTO order_items (order_id, line, menu_id, name, price, qty) VALUES (?, ?, ?, ?, ?, ?)").bind(id, i, l.menuId, l.name, l.price, l.qty)
    ),
  ]);

  ctx.waitUntil(syncOrder(env, id));
  return json({ ok: true, billNo, total });
}

async function voidOrder(id, env, ctx) {
  const res = await env.DB.prepare("UPDATE orders SET status = 'void', sync = 'pending', attempts = 0 WHERE id = ? AND status = 'ok'").bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, "order_not_found");
  ctx.waitUntil(syncOrder(env, id));
  return json({ ok: true });
}

async function today(env) {
  const day = toThaiIso(Date.now()).slice(0, 10);
  const sums = await env.DB.prepare(
    "SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS bills FROM orders WHERE day = ? AND status = 'ok'"
  ).bind(day).first();
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE sync = 'pending'").first();
  const { results: orders } = await env.DB.prepare(
    "SELECT id, bill_no, created_at, total, status, sync FROM orders WHERE day = ? ORDER BY created_at DESC LIMIT 50"
  ).bind(day).all();
  const { results: items } = orders.length
    ? await env.DB.prepare(
        `SELECT order_id, name, qty FROM order_items WHERE order_id IN (${orders.map(() => "?").join(",")}) ORDER BY line`
      ).bind(...orders.map((o) => o.id)).all()
    : { results: [] };

  return {
    day,
    total: sums.total,
    bills: sums.bills,
    pendingSync: pending.n,
    orders: orders.map((o) => ({
      id: o.id,
      billNo: o.bill_no,
      time: o.created_at.slice(11, 16),
      total: o.total,
      status: o.status,
      sync: o.sync,
      items: items.filter((i) => i.order_id === o.id).map((i) => `${i.name} ×${i.qty}`),
    })),
  };
}

// ---------- ส่งข้อมูลเข้า Notion ----------

async function syncPending(env) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM orders WHERE sync = 'pending' AND attempts < ? ORDER BY created_at LIMIT 20"
  ).bind(MAX_SYNC_ATTEMPTS).all();
  for (const { id } of results) await syncOrder(env, id);
}

async function syncOrder(env, id) {
  // จองบิลก่อนส่ง กัน cron กับการส่งทันทีหลังจบบิล ส่งบิลเดียวกันซ้ำพร้อมกัน
  const now = Date.now();
  const claim = await env.DB.prepare(
    "UPDATE orders SET sync_lock = ?1 WHERE id = ?2 AND sync = 'pending' AND (sync_lock IS NULL OR sync_lock < ?1 - 60000)"
  ).bind(now, id).run();
  if (!claim.meta.changes) return;

  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  const { results: items } = await env.DB.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY line").bind(id).all();

  try {
    if (!env.NOTION_TOKEN) throw new Error("NOTION_TOKEN is not set");
    for (const item of items) {
      if (order.status === "void") {
        // ยกเลิกบิล: ย้ายแถวใน Notion ไปถังขยะ (กู้คืนได้จาก Trash ของ Notion)
        if (item.notion_page_id) {
          await notion(env, "PATCH", `/pages/${item.notion_page_id}`, { in_trash: true });
          await setItemPage(env, id, item.line, null);
        }
      } else if (!item.notion_page_id) {
        const page = await notion(env, "POST", "/pages", {
          parent: { type: "data_source_id", data_source_id: env.NOTION_SALES_DS },
          properties: salesProperties(order, item),
        });
        // เก็บ id ทีละแถว ถ้าพังกลางทาง รอบหน้าจะไม่ส่งแถวที่ส่งไปแล้วซ้ำ
        await setItemPage(env, id, item.line, page.id);
      }
    }
    // ถ้ามีคนกดยกเลิกบิลระหว่างส่ง สถานะจะไม่ตรง บิลจะค้าง pending ให้ cron จัดการต่อ
    await env.DB.prepare("UPDATE orders SET sync = CASE WHEN status = ?2 THEN 'synced' ELSE 'pending' END, sync_error = NULL, sync_lock = NULL WHERE id = ?1").bind(id, order.status).run();
  } catch (err) {
    console.error("notion sync failed", id, err);
    await env.DB.prepare("UPDATE orders SET attempts = attempts + 1, sync_error = ?, sync_lock = NULL WHERE id = ?").bind(String(err.message || err).slice(0, 500), id).run();
  }
}

function salesProperties(order, item) {
  const text = (content) => [{ type: "text", text: { content } }];
  const props = {
    "รายการ": { title: text(`${item.name} ×${item.qty}`) },
    "เมนู": { relation: [{ id: item.menu_id }] },
    "จำนวน": { number: item.qty },
    "ราคาขาย": { number: item.price },
    "เลขบิล": { rich_text: text(order.bill_no) },
    "เวลาบิล": { date: { start: order.created_at } },
  };
  if (order.note) props["หมายเหตุ"] = { rich_text: text(order.note) };
  return props;
}

async function setItemPage(env, orderId, line, pageId) {
  await env.DB.prepare("UPDATE order_items SET notion_page_id = ? WHERE order_id = ? AND line = ?").bind(pageId, orderId, line).run();
}

async function notion(env, method, path, body) {
  const res = await fetch(`${env.NOTION_API_BASE || NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion ${res.status}: ${data.code || ""} ${data.message || ""}`.trim());
  return data;
}

// ---------- เครื่องมือเล็ก ๆ ----------

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

// "2026-09-26T14:05:00+07:00"
function toThaiIso(ms) {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 19) + "+07:00";
}

function base64urlEncode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlDecode(str) {
  try {
    const bin = atob(str.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}
