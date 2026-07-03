import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

export interface SeriesDef {
  key: string
  name: string
  color: string
  type?: "line" | "bar"
  dashed?: boolean
  fillOpacity?: number
}

interface Props {
  data: Record<string, unknown>[]
  xKey: string
  series: SeriesDef[]
  height?: number
  yLabel?: string
}

/** Themed Recharts composed chart — mixes bar + line series. */
export function SeriesChart({ data, xKey, series, height = 260, yLabel }: Props) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} interval="preserveStartEnd" tickLine={false} axisLine={false} />
        <YAxis
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          label={yLabel ? { value: yLabel, angle: -90, position: "insideLeft", fontSize: 10, fill: "hsl(var(--muted-foreground))" } : undefined}
        />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: "hsl(var(--foreground))" }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {series.map((s) =>
          s.type === "bar" ? (
            <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} fillOpacity={s.fillOpacity ?? 0.6} radius={[3, 3, 0, 0]} />
          ) : (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.dashed ? "5 4" : undefined}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ),
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
