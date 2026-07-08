interface Props {
  index: number;
  count: number;
}

export default function ProgressBar({ index, count }: Props) {
  const pct = count > 0 ? ((index + 1) / count) * 100 : 0;
  return (
    <div className="progress" aria-hidden="true">
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
