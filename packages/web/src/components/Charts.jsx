/**
 * Chart components.
 *
 * Wrappers around Recharts that fix the two things a raw chart library
 * gets wrong in a themed app: colours come from CSS variables (read at
 * render so they follow the light/dark switch), and tooltips use the app's
 * own surface styling rather than the library default.
 */

import { useEffect, useState } from 'react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, AreaChart, Area, BarChart, Bar,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts';
import { formatCurrency } from '@subtrack/shared';
import { useTheme } from '../lib/theme.jsx';

/**
 * Read resolved CSS custom properties.
 * Recharts needs concrete colour values (it writes them into SVG
 * attributes), so `var(--x)` cannot be passed through. Re-read whenever the
 * theme changes.
 */
function useChartColors() {
  const { theme } = useTheme();
  const [colors, setColors] = useState(() => ({
    grid: '#e5e8f0', text: '#7c899d', brand: '#4f46e5', surface: '#fff',
  }));

  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    setColors({
      grid: read('--border', '#e5e8f0'),
      text: read('--text-muted', '#7c899d'),
      brand: read('--brand', '#4f46e5'),
      surface: read('--surface-raised', '#fff'),
      success: read('--success', '#10b981'),
      danger: read('--danger', '#ef4444'),
    });
  }, [theme]);

  return colors;
}

/** Categorical palette: distinguishable, and legible in both themes. */
export const SERIES_COLORS = [
  '#4f46e5', '#e0245e', '#0ea5e9', '#10b981', '#f59e0b',
  '#8b5cf6', '#14b8a6', '#f43f5e', '#6366f1', '#84cc16',
];

const money = (value, currency = 'USD') => formatCurrency(value, currency);

function CustomTooltip({ active, payload, label, currency, labelFormatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      {label !== undefined ? (
        <div className="chart-tooltip-label">
          {labelFormatter ? labelFormatter(label) : label}
        </div>
      ) : null}
      {payload.map((entry) => (
        <div key={entry.dataKey ?? entry.name} className="row gap-2" style={{ justifyContent: 'space-between' }}>
          <span className="row gap-2">
            <span className="dot" style={{ background: entry.color ?? entry.payload?.fill }} />
            <span className="secondary">{entry.name}</span>
          </span>
          <strong className="nums">{money(entry.value, currency)}</strong>
        </div>
      ))}
    </div>
  );
}

/** "2026-09" -> "Sep 2026" */
export function formatMonthLabel(month) {
  if (typeof month !== 'string' || month.length < 7) return month;
  const date = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return month;
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const shortMonth = (month) => formatMonthLabel(month).replace(' 20', " '");

/** Spend split by category. */
export function CategoryPie({ data, currency = 'USD', height = 260 }) {
  const colors = useChartColors();
  if (!data?.length) return null;

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={data}
            dataKey="monthly"
            nameKey="category"
            cx="50%"
            cy="50%"
            // A donut rather than a full pie: the hole gives the centre
            // label somewhere to live and makes small slices easier to see.
            innerRadius="52%"
            outerRadius="80%"
            paddingAngle={2}
            stroke={colors.surface}
            strokeWidth={2}
            animationDuration={600}
          >
            {data.map((entry, index) => (
              <Cell key={entry.category} fill={entry.color ?? SERIES_COLORS[index % SERIES_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip currency={currency} />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="chart-legend">
        {data.slice(0, 8).map((entry, index) => (
          <span key={entry.category} className="chart-legend-item">
            <span
              className="dot"
              style={{ background: entry.color ?? SERIES_COLORS[index % SERIES_COLORS.length] }}
            />
            {entry.category}
            <strong className="nums">{entry.percent}%</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Historical spend per month. */
export function SpendAreaChart({ data, currency = 'USD', height = 260, average }) {
  const colors = useChartColors();
  if (!data?.length) return null;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <defs>
          <linearGradient id="spendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colors.brand} stopOpacity={0.32} />
            <stop offset="100%" stopColor={colors.brand} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
        <XAxis
          dataKey="month"
          tickFormatter={shortMonth}
          tick={{ fill: colors.text, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: colors.text, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(value) => `$${value >= 1000 ? `${Math.round(value / 100) / 10}k` : Math.round(value)}`}
        />
        <Tooltip content={<CustomTooltip currency={currency} labelFormatter={formatMonthLabel} />} />
        {/* The average line turns a squiggle into something you can read a
            month against. */}
        {average ? (
          <ReferenceLine
            y={average}
            stroke={colors.text}
            strokeDasharray="4 4"
            label={{ value: 'avg', position: 'right', fill: colors.text, fontSize: 10 }}
          />
        ) : null}
        <Area
          type="monotone"
          dataKey="total"
          name="Spent"
          stroke={colors.brand}
          strokeWidth={2.5}
          fill="url(#spendFill)"
          animationDuration={700}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: colors.surface }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/**
 * Forecast with its confidence band.
 *
 * History and forecast are drawn as one continuous series with the
 * predicted part dashed, and the interval as a shaded band — so the
 * uncertainty is visible rather than implied by a single confident line.
 */
export function ForecastChart({ history = [], predictions = [], currency = 'USD', height = 280 }) {
  const colors = useChartColors();
  if (!history.length && !predictions.length) return null;

  const data = [
    ...history.map((point) => ({
      month: point.month,
      actual: point.total,
      // Join the two series at the last actual point so the line is
      // unbroken across the boundary.
      predicted: null,
      band: null,
    })),
    ...predictions.map((point) => ({
      month: point.month,
      actual: null,
      predicted: point.predicted,
      lower: point.lower,
      // Recharts stacks from the baseline, so the band is drawn as
      // [lower, upper-lower].
      band: Math.max(0, point.upper - point.lower),
    })),
  ];

  // Bridge the gap: give the first prediction row the last actual value.
  const lastActual = history[history.length - 1];
  const firstPrediction = data.find((row) => row.predicted != null);
  if (lastActual && firstPrediction) {
    const bridge = data.find((row) => row.month === lastActual.month);
    if (bridge) bridge.predicted = lastActual.total;
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <defs>
          <linearGradient id="actualFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colors.brand} stopOpacity={0.24} />
            <stop offset="100%" stopColor={colors.brand} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
        <XAxis
          dataKey="month"
          tickFormatter={shortMonth}
          tick={{ fill: colors.text, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: colors.text, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(value) => `$${value >= 1000 ? `${Math.round(value / 100) / 10}k` : Math.round(value)}`}
        />
        <Tooltip content={<CustomTooltip currency={currency} labelFormatter={formatMonthLabel} />} />
        {/* An explicit payload: the invisible `lower` series exists only to
            offset the stacked confidence band, and `legendType="none"` does
            not reliably keep it out of an auto-generated legend. */}
        <Legend
          verticalAlign="top"
          height={28}
          wrapperStyle={{ fontSize: 12, color: colors.text }}
          payload={[
            { value: 'Actual', type: 'plainline', color: colors.brand, payload: { strokeDasharray: '0' } },
            { value: 'Forecast', type: 'plainline', color: colors.brand, payload: { strokeDasharray: '5 4' } },
            { value: 'Confidence range', type: 'rect', color: colors.brand },
          ]}
        />

        {/* Invisible floor, then the visible band on top of it. */}
        <Area dataKey="lower" stackId="band" stroke="none" fill="none" legendType="none" name="lower" />
        <Area
          dataKey="band"
          stackId="band"
          stroke="none"
          fill={colors.brand}
          fillOpacity={0.12}
          name="Confidence range"
          legendType="none"
        />

        <Area
          type="monotone"
          dataKey="actual"
          name="Actual"
          stroke={colors.brand}
          strokeWidth={2.5}
          fill="url(#actualFill)"
          connectNulls={false}
          dot={false}
        />
        <Area
          type="monotone"
          dataKey="predicted"
          name="Forecast"
          stroke={colors.brand}
          strokeWidth={2}
          strokeDasharray="5 4"
          fill="none"
          connectNulls
          dot={{ r: 3, fill: colors.surface, strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Horizontal bars, used for per-category comparisons. */
export function CategoryBarChart({ data, currency = 'USD', height = 280 }) {
  const colors = useChartColors();
  if (!data?.length) return null;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} horizontal={false} />
        <XAxis
          type="number"
          tick={{ fill: colors.text, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(value) => `$${Math.round(value)}`}
        />
        <YAxis
          type="category"
          dataKey="category"
          tick={{ fill: colors.text, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={104}
        />
        <Tooltip content={<CustomTooltip currency={currency} />} cursor={{ fill: colors.grid, opacity: 0.3 }} />
        <Bar dataKey="monthly" name="Monthly" radius={[0, 6, 6, 0]} animationDuration={600}>
          {data.map((entry, index) => (
            <Cell key={entry.category} fill={entry.color ?? SERIES_COLORS[index % SERIES_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Stacked spend by category over time. */
export function StackedCategoryChart({ categories = [], series = [], currency = 'USD', height = 280 }) {
  const colors = useChartColors();
  if (!series.length) return null;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={series} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
        <XAxis
          dataKey="month"
          tickFormatter={shortMonth}
          tick={{ fill: colors.text, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: colors.text, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(value) => `$${Math.round(value)}`}
        />
        <Tooltip content={<CustomTooltip currency={currency} labelFormatter={formatMonthLabel} />} />
        <Legend wrapperStyle={{ fontSize: 11, color: colors.text }} iconType="circle" iconSize={8} />
        {categories.map((category, index) => (
          <Bar
            key={category}
            dataKey={category}
            stackId="spend"
            name={category}
            fill={SERIES_COLORS[index % SERIES_COLORS.length]}
            // Only the topmost segment gets rounded corners, which needs
            // per-bar knowledge; a flat radius on all reads as stripes.
            radius={index === categories.length - 1 ? [5, 5, 0, 0] : 0}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Compact sparkline for stat cards. */
export function Sparkline({ data, dataKey = 'total', height = 40, tone = 'brand' }) {
  const colors = useChartColors();
  if (!data?.length) return null;
  const stroke = tone === 'success' ? colors.success : tone === 'danger' ? colors.danger : colors.brand;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
        <Line type="monotone" dataKey={dataKey} stroke={stroke} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
