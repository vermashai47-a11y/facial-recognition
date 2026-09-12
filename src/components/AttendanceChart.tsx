'use client';

/**
 * Fourteen-day attendance mix.
 *
 * Form: stacked bars — the job is "how did each day break down", and the parts
 * sum to a meaningful whole (headcount). Colours come from the reserved status
 * palette (good / warning / critical), never the categorical series slots, so a
 * status colour can never be mistaken for "series 4".
 *
 * Status-warning sits below 3:1 on a white surface by design, so the relief rule
 * applies: the legend is always present and a table view is one click away.
 */

import { useId, useState } from 'react';
import { dayLabel } from '@/lib/format';

export interface DayBreakdown {
  day: string; // ISO date
  present: number;
  late: number;
  absent: number;
}

const SERIES = [
  { key: 'present', label: 'Present', color: '#0ca30c', symbol: '●' },
  { key: 'late', label: 'Late', color: '#fab219', symbol: '▲' },
  { key: 'absent', label: 'Absent', color: '#d03b3b', symbol: '■' },
] as const;

export default function AttendanceChart({ data }: { data: DayBreakdown[] }) {
  const [showTable, setShowTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();

  const max = Math.max(1, ...data.map((d) => d.present + d.late + d.absent));

  return (
    <section className="card p-4" aria-labelledby={titleId}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id={titleId} className="text-sm font-semibold">
          Last 14 days
        </h2>
        <div className="flex items-center gap-4">
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {SERIES.map((s) => (
              <li key={s.key} className="muted flex items-center gap-1.5 text-xs">
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 rounded-[2px]"
                  style={{ background: s.color }}
                />
                {s.label}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="muted text-xs underline underline-offset-4"
            onClick={() => setShowTable((v) => !v)}
            aria-expanded={showTable}
          >
            {showTable ? 'Chart' : 'Table'}
          </button>
        </div>
      </div>

      {showTable ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead>
              <tr className="muted border-b border-[var(--border)] text-left text-xs">
                <th scope="col" className="py-2 pr-4 font-medium">Day</th>
                {SERIES.map((s) => (
                  <th key={s.key} scope="col" className="py-2 pr-4 text-right font-medium">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.day} className="border-b border-[var(--border)] last:border-0">
                  <th scope="row" className="py-1.5 pr-4 text-left font-normal">{dayLabel(d.day)}</th>
                  <td className="py-1.5 pr-4 text-right">{d.present}</td>
                  <td className="py-1.5 pr-4 text-right">{d.late}</td>
                  <td className="py-1.5 pr-4 text-right">{d.absent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <div className="flex h-44 items-end gap-1.5">
            {data.map((d, i) => {
              const total = d.present + d.late + d.absent;
              return (
                <div
                  key={d.day}
                  className="group relative flex h-full flex-1 flex-col justify-end"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  tabIndex={0}
                  role="img"
                  aria-label={`${dayLabel(d.day)}: ${d.present} present, ${d.late} late, ${d.absent} absent`}
                >
                  {/* Segments render top-down: absent, late, present, with a 2px
                      surface gap between them so adjacent fills never merge. */}
                  {([...SERIES].reverse()).map((s) => {
                    const value = d[s.key];
                    if (value === 0) return null;
                    return (
                      <div
                        key={s.key}
                        style={{
                          height: `${(value / max) * 100}%`,
                          background: s.color,
                          marginBottom: 2,
                        }}
                        className="w-full first:rounded-t-[4px] last:mb-0 last:rounded-b-[2px]"
                      />
                    );
                  })}
                  {total === 0 && <div className="h-0.5 w-full rounded bg-[var(--border)]" />}

                  {hover === i && (
                    <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-36 -translate-x-1/2 rounded-lg bg-slate-900 px-2.5 py-2 text-xs text-white shadow-lg">
                      <p className="font-medium">{dayLabel(d.day)}</p>
                      {SERIES.map((s) => (
                        <p key={s.key} className="flex justify-between tabular-nums text-white/80">
                          <span>{s.label}</span>
                          <span>{d[s.key]}</span>
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="muted mt-2 flex justify-between text-[11px] tabular-nums">
            <span>{data[0] ? dayLabel(data[0].day) : ''}</span>
            <span>{data.at(-1) ? dayLabel(data.at(-1)!.day) : ''}</span>
          </div>
        </div>
      )}
    </section>
  );
}
