/** LolkaMod's hexagon and transparent LM cutouts, adapted from the supplied mark. */
export const BRAND_HEX_PATH = "M858.4 676 Q858.4 712 827.22 730 L543.18 894 Q512 912 480.82 894 L196.78 730 Q165.6 712 165.6 676 L165.6 348 Q165.6 312 196.78 294 L480.82 130 Q512 112 543.18 130 L827.22 294 Q858.4 312 858.4 348 Z";
export const BRAND_CUTOUTS = {
  regular: { width: 85, paths: ["M320 380V644H440", "M540 644V380L630 500L720 380V644"] },
  sidebar: { width: 135, paths: ["M280 380V644H400", "M550 644V380L650 480L750 380V644"] },
} as const;

let nextMark = 0;
/** Every inline mark owns its mask, so repeated panels cannot resolve another mark's ID. */
export function createBrandMark(document: Document, variant: keyof typeof BRAND_CUTOUTS = "regular", size = 38): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1024 1024");
  svg.setAttribute("width", String(size)); svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  svg.setAttribute("data-lolkamod-brand", variant);
  const id = `lolkamod-brand-${++nextMark}`;
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const mask = document.createElementNS("http://www.w3.org/2000/svg", "mask");
  mask.setAttribute("id", id); mask.setAttribute("maskUnits", "userSpaceOnUse");
  mask.setAttribute("x", "0"); mask.setAttribute("y", "0");
  mask.setAttribute("width", "1024"); mask.setAttribute("height", "1024");
  const white = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  white.setAttribute("width", "1024"); white.setAttribute("height", "1024"); white.setAttribute("fill", "white");
  mask.append(white);
  for (const d of BRAND_CUTOUTS[variant].paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d); path.setAttribute("fill", "none"); path.setAttribute("stroke", "black");
    path.setAttribute("stroke-width", String(BRAND_CUTOUTS[variant].width));
    path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
    mask.append(path);
  }
  defs.append(mask);
  const hex = document.createElementNS("http://www.w3.org/2000/svg", "path");
  hex.setAttribute("d", BRAND_HEX_PATH); hex.setAttribute("fill", "currentColor");
  hex.setAttribute("mask", `url(#${id})`);
  svg.append(defs, hex);
  return svg;
}
