// ============================================================
// 6.2.2 整合交付：分項證據結果頁（閱讀／克漏字）
//
// 【內容邊界（使用者已核准）】
//   只顯示「原始作答表現」與「弱項來源」：
//     ・分子／分母、題量、篇量、覆蓋範圍、重答與提示狀態
//     ・弱項只列真的答錯或有提示的觀測單元（不是用 unknown 推測）
//   不顯示能力等級、不換算等級分數、不設通過／停測門檻、不產生任務、
//   不改 SRS 或每日份量、不重算詞彙一次性資格（那些都還沒校準／未核准）。
//   提示未觀測時如實寫「未觀測」，不寫成「沒有提示」：模擬考作答前只有整篇文章的
//   中文翻譯可展開（考古題卷、每組首題一次），那是整篇輔助、沒有逐題觀測紀錄，
//   620／621 的逐題提示名單也還沒交付——所以逐題提示狀態只能是「未觀測」。
//
// 【生命週期（沿用 daily-tasks／learning-data 的既有風格）】
//  ・進場遞增 epoch，離頁作廢本輪（router 的離頁清理會呼叫本檔的 onLeave）。
//  ・authReady 後才取 owner 與 auth generation；每個 await 回來都檢查
//    「仍是同一 owner＋同一 generation＋仍停在本頁」——A→B→A 的舊結果不得畫上新頁。
//  ・auth:changed → 停手並給「重新開啟」真按鈕（不假裝資料還在）。
//  ・本頁只讀，不在瀏覽時建立／改寫場次（舊版會在開頁時 ensureSession，
//    等於「看一次就多一場」，已移除）。
//  ・寫入失敗的事件留在 pending 佇列，本頁顯示「未保存」與重試；重試失敗如實顯示。
// ============================================================
import { el, escapeHtml } from '../core/ui.js';
import { on } from '../core/eventbus.js';
import { aggregateEvidence, SECTION_KEYS, SECTION_LABELS } from '../core/evidence-aggregate.js';
import {
  HINT_NOT_OBSERVED, HINT_OBSERVATION_UNVERIFIED, assertAlive, createEvidenceStore, makeGuard, toAggregateEvents,
} from '../services/evidence-store.js';
import { runEvidenceWritesInFlight, waitForRunEvidenceWrites } from '../practice/exam-evidence.js';

export const ROUTE = '#/exam-evidence';

// 明示既有模擬考的邊界（不假稱跨裝置／不假稱可續答）：
//   run 只在 exam.js 的模組記憶體，重新整理＝回到設定畫面，不會續答、也不會補寫證據；
//   本頁讀的是這台裝置的本機 IndexedDB，沒有雲端同步。
export const LOCAL_ONLY_NOTE = '這些作答紀錄只在這台裝置的本機 IndexedDB，這個帳戶看不到別台裝置的紀錄；'
  + '跨裝置同步尚未實作。既有模擬考的作答場次只存在記憶體（run 沒有持久化）：重新整理或關閉頁面後無法續答，'
  + '也不會補寫任何證據。';

let epoch = 0;
let unsubAuth = null;
let defaultStore = null;

function getStore(deps) {
  if (deps?.store) return deps.store;
  if (!defaultStore) defaultStore = createEvidenceStore();
  return defaultStore;
}

function statusText(status) {
  if (status === 'measured') return '已記錄';
  if (status === 'partial') return '部分（覆蓋不完整）';
  return '未測（未知）';
}

// 題量／篇量要用「這個分項所有觀測單元」的總和，不是只算已測單元：
// 彙整核心的 section.raw.itemCount 只累加「已測」單元，遇到未作答的單元會少算，
// 甚至在全未測時顯示 0（不是 0 題，是不知道答了幾題）。這裡改由單元原始量彙總，
// 保留真正呈現出來的題量／篇量；有單元缺值時標「部分未提供」，不補 0。
function unitTotals(section) {
  const totals = { items: 0, passages: 0, itemsUnknown: 0, passagesUnknown: 0, units: section.units.length };
  for (const unit of section.units) {
    if (unit.raw.itemCount == null) totals.itemsUnknown += 1;
    else totals.items += unit.raw.itemCount;
    if (unit.raw.passageCount == null) totals.passagesUnknown += 1;
    else totals.passages += unit.raw.passageCount;
  }
  return totals;
}

function totalsText(section, kind, unitLabel) {
  const totals = unitTotals(section);
  const known = kind === 'item' ? totals.items : totals.passages;
  const unknown = kind === 'item' ? totals.itemsUnknown : totals.passagesUnknown;
  if (totals.units === 0 || unknown === totals.units) return '未提供';
  const suffix = unknown > 0 ? '（部分單元未提供）' : '';
  return `${known} ${unitLabel}${suffix}`;
}

function rawCountText(section) {
  const { numerator, denominator, measuredUnits } = section.raw;
  // 沒有任何已測單元 → 未知，不顯示 0/0 冒充 0 分。
  if (measuredUnits === 0 || numerator == null || denominator == null) {
    return '—（沒有可用的分子／分母，不是 0 分）';
  }
  return `${numerator} / ${denominator}`;
}

function coverageText(section) {
  const { coverage } = section;
  if (coverage.status === 'unknown') return '未知';
  return `${coverage.attempted}/${coverage.available}（${coverage.status === 'complete' ? '完整' : '部分'}）`;
}

function hintUnknownOf(unit) {
  return unit.missingReasons.some((entry) => entry.code === HINT_NOT_OBSERVED);
}

// 舊資料（v1 把「沒有名單」寫成 false）留下來的「觀測不確定」：不是「沒有提示」。
function hintUnverifiedOf(unit) {
  return unit.missingReasons.some((entry) => entry.code === HINT_OBSERVATION_UNVERIFIED);
}

function weaknessRows(aggregate) {
  const rows = [];
  for (const key of SECTION_KEYS) {
    const section = aggregate.sections[key];
    for (const unit of section.units) {
      if (unit.status !== 'measured' && unit.status !== 'unknown') continue;
      const wrong = unit.status === 'measured' && unit.raw.numerator != null
        ? unit.raw.denominator - unit.raw.numerator
        : null;
      const isWeak = unit.originalError || unit.hinted;
      if (!isWeak) continue;
      rows.push({
        section: SECTION_LABELS[key],
        sourceId: unit.sourceId,
        source: unit.source,
        wrong,
        denominator: unit.raw.denominator,
        hinted: unit.hinted,
        hintUnknown: hintUnknownOf(unit),
        hintUnverified: hintUnverifiedOf(unit),
        retakeCount: unit.retakeCount,
        laterCorrected: unit.laterCorrected,
        missing: unit.missingReasons.map((entry) => entry.code),
      });
    }
  }
  return rows;
}

function hintAuditText(aggregate) {
  let observed = 0;
  let unobserved = 0;
  let unverified = 0;
  for (const key of SECTION_KEYS) {
    for (const unit of aggregate.sections[key].units) {
      if (hintUnknownOf(unit)) unobserved += 1;
      else observed += 1;
      if (hintUnverifiedOf(unit)) unverified += 1;
    }
  }
  if (!observed && !unobserved) return '提示狀態：目前沒有可判定的觀測單元。';
  const legacy = unverified
    ? `其中 ${unverified} 個是舊資料（舊版把「沒有名單」記成 false），只能算觀測不確定，不能當成「沒有提示」。`
    : '';
  if (unobserved && !observed) {
    return `提示狀態：${unobserved} 個觀測單元未觀測（模擬考只有整篇文章的中文翻譯可展開，`
      + '沒有逐題提示紀錄；620／621 的逐題提示名單也還沒交付）。'
      + `${legacy}未觀測不等於「沒有提示」，不列入提示統計，也不改變弱項判定。`;
  }
  if (unobserved) {
    return `提示狀態：已觀測 ${observed} 個單元、未觀測 ${unobserved} 個（未觀測不推定為沒有提示）。${legacy}`;
  }
  return `提示狀態：${observed} 個觀測單元皆有提示狀態。${legacy}`;
}

// 保存中：本場還有在途寫入時，先講清楚「正在保存」，不要在數字上假裝已完成一半。
function savingCard() {
  return el(`
    <section class="card">
      <h2>分項表現（閱讀／克漏字）</h2>
      <p class="muted" role="status" id="ee-saving">本場分項證據正在保存中…保存完成後自動顯示；
        若保存失敗會列出未保存的項目並提供「重新保存」，不會先顯示半套數字。</p>
    </section>`);
}

function renderPending(main, model, handlers) {
  const host = main.querySelector('#ee-pending');
  if (!host) return;
  if (!model.pending.length) {
    host.replaceChildren();
    return;
  }
  host.replaceChildren(el(`
    <div class="card error" role="status">
      <h3>有 ${model.pending.length} 筆分項證據尚未保存</h3>
      <p class="muted small">這些作答只留在本機待寫佇列；在成功寫入前，本頁不會把它們算進上面的統計。</p>
      <div class="controls">
        <button type="button" class="btn primary" id="ee-retry">重新保存</button>
      </div>
      <p class="muted small" id="ee-retry-status"></p>
    </div>`));
  host.querySelector('#ee-retry').addEventListener('click', () => handlers.retry());
}

function paint(main, model) {
  const head = `<tr><th>分項</th><th>答對／作答</th><th>題量</th><th>篇量</th><th>覆蓋</th><th>狀態</th></tr>`;
  const rows = SECTION_KEYS.map((key) => {
    const section = model.aggregate.sections[key];
    return `<tr data-section="${escapeHtml(key)}">
      <td>${escapeHtml(section.label)}</td>
      <td>${escapeHtml(rawCountText(section))}</td>
      <td>${escapeHtml(totalsText(section, 'item', '題'))}</td>
      <td>${escapeHtml(totalsText(section, 'passage', '篇'))}</td>
      <td>${escapeHtml(coverageText(section))}</td>
      <td>${escapeHtml(statusText(section.status))}</td>
    </tr>`;
  }).join('');

  const weak = weaknessRows(model.aggregate);
  const hintNoteOf = (row) => {
    if (row.hinted) return '・有提示';
    if (row.hintUnverified) return '・提示未觀測（舊資料，觀測不確定）';
    if (row.hintUnknown) return '・提示未觀測';
    return '';
  };
  const weakList = weak.length
    ? `<ul class="ee-weak">${weak.map((row) => `<li data-source-id="${escapeHtml(row.sourceId)}">
        ${escapeHtml(row.section)}・${escapeHtml(row.source)}・${escapeHtml(row.sourceId)}：
        ${row.wrong == null ? '未作答（不算錯）' : `錯 ${row.wrong} 題（答對 ${row.denominator - row.wrong}/${row.denominator}）`}${hintNoteOf(row)}${row.retakeCount ? `・重答 ${row.retakeCount} 次` : ''}${row.laterCorrected ? '・重答後答對（原始錯誤保留）' : ''}
      </li>`).join('')}</ul>`
    : `<p class="muted">目前沒有「實際答錯或有提示」的單元。</p>`;

  const audit = model.aggregate;
  main.replaceChildren(el(`
    <section class="card">
      <h2>分項表現（閱讀／克漏字）</h2>
      <p class="muted small">只顯示你自己的原始作答表現與錯題來源。目前沒有校準資料，所以不評能力等級、不設通過或停測門檻，也不改變每日任務份量、SRS 排程或診斷資格。</p>
      <div id="ee-pending"></div>
      <table class="exam-report ee-table">
        <tr class="er-head"><td colspan="6">原始表現（分子／分母只算已作答的題；未作答不是 0 分）</td></tr>
        ${head}
        ${rows}
      </table>
      <h3>弱項（限實際錯題或有提示的來源）</h3>
      ${weakList}
      <h3>審計</h3>
      <p class="muted small">重複（同場次同單元重送）${audit.duplicates.count} 筆；衝突（同 id 內容不同，保留第一筆）${audit.conflicts.count} 筆；被拒（帳戶或格式不符）${audit.rejected.count} 筆；重答審計 ${SECTION_KEYS.reduce((sum, key) => sum + audit.sections[key].measurement.retakeCount, 0)} 筆。</p>
      <p class="muted small" id="ee-hint-audit">${escapeHtml(hintAuditText(audit))}</p>
      <p class="muted small" id="ee-local-note">${escapeHtml(LOCAL_ONLY_NOTE)}</p>
      <div class="controls">
        <a class="btn primary" href="#/exam">回模擬考</a>
      </div>
    </section>`));
  renderPending(main, model, model.handlers);
}

function emptyCard(reason) {
  return el(`
    <section class="card">
      <h2>分項表現（閱讀／克漏字）</h2>
      <p role="status">${escapeHtml(reason)}</p>
      <div class="controls">
        <a class="btn primary" href="#/exam">去模擬考</a>
      </div>
      <p class="muted small">${escapeHtml(LOCAL_ONLY_NOTE)}</p>
    </section>`);
}

/**
 * 頁面渲染（router 以 render: 'renderExamEvidenceResult' 呼叫）。
 * deps 只給測試注入：{ store, auth:{getUser,getAuthGeneration,authReady}, getUser, getAuthGeneration }
 */
export async function renderExamEvidenceResult(main, deps = {}) {
  epoch += 1;
  unsubAuth?.();
  unsubAuth = null;
  const myEpoch = epoch;
  const store = getStore(deps);
  let authMod = deps.auth || null;
  const getUser = () => (deps.getUser ? deps.getUser() : (authMod?.getUser?.() ?? null));
  const getGeneration = () => (deps.getAuthGeneration ? deps.getAuthGeneration() : (authMod?.getAuthGeneration?.() ?? 0));
  const stillOn = () => {
    // 路由是否還在這一頁：hash 被換走就不再把 DOM 寫回 main。
    const hash = String(globalThis.location?.hash || '');
    return !hash || hash.startsWith(ROUTE);
  };

  main.replaceChildren(el(`
    <section class="card">
      <h2>分項表現（閱讀／克漏字）</h2>
      <p class="muted" role="status">正在讀取本機作答紀錄…</p>
    </section>`));

  if (!authMod) authMod = await import('../services/auth.js');
  if (myEpoch !== epoch) return;
  await (authMod.authReady || Promise.resolve());
  if (myEpoch !== epoch) return;

  const owner = getUser();
  const authGeneration = getGeneration();
  const guard = makeGuard({
    ownerId: owner?.id ?? null,
    generation: authGeneration,
    getOwnerId: () => getUser()?.id ?? null,
    getGeneration: () => getGeneration(),
  });
  const alive = () => myEpoch === epoch && stillOn() && guard.alive();

  if (!owner?.id) {
    main.replaceChildren(emptyCard('登入後即可查看你自己的閱讀／克漏字分項表現。'));
    return;
  }

  // 【保存中就先等，不顯示半套】
  // 成績頁的「分項表現」連結不阻塞導覽（不設超時、不截斷寫入），所以進來時本場可能還在寫。
  // 這裡等「同一個帳戶當時在途的那幾份寫入承諾」全部落地，再讀一次 IndexedDB；
  // 期間畫面明確寫「正在保存中」。等不到（寫入失敗）就照實顯示未保存與重試，不假裝完成。
  if (runEvidenceWritesInFlight(owner.id) > 0) {
    main.replaceChildren(savingCard());
    await waitForRunEvidenceWrites(owner.id);
    if (myEpoch !== epoch) return;
    if (!stillOn() || !guard.alive()) return;
  }

  unsubAuth = on('auth:changed', () => {
    const wasCurrent = myEpoch === epoch;
    epoch += 1;
    unsubAuth?.();
    unsubAuth = null;
    if (!wasCurrent) return;
    main.replaceChildren(el(`
      <section class="card">
        <h2>分項表現（閱讀／克漏字）</h2>
        <p role="status">帳戶已變更，請重新開啟此頁。</p>
        <div class="controls controls-start">
          <button type="button" class="btn primary" id="ee-reopen">重新開啟</button>
        </div>
      </section>`));
    main.querySelector('#ee-reopen').onclick = () => renderExamEvidenceResult(main, deps);
  });

  let events;
  let pending;
  try {
    // 讀之前再確認一次：如果有人在這段時間開始寫（例如成績頁剛送出），再等同一份承諾。
    for (;;) {
      if (runEvidenceWritesInFlight(owner.id) > 0) {
        main.replaceChildren(savingCard());
        await waitForRunEvidenceWrites(owner.id);
        if (!alive()) return;
        continue;
      }
      events = await store.listEvents(owner.id);
      if (!alive()) return;
      if (runEvidenceWritesInFlight(owner.id) === 0) break;
    }
    pending = await store.listPending(owner.id);
  } catch (err) {
    if (!alive()) return;
    main.replaceChildren(el(`
      <section class="card error">
        <h2>分項表現（閱讀／克漏字）</h2>
        <p role="status">讀取本機紀錄失敗：${escapeHtml(String(err?.message || err))}</p>
        <div class="controls"><a class="btn" href="#/exam">回模擬考</a></div>
      </section>`));
    return;
  }
  if (!alive()) return;

  // 本頁只讀：不呼叫 ensureSession（瀏覽結果頁不該建立或改寫場次）。
  const aggregate = aggregateEvidence(owner.id, toAggregateEvents(events));
  const model = {
    aggregate,
    pending,
    handlers: {
      async retry() {
        const statusEl = main.querySelector('#ee-retry-status');
        if (statusEl) statusEl.textContent = '正在重新保存…';
        try {
          assertAlive(guard);
          const result = await store.flushPending(owner.id, { guard });
          if (!alive()) return;
          if (result.failed > 0 || result.remaining > 0) {
            if (statusEl) statusEl.textContent = `仍有 ${result.remaining} 筆未能保存（${result.failedCodes.join('、') || '未知原因'}）；資料仍在待寫佇列，重新整理後可再試。`;
            return;
          }
          const again = await store.listEvents(owner.id);
          if (!alive()) return;
          pending = await store.listPending(owner.id);
          if (!alive()) return;
          paint(main, {
            aggregate: aggregateEvidence(owner.id, toAggregateEvents(again)),
            pending,
            handlers: model.handlers,
          });
        } catch (err) {
          if (!alive()) return;
          if (statusEl) statusEl.textContent = `重新保存失敗：${String(err?.message || err)}`;
        }
      },
    },
  };
  if (!events.length && !pending.length) {
    main.replaceChildren(emptyCard('這個帳戶在本機還沒有閱讀／克漏字的作答紀錄。'));
    return;
  }
  paint(main, model);
}

/** 供 router／測試清理：離頁時解除訂閱並作廢本輪。 */
export function leaveExamEvidence() {
  epoch += 1;
  unsubAuth?.();
  unsubAuth = null;
}

// router 的離頁清理會呼叫模組的 onLeave（見 patches/router.patch 把本路由列入離頁清單）。
export const onLeave = leaveExamEvidence;
