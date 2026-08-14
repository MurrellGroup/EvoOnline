import React, { useEffect, useRef, useState, type InputHTMLAttributes } from "react";

interface CommittedNumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue" | "onChange"> {
  readonly value: number;
  readonly onCommit: (value: number) => void;
  readonly integer?: boolean;
}

function numericBound(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeCommittedNumberDraft(
  draft: string,
  current: number,
  min?: string | number,
  max?: string | number,
  integer = true,
): number {
  const parsed = draft.trim() === "" ? Number.NaN : Number(draft);
  if (!Number.isFinite(parsed)) return current;
  const rounded = integer ? Math.trunc(parsed) : parsed;
  return Math.max(numericBound(min, -Infinity), Math.min(numericBound(max, Infinity), rounded));
}

/**
 * A number field whose text is deliberately decoupled from committed state.
 * Users can clear and replace the whole value; Enter or blur validates and
 * commits it. Escape restores the last committed value.
 */
export function CommittedNumberInput({
  value,
  onCommit,
  integer = true,
  min,
  max,
  onBlur,
  onFocus,
  onKeyDown,
  ...inputProps
}: CommittedNumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  const skipNextBlurCommit = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const commit = (): void => {
    const bounded = normalizeCommittedNumberDraft(draft, value, min, max, integer);
    setDraft(String(bounded));
    if (bounded !== value) onCommit(bounded);
  };

  return <input
    {...inputProps}
    type="number"
    min={min}
    max={max}
    value={draft}
    onChange={(event) => setDraft(event.target.value)}
    onFocus={(event) => {
      focused.current = true;
      onFocus?.(event);
    }}
    onBlur={(event) => {
      focused.current = false;
      if (skipNextBlurCommit.current) {
        skipNextBlurCommit.current = false;
        setDraft(String(value));
      } else {
        commit();
      }
      onBlur?.(event);
    }}
    onKeyDown={(event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.currentTarget.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        skipNextBlurCommit.current = true;
        setDraft(String(value));
        event.currentTarget.blur();
      }
      onKeyDown?.(event);
    }}
  />;
}
