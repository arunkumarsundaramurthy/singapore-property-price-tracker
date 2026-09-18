export async function* toAsync<T>(items: T[]): AsyncGenerator<T> {
  yield* items;
}
