/* =====================================================================
   婚礼通知备忘录 v3
   - 本地 localStorage 存储，PWA 离线可用
   - 跨设备：同步码（复制/粘贴）+ JSON 文件导出导入，支持智能合并
   - 自动快照，误删误清空可回滚
   ===================================================================== */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  var K_FRIENDS = 'wm_friends_v3';
  var K_TAGS = 'wm_tags_v3';
  var K_SNAP = 'wm_snapshots_v3';
  var K_PREF = 'wm_pref_v3';
  var K_TOMB = 'wm_tombs_v3';
  var K_TAGORDER = 'wm_tagorder_v3';

  var PRESET_TAGS = ['亲戚', '大荔发小', '初中同学', '高中同学', '大荔跳舞朋友', '西安跳舞朋友'];
  var STATUS_ORDER = ['notified', 'confirmed', 'pending', 'declined'];   // 徽章点击的循环顺序
  var STATUS_TEXT = { notified: '已通知', confirmed: '确认出席', pending: '待确认', declined: '不来' };
  // 明细列表的状态排序权重：已通知 → 待确认 → 不来 → 确认出席（越小越靠前）
  var STATUS_RANK = { notified: 0, pending: 1, declined: 2, confirmed: 3 };
  // 记份子弹层里的快捷金额（关中一带常见档位）+ 一个「未随」选项
  var QUICK_AMTS = [200, 300, 500, 800, 1000];

  /* ---------------- 状态 ---------------- */
  var friends = [];
  var customTags = [];
  var tombs = {};            // 删除墓碑 { clientId: updatedAt }，用于跨设备传播删除
  var tagOrder = [];         // 标签显示顺序（含预设标签），可在标签管理里上下调整
  var pref = { sort: 'date-desc', group: false, fold: {} };
  var filterTag = null;      // null = 全部
  var filterStatus = 'all';
  var filterGift = 'all';    // all | has(已随礼) | none(还没记)
  var giftKeyword = '';      // 份子钱页的搜索词
  var giftSort = 'gift-desc';// 份子钱页的排序
  var view = 'list';         // list | gift
  var keyword = '';
  var editingId = null;
  var giftingId = null;      // 正在记份子的那个人
  var giftNonePicked = false;// 弹层里是否选中了「未随」
  var giftNeedConfirm = true;// 这人是否还不是「确认出席」（决定是否显示自动勾选）
  var pickedTag = '';
  var undoTimer = null;

  /* ---------------- 工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function today() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function now() { return Date.now(); }

  function read(key, def) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : def;
    } catch (e) { return def; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { toast('存储空间不足，数据未保存'); return false; }
  }

  function toast(text, actionText, actionFn) {
    var box = $('toast'), t = $('toastText'), btn = $('toastAction');
    t.textContent = text;
    clearTimeout(undoTimer);
    if (actionText) {
      btn.hidden = false;
      btn.textContent = actionText;
      btn.onclick = function () { box.hidden = true; actionFn && actionFn(); };
    } else { btn.hidden = true; btn.onclick = null; }
    box.hidden = false;
    undoTimer = setTimeout(function () { box.hidden = true; }, actionText ? 6000 : 2200);
  }

  /* ---------------- 数据层 ---------------- */
  function loadAll() {
    friends = read(K_FRIENDS, []) || [];
    customTags = read(K_TAGS, []) || [];
    tombs = read(K_TOMB, {}) || {};
    tagOrder = read(K_TAGORDER, null) || PRESET_TAGS.concat(customTags);
    normalizeTagOrder();
    var stored = read(K_PREF, null);
    pref = Object.assign({ sort: 'date-desc', group: false, fold: {} }, stored || {});
    if (!pref.fold) pref.fold = {};
    // 首次在手机上打开：默认收起筛选区，把首屏留给名单
    if (!stored) pref.fold = { filter: true };
    // 兼容旧数据
    friends.forEach(function (f) {
      if (!f.id) f.id = uid();
      if (!f.status || STATUS_ORDER.indexOf(f.status) < 0) f.status = 'notified';
      if (f.status === 'replied') f.status = 'pending';
      if (!f.updatedAt) f.updatedAt = 0;
      if (f.relation == null) f.relation = '';
      if (f.note == null) f.note = '';
      if (!f.date) f.date = today();
      // 份子钱：gift=金额（0 表示没记），giftNote=收礼方式，giftAt=收到日期
      f.gift = money(f.gift);
      if (f.giftNote == null) f.giftNote = '';
      if (f.giftAt == null) f.giftAt = '';
    });
  }

  /* 金额归一：只认非负整数，脏数据一律当 0 */
  function money(v) {
    var n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
    return isFinite(n) && n > 0 ? n : 0;
  }
  function fmtMoney(n) {
    return String(money(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  /* 有没有记过份子：金额 > 0，或者只收了实物（金额 0 但写了方式） */
  function hasGift(f) { return money(f.gift) > 0 || !!(f.giftNote || '').trim(); }
  function saveTags() { write(K_TAGS, customTags); }
  function savePref() { write(K_PREF, pref); }

  /* 本地提交：写 friends + tags + 墓碑，并通知同步层 */
  function commit() {
    write(K_FRIENDS, friends);
    write(K_TAGS, customTags);
    write(K_TOMB, tombs);
  }

  // 顺序表与实际标签集合对齐：补上新标签、剔除已删除的，保持用户排好的相对次序
  function normalizeTagOrder() {
    var exists = PRESET_TAGS.concat(customTags);
    var seen = {};
    var next = [];
    (tagOrder || []).forEach(function (t) {
      if (exists.indexOf(t) >= 0 && !seen[t]) { seen[t] = 1; next.push(t); }
    });
    exists.forEach(function (t) { if (!seen[t]) { seen[t] = 1; next.push(t); } });
    var changed = next.length !== (tagOrder || []).length ||
      next.some(function (t, i) { return t !== tagOrder[i]; });
    tagOrder = next;
    if (changed) write(K_TAGORDER, tagOrder);
  }
  function saveTagOrder() { write(K_TAGORDER, tagOrder); }
  function allTags() { normalizeTagOrder(); return tagOrder.slice(); }
  function moveTag(name, dir) {
    var i = tagOrder.indexOf(name);
    var j = i + dir;
    if (i < 0 || j < 0 || j >= tagOrder.length) return false;
    tagOrder.splice(j, 0, tagOrder.splice(i, 1)[0]);
    saveTagOrder();
    return true;
  }

  /* 自动快照：保留最近 8 次，误操作可回滚 */
  function snapshot() {
    try {
      var snaps = read(K_SNAP, []) || [];
      var prev = localStorage.getItem(K_FRIENDS);
      if (!prev) return;
      if (snaps.length && snaps[0].data === prev) return;
      snaps.unshift({ at: now(), data: prev, n: (read(K_FRIENDS, []) || []).length });
      write(K_SNAP, snaps.slice(0, 8));
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 计算 ---------------- */
  function scopedByTag() {
    if (!filterTag) return friends;
    if (filterTag === '__none__') return friends.filter(function (f) { return !f.relation; });
    return friends.filter(function (f) { return f.relation === filterTag; });
  }

  function visible() {
    var list = scopedByTag();
    if (filterStatus !== 'all') list = list.filter(function (f) { return f.status === filterStatus; });
    if (keyword) {
      var k = keyword.toLowerCase();
      list = list.filter(function (f) {
        return (f.name + ' ' + f.relation + ' ' + f.note + ' ' + (f.giftNote || '')).toLowerCase().indexOf(k) >= 0;
      });
    }
    var s = pref.sort;
    var byName = function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); };
    var byStatus = function (a, b) {
      return (STATUS_RANK[a.status] || 0) - (STATUS_RANK[b.status] || 0);
    };
    list = list.slice().sort(function (a, b) {
      if (s === 'name') return byName(a, b) || byStatus(a, b);
      if (s === 'status') return byStatus(a, b) || -(a.date || '').localeCompare(b.date || '') || byName(a, b);
      // 份子钱排序：没记过的永远沉底，方便对着名单查漏
      if (s === 'gift-desc' || s === 'gift-asc') {
        var ha = hasGift(a) ? 1 : 0, hb = hasGift(b) ? 1 : 0;
        if (ha !== hb) return hb - ha;
        var d = money(a.gift) - money(b.gift);
        if (d) return s === 'gift-asc' ? d : -d;
        return byName(a, b);
      }
      // 日期优先；同一天内按 已通知 → 待确认 → 不来 → 确认出席；再按姓名
      var r = (a.date || '').localeCompare(b.date || '');
      if (s === 'date-asc') return r || byStatus(a, b) || byName(a, b);
      return -r || byStatus(a, b) || byName(a, b);
    });
    return list;
  }

  /* ---------------- 渲染 ---------------- */
  function renderStats() {
    var scope = scopedByTag();
    $('sAll').textContent = scope.length;
    $('sNotified').textContent = scope.filter(function (f) { return f.status === 'notified'; }).length;
    $('sConfirmed').textContent = scope.filter(function (f) { return f.status === 'confirmed'; }).length;
    $('sPending').textContent = scope.filter(function (f) { return f.status === 'pending'; }).length;
    $('sDeclined').textContent = scope.filter(function (f) { return f.status === 'declined'; }).length;
    [].forEach.call(document.querySelectorAll('.stat'), function (b) {
      b.classList.toggle('on', b.dataset.status === filterStatus);
    });
    var giftSum = friends.reduce(function (a, f) { return a + money(f.gift); }, 0);
    $('brandSub').textContent = friends.length
      ? '共 ' + friends.length + ' 人 · 确认 ' + friends.filter(function (f) { return f.status === 'confirmed'; }).length + ' 人' +
      (giftSum > 0 ? ' · 礼金 ¥' + fmtMoney(giftSum) : '')
      : '已通知名单 · 出席跟踪';
  }

  /* 礼金页：汇总 + 分摊 + 明细。跟着当前标签范围走，点「亲戚」就只看亲戚那一摊 */
  function renderGift() {
    var scope = scopedByTag();
    var got = scope.filter(hasGift);
    var amts = got.map(function (f) { return money(f.gift); });
    var total = amts.reduce(function (a, b) { return a + b; }, 0);
    var paid = amts.filter(function (n) { return n > 0; });
    var avg = paid.length ? Math.round(total / paid.length) : 0;
    var max = paid.length ? Math.max.apply(null, paid) : 0;

    // 顶部 Tab 常驻显示总额，不用切过去也知道收了多少
    $('tabListN').textContent = friends.length + ' 人';
    $('tabGiftN').textContent = '¥' + fmtMoney(friends.reduce(function (a, f) { return a + money(f.gift); }, 0));

    // 名单页的速览条
    var allGot = friends.filter(hasGift).length;
    $('gpTotal').textContent = '¥' + fmtMoney(friends.reduce(function (a, f) { return a + money(f.gift); }, 0));
    $('gpSub').textContent = allGot
      ? allGot + ' 人已随礼 · 还有 ' + (friends.length - allGot) + ' 人没记'
      : '还没记份子钱';

    $('gTotal').textContent = fmtMoney(total);
    $('gCount').textContent = got.length;
    $('gAvg').textContent = fmtMoney(avg);
    $('gMax').textContent = fmtMoney(max);
    $('gNone').textContent = scope.length - got.length;
    $('gTotalSub').textContent = got.length
      ? (filterTag && filterTag !== '__none__' ? filterTag + ' · ' : '') + got.length + ' 人已随礼'
      : '还没记录';

    var pct = scope.length ? Math.round(got.length / scope.length * 100) : 0;
    $('gBar').style.width = pct + '%';
    $('gBarL').textContent = got.length + ' 人已随礼（' + pct + '%）';
    $('gBarR').textContent = '共 ' + scope.length + ' 人';
    $('gTagScope').textContent = filterTag && filterTag !== '__none__' ? '当前：' + filterTag : '';

    renderGiftTagRows(scope);
    renderGiftList(scope);

    [].forEach.call($('giftSeg').children, function (b) {
      b.classList.toggle('on', b.dataset.gift === filterGift);
    });
  }

  /* 按标签分摊，回礼时按圈子看 */
  function renderGiftTagRows(scope) {
    var byTag = {};
    scope.forEach(function (f) {
      var t = f.relation || '未分组';
      if (!byTag[t]) byTag[t] = { n: 0, got: 0, sum: 0 };
      byTag[t].n++;
      if (hasGift(f)) { byTag[t].got++; byTag[t].sum += money(f.gift); }
    });
    var keys = allTags().concat(['未分组']).filter(function (t) { return byTag[t]; });
    var maxSum = Math.max.apply(null, keys.map(function (t) { return byTag[t].sum; }).concat([1]));

    $('gTagRows').innerHTML = keys.length
      ? keys.map(function (t) {
        var d = byTag[t];
        var amount = d.sum > 0 ? '¥' + fmtMoney(d.sum) : (d.got ? '仅实物' : '—');
        return '<button class="gtr" data-tagjump="' + esc(t) + '">' +
          '<span class="gtr-top">' +
          '<span class="gtr-name">' + esc(t) + '</span>' +
          '<b class="gtr-sum' + (d.sum > 0 ? '' : ' muted') + '">' + amount + '</b>' +
          '</span>' +
          '<span class="gtr-fill"><i style="width:' + Math.round(d.sum / maxSum * 100) + '%"></i></span>' +
          '<span class="gtr-sub">' + d.got + '/' + d.n + ' 人已随</span>' +
          '</button>';
      }).join('')
      : '<p class="lg-empty">还没有人分组。</p>';
  }

  /* 明细：分「已随礼 / 还没记」两段，谁随了谁没随一眼看清 */
  function renderGiftList(scope) {
    var list = scope.slice();
    if (giftKeyword) {
      var k = giftKeyword.toLowerCase();
      list = list.filter(function (f) {
        return (f.name + ' ' + f.relation + ' ' + (f.giftNote || '') + ' ' + f.note).toLowerCase().indexOf(k) >= 0;
      });
    }
    var got = list.filter(hasGift);
    var none = list.filter(function (f) { return !hasGift(f); });

    var s = giftSort;
    var byName = function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); };
    got.sort(function (a, b) {
      if (s === 'name') return byName(a, b);
      if (s === 'tag') return (a.relation || '~').localeCompare(b.relation || '~', 'zh-Hans-CN') || byName(a, b);
      if (s === 'giftat-desc') return -((a.giftAt || '').localeCompare(b.giftAt || '')) || byName(a, b);
      var d = money(a.gift) - money(b.gift);
      return (s === 'gift-asc' ? d : -d) || byName(a, b);
    });
    none.sort(function (a, b) {
      // 「不来」的人多半不随礼，沉到最后，别干扰要补记的人
      var da = a.status === 'declined' ? 1 : 0, db = b.status === 'declined' ? 1 : 0;
      if (da !== db) return da - db;
      if (s === 'tag') return (a.relation || '~').localeCompare(b.relation || '~', 'zh-Hans-CN') || byName(a, b);
      return byName(a, b);
    });

    var sum = got.reduce(function (a, f) { return a + money(f.gift); }, 0);
    var html = '';

    if (filterGift !== 'none') {
      html += '<div class="glist-head paid"><h3>已随礼 <i>' + got.length + '</i></h3>' +
        '<b>¥' + fmtMoney(sum) + '</b></div>';
      html += got.length
        ? got.map(function (f, i) { return giftRowHTML(f, i + 1, true); }).join('')
        : '<div class="gempty">这个范围内还没有人随礼。</div>';
    }
    if (filterGift !== 'has') {
      html += '<div class="glist-head todo"><h3>还没记 <i>' + none.length + '</i></h3>' +
        (none.length ? '<span>点右边「记一笔」补上</span>' : '<span>全都记齐了</span>') + '</div>';
      html += none.length
        ? none.map(function (f) { return giftRowHTML(f, 0, false); }).join('')
        : '<div class="gempty done">这个范围内的人都记完了。</div>';
    }
    $('gList').innerHTML = html;
  }

  function giftRowHTML(f, idx, paid) {
    var sub = [];
    if (f.relation) sub.push('<i class="gr-tag">' + esc(f.relation) + '</i>');
    if (paid && f.giftNote) sub.push('<span class="gr-way">' + esc(f.giftNote) + '</span>');
    if (paid && f.giftAt) sub.push('<span>' + esc(f.giftAt.slice(5)) + '</span>');
    if (!paid) sub.push('<span class="gr-st b-' + f.status + '">' + STATUS_TEXT[f.status] + '</span>');

    var right = paid
      ? (money(f.gift) > 0
        ? '<b class="gr-amt">¥' + fmtMoney(f.gift) + '</b>'
        : '<b class="gr-amt kind">实物</b>')
      : '<span class="gr-add">记一笔 ›</span>';

    return '<button class="grow' + (paid ? ' paid' : '') + '" data-gift="' + f.id + '">' +
      (paid ? '<span class="gr-i">' + idx + '</span>' : '') +
      '<span class="gr-main"><span class="gr-name">' + esc(f.name) + '</span>' +
      (sub.length ? '<span class="gr-sub">' + sub.join('') + '</span>' : '') + '</span>' +
      right + '</button>';
  }

  function renderTags() {
    var grid = $('tagGrid'), html = '';
    var count = function (t) {
      return friends.filter(function (f) { return t === '__none__' ? !f.relation : f.relation === t; }).length;
    };
    html += '<button class="tag' + (filterTag === null ? ' on' : '') + '" data-tag="">全部<i>' + friends.length + '</i></button>';
    allTags().forEach(function (t) {
      html += '<button class="tag' + (filterTag === t ? ' on' : '') + '" data-tag="' + esc(t) + '">' +
        esc(t) + '<i>' + count(t) + '</i></button>';
    });
    var noTag = count('__none__');
    if (noTag > 0) {
      html += '<button class="tag' + (filterTag === '__none__' ? ' on' : '') + '" data-tag="__none__">未分组<i>' + noTag + '</i></button>';
    }
    html += '<button class="tag add" data-add="1" aria-label="新增标签">＋</button>';
    grid.innerHTML = html;
  }

  function rowHTML(f) {
    var meta = [];
    if (f.relation) meta.push('<span class="mtag">' + esc(f.relation) + '</span>');
    if (f.date) meta.push('<span>' + esc(f.date.slice(5)) + '</span>');
    if (f.giftNote) meta.push('<span class="mway">' + esc(f.giftNote) + '</span>');
    if (f.note) meta.push('<span class="mnote">' + esc(f.note) + '</span>');

    var amt = money(f.gift);
    // 是否随礼要一眼看出来：红色=收到了，灰色「未随」=还没记
    var moneyBtn = amt > 0
      ? '<button class="money on" data-gift="' + f.id + '" aria-label="改份子钱"><i>¥</i>' + fmtMoney(amt) + '</button>'
      : (f.giftNote
        ? '<button class="money kind" data-gift="' + f.id + '" aria-label="改份子钱">实物</button>'
        : '<button class="money none" data-gift="' + f.id + '" aria-label="记份子钱">未随</button>');

    return '<div class="row' + (hasGift(f) ? ' paid' : '') + '" data-id="' + f.id + '">' +
      '<div class="row-main">' +
      '<div class="row-name">' + esc(f.name) + '</div>' +
      (meta.length ? '<div class="row-meta">' + meta.join('') + '</div>' : '') +
      '</div>' +
      moneyBtn +
      '<button class="badge b-' + f.status + '" data-toggle="' + f.id + '">' + STATUS_TEXT[f.status] + '</button>' +
      '</div>';
  }

  function renderList() {
    renderFold();
    var list = visible(), box = $('list');
    var sum = list.reduce(function (a, f) { return a + money(f.gift); }, 0);
    $('listCount').textContent = list.length + ' 人' + (sum > 0 ? ' · ¥' + fmtMoney(sum) : '');
    $('listTitle').textContent = (filterTag === '__none__' ? '未分组' : (filterTag || '全部朋友')) +
      (filterStatus === 'all' ? '' : ' · ' + STATUS_TEXT[filterStatus]);

    if (!friends.length) { box.innerHTML = ''; $('empty').hidden = false; return; }
    $('empty').hidden = true;

    if (!list.length) {
      box.innerHTML = '<div class="card empty"><div class="empty-ico">🔍</div>' +
        '<p class="empty-title">没有匹配的记录</p>' +
        '<p class="empty-sub">换个关键字，或点「全部」看完整名单</p></div>';
      return;
    }

    if (pref.group && !keyword) {
      var groups = {}, order = [];
      list.forEach(function (f) {
        var g = f.relation || '未分组';
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push(f);
      });
      var sortedOrder = allTags().filter(function (t) { return groups[t]; })
        .concat(order.filter(function (g) { return allTags().indexOf(g) < 0; }));
      box.innerHTML = sortedOrder.map(function (g) {
        return '<div class="group-label">' + esc(g) + ' · ' + groups[g].length + ' 人</div>' +
          groups[g].map(rowHTML).join('');
      }).join('');
    } else {
      box.innerHTML = list.map(rowHTML).join('');
    }
  }

  function renderFold() {
    [].forEach.call(document.querySelectorAll('.panel[data-panel]'), function (p) {
      p.classList.toggle('collapsed', !!pref.fold[p.dataset.panel]);
    });
    var active = (filterStatus !== 'all') || !!keyword || pref.group || pref.sort !== 'date-desc';
    $('filterTip').hidden = !(active && pref.fold.filter);
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('.panel-toggle');
    if (!t) return;
    var panel = t.closest('.panel[data-panel]');
    var key = panel.dataset.panel;
    pref.fold[key] = !pref.fold[key];
    savePref();
    renderFold();
  });

  function render() { renderStats(); renderGift(); renderTags(); renderList(); }

  /* ---------------- 交互 ---------------- */
  // 标签网格
  $('tagGrid').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.add) return addTagPrompt();
    var t = b.dataset.tag;
    filterTag = t === '' ? null : t;
    render();
  });

  // 统计卡片筛选
  $('stats').addEventListener('click', function (e) {
    var b = e.target.closest('.stat');
    if (!b) return;
    filterStatus = (filterStatus === b.dataset.status) ? 'all' : b.dataset.status;
    syncSeg();
    render();
  });

  // 状态条
  $('statusSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    filterStatus = b.dataset.status;
    syncSeg();
    render();
  });
  function syncSeg() {
    [].forEach.call($('statusSeg').children, function (b) {
      b.classList.toggle('on', b.dataset.status === filterStatus);
    });
  }

  // 份子钱筛选条
  $('giftSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    filterGift = b.dataset.gift;
    render();
  });

  /* ---------------- 视图切换：名单 / 份子钱 ---------------- */
  function switchView(v) {
    view = v;
    document.body.classList.toggle('view-gift', v === 'gift');
    $('viewList').hidden = v !== 'list';
    $('viewGift').hidden = v !== 'gift';
    [].forEach.call($('tabs').children, function (b) {
      b.classList.toggle('on', b.dataset.view === v);
    });
    window.scrollTo(0, 0);
    render();
  }
  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('[data-view]');
    if (b) switchView(b.dataset.view);
  });
  $('giftPeek').addEventListener('click', function () { switchView('gift'); });

  // 份子钱页：搜索 / 排序 / 点标签卡跳回名单 / 点明细行记账
  $('gSearch').addEventListener('input', function () {
    giftKeyword = this.value.trim();
    renderGiftList(scopedByTag());
  });
  $('gSortSel').addEventListener('change', function () {
    giftSort = this.value;
    renderGiftList(scopedByTag());
  });
  $('gTagRows').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tagjump]');
    if (!b) return;
    var t = b.dataset.tagjump;
    filterTag = (filterTag === t) ? null : (t === '未分组' ? '__none__' : t);
    render();
    toast(filterTag ? '只看「' + t + '」这一摊' : '已看全部');
  });
  $('gList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-gift]');
    if (b) openGift(b.dataset.gift);
  });

  // 搜索
  $('search').addEventListener('input', function () {
    keyword = this.value.trim();
    $('btnClearSearch').hidden = !keyword;
    renderList();
  });
  $('btnClearSearch').addEventListener('click', function () {
    $('search').value = ''; keyword = ''; this.hidden = true; renderList();
  });

  // 排序 / 分组
  $('sortSel').addEventListener('change', function () { pref.sort = this.value; savePref(); renderList(); });
  $('groupToggle').addEventListener('change', function () { pref.group = this.checked; savePref(); renderList(); });

  // 列表点击
  $('list').addEventListener('click', function (e) {
    var g = e.target.closest('[data-gift]');
    if (g) { e.stopPropagation(); return openGift(g.dataset.gift); }
    var tgl = e.target.closest('[data-toggle]');
    if (tgl) { e.stopPropagation(); return cycleStatus(tgl.dataset.toggle); }
    var row = e.target.closest('.row');
    if (row) openForm(row.dataset.id);
  });

  function cycleStatus(id) {
    var f = friends.find(function (x) { return x.id === id; });
    if (!f) return;
    f.status = STATUS_ORDER[(STATUS_ORDER.indexOf(f.status) + 1) % STATUS_ORDER.length];
    f.updatedAt = now();
    commit();
    render();
  }

  /* ---------------- 表单 ---------------- */
  function renderTagPicker() {
    var box = $('fTagPick'), html = '';
    html += '<button type="button" data-t="" class="' + (pickedTag === '' ? 'on' : '') + '">未分组</button>';
    allTags().forEach(function (t) {
      html += '<button type="button" data-t="' + esc(t) + '" class="' + (pickedTag === t ? 'on' : '') + '">' + esc(t) + '</button>';
    });
    box.innerHTML = html;
  }
  $('fTagPick').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    pickedTag = b.dataset.t;
    renderTagPicker();
  });

  function openForm(id) {
    editingId = id || null;
    var f = id ? friends.find(function (x) { return x.id === id; }) : null;
    $('formTitle').textContent = f ? '编辑朋友' : '新增朋友';
    $('btnDelete').hidden = !f;
    $('batchMode').checked = false;
    document.querySelector('.batch-field').hidden = !!f;
    toggleBatch(false);

    $('fName').value = f ? f.name : '';
    $('fNames').value = '';
    pickedTag = f ? (f.relation || '') : (filterTag && filterTag !== '__none__' ? filterTag : '');
    $('fStatus').value = f ? f.status : 'notified';
    $('fDate').value = f ? (f.date || today()) : today();
    $('fNote').value = f ? f.note : '';
    $('fGift').value = f && money(f.gift) > 0 ? money(f.gift) : '';
    $('fGiftNote').value = f ? (f.giftNote || '') : '';
    renderTagPicker();

    $('formMask').hidden = false;
  }
  function closeForm() { $('formMask').hidden = true; editingId = null; }

  $('batchMode').addEventListener('change', function () { toggleBatch(this.checked); });
  function toggleBatch(on) {
    $('fName').hidden = on;
    $('fNames').hidden = !on;
    $('batchHint').hidden = !on;
    // 批量录入时每人金额都不一样，份子钱字段没意义，直接藏掉
    $('giftField').hidden = on;
    if (on) updateBatchHint();
  }
  $('fNames').addEventListener('input', updateBatchHint);
  function splitNames(raw) {
    return raw.split(/[\n\r,，、;；\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function updateBatchHint() {
    $('batchHint').textContent = '将生成 ' + splitNames($('fNames').value).length + ' 条记录';
  }

  $('btnFormSave').addEventListener('click', saveForm);
  function saveForm() {
    var batch = $('batchMode').checked && !editingId;
    var base = {
      relation: pickedTag,
      date: $('fDate').value || today(),
      status: $('fStatus').value,
      note: $('fNote').value.trim()
    };
    if (!batch) {
      var old = editingId ? friends.find(function (x) { return x.id === editingId; }) : null;
      base.gift = money($('fGift').value);
      base.giftNote = $('fGiftNote').value.trim();
      // 第一次记上份子钱时补个收到日期，之前记过就保留原来的
      base.giftAt = (base.gift > 0 || base.giftNote)
        ? ((old && old.giftAt) || today())
        : '';
    } else {
      base.gift = 0; base.giftNote = ''; base.giftAt = '';
    }

    if (batch) {
      var names = splitNames($('fNames').value);
      if (!names.length) { toast('请至少填一个姓名'); $('fNames').focus(); return; }
      snapshot();
      names.forEach(function (n) {
        friends.push(Object.assign({ id: uid(), name: n, updatedAt: now() }, base));
      });
      commit();
      closeForm(); render();
      toast('已添加 ' + names.length + ' 人');
      return;
    }

    var name = $('fName').value.trim();
    if (!name) { toast('姓名不能为空'); $('fName').focus(); return; }

    snapshot();
    if (editingId) {
      var f = friends.find(function (x) { return x.id === editingId; });
      Object.assign(f, base, { name: name, updatedAt: now() });
    } else {
      // 同名提醒（不阻断）
      var dup = friends.some(function (x) { return x.name === name; });
      friends.push(Object.assign({ id: uid(), name: name, updatedAt: now() }, base));
      if (dup) setTimeout(function () { toast('提醒：名单里已有同名的「' + name + '」'); }, 400);
    }
    commit();
    closeForm(); render();
    if (!editingId) toast('已保存');
  }

  $('btnDelete').addEventListener('click', function () {
    var f = friends.find(function (x) { return x.id === editingId; });
    if (!f) return;
    if (!confirm('删除「' + f.name + '」？')) return;
    snapshot();
    var backup = JSON.parse(JSON.stringify(f));
    friends = friends.filter(function (x) { return x.id !== editingId; });
    tombs[backup.id] = now();
    commit();
    closeForm(); render();
    toast('已删除「' + backup.name + '」', '撤销', function () {
      delete tombs[backup.id];
      backup.updatedAt = now();
      friends.push(backup);
      commit();
      render();
      toast('已恢复');
    });
  });

  $('btnFormCancel').addEventListener('click', closeForm);
  $('formMask').addEventListener('click', function (e) { if (e.target === this) closeForm(); });
  $('btnAdd').addEventListener('click', function () { openForm(null); });
  $('btnEmptyAdd').addEventListener('click', function () { openForm(null); });

  /* ---------------- 记份子（快捷弹层） ---------------- */
  function openGift(id) {
    var f = friends.find(function (x) { return x.id === id; });
    if (!f) return;
    giftingId = id;
    giftNonePicked = false;

    var amt = money(f.gift);
    $('giftTitle').textContent = hasGift(f) ? '改份子钱' : '记份子';
    $('giftWho').innerHTML = '<b>' + esc(f.name) + '</b>' +
      (f.relation ? '<span class="gw-tag">' + esc(f.relation) + '</span>' : '') +
      '<span class="gw-st b-' + f.status + '">' + STATUS_TEXT[f.status] + '</span>';
    $('gAmount').value = amt > 0 ? amt : '';
    $('gWay').value = f.giftNote || '';
    $('gDate').value = f.giftAt || today();
    $('gTagShow').value = f.relation || '未分组';
    $('btnGiftRemove').hidden = !hasGift(f);

    // 已经是「确认出席」就不用再提了
    giftNeedConfirm = f.status !== 'confirmed';
    $('gAutoConfirm').checked = giftNeedConfirm;

    renderQuickAmts();
    syncGiftSaveLabel();
    $('giftMask').hidden = false;
  }
  function closeGift() {
    $('giftMask').hidden = true; giftingId = null; giftNonePicked = false;
  }

  function renderQuickAmts() {
    var cur = money($('gAmount').value);
    var html = QUICK_AMTS.map(function (n) {
      return '<button type="button" data-amt="' + n + '"' +
        (!giftNonePicked && cur === n ? ' class="on"' : '') + '>' + n + '</button>';
    }).join('');
    // 第 6 个格子：明确标「未随」，和金额档位在样式上分开
    html += '<button type="button" class="none' + (giftNonePicked ? ' on' : '') +
      '" data-amt="none">未随</button>';
    $('quickAmt').innerHTML = html;
  }
  function syncGiftSaveLabel() {
    if (giftNonePicked) {
      $('btnGiftSave').textContent = '标为未随';
      $('giftAutoWrap').hidden = true;   // 没随礼，不该顺手把人改成「确认出席」
      return;
    }
    $('giftAutoWrap').hidden = !giftNeedConfirm;
    var n = money($('gAmount').value);
    $('btnGiftSave').textContent = n > 0 ? '保存 ¥' + fmtMoney(n) : '保存';
  }

  $('quickAmt').addEventListener('click', function (e) {
    var b = e.target.closest('[data-amt]');
    if (!b) return;
    if (b.dataset.amt === 'none') {
      // 再点一次 = 取消，和金额档位保持一致，防手滑
      giftNonePicked = !giftNonePicked;
      if (giftNonePicked) { $('gAmount').value = ''; $('gWay').value = ''; }
    } else {
      var n = +b.dataset.amt;
      var wasNone = giftNonePicked;
      giftNonePicked = false;   // 选了金额就等于不要「未随」
      // 再点一次已选中的档位 = 取消
      $('gAmount').value = (!wasNone && money($('gAmount').value) === n) ? '' : n;
    }
    renderQuickAmts();
    syncGiftSaveLabel();
  });
  $('gAmount').addEventListener('input', function () {
    var v = this.value.replace(/[^\d]/g, '').slice(0, 7);
    if (v !== this.value) this.value = v;
    giftNonePicked = false;   // 手输金额 = 取消「未随」
    renderQuickAmts();
    syncGiftSaveLabel();
  });
  $('gWay').addEventListener('input', function () {
    if (this.value.trim()) giftNonePicked = false;
    renderQuickAmts();
    syncGiftSaveLabel();
  });
  $('btnGiftClear').addEventListener('click', function () {
    $('gAmount').value = '';
    giftNonePicked = false;
    renderQuickAmts();
    syncGiftSaveLabel();
    $('gAmount').focus();
  });

  $('btnGiftSave').addEventListener('click', function () {
    var f = friends.find(function (x) { return x.id === giftingId; });
    if (!f) return closeGift();
    var nonePicked = giftNonePicked;
    var amt = money($('gAmount').value);
    var way = $('gWay').value.trim();
    if (!nonePicked && !amt && !way) {
      toast('填个金额，或者点上边的「未随」'); $('gAmount').focus(); return;
    }

    snapshot();
    f.gift = nonePicked ? 0 : amt;
    f.giftNote = nonePicked ? '' : way;
    f.giftAt = nonePicked ? '' : ($('gDate').value || today());
    if (!nonePicked && !$('giftAutoWrap').hidden && $('gAutoConfirm').checked) f.status = 'confirmed';
    f.updatedAt = now();
    commit();
    closeGift(); render();
    toast(nonePicked ? f.name + ' · 已标为未随'
      : f.name + ' · ' + (amt > 0 ? '¥' + fmtMoney(amt) : way) + ' 已记下');
  });

  $('btnGiftRemove').addEventListener('click', function () {
    var f = friends.find(function (x) { return x.id === giftingId; });
    if (!f) return;
    if (!confirm('清除「' + f.name + '」的份子钱记录？人还在名单里，只是金额清空。')) return;
    snapshot();
    var bk = { gift: money(f.gift), giftNote: f.giftNote, giftAt: f.giftAt };
    f.gift = 0; f.giftNote = ''; f.giftAt = ''; f.updatedAt = now();
    commit();
    closeGift(); render();
    toast('已清除', '撤销', function () {
      f.gift = bk.gift; f.giftNote = bk.giftNote; f.giftAt = bk.giftAt; f.updatedAt = now();
      commit(); render(); toast('已恢复');
    });
  });

  $('btnGiftCancel').addEventListener('click', closeGift);
  $('giftMask').addEventListener('click', function (e) { if (e.target === this) closeGift(); });

  /* ---------------- 标签管理 ---------------- */
  function addTagPrompt() {
    var name = prompt('新标签名称');
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    if (allTags().indexOf(name) >= 0) { toast('这个标签已经有了'); return; }
    customTags.push(name);
    tagOrder.push(name);
    saveTags();
    saveTagOrder();
    render();
    toast('已添加标签「' + name + '」');
  }

  $('btnManageTags').addEventListener('click', openTagManager);

  function openTagManager() {
    var list = allTags();
    var rows = list.map(function (t, i) {
      var isPreset = PRESET_TAGS.indexOf(t) >= 0;
      var n = friends.filter(function (f) { return f.relation === t; }).length;
      return '<div class="tagrow">' +
        '<span class="tagrow-idx">' + (i + 1) + '</span>' +
        '<span class="tagrow-name">' + esc(t) + '</span>' +
        '<em>' + n + ' 人</em>' +
        '<span class="tagrow-moves">' +
        '<button class="mv" data-up="' + esc(t) + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="上移">↑</button>' +
        '<button class="mv" data-down="' + esc(t) + '"' + (i === list.length - 1 ? ' disabled' : '') + ' aria-label="下移">↓</button>' +
        '</span>' +
        (isPreset ? '<button class="tagrow-del" disabled>预设</button>'
          : '<button class="tagrow-del" data-del="' + esc(t) + '">删除</button>') +
        '</div>';
    }).join('');
    openModal('标签管理与排序',
      '<div class="mod-sec"><h4>拖不动就用箭头</h4>' +
      '<p>用 ↑ ↓ 调整顺序，页面上的标签网格、表单里的标签选择、按标签分组的视图都会跟着这个顺序。预设标签也能排。</p>' +
      rows + '</div>' +
      '<div class="mod-sec"><div class="btns two">' +
      '<button class="sec-btn" id="mAddTag">＋ 新增标签</button>' +
      '<button class="sec-btn" id="mResetOrder">恢复默认顺序</button>' +
      '</div></div>' +
      '<div class="mod-sec"><p>删除自定义标签后，原本属于它的朋友会变成「未分组」，记录不会丢。预设标签不可删除。</p></div>',
      function (body) {
        body.addEventListener('click', function (e) {
          var add = e.target.closest('#mAddTag');
          if (add) { closeModal(); addTagPrompt(); return; }

          var reset = e.target.closest('#mResetOrder');
          if (reset) {
            tagOrder = PRESET_TAGS.concat(customTags);
            saveTagOrder();
            render();
            openTagManager();
            toast('已恢复默认顺序');
            return;
          }

          var up = e.target.closest('[data-up]');
          var down = e.target.closest('[data-down]');
          if (up || down) {
            if (moveTag((up || down).dataset[up ? 'up' : 'down'], up ? -1 : 1)) {
              render();
              openTagManager();
            }
            return;
          }

          var del = e.target.closest('[data-del]');
          if (!del) return;
          var t = del.dataset.del;
          if (!confirm('删除标签「' + t + '」？属于它的朋友会变成未分组。')) return;
          snapshot();
          customTags = customTags.filter(function (x) { return x !== t; });
          tagOrder = tagOrder.filter(function (x) { return x !== t; });
          saveTagOrder();
          friends.forEach(function (f) { if (f.relation === t) { f.relation = ''; f.updatedAt = now(); } });
          commit();
          if (filterTag === t) filterTag = null;
          render();
          openTagManager();
          toast('已删除标签');
        });
      });
  }

  /* ---------------- 礼金台账 ---------------- */
  function ledgerRows() {
    return friends.filter(hasGift).sort(function (a, b) {
      return money(b.gift) - money(a.gift) ||
        a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
  }
  function ledgerText() {
    var rows = ledgerRows();
    var total = rows.reduce(function (a, f) { return a + money(f.gift); }, 0);
    return '礼金台账 · ' + today() + '\n' +
      '合计 ¥' + fmtMoney(total) + '（' + rows.length + ' 人）\n' +
      '------------------------\n' +
      rows.map(function (f, i) {
        return (i + 1) + '. ' + f.name +
          (f.relation ? '（' + f.relation + '）' : '') +
          ' ¥' + fmtMoney(f.gift) +
          (f.giftNote ? ' · ' + f.giftNote : '') +
          (f.giftAt ? ' · ' + f.giftAt.slice(5) : '');
      }).join('\n');
  }

  function openLedger() { switchView('gift'); }

  // 复制台账 / 导出 CSV（份子钱页底部）
  $('lgCopy').addEventListener('click', function () {
    if (!ledgerRows().length) { toast('还没记过份子钱'); return; }
    var ta = document.createElement('textarea');
    ta.value = ledgerText();
    ta.style.cssText = 'position:fixed;opacity:0;top:0';
    document.body.appendChild(ta);
    copyText(ta.value, ta);
    setTimeout(function () { ta.remove(); }, 600);
  });
  $('lgCsv').addEventListener('click', exportCSV);

  function exportCSV() {
    var rows = ledgerRows();
    if (!rows.length) { toast('还没有可导出的礼金记录'); return; }
    var esc2 = function (s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; };
    var lines = [['姓名', '标签', '金额', '收礼方式', '收到日期', '出席状态', '备注'].map(esc2).join(',')];
    rows.forEach(function (f) {
      lines.push([f.name, f.relation || '', money(f.gift), f.giftNote || '',
      f.giftAt || '', STATUS_TEXT[f.status], f.note || ''].map(esc2).join(','));
    });
    var total = rows.reduce(function (a, f) { return a + money(f.gift); }, 0);
    lines.push(['合计', '', total, '', '', rows.length + ' 人', ''].map(esc2).join(','));
    // 带 BOM，Excel 打开才不乱码
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '礼金台账-' + today() + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
    toast('已导出 ' + rows.length + ' 条礼金记录');
  }

  /* ---------------- 通用弹层 ---------------- */
  function openModal(title, html, after) {
    $('modalTitle').textContent = title;
    // 用一个干净的新节点替换，避免反复打开同一弹层时事件监听器层层叠加
    // （叠加会让一次点击被执行多次，比如标签上移一下跳好几格）
    var old = $('modalBody');
    var fresh = old.cloneNode(false);
    fresh.innerHTML = html;
    old.parentNode.replaceChild(fresh, old);
    $('modalMask').hidden = false;
    if (after) after(fresh);
  }
  function closeModal() { $('modalMask').hidden = true; $('modalBody').innerHTML = ''; }
  $('btnModalClose').addEventListener('click', closeModal);
  $('modalMask').addEventListener('click', function (e) { if (e.target === this) closeModal(); });

  /* ---------------- 同步码（跨设备） ---------------- */
  // 紧凑编码：[name, relation, date, statusIndex, note, updatedAt, id, gift, giftNote, giftAt]
  // 7~9 位是 v4.2 加的份子钱，老版本读到会忽略，新版本读老码按 0 / 空串兜底
  function encodeData() {
    var payload = {
      v: 3,
      t: customTags,
      f: friends.map(function (f) {
        return [f.name, f.relation || '', f.date || '', STATUS_ORDER.indexOf(f.status),
        f.note || '', f.updatedAt || 0, f.id,
        money(f.gift), f.giftNote || '', f.giftAt || ''];
      })
    };
    var json = JSON.stringify(payload);
    var bytes = new TextEncoder().encode(json);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return 'WM3:' + btoa(bin);
  }
  function decodeData(code) {
    code = String(code || '').trim().replace(/\s+/g, '');
    if (code.indexOf('WM3:') === 0) code = code.slice(4);
    var bin = atob(code);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var obj = JSON.parse(new TextDecoder().decode(bytes));
    if (!obj || !Array.isArray(obj.f)) throw new Error('bad');
    return {
      tags: obj.t || [],
      friends: obj.f.map(function (a) {
        return {
          id: a[6] || uid(), name: a[0], relation: a[1] || '', date: a[2] || today(),
          status: STATUS_ORDER[a[3]] || 'notified', note: a[4] || '', updatedAt: a[5] || 0,
          gift: money(a[7]), giftNote: a[8] || '', giftAt: a[9] || ''
        };
      })
    };
  }

  // 智能合并：同 id 取 updatedAt 新的；无同 id 时按 姓名+标签 去重
  function mergeIn(incoming) {
    var added = 0, updated = 0, skipped = 0;
    var byId = {}, byKey = {};
    friends.forEach(function (f) {
      byId[f.id] = f;
      byKey[f.name + '|' + (f.relation || '')] = f;
    });
    incoming.friends.forEach(function (n) {
      // 本机已删除且删除时间更晚 → 不要复活
      if (tombs[n.id] && tombs[n.id] >= (n.updatedAt || 0)) { skipped++; return; }
      var exist = byId[n.id] || byKey[n.name + '|' + (n.relation || '')];
      if (exist) {
        if ((n.updatedAt || 0) > (exist.updatedAt || 0)) {
          // 份子钱是钱，不能被一份「不含金额的旧数据」覆盖掉：
          // 对面没记而本机记了，就保留本机的
          var keepGift = !hasGift(n) && hasGift(exist)
            ? { gift: money(exist.gift), giftNote: exist.giftNote, giftAt: exist.giftAt }
            : null;
          Object.assign(exist, n, { id: exist.id });
          if (keepGift) Object.assign(exist, keepGift);
          updated++;
        } else skipped++;
      } else {
        friends.push(n);
        byId[n.id] = n;
        byKey[n.name + '|' + (n.relation || '')] = n;
        added++;
      }
    });
    (incoming.tags || []).forEach(function (t) {
      if (allTags().indexOf(t) < 0) customTags.push(t);
    });
    return { added: added, updated: updated, skipped: skipped };
  }

  function applyIncoming(incoming, mode) {
    snapshot();
    var msg;
    if (mode === 'replace') {
      friends = incoming.friends;
      customTags = (incoming.tags || []).filter(function (t) { return PRESET_TAGS.indexOf(t) < 0; });
      tombs = {};
      msg = '已覆盖导入 ' + friends.length + ' 条记录';
    } else {
      var r = mergeIn(incoming);
      msg = '合并完成：新增 ' + r.added + ' · 更新 ' + r.updated + ' · 无变化 ' + r.skipped;
    }
    commit();
    closeModal(); render(); toast(msg);
  }

  function askApply(incoming) {
    openModal('导入 ' + incoming.friends.length + ' 条记录',
      '<div class="mod-sec"><h4>选择导入方式</h4>' +
      '<p>当前本机有 <b>' + friends.length + '</b> 条记录。推荐用「智能合并」：同一个人取最后修改的那份，不会把你这边的新记录冲掉。</p>' +
      '<div class="btns">' +
      '<button class="primary-btn block" id="mMerge">智能合并（推荐）</button>' +
      '<button class="sec-btn block" id="mReplace">全部覆盖本机数据</button>' +
      '</div></div>',
      function (body) {
        body.querySelector('#mMerge').onclick = function () { applyIncoming(incoming, 'merge'); };
        body.querySelector('#mReplace').onclick = function () {
          if (confirm('本机现有 ' + friends.length + ' 条记录会被全部替换，确定？（仍可在「备份与恢复」里回滚）')) {
            applyIncoming(incoming, 'replace');
          }
        };
      });
  }

  $('btnSync').addEventListener('click', function () {
    var code = encodeData();
    var kb = (code.length / 1024).toFixed(1);
    openModal('换机搬数据',
      '<div class="mod-sec"><h4>① 在这台设备上复制同步码</h4>' +
      '<p>包含全部 ' + friends.length + ' 条记录和自定义标签，约 ' + kb + ' KB。复制后用微信发给自己，在另一台设备上粘贴即可。</p>' +
      '<textarea class="code-box" id="syncOut" readonly>' + esc(code) + '</textarea>' +
      '<div class="btns two" style="margin-top:8px">' +
      '<button class="primary-btn" id="btnCopyCode">复制同步码</button>' +
      '<button class="sec-btn" id="btnShareCode">分享…</button>' +
      '</div></div>' +
      '<div class="mod-sec"><h4>② 在另一台设备上粘贴导入</h4>' +
      '<p>把收到的同步码贴进来，可以选择智能合并或覆盖。</p>' +
      '<textarea class="code-box" id="syncIn" placeholder="在这里粘贴同步码（WM3: 开头）"></textarea>' +
      '<button class="sec-btn block" id="btnImportCode" style="margin-top:8px">读取同步码</button></div>' +
      '<div class="mod-sec"><h4>说明</h4>' +
      '<ul class="tiplist"><li>同步码是纯文本，走你自己的微信/备忘录传输，不经过任何服务器。</li>' +
      '<li>两台设备各自改过也没关系，合并时按「最后修改时间」取新的那份。</li>' +
      '<li>换手机、或者想在别的设备上也记一份，用这个搬过去就行。</li></ul></div>',
      function (body) {
        body.querySelector('#btnCopyCode').onclick = function () {
          var ta = body.querySelector('#syncOut');
          copyText(ta.value, ta);
        };
        body.querySelector('#btnShareCode').onclick = function () {
          var txt = body.querySelector('#syncOut').value;
          if (navigator.share) navigator.share({ title: '婚礼备忘录同步码', text: txt }).catch(function () { });
          else copyText(txt, body.querySelector('#syncOut'));
        };
        body.querySelector('#btnImportCode').onclick = function () {
          var v = body.querySelector('#syncIn').value.trim();
          if (!v) { toast('先粘贴同步码'); return; }
          try { askApply(decodeData(v)); }
          catch (e) { toast('同步码不完整或格式不对'); }
        };
      });
  });

  function copyText(text, el) {
    function fallback() {
      try {
        el.removeAttribute('readonly');
        el.select(); el.setSelectionRange(0, 999999);
        document.execCommand('copy');
        el.setAttribute('readonly', 'readonly');
        toast('已复制');
      } catch (e) { toast('复制失败，请长按手动选择'); }
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制'); }, fallback);
    } else fallback();
  }

  /* ---------------- 备份与恢复 ---------------- */
  $('btnBackup').addEventListener('click', function () {
    var snaps = read(K_SNAP, []) || [];
    var snapHtml = snaps.length
      ? snaps.map(function (s, i) {
        var d = new Date(s.at);
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        return '<div class="tagrow"><span>' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
          p(d.getHours()) + ':' + p(d.getMinutes()) + '</span><em>' + s.n + ' 人</em>' +
          '<button data-snap="' + i + '" style="color:var(--blue);background:var(--blue-soft-2)">回滚</button></div>';
      }).join('')
      : '<p style="font-size:12.5px;color:#7d97ae;font-weight:600;margin:0">暂无快照，改动一次后就会自动生成。</p>';

    openModal('备份与恢复',
      '<div class="mod-sec"><h4>导出到文件</h4>' +
      '<p>生成一个带日期的 JSON 文件，会存进 iPhone 的「文件」App，可以隔空投送或发微信备份。</p>' +
      '<button class="primary-btn block" id="btnExport">导出 JSON 备份</button></div>' +
      '<div class="mod-sec"><h4>从文件导入</h4>' +
      '<p>支持本应用导出的 JSON，导入时可以选合并或覆盖。</p>' +
      '<button class="sec-btn block" id="btnImportFile">选择备份文件</button>' +
      '<input type="file" id="fileInput" accept=".json,application/json" hidden></div>' +
      '<div class="mod-sec"><h4>自动快照（最近 8 次改动）</h4>' +
      '<p>每次增删改前自动留底，手滑了可以直接回滚。</p>' + snapHtml + '</div>' +
      '<div class="mod-sec"><h4>危险操作</h4>' +
      '<p>清空后仍可用上面的快照回滚一次。</p>' +
      '<button class="danger-btn" id="btnClearAll">清空全部记录</button></div>',
      function (body) {
        body.querySelector('#btnExport').onclick = exportJSON;
        body.querySelector('#btnImportFile').onclick = function () { body.querySelector('#fileInput').click(); };
        body.querySelector('#fileInput').onchange = function () {
          var file = this.files[0];
          if (!file) return;
          var rd = new FileReader();
          rd.onload = function () {
            try {
              var obj = JSON.parse(rd.result);
              var arr = Array.isArray(obj) ? obj : (obj.friends || obj.f || []);
              var tags = obj.tags || obj.customTags || obj.t || [];
              if (Array.isArray(arr) && arr.length && Array.isArray(arr[0])) {
                askApply(decodeData(encodeFromCompact(arr, tags)));
                return;
              }
              var normalized = arr.map(function (f) {
                return {
                  id: f.id || uid(), name: f.name || '', relation: f.relation || '',
                  date: f.date || today(),
                  status: STATUS_ORDER.indexOf(f.status) >= 0 ? f.status : (f.status === 'replied' ? 'pending' : 'notified'),
                  note: f.note || '', updatedAt: f.updatedAt || 0,
                  gift: money(f.gift), giftNote: f.giftNote || '', giftAt: f.giftAt || ''
                };
              }).filter(function (f) { return f.name; });
              if (!normalized.length) { toast('文件里没有可导入的记录'); return; }
              askApply({ friends: normalized, tags: tags });
            } catch (e) { toast('文件解析失败，不是有效的备份'); }
          };
          rd.readAsText(file);
        };
        body.addEventListener('click', function (e) {
          var s = e.target.closest('[data-snap]');
          if (!s) return;
          var snaps = read(K_SNAP, []) || [];
          var snap = snaps[+s.dataset.snap];
          if (!snap) return;
          if (!confirm('回滚到这份快照？当前数据会先自动存一份快照。')) return;
          snapshot();
          try {
            friends = JSON.parse(snap.data);
            commit();
            closeModal(); loadAll(); render(); toast('已回滚');
          } catch (err) { toast('快照损坏，回滚失败'); }
        });
        body.querySelector('#btnClearAll').onclick = function () {
          if (!confirm('确定清空全部 ' + friends.length + ' 条记录和自定义标签？')) return;
          if (!confirm('再确认一次：这会清掉所有名单，之后只能靠快照或备份恢复。')) return;
          snapshot();
          var t = now();
          friends.forEach(function (f) { tombs[f.id] = t; });
          friends = []; customTags = [];
          commit();
          filterTag = null; filterStatus = 'all';
          closeModal(); syncSeg(); render();
          toast('已清空，可在备份与恢复里回滚');
        };
      });
  });

  function encodeFromCompact(arr, tags) {
    return 'WM3:' + btoa(unescape(encodeURIComponent(JSON.stringify({ v: 3, t: tags, f: arr }))));
  }

  function exportJSON() {
    var data = {
      app: 'wedding-memo', version: 4, exportedAt: new Date().toISOString(),
      giftTotal: friends.reduce(function (a, f) { return a + money(f.gift); }, 0),
      tags: customTags, friends: friends
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '婚礼备忘录-' + today() + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
    toast('已导出 ' + friends.length + ' 条记录');
  }

  /* ---------------- 复制名单 ---------------- */
  $('btnCopyList').addEventListener('click', function () {
    var list = visible();
    if (!list.length) { toast('当前没有可复制的记录'); return; }
    var title = $('listTitle').textContent;
    var sum = list.reduce(function (a, f) { return a + money(f.gift); }, 0);
    var text = title + '（' + list.length + ' 人' + (sum > 0 ? ' · 礼金 ¥' + fmtMoney(sum) : '') + '）\n' +
      list.map(function (f, i) {
        return (i + 1) + '. ' + f.name +
          (f.relation ? ' · ' + f.relation : '') +
          ' · ' + STATUS_TEXT[f.status] +
          (money(f.gift) > 0 ? ' · ¥' + fmtMoney(f.gift) : (f.giftNote ? ' · ' + f.giftNote : '')) +
          (f.note ? ' · ' + f.note : '');
      }).join('\n');
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0';
    document.body.appendChild(ta);
    copyText(text, ta);
    setTimeout(function () { ta.remove(); }, 600);
  });

  /* ---------------- 更多菜单 ---------------- */
  $('btnMenu').addEventListener('click', function () {
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    var standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    openModal('关于与技巧',
      '<div class="mod-sec"><h4>装到桌面当 App 用</h4>' +
      (standalone
        ? '<p>已经是独立 App 模式了，断网也能打开。</p>'
        : '<p>点 Safari 底部中间的「分享」按钮 → 往下翻找到「添加到主屏幕」→ 右上角「添加」。之后桌面就有一个独立图标，点开没有地址栏，跟原生 App 一样，断网也能用。</p>') +
      '</div>' +
      '<div class="mod-sec"><h4>快捷操作</h4>' +
      '<ul class="tiplist">' +
      '<li><b>记份子钱：</b>名单里点名字右边的按钮——红色的是已收到的金额，灰色「未随」是还没记的，一眼就能扫出来谁随了。</li>' +
      '<li>顶部「份子钱」页是独立一页：大总额、收礼进度、按标签分摊，下面分「已随礼 / 还没记」两段列清楚，点任意一行就能记或改。</li>' +
      '<li>弹层里有 5 个常用金额（200 / 300 / 500 / 800 / 1000）和「未随」：点「未随」再保存，就是明确记下这人没随礼，之前记错的一键清掉。</li>' +
      '<li>记完默认会把这个人标成「确认出席」，不想要就在弹层里取消勾选；标「未随」时不会动出席状态。</li>' +
      '<li>收的是实物（烟酒、被褥）就把金额留空，在「收礼方式」里写清楚，台账里会显示「实物」，不计进总额。</li>' +
      '<li>份子钱页点标签分摊里的某一摊，能只看那个圈子的礼金；底部可复制台账或导出 CSV 对账。</li>' +
      '<li>点一下右边的状态徽章，就在「已通知 → 确认出席 → 待确认 → 不来」之间循环切换。</li>' +
      '<li>明细默认排序：通知日期新的在前；同一天内按「已通知 → 待确认 → 不来 → 确认出席」排，没落定的排在前面。</li>' +
      '<li>标签顺序可以自己调：标签分组右上角「管理」里用 ↑ ↓ 排，网格、表单、分组视图都跟着变。</li>' +
      '<li>点卡片任意位置进入编辑，删除按钮在编辑页里面。</li>' +
      '<li>点统计卡片可以直接筛选对应状态，再点一下取消。</li>' +
      '<li>批量录入时姓名支持换行、空格、逗号、顿号混用。</li>' +
      '</ul></div>' +
      '<div class="mod-sec"><h4>数据在哪</h4>' +
      '<p>全部存在这台手机的 Safari 本地，不上传任何服务器，断网也能用。换手机用「换机搬数据」的同步码，或者「备份与恢复」导出 JSON 文件。</p></div>' +
      '<div class="mod-sec"><h4>自检信息</h4>' +
      '<p id="diagBox" style="font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.8">读取中…</p>' +
      '<button class="sec-btn block" id="btnCopyDiag">复制自检信息</button></div>' +
      '<div class="mod-sec"><p style="color:#7d97ae">婚礼通知备忘录 v4.3.2 · iPhone 版</p></div>',
      function (body) {
        var lines = [
          '版本 v4.3.2-iOS',
          '记录 ' + friends.length + ' 条 · 礼金 ¥' + fmtMoney(friends.reduce(function(a,f){return a+money(f.gift);},0)) + ' · 标签 ' + customTags.length + ' 个',
          '网络 ' + (navigator.onLine ? '在线' : '离线'),
          '离线缓存 ' + ('serviceWorker' in navigator ? (navigator.serviceWorker.controller ? '已生效' : '未生效') : '不支持'),
          '运行模式 ' + (standalone ? '独立 App' : '浏览器标签页'),
          '屏幕 ' + window.innerWidth + '×' + window.innerHeight,
          'UA ' + navigator.userAgent.slice(0, 80)
        ];
        body.querySelector('#diagBox').innerHTML = lines.map(esc).join('<br>');
        body.querySelector('#btnCopyDiag').onclick = function () {
          var ta = document.createElement('textarea');
          ta.value = lines.join('\n');
          ta.style.cssText = 'position:fixed;opacity:0;top:0';
          document.body.appendChild(ta);
          try {
            ta.select(); document.execCommand('copy'); toast('已复制自检信息');
          } catch (e) { toast('复制失败，截图发我也行'); }
          setTimeout(function () { ta.remove(); }, 400);
        };
      });
  });

  /* ---------------- Esc 关闭弹层 ---------------- */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('giftMask').hidden) closeGift();
    else if (!$('formMask').hidden) closeForm();
    else if (!$('modalMask').hidden) closeModal();
  });

  /* ---------------- 跨标签页/窗口同步 ---------------- */
  window.addEventListener('storage', function (e) {
    if (e.key === K_FRIENDS || e.key === K_TAGS) { loadAll(); render(); }
  });

  /* ---------------- 启动 ---------------- */
  loadAll();
  $('sortSel').value = pref.sort;
  $('gSortSel').value = giftSort;
  $('groupToggle').checked = !!pref.group;
  $('fDate').value = today();
  syncSeg();
  render();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { });
    });
  }

})();