// Streaming "store" (uncompressed) ZIP writer. CRCs and sizes are known up
// front (computed at upload time), so the archive streams straight from disk
// with an exact Content-Length and no temp files. No ZIP64: callers must keep
// the archive under 4 GiB and 65535 entries.

export interface ZipEntry {
  name: string;
  size: number;
  crc32: number;
  mtime: number; // ms epoch
  path: string; // on-disk location
}

export const ZIP_LIMIT_BYTES = 0xffffffff;
export const ZIP_LIMIT_ENTRIES = 0xffff;

const enc = new TextEncoder();

function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function localHeader(e: ZipEntry, name: Uint8Array): Uint8Array {
  const b = new Uint8Array(30 + name.length);
  const v = new DataView(b.buffer);
  const { time, date } = dosTime(e.mtime);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true); // version needed
  v.setUint16(6, 0x0800, true); // UTF-8 names
  v.setUint16(8, 0, true); // stored
  v.setUint16(10, time, true);
  v.setUint16(12, date, true);
  v.setUint32(14, e.crc32, true);
  v.setUint32(18, e.size, true);
  v.setUint32(22, e.size, true);
  v.setUint16(26, name.length, true);
  v.setUint16(28, 0, true);
  b.set(name, 30);
  return b;
}

function centralHeader(e: ZipEntry, name: Uint8Array, offset: number): Uint8Array {
  const b = new Uint8Array(46 + name.length);
  const v = new DataView(b.buffer);
  const { time, date } = dosTime(e.mtime);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, 20, true); // version made by
  v.setUint16(6, 20, true); // version needed
  v.setUint16(8, 0x0800, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, time, true);
  v.setUint16(14, date, true);
  v.setUint32(16, e.crc32, true);
  v.setUint32(20, e.size, true);
  v.setUint32(24, e.size, true);
  v.setUint16(28, name.length, true);
  // extra len, comment len, disk start, internal attrs: 0
  v.setUint32(38, 0, true); // external attrs
  v.setUint32(42, offset, true);
  b.set(name, 46);
  return b;
}

function endRecord(count: number, cdSize: number, cdOffset: number): Uint8Array {
  const b = new Uint8Array(22);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  return b;
}

/** Make entry names unique within the archive ("a.txt", "a (2).txt", ...). */
export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((n) => {
    let candidate = n;
    let i = 2;
    while (seen.has(candidate.toLowerCase())) {
      const dot = n.lastIndexOf(".");
      candidate = dot > 0 ? `${n.slice(0, dot)} (${i})${n.slice(dot)}` : `${n} (${i})`;
      i++;
    }
    seen.add(candidate.toLowerCase());
    return candidate;
  });
}

export function zipLength(entries: ZipEntry[]): number {
  let total = 22;
  for (const e of entries) {
    const n = enc.encode(e.name).length;
    total += 30 + n + e.size + 46 + n;
  }
  return total;
}

export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  const names = entries.map((e) => enc.encode(e.name));
  const offsets: number[] = [];
  let index = 0;
  let offset = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let finished = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (reader) {
        const { done, value } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        reader = null;
        index++;
      }
      if (index < entries.length) {
        const e = entries[index]!;
        offsets[index] = offset;
        const header = localHeader(e, names[index]!);
        offset += header.length + e.size;
        controller.enqueue(header);
        reader = Bun.file(e.path).stream().getReader() as ReadableStreamDefaultReader<Uint8Array>;
        return;
      }
      if (finished) return;
      finished = true;
      const cdStart = offset;
      let cdSize = 0;
      entries.forEach((e, i) => {
        const c = centralHeader(e, names[i]!, offsets[i]!);
        cdSize += c.length;
        controller.enqueue(c);
      });
      controller.enqueue(endRecord(entries.length, cdSize, cdStart));
      controller.close();
    },
    cancel() {
      reader?.cancel().catch(() => {});
    },
  });
}
