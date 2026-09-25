// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StackRadar, radarAxes, type RadarPoint } from '../src/components/StackRadar';

/**
 * 技术栈雷达图（N-03）：只测"图有没有说实话"，不测像素。
 * 断言点集中在三件容易做错的事：顶点数与轴一致、满格落在外圈、没数据的栈不能被画成 0 分。
 */

const POINTS: RadarPoint[] = [
  { id: 'frontend', label: '前端工程', accuracy: 1, answered: 4 },
  { id: 'algorithms', label: '算法', accuracy: 0.5, answered: 6 },
  { id: 'sql', label: 'SQL 与存储', accuracy: 0, answered: 2 },
  { id: 'system-design', label: '系统设计', accuracy: 0.75, answered: 3 },
  { id: 'big-data', label: '大数据处理', accuracy: 0, answered: 0 },
  { id: 'agent-design', label: 'Agent 设计', accuracy: 0.2, answered: 1 },
  { id: 'hot-interviews', label: '高频面试题', accuracy: 0, answered: 0 },
];

afterEach(() => cleanup());

describe('StackRadar', () => {
  it('每根轴一条辐条，数据多边形顶点数与轴数相同', () => {
    const ui = render(<StackRadar points={POINTS} />);
    const spokes = ui.container.querySelectorAll('[data-part="spoke"]');
    const vertices = (ui.container.querySelector('[data-part="shape"]')?.getAttribute('points') ?? '').trim().split(/\s+/);
    expect(spokes.length).toBe(radarAxes.length);
    expect(vertices).toHaveLength(radarAxes.length);
  });

  it('正确率 100% 的点落在外圈半径上，50% 落在一半处', () => {
    const ui = render(<StackRadar points={POINTS} />);
    const raw = ui.container.querySelector('[data-part="shape"]')!.getAttribute('points')!;
    const pts = raw.trim().split(/\s+/).map((p) => p.split(',').map(Number) as [number, number]);
    const distance = (p: [number, number]) => Math.hypot(p[0] - 130, p[1] - 130);
    expect(distance(pts[0]!) / distance(pts[1]!)).toBeCloseTo(2, 1); // 100% vs 50%
    expect(distance(pts[4]!)).toBeLessThan(1); // 没练过的栈画在圆心，不能"看起来很强"
  });

  it('标注最弱的已练栈，让人知道下一步练什么', () => {
    const ui = render(<StackRadar points={POINTS} />);
    const svg = ui.container.querySelector('svg')!;
    expect(svg.getAttribute('aria-label')).toContain('SQL 与存储');
  });

  it('画布比图形本身宽：中文标签有 5 个字，viewBox 收紧就会把左右两侧裁掉', () => {
    const ui = render(<StackRadar points={POINTS} />);
    const [minX, , w] = (ui.container.querySelector('svg')!.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);
    expect(minX!).toBeLessThanOrEqual(-40);
    expect(w!).toBeGreaterThan(260);
  });

  it('一题都没答过时明说没数据，而不是画一个空圈', () => {
    const none = POINTS.map((p) => ({ ...p, answered: 0, accuracy: 0 }));
    const ui = render(<StackRadar points={none} />);
    expect(ui.container.textContent).toContain('还没有可比较的数据');
    expect(ui.container.querySelector('[data-part="shape"]')).toBeNull();
  });
});
