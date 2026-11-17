import React from 'react';

interface KpiCardProps {
  label: string;
  value: string | number;
  subtext?: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}

export const KpiCard: React.FC<KpiCardProps> = ({
  label,
  value,
  subtext,
  tone = 'default',
}) => {
  const valueTone =
    tone === 'danger'
      ? 'text-red-700'
      : tone === 'warning'
        ? 'text-amber-700'
        : tone === 'success'
          ? 'text-emerald-700'
          : 'text-slate-900';

  const isLongText = typeof value === 'string' && value.length > 10 && !/^[₹0-9.,%\s/+-]+$/.test(value);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 min-w-0">
      <p className="text-xs font-medium text-slate-500 truncate">{label}</p>
      <p
        className={`mt-1.5 font-semibold tracking-tight ${
          isLongText
            ? 'text-base sm:text-lg leading-snug break-words'
            : 'text-xl sm:text-2xl font-mono tabular-nums'
        } ${valueTone}`}
      >
        {value}
      </p>
      {subtext && <p className="mt-1 text-xs text-slate-500 truncate">{subtext}</p>}
    </div>
  );
};
