import { Fragment } from "react";
import { useT } from "../../lib/i18n";

type StepProgressProps = {
  steps: readonly (readonly [string, string])[];
  currentStep: number;
  onStep: (step: number) => void;
};

export function StepProgress({ steps, currentStep, onStep }: StepProgressProps) {
  const t = useT();
  const current = steps[currentStep - 1] ?? steps[0];
  return (
    <>
      <nav className="sub-steps" aria-label={t.subscribe.stepsNavLabel}>
        {steps.map(([name, tip], index) => {
          const number = index + 1;
          return (
            <Fragment key={name}>
              <button
                type="button"
                className={`sub-step ${number < currentStep ? "is-done" : ""} ${number === currentStep ? "is-current" : ""}`}
                aria-current={number === currentStep ? "step" : undefined}
                onClick={() => onStep(number)}
              >
                <span className="sub-step-number">{number}</span>
                <span className="sub-step-copy"><b>{name}</b><small>{tip}</small></span>
              </button>
              {index < steps.length - 1 && <span className={`sub-step-bar ${number < currentStep ? "is-filled" : ""}`} />}
            </Fragment>
          );
        })}
      </nav>
      <button type="button" className="sub-mobile-progress" onClick={() => onStep(currentStep)}>
        <span className="sub-mobile-progress-label"><b>{current[1]}</b><span>{t.subscribe.mobileStep} <em>{currentStep}</em> / {steps.length}</span></span>
        <span className="sub-mobile-progress-track"><i style={{ width: `${(currentStep / steps.length) * 100}%` }} /></span>
      </button>
    </>
  );
}
