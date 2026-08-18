import { Fragment } from "react";

type StepProgressProps = {
  currentStep: number;
  onStep: (step: number) => void;
};

const steps = [
  ["网络类型", "选择网络类型"],
  ["国家/地区", "选择目标国家"],
  ["运营商", "选择运营商"],
  ["规格", "选择套餐规格"],
  ["有效期", "选择购买时长"],
  ["确认订单", "确认并支付"],
] as const;

export function StepProgress({ currentStep, onStep }: StepProgressProps) {
  const current = steps[currentStep - 1] ?? steps[0];
  return (
    <>
      <nav className="sub-steps" aria-label="套餐选择步骤">
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
        <span className="sub-mobile-progress-label"><b>{current[1]}</b><span>步骤 <em>{currentStep}</em> / 6</span></span>
        <span className="sub-mobile-progress-track"><i style={{ width: `${(currentStep / 6) * 100}%` }} /></span>
      </button>
    </>
  );
}
