type Props = {
  title: string;
  subtitle?: string;
  comingFrom: string;
};

export default function PagePlaceholder({
  title,
  subtitle,
  comingFrom,
}: Props) {
  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex items-center justify-between border-b border-line px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle ? (
            <p className="mt-1 text-sm text-ink-dim">{subtitle}</p>
          ) : null}
        </div>
      </header>

      <section className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="max-w-md rounded-lg border border-line bg-bg-panel p-6 text-sm leading-relaxed text-ink-dim">
          <div className="mb-2 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
            scaffold
          </div>
          <p>
            이 탭은 Phase{" "}
            <span className="font-mono text-ink">{comingFrom}</span>에서
            구현됩니다.
          </p>
          <p className="mt-3 text-ink-faint">
            현재는 Next.js 스캐폴드(Phase 4.1)만 깔린 상태입니다. 좌측의 다른
            탭과 네비게이션은 정상 동작합니다.
          </p>
        </div>
      </section>
    </div>
  );
}
