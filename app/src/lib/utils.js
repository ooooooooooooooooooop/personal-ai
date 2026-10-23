import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

/**
 * Loopback/RFC1918/link-local detection for provider baseUrls.
 * Mirrors the host/pi egress rule (dedup-h #1402): a private endpoint needs
 * an explicit allowPrivateNetwork opt-in — typing a private URL into this
 * localhost-only app plus the checkbox IS that opt-in.
 */
export function isPrivateBaseUrl(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
    const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  } catch {
    return false;
  }
}

/**
 * 跨平台路径归一化：消除 Windows 斜杠与大小写盘符差异
 */
export function normPath(p) {
  if (!p || typeof p !== 'string') return '';
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 比较两段物理路径是否指向同一目录/文件
 */
export function samePath(a, b) {
  if (!a || !b) return false;
  return normPath(a) === normPath(b);
}

/**
 * 深度清洗文本内容，剥离框架内部元数据与系统提示词标签，保证仅向用户呈现有意义的内容
 */
export function cleanDisplayContent(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/^# PERSONAL AI BRIEF[\s\S]*?(?=\n\n[^#]|$)/m, '')
    .replace(/<personal-ai-instructions[\s\S]*?<\/personal-ai-instructions>/gi, '')
    .replace(/<untrusted-content-policy[\s\S]*?<\/untrusted-content-policy>/gi, '')
    .replace(/<ambient>[\s\S]*?<\/ambient>/gi, '')
    .replace(/<steering>[\s\S]*?<\/steering>/gi, '')
    .replace(/<budget>[\s\S]*?<\/budget>/gi, '')
    .replace(/<observations>[\s\S]*?<\/observations>/gi, '')
    .replace(/<open-predictions>[\s\S]*?<\/open-predictions>/gi, '')
    .replace(/<memory[^>]*>[\s\S]*?<\/memory>/gi, '')
    .replace(/<pinned-files>[\s\S]*?<\/pinned-files>/gi, '')
    .trim();
}
