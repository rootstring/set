export interface Confirm {
  /** The control that asked. The popover opens beside it; null centres it. */
  anchor?: HTMLElement | null;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

export interface Opt {
  value: string;
  label: string;
}

/** `warn` colours the line, so a problem is not taken for a confirmation. */
export type FlashTone = "info" | "warn";

export interface TabContext {
  confirm: (request: Confirm) => void;
  flash: (message: string, tone?: FlashTone) => void;
  close: () => void;
}

export function whenLabel(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) return time;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}
