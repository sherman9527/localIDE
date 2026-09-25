/** 面向答题者的错误文案：只说人话，不把后端堆栈搬到界面上。 */
const STATUS_HINT: Record<number, string> = {
  400: '请求不被接受',
  404: '找不到这道题',
  409: '状态已变化，请刷新',
  413: '提交内容过长',
  422: '提交内容不符合要求',
  429: '操作太频繁，稍等几秒',
  500: '服务端内部错误',
  502: '判题栈不可用',
  503: '服务还在启动',
  504: '等待判题超时',
};

export class ApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/** 取第一行"像人话"的内容，跳过 `at ...` 这类栈帧。 */
export function firstMeaningfulLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^at\s/.test(line) || /node_modules|\.(js|ts|java):\d+|^\^+$/.test(line)) continue;
    return line.slice(0, 160);
  }
  return '';
}

export async function toApiError(res: { status: number; text: () => Promise<string> }, label: string): Promise<ApiError> {
  let detail = '';
  try {
    detail = firstMeaningfulLine(await res.text());
  } catch {
    detail = '';
  }
  const hint = STATUS_HINT[res.status] ?? '服务端返回了错误';
  return new ApiError(`${label}失败：${hint}（HTTP ${res.status}${detail ? `：${detail}` : ''}）`, res.status);
}

export function offlineError(label: string): ApiError {
  return new ApiError(`${label}失败：连不上本地服务，请确认容器已启动（./start.sh）`);
}

/** 给界面用的一句话原因。 */
export function errorMessage(e: unknown): string {
  if (isAbort(e)) return '';
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return firstMeaningfulLine(e.message) || '出错了，请重试';
  return '出错了，请重试';
}
