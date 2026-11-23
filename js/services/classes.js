// 班級名單（7.5 P1，2026-11-24）
//
// 純邏輯：加入代碼產生與暱稱規則（可測）；REST 呼叫只在使用者操作時發生。
// 隱私：只傳暱稱，不傳本名／email。
import { loadSupabaseConfig } from './sync.js';
import { getAccessToken, getUser } from './auth.js';

// 去掉容易看錯的字元（0/O、1/I/L）
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export function generateJoinCode(rand = Math.random) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  }
  return out;
}

export function isValidCode(code) {
  return new RegExp('^[' + CODE_ALPHABET + ']{' + CODE_LENGTH + '}$').test(String(code || '').trim().toUpperCase());
}

export function normalizeNickname(name) {
  const n = String(name || '').trim();
  if (n.length < 1) return { ok: false, code: 'NICK_REQUIRED' };
  if (n.length > 20) return { ok: false, code: 'NICK_TOO_LONG' };
  return { ok: true, value: n };
}

async function rest(path, init = {}) {
  const cfg = await loadSupabaseConfig();
  if (!cfg.configured) throw new Error('NOT_CONFIGURED');
  const token = await getAccessToken();
  const base = cfg.url.replace(/\/$/, '');
  const res = await fetch(base + '/rest/v1/' + path, {
    ...init,
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function createClass(name) {
  const n = String(name || '').trim().slice(0, 40);
  if (!n) return { ok: false, code: 'NAME_REQUIRED' };
  const user = getUser();
  if (!user?.id) return { ok: false, code: 'NOT_LOGGED_IN' };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateJoinCode();
    try {
      const rows = await rest('classes', {
        method: 'POST',
        body: JSON.stringify([{ teacher_id: user.id, name: n, join_code: code }]),
      });
      const row = Array.isArray(rows) ? rows[0] : rows;
      return { ok: true, class: row };
    } catch (err) {
      if (!/409|23505/.test(String(err.message))) return { ok: false, code: 'CREATE_FAILED' };
    }
  }
  return { ok: false, code: 'CODE_COLLISION' };
}

export async function joinClass(code, nickname) {
  const c = String(code || '').trim().toUpperCase();
  if (!isValidCode(c)) return { ok: false, code: 'BAD_CODE' };
  const nick = normalizeNickname(nickname);
  if (!nick.ok) return { ok: false, code: nick.code };
  try {
    const cfg = await loadSupabaseConfig();
    const token = await getAccessToken();
    const res = await fetch(cfg.url.replace(/\/$/, '') + '/rest/v1/rpc/join_class_by_code', {
      method: 'POST',
      headers: { apikey: cfg.key, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_code: c, p_nickname: nick.value }),
    });
    if (!res.ok) return { ok: false, code: 'HTTP_' + res.status };
    const r = await res.json();
    return r && r.ok ? { ok: true, classId: r.class_id, className: r.class_name } : { ok: false, code: (r && r.reason) || 'JOIN_FAILED' };
  } catch {
    return { ok: false, code: 'JOIN_FAILED' };
  }
}

export async function listMyClasses() {
  const user = getUser();
  if (!user?.id) return [];
  try {
    const rows = await rest('classes?teacher_id=eq.' + user.id + '&select=*&order=created_at.desc');
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

export async function listMembers(classId) {
  try {
    const rows = await rest('class_members?class_id=eq.' + classId + '&select=nickname,joined_at&order=joined_at.asc');
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

// ---- 7.5 P2：指派任務 ----
export function normalizeTarget(target) {
  const t = target || {};
  if (t.type === 'level') {
    const minLv = Math.max(1, Math.min(7, Number(t.minLv) || 1));
    const maxLv = Math.max(1, Math.min(7, Number(t.maxLv) || minLv));
    if (minLv > maxLv) return { ok: false, code: 'BAD_RANGE' };
    return { ok: true, value: { type: 'level', minLv, maxLv } };
  }
  if (t.type === 'words') {
    const ids = Array.isArray(t.wordIds)
      ? t.wordIds.filter((x) => x !== null && x !== '' && Number.isFinite(Number(x)) && Number(x) > 0).map(Number)
      : [];
    if (!ids.length) return { ok: false, code: 'NO_WORDS' };
    return { ok: true, value: { type: 'words', wordIds: ids.slice(0, 200) } };
  }
  if (t.type === 'exam') {
    const id = String(t.examId || '').trim();
    if (!id) return { ok: false, code: 'NO_EXAM' };
    return { ok: true, value: { type: 'exam', examId: id.slice(0, 60) } };
  }
  return { ok: false, code: 'BAD_TYPE' };
}

export function normalizeDueAt(value) {
  if (!value) return { ok: true, value: null };
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return { ok: false, code: 'BAD_DATE' };
  if (t < Date.now() - 60_000) return { ok: false, code: 'PAST_DATE' };
  return { ok: true, value: new Date(t).toISOString() };
}

export async function createAssignment({ classId, title, target, dueAt }) {
  const name = String(title || '').trim().slice(0, 60);
  if (!name) return { ok: false, code: 'TITLE_REQUIRED' };
  const tg = normalizeTarget(target);
  if (!tg.ok) return { ok: false, code: tg.code };
  const due = normalizeDueAt(dueAt);
  if (!due.ok) return { ok: false, code: due.code };
  const user = getUser();
  if (!user?.id) return { ok: false, code: 'NOT_LOGGED_IN' };
  try {
    const rows = await rest('assignments', {
      method: 'POST',
      body: JSON.stringify([{ class_id: classId, teacher_id: user.id, title: name, target: tg.value, due_at: due.value }]),
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return { ok: true, assignment: row };
  } catch (err) {
    return { ok: false, code: /403/.test(String(err.message)) ? 'FORBIDDEN' : 'CREATE_FAILED' };
  }
}

export async function listAssignments(classId) {
  try {
    const rows = await rest('assignments?class_id=eq.' + classId + '&select=*&order=created_at.desc');
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

export async function listMyAssignments() {
  const user = getUser();
  if (!user?.id) return [];
  try {
    const rows = await rest('class_members?student_id=eq.' + user.id + '&select=class_id');
    const ids = (Array.isArray(rows) ? rows : []).map((r) => r.class_id);
    if (!ids.length) return [];
    const q = ids.map((id) => '"' + id + '"').join(',');
    const out = await rest('assignments?class_id=in.(' + q + ')&select=*&order=due_at.asc.nullslast');
    return Array.isArray(out) ? out : [];
  } catch { return []; }
}

// ---- 7.5 P3：班級聚合檢視 ----
// 只回聚合（人數、平均字數、複習次數），不回個別學生。
export async function classStats(classId) {
  try {
    const cfg = await loadSupabaseConfig();
    const token = await getAccessToken();
    const baseUrl = cfg.url.endsWith('/') ? cfg.url.slice(0, -1) : cfg.url;
    const res = await fetch(baseUrl + '/rest/v1/rpc/class_stats', {
      method: 'POST',
      headers: { apikey: cfg.key, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_class_id: classId }),
    });
    if (!res.ok) return { ok: false, code: 'HTTP_' + res.status };
    const r = await res.json();
    if (!r || !r.ok) return { ok: false, code: (r && r.reason) || 'NO_DATA' };
    return {
      ok: true,
      members: Number(r.members) || 0,
      withData: Number(r.withData) || 0,
      avgMarks: Number(r.avgMarks) || 0,
      avgReviews: Number(r.avgReviews) || 0,
      totalMarks: Number(r.totalMarks) || 0,
      totalReviews: Number(r.totalReviews) || 0,
    };
  } catch { return { ok: false, code: 'STATS_FAILED' }; }
}

export function formatClassStats(s) {
  if (!s || !s.ok) return '尚無資料';
  if (!s.members) return '班上還沒有成員';
  return '成員 ' + s.members + ' 人（有資料 ' + s.withData + ' 人）｜平均每人 ' + s.avgMarks + ' 個待複習字、複習 ' + s.avgReviews + ' 次';
}

// ---- 7.5 P4：班級季賽（只做班級整體） ----
// 計分規則（刻意簡單、可解釋）：每 1 個待複習字 2 分、每 1 次複習 1 分。
// 不做個人排行：避免把弱勢學生標記出來（7.5 評估文件已列此風險）。
export function scoreOf(stats) {
  if (!stats || !stats.ok) return 0;
  const marks = Number(stats.totalMarks) || 0;
  const reviews = Number(stats.totalReviews) || 0;
  return marks * 2 + reviews;
}

export function rankClasses(list) {
  const rows = (Array.isArray(list) ? list : [])
    .filter((c) => c && c.stats && c.stats.ok)
    .map((c) => ({ id: c.id, name: c.name, members: c.stats.members, score: scoreOf(c.stats) }));
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

export function formatRanking(rows) {
  if (!rows || !rows.length) return '尚無班級資料';
  return rows.map((r, i) => (i + 1) + '. ' + r.name + '（' + r.members + ' 人）：' + r.score + ' 分').join('　');
}

// ---- 7.5 追加：老師可見 email／個人排行 ----
async function rpc(name, body) {
  const cfg = await loadSupabaseConfig();
  const token = await getAccessToken();
  const base = cfg.url.endsWith('/') ? cfg.url.slice(0, -1) : cfg.url;
  const res = await fetch(base + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, code: 'HTTP_' + res.status };
  const rows = await res.json();
  return { ok: true, rows: Array.isArray(rows) ? rows : [] };
}

// 老師限定：暱稱 + email
export async function classMemberContacts(classId) {
  const r = await rpc('class_member_contacts', { p_class_id: classId });
  if (!r.ok) return r;
  return { ok: true, rows: r.rows.map((x) => ({ nickname: String(x.nickname || ''), email: String(x.email || '') })) };
}

// 老師限定：個人排行（前端預設不顯示）
export async function classLeaderboard(classId) {
  const r = await rpc('class_leaderboard', { p_class_id: classId });
  if (!r.ok) return r;
  return {
    ok: true,
    rows: r.rows.map((x) => ({
      nickname: String(x.nickname || ''),
      marks: Number(x.marks) || 0,
      reviews: Number(x.reviews) || 0,
      score: Number(x.score) || 0,
    })),
  };
}

export function formatContacts(rows) {
  if (!Array.isArray(rows) || !rows.length) return '尚無成員';
  return rows.map((r) => r.nickname + (r.email ? '（' + r.email + '）' : '')).join('、');
}

export function formatLeaderboard(rows) {
  if (!Array.isArray(rows) || !rows.length) return '尚無資料';
  return rows.map((r, i) => (i + 1) + '. ' + r.nickname + '：' + r.score + ' 分（字 ' + r.marks + '／複習 ' + r.reviews + '）').join('　');
}