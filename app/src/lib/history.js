import { cleanDisplayContent } from './utils.js';

export function mapHistoryToMessages(historyList) {
  if (!Array.isArray(historyList)) return [];
  const merged = [];

  for (let idx = 0; idx < historyList.length; idx++) {
    const m = historyList[idx];
    const role = m.role || 'user';
    let text = '';
    if (typeof m.text === 'string') {
      text = m.text;
    } else if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content.map((c) => (typeof c === 'string' ? c : (c?.text || c?.content || ''))).join('');
    } else if (typeof m.content === 'object' && m.content !== null) {
      text = typeof m.content.content === 'string'
        ? m.content.content
        : (typeof m.content.text === 'string' ? m.content.text : '');
    } else if (m.text !== undefined && m.text !== null) {
      text = typeof m.text === 'object'
        ? (m.text.content || m.text.text || '')
        : String(m.text);
    }

    const cleanText = cleanDisplayContent(text);
    const model = typeof m.model === 'string' ? m.model : (m.model?.id || undefined);
    const rawErr = m.errorMessage || (typeof m.error === 'string' ? m.error : (m.error?.message || (typeof m.error === 'object' && m.error !== null ? JSON.stringify(m.error) : undefined)));
    const err = typeof rawErr === 'string' ? rawErr : undefined;
    const thinking = typeof m.thinking === 'string'
      ? m.thinking
      : (typeof m.thinking?.thinking === 'string' ? m.thinking.thinking : (m.thinking ? JSON.stringify(m.thinking) : ''));

    // 提取工具调用
    const tools = [];
    if (Array.isArray(m.tools)) {
      for (const t of m.tools) {
        tools.push(typeof t === 'string' ? { name: t, status: 'done' } : t);
      }
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c?.type === 'toolCall' || c?.type === 'tool_use') {
          let parsedArgs = c.args || c.input || c.arguments || {};
          if (typeof parsedArgs === 'string') {
            try { parsedArgs = JSON.parse(parsedArgs); } catch { parsedArgs = { raw: parsedArgs }; }
          }
          tools.push({
            id: c.id,
            name: c.name,
            args: parsedArgs,
            status: 'done',
          });
        }
      }
    } else if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let parsedArgs = tc.function?.arguments || tc.args || tc.input || tc.arguments || {};
        if (typeof parsedArgs === 'string') {
          try { parsedArgs = JSON.parse(parsedArgs); } catch { parsedArgs = { raw: parsedArgs }; }
        }
        tools.push({
          id: tc.id,
          name: tc.function?.name || tc.name,
          args: parsedArgs,
          status: 'done',
        });
      }
    }

    // Pi channel 回放时以 toolResult 形式返回工具结果，自动回填至对应工具调用
    if (role === 'toolResult' || role === 'tool_result' || role === 'tool') {
      const last = merged[merged.length - 1];
      if (last && last.role === 'assistant' && last.tools?.length) {
        const callId = m.toolCallId || m.tool_call_id || m.id;
        const matchingTool = (callId && last.tools.find((t) => t.id === callId)) || last.tools[last.tools.length - 1];
        if (matchingTool) {
          matchingTool.result = m.text || (Array.isArray(m.content) ? m.content.map((c) => c?.text || '').join('') : m.content) || '';
          matchingTool.status = m.error || m.isError ? 'error' : 'done';
          matchingTool.exitCode = m.exitCode ?? (m.error || m.isError ? 1 : 0);
        }
      }
      continue;
    }

    if (role === 'user') {
      merged.push({
        id: m.id || `hist-u-${idx}-${Date.now()}`,
        role: 'user',
        content: cleanText || text,
        timestamp: m.timestamp || Date.now(),
        attachments: m.attachments || [],
      });
    } else {
      // role === 'assistant'：同一轮内的所有连续思考、工具调用与最终回复统一归并入一个回合卡片
      const last = merged[merged.length - 1];
      if (last && last.role === 'assistant') {
        if (cleanText) {
          last.content = last.content ? `${last.content}\n\n${cleanText}` : cleanText;
        }
        if (thinking) {
          last.thinking = last.thinking ? `${last.thinking}\n${thinking}` : thinking;
        }
        if (tools.length) {
          last.tools = [...(last.tools || []), ...tools];
        }
        if (err) {
          last.error = err;
        } else if (m.stopReason === 'stop' || (cleanText && !err)) {
          // 成功产生最终正文或正常结束，清除中间重试遗留的瞬态错误
          last.error = undefined;
        }
        if (model && (!last.model || last.model === '未知模型')) last.model = model;
      } else {
        merged.push({
          id: m.id || `hist-a-${idx}-${Date.now()}`,
          role: 'assistant',
          content: cleanText,
          thinking,
          error: err,
          model: model || 'Personal AI',
          tools: tools.length ? tools : undefined,
        });
      }
    }
  }

  return merged;
}
