import { CATEGORY_IDS } from '@arena/shared';

/**
 * 技术栈正确率雷达（N-03）。手写 SVG，不引图表依赖：7 根轴的多边形而已，
 * 引一个 30KB+ 的库换一张静态图不值当（也违反"能不加依赖就不加"的约定）。
 * 下面的表格才是无障碍口径的数据源，这张图负责"一眼看出哪个角是凹的"。
 */

export interface RadarPoint {
  id: string;
  label: string;
  /** 0..1 */
  accuracy: number;
  answered: number;
}

/** 轴顺序 = 类别顺序（与题库、今日页一致，避免"同一张图两种顺序"）。 */
export const radarAxes = CATEGORY_IDS;

const SIZE = 260;
const CENTER = SIZE / 2;
const RADIUS = 96;
/** 左右两侧的中文标签有 5 个字，画布必须比图形本身宽，否则标签被 viewBox 裁掉。 */
const SIDE_PAD = 58;
const VIEW_W = SIZE + SIDE_PAD * 2;
const RINGS = [0.34, 0.67, 1];

function angleAt(index: number, total: number): number {
  return ((-90 + (360 / total) * index) * Math.PI) / 180;
}

function vertex(index: number, total: number, ratio: number): [number, number] {
  const angle = angleAt(index, total);
  return [CENTER + Math.cos(angle) * RADIUS * ratio, CENTER + Math.sin(angle) * RADIUS * ratio];
}

function toPoints(coords: [number, number][]): string {
  return coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

export function StackRadar({ points }: { points: RadarPoint[] }) {
  const practiced = points.filter((p) => p.answered > 0);
  if (practiced.length === 0) {
    return (
      <p className="small muted" data-part="empty">
        还没有可比较的数据 —— 每个栈至少答过一题之后，这里会画出你的形状。
      </p>
    );
  }
  const weakest = practiced.reduce((a, b) => (b.accuracy < a.accuracy ? b : a));
  const total = points.length;
  const shape = points.map((p, i) => vertex(i, total, p.answered > 0 ? p.accuracy : 0));

  return (
    <svg
      className="radar"
      role="img"
      width={VIEW_W}
      height={SIZE}
      viewBox={`${-SIDE_PAD} 0 ${VIEW_W} ${SIZE}`}
      aria-label={`各技术栈正确率雷达图；最弱的是 ${weakest.label} ${Math.round(weakest.accuracy * 100)}%（已练 ${weakest.answered} 题）`}
    >
      {RINGS.map((ring) => (
        <polygon
          key={ring}
          data-part="ring"
          className="radar-ring"
          points={toPoints(points.map((_, i) => vertex(i, total, ring)))}
        />
      ))}
      {points.map((p, i) => {
        const [x, y] = vertex(i, total, 1);
        return <line key={`spoke-${p.id}`} data-part="spoke" className="radar-spoke" x1={CENTER} y1={CENTER} x2={x} y2={y} />;
      })}
      <polygon data-part="shape" className="radar-shape" points={toPoints(shape)} />
      {shape.map(([x, y], i) => (
        <circle key={`dot-${points[i]!.id}`} data-part="dot" className="radar-dot" cx={x} cy={y} r={3} />
      ))}
      {points.map((p, i) => {
        const [x, y] = vertex(i, total, 1.2);
        const anchor = Math.abs(x - CENTER) < 6 ? 'middle' : x > CENTER ? 'start' : 'end';
        return (
          <text key={`label-${p.id}`} className="radar-label" x={x} y={y} textAnchor={anchor}>
            {p.label}
          </text>
        );
      })}
    </svg>
  );
}
