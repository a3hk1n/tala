/* =========================================================
   قلک طلایی (Golden Wallet) — Vanilla JS Application
   Architecture: small service modules + a central StateManager
   ========================================================= */
"use strict";

/* ============================================================
         0. UTILITIES — Persian digits / Jalali dates / number format
         ============================================================ */
const Utils = (() => {
  const faDigits = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

  function toFaDigits(input) {
    return String(input).replace(/[0-9]/g, (d) => faDigits[d]);
  }

  function toEnDigits(input) {
    return String(input).replace(/[۰-۹]/g, (d) => faDigits.indexOf(d));
  }

  // Format integer/decimal with thousands separators, then convert to Persian digits
  function formatNumber(num, decimals = 0) {
    if (num === null || num === undefined || isNaN(num)) return toFaDigits("0");
    const fixed = Number(num).toFixed(decimals);
    const parts = fixed.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const joined = parts.length > 1 ? parts.join(".") : parts[0];
    return toFaDigits(joined);
  }

  function formatToman(num) {
    return formatNumber(Math.round(num || 0), 0) + " تومان";
  }

  function formatGram(num) {
    return formatNumber(num || 0, 4) + " گرم";
  }

  // Parse a user-entered numeric string (may contain commas / Persian digits)
  function parseNumber(str) {
    if (str === null || str === undefined) return NaN;
    const en = toEnDigits(String(str)).replace(/,/g, "").trim();
    if (en === "") return NaN;
    return Number(en);
  }

  // --- Gregorian -> Jalali conversion (standard algorithm) ---
  function gregorianToJalali(gy, gm, gd) {
    const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let jy = gy <= 1600 ? 0 : 979;
    gy -= gy <= 1600 ? 621 : 1600;
    const gy2 = gm > 2 ? gy + 1 : gy;
    let days =
      365 * gy +
      Math.floor((gy2 + 3) / 4) -
      Math.floor((gy2 + 99) / 100) +
      Math.floor((gy2 + 399) / 400) -
      80 +
      gd +
      g_d_m[gm - 1];
    jy += 33 * Math.floor(days / 12053);
    days %= 12053;
    jy += 4 * Math.floor(days / 1461);
    days %= 1461;
    if (days > 365) {
      jy += Math.floor((days - 1) / 365);
      days = (days - 1) % 365;
    }
    let jm, jd;
    if (days < 186) {
      jm = 1 + Math.floor(days / 31);
      jd = 1 + (days % 31);
    } else {
      jm = 7 + Math.floor((days - 186) / 30);
      jd = 1 + ((days - 186) % 30);
    }
    return [jy, jm, jd];
  }

  function nowJalaliParts(d = new Date()) {
    const [jy, jm, jd] = gregorianToJalali(
      d.getFullYear(),
      d.getMonth() + 1,
      d.getDate()
    );
    return { jy, jm, jd, hh: d.getHours(), mm: d.getMinutes() };
  }

  function formatJalaliDate(d = new Date()) {
    const { jy, jm, jd } = nowJalaliParts(d);
    const pad = (n) => String(n).padStart(2, "0");
    return toFaDigits(`${jy}/${pad(jm)}/${pad(jd)}`);
  }

  function formatJalaliDateTime(d = new Date()) {
    const { jy, jm, jd, hh, mm } = nowJalaliParts(d);
    const pad = (n) => String(n).padStart(2, "0");
    return toFaDigits(`${jy}/${pad(jm)}/${pad(jd)} - ${pad(hh)}:${pad(mm)}`);
  }

  function uid(prefix = "id") {
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function validMobile(mobile) {
    return /^09\d{9}$/.test(toEnDigits(mobile || "").trim());
  }

  function validNationalCode(code) {
    return /^\d{10}$/.test(toEnDigits(code || "").trim());
  }

  return {
    toFaDigits,
    toEnDigits,
    formatNumber,
    formatToman,
    formatGram,
    parseNumber,
    formatJalaliDate,
    formatJalaliDateTime,
    nowJalaliParts,
    uid,
    escapeHtml,
    validMobile,
    validNationalCode,
  };
})();

/* ============================================================
         0.5 SUPABASE CONFIG — paste your project URL + anon key here
         ============================================================ */
const SupabaseConfig = {
  URL: "https://lawwcoeiwpsakxwfhipv.supabase.co",
  ANON_KEY: "sb_publishable_wej8saTKU5zwUd4fljHiXg_K810yVtR",
};

/* ============================================================
         1. STORAGE SERVICE — in-memory cache (mirrors the DB)
         All reads in the rest of the app stay synchronous by reading
         from this cache. The cache is populated from Supabase on
         startup and kept in sync by DataService after every write.
         ============================================================ */
const StorageService = (() => {
  let cache = {
    customers: [],
    ledger: [],
    goldPrice: 0,
    goldPriceUpdatedAt: 0,
    settings: { businessName: "قلک طلایی", smsEnabled: true },
    sms: [],
  };

  function get(key, fallback) {
    const val = cache[key];
    return val === undefined || val === null ? fallback : val;
  }

  function set(key, value) {
    cache[key] = value;
    return true;
  }

  function remove(key) {
    delete cache[key];
  }

  function replaceAll(data) {
    cache = { ...cache, ...data };
  }

  function exportAll() {
    return {
      customers: get("customers", []),
      ledger: get("ledger", []),
      goldPrice: get("goldPrice", 0),
      settings: get("settings", {}),
      sms: get("sms", []),
      exportedAt: new Date().toISOString(),
    };
  }

  function clearCache() {
    cache = {
      customers: [],
      ledger: [],
      goldPrice: 0,
      goldPriceUpdatedAt: 0,
      settings: { businessName: "قلک طلایی", smsEnabled: true },
      sms: [],
    };
  }

  return { get, set, remove, replaceAll, exportAll, clearCache };
})();

/* ============================================================
         1.5 DATA SERVICE — all Supabase (Postgres) I/O lives here.
         Field names are converted between the app's camelCase shape
         and the DB's snake_case columns so the rest of the app never
         has to know the difference.
         ============================================================ */
const DataService = (() => {
  let client = null;

  function init() {
    if (typeof window.supabase === "undefined") {
      console.error(
        "Supabase SDK not found — make sure the supabase-js <script> tag is included in index.html before app.js."
      );
      return false;
    }
    if (
      !SupabaseConfig.URL ||
      SupabaseConfig.URL.startsWith("YOUR_") ||
      !SupabaseConfig.ANON_KEY ||
      SupabaseConfig.ANON_KEY.startsWith("YOUR_")
    ) {
      console.error(
        "Supabase not configured — fill in SupabaseConfig.URL and SupabaseConfig.ANON_KEY in app.js."
      );
      return false;
    }
    client = window.supabase.createClient(
      SupabaseConfig.URL,
      SupabaseConfig.ANON_KEY
    );
    return true;
  }

  function isReady() {
    return !!client;
  }

  /* ---------- AUTH ---------- */
  async function signIn(username, password) {
    const email = `${username}@goldenwallet.local`;
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    return data;
  }

  async function signOut() {
    await client.auth.signOut();
  }

  async function getSession() {
    const { data } = await client.auth.getSession();
    return data.session;
  }

  /* ---------- MAPPERS (db snake_case -> app camelCase) ---------- */
  function mapCustomer(row) {
    return {
      id: row.id,
      fullName: row.full_name,
      mobile: row.mobile,
      nationalCode: row.national_code,
      address: row.address || "",
      description: row.description || "",
      joinDate: row.join_date,
      createdAt: row.created_at,
    };
  }

  function mapTx(row) {
    return {
      id: row.id,
      customerId: row.customer_id,
      type: row.type,
      amount: Number(row.amount),
      goldPrice: Number(row.gold_price),
      goldAmount: Number(row.gold_amount),
      balanceAfter: Number(row.balance_after),
      operator: row.operator,
      description: row.description,
      date: row.date,
      timestamp: row.timestamp,
    };
  }

  function mapSms(row) {
    return {
      id: row.id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      mobile: row.mobile,
      text: row.text,
      status: row.status,
      date: row.date,
      timestamp: row.timestamp,
    };
  }

  /* ---------- FETCH ALL (called once at startup / refresh) ---------- */
  async function fetchAll() {
    const [customersRes, ledgerRes, settingsRes, smsRes] = await Promise.all([
      client
        .from("customers")
        .select("*")
        .order("created_at", { ascending: true }),
      client.from("ledger").select("*").order("timestamp", { ascending: true }),
      client.from("settings").select("*").eq("id", 1).single(),
      client
        .from("sms_logs")
        .select("*")
        .order("timestamp", { ascending: false }),
    ]);
    if (customersRes.error) throw customersRes.error;
    if (ledgerRes.error) throw ledgerRes.error;
    if (settingsRes.error) throw settingsRes.error;
    if (smsRes.error) throw smsRes.error;

    return {
      customers: (customersRes.data || []).map(mapCustomer),
      ledger: (ledgerRes.data || []).map(mapTx),
      settings: {
        businessName: settingsRes.data.business_name || "قلک طلایی",
        smsEnabled: !!settingsRes.data.sms_enabled,
      },
      goldPrice: Number(settingsRes.data.gold_price || 0),
      goldPriceUpdatedAt: settingsRes.data.gold_price_updated_at
        ? new Date(settingsRes.data.gold_price_updated_at).getTime()
        : 0,
      sms: (smsRes.data || []).map(mapSms),
    };
  }

  /* ---------- CUSTOMERS ---------- */
  async function insertCustomer(customer) {
    const { error } = await client.from("customers").insert({
      id: customer.id,
      full_name: customer.fullName,
      mobile: customer.mobile,
      national_code: customer.nationalCode,
      address: customer.address,
      description: customer.description,
      join_date: customer.joinDate,
      created_at: customer.createdAt,
    });
    if (error) throw error;
  }

  async function updateCustomer(id, data) {
    const { error } = await client
      .from("customers")
      .update({
        full_name: data.fullName,
        mobile: data.mobile,
        national_code: data.nationalCode,
        address: data.address,
        description: data.description,
      })
      .eq("id", id);
    if (error) throw error;
  }

  async function deleteCustomer(id) {
    // ledger + sms rows cascade/null automatically via FK constraints
    const { error } = await client.from("customers").delete().eq("id", id);
    if (error) throw error;
  }

  /* ---------- LEDGER ---------- */
  async function insertLedgerTx(tx) {
    const { error } = await client.from("ledger").insert({
      id: tx.id,
      customer_id: tx.customerId,
      type: tx.type,
      amount: tx.amount,
      gold_price: tx.goldPrice,
      gold_amount: tx.goldAmount,
      balance_after: tx.balanceAfter,
      operator: tx.operator,
      description: tx.description,
      date: tx.date,
      timestamp: tx.timestamp,
    });
    if (error) throw error;
  }

  /* ---------- SETTINGS / GOLD PRICE (single row, id = 1) ---------- */
  async function upsertSettings(partial) {
    const payload = { id: 1 };
    if (partial.businessName !== undefined)
      payload.business_name = partial.businessName;
    if (partial.smsEnabled !== undefined)
      payload.sms_enabled = partial.smsEnabled;
    if (partial.goldPrice !== undefined) payload.gold_price = partial.goldPrice;
    if (partial.goldPriceUpdatedAt !== undefined)
      payload.gold_price_updated_at = new Date(
        partial.goldPriceUpdatedAt
      ).toISOString();
    const { error } = await client.from("settings").upsert(payload);
    if (error) throw error;
  }

  /* ---------- SMS ---------- */
  async function insertSms(record) {
    const { error } = await client.from("sms_logs").insert({
      id: record.id,
      customer_id: record.customerId,
      customer_name: record.customerName,
      mobile: record.mobile,
      text: record.text,
      status: record.status,
      date: record.date,
      timestamp: record.timestamp,
    });
    if (error) throw error;
  }

  /* ---------- BACKUP / RESTORE ---------- */
  async function bulkImport(data) {
    if (Array.isArray(data.customers) && data.customers.length) {
      const rows = data.customers.map((c) => ({
        id: c.id,
        full_name: c.fullName,
        mobile: c.mobile,
        national_code: c.nationalCode,
        address: c.address,
        description: c.description,
        join_date: c.joinDate,
        created_at: c.createdAt,
      }));
      const { error } = await client.from("customers").upsert(rows);
      if (error) throw error;
    }
    if (Array.isArray(data.ledger) && data.ledger.length) {
      const rows = data.ledger.map((t) => ({
        id: t.id,
        customer_id: t.customerId,
        type: t.type,
        amount: t.amount,
        gold_price: t.goldPrice,
        gold_amount: t.goldAmount,
        balance_after: t.balanceAfter,
        operator: t.operator,
        description: t.description,
        date: t.date,
        timestamp: t.timestamp,
      }));
      const { error } = await client.from("ledger").upsert(rows);
      if (error) throw error;
    }
    if (data.settings || typeof data.goldPrice === "number") {
      await upsertSettings({
        businessName: data.settings && data.settings.businessName,
        smsEnabled: data.settings && data.settings.smsEnabled,
        goldPrice: data.goldPrice,
      });
    }
    if (Array.isArray(data.sms) && data.sms.length) {
      const rows = data.sms.map((s) => ({
        id: s.id,
        customer_id: s.customerId,
        customer_name: s.customerName,
        mobile: s.mobile,
        text: s.text,
        status: s.status,
        date: s.date,
        timestamp: s.timestamp,
      }));
      const { error } = await client.from("sms_logs").upsert(rows);
      if (error) throw error;
    }
  }

  async function clearAllData() {
    const nothingId = "__none__";
    await client.from("ledger").delete().neq("id", nothingId);
    await client.from("sms_logs").delete().neq("id", nothingId);
    await client.from("customers").delete().neq("id", nothingId);
    await client
      .from("settings")
      .update({
        business_name: "قلک طلایی",
        sms_enabled: true,
        gold_price: 0,
        gold_price_updated_at: null,
      })
      .eq("id", 1);
  }

  return {
    init,
    isReady,
    signIn,
    signOut,
    getSession,
    fetchAll,
    insertCustomer,
    updateCustomer,
    deleteCustomer,
    insertLedgerTx,
    upsertSettings,
    insertSms,
    bulkImport,
    clearAllData,
  };
})();

/* ============================================================
         2. AUTHENTICATION SERVICE
         ============================================================ */
const AuthenticationService = (() => {
  // Operators are now real Supabase Auth users (create them in the
  // Supabase Dashboard → Authentication → Users). Use an email shaped
  // like "<username>@goldenwallet.local" and set the operator's display
  // name in "User Metadata" as: { "full_name": "اپراتور یک" }
  let currentSession = null;

  function sessionFromSupabaseUser(user) {
    const uname = user.email ? user.email.split("@")[0] : "operator";
    const fullName =
      (user.user_metadata && user.user_metadata.full_name) || uname;
    return { username: uname, fullName, loginAt: new Date().toISOString() };
  }

  async function login(username, password) {
    const uname = (username || "").trim();
    try {
      const data = await DataService.signIn(uname, password);
      currentSession = sessionFromSupabaseUser(data.user);
      return { success: true, session: currentSession };
    } catch (e) {
      return { success: false, message: "نام کاربری یا رمز عبور اشتباه است." };
    }
  }

  async function logout() {
    await DataService.signOut();
    currentSession = null;
  }

  function currentUser() {
    return currentSession;
  }

  function isAuthenticated() {
    return !!currentSession;
  }

  // Called once at page load to see if Supabase already has a valid
  // session (kept alive by the Supabase SDK itself between reloads).
  async function restoreSession() {
    const session = await DataService.getSession();
    if (!session) return false;
    currentSession = sessionFromSupabaseUser(session.user);
    return true;
  }

  return { login, logout, currentUser, isAuthenticated, restoreSession };
})();

// /* ============================================================
//       3. GOLD PRICE SERVICE (API-ready architecture)
//       ============================================================ */
// const GoldPriceService = (() => {
//   function getCurrentPrice() {
//     return StorageService.get("goldPrice", 0);
//   }

//   function setCurrentPrice(price) {
//     const p = Number(price);
//     if (!p || p <= 0) throw new Error("قیمت طلا باید بزرگتر از صفر باشد.");
//     StorageService.set("goldPrice", p);
//     return p;
//   }

//   // Placeholder for future live API integration:
//   // async function fetchFromApi() { const res = await fetch('/api/gold-price'); ... }

//   return { getCurrentPrice, setCurrentPrice };
// })();

/* ============================================================
      3. GOLD PRICE SERVICE
   ============================================================ */

const GoldPriceService = (() => {
  const API_URL = "https://www.goldapi.io/api/XAU/USD";
  const API_KEY = "goldapi-e4110585dbd72ade27ab9e96ff9350d7-io";

  // فعلاً ثابت تا بعداً API دلار اضافه شود
  const DOLLAR_PRICE = 180000;

  // 12 ساعت
  const UPDATE_INTERVAL = 12 * 60 * 60 * 1000;

  function getCurrentPrice() {
    return StorageService.get("goldPrice", 0);
  }

  async function setCurrentPrice(price) {
    const p = Math.round(Number(price));

    if (p <= 0) {
      throw new Error("قیمت معتبر نیست.");
    }

    const updatedAt = Date.now();
    await DataService.upsertSettings({
      goldPrice: p,
      goldPriceUpdatedAt: updatedAt,
    });
    StorageService.set("goldPrice", p);
    StorageService.set("goldPriceUpdatedAt", updatedAt);

    return p;
  }

  function shouldUpdate() {
    const lastUpdate = StorageService.get("goldPriceUpdatedAt", 0);

    if (!lastUpdate) return true;

    return Date.now() - lastUpdate >= UPDATE_INTERVAL;
  }

  async function updatePrice(force = false) {
    // اگر مجبور به بروزرسانی نیستیم
    if (!force && !shouldUpdate()) {
      return getCurrentPrice();
    }

    try {
      const response = await fetch(API_URL, {
        method: "GET",
        headers: {
          "x-access-token": API_KEY,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!data.price) {
        throw new Error("Gold price not found.");
      }

      // قیمت اونس
      const ouncePrice = Number(data.price);

      // هر گرم طلای 24 عیار (تومان)
      const gram24 = (ouncePrice / 31.1034768) * DOLLAR_PRICE;

      // هر گرم طلای 18 عیار
      const gram18 = gram24 * 0.75;

      await setCurrentPrice(gram18);

      return gram18;
    } catch (error) {
      console.error("Gold API Error:", error);

      // اگر قبلاً قیمت ذخیره شده باشد همان را برگردان
      return getCurrentPrice();
    }
  }

  return {
    getCurrentPrice,
    setCurrentPrice,
    updatePrice,
  };
})();

/* ============================================================
         4. VALIDATION SERVICE
         ============================================================ */
const ValidationService = (() => {
  function validateCustomer({ fullName, mobile, nationalCode }) {
    if (!fullName || fullName.trim().length < 3)
      return "نام و نام خانوادگی باید حداقل ۳ حرف باشد.";
    if (!Utils.validMobile(mobile))
      return "شماره موبایل معتبر نیست (مثال: 09121234567).";
    if (!Utils.validNationalCode(nationalCode))
      return "کد ملی باید ۱۰ رقم باشد.";
    return null;
  }

  function validateAmount(amount) {
    if (isNaN(amount) || amount <= 0)
      return "مبلغ وارد شده باید عددی بزرگتر از صفر باشد.";
    return null;
  }

  function validateGoldPrice(price) {
    if (isNaN(price) || price <= 0) return "قیمت طلا باید بزرگتر از صفر باشد.";
    return null;
  }

  function validateWithdrawal(goldAmount, currentBalance) {
    if (goldAmount > currentBalance + 1e-9)
      return "موجودی طلای مشتری کافی نیست.";
    return null;
  }

  return {
    validateCustomer,
    validateAmount,
    validateGoldPrice,
    validateWithdrawal,
  };
})();

/* ============================================================
         5. CUSTOMER SERVICE
         ============================================================ */
const CustomerService = (() => {
  function getAll() {
    return StorageService.get("customers", []);
  }

  function save(list) {
    StorageService.set("customers", list);
  }

  function getById(id) {
    return getAll().find((c) => c.id === id) || null;
  }

  async function add(data) {
    const list = getAll();
    const customer = {
      id: Utils.uid("cust"),
      fullName: data.fullName.trim(),
      mobile: Utils.toEnDigits(data.mobile).trim(),
      nationalCode: Utils.toEnDigits(data.nationalCode).trim(),
      address: (data.address || "").trim(),
      description: (data.description || "").trim(),
      joinDate: Utils.formatJalaliDate(),
      createdAt: new Date().toISOString(),
    };
    await DataService.insertCustomer(customer);
    list.push(customer);
    save(list);
    return customer;
  }

  async function update(id, data) {
    const list = getAll();
    const idx = list.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error("مشتری یافت نشد.");
    const updated = {
      ...list[idx],
      fullName: data.fullName.trim(),
      mobile: Utils.toEnDigits(data.mobile).trim(),
      nationalCode: Utils.toEnDigits(data.nationalCode).trim(),
      address: (data.address || "").trim(),
      description: (data.description || "").trim(),
    };
    await DataService.updateCustomer(id, updated);
    list[idx] = updated;
    save(list);
    return list[idx];
  }

  async function remove(id) {
    await DataService.deleteCustomer(id); // DB cascades ledger/sms rows
    const list = getAll().filter((c) => c.id !== id);
    save(list);
    // mirror the cascade locally so the in-memory cache matches the DB
    const ledger = LedgerService.getAll().filter((t) => t.customerId !== id);
    LedgerService.saveAll(ledger);
  }

  function search(query) {
    const q = Utils.toEnDigits((query || "").trim().toLowerCase());
    if (!q) return getAll();
    return getAll().filter((c) => {
      return (
        c.fullName.toLowerCase().includes(query.trim().toLowerCase()) ||
        c.mobile.includes(q) ||
        c.nationalCode.includes(q)
      );
    });
  }

  function getBalance(customerId) {
    const txs = LedgerService.getByCustomer(customerId);
    if (txs.length === 0) return 0;
    return txs[txs.length - 1].balanceAfter;
  }

  function getTotals(customerId) {
    const txs = LedgerService.getByCustomer(customerId);
    let totalDeposit = 0,
      totalWithdraw = 0;
    txs.forEach((t) => {
      if (t.type === "deposit") totalDeposit += t.amount;
      else totalWithdraw += t.amount;
    });
    return {
      totalDeposit,
      totalWithdraw,
      lastTx: txs.length ? txs[txs.length - 1] : null,
    };
  }

  return {
    getAll,
    getById,
    add,
    update,
    remove,
    search,
    getBalance,
    getTotals,
  };
})();

/* ============================================================
         6. LEDGER SERVICE
         ============================================================ */
const LedgerService = (() => {
  function getAll() {
    return StorageService.get("ledger", []);
  }

  function saveAll(list) {
    StorageService.set("ledger", list);
  }

  function getByCustomer(customerId) {
    return getAll()
      .filter((t) => t.customerId === customerId)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  async function recordDeposit({ customerId, amount, description, operator }) {
    const price = GoldPriceService.getCurrentPrice();
    const goldAmount = Number((amount / price).toFixed(4));
    const prevBalance = CustomerService.getBalance(customerId);
    const balanceAfter = Number((prevBalance + goldAmount).toFixed(4));
    const tx = {
      id: Utils.uid("tx"),
      customerId,
      type: "deposit",
      amount,
      goldPrice: price,
      goldAmount,
      balanceAfter,
      operator,
      description: description || "-",
      date: Utils.formatJalaliDate(),
      timestamp: new Date().toISOString(),
    };
    await DataService.insertLedgerTx(tx);
    const list = getAll();
    list.push(tx);
    saveAll(list);
    return tx;
  }

  async function recordWithdrawal({
    customerId,
    amount,
    description,
    operator,
  }) {
    const price = GoldPriceService.getCurrentPrice();
    const goldAmount = Number((amount / price).toFixed(4));
    const prevBalance = CustomerService.getBalance(customerId);
    const err = ValidationService.validateWithdrawal(goldAmount, prevBalance);
    if (err) throw new Error(err);
    const balanceAfter = Number((prevBalance - goldAmount).toFixed(4));
    const tx = {
      id: Utils.uid("tx"),
      customerId,
      type: "withdraw",
      amount,
      goldPrice: price,
      goldAmount,
      balanceAfter,
      operator,
      description: description || "-",
      date: Utils.formatJalaliDate(),
      timestamp: new Date().toISOString(),
    };
    await DataService.insertLedgerTx(tx);
    const list = getAll();
    list.push(tx);
    saveAll(list);
    return tx;
  }

  function recentActivity(limit = 8) {
    return [...getAll()]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  function totalsForDate(dateStr) {
    const txs = getAll().filter((t) => t.date === dateStr);
    let deposit = 0,
      withdraw = 0;
    txs.forEach((t) =>
      t.type === "deposit" ? (deposit += t.amount) : (withdraw += t.amount)
    );
    return { deposit, withdraw };
  }

  return {
    getAll,
    saveAll,
    getByCustomer,
    recordDeposit,
    recordWithdrawal,
    recentActivity,
    totalsForDate,
  };
})();

/* ============================================================
         7. SMS SERVICE (preview only — API-ready)
         ============================================================ */
const SMSService = (() => {
  function getAll() {
    return StorageService.get("sms", []);
  }

  function buildDepositMessage(customerName, tx) {
    return `مشتری گرامی ${customerName}\nمبلغ ${Utils.formatToman(
      tx.amount
    )} به قلک طلایی شما اضافه شد.\nطلای خریداری شده: ${Utils.formatGram(
      tx.goldAmount
    )}\nموجودی فعلی: ${Utils.formatGram(tx.balanceAfter)}`;
  }

  function buildWithdrawMessage(customerName, tx) {
    return `مشتری گرامی ${customerName}\nمبلغ ${Utils.formatToman(
      tx.amount
    )} از حساب شما برداشت شد.\nموجودی فعلی: ${Utils.formatGram(
      tx.balanceAfter
    )}`;
  }

  async function log(customer, tx, text) {
    const settings = StorageService.get("settings", {});
    const record = {
      id: Utils.uid("sms"),
      customerId: customer.id,
      customerName: customer.fullName,
      mobile: customer.mobile,
      text,
      status: settings.smsEnabled ? "ارسال شده (نمایشی)" : "غیرفعال",
      date: Utils.formatJalaliDate(),
      timestamp: new Date().toISOString(),
    };
    await DataService.insertSms(record);
    const list = getAll();
    list.push(record);
    StorageService.set("sms", list);
  }

  // Placeholder for future SMS API integration:
  // async function sendViaApi(mobile, text) { return fetch('/api/sms/send', {...}); }

  return { buildDepositMessage, buildWithdrawMessage, log, getAll };
})();

/* ============================================================
         8. REPORT SERVICE
         ============================================================ */
const ReportService = (() => {
  function summary() {
    const customers = CustomerService.getAll();
    const ledger = LedgerService.getAll();
    const today = Utils.formatJalaliDate();

    let totalBalance = 0;
    customers.forEach(
      (c) => (totalBalance += CustomerService.getBalance(c.id))
    );

    let totalSoldGold = 0; // total gold given out to customers via deposits (sold)
    let totalWithdrawnGold = 0;
    let todayDeposit = 0,
      todayWithdraw = 0;

    ledger.forEach((t) => {
      if (t.type === "deposit") totalSoldGold += t.goldAmount;
      else totalWithdrawnGold += t.goldAmount;
      if (t.date === today) {
        if (t.type === "deposit") todayDeposit += t.amount;
        else todayWithdraw += t.amount;
      }
    });

    return {
      customerCount: customers.length,
      totalBalance,
      todayDeposit,
      todayWithdraw,
      totalSoldGold,
      totalWithdrawnGold,
      totalTransactions: ledger.length,
    };
  }

  function groupByRange(range) {
    const ledger = LedgerService.getAll();
    const groups = {};
    ledger.forEach((t) => {
      const faParts = Utils.toEnDigits(t.date).split("/"); // [jy, jm, jd]
      let key;
      if (range === "daily") key = t.date;
      else if (range === "monthly") key = `${faParts[0]}/${faParts[1]}`;
      else key = faParts[0];
      if (!groups[key])
        groups[key] = {
          depositCount: 0,
          depositSum: 0,
          withdrawCount: 0,
          withdrawSum: 0,
          netGold: 0,
        };
      if (t.type === "deposit") {
        groups[key].depositCount++;
        groups[key].depositSum += t.amount;
        groups[key].netGold += t.goldAmount;
      } else {
        groups[key].withdrawCount++;
        groups[key].withdrawSum += t.amount;
        groups[key].netGold -= t.goldAmount;
      }
    });
    return Object.entries(groups)
      .map(([key, val]) => ({ key, ...val }))
      .sort((a, b) =>
        Utils.toEnDigits(b.key).localeCompare(Utils.toEnDigits(a.key))
      );
  }

  function topCustomers(limit = 5) {
    const customers = CustomerService.getAll();
    const ledger = LedgerService.getAll();
    const counts = {};
    ledger.forEach((t) => {
      counts[t.customerId] = (counts[t.customerId] || 0) + 1;
    });
    return customers
      .map((c) => ({
        customer: c,
        txCount: counts[c.id] || 0,
        balance: CustomerService.getBalance(c.id),
      }))
      .sort((a, b) => b.txCount - a.txCount)
      .slice(0, limit);
  }

  function last7DaysTrend() {
    const ledger = LedgerService.getAll();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(Utils.formatJalaliDate(d));
    }
    return days.map((dateStr) => {
      let deposit = 0,
        withdraw = 0;
      ledger.forEach((t) => {
        if (t.date === dateStr) {
          t.type === "deposit" ? (deposit += t.amount) : (withdraw += t.amount);
        }
      });
      return { date: dateStr, deposit, withdraw };
    });
  }

  function monthlyDepositWithdraw(monthsBack = 6) {
    const groups = groupByRange("monthly").slice(0, monthsBack).reverse();
    return groups;
  }

  function customerGrowth() {
    const customers = [...CustomerService.getAll()].sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    );
    let running = 0;
    return customers.map((c) => {
      running++;
      return { date: c.joinDate, count: running };
    });
  }

  return {
    summary,
    groupByRange,
    topCustomers,
    last7DaysTrend,
    monthlyDepositWithdraw,
    customerGrowth,
  };
})();

/* ============================================================
         9. UI HELPERS — Toasts / Confirm / Modal Manager
         ============================================================ */
const ToastManager = (() => {
  const container = () => document.getElementById("toastContainer");

  function show(message, type = "info") {
    const icons = { success: "✅", error: "⛔", info: "ℹ️" };
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-ico">${
      icons[type] || icons.info
    }</span><span>${Utils.escapeHtml(message)}</span>`;
    container().appendChild(el);
    setTimeout(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), 260);
    }, 3200);
  }

  return { show };
})();

const ModalManager = (() => {
  let confirmResolver = null;

  function confirm(
    message,
    { title = "آیا مطمئن هستید؟", okText = "تایید" } = {}
  ) {
    return new Promise((resolve) => {
      confirmResolver = resolve;
      document.getElementById("confirmTitle").textContent = title;
      document.getElementById("confirmMessage").textContent = message;
      document.getElementById("confirmOkBtn").textContent = okText;
      document.getElementById("confirmOverlay").classList.remove("hidden");
    });
  }

  function closeConfirm(result) {
    document.getElementById("confirmOverlay").classList.add("hidden");
    if (confirmResolver) {
      confirmResolver(result);
      confirmResolver = null;
    }
  }

  function open(id) {
    document.getElementById(id).classList.remove("hidden");
  }
  function close(id) {
    document.getElementById(id).classList.add("hidden");
  }

  function init() {
    document
      .getElementById("confirmCancelBtn")
      .addEventListener("click", () => closeConfirm(false));
    document
      .getElementById("confirmOkBtn")
      .addEventListener("click", () => closeConfirm(true));
    document.getElementById("confirmOverlay").addEventListener("click", (e) => {
      if (e.target.id === "confirmOverlay") closeConfirm(false);
    });
  }

  return { confirm, open, close, init };
})();

/* ============================================================
         10. STATE MANAGER — app-wide state + section navigation
         ============================================================ */
const StateManager = (() => {
  let state = {
    activeSection: "dashboard",
    activeLedgerCustomerId: null,
  };

  function get(key) {
    return state[key];
  }
  function set(key, value) {
    state[key] = value;
  }

  return { get, set };
})();

/* ============================================================
         11. UI RENDERER — builds all dynamic DOM content
         ============================================================ */
const UIRenderer = (() => {
  function renderStatCards() {
    const s = ReportService.summary();
    const cards = [
      {
        ico: "👥",
        label: "تعداد مشتریان",
        value: Utils.formatNumber(s.customerCount),
        cls: "",
      },
      {
        ico: "🏆",
        label: "مجموع موجودی طلای مشتریان",
        value: Utils.formatGram(s.totalBalance),
        cls: "gold-text",
      },
      {
        ico: "💰",
        label: "مجموع واریزی امروز",
        value: Utils.formatToman(s.todayDeposit),
        cls: "success-text",
      },
      {
        ico: "💸",
        label: "مجموع برداشت امروز",
        value: Utils.formatToman(s.todayWithdraw),
        cls: "danger-text",
      },
      {
        ico: "🥇",
        label: "کل طلای فروخته‌شده",
        value: Utils.formatGram(s.totalSoldGold),
        cls: "gold-text",
      },
      {
        ico: "🧾",
        label: "کل تراکنش‌ها",
        value: Utils.formatNumber(s.totalTransactions),
        cls: "",
      },
    ];
    document.getElementById("statGrid").innerHTML = cards
      .map(
        (c) => `
            <div class="stat-card glass">
              <div class="stat-ico">${c.ico}</div>
              <div class="stat-label">${c.label}</div>
              <div class="stat-value ${c.cls}">${c.value}</div>
            </div>
          `
      )
      .join("");

    // report page mirrors same stats
    const reportGrid = document.getElementById("reportStatGrid");
    if (reportGrid)
      reportGrid.innerHTML = document.getElementById("statGrid").innerHTML;
  }

  function renderRecentActivity() {
    const rows = LedgerService.recentActivity(8);
    const tbody = document.querySelector("#recentActivityTable tbody");
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-2);padding:26px;">هنوز تراکنشی ثبت نشده است.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map((t) => {
        const cust = CustomerService.getById(t.customerId);
        const badge =
          t.type === "deposit"
            ? `<span class="badge badge-deposit">واریز</span>`
            : `<span class="badge badge-withdraw">برداشت</span>`;
        return `<tr>
              <td>${t.date}</td>
              <td>${Utils.escapeHtml(cust ? cust.fullName : "حذف شده")}</td>
              <td>${badge}</td>
              <td>${Utils.formatNumber(t.amount)}</td>
              <td>${Utils.formatGram(t.goldAmount)}</td>
              <td>${Utils.escapeHtml(t.operator)}</td>
            </tr>`;
      })
      .join("");
  }

  function renderCustomersTable() {
    const searchVal = document.getElementById("customerSearchInput").value;
    const sortVal = document.getElementById("customerSortSelect").value;
    let list = CustomerService.search(searchVal);

    if (sortVal === "name")
      list = [...list].sort((a, b) =>
        a.fullName.localeCompare(b.fullName, "fa")
      );
    else if (sortVal === "balance")
      list = [...list].sort(
        (a, b) =>
          CustomerService.getBalance(b.id) - CustomerService.getBalance(a.id)
      );
    else
      list = [...list].sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      );

    const tbody = document.querySelector("#customersTable tbody");
    const emptyState = document.getElementById("customersEmptyState");

    if (list.length === 0) {
      tbody.innerHTML = "";
      emptyState.classList.remove("hidden");
      emptyState.innerHTML = `<div class="empty-illustration">🗂️</div><h3>مشتری‌ای یافت نشد</h3><p>می‌توانید یک مشتری جدید اضافه کنید یا عبارت جستجو را تغییر دهید.</p>`;
      return;
    }
    emptyState.classList.add("hidden");

    tbody.innerHTML = list
      .map(
        (c) => `
            <tr>
              <td>${Utils.escapeHtml(c.fullName)}</td>
              <td>${Utils.toFaDigits(c.mobile)}</td>
              <td>${Utils.toFaDigits(c.nationalCode)}</td>
              <td>${c.joinDate}</td>
              <td>${Utils.formatGram(CustomerService.getBalance(c.id))}</td>
              <td>
               <div class="row-actions">
               <button class="icon-btn" title="دفتر حساب" data-action="ledger" data-id="${
                 c.id
               }">
                 <i class="fas fa-book"></i>
               </button>
               <button class="icon-btn" title="ویرایش" data-action="edit" data-id="${
                 c.id
               }">
                 <i class="fas fa-pen"></i>
               </button>
               <button class="icon-btn danger" title="حذف" data-action="delete" data-id="${
                 c.id
               }">
                 <i class="fas fa-trash"></i>
               </button>
               </div>
              </td>
            </tr>
          `
      )
      .join("");
  }

  function customerOptionsHtml() {
    const list = [...CustomerService.getAll()].sort((a, b) =>
      a.fullName.localeCompare(b.fullName, "fa")
    );
    if (list.length === 0)
      return `<option value="">-- ابتدا مشتری اضافه کنید --</option>`;
    return (
      `<option value="">-- انتخاب مشتری --</option>` +
      list
        .map(
          (c) =>
            `<option value="${c.id}">${Utils.escapeHtml(
              c.fullName
            )} (${Utils.toFaDigits(c.mobile)})</option>`
        )
        .join("")
    );
  }

  function renderDepositWithdrawSelects() {
    document.getElementById("depositCustomerSelect").innerHTML =
      customerOptionsHtml();
    document.getElementById("withdrawCustomerSelect").innerHTML =
      customerOptionsHtml();
  }

  function renderSidebarGoldPrice() {
    const price = GoldPriceService.getCurrentPrice();
    const text = price > 0 ? Utils.formatToman(price) : "ثبت نشده";
    document.getElementById("sidebarGoldPrice").textContent = text;
  }

  function renderLedgerEmpty() {
    document.getElementById("ledgerNoCustomer").classList.remove("hidden");
    document.getElementById("ledgerContent").classList.add("hidden");
  }

  function renderLedgerForCustomer(customerId) {
    const cust = CustomerService.getById(customerId);
    if (!cust) {
      renderLedgerEmpty();
      return;
    }

    document.getElementById("ledgerNoCustomer").classList.add("hidden");
    document.getElementById("ledgerContent").classList.remove("hidden");

    document.getElementById("ledgerAvatar").textContent =
      cust.fullName.trim().charAt(0) || "?";
    document.getElementById("ledgerCustomerName").textContent = cust.fullName;
    document.getElementById("ledgerCustomerMobile").textContent =
      Utils.toFaDigits(cust.mobile);
    document.getElementById("ledgerNationalCode").textContent =
      Utils.toFaDigits(cust.nationalCode);
    document.getElementById("ledgerJoinDate").textContent = cust.joinDate;
    document.getElementById("ledgerAddress").textContent = cust.address || "—";

    const balance = CustomerService.getBalance(cust.id);
    document.getElementById("ledgerBalanceValue").textContent =
      Utils.formatGram(balance);

    const totals = CustomerService.getTotals(cust.id);
    document.getElementById("ledgerTotalDeposit").textContent =
      Utils.formatToman(totals.totalDeposit);
    document.getElementById("ledgerTotalWithdraw").textContent =
      Utils.formatToman(totals.totalWithdraw);
    document.getElementById("ledgerLastTx").textContent = totals.lastTx
      ? totals.lastTx.date
      : "—";

    const txs = LedgerService.getByCustomer(cust.id).slice().reverse();
    const tbody = document.getElementById("ledgerTableBody");
    if (txs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-2);padding:26px;">هنوز تراکنشی برای این مشتری ثبت نشده است.</td></tr>`;
      return;
    }
    tbody.innerHTML = txs
      .map((t) => {
        const badge =
          t.type === "deposit"
            ? `<span class="badge badge-deposit">واریز</span>`
            : `<span class="badge badge-withdraw">برداشت</span>`;
        return `<tr>
              <td>${t.date}</td>
              <td>${badge}</td>
              <td>${Utils.formatNumber(t.amount)}</td>
              <td>${Utils.formatNumber(t.goldPrice)}</td>
              <td>${Utils.formatGram(t.goldAmount)}</td>
              <td>${Utils.formatGram(t.balanceAfter)}</td>
              <td>${Utils.escapeHtml(t.operator)}</td>
              <td>${Utils.escapeHtml(t.description)}</td>
            </tr>`;
      })
      .join("");
  }

  function renderReportsPage() {
    const range = document.getElementById("reportRangeSelect").value;
    const groups = ReportService.groupByRange(range);
    const tbody = document.querySelector("#reportTable tbody");
    if (groups.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-2);padding:26px;">داده‌ای برای نمایش وجود ندارد.</td></tr>`;
    } else {
      tbody.innerHTML = groups
        .map(
          (g) => `
              <tr>
                <td>${Utils.toFaDigits(g.key)}</td>
                <td>${Utils.formatNumber(g.depositCount)}</td>
                <td>${Utils.formatToman(g.depositSum)}</td>
                <td>${Utils.formatNumber(g.withdrawCount)}</td>
                <td>${Utils.formatToman(g.withdrawSum)}</td>
                <td>${Utils.formatGram(g.netGold)}</td>
              </tr>
            `
        )
        .join("");
    }

    const top = ReportService.topCustomers(5);
    const topBody = document.querySelector("#topCustomersTable tbody");
    if (top.length === 0 || top.every((t) => t.txCount === 0)) {
      topBody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-2);padding:26px;">هنوز داده‌ای وجود ندارد.</td></tr>`;
    } else {
      topBody.innerHTML = top
        .map(
          (t, i) => `
              <tr>
                <td>${Utils.toFaDigits(i + 1)}</td>
                <td>${Utils.escapeHtml(t.customer.fullName)}</td>
                <td>${Utils.formatNumber(t.txCount)}</td>
                <td>${Utils.formatGram(t.balance)}</td>
              </tr>
            `
        )
        .join("");
    }
  }

  function renderSmsTable() {
    const list = [...SMSService.getAll()].sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    );
    const tbody = document.querySelector("#smsTable tbody");
    const emptyState = document.getElementById("smsEmptyState");
    if (list.length === 0) {
      tbody.innerHTML = "";
      emptyState.classList.remove("hidden");
      emptyState.innerHTML = `<div class="empty-illustration">📭</div><h3>پیامکی ارسال نشده</h3><p>پس از ثبت واریز یا برداشت، پیش‌نمایش پیامک اینجا نمایش داده می‌شود.</p>`;
      return;
    }
    emptyState.classList.add("hidden");
    tbody.innerHTML = list
      .map(
        (s) => `
            <tr>
              <td>${s.date}</td>
              <td>${Utils.escapeHtml(s.customerName)}</td>
              <td>${Utils.toFaDigits(s.mobile)}</td>
              <td style="white-space:normal;max-width:320px;">${Utils.escapeHtml(
                s.text
              ).replace(/\n/g, "<br>")}</td>
              <td>${Utils.escapeHtml(s.status)}</td>
            </tr>
          `
      )
      .join("");
  }

  function renderSettingsPage() {
    const price = GoldPriceService.getCurrentPrice();
    document.getElementById("settingsGoldPriceInput").value =
      price > 0 ? Utils.formatNumber(price) : "";
    const settings = StorageService.get("settings", {
      businessName: "قلک طلایی",
      smsEnabled: true,
    });
    document.getElementById("settingsBusinessNameInput").value =
      settings.businessName || "";
    document.getElementById("settingsSmsToggle").checked =
      !!settings.smsEnabled;
  }

  function renderOperatorBadge() {
    const user = AuthenticationService.currentUser();
    if (user)
      document.getElementById("operatorNameDisplay").textContent =
        user.fullName;
  }

  function renderBusinessName() {
    const settings = StorageService.get("settings", {});
    document.getElementById("businessNameDisplay").textContent =
      settings.businessName || "قلک طلایی";
  }

  function refreshDashboard() {
    renderStatCards();
    renderRecentActivity();
    ChartRenderer.renderTrendChart();
    ChartRenderer.renderPieChart();
  }

  function refreshAll() {
    renderSidebarGoldPrice();
    renderBusinessName();
    renderOperatorBadge();
    refreshDashboard();
    renderCustomersTable();
    renderDepositWithdrawSelects();
  }

  return {
    renderStatCards,
    renderRecentActivity,
    renderCustomersTable,
    renderDepositWithdrawSelects,
    renderSidebarGoldPrice,
    renderLedgerEmpty,
    renderLedgerForCustomer,
    renderReportsPage,
    renderSmsTable,
    renderSettingsPage,
    renderOperatorBadge,
    renderBusinessName,
    refreshDashboard,
    refreshAll,
    customerOptionsHtml,
  };
})();

/* ============================================================
         12. CHART RENDERER — pure Canvas 2D, no libraries
         ============================================================ */
const ChartRenderer = (() => {
  function setupCanvas(canvas) {
    const ctx = canvas.getContext("2d");
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth;
    const cssHeight = canvas.height
      ? Number(canvas.getAttribute("height"))
      : 220;
    canvas.width = cssWidth * ratio;
    canvas.height = cssHeight * ratio;
    canvas.style.width = cssWidth + "px";
    canvas.style.height = cssHeight + "px";
    ctx.scale(ratio, ratio);
    return { ctx, width: cssWidth, height: cssHeight };
  }

  function renderTrendChart() {
    const canvas = document.getElementById("trendChart");
    if (!canvas) return;
    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const data = ReportService.last7DaysTrend();
    const padding = { top: 16, right: 16, bottom: 30, left: 10 };
    const maxVal = Math.max(
      1,
      ...data.map((d) => Math.max(d.deposit, d.withdraw))
    );
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;
    const stepX = chartW / (data.length - 1 || 1);

    // grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = padding.top + (chartH / 3) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
    }

    function drawLine(key, color) {
      ctx.beginPath();
      data.forEach((d, i) => {
        const x = padding.left + stepX * i;
        const y = padding.top + chartH - (d[key] / maxVal) * chartH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.stroke();

      data.forEach((d, i) => {
        const x = padding.left + stepX * i;
        const y = padding.top + chartH - (d[key] / maxVal) * chartH;
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      });
    }

    drawLine("deposit", "#22C55E");
    drawLine("withdraw", "#EF4444");

    // x labels
    ctx.fillStyle = "#9CA3AF";
    ctx.font = "11px Vazirmatn, sans-serif";
    ctx.textAlign = "center";
    data.forEach((d, i) => {
      const x = padding.left + stepX * i;
      const label = Utils.toFaDigits(
        Utils.toEnDigits(d.date).split("/").slice(1).join("/")
      );
      ctx.fillText(label, x, height - 10);
    });

    // legend
    ctx.textAlign = "right";
    ctx.fillStyle = "#22C55E";
    ctx.fillText("● واریز", width - 16, 14);
    ctx.fillStyle = "#EF4444";
    ctx.fillText("● برداشت", width - 80, 14);
  }

  function renderPieChart() {
    const canvas = document.getElementById("pieChart");
    if (!canvas) return;
    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const ledger = LedgerService.getAll();
    const deposits = ledger.filter((t) => t.type === "deposit").length;
    const withdrawals = ledger.filter((t) => t.type === "withdraw").length;
    const total = deposits + withdrawals;

    const cx = width / 2 - 50,
      cy = height / 2,
      r = Math.min(height, width / 2) / 2.4;

    if (total === 0) {
      ctx.fillStyle = "#9CA3AF";
      ctx.font = "13px Vazirmatn, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("داده‌ای برای نمایش وجود ندارد", width / 2, height / 2);
      return;
    }

    const slices = [
      { label: "واریز", value: deposits, color: "#22C55E" },
      { label: "برداشت", value: withdrawals, color: "#EF4444" },
    ];
    let start = -Math.PI / 2;
    slices.forEach((s) => {
      const angle = (s.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, start, start + angle);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
      start += angle;
    });

    // donut hole
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = "#171b22";
    ctx.fill();

    // legend
    ctx.textAlign = "right";
    ctx.font = "12px Vazirmatn, sans-serif";
    let ly = cy - 20;
    slices.forEach((s) => {
      ctx.fillStyle = s.color;
      ctx.fillRect(width - 40, ly - 8, 10, 10);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(`${s.label} (${Utils.toFaDigits(s.value)})`, width - 54, ly);
      ly += 24;
    });
  }

  function renderGrowthChart() {
    const canvas = document.getElementById("growthChart");
    if (!canvas) return;
    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const data = ReportService.customerGrowth();
    const padding = { top: 16, right: 16, bottom: 30, left: 10 };
    if (data.length === 0) {
      ctx.fillStyle = "#9CA3AF";
      ctx.font = "13px Vazirmatn, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("هنوز مشتری‌ای ثبت نشده است", width / 2, height / 2);
      return;
    }
    const maxVal = Math.max(1, ...data.map((d) => d.count));
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;
    const stepX = chartW / Math.max(data.length - 1, 1);

    ctx.beginPath();
    data.forEach((d, i) => {
      const x = padding.left + stepX * i;
      const y = padding.top + chartH - (d.count / maxVal) * chartH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(
      padding.left + stepX * (data.length - 1),
      height - padding.bottom
    );
    ctx.lineTo(padding.left, height - padding.bottom);
    ctx.closePath();
    const grad = ctx.createLinearGradient(
      0,
      padding.top,
      0,
      height - padding.bottom
    );
    grad.addColorStop(0, "rgba(212,175,55,0.35)");
    grad.addColorStop(1, "rgba(212,175,55,0.02)");
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    data.forEach((d, i) => {
      const x = padding.left + stepX * i;
      const y = padding.top + chartH - (d.count / maxVal) * chartH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#D4AF37";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  function renderBarChart() {
    const canvas = document.getElementById("barChart");
    if (!canvas) return;
    const { ctx, width, height } = setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    const groups = ReportService.monthlyDepositWithdraw(6);
    const padding = { top: 16, right: 16, bottom: 30, left: 10 };
    if (groups.length === 0) {
      ctx.fillStyle = "#9CA3AF";
      ctx.font = "13px Vazirmatn, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("داده‌ای برای نمایش وجود ندارد", width / 2, height / 2);
      return;
    }
    const maxVal = Math.max(
      1,
      ...groups.map((g) => Math.max(g.depositSum, g.withdrawSum))
    );
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;
    const groupW = chartW / groups.length;
    const barW = Math.min(22, groupW / 3);

    groups.forEach((g, i) => {
      const gx = padding.left + groupW * i + groupW / 2;
      const depH = (g.depositSum / maxVal) * chartH;
      const witH = (g.withdrawSum / maxVal) * chartH;
      ctx.fillStyle = "#22C55E";
      ctx.fillRect(gx - barW - 3, padding.top + chartH - depH, barW, depH);
      ctx.fillStyle = "#EF4444";
      ctx.fillRect(gx + 3, padding.top + chartH - witH, barW, witH);
      ctx.fillStyle = "#9CA3AF";
      ctx.font = "10.5px Vazirmatn, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(Utils.toFaDigits(g.key), gx, height - 10);
    });
  }

  return {
    renderTrendChart,
    renderPieChart,
    renderGrowthChart,
    renderBarChart,
  };
})();

/* ============================================================
         13. NUMBER INPUT MASKING (live comma formatting)
         ============================================================ */
function attachNumberMask(input) {
  input.addEventListener("input", () => {
    const raw = Utils.parseNumber(input.value);
    if (isNaN(raw)) {
      input.value = "";
      return;
    }
    const caretFromEnd = input.value.length - input.selectionStart;
    input.value = Utils.formatNumber(raw, 0);
    const pos = Math.max(input.value.length - caretFromEnd, 0);
    input.setSelectionRange(pos, pos);
  });
}

/* ============================================================
         14. EVENT MANAGER — wires up all DOM interactions
         ============================================================ */
const EventManager = (() => {
  function switchSection(section) {
    StateManager.set("activeSection", section);
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.section === section);
    });
    document
      .querySelectorAll(".page")
      .forEach((p) => p.classList.remove("active"));
    document.getElementById(`page-${section}`).classList.add("active");

    if (section === "dashboard") UIRenderer.refreshDashboard();
    if (section === "customers") UIRenderer.renderCustomersTable();
    if (section === "deposit") UIRenderer.renderDepositWithdrawSelects();
    if (section === "withdraw") UIRenderer.renderDepositWithdrawSelects();
    if (section === "reports") UIRenderer.renderReportsPage();
    if (section === "sms") UIRenderer.renderSmsTable();
    if (section === "settings") UIRenderer.renderSettingsPage();
    if (section === "stats") {
      ChartRenderer.renderGrowthChart();
      ChartRenderer.renderBarChart();
    }
    if (section === "ledger") {
      const id = StateManager.get("activeLedgerCustomerId");
      if (id) UIRenderer.renderLedgerForCustomer(id);
      else UIRenderer.renderLedgerEmpty();
    }

    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("contentArea").scrollTop = 0;
  }

  function openLedgerFor(customerId) {
    StateManager.set("activeLedgerCustomerId", customerId);
    switchSection("ledger");
  }

  function initLogin() {
    document
      .getElementById("loginForm")
      .addEventListener("submit", async (e) => {
        e.preventDefault();
        const submitBtn = document.querySelector(
          "#loginForm button[type='submit']"
        );
        const username = document.getElementById("loginUsername").value.trim();
        const password = document.getElementById("loginPassword").value;
        const errorEl = document.getElementById("loginError");
        errorEl.textContent = "";
        submitBtn.disabled = true;
        try {
          const result = await AuthenticationService.login(username, password);
          if (!result.success) {
            errorEl.textContent = result.message;
            return;
          }
          document.getElementById("loginForm").reset();
          await startApp();
        } catch (ex) {
          errorEl.textContent =
            "خطا در اتصال به سرور. اتصال اینترنت را بررسی کنید.";
          console.error(ex);
        } finally {
          submitBtn.disabled = false;
        }
      });

    document.getElementById("logoutBtn").addEventListener("click", async () => {
      await AuthenticationService.logout();
      StorageService.clearCache();
      document.getElementById("appShell").classList.add("hidden");
      document.getElementById("loginScreen").classList.remove("hidden");
    });
  }

  function initNav() {
    document.getElementById("sidebarNav").addEventListener("click", (e) => {
      const btn = e.target.closest(".nav-item");
      if (!btn) return;
      switchSection(btn.dataset.section);
    });
    document.getElementById("hamburgerBtn").addEventListener("click", () => {
      document.getElementById("sidebar").classList.toggle("open");
    });
    document.addEventListener("click", (e) => {
      const gotoBtn = e.target.closest("[data-goto]");
      if (gotoBtn) switchSection(gotoBtn.dataset.goto);
    });
  }

  function initGlobalSearch() {
    const input = document.getElementById("globalSearchInput");
    const box = document.getElementById("searchResultsBox");
    input.addEventListener("input", () => {
      const q = input.value.trim();
      if (!q) {
        box.classList.add("hidden");
        box.innerHTML = "";
        return;
      }
      const results = CustomerService.search(q).slice(0, 8);
      if (results.length === 0) {
        box.innerHTML = `<div class="search-empty">مشتری‌ای یافت نشد</div>`;
      } else {
        box.innerHTML = results
          .map(
            (c) => `
                <div class="search-result-item" data-id="${c.id}">
                  <div><strong>${Utils.escapeHtml(
                    c.fullName
                  )}</strong><span>${Utils.toFaDigits(
              c.mobile
            )} — کد ملی ${Utils.toFaDigits(c.nationalCode)}</span></div>
                  <span>${Utils.formatGram(
                    CustomerService.getBalance(c.id)
                  )}</span>
                </div>
              `
          )
          .join("");
      }
      box.classList.remove("hidden");
    });
    box.addEventListener("click", (e) => {
      const item = e.target.closest(".search-result-item");
      if (!item) return;
      openLedgerFor(item.dataset.id);
      input.value = "";
      box.classList.add("hidden");
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".global-search")) box.classList.add("hidden");
    });
  }

  /* ---------- Customers ---------- */
  function openCustomerModal(customer = null) {
    const form = document.getElementById("customerForm");
    form.reset();
    document.getElementById("customerFormError").textContent = "";
    document.getElementById("customerIdInput").value = customer
      ? customer.id
      : "";
    document.getElementById("customerModalTitle").textContent = customer
      ? "ویرایش مشتری"
      : "افزودن مشتری جدید";
    document.getElementById("customerFullNameInput").value = customer
      ? customer.fullName
      : "";
    document.getElementById("customerMobileInput").value = customer
      ? Utils.toFaDigits(customer.mobile)
      : "";
    document.getElementById("customerNationalCodeInput").value = customer
      ? Utils.toFaDigits(customer.nationalCode)
      : "";
    document.getElementById("customerAddressInput").value = customer
      ? customer.address
      : "";
    document.getElementById("customerDescInput").value = customer
      ? customer.description
      : "";
    ModalManager.open("customerModalOverlay");
  }

  function initCustomerModule() {
    document
      .getElementById("addCustomerBtn")
      .addEventListener("click", () => openCustomerModal());
    document
      .getElementById("customerModalClose")
      .addEventListener("click", () =>
        ModalManager.close("customerModalOverlay")
      );
    document
      .getElementById("customerCancelBtn")
      .addEventListener("click", () =>
        ModalManager.close("customerModalOverlay")
      );

    document
      .getElementById("customerForm")
      .addEventListener("submit", async (e) => {
        e.preventDefault();
        const id = document.getElementById("customerIdInput").value;
        const data = {
          fullName: document.getElementById("customerFullNameInput").value,
          mobile: document.getElementById("customerMobileInput").value,
          nationalCode: document.getElementById("customerNationalCodeInput")
            .value,
          address: document.getElementById("customerAddressInput").value,
          description: document.getElementById("customerDescInput").value,
        };
        const err = ValidationService.validateCustomer(data);
        const errorEl = document.getElementById("customerFormError");
        if (err) {
          errorEl.textContent = err;
          return;
        }
        errorEl.textContent = "";
        const saveBtn = document.getElementById("customerSaveBtn");
        saveBtn.disabled = true;

        try {
          if (id) {
            await CustomerService.update(id, data);
            ToastManager.show("اطلاعات مشتری با موفقیت ویرایش شد.", "success");
          } else {
            await CustomerService.add(data);
            ToastManager.show("مشتری جدید با موفقیت افزوده شد.", "success");
          }
          ModalManager.close("customerModalOverlay");
          UIRenderer.renderCustomersTable();
          UIRenderer.renderDepositWithdrawSelects();
          UIRenderer.renderStatCards();
        } catch (ex) {
          errorEl.textContent = ex.message || "خطا در ارتباط با سرور.";
        } finally {
          saveBtn.disabled = false;
        }
      });

    document
      .getElementById("customersTable")
      .addEventListener("click", async (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn) return;
        const id = btn.dataset.id;
        const action = btn.dataset.action;
        if (action === "ledger") openLedgerFor(id);
        if (action === "edit") openCustomerModal(CustomerService.getById(id));
        if (action === "delete") {
          const cust = CustomerService.getById(id);
          const ok = await ModalManager.confirm(
            `مشتری «${cust.fullName}» و تمام تراکنش‌های او حذف خواهد شد.`,
            { title: "حذف مشتری", okText: "حذف کن" }
          );
          if (ok) {
            try {
              await CustomerService.remove(id);
              UIRenderer.renderCustomersTable();
              UIRenderer.renderDepositWithdrawSelects();
              UIRenderer.renderStatCards();
              ToastManager.show("مشتری حذف شد.", "success");
            } catch (ex) {
              ToastManager.show(ex.message || "خطا در حذف مشتری.", "error");
            }
          }
        }
      });

    document
      .getElementById("customerSearchInput")
      .addEventListener("input", UIRenderer.renderCustomersTable);
    document
      .getElementById("customerSortSelect")
      .addEventListener("change", UIRenderer.renderCustomersTable);
  }

  /* ---------- Ledger quick actions ---------- */
  function initLedgerModule() {
    document
      .getElementById("ledgerDepositBtn")
      .addEventListener("click", () => {
        const id = StateManager.get("activeLedgerCustomerId");
        switchSection("deposit");
        document.getElementById("depositCustomerSelect").value = id;
        updateDepositPreview();
      });
    document
      .getElementById("ledgerWithdrawBtn")
      .addEventListener("click", () => {
        const id = StateManager.get("activeLedgerCustomerId");
        switchSection("withdraw");
        document.getElementById("withdrawCustomerSelect").value = id;
        updateWithdrawPreview();
      });
  }

  /* ---------- Deposit ---------- */
  function updateDepositPreview() {
    const price = GoldPriceService.getCurrentPrice();
    const custId = document.getElementById("depositCustomerSelect").value;
    const amount =
      Utils.parseNumber(document.getElementById("depositAmountInput").value) ||
      0;
    const goldAmount = price > 0 ? amount / price : 0;
    const currentBalance = custId ? CustomerService.getBalance(custId) : 0;
    document.getElementById("depositGoldPriceText").textContent =
      price > 0 ? Utils.formatToman(price) : "ثبت نشده";
    document.getElementById("depositGoldAmountText").textContent =
      Utils.formatGram(goldAmount);
    document.getElementById("depositNewBalanceText").textContent =
      Utils.formatGram(currentBalance + goldAmount);
  }

  function initDepositModule() {
    const amountInput = document.getElementById("depositAmountInput");
    attachNumberMask(amountInput);
    amountInput.addEventListener("input", updateDepositPreview);
    document
      .getElementById("depositCustomerSelect")
      .addEventListener("change", updateDepositPreview);

    const submitBtn = document.getElementById("submitDepositBtn");
    submitBtn.addEventListener("click", async () => {
      const errorEl = document.getElementById("depositError");
      const custId = document.getElementById("depositCustomerSelect").value;
      const amount = Utils.parseNumber(amountInput.value);
      const desc = document.getElementById("depositDescInput").value;

      if (!custId) {
        errorEl.textContent = "لطفا یک مشتری انتخاب کنید.";
        return;
      }
      const amtErr = ValidationService.validateAmount(amount);
      if (amtErr) {
        errorEl.textContent = amtErr;
        return;
      }
      if (GoldPriceService.getCurrentPrice() <= 0) {
        errorEl.textContent = "ابتدا قیمت طلا را از بخش تنظیمات ثبت کنید.";
        return;
      }
      errorEl.textContent = "";
      submitBtn.disabled = true;

      try {
        const operator = AuthenticationService.currentUser().username;
        const tx = await LedgerService.recordDeposit({
          customerId: custId,
          amount,
          description: desc,
          operator,
        });
        const cust = CustomerService.getById(custId);
        const smsText = SMSService.buildDepositMessage(cust.fullName, tx);
        await SMSService.log(cust, tx, smsText);

        amountInput.value = "";
        document.getElementById("depositDescInput").value = "";
        updateDepositPreview();
        UIRenderer.renderStatCards();
        UIRenderer.renderDepositWithdrawSelects();
        showSmsPreview(smsText);
        ToastManager.show("واریز با موفقیت ثبت شد.", "success");
      } catch (ex) {
        errorEl.textContent = ex.message || "خطا در ثبت واریز.";
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  /* ---------- Withdraw ---------- */
  function updateWithdrawPreview() {
    const price = GoldPriceService.getCurrentPrice();
    const custId = document.getElementById("withdrawCustomerSelect").value;
    const amount =
      Utils.parseNumber(document.getElementById("withdrawAmountInput").value) ||
      0;
    const goldAmount = price > 0 ? amount / price : 0;
    const currentBalance = custId ? CustomerService.getBalance(custId) : 0;
    document.getElementById("withdrawGoldPriceText").textContent =
      price > 0 ? Utils.formatToman(price) : "ثبت نشده";
    document.getElementById("withdrawCurrentBalanceText").textContent =
      Utils.formatGram(currentBalance);
    document.getElementById("withdrawGoldAmountText").textContent =
      Utils.formatGram(goldAmount);
    document.getElementById("withdrawNewBalanceText").textContent =
      Utils.formatGram(
        Math.max(currentBalance - goldAmount, currentBalance - goldAmount)
      );
  }

  function initWithdrawModule() {
    const amountInput = document.getElementById("withdrawAmountInput");
    attachNumberMask(amountInput);
    amountInput.addEventListener("input", updateWithdrawPreview);
    document
      .getElementById("withdrawCustomerSelect")
      .addEventListener("change", updateWithdrawPreview);

    document
      .getElementById("submitWithdrawBtn")
      .addEventListener("click", async () => {
        const errorEl = document.getElementById("withdrawError");
        const custId = document.getElementById("withdrawCustomerSelect").value;
        const amount = Utils.parseNumber(amountInput.value);
        const desc = document.getElementById("withdrawDescInput").value;

        if (!custId) {
          errorEl.textContent = "لطفا یک مشتری انتخاب کنید.";
          return;
        }
        const amtErr = ValidationService.validateAmount(amount);
        if (amtErr) {
          errorEl.textContent = amtErr;
          return;
        }
        if (GoldPriceService.getCurrentPrice() <= 0) {
          errorEl.textContent = "ابتدا قیمت طلا را از بخش تنظیمات ثبت کنید.";
          return;
        }

        const price = GoldPriceService.getCurrentPrice();
        const goldAmount = amount / price;
        const currentBalance = CustomerService.getBalance(custId);
        const balErr = ValidationService.validateWithdrawal(
          goldAmount,
          currentBalance
        );
        if (balErr) {
          errorEl.textContent = balErr;
          return;
        }
        errorEl.textContent = "";

        const cust = CustomerService.getById(custId);
        const ok = await ModalManager.confirm(
          `برداشت ${Utils.formatToman(amount)} (معادل ${Utils.formatGram(
            goldAmount
          )}) از حساب «${cust.fullName}» ثبت شود؟`,
          { title: "تایید برداشت", okText: "ثبت برداشت" }
        );
        if (!ok) return;

        const operator = AuthenticationService.currentUser().username;
        try {
          const tx = await LedgerService.recordWithdrawal({
            customerId: custId,
            amount,
            description: desc,
            operator,
          });
          const smsText = SMSService.buildWithdrawMessage(cust.fullName, tx);
          await SMSService.log(cust, tx, smsText);

          amountInput.value = "";
          document.getElementById("withdrawDescInput").value = "";
          updateWithdrawPreview();
          UIRenderer.renderStatCards();
          UIRenderer.renderDepositWithdrawSelects();
          showSmsPreview(smsText);
          ToastManager.show("برداشت با موفقیت ثبت شد.", "success");
        } catch (ex) {
          errorEl.textContent = ex.message;
        }
      });
  }

  function showSmsPreview(text) {
    document.getElementById("smsPreviewText").textContent = text;
    ModalManager.open("smsModalOverlay");
  }

  function initSmsModal() {
    document
      .getElementById("smsModalClose")
      .addEventListener("click", () => ModalManager.close("smsModalOverlay"));
    document.getElementById("smsModalOkBtn").addEventListener("click", () => {
      ModalManager.close("smsModalOverlay");
      UIRenderer.renderSmsTable();
    });
  }

  /* ---------- Reports ---------- */
  function initReportsModule() {
    document
      .getElementById("reportRangeSelect")
      .addEventListener("change", UIRenderer.renderReportsPage);
  }

  /* ---------- Settings ---------- */
  function initSettingsModule() {
    const priceInput = document.getElementById("settingsGoldPriceInput");
    attachNumberMask(priceInput);

    document
      .getElementById("saveGoldPriceBtn")
      .addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await GoldPriceService.setCurrentPrice(
            Utils.parseNumber(priceInput.value)
          );
          UIRenderer.renderSidebarGoldPrice();
          ToastManager.show("قیمت طلا با موفقیت ذخیره شد.", "success");
        } catch (ex) {
          ToastManager.show(ex.message || "خطا در ذخیره قیمت طلا.", "error");
        } finally {
          btn.disabled = false;
        }
      });

    document
      .getElementById("saveBusinessInfoBtn")
      .addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const businessName =
          document.getElementById("settingsBusinessNameInput").value.trim() ||
          "قلک طلایی";
        const smsEnabled = document.getElementById("settingsSmsToggle").checked;
        btn.disabled = true;
        try {
          await DataService.upsertSettings({ businessName, smsEnabled });
          StorageService.set("settings", { businessName, smsEnabled });
          UIRenderer.renderBusinessName();
          ToastManager.show("تنظیمات ذخیره شد.", "success");
        } catch (ex) {
          ToastManager.show(ex.message || "خطا در ذخیره تنظیمات.", "error");
        } finally {
          btn.disabled = false;
        }
      });

    document.getElementById("exportJsonBtn").addEventListener("click", () => {
      const data = StorageService.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `golden-wallet-backup-${Utils.toEnDigits(
        Utils.formatJalaliDate()
      ).replace(/\//g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
      ToastManager.show("فایل پشتیبان با موفقیت دانلود شد.", "success");
    });

    document
      .getElementById("importJsonInput")
      .addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const data = JSON.parse(reader.result);
            const ok = await ModalManager.confirm(
              "اطلاعات فعلی با محتوای فایل جایگزین/تکمیل خواهد شد (بر اساس شناسه).",
              { title: "بازیابی داده‌ها", okText: "بازیابی کن" }
            );
            if (!ok) return;
            await DataService.bulkImport(data);
            const fresh = await DataService.fetchAll();
            StorageService.replaceAll(fresh);
            UIRenderer.refreshAll();
            ToastManager.show("داده‌ها با موفقیت بازیابی شدند.", "success");
          } catch (ex) {
            ToastManager.show(
              ex.message || "فایل انتخاب شده معتبر نیست.",
              "error"
            );
          }
        };
        reader.readAsText(file);
        e.target.value = "";
      });

    document
      .getElementById("resetDataBtn")
      .addEventListener("click", async () => {
        const ok = await ModalManager.confirm(
          "تمامی مشتریان، تراکنش‌ها و تنظیمات برای همیشه حذف خواهند شد.",
          { title: "حذف کامل داده‌ها", okText: "حذف همه چیز" }
        );
        if (!ok) return;
        try {
          await DataService.clearAllData();
          StorageService.clearCache();
          UIRenderer.refreshAll();
          ToastManager.show("تمامی داده‌ها پاک شدند.", "success");
        } catch (ex) {
          ToastManager.show(ex.message || "خطا در حذف داده‌ها.", "error");
        }
      });
  }

  function initResizeHandler() {
    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const section = StateManager.get("activeSection");
        if (section === "dashboard") {
          ChartRenderer.renderTrendChart();
          ChartRenderer.renderPieChart();
        }
        if (section === "stats") {
          ChartRenderer.renderGrowthChart();
          ChartRenderer.renderBarChart();
        }
      }, 200);
    });
  }

  function initAll() {
    initLogin();
    initNav();
    initGlobalSearch();
    initCustomerModule();
    initLedgerModule();
    initDepositModule();
    initWithdrawModule();
    initSmsModal();
    initReportsModule();
    initSettingsModule();
    initResizeHandler();
    ModalManager.init();
  }

  return { initAll, switchSection, openLedgerFor };
})();

/* ============================================================
         15. APP BOOTSTRAP
         ============================================================ */
async function loadDataFromSupabase() {
  const data = await DataService.fetchAll();
  StorageService.replaceAll(data);
}

async function startApp() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("appShell").classList.remove("hidden");
  try {
    await loadDataFromSupabase();
  } catch (ex) {
    console.error("Failed to load data from Supabase:", ex);
    ToastManager.show(
      "خطا در دریافت اطلاعات از سرور. اتصال اینترنت را بررسی کنید.",
      "error"
    );
  }
  UIRenderer.refreshAll();
  EventManager.switchSection("dashboard");
  await GoldPriceService.updatePrice();
  UIRenderer.renderSidebarGoldPrice();
}

document.addEventListener("DOMContentLoaded", async () => {
  EventManager.initAll();

  const ready = DataService.init();
  if (!ready) {
    document.getElementById("loginScreen").classList.remove("hidden");
    document.getElementById("loginError").textContent =
      "سامانه به دیتابیس متصل نیست. تنظیمات Supabase در app.js را کامل کنید.";
    return;
  }

  const restored = await AuthenticationService.restoreSession();
  if (restored) {
    await startApp();
  } else {
    document.getElementById("loginScreen").classList.remove("hidden");
  }
});
