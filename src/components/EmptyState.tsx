export default function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="card grid place-items-center px-6 py-12 text-center">
      <div className="max-w-sm">
        <p className="font-medium">{title}</p>
        <p className="muted mt-1 text-sm">{body}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}
