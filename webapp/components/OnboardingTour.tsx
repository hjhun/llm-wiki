"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Sparkles, X } from "lucide-react";
import { useLanguage } from "./i18n";
import { Button } from "./ui";

const SEEN_KEY = "lw-onboarded";

/**
 * First-run onboarding: a small step-through that explains the raw → ingest →
 * query flow. Shown once, gated by a localStorage flag. Mounted in the
 * protected layout so it appears on the first authenticated page load.
 */
export default function OnboardingTour() {
  const { t } = useLanguage();
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (window.localStorage.getItem(SEEN_KEY) !== "1") {
      setShow(true);
    }
  }, []);

  function dismiss() {
    window.localStorage.setItem(SEEN_KEY, "1");
    setShow(false);
  }

  if (!show) return null;

  const steps = t.onboarding.steps;
  const current = steps[step];
  const isLast = step === steps.length - 1;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-bg/75 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-line bg-bg-panel/95 shadow-[0_28px_70px_rgb(0_0_0_/_0.45)] backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles aria-hidden className="h-4 w-4 text-accent" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
              {t.onboarding.title}
            </span>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label={t.onboarding.skip}
            className="text-ink-faint transition hover:text-ink"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-6">
          <h2 className="text-lg font-semibold text-ink">{current.title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-dim">
            {current.body}
          </p>
          <div className="mt-5 flex justify-center gap-1.5">
            {steps.map((_, i) => (
              <span
                key={i}
                className={[
                  "h-1.5 rounded-full transition-all",
                  i === step ? "w-5 bg-accent" : "w-1.5 bg-line",
                ].join(" ")}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={dismiss}
            className="text-xs text-ink-faint transition hover:text-ink"
          >
            {t.onboarding.skip}
          </button>
          <div className="flex items-center gap-2">
            {step > 0 ? (
              <Button icon={ArrowLeft} onClick={() => setStep((s) => s - 1)}>
                {t.onboarding.back}
              </Button>
            ) : null}
            {isLast ? (
              <Button variant="primary" icon={Check} onClick={dismiss}>
                {t.onboarding.done}
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={ArrowRight}
                onClick={() => setStep((s) => s + 1)}
              >
                {t.onboarding.next}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
