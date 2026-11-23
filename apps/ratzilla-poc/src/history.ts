/**
 * Undo/redo over whole annotation states. osdlabel has no history of its own,
 * so the bridge records every committed change (a draw, an edit's
 * `object:modified`, a delete, an import) and restores through
 * `loadAnnotations`.
 */
export class History<T> {
  private readonly past: T[] = [];
  private readonly future: T[] = [];
  private present: T | undefined;

  constructor(private readonly limit = 100) {}

  /** Records a state the user produced. Discards anything to redo. */
  record(state: T): void {
    if (this.present !== undefined) {
      this.past.push(this.present);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.present = state;
    this.future.length = 0;
  }

  /** The state to restore, or `undefined` when there is nothing to undo. */
  undo(): T | undefined {
    const previous = this.past.pop();
    if (previous === undefined || this.present === undefined) return undefined;
    this.future.push(this.present);
    this.present = previous;
    return previous;
  }

  redo(): T | undefined {
    const next = this.future.pop();
    if (next === undefined || this.present === undefined) return undefined;
    this.past.push(this.present);
    this.present = next;
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
