/** Three separate contributions meet in one piece of work: the product's mark. */
export function RellaneMark({
  className = ""
}: {
  readonly className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 8h12a8 8 0 0 1 0 16H8V8Z"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <path
        d="M8 16h12M8 24v8M20 24l12 8"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="31" cy="9" r="4" className="rellane-mark__spark" />
    </svg>
  );
}
