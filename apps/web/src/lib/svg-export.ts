function safeStem(value: string): string {
  const stem = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return stem || "diffubar-figure";
}

/** Serialize the live, edited SVG without rasterization or external styles. */
export function downloadSvg(svg: SVGSVGElement, title: string): void {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.removeAttribute("aria-labelledby");
  clone.querySelectorAll("[data-transient='true']").forEach((node) => node.remove());
  const viewBox = clone.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
  if (viewBox?.length === 4) {
    clone.setAttribute("width", String(viewBox[2]));
    clone.setAttribute("height", String(viewBox[3]));
  }
  const serialized = new XMLSerializer().serializeToString(clone);
  const source = `<?xml version="1.0" encoding="UTF-8"?>\n${serialized}\n`;
  const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeStem(title)}.svg`;
  anchor.click();
  URL.revokeObjectURL(url);
}
