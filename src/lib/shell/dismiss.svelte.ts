interface Dismissible {
  isOpen: () => boolean;
  /** Elements a pointer press may land in without dismissing. */
  anchors: () => (HTMLElement | null | undefined)[];
  close: () => void;
  /** For closing and stopping there, so a dialog behind does not take the same Escape. */
  escape?: (event: KeyboardEvent) => void;
}

/** Capture-phase, so a press is caught before the thing under it acts. */
export function dismissible({ isOpen, anchors, close, escape }: Dismissible): void {
  $effect(() => {
    if (!isOpen()) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchors().some((el) => el?.contains(target))) return;
      close();
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (escape) escape(event);
      else close();
    };
    const onLeave = () => close();

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeydown, true);
    window.addEventListener("blur", onLeave);
    window.addEventListener("resize", onLeave);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("resize", onLeave);
    };
  });
}
