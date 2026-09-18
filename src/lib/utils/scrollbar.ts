export function applyScrollbarWidthVar(): void {
  if (typeof document === "undefined") return;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden;";
  document.body.appendChild(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  document.documentElement.style.setProperty("--sbw", `${width}px`);
}
