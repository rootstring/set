export interface LinkDraft {
  href: string;
  text: string;
}

export interface LinkRequest {
  /** "Link" when adding one, "Edit link" when changing one that exists. */
  title: string;
  confirmLabel: string;
  /** A rect, since the caret is not a control. */
  anchor: HTMLElement | DOMRect | null;
  draft: LinkDraft;
  answer: (result: LinkDraft | null) => void;
}

/** The one dialog lives in `AppLayout`; this is how the editor reaches it. */
class LinkDialog {
  request = $state<LinkRequest | null>(null);

  get open(): boolean {
    return this.request !== null;
  }

  confirm(draft: LinkDraft): void {
    const request = this.request;
    this.request = null;
    request?.answer(draft);
  }

  cancel(): void {
    const request = this.request;
    this.request = null;
    request?.answer(null);
  }
}

export const linkDialog = new LinkDialog();

/** Resolves with the link, or null if the dialog was dismissed. */
export function askLink(opts: {
  title?: string;
  confirmLabel?: string;
  href?: string;
  text?: string;
  anchor?: HTMLElement | DOMRect | null;
}): Promise<LinkDraft | null> {
  linkDialog.cancel();
  return new Promise((answer) => {
    linkDialog.request = {
      title: opts.title ?? "Link",
      confirmLabel: opts.confirmLabel ?? "Add link",
      anchor: opts.anchor ?? null,
      draft: { href: opts.href ?? "", text: opts.text ?? "" },
      answer,
    };
  });
}
