/** Stable public categories; provider messages and credentials never become UI text. */
export function classifyMemoryFailure(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown } | null;
  const code = typeof value?.code === 'string' ? value.code : '';
  const message = typeof value?.message === 'string' ? value.message : String(error);
  const storedCode = /^[A-Z_]+(?=:|$)/u.exec(message)?.[0] ?? code;
  if (['MODEL_UNAVAILABLE', 'INVALID_MODEL_OUTPUT', 'MEMORY_TASK_TIMEOUT', 'SOURCE_CHANGED', 'TARGET_CHANGED',
    'MEMORY_WRITE_CONFLICT', 'MEMORY_TASK_CANCELLED', 'MEMORY_STORAGE_FAILED', 'MEMORY_AUTH_FAILED',
    'MEMORY_RATE_LIMITED', 'MEMORY_NETWORK_FAILED', 'EXTRACTION_FAILED'].includes(storedCode)) return storedCode;
  const text = `${code} ${message}`;
  if (/MODEL_UNAVAILABLE/u.test(text)) return 'MODEL_UNAVAILABLE';
  if (/INVALID_MODEL_OUTPUT|AI_STRUCTURED_OUTPUT_CONTRACT|SyntaxError|Schema|JSON|提炼模型返回|决策来源|证据不是|实际展示的有效记忆|重复决策|多个冲突操作/iu.test(text)
    || error instanceof SyntaxError) return 'INVALID_MODEL_OUTPUT';
  if (/TIMEOUT|timed?\s*out|超时/iu.test(text)) return 'MEMORY_TASK_TIMEOUT';
  if (/SOURCE_CHANGED|STALE_MEMORY_SOURCE|STALE_MEMORY_GENERATION|EXTRACTION_LEASE_EXPIRED/u.test(text)) return 'SOURCE_CHANGED';
  if (/TARGET_CHANGED|SOURCE_EXPIRED|TARGET_EXPIRED/u.test(text)) return 'TARGET_CHANGED';
  if (/MEMORY_WRITE_CONFLICT|TARGET_CONFLICT/u.test(text)) return 'MEMORY_WRITE_CONFLICT';
  if (/MEMORY_TASK_CANCELLED|AUTO_EXTRACTION_DISABLED|MEMORY_DISABLED/u.test(text)) return 'MEMORY_TASK_CANCELLED';
  if (/SQLITE_|MEMORY_STORAGE_FAILED|ENOSPC|EACCES|EROFS|数据库|磁盘/iu.test(text)) return 'MEMORY_STORAGE_FAILED';
  if (/MEMORY_AUTH_FAILED|\b(?:401|403)\b|unauthorized|forbidden|鉴权/iu.test(text)) return 'MEMORY_AUTH_FAILED';
  if (/MEMORY_RATE_LIMITED|\b429\b|rate.limit|限流/iu.test(text)) return 'MEMORY_RATE_LIMITED';
  if (/MEMORY_NETWORK_FAILED|fetch failed|ECONN|ENOTFOUND|network|连接失败/iu.test(text)) return 'MEMORY_NETWORK_FAILED';
  return 'EXTRACTION_FAILED';
}

export function memoryFailureMessage(reason?: string): string {
  return ({
    MODEL_UNAVAILABLE: '提炼模型不可用，请检查模型配置；原记忆未被覆盖',
    INVALID_MODEL_OUTPUT: '模型输出格式或证据校验未通过；本次候选未保存，原记忆保留',
    MEMORY_TASK_TIMEOUT: '提炼超时；原记忆未被覆盖，可稍后重试',
    SOURCE_CHANGED: '对话来源或记忆代际已变化；本次提炼已停止',
    TARGET_CHANGED: '要更正的旧记忆已变化；未覆盖旧记忆',
    MEMORY_WRITE_CONFLICT: '记忆写入冲突；未覆盖旧记忆，请先处理待确认提案',
    MEMORY_TASK_CANCELLED: '提炼已停止；未覆盖旧记忆',
    MEMORY_STORAGE_FAILED: '记忆数据库写入失败；未覆盖旧记忆，请检查磁盘和文件权限',
    MEMORY_AUTH_FAILED: '提炼服务鉴权失败；原记忆未被覆盖，请检查凭据',
    MEMORY_RATE_LIMITED: '提炼服务请求受限；原记忆未被覆盖，可稍后重试',
    MEMORY_NETWORK_FAILED: '无法连接提炼服务；原记忆未被覆盖，请检查连接',
  } as Record<string, string>)[reason ?? ''] ?? '自动提炼失败；原记忆未被覆盖，请查看应用日志';
}
