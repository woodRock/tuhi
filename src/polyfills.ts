// WebKit (the macOS webview) can't iterate a ReadableStream with `for await` yet; pdf.js does
// in getTextContent(), which the PDF comment import and the References search use.
const streams = ReadableStream.prototype as unknown as Record<symbol, unknown>;
if (!streams[Symbol.asyncIterator]) {
  streams[Symbol.asyncIterator] = async function* <T>(this: ReadableStream<T>) {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}
