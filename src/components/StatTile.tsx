interface StatTileProps {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warning' | 'critical';
}

const TONE: Record<NonNullable<StatTileProps['tone']>, string> = {
  neutral: 'text-[var(--text)]',
  good: 'text-[#0ca30c]',
  warning: 'text-[#a06f00] dark:text-[#fab219]',
  critical: 'text-[#d03b3b]',
};

export default function StatTile({ label, value, hint, tone = 'neutral' }: StatTileProps) {
  return (
    <div className="card px-4 py-3.5">
      <p className="muted text-xs font-medium uppercase tracking-wide">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${TONE[tone]}`}>{value}</p>
      {hint && <p className="muted mt-0.5 text-xs">{hint}</p>}
    </div>
  );
}
