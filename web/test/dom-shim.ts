import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * jsdom 不实现 Range.getClientRects / Element.getClientRects，CodeMirror 测量文字高度时会抛，
 * 这里补一个"零尺寸"实现，让编辑器能在测试环境里正常挂载。
 */
type RectLike = {
  length: number;
  item: (index: number) => null;
};

const emptyRects = (): RectLike => {
  const list = [] as unknown as RectLike;
  Object.defineProperty(list, 'item', { value: () => null, enumerable: false });
  return list;
};

const rect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
};

const rangeProto = typeof Range !== 'undefined' ? (Range.prototype as unknown as Record<string, unknown>) : null;
if (rangeProto && typeof rangeProto.getClientRects !== 'function') {
  rangeProto.getClientRects = emptyRects;
  rangeProto.getBoundingClientRect = () => rect;
}

const elementProto = typeof Element !== 'undefined' ? (Element.prototype as unknown as Record<string, unknown>) : null;
if (elementProto && typeof elementProto.getClientRects !== 'function') {
  elementProto.getClientRects = emptyRects;
  elementProto.getBoundingClientRect = () => rect;
}

export {};

// RTL 的自动清理依赖 globals:true，从仓库根跑时拿不到；这里显式补一次，
// 否则多个组件测试互相看得到对方的 DOM（表现为"找不到 / 找到多个 element"）。
afterEach(() => cleanup());
