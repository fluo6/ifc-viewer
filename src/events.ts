export class Emitter<T> {
  private handlers = new Set<(value: T) => void>();
  on(handler: (value: T) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(value: T): void {
    for (const h of this.handlers) h(value);
  }
}
