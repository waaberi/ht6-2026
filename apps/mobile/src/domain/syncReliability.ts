export const pageBounds = (pageIndex: number, pageSize: number) => {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new Error('Page index must be a non-negative integer.');
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('Page size must be a positive integer.');
  const from = pageIndex * pageSize;
  return { from, to: from + pageSize - 1 };
};

export const collectPages = async <T>(
  pageSize: number,
  readPage: (from: number, to: number) => Promise<T[]>,
): Promise<T[]> => {
  const values: T[] = [];
  for (let pageIndex = 0; ; pageIndex += 1) {
    const { from, to } = pageBounds(pageIndex, pageSize);
    const page = await readPage(from, to);
    values.push(...page);
    if (page.length < pageSize) return values;
  }
};

export const chunkValues = <T>(values: T[], chunkSize: number): T[][] => {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('Chunk size must be a positive integer.');
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
};

export const groupValuesBy = <T, K>(values: T[], keyFor: (value: T) => K): Map<K, T[]> => {
  const grouped = new Map<K, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = grouped.get(key);
    if (group) group.push(value);
    else grouped.set(key, [value]);
  }
  return grouped;
};

export const mapSettledWithConcurrency = async <T, R>(
  values: T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> => {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer.');
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: 'fulfilled', value: await work(values[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
};

export const fulfilledValues = <T>(results: PromiseSettledResult<T>[]): T[] =>
  results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);

export const retryBestEffort = async (
  attempts: number,
  work: () => Promise<boolean>,
): Promise<boolean> => {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('Attempts must be a positive integer.');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await work()) return true;
    } catch {
      // A later attempt may recover from a transient network failure.
    }
  }
  return false;
};
