export interface DownloadFile { readonly name: string; readonly data: string | Uint8Array }

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadText(text: string, filename: string, type = "text/plain;charset=utf-8"): void {
  downloadBlob(new Blob([text], { type }), filename);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let entry = 0; entry < 256; entry += 1) {
    let value = entry;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[entry] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function u16(target: Uint8Array, offset: number, value: number): void { target[offset] = value & 255; target[offset + 1] = (value >>> 8) & 255; }
function u32(target: Uint8Array, offset: number, value: number): void { u16(target, offset, value & 0xffff); u16(target, offset + 2, value >>> 16); }
function join(parts: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> { const total = parts.reduce((sum, part) => sum + part.length, 0); const output = new Uint8Array(total); let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output; }

/** Standards-compliant STORE-only ZIP: no dependency and no compression latency. */
export function createStoredZip(files: readonly DownloadFile[]): Blob {
  const encoder = new TextEncoder();
  const localParts: Uint8Array<ArrayBuffer>[] = [];
  const centralParts: Uint8Array<ArrayBuffer>[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name.replaceAll("\\", "/"));
    const data: Uint8Array<ArrayBuffer> = typeof file.data === "string" ? encoder.encode(file.data) : Uint8Array.from(file.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    u32(local, 0, 0x04034b50); u16(local, 4, 20); u16(local, 6, 0x0800); u16(local, 8, 0); u32(local, 14, crc); u32(local, 18, data.length); u32(local, 22, data.length); u16(local, 26, name.length); local.set(name, 30);
    localParts.push(local, data);
    const central = new Uint8Array(46 + name.length);
    u32(central, 0, 0x02014b50); u16(central, 4, 20); u16(central, 6, 20); u16(central, 8, 0x0800); u16(central, 10, 0); u32(central, 16, crc); u32(central, 20, data.length); u32(central, 24, data.length); u16(central, 28, name.length); u32(central, 42, localOffset); central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length + data.length;
  }
  const central = join(centralParts);
  const end = new Uint8Array(22);
  u32(end, 0, 0x06054b50); u16(end, 8, files.length); u16(end, 10, files.length); u32(end, 12, central.length); u32(end, 16, localOffset);
  return new Blob([...localParts, central, end], { type: "application/zip" });
}
