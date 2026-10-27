import { type ReactNode, useId } from "react";
import { InfoTip } from "./InfoTip";
import { rowTitleClass, ruledListClass, ruledRowClass, sectionTitleClass } from "./ui";

/**
 * Settings → a page → one switch row: what the section is about, the row's own
 * title, what turning it on does (a line or a tip), and the switch.
 */
export function SwitchSetting({
  sectionTestId,
  heading,
  title,
  tip,
  description,
  switchTestId,
  on,
  onChange,
}: {
  sectionTestId: string;
  heading: string;
  title: string;
  tip?: string;
  description?: ReactNode;
  switchTestId: string;
  on: boolean;
  onChange(on: boolean): void;
}) {
  const id = useId();
  const described = tip !== undefined || description !== undefined;
  return (
    <section data-testid={sectionTestId}>
      <h4 className={`mb-2 ${sectionTitleClass}`}>{heading}</h4>
      <div className={ruledListClass}>
        <div className={ruledRowClass}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center">
              <label htmlFor={id} className={rowTitleClass}>
                {title}
              </label>
              {tip !== undefined && <InfoTip id={`${id}-description`} text={tip} />}
            </div>
            {description !== undefined && <div id={`${id}-description`}>{description}</div>}
          </div>
          <input
            id={id}
            type="checkbox"
            role="switch"
            aria-checked={on}
            aria-describedby={described ? `${id}-description` : undefined}
            data-testid={switchTestId}
            checked={on}
            onChange={(event) => onChange(event.target.checked)}
            className="switch"
          />
        </div>
      </div>
    </section>
  );
}
