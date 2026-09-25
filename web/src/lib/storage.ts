export type DraftKind = 'code' | 'answer';

function draftKey(id: string, kind: DraftKind): string {
  return kind === 'code' ? `arena:draft:${id}` : `arena:draft:${kind}:${id}`;
}

const BEST_KEY = (id: string): string => `arena:best:${id}`;

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadDraft(id: string, kind: DraftKind): string {
  return store()?.getItem(draftKey(id, kind)) ?? '';
}

export function saveDraft(id: string, kind: DraftKind, text: string): void {
  const s = store();
  if (!s) return;
  try {
    if (text === '') s.removeItem(draftKey(id, kind));
    else s.setItem(draftKey(id, kind), text);
  } catch {
    /* 私密模式或配额满：草稿只是便利功能，不影响答题 */
  }
}

/** 历史最佳只记"曾经通过"，后续失败不会覆盖它。 */
export function loadBestPass(id: string): boolean {
  return store()?.getItem(BEST_KEY(id)) === 'pass';
}

export function saveBestPass(id: string): void {
  try {
    store()?.setItem(BEST_KEY(id), 'pass');
  } catch {
    /* 同上 */
  }
}
