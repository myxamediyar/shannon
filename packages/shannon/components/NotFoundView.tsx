import Link from "next/link";

interface Props {
  /** Body line under the "404" heading. */
  message?: string;
  /** Where the back link points and what it says. */
  backHref?: string;
  backLabel?: string;
}

export function NotFoundView({
  message = "Not found.",
  backHref = "/",
  backLabel = "Back to dashboard",
}: Props) {
  return (
    <div className="h-full flex flex-col items-center justify-center font-lexend px-6 py-16">
      <h1 className="font-extrabold text-5xl text-[var(--th-text)] tracking-tighter mb-2">
        404
      </h1>
      <p className="text-sm text-[var(--th-text-muted)] mb-8">{message}</p>
      <Link
        href={backHref}
        className="text-xs text-[var(--th-text-secondary)] hover:text-[var(--th-text)] underline underline-offset-4 decoration-[var(--th-border-30)] hover:decoration-[var(--th-text)] transition-colors"
      >
        {backLabel}
      </Link>
    </div>
  );
}
