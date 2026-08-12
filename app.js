/* Spare Part Management — application logic.
 *
 * A single-page app with no build step. State lives in one object; every mutation
 * goes through setState()/render(), which rebuilds the active view and restores
 * focus/scroll so typing in a field is not interrupted.
 *
 * Data lives in Supabase (Postgres): the `stock`, `transactions` and `profiles`
 * tables are readable by any signed-in active user (see db/schema.sql), and every
 * write goes through a Postgres RPC function that re-checks the caller's role
 * itself — the browser never has to be trusted with permission logic.
 *
 * Login uses Supabase Auth, which needs an email. The UI only ever shows a short
 * "User" handle, so the frontend logs in with a synthetic address
 * `<username>@login.spareapart.internal` — it never has to be a real, deliverable
 * inbox, it just has to satisfy the email format Supabase Auth expects.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ config

  var LOGIN_DOMAIN = '@login.spareapart.internal';

  var ROLE_LABEL = { admin: 'Admin', supervisor: 'Supervisor', operator: 'Operator' };

  // Position of each role in the user list: Admin first, then Supervisor, then
  // Operator, with creation order breaking ties within a role.
  var ROLE_ORDER = { admin: 0, supervisor: 1, operator: 2 };

  function roleRank(role) {
    return ROLE_ORDER[role] === undefined ? 99 : ROLE_ORDER[role];
  }

  /** Oldest account first. */
  function byCreatedAt(a, b) {
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  }

  var PAGE_TITLE = {
    overview: 'Overview',
    receive: 'รับอะไหล่เข้า',
    issue: 'จ่ายอะไหล่ออก',
    log: 'ประวัติ/Log',
    inventory: 'รายการอุปกรณ์',
    users: 'จัดการผู้ใช้งาน',
    settings: 'ตั้งค่า'
  };

  var STATUS_LABEL = {
    approved: 'อนุมัติแล้ว',
    pending: 'รออนุมัติ',
    rejected: 'ปฏิเสธ',
    ok: 'ปกติ',
    near: 'ใกล้ Min',
    low: 'ต่ำกว่า Min',
    high: 'สูงกว่า Max'
  };

  // Marks the receive transaction submit_stock_item auto-creates for a new item's
  // starting quantity (must match the literal in db/stock_item_receive_log.sql).
  // While the item is still pending, this transaction is hidden from the log
  // page's quick-approve card — approving it there would call approveTx, which
  // has no idea it also needs to set Min/Max and activate the item.
  var NEW_ITEM_RECEIVE_NOTE = 'เพิ่มอุปกรณ์ใหม่';

  // The chart draws one column per day; a very wide range would produce
  // thousands of columns, so the window is clamped.
  var MAX_CHART_DAYS = 120;

  // ----------------------------------------------------------------- helpers

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function raw(markup) {
    return { __raw: String(markup) };
  }

  function interpolate(value) {
    if (value === null || value === undefined || value === false) return '';
    if (Array.isArray(value)) return value.map(interpolate).join('');
    if (value && value.__raw !== undefined) return value.__raw;
    return esc(value);
  }

  /** Tagged template that escapes every interpolated value unless wrapped in raw(). */
  function html(strings) {
    var out = strings[0];
    for (var i = 1; i < arguments.length; i++) {
      out += interpolate(arguments[i]) + strings[i];
    }
    return out;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** Local calendar date as YYYY-MM-DD (toISOString would shift by the UTC offset). */
  function isoDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function todayStr() {
    return isoDate(new Date());
  }

  function daysAgoStr(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    return isoDate(d);
  }

  function parseIsoDate(s) {
    var p = String(s || '').split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function formatDateThai(dateStr) {
    if (!dateStr) return '';
    var p = String(dateStr).split('-');
    return p[2] + '-' + p[1] + '-' + p[0];
  }

  function usernameToEmail(username) {
    return String(username || '').trim().toLowerCase() + LOGIN_DOMAIN;
  }

  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
  }

  function setPath(obj, path, value) {
    var keys = path.split('.');
    var target = obj;
    for (var i = 0; i < keys.length - 1; i++) target = target[keys[i]];
    target[keys[keys.length - 1]] = value;
    return target;
  }

  var NETWORK_ERROR_MSG = 'เชื่อมต่อฐานข้อมูลไม่สำเร็จ — เครือข่ายที่ใช้อยู่อาจบล็อกการเชื่อมต่อ กรุณาลองใหม่ หรือสลับไปใช้เน็ตมือถือ/เครือข่ายอื่น';

  /**
   * True when a failure came from the connection itself rather than from Postgres.
   * Corporate proxies reset the TLS connection, which surfaces as a thrown TypeError
   * ("Failed to fetch") rather than a PostgREST error payload — worth telling apart,
   * because the fix is completely different from a real credential/permission problem.
   */
  function isNetworkError(error) {
    if (!error) return false;
    var text = String(error.message || error.details || error) + '';
    return /failed to fetch|networkerror|err_connection|load failed|fetch failed|network request failed/i.test(text);
  }

  /** Human-readable text from a Supabase/Postgres error, falling back to a generic message. */
  function errorMessage(error, fallback) {
    if (!error) return fallback;
    if (isNetworkError(error)) return NETWORK_ERROR_MSG;
    var text = String(error.message || '');
    // Constraint violations arrive as raw Postgres English naming internal tables,
    // which means nothing to whoever is looking at the screen.
    if (/violates foreign key constraint/i.test(text)) {
      return 'ลบไม่ได้เพราะยังมีข้อมูลอื่นในระบบอ้างอิงถึงรายการนี้อยู่ กรุณาแจ้งผู้ดูแลระบบ';
    }
    // RPC exceptions raised with `raise exception '...'` arrive in error.message as-is.
    return text || fallback;
  }

  /**
   * Build a CSV and hand it to the browser as a download. The leading U+FEFF is
   * what makes Excel read the Thai text as UTF-8 instead of mojibake.
   */
  function downloadCsv(rows, filename) {
    var csv = '\uFEFF' + rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');

    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Avatars render at 32-84px, so a 128px thumbnail is all that is ever displayed.
  // Storing the file as picked would mean carrying megabytes of base64 around for
  // something shown the size of a fingernail.
  var AVATAR_PX = 128;
  // Part photos are shown small in the table but should still be legible enough to
  // tell two similar fittings apart, so they get more pixels than an avatar.
  var PART_IMAGE_PX = 200;

  /**
   * Read a picked image file and return a square JPEG data URL, centre-cropped to
   * `size` pixels. Rejects if the file is not a decodable image.
   */
  function shrinkImageFile(file, size) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('อ่านไฟล์รูปไม่สำเร็จ')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('ไฟล์นี้ไม่ใช่รูปภาพที่รองรับ')); };
        img.onload = function () {
          try {
            var px = size || AVATAR_PX;
            var canvas = document.createElement('canvas');
            canvas.width = px;
            canvas.height = px;
            // Scale so the shorter side fills the square, then centre it: keeps the
            // subject in frame instead of squashing the aspect ratio.
            var scale = Math.max(px / img.width, px / img.height);
            var w = img.width * scale;
            var h = img.height * scale;
            canvas.getContext('2d').drawImage(img, (px - w) / 2, (px - h) / 2, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.8));
          } catch (e) {
            reject(new Error('ย่อรูปไม่สำเร็จ กรุณาเลือกรูปอื่น'));
          }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  var ICON = {
    overview: '<path d="M3 11l9-8 9 8"></path><path d="M5 10v10h5v-6h4v6h5V10"></path>',
    receive: '<path d="M12 3v12M8 11l4 4 4-4"></path><path d="M4 19h16"></path>',
    issue: '<path d="M12 21V9M8 13l4-4 4 4"></path><path d="M4 5h16"></path>',
    log: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path>',
    inventory: '<path d="M3 7l9-4 9 4-9 4-9-4z"></path><path d="M3 7v10l9 4 9-4V7"></path><path d="M12 11v10"></path>',
    users: '<circle cx="9" cy="8" r="3"></circle><path d="M2 20c0-3.3 3.1-5 7-5s7 1.7 7 5"></path><circle cx="17" cy="9" r="2.6"></circle><path d="M16 12.2c2.6.4 4.3 1.8 4.3 3.8"></path>',
    settings: '<circle cx="12" cy="12" r="7.5"></circle><circle cx="12" cy="12" r="2.6"></circle>',
    logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"></path><path d="M16 17l5-5-5-5"></path><path d="M21 12H9"></path>',
    person: '<circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"></path>'
  };

  function icon(name, size) {
    return raw('<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICON[name] + '</svg>');
  }

  // -------------------------------------------------------------- supabase client

  var supabaseClient = null;
  var configError = '';

  (function initSupabase() {
    var cfg = window.SPM_CONFIG || {};
    // Catches any leftover placeholder text regardless of exact wording, plus anything
    // implausibly short to be a real Supabase URL/key — safer than matching one fixed string.
    var placeholder = /YOUR[-_]|PASTE|xxxxxxxxxxxx|example/i;
    var looksReal = cfg.url && cfg.anonKey && !placeholder.test(cfg.url) && !placeholder.test(cfg.anonKey)
      && cfg.url.indexOf('https://') === 0 && cfg.anonKey.length >= 20;
    if (!looksReal) {
      configError = 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล กรุณาแก้ไขค่าในไฟล์ config.js ให้ครบก่อนใช้งาน (ดูวิธีที่ SUPABASE_SETUP.md)';
      return;
    }
    if (!window.supabase || !window.supabase.createClient) {
      configError = 'โหลดไลบรารี Supabase ไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วรีเฟรชหน้านี้อีกครั้ง';
      return;
    }
    supabaseClient = window.supabase.createClient(cfg.url, cfg.anonKey);
  })();

  // ------------------------------------------------------------------- state

  var state = {
    view: configError ? 'configError' : 'loading',
    page: 'overview',
    currentUser: null,
    users: [],
    stock: [],
    stockImages: {},   // item id -> picture data URL, loaded once per sign-in
    transactions: [],
    loginForm: { username: '', password: '', error: '', showPw: false },
    signupForm: { username: '', password: '', name: '', email: '', avatar: '', error: '', success: '' },
    changePwForm: { current: '', next: '', confirm: '', error: '', success: '' },
    receiveForm: { date: todayStr(), itemQuery: '', category: '', unit: '', qty: '', note: '', error: '' },
    issueForm: { date: todayStr(), itemQuery: '', category: '', unit: '', qty: '', note: '', error: '' },
    logFilter: { search: '', type: 'all', status: 'all', dateFrom: '', dateTo: '' },
    chartFilter: { from: daysAgoStr(13), to: todayStr() },
    invFilter: { search: '', category: 'all', status: 'all' },
    receiveTab: 'receive',   // 'receive' | 'addItem' — sub-tabs under รับอะไหล่เข้า
    // Banners for requests that arrived while the approver was on another page.
    // Unlike the toast these stay until dismissed, so one cannot be missed.
    requestAlerts: [],
    newItemForm: { date: todayStr(), code: '', category: '', unit: '', qty: '', min: '1', max: '1', error: '' },
    toast: { msg: '', type: '' }
  };

  var toastTimer = null;
  var realtimeChannel = null;
  var inFlight = {}; // guards against double-submit while an RPC call is in flight

  function setState(patch) {
    Object.assign(state, patch);
    render();
  }

  function showToast(msg, type) {
    state.toast = { msg: msg, type: type || 'success' };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      state.toast = { msg: '', type: '' };
      render();
    }, 2600);
    render();
  }

  /** Opens the equipment list showing only `status`, clearing other filters so the
   *  jump lands on exactly the group that was clicked. */
  function jumpToStatus(status) {
    state.invFilter = { search: '', category: 'all', status: status || 'all' };
    setState({ page: 'inventory' });
  }

  function canDirectStock() {
    var r = state.currentUser && state.currentUser.role;
    return r === 'admin' || r === 'supervisor';
  }

  function isAdmin() {
    return !!state.currentUser && state.currentUser.role === 'admin';
  }

  /** Runs `fn` only if no call tagged `key` is already in flight; always clears the guard after. */
  function guarded(key, fn) {
    if (inFlight[key]) return;
    inFlight[key] = true;
    Promise.resolve().then(fn).catch(function (e) {
      showToast(errorMessage(e, 'เกิดข้อผิดพลาด กรุณาลองใหม่'), 'error');
    }).then(function () {
      inFlight[key] = false;
    });
  }

  // --------------------------------------------------------------- row mapping

  function mapStockRow(r) {
    return {
      id: r.id, code: r.code, category: r.category, unit: r.unit, qty: r.qty, min: r.min, max: r.max,
      // 'active' | 'pending' — a request awaiting Admin/Supervisor approval. Distinct
      // from stockStatus(), which is a computed low/near/ok/high health reading.
      status: r.status || 'active',
      requestedBy: r.requested_by, requestedName: r.requested_name,
      approvedBy: r.approved_by, approvedName: r.approved_name
    };
  }

  function mapTxRow(r) {
    return {
      id: r.id, date: r.tx_date, time: r.tx_time, type: r.type,
      itemId: r.item_id, itemCode: r.item_code, category: r.category, unit: r.unit, qty: r.qty,
      userId: r.user_id, userName: r.user_name, status: r.status, note: r.note,
      approverName: r.approver_name
    };
  }

  function mapProfileRow(r) {
    return {
      id: r.id, username: r.username, name: r.name, email: r.email,
      avatar: r.avatar_url, role: r.role, status: r.status,
      createdAt: r.created_at
    };
  }

  // ----------------------------------------------------------------- data I/O

  function loadStock() {
    return supabaseClient.from('stock').select('*').order('id').then(function (res) {
      if (res.error) throw res.error;
      state.stock = res.data.map(mapStockRow);
    });
  }

  function loadTransactions() {
    return supabaseClient.from('transactions').select('*').order('id', { ascending: false }).then(function (res) {
      if (res.error) throw res.error;
      state.transactions = res.data.map(mapTxRow);
    });
  }

  function loadProfiles() {
    // created_at, not id: the id is a random uuid, so ordering by it is arbitrary.
    return supabaseClient.from('profiles').select('*').order('created_at').then(function (res) {
      if (res.error) throw res.error;
      state.users = res.data.map(mapProfileRow);
    });
  }

  /**
   * Pictures are loaded once per sign-in and then left alone — deliberately not
   * part of refreshStock(), which fires on every receive/issue and would otherwise
   * re-download every picture each time anyone moves stock.
   */
  function loadStockImages() {
    return supabaseClient.from('stock_images').select('item_id,image').then(function (res) {
      // A missing table just means db/add_stock_images.sql has not been run yet;
      // the list still works, it simply has no pictures to show.
      if (res.error) { state.stockImages = {}; return; }
      var map = {};
      res.data.forEach(function (r) { map[r.item_id] = r.image; });
      state.stockImages = map;
    });
  }

  function loadAll() {
    return Promise.all([loadStock(), loadTransactions(), loadProfiles(), loadStockImages()]);
  }

  function refreshStock() { return loadStock().then(afterRefresh); }
  function refreshTransactions() { return loadTransactions().then(afterRefresh); }
  function refreshProfiles() { return loadProfiles().then(afterRefresh); }

  function afterRefresh() {
    announceNewRequests();
    render();
  }

  // ------------------------------------------------------- request alerts

  // Counts at the last check. null until the first load establishes a baseline —
  // without that, signing in with requests already waiting would announce them
  // as if they had just arrived.
  var pendingBaseline = null;

  function pendingCounts() {
    return {
      tx: pendingTransactions().length,
      items: pendingStockItems().length,
      users: pendingUsers().length
    };
  }

  function resetPendingBaseline() {
    pendingBaseline = canDirectStock() ? pendingCounts() : null;
  }

  /**
   * Announces requests that appeared since the last check. Only approvers are
   * told, since nobody else can act on them. Driven by the realtime refreshes,
   * so it fires for requests raised by other people, which is the whole point —
   * the approver has no other reason to be looking at the screen.
   */
  function announceNewRequests() {
    if (!canDirectStock()) { pendingBaseline = null; return; }
    var now = pendingCounts();
    if (pendingBaseline === null) { pendingBaseline = now; return; }

    var alerts = [];
    if (now.tx > pendingBaseline.tx) {
      alerts.push({ text: 'มีคำขอเบิก/รับอะไหล่รออนุมัติ ' + now.tx + ' รายการ', page: 'log' });
    }
    if (now.items > pendingBaseline.items) {
      alerts.push({ text: 'มีคำขอเพิ่มอุปกรณ์ใหม่รออนุมัติ ' + now.items + ' รายการ', page: 'receive', tab: 'addItem' });
    }
    if (now.users > pendingBaseline.users) {
      alerts.push({ text: 'มีบัญชีผู้ใช้งานใหม่รออนุมัติ ' + now.users + ' รายการ', page: 'users' });
    }
    pendingBaseline = now;
    if (alerts.length) state.requestAlerts = state.requestAlerts.concat(alerts);
    alerts.forEach(desktopNotify);
  }

  /**
   * Fires an OS-level notification, which is the only part that reaches an
   * approver whose browser is behind another window. Silently does nothing
   * unless they have granted permission from ตั้งค่า.
   */
  function desktopNotify(alert) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      var n = new Notification('Spare Part Management', { body: alert.text, icon: 'assets/logo.svg' });
      n.onclick = function () {
        window.focus();
        if (alert.tab) state.receiveTab = alert.tab;
        setState({ page: alert.page });
        n.close();
      };
    } catch (e) { /* some browsers reject construction outside a service worker */ }
  }

  /** Keeps everyone's view live: any user's approve/receive/issue updates every open tab. */
  function subscribeRealtime() {
    if (realtimeChannel) return;
    realtimeChannel = supabaseClient
      .channel('spm-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stock' }, refreshStock)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, refreshTransactions)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, refreshProfiles)
      .subscribe();
  }

  function unsubscribeRealtime() {
    if (!realtimeChannel) return;
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  // --------------------------------------------------------------- bootstrap

  function bootstrap() {
    if (configError) return;
    supabaseClient.auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (session) return enterAsUser(session.user.id);
      setState({ view: 'login' });
    }).catch(function () {
      setState({ view: 'login' });
    });
  }

  /**
   * Bounce back to the login screen showing `msg`.
   *
   * The sign-out is best-effort on purpose: when the network is what failed in the
   * first place, signOut() fails too, and awaiting it would swallow the very message
   * explaining what went wrong — leaving the button looking like it did nothing.
   */
  function failLogin(msg) {
    return Promise.resolve()
      .then(function () { return supabaseClient.auth.signOut(); })
      .catch(function () { /* already offline / no session — nothing to clean up */ })
      .then(function () {
        state.currentUser = null;
        setState({ view: 'login', loginForm: blankLoginForm(msg) });
      });
  }

  /** After a valid Supabase session exists, load the matching profile and gate on its status. */
  function enterAsUser(userId) {
    return supabaseClient.from('profiles').select('*').eq('id', userId).single().then(function (res) {
      if (res.error || !res.data) {
        return failLogin(isNetworkError(res.error)
          ? NETWORK_ERROR_MSG
          : 'ไม่พบข้อมูลผู้ใช้งาน กรุณาลองเข้าสู่ระบบใหม่');
      }
      var profile = res.data;
      if (profile.status === 'pending') {
        return failLogin('บัญชีนี้ยังรอ Admin หรือ Supervisor อนุมัติ');
      }
      if (profile.status === 'rejected') {
        return failLogin('บัญชีนี้ถูกปฏิเสธการสมัคร กรุณาติดต่อผู้ดูแลระบบ');
      }
      state.currentUser = mapProfileRow(profile);
      return loadAll().then(function () {
        // Baseline before subscribing, so whatever was already waiting at sign-in
        // is treated as known rather than announced as new.
        resetPendingBaseline();
        subscribeRealtime();
        setState({ view: 'app', page: 'overview' });
      });
    }).catch(function (e) {
      // Covers a thrown fetch failure anywhere above, including inside loadAll().
      return failLogin(errorMessage(e, 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'));
    });
  }

  function blankLoginForm(error) {
    return { username: '', password: '', error: error || '', showPw: false };
  }

  // --------------------------------------------------------------- selectors

  /** Everything except items still awaiting approval — what the app treats as "real" stock. */
  function activeStock() {
    return state.stock.filter(function (s) { return s.status === 'active'; });
  }

  function findByCode(code) {
    var q = String(code || '').trim().toLowerCase();
    if (!q) return null;
    return activeStock().find(function (s) { return s.code.trim().toLowerCase() === q; }) || null;
  }

  // How close to Min still counts as "ใกล้ Min" — 30% above it, matching the
  // threshold the Overview used before these statuses were unified.
  var NEAR_MIN_RATIO = 1.3;

  function stockStatus(item) {
    if (item.qty < item.min) return 'low';
    // max === 0 reads as "no ceiling set" rather than "must be zero" — much of the
    // master list was imported with the Max column left blank, and flagging all of
    // those as overstocked the moment anything is received would be noise.
    if (item.max > 0 && item.qty > item.max) return 'high';
    // Checked after 'high' on purpose: stock sitting above Max is not running low,
    // even where Max was entered below Min.
    if (item.min > 0 && item.qty <= item.min * NEAR_MIN_RATIO) return 'near';
    return 'ok';
  }

  function categories() {
    return Array.from(new Set(activeStock().map(function (s) { return s.category; })));
  }

  function units() {
    return Array.from(new Set(activeStock().map(function (s) { return s.unit; })));
  }

  function pendingTransactions() {
    return state.transactions.filter(function (t) {
      return t.status === 'pending' && t.note !== NEW_ITEM_RECEIVE_NOTE;
    });
  }

  function pendingUsers() {
    return state.users.filter(function (u) { return u.status === 'pending'; });
  }

  function pendingStockItems() {
    return state.stock.filter(function (s) { return s.status === 'pending'; });
  }

  function filteredTransactions() {
    var f = state.logFilter;
    var search = f.search.trim().toLowerCase();
    return state.transactions
      .filter(function (t) { return !search || t.itemCode.toLowerCase().indexOf(search) !== -1; })
      .filter(function (t) { return f.type === 'all' || t.type === f.type; })
      .filter(function (t) { return f.status === 'all' || t.status === f.status; })
      .filter(function (t) { return !f.dateFrom || t.date >= f.dateFrom; })
      .filter(function (t) { return !f.dateTo || t.date <= f.dateTo; })
      .sort(function (a, b) { return (a.date + a.time) < (b.date + b.time) ? 1 : -1; });
  }

  function filteredStock() {
    var f = state.invFilter;
    var search = f.search.trim().toLowerCase();
    return activeStock()
      .filter(function (it) { return !search || it.code.toLowerCase().indexOf(search) !== -1; })
      .filter(function (it) { return f.category === 'all' || it.category === f.category; })
      .filter(function (it) { return f.status === 'all' || stockStatus(it) === f.status; });
  }

  function chartData() {
    var approved = state.transactions.filter(function (t) { return t.status === 'approved'; });
    var from = parseIsoDate(state.chartFilter.from || daysAgoStr(13));
    var to = parseIsoDate(state.chartFilter.to || todayStr());
    var days = [];
    for (var d = new Date(from); d <= to && days.length < MAX_CHART_DAYS; d.setDate(d.getDate() + 1)) {
      days.push(isoDate(d));
    }
    var maxQty = Math.max.apply(null, [1].concat(approved.map(function (t) { return t.qty; })));
    return days.map(function (day) {
      var inQty = 0;
      var outQty = 0;
      approved.forEach(function (t) {
        if (t.date !== day) return;
        if (t.type === 'in') inQty += t.qty; else outQty += t.qty;
      });
      return {
        label: day.slice(8, 10) + '/' + day.slice(5, 7),
        inQty: inQty,
        outQty: outQty,
        inH: Math.round((inQty / maxQty) * 110) + (inQty ? 4 : 0),
        outH: Math.round((outQty / maxQty) * 110) + (outQty ? 4 : 0)
      };
    });
  }

  function topIssuedItems() {
    var totals = {};
    state.transactions.forEach(function (t) {
      if (t.type !== 'out' || t.status !== 'approved') return;
      if (!totals[t.itemCode]) totals[t.itemCode] = { code: t.itemCode, total: 0, unit: t.unit || '' };
      totals[t.itemCode].total += t.qty;
    });
    var list = Object.keys(totals).map(function (k) { return totals[k]; })
      .sort(function (a, b) { return b.total - a.total; })
      .slice(0, 5);
    var max = list.length ? list[0].total : 1;
    return list.map(function (it) {
      return Object.assign({}, it, { barPct: Math.round((it.total / max) * 100) });
    });
  }

  function donutStats() {
    var stats = { low: 0, near: 0, ok: 0, high: 0 };
    activeStock().forEach(function (it) { stats[stockStatus(it)]++; });
    return stats;
  }

  /**
   * The donut slices, each carrying the arc it occupies so a click can be mapped
   * back to a status. Shares stockStatus() with the table, so the counts here and
   * the rows behind the inventory filter can never disagree.
   */
  function donutSegments() {
    var stats = donutStats();
    var total = activeStock().length || 1;
    // Ordered green -> blue -> amber -> red so the ring reads as increasing attention.
    var order = [
      { key: 'ok',   label: STATUS_LABEL.ok,   color: '#16a34a', count: stats.ok },
      { key: 'high', label: STATUS_LABEL.high, color: '#2f6fed', count: stats.high },
      { key: 'near', label: STATUS_LABEL.near, color: '#f59e0b', count: stats.near },
      { key: 'low',  label: STATUS_LABEL.low,  color: '#dc2626', count: stats.low }
    ];
    var acc = 0;
    return order.map(function (seg) {
      var from = (acc / total) * 360;
      acc += seg.count;
      return Object.assign({}, seg, { from: from, to: (acc / total) * 360 });
    });
  }

  // ----------------------------------------------------------------- actions

  var actions = {

    // -- auth ---------------------------------------------------------------

    toggleLoginPw: function () {
      state.loginForm.showPw = !state.loginForm.showPw;
      render();
    },

    submitLogin: function () {
      guarded('login', function () {
        var f = state.loginForm;
        if (!f.username || !f.password) {
          f.error = 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน';
          return render();
        }
        return supabaseClient.auth.signInWithPassword({
          email: usernameToEmail(f.username), password: f.password
        }).then(function (res) {
          if (res.error) {
            // A dropped connection must not be reported as bad credentials — that
            // sends the user off resetting a password that was never the problem.
            state.loginForm.error = isNetworkError(res.error)
              ? NETWORK_ERROR_MSG
              : 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
            return render();
          }
          return enterAsUser(res.data.user.id);
        }).catch(function (e) {
          state.loginForm.error = errorMessage(e, 'เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
          return render();
        });
      });
    },

    logout: function () {
      guarded('logout', function () {
        unsubscribeRealtime();
        pendingBaseline = null;
        return supabaseClient.auth.signOut().then(function () {
          setState({
            view: 'login', currentUser: null, stock: [], stockImages: {},
            transactions: [], users: [], page: 'overview', requestAlerts: []
          });
        });
      });
    },

    goSignup: function (el, e) {
      e.preventDefault();
      setState({ view: 'signup' });
    },

    goLogin: function (el, e) {
      e.preventDefault();
      state.signupForm = { username: '', password: '', name: '', email: '', avatar: '', error: '', success: '' };
      setState({ view: 'login' });
    },

    signupAvatar: function (el) {
      var file = el.files && el.files[0];
      if (!file) return;
      shrinkImageFile(file, AVATAR_PX).then(function (dataUrl) {
        state.signupForm.avatar = dataUrl;
        state.signupForm.error = '';
        render();
      }).catch(function (e) {
        state.signupForm.avatar = '';
        state.signupForm.error = errorMessage(e, 'ใช้รูปนี้ไม่ได้ กรุณาเลือกรูปอื่น');
        render();
      });
    },

    submitSignup: function () {
      guarded('signup', function () {
        var f = state.signupForm;
        if (!f.username || !f.password || !f.name || !f.email) {
          f.error = 'กรุณากรอกข้อมูลให้ครบทุกช่อง';
          return render();
        }
        if (f.password.length < 6) {
          f.error = 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร';
          return render();
        }
        var avatar = f.avatar;
        // The picture is deliberately NOT passed in `options.data`: that becomes auth
        // metadata, which Supabase copies into the JWT, and the JWT rides in a request
        // header on every call. An image there overflows the header and every request
        // from the account fails. It goes into `profiles` via RPC just below instead.
        return supabaseClient.auth.signUp({
          email: usernameToEmail(f.username),
          password: f.password,
          options: { data: { username: f.username.trim(), name: f.name, contact_email: f.email } }
        }).then(function (res) {
          if (res.error) {
            f.error = /already|registered|exists/i.test(res.error.message)
              ? 'ชื่อผู้ใช้นี้ถูกใช้งานแล้ว'
              : 'สมัครไม่สำเร็จ: ' + res.error.message;
            return render();
          }
          // signUp leaves a valid session behind, which is the one chance to write the
          // picture before signing out. A failure here costs only the picture, so it is
          // swallowed rather than failing an otherwise successful sign-up.
          // Promise.resolve() wrapper matters: rpc() hands back a thenable builder that
          // has .then() but no .catch(), so catching directly on it throws.
          return (avatar
            ? Promise.resolve(supabaseClient.rpc('set_my_avatar', { p_avatar: avatar })).catch(function () {})
            : Promise.resolve()
          ).then(function () {
            // New accounts start as 'pending' — sign back out immediately even though
            // signUp may hand back an active session.
            return supabaseClient.auth.signOut();
          }).then(function () {
            state.signupForm = {
              username: '', password: '', name: '', email: '', avatar: '', error: '',
              success: 'ส่งคำขอสมัครสำเร็จ กรุณารอ Admin หรือ Supervisor อนุมัติบัญชีก่อนเข้าสู่ระบบ'
            };
            render();
            setTimeout(function () {
              if (state.view !== 'signup') return;
              state.signupForm = { username: '', password: '', name: '', email: '', avatar: '', error: '', success: '' };
              setState({ view: 'login' });
            }, 2400);
          });
        });
      });
    },

    /**
     * Uploads the signed-in user's own picture. Goes through set_my_avatar rather
     * than auth metadata: metadata ends up inside the JWT, which travels in a
     * request header, and an image there is what previously locked these accounts
     * out entirely.
     */
    myAvatar: function (el) {
      var file = el.files && el.files[0];
      if (!file) return;
      el.value = '';   // allow re-picking the same file after a failure
      guarded('myAvatar', function () {
        return shrinkImageFile(file, AVATAR_PX).then(function (dataUrl) {
          return saveMyAvatar(dataUrl, 'อัปเดตรูปโปรไฟล์สำเร็จ');
        });
      });
    },

    removeMyAvatar: function () {
      if (!window.confirm('ยืนยันการลบรูปโปรไฟล์?')) return;
      guarded('myAvatar', function () {
        return saveMyAvatar('', 'ลบรูปโปรไฟล์แล้ว');
      });
    },

    submitChangePassword: function () {
      guarded('changePassword', function () {
        var f = state.changePwForm;
        var cu = state.currentUser;
        return supabaseClient.auth.signInWithPassword({
          email: usernameToEmail(cu.username), password: f.current
        }).then(function (verify) {
          if (verify.error) {
            f.error = 'รหัสผ่านเดิมไม่ถูกต้อง';
            return render();
          }
          if (!f.next || f.next.length < 6) {
            f.error = 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร';
            return render();
          }
          if (f.next !== f.confirm) {
            f.error = 'รหัสผ่านใหม่ไม่ตรงกัน';
            return render();
          }
          return supabaseClient.auth.updateUser({ password: f.next }).then(function (res) {
            if (res.error) {
              f.error = 'เปลี่ยนรหัสผ่านไม่สำเร็จ: ' + res.error.message;
              return render();
            }
            state.changePwForm = { current: '', next: '', confirm: '', error: '', success: 'เปลี่ยนรหัสผ่านสำเร็จ' };
            render();
          });
        });
      });
    },

    // -- navigation ---------------------------------------------------------

    nav: function (el) {
      setState({ page: el.dataset.page });
    },

    filterByStatus: function (el) {
      jumpToStatus(el.dataset.status);
    },

    /**
     * Works out which slice was clicked from where the pointer landed. The ring is a
     * conic-gradient, so there are no per-slice elements to attach handlers to —
     * the angle from the centre is what identifies the slice. Clicking the hole
     * clears the filter and shows everything.
     */
    donutJump: function (el, e) {
      if (!activeStock().length) return;
      var rect = el.getBoundingClientRect();
      var dx = e.clientX - (rect.left + rect.width / 2);
      var dy = e.clientY - (rect.top + rect.height / 2);
      var radius = Math.sqrt(dx * dx + dy * dy);

      if (radius <= rect.width * 0.36) return jumpToStatus('all');   // the hole
      if (radius > rect.width / 2) return;                            // outside the ring

      // Measured clockwise from 12 o'clock, matching how conic-gradient lays slices out.
      var deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
      var hit = donutSegments().find(function (seg) { return deg >= seg.from && deg < seg.to; });
      if (hit) jumpToStatus(hit.key);
    },

    openDatePicker: function (el) {
      if (el.showPicker) {
        try { el.showPicker(); } catch (e) { /* not supported / not user-activated */ }
      }
    },

    // -- receive / issue ----------------------------------------------------

    receiveItem: function (el) {
      var f = state.receiveForm;
      var match = findByCode(el.value);
      f.itemQuery = el.value;
      if (match) { f.category = match.category; f.unit = match.unit; }
      f.error = '';
      render();
    },

    issueItem: function (el) {
      var f = state.issueForm;
      var match = findByCode(el.value);
      f.itemQuery = el.value;
      if (match) { f.category = match.category; f.unit = match.unit; }
      f.error = '';
      render();
    },

    submitReceive: function () { guarded('receive', function () { return submitMovement('in'); }); },
    submitIssue: function () { guarded('issue', function () { return submitMovement('out'); }); },

    // -- approvals ----------------------------------------------------------

    approveTx: function (el) {
      var id = Number(el.dataset.id);
      guarded('approveTx' + id, function () {
        return supabaseClient.rpc('approve_transaction', { p_tx_id: id }).then(function (res) {
          if (res.error) return showToast(errorMessage(res.error, 'อนุมัติไม่สำเร็จ'), 'error');
          return Promise.all([refreshStock(), refreshTransactions()]).then(function () {
            showToast('อนุมัติรายการสำเร็จ', 'success');
          });
        });
      });
    },

    rejectTx: function (el) {
      var id = Number(el.dataset.id);
      guarded('rejectTx' + id, function () {
        return supabaseClient.rpc('reject_transaction', { p_tx_id: id }).then(function (res) {
          if (res.error) return showToast(errorMessage(res.error, 'ปฏิเสธไม่สำเร็จ'), 'error');
          return refreshTransactions().then(function () {
            showToast('ปฏิเสธรายการแล้ว', 'error');
          });
        });
      });
    },

    // -- inventory ----------------------------------------------------------

    stockMin: function (el) { updateStockMinMax(el, 'min'); },
    stockMax: function (el) { updateStockMinMax(el, 'max'); },

    stockImage: function (el) {
      var id = Number(el.dataset.id);
      var file = el.files && el.files[0];
      if (!file) return;
      el.value = '';   // let the same file be picked again after a failure
      guarded('stockImage' + id, function () {
        return shrinkImageFile(file, PART_IMAGE_PX).then(function (dataUrl) {
          // rpc() returns a thenable without .catch(), so wrap before chaining.
          return Promise.resolve(supabaseClient.rpc('set_stock_image', { p_item_id: id, p_image: dataUrl }))
            .then(function (res) {
              if (res && res.error) throw res.error;
              state.stockImages[id] = dataUrl;
              showToast('อัปเดตรูปอุปกรณ์สำเร็จ', 'success');
            });
        });
      });
    },

    removeStockImage: function (el) {
      var id = Number(el.dataset.id);
      if (!window.confirm('ยืนยันการลบรูปอุปกรณ์นี้?')) return;
      guarded('stockImage' + id, function () {
        return Promise.resolve(supabaseClient.rpc('set_stock_image', { p_item_id: id, p_image: '' }))
          .then(function (res) {
            if (res && res.error) throw res.error;
            delete state.stockImages[id];
            showToast('ลบรูปอุปกรณ์แล้ว', 'success');
          });
      });
    },

    receiveTab: function (el) {
      setState({ receiveTab: el.dataset.tab });
    },

    // -- request alerts -----------------------------------------------------

    openAlert: function (el) {
      var alert = state.requestAlerts[Number(el.dataset.index)];
      if (!alert) return;
      state.requestAlerts = [];
      if (alert.tab) state.receiveTab = alert.tab;
      setState({ page: alert.page });
    },

    dismissAlerts: function () {
      setState({ requestAlerts: [] });
    },

    enableDesktopAlerts: function () {
      if (!('Notification' in window)) {
        return showToast('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือนบนเดสก์ท็อป', 'error');
      }
      // Must be called from a click — browsers reject the prompt otherwise.
      Notification.requestPermission().then(function (result) {
        if (result === 'granted') {
          new Notification('Spare Part Management', { body: 'เปิดการแจ้งเตือนแล้ว', icon: 'assets/logo.svg' });
          showToast('เปิดการแจ้งเตือนบนเดสก์ท็อปแล้ว', 'success');
        } else {
          showToast('ไม่ได้รับอนุญาต — เปิดสิทธิ์แจ้งเตือนให้เว็บนี้ในตั้งค่าเบราว์เซอร์', 'error');
        }
        render();
      });
    },

    submitAddItem: function () {
      guarded('addItem', function () {
        var f = state.newItemForm;
        var direct = canDirectStock();
        if (!f.code.trim()) {
          f.error = 'กรุณากรอกชื่ออุปกรณ์';
          return render();
        }
        var qty = f.qty === '' ? 0 : parseInt(f.qty, 10);
        var min = direct ? (f.min === '' ? 0 : parseInt(f.min, 10)) : null;
        var max = direct ? (f.max === '' ? 0 : parseInt(f.max, 10)) : null;
        var numbersOk = !isNaN(qty) && qty >= 0 && (!direct || (!isNaN(min) && min >= 0 && !isNaN(max) && max >= 0));
        if (!numbersOk) {
          f.error = 'จำนวน, Min และ Max ต้องเป็นตัวเลขไม่ติดลบ';
          return render();
        }
        return Promise.resolve(supabaseClient.rpc('submit_stock_item', {
          p_code: f.code.trim(), p_category: f.category.trim(), p_unit: f.unit.trim(),
          p_qty: qty, p_min: min, p_max: max, p_date: f.date || todayStr()
        })).then(function (res) {
          if (res && res.error) {
            f.error = errorMessage(res.error, direct ? 'เพิ่มอุปกรณ์ไม่สำเร็จ' : 'ส่งคำขอไม่สำเร็จ');
            return render();
          }
          state.newItemForm = { date: todayStr(), code: '', category: '', unit: '', qty: '', min: '1', max: '1', error: '' };
          // A starting qty > 0 also creates a receive transaction (see
          // db/stock_item_receive_log.sql), so both need refreshing.
          return Promise.all([refreshStock(), refreshTransactions()]).then(function () {
            showToast(direct ? 'เพิ่มอุปกรณ์ใหม่สำเร็จ' : 'ส่งคำขอเพิ่มอุปกรณ์สำเร็จ กรุณารอ Admin หรือ Supervisor อนุมัติ', 'success');
          });
        });
      });
    },

    approveStockItem: function (el) {
      var id = Number(el.dataset.id);
      var card = el.closest('.pending-item');
      var min = parseInt(card.querySelector('[data-field="min"]').value, 10);
      var max = parseInt(card.querySelector('[data-field="max"]').value, 10);
      if (isNaN(min) || min < 0 || isNaN(max) || max < 0) {
        return showToast('กรุณากรอกค่า Min/Max เป็นตัวเลขไม่ติดลบ', 'error');
      }
      guarded('approveStockItem' + id, function () {
        return Promise.resolve(supabaseClient.rpc('approve_stock_item', { p_item_id: id, p_min: min, p_max: max }))
          .then(function (res) {
            if (res && res.error) return showToast(errorMessage(res.error, 'อนุมัติไม่สำเร็จ'), 'error');
            // Approving also approves the linked receive transaction and applies its qty.
            return Promise.all([refreshStock(), refreshTransactions()]).then(function () {
              showToast('อนุมัติอุปกรณ์ใหม่สำเร็จ', 'success');
            });
          });
      });
    },

    rejectStockItem: function (el) {
      var id = Number(el.dataset.id);
      if (!window.confirm('ยืนยันการปฏิเสธคำขอนี้? รายการจะถูกลบออก')) return;
      guarded('approveStockItem' + id, function () {
        return Promise.resolve(supabaseClient.rpc('reject_stock_item', { p_item_id: id }))
          .then(function (res) {
            if (res && res.error) return showToast(errorMessage(res.error, 'ปฏิเสธไม่สำเร็จ'), 'error');
            // Rejecting also deletes the linked receive transaction.
            return Promise.all([refreshStock(), refreshTransactions()]).then(function () {
              showToast('ปฏิเสธคำขอแล้ว', 'error');
            });
          });
      });
    },

    // -- users --------------------------------------------------------------

    userRole: function (el) {
      if (!isAdmin()) return;
      var id = el.dataset.id;
      var role = el.value;
      guarded('userRole' + id, function () {
        return supabaseClient.rpc('set_user_role', { p_user_id: id, p_role: role }).then(function (res) {
          if (res.error) return showToast(errorMessage(res.error, 'ปรับสิทธิ์ไม่สำเร็จ'), 'error');
          if (state.currentUser && state.currentUser.id === id) state.currentUser.role = role;
          return refreshProfiles();
        });
      });
    },

    deleteUser: function (el) {
      var id = el.dataset.id;
      if (id === state.currentUser.id) {
        return showToast('ไม่สามารถลบบัญชีที่ใช้งานอยู่ได้', 'error');
      }
      if (!window.confirm('ยืนยันการลบบัญชีผู้ใช้งานนี้?\n\nประวัติการรับ-จ่ายที่ผู้ใช้นี้ทำไว้จะยังคงอยู่ในระบบ พร้อมชื่อผู้ดำเนินการเดิม')) return;
      guarded('deleteUser' + id, function () {
        return supabaseClient.rpc('delete_user', { p_user_id: id }).then(function (res) {
          if (res.error) return showToast(errorMessage(res.error, 'ลบไม่สำเร็จ'), 'error');
          return refreshProfiles().then(function () {
            showToast('ลบบัญชีผู้ใช้งานสำเร็จ', 'success');
          });
        });
      });
    },

    approveUser: function (el) {
      var id = el.dataset.id;
      guarded('approveUser' + id, function () {
        return supabaseClient.rpc('approve_user', { p_user_id: id }).then(function (res) {
          if (res.error) return showToast(errorMessage(res.error, 'อนุมัติไม่สำเร็จ'), 'error');
          return refreshProfiles().then(function () {
            showToast('อนุมัติบัญชีผู้ใช้งานสำเร็จ', 'success');
          });
        });
      });
    },

    rejectUser: function (el) {
      var id = el.dataset.id;
      guarded('rejectUser' + id, function () {
        return supabaseClient.rpc('reject_user', { p_user_id: id }).then(function (res) {
          if (res.error) return showToast(errorMessage(res.error, 'ปฏิเสธไม่สำเร็จ'), 'error');
          return refreshProfiles().then(function () {
            showToast('ปฏิเสธการสมัครบัญชีแล้ว', 'error');
          });
        });
      });
    },

    // -- export -------------------------------------------------------------

    exportLog: function () {
      var rows = [['วันที่', 'เวลา', 'ประเภท', 'อุปกรณ์', 'จำนวน', 'หมายเหตุ', 'ผู้ดำเนินการ', 'ผู้อนุมัติ', 'สถานะ']];
      filteredTransactions().forEach(function (t) {
        rows.push([
          formatDateThai(t.date),
          t.time,
          t.type === 'in' ? 'รับเข้า' : 'จ่ายออก',
          t.itemCode,
          (t.type === 'in' ? '+' : '-') + t.qty,
          t.note || '-',
          t.userName,
          t.approverName || '-',
          STATUS_LABEL[t.status] || t.status
        ]);
      });
      downloadCsv(rows, 'log_' + todayStr() + '.csv');
    },

    /** Exports exactly what the filters are showing, so the file matches the screen. */
    exportInventory: function () {
      var rows = [['#', 'อุปกรณ์', 'หมวดหมู่', 'หน่วย', 'คงเหลือ', 'Min', 'Max', 'สถานะ']];
      filteredStock().forEach(function (it) {
        var st = stockStatus(it);
        rows.push([it.id, it.code, it.category, it.unit, it.qty, it.min, it.max, STATUS_LABEL[st]]);
      });
      downloadCsv(rows, 'inventory_' + todayStr() + '.csv');
    }
  };

  /** Writes the caller's own picture and keeps the copies held in state in step. */
  function saveMyAvatar(dataUrl, successMsg) {
    // rpc() returns a thenable with no .catch(), so wrap before chaining.
    return Promise.resolve(supabaseClient.rpc('set_my_avatar', { p_avatar: dataUrl }))
      .then(function (res) {
        if (res && res.error) throw res.error;
        var id = state.currentUser.id;
        state.currentUser.avatar = dataUrl;
        // The user list holds its own copy, so the sidebar and จัดการผู้ใช้งาน
        // do not disagree until the next reload.
        state.users = state.users.map(function (u) {
          return u.id === id ? Object.assign({}, u, { avatar: dataUrl }) : u;
        });
        showToast(successMsg, 'success');
      });
  }

  function updateStockMinMax(el, field) {
    var id = Number(el.dataset.id);
    var n = parseInt(el.value, 10);
    if (isNaN(n) || n < 0) return render();
    guarded('stock' + field + id, function () {
      return supabaseClient.rpc('update_stock_minmax', { p_item_id: id, p_field: field, p_value: n }).then(function (res) {
        if (res.error) return showToast(errorMessage(res.error, 'อัปเดตไม่สำเร็จ'), 'error');
        return refreshStock().then(function () {
          showToast('อัปเดตค่า Min/Max สำเร็จ', 'success');
        });
      });
    });
  }

  /** Shared handler for the receive ('in') and issue ('out') forms. */
  function submitMovement(type) {
    var f = type === 'in' ? state.receiveForm : state.issueForm;
    var item = findByCode(f.itemQuery);
    var qty = parseInt(f.qty, 10);

    if (!item || !qty || qty <= 0) {
      f.error = 'กรุณาเลือกอุปกรณ์จากรายการและระบุจำนวนให้ถูกต้อง';
      return render();
    }
    if (type === 'out' && canDirectStock() && qty > item.qty) {
      f.error = 'จำนวนขอเบิกมากกว่าจำนวนคงเหลือใน Stock';
      return render();
    }

    return supabaseClient.rpc('submit_transaction', {
      p_item_id: item.id, p_type: type, p_qty: qty, p_note: f.note || '', p_tx_date: f.date
    }).then(function (res) {
      if (res.error) {
        f.error = errorMessage(res.error, 'บันทึกไม่สำเร็จ');
        return render();
      }
      var blank = { date: todayStr(), itemQuery: '', category: '', unit: '', qty: '', note: '', error: '' };
      if (type === 'in') state.receiveForm = blank; else state.issueForm = blank;

      var direct = canDirectStock();
      return Promise.all([refreshStock(), refreshTransactions()]).then(function () {
        if (type === 'in') {
          showToast(direct ? 'บันทึกรับอะไหล่เข้าสำเร็จ' : 'ส่งคำขอรับเข้ารออนุมัติแล้ว', 'success');
        } else {
          showToast(direct ? 'บันทึกจ่ายอะไหล่ออกสำเร็จ' : 'ส่งคำขอเบิกรออนุมัติแล้ว', 'success');
        }
      });
    });
  }

  // ------------------------------------------------------------------- views

  function avatarStyle(url) {
    return url ? 'background-image:url(' + String(url).replace(/["')]/g, '') + ')' : '';
  }

  function loadingView() {
    return html`
      <div class="auth-wrap">
        <div style="color:#fff;font-size:14px;opacity:.85;">กำลังโหลด...</div>
      </div>`;
  }

  function configErrorView() {
    return html`
      <div class="auth-wrap">
        <div class="auth-card" style="width:480px;">
          <div class="auth-title" style="color:#dc2626;">ยังไม่พร้อมใช้งาน</div>
          <div class="alert alert--error" style="margin-top:14px;">${configError}</div>
        </div>
      </div>`;
  }

  function loginView() {
    var f = state.loginForm;
    return html`
      <div class="auth-wrap">
        <div class="auth-card">
          <div class="auth-logo"><img src="assets/logo.svg" alt="โลโก้ระบบ"/></div>
          <div class="auth-title">เข้าสู่ระบบ</div>
          <div class="auth-sub">กรุณาเข้าสู่ระบบเพื่อใช้งานระบบ</div>

          ${f.error ? raw(html`<div class="alert alert--error">${f.error}</div>`) : ''}
          ${!f.error && state.toast.msg ? raw(html`<div class="alert alert--error">${state.toast.msg}</div>`) : ''}

          <div class="field">
            <div class="field-label">User</div>
            <input class="input" type="text" placeholder="กรอกชื่อผู้ใช้" autocomplete="username"
                   data-key="login.username" data-model="loginForm.username" value="${f.username}"/>
          </div>
          <div class="field" style="margin-bottom:8px;">
            <div class="field-label">Password</div>
            <div class="pw-field">
              <input class="input" type="${f.showPw ? 'text' : 'password'}" placeholder="กรอกรหัสผ่าน" autocomplete="current-password"
                     data-key="login.password" data-model="loginForm.password" value="${f.password}"/>
              <button class="pw-toggle" type="button" data-act="toggleLoginPw">${f.showPw ? 'ซ่อน' : 'แสดง'}</button>
            </div>
          </div>

          <button class="btn btn--blue auth-submit" data-act="submitLogin">เข้าสู่ระบบ</button>

          <div class="auth-foot">ยังไม่มีบัญชี? <a href="#" class="link" data-act="goSignup">สร้างบัญชีใช้งาน</a></div>
        </div>
      </div>`;
  }

  function signupView() {
    var f = state.signupForm;
    return html`
      <div class="auth-wrap">
        <div class="auth-card auth-card--signup">
          <div class="auth-title">สร้างบัญชีใช้งาน</div>
          <div class="auth-sub">บัญชีใหม่จะได้รับสิทธิ์ระดับ Operator เริ่มต้น</div>

          <div class="avatar-pick">
            <div class="avatar-circle" style="${avatarStyle(f.avatar)}">
              ${f.avatar ? '' : raw('<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#98a2b3" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICON.person + '</svg>')}
            </div>
            <label>
              เลือกรูปโปรไฟล์
              <input type="file" accept="image/*" data-act-change="signupAvatar"/>
            </label>
          </div>

          ${f.error ? raw(html`<div class="alert alert--error">${f.error}</div>`) : ''}
          ${f.success ? raw(html`<div class="alert alert--success">${f.success}</div>`) : ''}
          ${!f.error && !f.success && state.toast.msg ? raw(html`<div class="alert alert--error">${state.toast.msg}</div>`) : ''}

          <div class="grid-2">
            <div>
              <div class="field-label">User</div>
              <input class="input" type="text" placeholder="ชื่อผู้ใช้" autocomplete="username"
                     data-key="signup.username" data-model="signupForm.username" value="${f.username}"/>
            </div>
            <div>
              <div class="field-label">Password</div>
              <input class="input" type="password" placeholder="รหัสผ่าน" autocomplete="new-password"
                     data-key="signup.password" data-model="signupForm.password" value="${f.password}"/>
            </div>
          </div>
          <div class="field" style="margin-bottom:12px;">
            <div class="field-label">ชื่อ-นามสกุล</div>
            <input class="input" type="text" placeholder="กรอกชื่อ-นามสกุล"
                   data-key="signup.name" data-model="signupForm.name" value="${f.name}"/>
          </div>
          <div class="field" style="margin-bottom:8px;">
            <div class="field-label">Email</div>
            <input class="input" type="text" inputmode="email" placeholder="กรอกอีเมล" autocomplete="email"
                   data-key="signup.email" data-model="signupForm.email" value="${f.email}"/>
          </div>

          <button class="btn btn--blue" style="margin-top:16px;" data-act="submitSignup">สมัครใช้งาน</button>
          <div class="auth-foot">มีบัญชีแล้ว? <a href="#" class="link" data-act="goLogin">เข้าสู่ระบบ</a></div>
        </div>
      </div>`;
  }

  function navItem(page, label, badge) {
    return html`
      <button class="nav-item ${state.page === page ? 'is-active' : ''}" data-act="nav" data-page="${page}">
        ${icon(page, 19)}
        <span>${label}</span>
        ${badge ? raw(html`<span class="nav-badge">${badge}</span>`) : ''}
      </button>`;
  }

  function sidebar() {
    var cu = state.currentUser;
    return html`
      <div class="sidebar">
        <div class="brand">
          <img src="assets/logo.svg" alt=""/>
          <div style="min-width:0;">
            <div class="brand-name">Spare Part</div>
            <div class="brand-sub">Management</div>
          </div>
        </div>

        <div class="user-card">
          <div class="user-avatar" style="${avatarStyle(cu.avatar)}">${cu.avatar ? '' : (cu.name || '').charAt(0)}</div>
          <div class="user-meta">
            <div class="user-name">${cu.name}</div>
            <div class="user-role">${ROLE_LABEL[cu.role] || cu.role}</div>
          </div>
        </div>

        <div class="nav">
          ${raw(navItem('overview', 'Overview'))}
          ${raw(navItem('receive', 'รับอะไหล่เข้า', canDirectStock() ? pendingStockItems().length : 0))}
          ${raw(navItem('issue', 'จ่ายอะไหล่ออก'))}
          ${raw(navItem('log', 'ประวัติ/Log', pendingTransactions().length))}
          ${raw(navItem('inventory', 'รายการอุปกรณ์'))}
          ${canDirectStock() ? raw(navItem('users', 'จัดการผู้ใช้งาน', pendingUsers().length)) : ''}
          ${raw(navItem('settings', 'ตั้งค่า'))}
        </div>

        <button class="logout-btn" data-act="logout">${icon('logout', 18)}ออกจากระบบ</button>
      </div>`;
  }

  function overviewPage() {
    var stats = donutStats();
    var total = activeStock().length;
    var monthNow = todayStr().slice(0, 7);
    var approved = state.transactions.filter(function (t) { return t.status === 'approved'; });
    var kpiIn = approved.filter(function (t) { return t.type === 'in' && t.date.slice(0, 7) === monthNow; }).length;
    var kpiOut = approved.filter(function (t) { return t.type === 'out' && t.date.slice(0, 7) === monthNow; }).length;
    var lowItems = activeStock().filter(function (it) { return it.qty < it.min; });
    var top = topIssuedItems();

    var segments = donutSegments();
    var donutGradient = total
      ? 'conic-gradient(' + segments.map(function (seg) {
          return seg.color + ' ' + seg.from + 'deg ' + seg.to + 'deg';
        }).join(', ') + ')'
      : '#eef1f6';

    return html`
      <div class="kpi-grid">
        <div class="card kpi">
          <div class="kpi-label">รับเข้า (เดือนนี้)</div>
          <div class="kpi-value kpi-value--in">${kpiIn}</div>
          <div class="kpi-unit">รายการ</div>
        </div>
        <div class="card kpi">
          <div class="kpi-label">จ่ายออก (เดือนนี้)</div>
          <div class="kpi-value kpi-value--out">${kpiOut}</div>
          <div class="kpi-unit">รายการ</div>
        </div>
        <div class="card kpi">
          <div class="kpi-label">คงเหลือทั้งหมด</div>
          <div class="kpi-value">${total}</div>
          <div class="kpi-unit">รายการอุปกรณ์</div>
        </div>
        <div class="card kpi">
          <div class="kpi-label">ต่ำกว่าค่า Min</div>
          <div class="kpi-value kpi-value--low">${lowItems.length}</div>
          <div class="kpi-unit">รายการ</div>
        </div>
      </div>

      <div class="row-chart">
        <div class="card">
          <div class="chart-head">
            <div class="card-title" style="margin-bottom:0;">สรุปการรับ-จ่าย</div>
            <div class="legend">
              <span><span class="legend-dot legend-dot--in"></span>รับเข้า</span>
              <span><span class="legend-dot legend-dot--out"></span>จ่ายออก</span>
            </div>
          </div>
          <div class="daterange">
            <span>จาก</span>
            ${raw(dateField('chart.from', 'chartFilter.from', state.chartFilter.from, 'sm'))}
            <span>ถึง</span>
            ${raw(dateField('chart.to', 'chartFilter.to', state.chartFilter.to, 'sm'))}
          </div>
          <div class="chart" data-scroll-key="chart">
            ${chartData().map(function (bar) {
              return raw(html`
                <div class="bar-col">
                  <div class="bar-stack">
                    <div class="bar bar--in" title="รับเข้า ${bar.inQty}" style="height:${bar.inH}px;"></div>
                    <div class="bar bar--out" title="จ่ายออก ${bar.outQty}" style="height:${bar.outH}px;"></div>
                  </div>
                  <div class="bar-vals">
                    <div class="bar-val bar-val--in">${bar.inQty}</div>
                    <div class="bar-val bar-val--out">${bar.outQty}</div>
                  </div>
                  <div class="bar-label">${bar.label}</div>
                </div>`);
            })}
          </div>
        </div>

        <div class="card">
          <div class="card-title">รายการต่ำกว่า Min</div>
          <div class="low-list" data-scroll-key="low">
            ${lowItems.slice(0, 6).map(function (it) {
              return raw(html`
                <div class="low-item">
                  <div style="min-width:0;">
                    <div class="low-code">${it.code}</div>
                    <div class="low-cat">${it.category}</div>
                  </div>
                  <div class="low-qty">${it.qty}/${it.min} ${it.unit}</div>
                </div>`);
            })}
            ${lowItems.length ? '' : raw('<div class="muted-note">ไม่มีรายการต่ำกว่าค่า Min</div>')}
          </div>
        </div>
      </div>

      <div class="row-bottom">
        <div class="card">
          <div class="card-title">Top อุปกรณ์ที่ถูกเบิกเยอะสุด</div>
          <div class="top-list">
            ${top.map(function (it) {
              return raw(html`
                <div>
                  <div class="top-head">
                    <div class="top-code">${it.code}</div>
                    <div class="top-total">${it.total} ${it.unit}</div>
                  </div>
                  <div class="top-track"><div class="top-fill" style="width:${it.barPct}%;"></div></div>
                </div>`);
            })}
            ${top.length ? '' : raw('<div class="muted-note">ยังไม่มีข้อมูลการเบิกจ่าย</div>')}
          </div>
        </div>

        <div class="card">
          <div class="card-title">Stock คงเหลือตามช่วง Min-Max</div>
          <div class="donut-row">
            <div class="donut donut--clickable" data-act="donutJump" title="คลิกที่วงหรือรายการด้านข้างเพื่อดูอุปกรณ์ตามสถานะ">
              <div class="donut-ring" style="background:${donutGradient};"></div>
              <div class="donut-hole">
                <div class="donut-value">${total}</div>
                <div class="donut-unit">รายการ</div>
              </div>
            </div>
            <div class="donut-legend">
              ${segments.map(function (seg) {
                return raw(html`
                  <button class="donut-legend-row" data-act="filterByStatus" data-status="${seg.key}">
                    <span class="swatch" style="background:${seg.color};"></span>
                    <span>${seg.label} <b>${seg.count}</b> รายการ</span>
                  </button>`);
              })}
            </div>
          </div>
          <div class="donut-hint">คลิกเพื่อดูรายการอุปกรณ์ตามสถานะ</div>
        </div>
      </div>`;
  }

  function dateField(key, model, value, size) {
    return html`
      <div class="date-wrap date-wrap--${size}">
        <input type="date" lang="en-GB" data-key="${key}" data-model="${model}" data-act="openDatePicker" value="${value}"/>
        <div class="date-display">${value ? formatDateThai(value) : 'วัน-เดือน-ปี'}</div>
      </div>`;
  }

  function datalist(id, values) {
    return html`<datalist id="${id}">${values.map(function (v) {
      return raw(html`<option value="${v}"></option>`);
    })}</datalist>`;
  }

  /** The receive and issue forms differ only in copy, colour and the stock hint. */
  /** Tab bar shared by รับอะไหล่เข้า and its เพิ่มอุปกรณ์ใหม่ sibling, then delegates to whichever is active. */
  function receiveSection() {
    var pendingCount = canDirectStock() ? pendingStockItems().length : 0;
    return html`
      <div class="tabbar">
        <button class="tab ${state.receiveTab === 'receive' ? 'is-active' : ''}" data-act="receiveTab" data-tab="receive">รับอะไหล่เข้า</button>
        <button class="tab ${state.receiveTab === 'addItem' ? 'is-active' : ''}" data-act="receiveTab" data-tab="addItem">
          เพิ่มอุปกรณ์ใหม่ ${pendingCount ? raw(html`<span class="tab-badge">${pendingCount}</span>`) : ''}
        </button>
      </div>
      ${state.receiveTab === 'addItem' ? raw(addItemPage()) : raw(movementPage('in'))}`;
  }

  /**
   * Operator submits a request that waits for approval; Admin/Supervisor add an item
   * directly and set Min/Max themselves in the same step (mirrors how submit_transaction
   * already treats direct vs. pending receive/issue). Admin/Supervisor additionally see
   * everyone's pending requests here to approve or reject.
   */
  function addItemPage() {
    var f = state.newItemForm;
    var direct = canDirectStock();
    var pending = direct ? pendingStockItems() : [];

    return html`
      ${pending.length ? raw(html`
        <div class="pending-card">
          <div class="pending-title">คำขอเพิ่มอุปกรณ์รอการอนุมัติ (${pending.length})</div>
          <div class="pending-list">
            ${pending.map(function (it) {
              // it.qty stays 0 while pending — the requested quantity lives on the
              // linked receive transaction until approval applies it (see
              // db/stock_item_receive_log.sql), so look that up for display.
              var receipt = state.transactions.find(function (t) {
                return t.itemId === it.id && t.note === NEW_ITEM_RECEIVE_NOTE && t.status === 'pending';
              });
              return raw(html`
                <div class="pending-item pending-item--stock">
                  <div class="pending-main">
                    <div class="pending-head">${it.code}</div>
                    <div class="pending-meta">${it.category || 'ไม่ระบุหมวดหมู่'} · ${it.unit || 'ไม่ระบุหน่วย'} · จำนวนเริ่มต้น ${receipt ? receipt.qty : 0} (${receipt ? formatDateThai(receipt.date) : '-'}) · ขอโดย ${it.requestedName || '-'}</div>
                    <div class="pending-approve-fields">
                      <div>
                        <div class="sub-label">Min</div>
                        <input class="input input--sm" type="text" inputmode="numeric" pattern="[0-9]*" data-field="min" value="1"/>
                      </div>
                      <div>
                        <div class="sub-label">Max</div>
                        <input class="input input--sm" type="text" inputmode="numeric" pattern="[0-9]*" data-field="max" value="1"/>
                      </div>
                    </div>
                  </div>
                  <div class="pending-actions">
                    <button class="btn-sm btn-approve" data-act="approveStockItem" data-id="${it.id}">อนุมัติ</button>
                    <button class="btn-sm btn-reject" data-act="rejectStockItem" data-id="${it.id}">ปฏิเสธ</button>
                  </div>
                </div>`);
            })}
          </div>
        </div>`) : ''}

      <div class="card form-card">
        ${direct ? '' : raw(html`<div class="alert alert--warn">คำขอของคุณจะถูกส่งไปรออนุมัติจาก Supervisor/Admin — ผู้อนุมัติจะเป็นผู้กำหนดค่า Min/Max ให้</div>`)}
        ${f.error ? raw(html`<div class="alert alert--error" style="font-size:12.5px;">${f.error}</div>`) : ''}

        <div class="field">
          <div class="field-label">วันที่รับ</div>
          <input class="input input--form" type="date" data-key="newitem.date" data-model="newItemForm.date" value="${f.date}"/>
        </div>

        <div class="field">
          <div class="field-label">ชื่ออุปกรณ์</div>
          <input class="input input--form" type="text" placeholder="เช่น สายไฟ VCT-G"
                 data-key="newitem.code" data-model="newItemForm.code" value="${f.code}"/>
        </div>
        <div class="form-row">
          <div>
            <div class="sub-label">หมวดหมู่</div>
            <input class="input input--sm" type="text" list="newItemCategoryList" placeholder="เช่น สายไฟชุดเต้ารับ"
                   data-key="newitem.category" data-model="newItemForm.category" value="${f.category}"/>
            ${raw(datalist('newItemCategoryList', categories()))}
          </div>
          <div>
            <div class="sub-label">หน่วย</div>
            <input class="input input--sm" type="text" list="newItemUnitList" placeholder="เช่น ม้วน"
                   data-key="newitem.unit" data-model="newItemForm.unit" value="${f.unit}"/>
            ${raw(datalist('newItemUnitList', units()))}
          </div>
        </div>

        <div class="field" style="margin-top:14px;">
          <div class="field-label">จำนวนเริ่มต้น</div>
          <input class="input input--form" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="0"
                 data-key="newitem.qty" data-model="newItemForm.qty" value="${f.qty}"/>
        </div>

        ${direct ? raw(html`
          <div class="form-row">
            <div>
              <div class="sub-label">Min</div>
              <input class="input input--sm" type="text" inputmode="numeric" pattern="[0-9]*"
                     data-key="newitem.min" data-model="newItemForm.min" value="${f.min}"/>
            </div>
            <div>
              <div class="sub-label">Max</div>
              <input class="input input--sm" type="text" inputmode="numeric" pattern="[0-9]*"
                     data-key="newitem.max" data-model="newItemForm.max" value="${f.max}"/>
            </div>
          </div>`) : ''}

        <div class="meta-line" style="margin-top:14px;">${direct ? 'ผู้เพิ่ม' : 'ผู้ขอเพิ่ม'}: ${state.currentUser.name} (${state.currentUser.username})</div>
        <button class="btn btn--green" data-act="submitAddItem">${direct ? 'บันทึกอุปกรณ์ใหม่' : 'ส่งคำขอเพิ่มอุปกรณ์'}</button>
      </div>`;
  }

  function movementPage(type) {
    var f = type === 'in' ? state.receiveForm : state.issueForm;
    var prefix = type === 'in' ? 'receive' : 'issue';
    // Resolved for both directions now: seeing the picture and the balance while
    // receiving is the same guard against picking the wrong part as when issuing.
    var selected = findByCode(f.itemQuery);

    return html`
      <div class="card form-card">
        ${canDirectStock() ? '' : raw(html`<div class="alert alert--warn">${type === 'in'
          ? 'คำขอของคุณจะถูกส่งไปรออนุมัติจาก Supervisor/Admin ก่อนบันทึกเข้า Stock'
          : 'คำขอเบิกของคุณจะถูกส่งไปรออนุมัติจาก Supervisor/Admin ก่อนตัด Stock'}</div>`)}
        ${f.error ? raw(html`<div class="alert alert--error" style="font-size:12.5px;">${f.error}</div>`) : ''}

        <div class="field">
          <div class="field-label">วันที่</div>
          <input class="input input--form" type="date" data-key="${prefix}.date" data-model="${prefix}Form.date" value="${f.date}"/>
        </div>

        <div class="field">
          <div class="field-label">อุปกรณ์</div>
          <input class="input input--form" type="text" list="${prefix}ItemsList" placeholder="พิมพ์ค้นหาหรือเลือกอุปกรณ์..."
                 data-key="${prefix}.item" data-act-input="${prefix}Item" value="${f.itemQuery}"/>
          ${raw(datalist(prefix + 'ItemsList', activeStock().map(function (s) { return s.code; })))}
          <div class="form-row">
            <div>
              <div class="sub-label">หมวดหมู่</div>
              <input class="input input--sm" type="text" list="${prefix}CategoryList"
                     data-key="${prefix}.category" data-model="${prefix}Form.category" value="${f.category}"/>
              ${raw(datalist(prefix + 'CategoryList', categories()))}
            </div>
            <div>
              <div class="sub-label">หน่วย</div>
              <input class="input input--sm" type="text" list="${prefix}UnitList"
                     data-key="${prefix}.unit" data-model="${prefix}Form.unit" value="${f.unit}"/>
              ${raw(datalist(prefix + 'UnitList', units()))}
            </div>
          </div>
          ${selected ? raw(itemPreview(selected)) : ''}
        </div>

        <div class="field">
          <div class="field-label">${type === 'in' ? 'จำนวนรับเข้า' : 'จำนวนขอเบิก'}</div>
          <input class="input input--form" type="text" inputmode="numeric" pattern="[0-9]*" placeholder="0"
                 data-key="${prefix}.qty" data-model="${prefix}Form.qty" value="${f.qty}"/>
        </div>

        <div class="field" style="margin-bottom:8px;">
          <div class="field-label">หมายเหตุ</div>
          <textarea class="textarea input--form" placeholder="ระบุหมายเหตุ (ถ้ามี)"
                    data-key="${prefix}.note" data-model="${prefix}Form.note">${f.note}</textarea>
        </div>

        <div class="meta-line">${type === 'in' ? 'ผู้รับเข้า' : 'ผู้ขอเบิก'}: ${state.currentUser.name} (${state.currentUser.username})</div>
        <button class="btn ${type === 'in' ? 'btn--green' : 'btn--red'}" data-act="${type === 'in' ? 'submitReceive' : 'submitIssue'}">บันทึกข้อมูล</button>
      </div>`;
  }

  function logPage() {
    var pending = pendingTransactions();
    var rows = filteredTransactions();

    return html`
      ${canDirectStock() && pending.length ? raw(html`
        <div class="pending-card">
          <div class="pending-title">รายการรออนุมัติ (${pending.length})</div>
          <div class="pending-list">
            ${pending.map(function (tx) {
              return raw(html`
                <div class="pending-item">
                  <div class="pending-main">
                    <div class="pending-head">${tx.type === 'in' ? 'รับเข้า' : 'จ่ายออก'} · ${tx.itemCode} · ${tx.qty} ${tx.unit}</div>
                    <div class="pending-meta">${formatDateThai(tx.date)} ${tx.time} · ขอโดย ${tx.userName}</div>
                    <div class="pending-note">หมายเหตุ: ${tx.note || '-'}</div>
                  </div>
                  <div class="pending-actions">
                    <button class="btn-sm btn-approve" data-act="approveTx" data-id="${tx.id}">อนุมัติ</button>
                    <button class="btn-sm btn-reject" data-act="rejectTx" data-id="${tx.id}">ปฏิเสธ</button>
                  </div>
                </div>`);
            })}
          </div>
        </div>`) : ''}

      <div class="card">
        <div class="section-head">
          <div class="section-title">ประวัติการรับ-จ่ายอะไหล่</div>
          <button class="btn-export" data-act="exportLog">${icon('receive', 14)}Export Excel</button>
        </div>

        <div class="toolbar">
          <input class="input" type="text" placeholder="ค้นหารหัสอุปกรณ์..."
                 data-key="log.search" data-model="logFilter.search" value="${state.logFilter.search}"/>
          <select class="select" data-key="log.type" data-model="logFilter.type">
            ${selectOptions([['all', 'ทุกประเภท'], ['in', 'รับเข้า'], ['out', 'จ่ายออก']], state.logFilter.type)}
          </select>
          <select class="select" data-key="log.status" data-model="logFilter.status">
            ${selectOptions([['all', 'ทุกสถานะ'], ['approved', 'อนุมัติแล้ว'], ['pending', 'รออนุมัติ'], ['rejected', 'ปฏิเสธ']], state.logFilter.status)}
          </select>
          <div class="toolbar-dates">
            <span>จาก</span>
            ${raw(dateField('log.from', 'logFilter.dateFrom', state.logFilter.dateFrom, 'md'))}
            <span>ถึง</span>
            ${raw(dateField('log.to', 'logFilter.dateTo', state.logFilter.dateTo, 'md'))}
          </div>
        </div>

        <table class="table">
          <thead>
            <tr>
              <th>วันที่</th><th>เวลา</th><th>ประเภท</th><th>อุปกรณ์</th>
              <th class="num">จำนวน</th><th>หมายเหตุ</th><th>ผู้ดำเนินการ</th><th>ผู้อนุมัติ</th><th class="mid">สถานะ</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(function (t) {
              return raw(html`
                <tr>
                  <td class="soft">${formatDateThai(t.date)}</td>
                  <td class="soft">${t.time}</td>
                  <td><span class="badge badge--${t.type}">${t.type === 'in' ? 'รับเข้า' : 'จ่ายออก'}</span></td>
                  <td class="strong">${t.itemCode}</td>
                  <td class="num" style="font-weight:600;">${(t.type === 'in' ? '+' : '-') + t.qty} ${t.unit}</td>
                  <td class="note-cell" title="${t.note || ''}">${t.note || '-'}</td>
                  <td class="soft">${t.userName}</td>
                  <td class="soft">${t.approverName || '-'}</td>
                  <td class="mid"><span class="badge badge--${t.status}">${STATUS_LABEL[t.status] || t.status}</span></td>
                </tr>`);
            })}
            ${rows.length ? '' : raw('<tr><td class="empty" colspan="9">ไม่พบรายการที่ตรงกับเงื่อนไข</td></tr>')}
          </tbody>
        </table>
      </div>`;
  }

  function selectOptions(pairs, selected) {
    return pairs.map(function (p) {
      return raw(html`<option value="${p[0]}" ${p[0] === selected ? raw('selected') : ''}>${p[1]}</option>`);
    });
  }

  /**
   * Confirmation card for the part currently typed into a receive/issue form:
   * picture, code and the balance on hand, so a mistyped code is obvious before
   * the movement is saved. Falls back to a placeholder when no picture is stored.
   */
  function itemPreview(item) {
    var img = state.stockImages[item.id];
    var status = stockStatus(item);
    return html`
      <div class="item-preview">
        ${img
          ? raw(html`<div class="item-preview-img" style="background-image:url(${img})"></div>`)
          : raw(html`<div class="item-preview-img item-preview-img--empty">${icon('inventory', 20)}</div>`)}
        <div class="item-preview-body">
          <div class="item-preview-code">${item.code}</div>
          <div class="item-preview-meta">
            คงเหลือ <b>${item.qty}</b> ${item.unit} · Min ${item.min} / Max ${item.max}
            <span class="badge badge--${status}">${STATUS_LABEL[status]}</span>
          </div>
        </div>
      </div>`;
  }

  /**
   * Thumbnail cell for one stock row. For Admin/Supervisor the whole thumbnail is a
   * file picker, so adding a picture is one click on the row itself; everyone else
   * just sees the picture.
   */
  function stockThumb(item, editable) {
    var img = state.stockImages[item.id];
    var inner = img
      ? html`<div class="thumb" style="background-image:url(${img})"></div>`
      : html`<div class="thumb thumb--empty">${icon('inventory', 16)}</div>`;

    if (!editable) return inner;

    return html`
      <div class="thumb-wrap">
        <label class="thumb-pick" title="${img ? 'เปลี่ยนรูป' : 'เพิ่มรูป'}">
          ${raw(inner)}
          <input type="file" accept="image/*" data-act-change="stockImage" data-id="${item.id}"/>
        </label>
        ${img ? raw(html`<button class="thumb-remove" title="ลบรูป" data-act="removeStockImage" data-id="${item.id}">&times;</button>`) : ''}
      </div>`;
  }

  function inventoryPage() {
    var editable = canDirectStock();
    var rows = filteredStock();

    return html`
      <div class="card">
        <div class="section-head">
          <div class="section-title">รายการอุปกรณ์ทั้งหมด (${activeStock().length})</div>
          <button class="btn-export" data-act="exportInventory">${icon('receive', 14)}Export Excel</button>
        </div>
        <div class="toolbar">
          <input class="input" type="text" placeholder="ค้นหาอุปกรณ์..."
                 data-key="inv.search" data-model="invFilter.search" value="${state.invFilter.search}"/>
          <select class="select select--cat" data-key="inv.category" data-model="invFilter.category">
            ${selectOptions([['all', 'ทุกหมวดหมู่']].concat(categories().map(function (c) { return [c, c]; })), state.invFilter.category)}
          </select>
          <select class="select" data-key="inv.status" data-model="invFilter.status">
            ${selectOptions([['all', 'ทุกสถานะ'], ['low', 'ต่ำกว่า Min'], ['near', 'ใกล้ Min'], ['ok', 'ปกติ'], ['high', 'สูงกว่า Max']], state.invFilter.status)}
          </select>
        </div>
        <div class="filter-count">แสดง ${rows.length} จาก ${activeStock().length} รายการ</div>
        <div class="inv-scroll" data-scroll-key="inventory">
          <table class="table">
            <thead>
              <tr>
                <th>#</th><th>รูป</th><th>อุปกรณ์</th><th>หมวดหมู่</th><th>หน่วย</th>
                <th class="num">คงเหลือ</th><th class="num">Min</th><th class="num">Max</th><th class="mid">สถานะ</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(function (it) {
                var status = stockStatus(it);
                return raw(html`
                  <tr>
                    <td style="color:#98a2b3;font-size:12px;">${it.id}</td>
                    <td>${raw(stockThumb(it, editable))}</td>
                    <td class="strong">${it.code}</td>
                    <td class="soft">${it.category}</td>
                    <td class="soft">${it.unit}</td>
                    <td class="num" style="font-weight:600;">${it.qty}</td>
                    <td class="num">${editable
                      ? raw(html`<input class="mini-input" type="number" min="0" data-key="min.${it.id}" data-act-change="stockMin" data-id="${it.id}" value="${it.min}"/>`)
                      : raw(html`<span style="color:#98a2b3;">${it.min}</span>`)}</td>
                    <td class="num">${editable
                      ? raw(html`<input class="mini-input" type="number" min="0" data-key="max.${it.id}" data-act-change="stockMax" data-id="${it.id}" value="${it.max}"/>`)
                      : raw(html`<span style="color:#98a2b3;">${it.max}</span>`)}</td>
                    <td class="mid"><span class="badge badge--${status}">${STATUS_LABEL[status]}</span></td>
                  </tr>`);
              })}
              ${rows.length ? '' : raw('<tr><td class="empty" colspan="9">ไม่พบอุปกรณ์ที่ตรงกับเงื่อนไข</td></tr>')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function usersPage() {
    var admin = isAdmin();
    // Oldest request first, so the approval queue is answered in the order it arrived.
    var pending = pendingUsers().slice().sort(byCreatedAt);
    // Only approved accounts belong in the main list. Listing 'rejected' here too
    // made a rejection look like an approval — the rejected person showed up
    // indistinguishable from everyone else.
    var list = state.users
      .filter(function (u) { return u.status === 'active'; })
      .slice()
      .sort(function (a, b) {
        return (roleRank(a.role) - roleRank(b.role)) || byCreatedAt(a, b);
      });
    var rejected = state.users
      .filter(function (u) { return u.status === 'rejected'; })
      .slice()
      .sort(byCreatedAt);

    return html`
      ${pending.length ? raw(html`
        <div class="pending-card">
          <div class="pending-title">บัญชีรอการอนุมัติ (${pending.length})</div>
          <div class="pending-list">
            ${pending.map(function (u) {
              return raw(html`
                <div class="pending-item">
                  <div class="pending-main">
                    <div class="pending-head">${u.name} (${u.username})</div>
                    <div class="pending-meta">${u.email}</div>
                  </div>
                  <div class="pending-actions">
                    <button class="btn-sm btn-approve" data-act="approveUser" data-id="${u.id}">อนุมัติ</button>
                    <button class="btn-sm btn-reject" data-act="rejectUser" data-id="${u.id}">ปฏิเสธ</button>
                  </div>
                </div>`);
            })}
          </div>
        </div>`) : ''}

      ${rejected.length ? raw(html`
        <div class="pending-card pending-card--rejected">
          <div class="pending-title">บัญชีที่ถูกปฏิเสธ (${rejected.length})</div>
          <div class="pending-list">
            ${rejected.map(function (u) {
              return raw(html`
                <div class="pending-item pending-item--rejected">
                  <div class="pending-main">
                    <div class="pending-head">${u.name} (${u.username})</div>
                    <div class="pending-meta">${u.email} · เข้าสู่ระบบไม่ได้</div>
                  </div>
                  <div class="pending-actions">
                    <button class="btn-sm btn-approve" data-act="approveUser" data-id="${u.id}">อนุมัติย้อนหลัง</button>
                    ${admin ? raw(html`<button class="btn-sm btn-reject" data-act="deleteUser" data-id="${u.id}">ลบ</button>`) : ''}
                  </div>
                </div>`);
            })}
          </div>
        </div>`) : ''}

      <div class="card" style="margin-bottom:20px;">
        <div class="section-head">
          <div class="section-title">รายชื่อผู้ใช้งาน (${list.length})</div>
        </div>
        <table class="table">
          <thead>
            <tr>
              <th></th><th>ชื่อ-นามสกุล</th><th>User</th>
              <th>Email</th><th>สิทธิ์การใช้งาน</th>
              ${admin ? raw('<th class="mid">จัดการ</th>') : ''}
            </tr>
          </thead>
          <tbody>
            ${list.map(function (u) {
              return raw(html`
                <tr>
                  <td><div class="u-avatar" style="${avatarStyle(u.avatar)}">${u.avatar ? '' : raw(html`<span class="u-initial">${(u.name || '').charAt(0)}</span>`)}</div></td>
                  <td style="font-size:13px;font-weight:600;color:#101a2e;">${u.name}</td>
                  <td class="soft" style="font-size:13px;">${u.username}</td>
                  <td class="soft" style="font-size:13px;">${u.email}</td>
                  <td>${admin
                    ? raw(html`<select class="u-role-select" data-key="role.${u.id}" data-act-change="userRole" data-id="${u.id}">
                        ${selectOptions([['operator', 'Operator'], ['supervisor', 'Supervisor'], ['admin', 'Admin']], u.role)}
                      </select>`)
                    : raw(html`<span class="u-role-text">${ROLE_LABEL[u.role] || u.role}</span>`)}</td>
                  ${admin ? raw(html`<td class="mid">${u.id === state.currentUser.id ? '' :
                    raw(html`<button class="btn-delete" data-act="deleteUser" data-id="${u.id}">ลบ</button>`)}</td>`) : ''}
                </tr>`);
            })}
          </tbody>
        </table>
      </div>

      <div class="role-note">
        <b>Operator</b> — ขออนุมัติเบิกจ่ายอะไหล่ แต่ไม่มีสิทธิ์ตัดหรือเพิ่ม Stock ได้เอง<br/>
        <b>Supervisor</b> — อนุมัติการรับเข้า-จ่ายออกของ Stock ได้ทั้งหมด<br/>
        <b>Admin</b> — ทำได้ทั้งหมด รวมถึงการกำหนดสิทธิ์ผู้ใช้งาน
      </div>`;
  }

  /** Current desktop-notification permission, and the way to change it. */
  function desktopAlertControl() {
    if (!('Notification' in window)) {
      return html`<div class="notify-state notify-state--off">เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือนบนเดสก์ท็อป</div>`;
    }
    if (Notification.permission === 'granted') {
      return html`<div class="notify-state notify-state--on">เปิดการแจ้งเตือนบนเดสก์ท็อปแล้ว</div>`;
    }
    if (Notification.permission === 'denied') {
      // The browser will not re-prompt once denied; it has to be undone in site settings.
      return html`<div class="notify-state notify-state--off">
        ถูกบล็อกไว้ — เปิดสิทธิ์แจ้งเตือนให้เว็บนี้ได้ที่ไอคอนซ้ายของช่องที่อยู่เว็บ แล้วรีเฟรชหน้า
      </div>`;
    }
    return html`<button class="btn-pick" data-act="enableDesktopAlerts">เปิดการแจ้งเตือนบนเดสก์ท็อป</button>`;
  }

  function settingsPage() {
    var f = state.changePwForm;
    return html`
      <div class="card form-card form-card--narrow" style="margin-bottom:20px;">
        <div class="section-title" style="margin-bottom:16px;">รูปโปรไฟล์</div>
        <div class="my-avatar-row">
          <div class="avatar-circle my-avatar" style="${avatarStyle(state.currentUser.avatar)}">
            ${state.currentUser.avatar ? '' : raw('<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#98a2b3" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICON.person + '</svg>')}
          </div>
          <div>
            <label class="btn-pick">
              ${state.currentUser.avatar ? 'เปลี่ยนรูป' : 'เลือกรูปโปรไฟล์'}
              <input type="file" accept="image/*" data-act-change="myAvatar"/>
            </label>
            ${state.currentUser.avatar
              ? raw(html`<button class="btn-link-danger" data-act="removeMyAvatar">ลบรูป</button>`)
              : ''}
            <div class="my-avatar-hint">ระบบจะย่อรูปให้อัตโนมัติ</div>
          </div>
        </div>
      </div>

      ${canDirectStock() ? raw(html`
        <div class="card form-card form-card--narrow" style="margin-bottom:20px;">
          <div class="section-title" style="margin-bottom:6px;">การแจ้งเตือนคำขอ</div>
          <div class="notify-hint">
            แจ้งเตือนเมื่อมีคำขอเบิก/รับอะไหล่ คำขอเพิ่มอุปกรณ์ หรือบัญชีใหม่รออนุมัติ
            — แถบแจ้งเตือนในเว็บทำงานอยู่แล้ว ส่วนการแจ้งเตือนบนเดสก์ท็อปจะเด้งให้เห็นแม้สลับไปหน้าต่างอื่น
          </div>
          ${raw(desktopAlertControl())}
        </div>`) : ''}

      <div class="card form-card form-card--narrow">
        <div class="section-title" style="margin-bottom:4px;">เปลี่ยนรหัสผ่าน</div>
        <div style="font-size:13px;color:#64748b;margin-bottom:20px;">บัญชี: ${state.currentUser.username}</div>

        ${f.error ? raw(html`<div class="alert alert--error" style="font-size:12.5px;margin-bottom:14px;">${f.error}</div>`) : ''}
        ${f.success ? raw(html`<div class="alert alert--success" style="font-size:12.5px;margin-bottom:14px;">${f.success}</div>`) : ''}

        <div class="field">
          <div class="field-label">รหัสผ่านเดิม</div>
          <input class="input input--form" type="password" placeholder="กรอกรหัสผ่านเดิม" autocomplete="current-password"
                 data-key="pw.current" data-model="changePwForm.current" value="${f.current}"/>
        </div>
        <div class="field">
          <div class="field-label">รหัสผ่านใหม่</div>
          <input class="input input--form" type="password" placeholder="กรอกรหัสผ่านใหม่" autocomplete="new-password"
                 data-key="pw.next" data-model="changePwForm.next" value="${f.next}"/>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <div class="field-label">ยืนยันรหัสผ่านใหม่อีกครั้ง</div>
          <input class="input input--form" type="password" placeholder="ยืนยันรหัสผ่านใหม่" autocomplete="new-password"
                 data-key="pw.confirm" data-model="changePwForm.confirm" value="${f.confirm}"/>
        </div>
        <button class="btn btn--blue" style="margin-top:12px;" data-act="submitChangePassword">บันทึกการเปลี่ยนแปลง</button>
      </div>`;
  }

  function pageBody() {
    switch (state.page) {
      case 'receive': return receiveSection();
      case 'issue': return movementPage('out');
      case 'log': return logPage();
      case 'inventory': return inventoryPage();
      case 'users': return canDirectStock() ? usersPage() : overviewPage();
      case 'settings': return settingsPage();
      default: return overviewPage();
    }
  }

  function appView() {
    return html`
      <div class="app">
        ${raw(sidebar())}
        <div class="main" data-scroll-key="main">
          <div class="topbar">
            <div class="topbar-title">${state.page === 'receive' && state.receiveTab === 'addItem' ? 'เพิ่มอุปกรณ์ใหม่' : (PAGE_TITLE[state.page] || '')}</div>
            <div class="topbar-right">
              <div class="topbar-user">${state.currentUser.name}</div>
              <span class="topbar-role topbar-role--${state.currentUser.role}">${ROLE_LABEL[state.currentUser.role] || state.currentUser.role}</span>
            </div>
          </div>
          <div class="content">
            ${state.toast.msg ? raw(html`<div class="toast ${state.toast.type === 'error' ? 'toast--error' : ''}">${state.toast.msg}</div>`) : ''}
            ${state.requestAlerts.length ? raw(html`
              <div class="alert-stack">
                ${state.requestAlerts.map(function (a, i) {
                  return raw(html`
                    <div class="request-alert">
                      <span class="request-alert-dot"></span>
                      <span class="request-alert-text">${a.text}</span>
                      <button class="request-alert-go" data-act="openAlert" data-index="${i}">ดูรายการ</button>
                      <button class="request-alert-close" data-act="dismissAlerts" title="ปิด">&times;</button>
                    </div>`);
                })}
              </div>`) : ''}
            ${raw(pageBody())}
          </div>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------------ render

  var root = document.getElementById('root');

  function render() {
    var active = document.activeElement;
    var focusKey = active && active.dataset ? active.dataset.key : null;
    var selStart = null;
    var selEnd = null;
    if (focusKey) {
      try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (e) { /* unsupported type */ }
    }

    var scrolls = {};
    root.querySelectorAll('[data-scroll-key]').forEach(function (el) {
      scrolls[el.dataset.scrollKey] = el.scrollTop;
    });

    if (state.view === 'configError') root.innerHTML = configErrorView();
    else if (state.view === 'loading') root.innerHTML = loadingView();
    else if (state.view === 'login') root.innerHTML = loginView();
    else if (state.view === 'signup') root.innerHTML = signupView();
    else if (state.currentUser) root.innerHTML = appView();
    else root.innerHTML = loginView();

    root.querySelectorAll('[data-scroll-key]').forEach(function (el) {
      var saved = scrolls[el.dataset.scrollKey];
      if (saved) el.scrollTop = saved;
    });

    if (focusKey) {
      var next = root.querySelector('[data-key="' + focusKey.replace(/"/g, '\\"') + '"]');
      if (next) {
        next.focus();
        if (selStart !== null) {
          try { next.setSelectionRange(selStart, selEnd); } catch (e) { /* unsupported type */ }
        }
      }
    }
  }

  // ------------------------------------------------------------------ events

  function runAction(name, el, event) {
    var fn = actions[name];
    if (fn) fn(el, event);
  }

  root.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    // Date inputs use data-act only to open the native picker on click.
    if (el.tagName === 'A') e.preventDefault();
    runAction(el.dataset.act, el, e);
  });

  function handleModelEvent(e) {
    var el = e.target;
    if (!el.dataset) return;

    if (el.dataset.model) {
      var form = getPath(state, el.dataset.model.split('.')[0]);
      setPath(state, el.dataset.model, el.value);
      // Editing a form field clears any message the previous attempt left behind.
      if (form && typeof form === 'object') {
        if ('error' in form) form.error = '';
        if ('success' in form) form.success = '';
      }
      return render();
    }
    if (e.type === 'input' && el.dataset.actInput) return runAction(el.dataset.actInput, el, e);
    if (e.type === 'change' && el.dataset.actChange) return runAction(el.dataset.actChange, el, e);
  }

  root.addEventListener('input', handleModelEvent);
  root.addEventListener('change', function (e) {
    // data-model inputs already handled on `input`; only run change-only hooks.
    if (e.target.dataset && e.target.dataset.model) return;
    handleModelEvent(e);
  });

  root.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var el = e.target;
    if (el.tagName === 'TEXTAREA') return;
    if (state.view === 'login') { e.preventDefault(); actions.submitLogin(); }
    else if (state.view === 'signup') { e.preventDefault(); actions.submitSignup(); }
    else if (el.dataset && el.dataset.actChange) el.blur();
  });

  // -------------------------------------------------------------------- boot

  render();
  bootstrap();
})();
