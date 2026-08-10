import type { RefObject } from "react";

interface WidgetModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly source: string;
  readonly frameRef: RefObject<HTMLIFrameElement | null>;
  readonly applyLabel: string;
  readonly applying: boolean;
  readonly onCancel: () => void;
  readonly onApply: () => void;
}

export function WidgetModal({
  open,
  title,
  description,
  source,
  frameRef,
  applyLabel,
  applying,
  onCancel,
  onApply,
}: WidgetModalProps) {
  return (
    <section className={`widget-modal ${open ? "is-open" : "is-parked"}`} aria-hidden={!open}>
      <div className="widget-modal__bar">
        <div>
          <p className="eyebrow">Workspace tool</p>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <div className="widget-modal__actions">
          <button type="button" className="button button--quiet" onClick={onCancel}>Cancel</button>
          <button type="button" className="button button--primary" disabled={applying} onClick={onApply}>
            {applying ? "Applying…" : applyLabel}
          </button>
        </div>
      </div>
      <iframe
        ref={frameRef}
        className="widget-modal__frame"
        src={source}
        title={title}
        tabIndex={open ? 0 : -1}
        allow="clipboard-read; clipboard-write; webgpu"
      />
    </section>
  );
}
