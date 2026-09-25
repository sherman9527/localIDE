import { RangeSetBuilder, StateEffect, StateField, type Extension, type RangeSet } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, keymap } from '@codemirror/view';

/**
 * 编辑器行号槽上的**断点**（WI-81）。
 *
 * 为什么写成 CodeMirror 扩展而不是 React 覆盖层：断点跟着行走 ——
 * 代码加一行、删一行，覆盖层里的点会留在原来的**屏幕位置**上，指到别的代码去。
 * 那正是"骗人"的那种 bug，而 gutter 的 marker 天生按行号定位。
 *
 * 状态的真值仍在 React 那边（面板要拿它发请求）；这里只是一份镜像，
 * 通过 `syncBreakpoints` 单向同步。**镜像不许反过来当真值用**。
 */

export interface BreakpointState {
  lines: number[];
  /** 当前停在哪一行（null = 没在调试） */
  stopped: number | null;
}

const setBreakpointState = StateEffect.define<BreakpointState>();

const breakpointField = StateField.define<BreakpointState>({
  create: () => ({ lines: [], stopped: null }),
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setBreakpointState)) return effect.value;
    return value;
  },
});

/**
 * 一行**只有一个**标记。
 *
 * 早先每行可以叠两个（红点 + ▶），再配上"hover 整条槽就给每一行画一个空心圈"的样式，
 * 结果用户看到的是"一个白点一个红点同时出现"（两个都指同一行，等于谁都没说清）。
 * 现在：断点=红点；停在**没有**断点的行=▶；停在**自己有**断点的行=红点套一圈主色，
 * 并把那一行的**行号**涂成主色加粗 —— "停在哪"由行号说，断点槽只说"这里有没有断点"。
 */
class DotMarker extends GutterMarker {
  constructor(readonly active = false) {
    super();
  }
  override toDOM(): Node {
    const el = document.createElement('span');
    el.className = this.active ? 'cm-bp-dot cm-bp-active' : 'cm-bp-dot';
    el.title = this.active ? '断点（正停在这里）' : '断点';
    return el;
  }
  override eq(other: GutterMarker): boolean {
    // active 变了必须重画：只比 instanceof 的话，"停上来"这一步就没有任何视觉变化
    return other instanceof DotMarker && other.active === this.active;
  }
}

class HereMarker extends GutterMarker {
  override toDOM(): Node {
    const el = document.createElement('span');
    el.className = 'cm-bp-here';
    el.title = '停在这里';
    return el;
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof HereMarker;
  }
}

const DOT = new DotMarker();
const DOT_ACTIVE = new DotMarker(true);
const HERE = new HereMarker();

function markersFor(view: EditorView): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  const state = view.state.field(breakpointField);
  const doc = view.state.doc;
  const inRange = (n: number): boolean => n >= 1 && n <= doc.lines;
  const stopped = state.stopped !== null && inRange(state.stopped) ? state.stopped : null;
  const lines = new Set<number>(state.lines.filter(inRange));
  if (stopped !== null) lines.add(stopped);
  // RangeSetBuilder 要求按位置升序 add
  for (const n of [...lines].sort((a, b) => a - b)) {
    const from = doc.line(n).from;
    builder.add(from, from, n === stopped ? (state.lines.includes(n) ? DOT_ACTIVE : HERE) : DOT);
  }
  return builder.finish();
}

/**
 * 停住的那一行整行铺一层主色底 —— "我在哪"这件事本来就该由代码行自己说，
 * 不必在行号槽上再挤第二个标记（那正是"一个白点一个红点"的来源）。
 */
const stoppedLineDecoration = EditorView.decorations.compute([breakpointField], (state) => {
  const stopped = state.field(breakpointField).stopped;
  const doc = state.doc;
  if (stopped === null || stopped < 1 || stopped > doc.lines) return Decoration.none;
  return Decoration.set([Decoration.line({ class: 'cm-bp-line' }).range(doc.line(stopped).from)]);
});

export interface BreakpointOptions {
  /** 这门语言现在能不能打断点（读 ref，别把扩展重建一遍） */
  enabled: () => boolean;
  onToggle: (line: number) => void;
}

export function breakpointGutter(options: BreakpointOptions): Extension[] {
  const toggleAt = (view: EditorView, line: number): boolean => {
    if (!options.enabled()) return false;
    options.onToggle(line);
    return true;
  };
  return [
    breakpointField,
    stoppedLineDecoration,
    gutter({
      class: 'cm-gutter-breakpoints',
      // 每行都要有格子：不然空白处点不到，用户会以为"点行号没反应"
      renderEmptyElements: true,
      markers: (view) => markersFor(view),
      lineMarkerChange: (update) =>
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setBreakpointState))),
      domEventHandlers: {
        mousedown: (view, line) => toggleAt(view, view.state.doc.lineAt(line.from).number),
      },
    }),
    // 键盘也得能下断点：只给鼠标等于少一条路（Mod-F9 与常见编辑器一致）
    keymap.of([
      {
        key: 'Mod-F9',
        preventDefault: true,
        run: (view) => toggleAt(view, view.state.doc.lineAt(view.state.selection.main.head).number),
      },
    ]),
  ];
}

/** 把 React 那份断点状态镜像进编辑器。view 还没建好时什么都不做（建好时会同步一次）。 */
export function syncBreakpoints(view: EditorView | null, state: BreakpointState): void {
  if (!view) return;
  view.dispatch({ effects: setBreakpointState.of({ lines: [...state.lines], stopped: state.stopped }) });
}
