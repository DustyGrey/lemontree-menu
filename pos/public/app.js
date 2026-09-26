// Lemon Tree House POS — หน้าขาย
// บิลที่ส่งไม่ผ่าน (เน็ตหลุด) จะเก็บไว้ในเครื่องแล้วส่งให้เองเมื่อเน็ตกลับมา

const $ = (id) => document.getElementById(id);
const baht = (n) => "฿" + Number(n).toLocaleString("th-TH");

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* เต็มหรือถูกบล็อก */ }
  },
};

const state = {
  token: store.get("pos.token", null),
  menu: store.get("pos.menu", []),
  cat: null,
  cart: new Map(), // menuId -> qty
  queue: store.get("pos.queue", []), // บิลที่ยังส่งไม่ถึงเซิร์ฟเวอร์
  today: null,
  pin: "",
  flushing: false,
};

// ---------- API ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") {
    logout();
    throw Object.assign(new Error("login_required"), { status: 401 });
  }
  if (!res.ok) throw Object.assign(new Error(data.error || "error"), { status: res.status });
  return data;
}

// ---------- PIN ----------

function renderPin() {
  $("pinDots").innerHTML = Array.from({ length: Math.max(4, state.pin.length) }, (_, i) =>
    `<span class="${i < state.pin.length ? "on" : ""}"></span>`).join("");
}

function setupKeypad() {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "ลบ", "0", "ตกลง"];
  $("keypad").innerHTML = keys.map((k) =>
    `<button data-k="${k}" class="${k.length > 1 ? "ghost" : ""}">${k}</button>`).join("");
  $("keypad").addEventListener("click", (e) => {
    const k = e.target.closest("button")?.dataset.k;
    if (!k) return;
    if (k === "ลบ") state.pin = state.pin.slice(0, -1);
    else if (k === "ตกลง") return submitPin();
    else if (state.pin.length < 8) state.pin += k;
    $("pinMsg").textContent = "";
    renderPin();
  });
  document.addEventListener("keydown", (e) => {
    if ($("login").hidden) return;
    if (/^\d$/.test(e.key) && state.pin.length < 8) state.pin += e.key;
    else if (e.key === "Backspace") state.pin = state.pin.slice(0, -1);
    else if (e.key === "Enter") return submitPin();
    else return;
    renderPin();
  });
}

async function submitPin() {
  if (!state.pin) return;
  try {
    const { token } = await api("/api/login", { method: "POST", body: JSON.stringify({ pin: state.pin }) });
    state.token = token;
    store.set("pos.token", token);
    state.pin = "";
    showApp();
  } catch (err) {
    state.pin = "";
    renderPin();
    $("pinMsg").textContent =
      err.status === 401 ? "PIN ไม่ถูกต้อง ลองใหม่อีกครั้ง" :
      err.status === 429 ? "ใส่ผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่" :
      "เชื่อมต่อไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่";
  }
}

function logout() {
  state.token = null;
  store.set("pos.token", null);
  $("app").hidden = true;
  $("bills").hidden = true;
  $("summary").hidden = true;
  $("login").hidden = false;
  renderPin();
}

// ---------- เมนู ----------

async function loadMenu() {
  try {
    const { menu } = await api("/api/menu");
    state.menu = menu;
    store.set("pos.menu", menu);
  } catch (err) {
    if (err.status === 401) return;
    if (!state.menu.length) toast("โหลดเมนูไม่ได้ ตรวจอินเทอร์เน็ตแล้วเปิดแอปใหม่", true);
  }
  renderCatalog();
}

function renderCatalog() {
  const cats = [...new Set(state.menu.map((m) => m.category))];
  if (!cats.includes(state.cat)) state.cat = null;
  $("cats").innerHTML = [`<button data-cat="" class="${state.cat ? "" : "on"}">ทั้งหมด</button>`]
    .concat(cats.map((c) => `<button data-cat="${esc(c)}" class="${c === state.cat ? "on" : ""}">${esc(c)}</button>`))
    .join("");

  const items = state.menu.filter((m) => !state.cat || m.category === state.cat);
  $("grid").innerHTML = items.length
    ? items.map((m) => {
        const qty = state.cart.get(m.id);
        return `<button class="tile" data-id="${m.id}">
          ${qty ? `<span class="count">${qty}</span>` : ""}
          <span class="emoji">${esc(m.emoji || "🍽️")}</span>
          <span class="name">${esc(m.name)}</span>
          <span class="price">${baht(m.price)}</span>
        </button>`;
      }).join("")
    : `<p class="empty">ยังไม่มีเมนู — เพิ่มเมนูในตาราง "เมนู" บน Notion</p>`;
}

// ---------- ตะกร้า ----------

function menuById(id) { return state.menu.find((m) => m.id === id); }

function addToCart(id, delta) {
  const qty = (state.cart.get(id) || 0) + delta;
  if (qty <= 0) state.cart.delete(id); else state.cart.set(id, Math.min(qty, 99));
  renderCart();
  renderCatalog();
}

function cartTotal() {
  let total = 0, count = 0;
  for (const [id, qty] of state.cart) {
    const m = menuById(id);
    if (m) { total += m.price * qty; count += qty; }
  }
  return { total, count };
}

function renderCart() {
  const lines = [...state.cart].map(([id, qty]) => ({ m: menuById(id), qty })).filter((l) => l.m);
  $("lines").innerHTML = lines.length
    ? lines.map(({ m, qty }) => `
      <div class="line">
        <div class="info"><div>${esc(m.name)}</div><small>${baht(m.price)}</small></div>
        <div class="stepper">
          <button data-step="-1" data-id="${m.id}" aria-label="ลด">−</button>
          <span>${qty}</span>
          <button data-step="1" data-id="${m.id}" aria-label="เพิ่ม">+</button>
        </div>
        <div class="sum">${baht(m.price * qty)}</div>
      </div>`).join("")
    : `<p class="empty">แตะเมนูทางซ้ายเพื่อเพิ่มลงบิล</p>`;

  const { total, count } = cartTotal();
  $("cartTotal").textContent = baht(total);
  $("pay").disabled = count === 0;
  $("pay").textContent = count ? `จบบิล ${baht(total)}` : "จบบิล";
  $("cartbar").hidden = count === 0;
  $("cartbarCount").textContent = `ดูบิล · ${count} รายการ`;
  $("cartbarTotal").textContent = baht(total);
  if (count === 0) closeCartSheet();
}

function openCartSheet() { $("cart").classList.add("open"); $("scrim").hidden = false; }
function closeCartSheet() { $("cart").classList.remove("open"); $("scrim").hidden = true; }

// ---------- จบบิล + คิวออฟไลน์ ----------

function checkout() {
  const items = [...state.cart].filter(([id]) => menuById(id)).map(([menuId, qty]) => ({ menuId, qty }));
  if (!items.length) return;
  const { total } = cartTotal();
  const order = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2),
    createdAt: new Date().toISOString(),
    items,
    note: $("note").value.trim(),
    total, // ไว้โชว์ในเครื่องตอนยังส่งไม่ได้เท่านั้น เซิร์ฟเวอร์คิดราคาเอง
    label: items.map((i) => `${menuById(i.menuId).name} ×${i.qty}`),
  };
  state.queue.push(order);
  store.set("pos.queue", state.queue);

  state.cart.clear();
  $("note").value = "";
  renderCart();
  renderCatalog();
  closeCartSheet();
  flushQueue(true);
}

async function flushQueue(announce = false) {
  if (state.flushing || !state.token) return renderQueuePill();
  state.flushing = true;
  try {
    for (const order of state.queue.filter((o) => !o.error)) {
      try {
        const res = await api("/api/orders", {
          method: "POST",
          body: JSON.stringify({ id: order.id, createdAt: order.createdAt, items: order.items, note: order.note }),
        });
        state.queue = state.queue.filter((o) => o.id !== order.id);
        store.set("pos.queue", state.queue);
        if (announce) toast(`บันทึกบิล ${res.billNo} แล้ว · ${baht(res.total)}`);
      } catch (err) {
        if (err.status === 409 || err.status === 400) {
          // เมนูถูกลบ/แก้ใน Notion ระหว่างที่บิลค้างอยู่ — เก็บไว้ให้ดู ไม่ขวางบิลอื่น
          order.error = "เมนูในบิลนี้ถูกเปลี่ยนใน Notion ส่งไม่ได้";
          store.set("pos.queue", state.queue);
          toast("มีบิลที่ส่งไม่ได้เพราะเมนูถูกเปลี่ยน ดูได้ใน \"บิลวันนี้\"", true);
          continue;
        }
        if (announce) toast("ส่งไม่ได้ตอนนี้ เก็บบิลไว้ในเครื่องแล้ว จะส่งให้เองเมื่อเน็ตกลับมา", true);
        break;
      }
      announce = false;
    }
  } finally {
    state.flushing = false;
    renderQueuePill();
    refreshToday();
  }
}

function dropLocal(id) {
  state.queue = state.queue.filter((o) => o.id !== id);
  store.set("pos.queue", state.queue);
  renderQueuePill();
  renderBills();
}

function renderQueuePill() {
  const n = state.queue.length;
  $("queuePill").hidden = n === 0;
  $("queuePill").textContent = `⏳ รอส่ง ${n} บิล`;
}

// ---------- ยอดวันนี้ / บิลวันนี้ ----------

async function refreshToday() {
  try {
    state.today = await api("/api/today");
    $("todayTotal").textContent = baht(state.today.total);
    $("todayBills").textContent = `วันนี้ ${state.today.bills} บิล`;
    if (!$("bills").hidden) renderBills();
  } catch { /* ออฟไลน์ แสดงตัวเลขเดิมไว้ */ }
}

function renderBills() {
  const t = state.today;
  const local = state.queue.map((o) => `
    <div class="bill">
      <div class="bill-top"><b>ยังไม่มีเลขบิล</b><span class="chip local">อยู่ในเครื่อง รอส่ง</span><span class="amt">${baht(o.total)}</span></div>
      <div class="bill-items">${esc(o.label.join(", "))}</div>
      ${o.error ? `<div class="bill-items" style="color:var(--danger)">${esc(o.error)} — จดบิลนี้ใหม่แล้วกดลบ</div><button class="void-btn" data-drop="${o.id}">ลบบิลนี้ออกจากเครื่อง</button>` : ""}
    </div>`).join("");

  const rows = (t?.orders || []).map((o) => {
    const chip = o.status === "void" ? `<span class="chip void">ยกเลิกแล้ว</span>`
      : o.sync === "synced" ? `<span class="chip synced">เข้า Notion แล้ว</span>`
      : `<span class="chip pending">กำลังส่งเข้า Notion</span>`;
    return `
      <div class="bill ${o.status === "void" ? "void" : ""}">
        <div class="bill-top"><b>${esc(o.billNo)}</b><small>${esc(o.time)}</small>${chip}<span class="amt">${baht(o.total)}</span></div>
        <div class="bill-items">${esc(o.items.join(", "))}</div>
        ${o.status === "ok" ? `<button class="void-btn" data-void="${o.id}">ยกเลิกบิลนี้</button>` : ""}
      </div>`;
  }).join("");

  $("billsBody").innerHTML = `
    <div class="summary">
      <div><small>ยอดขายวันนี้</small><b>${baht(t?.total || 0)}</b></div>
      <div><small>จำนวนบิล</small><b>${t?.bills || 0}</b></div>
      <div><small>รอส่งเข้า Notion</small><b>${(t?.pendingSync || 0) + state.queue.length}</b></div>
    </div>
    ${local}${rows || (local ? "" : `<p class="empty">วันนี้ยังไม่มีบิล</p>`)}`;
}

async function voidBill(btn) {
  // แตะครั้งแรกให้ยืนยัน แตะครั้งที่สองภายใน 4 วินาทีถึงยกเลิกจริง
  if (!btn.classList.contains("confirm")) {
    btn.classList.add("confirm");
    btn.textContent = "แตะอีกครั้งเพื่อยืนยันยกเลิก";
    setTimeout(() => { btn.classList.remove("confirm"); btn.textContent = "ยกเลิกบิลนี้"; }, 4000);
    return;
  }
  try {
    await api(`/api/orders/${btn.dataset.void}/void`, { method: "POST" });
    toast("ยกเลิกบิลแล้ว");
    refreshToday();
  } catch {
    toast("ยกเลิกไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่", true);
  }
}

// ---------- สรุปยอด ----------

const WEEKDAYS = ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"];
const RANGE_PREV = { today: "เมื่อวาน", week: "ช่วงเดียวกันของสัปดาห์ก่อน", month: "ช่วงเดียวกันของเดือนก่อน" };
let summaryRange = "today";

function thaiDate(day, withYear = false) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("th-TH", {
    day: "numeric", month: "short", timeZone: "UTC", ...(withYear ? { year: "numeric" } : {}),
  });
}

async function loadSummary() {
  $("summaryBody").innerHTML = `<p class="empty">กำลังโหลด…</p>`;
  const range = summaryRange;
  try {
    const data = await api(`/api/summary?range=${range}`);
    if (range === summaryRange) renderSummary(data);
  } catch (err) {
    if (err.status !== 401) $("summaryBody").innerHTML = `<p class="empty">โหลดสรุปยอดไม่ได้ ตรวจอินเทอร์เน็ตแล้วลองใหม่</p>`;
  }
}

function barRows(rows, { label, value, sub, highlightTop = false }) {
  const max = Math.max(...rows.map(value), 1);
  return `<div class="bars">${rows.map((r, i) => `
    <div class="bar-row ${highlightTop && i === 0 ? "top" : ""}">
      <span class="label">${esc(label(r))}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(value(r) / max) * 100}%"></span></span>
      <span class="val">${baht(value(r))}${sub ? `<small>${esc(sub(r))}</small>` : ""}</span>
    </div>`).join("")}</div>`;
}

function renderSummary(d) {
  const period = d.from === d.to ? thaiDate(d.from, true) : `${thaiDate(d.from)} – ${thaiDate(d.to, true)}`;
  let delta;
  if (!d.prevTotal) delta = `<div class="delta flat">${RANGE_PREV[d.range]}ยังไม่มียอด</div>`;
  else {
    const pct = Math.round(((d.total - d.prevTotal) / d.prevTotal) * 100);
    const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
    delta = `<div class="delta ${cls}">${pct > 0 ? "▲" : pct < 0 ? "▼" : "•"} ${Math.abs(pct)}% จาก${RANGE_PREV[d.range]} (${baht(d.prevTotal)})</div>`;
  }

  if (!d.bills) {
    $("summaryBody").innerHTML = `<p class="range-label">${period}</p>
      <div class="summary"><div><small>ยอดขาย</small><b>฿0</b>${delta}</div></div>
      <p class="empty">ช่วงนี้ยังไม่มีบิล</p>`;
    return;
  }

  // strftime('%w') ให้ 0 = อาทิตย์ — เรียงใหม่ให้เริ่มวันจันทร์
  const weekdays = [1, 2, 3, 4, 5, 6, 0]
    .map((wd, i) => ({ name: WEEKDAYS[i], ...(d.weekdays.find((w) => w.wd === wd) || { total: 0, bills: 0 }) }));

  $("summaryBody").innerHTML = `
    <p class="range-label">${period}</p>
    <div class="summary">
      <div><small>ยอดขาย</small><b>${baht(d.total)}</b>${delta}</div>
      <div><small>จำนวนบิล</small><b>${d.bills}</b></div>
      <div><small>เฉลี่ยต่อบิล</small><b>${baht(d.avg)}</b></div>
    </div>

    <div class="panel">
      <h3>เมนูขายดี</h3>
      <p class="hint">เรียงตามยอดเงิน</p>
      ${barRows(d.items, { label: (r) => r.name, value: (r) => r.revenue, sub: (r) => `${r.qty} ชิ้น`, highlightTop: true })}
    </div>

    ${d.range !== "today" ? `
    <div class="panel">
      <h3>ยอดตามวันในสัปดาห์</h3>
      ${barRows(weekdays, { label: (r) => r.name, value: (r) => r.total, sub: (r) => `${r.bills} บิล` })}
    </div>` : ""}

    <div class="panel">
      <h3>ช่วงเวลาที่ขาย</h3>
      ${barRows(d.hours, { label: (r) => `${String(r.hour).padStart(2, "0")}:00–${String(r.hour + 1).padStart(2, "0")}:00`, value: (r) => r.total, sub: (r) => `${r.bills} บิล` })}
    </div>

    ${d.range !== "today" ? `
    <div class="panel">
      <h3>รายวัน</h3>
      <div class="day-list">${d.days.map((x) => `<div><b>${thaiDate(x.day)}</b><span>${x.bills} บิล · ${baht(x.total)}</span></div>`).join("")}</div>
    </div>` : ""}`;
}

// ---------- ทั่วไป ----------

let toastTimer;
function toast(msg, warn = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast" + (warn ? " warn" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showApp() {
  $("login").hidden = true;
  $("app").hidden = false;
  renderCatalog();
  renderCart();
  renderQueuePill();
  loadMenu();
  flushQueue();
  refreshToday();
}

function bindEvents() {
  $("cats").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.cat = b.dataset.cat || null;
    renderCatalog();
  });
  $("grid").addEventListener("click", (e) => {
    const b = e.target.closest(".tile");
    if (b) addToCart(b.dataset.id, 1);
  });
  $("lines").addEventListener("click", (e) => {
    const b = e.target.closest("[data-step]");
    if (b) addToCart(b.dataset.id, Number(b.dataset.step));
  });
  $("clearCart").addEventListener("click", () => { state.cart.clear(); renderCart(); renderCatalog(); });
  $("pay").addEventListener("click", checkout);
  $("cartbar").addEventListener("click", openCartSheet);
  $("scrim").addEventListener("click", closeCartSheet);
  $("openBills").addEventListener("click", () => { $("bills").hidden = false; renderBills(); refreshToday(); });
  $("closeBills").addEventListener("click", () => { $("bills").hidden = true; });
  $("openSummary").addEventListener("click", () => { $("summary").hidden = false; loadSummary(); });
  $("closeSummary").addEventListener("click", () => { $("summary").hidden = true; });
  $("rangeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-range]");
    if (!b) return;
    summaryRange = b.dataset.range;
    for (const x of $("rangeSeg").children) x.classList.toggle("on", x === b);
    loadSummary();
  });
  $("billsBody").addEventListener("click", (e) => {
    const b = e.target.closest("[data-void]");
    if (b) voidBill(b);
    const d = e.target.closest("[data-drop]");
    if (d) dropLocal(d.dataset.drop);
  });
  window.addEventListener("online", () => flushQueue());
  setInterval(() => flushQueue(), 30000);
  setInterval(() => refreshToday(), 60000);
}

setupKeypad();
bindEvents();
if (state.token) showApp(); else logout();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
