// ============================================================
// 6.2.2 分項證據彙整核心（自足產品模組；由產生器產生，勿手改）
//
// 來源（已核准、37 項測試驗過）：6.0/prototypes/6.2.2/evidence-aggregate.mjs
// 來源內容 SHA-256（LF 正規化後）：dee3e5cef3ab8f977de7164f91f179a4a85064cb2c35d6cc14f110d125cef656
// 產生器：6.0/authoring/622-integration/tools/gen-evidence-core.mjs
//   node authoring/622-integration/tools/gen-evidence-core.mjs           # 重新產生
//   node authoring/622-integration/tools/gen-evidence-core.mjs --check   # 核對是否一致
//
// 【為什麼是產生檔而不是 re-export／手抄】
//   ・這些彙整規則（去重 tuple、觀測單元、unknown／coverage／retake／提示政策）
//     已在來源檔驗過 37 項；產品若另外手抄一份，兩份規則一定會分叉。
//   ・但產品也不能在發布時用多層相對路徑去 import prototypes：公開包 import graph
//     不允許依賴 prototypes／authoring／tests 目錄（測試會強制檢查）。
//   所以這裡放的是「來源原文」，外層只加這段說明與 hash，供任何人核對：
//     重新產生 → 逐 byte 相同；payload SHA-256 → 與上面記載值相同。
//   規則一句都沒改，改規則請改來源檔再重新產生。
// ============================================================
// ===== 已核准核心原文開始（以下逐 byte 等於來源檔，勿手改）=====
// 6.2.2 前置核心：分項證據彙整純函式。
// 只做「保留原始觀測值」與「避免重複／衝突／跨帳戶污染」，不做能力估計。
// 詞彙、閱讀、綜合測驗（克漏字）各自獨立；未測或不可用資料維持 unknown，
// 不以 0 分代替，也不合成總能力、不套用既有題型的部分得分公式。

export const SECTION_KEYS = Object.freeze(['vocabulary', 'reading', 'cloze']);

export const SECTION_LABELS = Object.freeze({
  vocabulary: '詞彙',
  reading: '閱讀',
  cloze: '綜合測驗（克漏字）',
});

export const EVENT_CONTRACT = Object.freeze({
  version: 1,
  required: ['eventId', 'ownerId', 'section', 'sessionId', 'occurredAt', 'provenance'],
  optional: ['measure', 'missing', 'hinted'],
  provenance: ['source', 'sourceId', 'revision?', 'capturedAt?'],
  measure: ['numerator?', 'denominator?', 'itemCount?', 'passageCount?', 'coverage?'],
  coverage: ['attempted', 'available'],
  sections: SECTION_KEYS,
  duplicateKey: 'JSON.stringify([provenance.source, provenance.sourceId, eventId])',
  unitKey: 'JSON.stringify([section, sessionId, provenance.source, provenance.sourceId])',
  conflictPolicy: '相同來源與事件 ID 但內容不同時保留第一筆並回報衝突，不靜默覆寫。',
  ownerPolicy: '只接受與彙整 ownerId 相同的事件；跨 owner 一律拒收。',
  retakePolicy: '同一來源觀測單元（section+sessionId+source+sourceId）內的重答只留審計；同場不同來源單元分開保留，不增加 session 數。',
  hintPolicy: '任一筆重答有提示，該來源單元視為有提示；不同來源單元的提示不互相污染。',
  unknownPolicy: '沒有可用分子／分母時維持 unknown；未測不是 0 分。',
  thresholdPolicy: '沒有校準資料，不設定程度、通過或停測門檻。',
  taskPolicy: '只回未定提案，不產生或寫入任何真實任務。',
});

const SECTION_SET = new Set(SECTION_KEYS);
const THRESHOLDS = Object.freeze({ status: 'not_calibrated', level: null, pass: null, stop: null });
const QUOTA = Object.freeze({ status: 'pending_review', value: null });

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function issue(code, detail, index, extra = {}) {
  return { code, detail, index, ...extra };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeMissing(value, index, issues) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    issues.push(issue('INVALID_MISSING', 'missing 必須是陣列', index));
    return [];
  }
  const out = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ code: item.trim(), detail: null });
    } else if (isPlainObject(item) && nonEmptyString(item.code)) {
      out.push({
        code: item.code.trim(),
        detail: typeof item.detail === 'string' && item.detail.trim() ? item.detail.trim() : null,
      });
    } else {
      issues.push(issue('INVALID_MISSING', 'missing 項目必須是非空字串或含 code 的物件', index));
    }
  }
  return out;
}

function nullableCount(value, name, index, issues) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    issues.push(issue('INVALID_MEASURE', `${name} 必須是非負整數或 null`, index));
    return null;
  }
  return value;
}

function normalizeCoverage(value, index, issues) {
  if (value == null) return null;
  if (!isPlainObject(value)) {
    issues.push(issue('INVALID_COVERAGE', 'coverage 必須是物件或 null', index));
    return null;
  }
  const attempted = nullableCount(value.attempted, 'coverage.attempted', index, issues);
  const available = nullableCount(value.available, 'coverage.available', index, issues);
  if (attempted == null || available == null) {
    issues.push(issue('INVALID_COVERAGE', 'coverage 必須同時提供 attempted 與 available', index));
    return null;
  }
  if (attempted > available) {
    issues.push(issue('INVALID_COVERAGE', 'coverage.attempted 不可大於 available', index));
    return null;
  }
  return { attempted, available };
}

function normalizeMeasure(value, section, index, issues) {
  if (value == null) {
    return { numerator: null, denominator: null, itemCount: null, passageCount: null, coverage: null };
  }
  if (!isPlainObject(value)) {
    issues.push(issue('INVALID_MEASURE', 'measure 必須是物件或 null', index));
    return null;
  }
  const numerator = nullableCount(value.numerator, 'measure.numerator', index, issues);
  const denominator = nullableCount(value.denominator, 'measure.denominator', index, issues);
  const itemCount = nullableCount(value.itemCount, 'measure.itemCount', index, issues);
  const passageCount = nullableCount(value.passageCount, 'measure.passageCount', index, issues);
  const coverage = normalizeCoverage(value.coverage, index, issues);
  const hasNumerator = numerator != null;
  const hasDenominator = denominator != null;
  if (hasNumerator !== hasDenominator) {
    issues.push(issue('INVALID_MEASURE', '分子與分母必須同時提供，或同時留 null', index));
  }
  if (hasDenominator && denominator === 0) {
    issues.push(issue('INVALID_MEASURE', '分母必須大於 0', index));
  }
  if (hasNumerator && hasDenominator && numerator > denominator) {
    issues.push(issue('INVALID_MEASURE', '分子不可大於分母', index));
  }
  if (section === 'reading' && passageCount === 0) {
    issues.push(issue('INVALID_MEASURE', '閱讀篇量為 0 時不可標成已測', index));
  }
  return { numerator, denominator, itemCount, passageCount, coverage };
}

function normalizeEvent(raw, expectedOwnerId, index) {
  const issues = [];
  if (!isPlainObject(raw)) {
    return { ok: false, issues: [issue('INVALID_EVENT', '事件必須是物件', index)] };
  }
  const ownerId = nonEmptyString(raw.ownerId);
  if (!ownerId) issues.push(issue('INVALID_OWNER', 'ownerId 必須是非空字串', index));
  if (ownerId && ownerId !== expectedOwnerId) {
    issues.push(issue('OWNER_MISMATCH', '事件 ownerId 與彙整 ownerId 不符', index));
  }
  const eventId = nonEmptyString(raw.eventId);
  if (!eventId) issues.push(issue('INVALID_EVENT_ID', 'eventId 必須是非空字串', index));
  const section = nonEmptyString(raw.section);
  if (!section || !SECTION_SET.has(section)) {
    issues.push(issue('INVALID_SECTION', `section 必須是 ${SECTION_KEYS.join('／')}`, index));
  }
  const sessionId = nonEmptyString(raw.sessionId);
  if (!sessionId) issues.push(issue('INVALID_SESSION', 'sessionId 必須是非空字串', index));
  if (!Number.isFinite(raw.occurredAt) || raw.occurredAt < 0) {
    issues.push(issue('INVALID_OCCURRED_AT', 'occurredAt 必須是有限非負數（epoch ms）', index));
  }
  let hinted = false;
  if (Object.prototype.hasOwnProperty.call(raw, 'hinted')) {
    if (typeof raw.hinted !== 'boolean') {
      issues.push(issue('INVALID_HINTED', 'hinted 必須是布林值', index));
    } else {
      hinted = raw.hinted;
    }
  }
  let source = null;
  let sourceId = null;
  let revision = null;
  let capturedAt = null;
  if (!isPlainObject(raw.provenance)) {
    issues.push(issue('MISSING_PROVENANCE', 'provenance 必須是含 source 與 sourceId 的物件', index));
  } else {
    source = nonEmptyString(raw.provenance.source);
    sourceId = nonEmptyString(raw.provenance.sourceId);
    if (!source) issues.push(issue('MISSING_PROVENANCE', 'provenance.source 必須是非空字串', index));
    if (!sourceId) issues.push(issue('MISSING_PROVENANCE', 'provenance.sourceId 必須是非空字串', index));
    if (raw.provenance.revision != null) {
      revision = nonEmptyString(raw.provenance.revision);
      if (!revision) issues.push(issue('MISSING_PROVENANCE', 'provenance.revision 必須是非空字串或省略', index));
    }
    if (raw.provenance.capturedAt != null) {
      if (!Number.isFinite(raw.provenance.capturedAt) || raw.provenance.capturedAt < 0) {
        issues.push(issue('MISSING_PROVENANCE', 'provenance.capturedAt 必須是有限非負數', index));
      } else {
        capturedAt = raw.provenance.capturedAt;
      }
    }
  }
  const missing = normalizeMissing(raw.missing, index, issues);
  const measure = normalizeMeasure(raw.measure, section, index, issues);
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    event: {
      eventId,
      ownerId,
      section,
      sessionId,
      occurredAt: raw.occurredAt,
      provenance: { source, sourceId, revision, capturedAt },
      measure,
      hinted,
      missing,
    },
  };
}

export function eventKey(event) {
  return JSON.stringify([event.provenance.source, event.provenance.sourceId, event.eventId]);
}

export function unitKey(event) {
  return JSON.stringify([event.section, event.sessionId, event.provenance.source, event.provenance.sourceId]);
}

function measurePresent(measure) {
  return measure != null && measure.numerator != null && measure.denominator != null;
}

function coverageStatus(coverage) {
  if (!coverage) return 'unknown';
  return coverage.attempted === coverage.available ? 'complete' : 'partial';
}

function uniqueMissing(entries) {
  const map = new Map();
  for (const item of entries) {
    const key = JSON.stringify([item.code, item.detail || null]);
    if (!map.has(key)) map.set(key, {
      code: item.code,
      detail: item.detail,
      sessions: new Set(),
      units: new Set(),
    });
    if (item.sessionId) map.get(key).sessions.add(item.sessionId);
    if (item.unitKey) map.get(key).units.add(item.unitKey);
  }
  return [...map.values()]
    .map((item) => ({
      code: item.code,
      detail: item.detail,
      sessions: [...item.sessions].sort(),
      units: [...item.units].sort(),
    }))
    .sort((a, b) => a.code.localeCompare(b.code) || String(a.detail || '').localeCompare(String(b.detail || '')));
}

function primaryCompare(a, b) {
  return a.occurredAt - b.occurredAt
    || a.eventId.localeCompare(b.eventId)
    || a.provenance.source.localeCompare(b.provenance.source)
    || a.provenance.sourceId.localeCompare(b.provenance.sourceId)
    || a.sessionId.localeCompare(b.sessionId);
}

function summarizeUnit(events) {
  const ordered = [...events].sort(primaryCompare);
  const primary = ordered[0];
  const retakes = ordered.slice(1);
  const measured = measurePresent(primary.measure);
  const raw = primary.measure || { numerator: null, denominator: null, itemCount: null, passageCount: null, coverage: null };
  const hinted = ordered.some((event) => event.hinted);
  const originalError = measured && raw.numerator < raw.denominator;
  const hadAnyError = ordered.some((event) => measurePresent(event.measure) && event.measure.numerator < event.measure.denominator);
  const laterCorrected = Boolean(originalError && retakes.some((event) => (
    measurePresent(event.measure)
    && event.measure.numerator === event.measure.denominator
    && !event.hinted
  )));
  const missing = [];
  for (const entry of primary.missing) missing.push({ ...entry, sessionId: primary.sessionId });
  if (!measured) {
    missing.push({ code: 'NO_RAW_COUNTS', detail: '沒有可用的分子／分母，維持未知', sessionId: primary.sessionId });
  }
  if (!raw.coverage) {
    missing.push({ code: 'COVERAGE_UNKNOWN', detail: '未提供覆蓋範圍', sessionId: primary.sessionId });
  } else if (raw.coverage.attempted < raw.coverage.available) {
    missing.push({ code: 'PARTIAL_COVERAGE', detail: `${raw.coverage.attempted}/${raw.coverage.available}`, sessionId: primary.sessionId });
  }
  if (raw.itemCount == null) {
    missing.push({ code: 'ITEM_COUNT_UNKNOWN', detail: '未提供題量', sessionId: primary.sessionId });
  }
  if ((primary.section === 'reading' || primary.section === 'cloze') && raw.passageCount == null) {
    missing.push({ code: 'PASSAGE_COUNT_UNKNOWN', detail: '未提供篇量', sessionId: primary.sessionId });
  }
  return {
    key: unitKey(primary),
    unitKey: unitKey(primary),
    sessionId: primary.sessionId,
    section: primary.section,
    source: primary.provenance.source,
    sourceId: primary.provenance.sourceId,
    status: measured ? 'measured' : 'unknown',
    primaryEventId: primary.eventId,
    provenance: { ...primary.provenance },
    raw: {
      numerator: raw.numerator,
      denominator: raw.denominator,
      itemCount: raw.itemCount,
      passageCount: raw.passageCount,
    },
    coverage: {
      attempted: raw.coverage ? raw.coverage.attempted : null,
      available: raw.coverage ? raw.coverage.available : null,
      status: coverageStatus(raw.coverage),
    },
    hinted,
    originalError,
    hadAnyError,
    laterCorrected,
    retakeCount: retakes.length,
    retakeEventIds: retakes.map((event) => event.eventId).sort(),
    retakeMissingReasons: retakes.flatMap((event) => event.missing.map((entry) => ({
      ...entry,
      sessionId: primary.sessionId,
      eventId: event.eventId,
    }))),
    missingReasons: uniqueMissing(missing),
  };
}

function summarizeSection(section, units, sessionIds) {
  const measured = units.filter((unit) => unit.status === 'measured');
  let numerator = 0;
  let denominator = 0;
  let itemCount = 0;
  let passageCount = 0;
  let itemCountKnown = 0;
  let passageCountKnown = 0;
  let coverageAttempted = 0;
  let coverageAvailable = 0;
  let coverageKnown = 0;
  let coverageComplete = 0;
  for (const unit of measured) {
    numerator += unit.raw.numerator;
    denominator += unit.raw.denominator;
    if (unit.raw.itemCount != null) {
      itemCount += unit.raw.itemCount;
      itemCountKnown += 1;
    }
    if (unit.raw.passageCount != null) {
      passageCount += unit.raw.passageCount;
      passageCountKnown += 1;
    }
    if (unit.coverage.status !== 'unknown') {
      coverageAttempted += unit.coverage.attempted;
      coverageAvailable += unit.coverage.available;
      coverageKnown += 1;
      if (unit.coverage.status === 'complete') coverageComplete += 1;
    }
  }
  const missingEntries = units.flatMap((unit) => unit.missingReasons.map((entry) => ({
    ...entry,
    sessionId: unit.sessionId,
    unitKey: unit.unitKey,
  })));
  if (!units.length) {
    missingEntries.push({ code: 'NO_EVENTS', detail: '此分項沒有任何事件', sessionId: null });
  }
  const coverage = coverageKnown === 0
    ? { attempted: null, available: null, status: 'unknown', units: 0 }
    : {
        attempted: coverageAttempted,
        available: coverageAvailable,
        status: coverageKnown === units.length && coverageComplete === measured.length ? 'complete' : 'partial',
        units: coverageKnown,
      };
  let status = 'unknown';
  if (measured.length) {
    const allCovered = coverage.status === 'complete';
    status = allCovered && measured.length === units.length ? 'measured' : 'partial';
  }
  return {
    key: section,
    label: SECTION_LABELS[section],
    status,
    raw: {
      unit: 'raw_counts',
      numerator,
      denominator,
      itemCount,
      passageCount,
      measuredUnits: measured.length,
      unknownUnits: units.length - measured.length,
      itemCountKnownUnits: itemCountKnown,
      passageCountKnownUnits: passageCountKnown,
    },
    coverage,
    unitCount: units.length,
    sessionCount: sessionIds.size,
    sessionIds: [...sessionIds].sort(),
    measurement: {
      measuredUnits: measured.length,
      unknownUnits: units.length - measured.length,
      unaidedCorrectUnits: measured.filter((unit) => (
        unit.raw.numerator === unit.raw.denominator
        && !unit.hinted
        && !unit.originalError
      )).length,
      hintedUnits: units.filter((unit) => unit.hinted).length,
      originalErrorUnits: units.filter((unit) => unit.originalError).length,
      laterCorrectedUnits: units.filter((unit) => unit.laterCorrected).length,
      retakeCount: units.reduce((sum, unit) => sum + unit.retakeCount, 0),
    },
    missingReasons: uniqueMissing(missingEntries),
    thresholds: { ...THRESHOLDS },
    taskQuota: { ...QUOTA },
    units: units.map((unit) => ({ ...unit })),
  };
}

export function aggregateEvidence(ownerId, events) {
  if (!nonEmptyString(ownerId)) throw new TypeError('ownerId 必須是非空字串');
  if (!Array.isArray(events)) throw new TypeError('events 必須是陣列');
  const accepted = new Map();
  const rejected = [];
  const conflicts = [];
  const duplicates = [];
  for (let index = 0; index < events.length; index += 1) {
    const rawEventId = isPlainObject(events[index]) ? nonEmptyString(events[index].eventId) : null;
    const normalized = normalizeEvent(events[index], ownerId, index);
    if (!normalized.ok) {
      rejected.push({
        index,
        code: normalized.issues[0].code,
        detail: normalized.issues[0].detail,
        issues: normalized.issues,
        eventId: rawEventId,
      });
      continue;
    }
    if (normalized.event.ownerId !== ownerId) continue;
    const key = eventKey(normalized.event);
    const canonical = stableStringify(normalized.event);
    const existing = accepted.get(key);
    if (!existing) {
      accepted.set(key, { event: normalized.event, canonical, index });
      continue;
    }
    if (existing.canonical === canonical) {
      duplicates.push({
        key,
        eventId: normalized.event.eventId,
        source: { ...normalized.event.provenance },
        keptIndex: existing.index,
        duplicateIndex: index,
      });
      continue;
    }
    conflicts.push({
      key,
      eventId: normalized.event.eventId,
      source: { ...normalized.event.provenance },
      keptIndex: existing.index,
      conflictIndex: index,
      code: 'EVENT_ID_CONTENT_CONFLICT',
      detail: '相同來源與事件 ID 的內容不同；保留第一筆，未覆寫。',
    });
  }
  const sorted = [...accepted.values()]
    .map((entry) => entry.event)
    .sort(primaryCompare);
  const sections = {};
  for (const section of SECTION_KEYS) {
    const sectionEvents = sorted.filter((event) => event.section === section);
    const groups = new Map();
    for (const event of sectionEvents) {
      const key = unitKey(event);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }
    const units = [...groups.values()]
      .map(summarizeUnit)
      .sort((a, b) => String(a.unitKey).localeCompare(String(b.unitKey)));
    const sessionIds = new Set(units.map((unit) => unit.sessionId));
    sections[section] = summarizeSection(section, units, sessionIds);
  }
  const aggregate = {
    contractVersion: EVENT_CONTRACT.version,
    ownerId,
    sectionOrder: [...SECTION_KEYS],
    sections,
    duplicates: { count: duplicates.length, items: duplicates },
    conflicts: { count: conflicts.length, items: conflicts },
    rejected: { count: rejected.length, items: rejected },
    combinedAbility: null,
    combinedAbilityReason: 'NOT_COMPUTED_BY_CONTRACT',
    thresholds: { ...THRESHOLDS },
  };
  aggregate.taskProposal = buildTaskCombinationProposal(aggregate);
  return aggregate;
}

export function buildTaskCombinationProposal(aggregate, { proposalId = 'task-combination-622' } = {}) {
  if (!aggregate || !aggregate.sections) throw new TypeError('需要 aggregateEvidence 的結果');
  const basis = {};
  for (const key of SECTION_KEYS) {
    const section = aggregate.sections[key];
    basis[key] = {
      label: section.label,
      status: section.status,
      measuredUnits: section.raw.measuredUnits,
      unknownUnits: section.raw.unknownUnits,
      sessionCount: section.sessionCount,
      unitCount: section.unitCount,
      hintedUnits: section.measurement.hintedUnits,
      originalErrorUnits: section.measurement.originalErrorUnits,
    };
  }
  return {
    proposalId,
    status: 'pending_review',
    approved: false,
    syntheticOnly: true,
    writesTasks: false,
    basis,
    quotas: Object.fromEntries(SECTION_KEYS.map((key) => [key, { ...QUOTA }])),
    weights: Object.fromEntries(SECTION_KEYS.map((key) => [key, { ...QUOTA }])),
    rules: {
      dailyQuota: 'pending_review',
      oneShot: 'pending_review',
      continuation: 'pending_review',
      thresholds: 'not_calibrated',
      dailyLoad: 'not_changed',
    },
    proposedTasks: [],
    notes: [
      '這是未定提案，不是任務清單，也不會寫入任何帳戶或學習紀錄。',
      '權重、題量、一次性與續作規則都待產品與校準資料審核。',
      '既有每日份量、SRS、診斷資格與 6.0.0／6.0.2 證據規則不因本提案改變。',
    ],
  };
}
