import fs from 'fs';

export function decodeTextBuffer(buffer: Buffer): string {
  if (buffer.length >= 3
    && buffer[0] === 0xef
    && buffer[1] === 0xbb
    && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const withoutBom = buffer.subarray(2);
    const swapped = Buffer.allocUnsafe(withoutBom.length);
    for (let index = 0; index < withoutBom.length; index += 2) {
      swapped[index] = withoutBom[index + 1] ?? 0;
      swapped[index + 1] = withoutBom[index] ?? 0;
    }
    return swapped.toString('utf16le');
  }

  return buffer.toString('utf8');
}
export function readTextFile(filePath: string): string {
  return decodeTextBuffer(fs.readFileSync(filePath));
}

export function writeUtf8TextFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf8');
}
