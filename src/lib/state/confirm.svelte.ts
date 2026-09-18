import { settings } from "./settings.svelte";

export interface ConfirmRequest {
  /** Null centres the popover. */
  anchor: HTMLElement | null;
  title: string;
  message: string;
  confirmLabel: string;
  /** Only for deletes that can be taken back. */
  remember: boolean;
  /** The label on the button that isn't the confirm one. */
  cancelLabel?: string;
  /** Deletes are the default, so this opts out. */
  danger?: boolean;
  /**
   * A request whose Cancel button does something passes this, so dismissing does nothing instead.
   */
  onDismiss?: () => void;
  /** Nothing brings this back, so the popover opens on Cancel instead. */
  permanent: boolean;
  /** `asked` is false when the confirmation was skipped; the caller then shows the undo toast. */
  onConfirm: (asked: boolean) => void;
  onCancel?: () => void;
}

type Ask = Omit<ConfirmRequest, "remember" | "permanent">;

class Confirms {
  request = $state<ConfirmRequest | null>(null);

  get open(): boolean {
    return this.request !== null;
  }

  ask(request: ConfirmRequest): void {
    this.request = request;
  }

  confirm(dontAskAgain: boolean): void {
    const request = this.request;
    this.request = null;
    if (!request) return;
    if (dontAskAgain && request.remember) settings.setConfirmDelete(false);
    request.onConfirm(true);
  }

  cancel(): void {
    const request = this.request;
    this.request = null;
    request?.onCancel?.();
  }

  /** Clicked away or Escape: never more than backing out. */
  dismiss(): void {
    const request = this.request;
    this.request = null;
    if (!request) return;
    (request.onDismiss ?? request.onCancel)?.();
  }
}

export const confirms = new Confirms();

/** Skipped when confirmations are off; the undo toast stands behind it then. */
export function askDelete(request: Ask): void {
  if (!settings.confirmDelete) {
    request.onConfirm(false);
    return;
  }
  confirms.ask({ ...request, remember: true, permanent: false });
}

/** Ask before a delete nothing can take back. Always asks. */
export function askPermanent(request: Ask): void {
  confirms.ask({ ...request, remember: false, permanent: true });
}
