// 设备级偏好（静音、玩法看过没有），和存档 js/core/storage.js 是两回事：
// 存档记的是成绩，坏了要逐条丢；偏好只有几个布尔，坏了要逐**字段**回落默认值。
//
// 两段式解码在这里的含义：第一段把字符串读出来并 JSON.parse（读不到/抛了就是"没有偏好"），
// 第二段逐字段验型 —— 一个 `"muted":"yes"` 或整份 `null` 都不该让读偏好的调用方抛异常，
// 更不该把另一个好字段一起带走。所以这里没有 `Object.assign(defaults, JSON.parse(raw))`
// 那种一把梭：它遇到 `null` 会抛，抛在启动路径上就是整屏白。
//
// 用裸 `localStorage` 而不是 window.localStorage：这条全局访问在本仓只出现在浏览器侧模块，
// node 下 `typeof localStorage` 直接是 undefined，走"没有盘"的分支，不需要伪造 window。

const KEY = 'kakurasu.settings.v1';

export const SETTINGS_KEY = KEY;

export const defaults = { muted: false, helpSeen: false, lastMode: '' };

function available() {
  try {
    return typeof localStorage !== 'undefined' && !!localStorage
      && typeof localStorage.getItem === 'function'
      && typeof localStorage.setItem === 'function';
  } catch (err) {
    return false; // Safari 隐私模式下读这个属性本身就抛
  }
}

const BOOL = ['muted', 'helpSeen'];

// 第二段：逐字段。坏的一个字段回落它的默认值，其余照常生效。
function sanitize(parsed) {
  const out = { ...defaults };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const k of BOOL) {
    if (typeof parsed[k] === 'boolean') out[k] = parsed[k];
  }
  if (typeof parsed.lastMode === 'string' && parsed.lastMode.length <= 24) out.lastMode = parsed.lastMode;
  return out;
}

export function readSettings() {
  if (!available()) return { ...defaults, persistent: false };
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch (err) {
    return { ...defaults, persistent: false };
  }
  if (!raw) return { ...defaults, persistent: true };
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ...defaults, persistent: true, corrupt: true };
  }
  return { ...sanitize(parsed), persistent: true };
}

export function writeSettings(patch = {}) {
  const next = { ...readSettings(), ...patch };
  delete next.persistent;
  delete next.corrupt;
  if (!available()) return { ok: false, settings: next };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (err) {
    return { ok: false, settings: next }; // 配额或禁写：本次会话仍然生效，只是不落盘
  }
  return { ok: true, settings: next };
}
