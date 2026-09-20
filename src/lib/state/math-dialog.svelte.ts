export interface MathRequest {
  /** "Equation" when adding one, "Edit equation" when changing one that exists. */
  title: string;
  confirmLabel: string;
  /** A rect, since the caret is not a control. */
  anchor: HTMLElement | DOMRect | null;
  source: string;
  /** Drawn on its own line, as a block is. */
  display: boolean;
  answer: (source: string | null) => void;
}

/** The one dialog lives in `AppLayout`; this is how the editor reaches it. */
class MathDialog {
  request = $state<MathRequest | null>(null);

  get open(): boolean {
    return this.request !== null;
  }

  confirm(source: string): void {
    const request = this.request;
    this.request = null;
    request?.answer(source);
  }

  cancel(): void {
    const request = this.request;
    this.request = null;
    request?.answer(null);
  }
}

export const mathDialog = new MathDialog();

/** Resolves with the LaTeX source, or null if the dialog was dismissed. */
export function askMath(opts: {
  title?: string;
  confirmLabel?: string;
  source?: string;
  display?: boolean;
  anchor?: HTMLElement | DOMRect | null;
}): Promise<string | null> {
  mathDialog.cancel();
  return new Promise((answer) => {
    mathDialog.request = {
      title: opts.title ?? "Equation",
      confirmLabel: opts.confirmLabel ?? "Add equation",
      anchor: opts.anchor ?? null,
      source: opts.source ?? "",
      display: opts.display ?? false,
      answer,
    };
  });
}
