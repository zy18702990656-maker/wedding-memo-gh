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

  var PRESET_TAGS = ['亲戚', '大荔发小', '初中同学', '高中同学', '大荔跳舞朋友', '西安跳舞朋友'];
  var STATUS_ORDER = ['notified', 'confirmed', 'pending', 'declined'];
  var STATUS_TEXT = { notified: '已通知', confirmed: '确认出席', pending: '待确认', declined: '不来' };

  /* ---------------- 状态 ---------------- */
  var friends = [];
  var customTags = [];
  var tombs = {};            // 删除墓碑 { clientId: updatedAt }，用于跨设备传播删除
  var pref = { sort: 'date-desc', group: false, fold: {} };
  var filterTag = null;      // null = 全部
  var filterStatus = 'all';
  var keyword = '';
  var editingId = null;
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
    });
  }
  function saveTags() { write(K_TAGS, customTags); }
  function savePref() { write(K_PREF, pref); }

  /* 本地提交：写 friends + tags + 墓碑，并通知同步层 */
  function commit() {
    write(K_FRIENDS, friends);
    write(K_TAGS, customTags);
    write(K_TOMB, tombs);
  }

  function allTags() { return PRESET_TAGS.concat(customTags); }

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
        return (f.name + ' ' + f.relation + ' ' + f.note).toLowerCase().indexOf(k) >= 0;
      });
    }
    var s = pref.sort;
    list = list.slice().sort(function (a, b) {
      if (s === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN');
      if (s === 'status') {
        var d = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
        return d !== 0 ? d : a.name.localeCompare(b.name, 'zh-Hans-CN');
      }
      var r = (a.date || '').localeCompare(b.date || '');
      if (s === 'date-asc') return r !== 0 ? r : a.name.localeCompare(b.name, 'zh-Hans-CN');
      return r !== 0 ? -r : a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    return list;
  }

  /* ---------------- 渲染 ---------------- */
  function renderStats() {
    var scope = scopedByTag();
    $('sAll').textContent = scope.length;
    $('sConfirmed').textContent = scope.filter(function (f) { return f.status === 'confirmed'; }).length;
    $('sPending').textContent = scope.filter(function (f) { return f.status === 'pending'; }).length;
    $('sDeclined').textContent = scope.filter(function (f) { return f.status === 'declined'; }).length;
    [].forEach.call(document.querySelectorAll('.stat'), function (b) {
      b.classList.toggle('on', b.dataset.status === filterStatus);
    });
    $('brandSub').textContent = friends.length
      ? '共 ' + friends.length + ' 人 · 确认 ' + friends.filter(function (f) { return f.status === 'confirmed'; }).length + ' 人'
      : '已通知名单 · 出席跟踪';
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
    if (f.note) meta.push('<span class="mnote">' + esc(f.note) + '</span>');
    return '<div class="row" data-id="' + f.id + '">' +
      '<div class="row-main">' +
      '<div class="row-name">' + esc(f.name) + '</div>' +
      (meta.length ? '<div class="row-meta">' + meta.join('') + '</div>' : '') +
      '</div>' +
      '<button class="badge b-' + f.status + '" data-toggle="' + f.id + '">' + STATUS_TEXT[f.status] + '</button>' +
      '</div>';
  }

  function renderList() {
    renderFold();
    var list = visible(), box = $('list');
    $('listCount').textContent = list.length + ' 人';
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

  function render() { renderStats(); renderTags(); renderList(); }

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
    renderTagPicker();

    $('formMask').hidden = false;
  }
  function closeForm() { $('formMask').hidden = true; editingId = null; }

  $('batchMode').addEventListener('change', function () { toggleBatch(this.checked); });
  function toggleBatch(on) {
    $('fName').hidden = on;
    $('fNames').hidden = !on;
    $('batchHint').hidden = !on;
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

  /* ---------------- 标签管理 ---------------- */
  function addTagPrompt() {
    var name = prompt('新标签名称');
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    if (allTags().indexOf(name) >= 0) { toast('这个标签已经有了'); return; }
    customTags.push(name);
    saveTags();
    render();
    toast('已添加标签「' + name + '」');
  }

  $('btnManageTags').addEventListener('click', function () {
    var rows = allTags().map(function (t) {
      var isPreset = PRESET_TAGS.indexOf(t) >= 0;
      var n = friends.filter(function (f) { return f.relation === t; }).length;
      return '<div class="tagrow"><span>' + esc(t) + '</span><em>' + n + ' 人</em>' +
        (isPreset ? '<button disabled>预设</button>'
          : '<button data-del="' + esc(t) + '">删除</button>') + '</div>';
    }).join('');
    openModal('标签管理',
      '<div class="mod-sec"><p>预设标签不可删除。删除自定义标签后，原本属于它的朋友会变成「未分组」，记录不会丢。</p>' +
      rows + '</div>' +
      '<div class="mod-sec"><button class="sec-btn block" id="mAddTag">＋ 新增标签</button></div>',
      function (body) {
        body.addEventListener('click', function (e) {
          var add = e.target.closest('#mAddTag');
          if (add) { closeModal(); addTagPrompt(); return; }
          var del = e.target.closest('[data-del]');
          if (!del) return;
          var t = del.dataset.del;
          if (!confirm('删除标签「' + t + '」？属于它的朋友会变成未分组。')) return;
          snapshot();
          customTags = customTags.filter(function (x) { return x !== t; });
          friends.forEach(function (f) { if (f.relation === t) { f.relation = ''; f.updatedAt = now(); } });
          commit();
          if (filterTag === t) filterTag = null;
          closeModal(); render(); toast('已删除标签');
        });
      });
  });

  /* ---------------- 通用弹层 ---------------- */
  function openModal(title, html, after) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = html;
    $('modalMask').hidden = false;
    if (after) after($('modalBody'));
  }
  function closeModal() { $('modalMask').hidden = true; $('modalBody').innerHTML = ''; }
  $('btnModalClose').addEventListener('click', closeModal);
  $('modalMask').addEventListener('click', function (e) { if (e.target === this) closeModal(); });

  /* ---------------- 同步码（跨设备） ---------------- */
  // 紧凑编码：[name, relation, date, statusIndex, note, updatedAt] 数组 → JSON → UTF8 → base64
  function encodeData() {
    var tagList = allTags();
    var payload = {
      v: 3,
      t: customTags,
      f: friends.map(function (f) {
        return [f.name, f.relation || '', f.date || '', STATUS_ORDER.indexOf(f.status),
        f.note || '', f.updatedAt || 0, f.id];
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
          status: STATUS_ORDER[a[3]] || 'notified', note: a[4] || '', updatedAt: a[5] || 0
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
          Object.assign(exist, n, { id: exist.id });
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
                  note: f.note || '', updatedAt: f.updatedAt || 0
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
      app: 'wedding-memo', version: 3, exportedAt: new Date().toISOString(),
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
    var text = title + '（' + list.length + ' 人）\n' +
      list.map(function (f, i) {
        return (i + 1) + '. ' + f.name +
          (f.relation ? ' · ' + f.relation : '') +
          ' · ' + STATUS_TEXT[f.status] +
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
      '<li>点一下右边的状态徽章，就在「已通知 → 确认出席 → 待确认 → 不来」之间循环切换。</li>' +
      '<li>点卡片任意位置进入编辑，删除按钮在编辑页里面。</li>' +
      '<li>点统计卡片可以直接筛选对应状态，再点一下取消。</li>' +
      '<li>批量录入时姓名支持换行、空格、逗号、顿号混用。</li>' +
      '</ul></div>' +
      '<div class="mod-sec"><h4>数据在哪</h4>' +
      '<p>全部存在这台手机的 Safari 本地，不上传任何服务器，断网也能用。换手机用「换机搬数据」的同步码，或者「备份与恢复」导出 JSON 文件。</p></div>' +
      '<div class="mod-sec"><h4>自检信息</h4>' +
      '<p id="diagBox" style="font-family:ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.8">读取中…</p>' +
      '<button class="sec-btn block" id="btnCopyDiag">复制自检信息</button></div>' +
      '<div class="mod-sec"><p style="color:#7d97ae">婚礼通知备忘录 v4.0 · iPhone 版</p></div>',
      function (body) {
        var lines = [
          '版本 v4.0-iOS',
          '记录 ' + friends.length + ' 条 · 自定义标签 ' + customTags.length + ' 个',
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
    if (!$('formMask').hidden) closeForm();
    else if (!$('modalMask').hidden) closeModal();
  });

  /* ---------------- 跨标签页/窗口同步 ---------------- */
  window.addEventListener('storage', function (e) {
    if (e.key === K_FRIENDS || e.key === K_TAGS) { loadAll(); render(); }
  });

  /* ---------------- 启动 ---------------- */
  loadAll();
  $('sortSel').value = pref.sort;
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
