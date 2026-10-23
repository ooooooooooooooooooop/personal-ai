/**
 * 从消息流中提取问答轮次信息（用于对话目录与快速定位）
 */
export function extractTurns(messages, running = false) {
  if (!Array.isArray(messages)) return [];
  const turns = [];
  let currentTurn = null;

  const toSafeString = (val) => {
    if (typeof val === 'string') return val;
    if (typeof val?.content === 'string') return val.content;
    if (typeof val?.text === 'string') return val.text;
    if (Array.isArray(val)) {
      return val.map((c) => (typeof c === 'string' ? c : (c?.text || c?.content || ''))).join('');
    }
    return '';
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      const promptStr = toSafeString(msg.content);
      currentTurn = {
        id: msg.id || `turn-${i}`,
        userMsgId: msg.id,
        userMsg: msg,
        timestamp:
          msg.timestamp ||
          (typeof msg.id === 'string' && msg.id.startsWith('user-')
            ? Number(msg.id.split('-')[1])
            : Date.now()),
        prompt:
          promptStr.trim() ||
          (msg.attachments?.length ? `[${msg.attachments.length}个附件]` : '新提问'),
        stepCount: 0,
        toolsCount: 0,
        responseExcerpt: '',
        status: 'done', // 'done' | 'running' | 'interrupted' | 'error'
      };
      turns.push(currentTurn);
    } else if (currentTurn) {
      if (Array.isArray(msg.tools) && msg.tools.length > 0) {
        currentTurn.toolsCount += msg.tools.length;
        currentTurn.stepCount += msg.tools.length;
      }
      const rawContent = toSafeString(msg.content);
      if (rawContent) {
        const clean = rawContent.replace(/[\r\n]+/g, ' ').trim();
        if (clean && !currentTurn.responseExcerpt) {
          currentTurn.responseExcerpt = clean.length > 60 ? clean.slice(0, 60) + '…' : clean;
        }
      }
      if (msg.error || msg.errorMessage) {
        currentTurn.status = 'error';
      }
      if (
        msg.status === 'interrupted' ||
        msg.interrupted ||
        rawContent.includes('操作员中断') ||
        rawContent.includes('已中断')
      ) {
        currentTurn.status = 'interrupted';
      }
    }
  }

  if (running && turns.length > 0) {
    turns[turns.length - 1].status = 'running';
  }

  return turns;
}
