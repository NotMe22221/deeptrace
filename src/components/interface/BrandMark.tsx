/** DEEPTRACE mark: a ground line with strata descending beneath it, traced by a probe. */
export function BrandMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <rect x="1" y="1" width="22" height="22" rx="6" fill="#0b1220" stroke="rgba(148,163,184,0.28)" />
      <path d="M5 8.2h14" stroke="#e2e8f0" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M6.5 11.6h11" stroke="#22d3ee" strokeWidth="1.2" strokeLinecap="round" opacity="0.9" />
      <path d="M8 14.6h8" stroke="#f5b83d" strokeWidth="1.2" strokeLinecap="round" opacity="0.9" />
      <path d="M9.5 17.4h5" stroke="#a78bfa" strokeWidth="1.2" strokeLinecap="round" opacity="0.9" />
      <path d="M12 5v14.5" stroke="#e2e8f0" strokeWidth="0.9" strokeDasharray="1.2 1.6" opacity="0.55" />
      <circle cx="12" cy="19.4" r="1.25" fill="#e2e8f0" />
    </svg>
  );
}
