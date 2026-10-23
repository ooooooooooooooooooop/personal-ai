/**
 * Bridge Client API for Personal AI.
 * Handles POST /cmd and GET /events SSE stream.
 *
 * Complies with PRD v2.0 (F01-F09, B01, B12):
 * - Strict real-contract enforcement: NO silent mock fallbacks in production paths.
 * - HTTP failures / network drops return explicit error receipts.
 * - Stamps client_msg_id for prompt idempotency and recovery.
 */

export function generateClientMsgId() {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function sendCmd(type, params = {}) {
  try {
    const res = await fetch('/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...params }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        success: false,
        error: `HTTP ${res.status}${errText ? `: ${errText}` : ''}`,
        status: res.status,
      };
    }
    return await res.json();
  } catch (err) {
    return {
      success: false,
      error: err.message || '网络连接失败',
      offline: true,
    };
  }
}

export function subscribeEvents(onEvent, onError) {
  let es = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    try {
      if (es) {
        try { es.close(); } catch {}
      }
      es = new EventSource('/events');
      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          onEvent(data);
        } catch (err) {
          console.error('[Bridge] SSE parse error:', err);
        }
      };
      es.onerror = (e) => {
        if (onError) onError(e);
      };
    } catch (err) {
      console.warn('[Bridge] SSE connection failed:', err);
      if (onError) onError(err);
    }
  };

  connect();

  // 当窗口恢复聚焦或切换回前台时，若检测到连接异常中断立即自愈重连
  const onWakeOrFocus = () => {
    if (closed) return;
    if (!es || es.readyState === EventSource.CLOSED) {
      connect();
    }
  };

  window.addEventListener('focus', onWakeOrFocus);
  document.addEventListener('visibilitychange', onWakeOrFocus);

  return () => {
    closed = true;
    window.removeEventListener('focus', onWakeOrFocus);
    document.removeEventListener('visibilitychange', onWakeOrFocus);
    if (es) es.close();
  };
}

export async function pickDirectory() {
  try {
    const res = await fetch('/api/pick-dir', { method: 'POST' });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.dir ?? null;
  } catch {
    return null;
  }
}
