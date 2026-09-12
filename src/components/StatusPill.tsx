import { STATUS_STYLE } from '@/lib/format';
import { STATUS_LABEL, type DayStatus } from '@/lib/types';

export default function StatusPill({ status }: { status: DayStatus }) {
  return <span className={`pill ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>;
}
