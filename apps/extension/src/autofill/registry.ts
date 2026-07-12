/**
 * Binding registry mapping serializable descriptor refs to live DOM elements.
 *
 * Keeping element handles out of the serializable result types lets the public
 * API return JSON-safe data while `executeFill`/`undoFill` still resolve the
 * real controls in the same runtime. A registry instance is created per
 * inspection so parallel or repeated inspections never alias each other.
 */

export class BindingRegistry {
  private readonly bindings = new Map<string, Element>();
  private counter = 0;

  /** Register an element and return a fresh stable ref. */
  register(element: Element): string {
    this.counter += 1;
    const ref = `f${this.counter.toString(36)}`;
    this.bindings.set(ref, element);
    return ref;
  }

  resolve(ref: string): Element | undefined {
    return this.bindings.get(ref);
  }

  has(ref: string): boolean {
    return this.bindings.has(ref);
  }

  get size(): number {
    return this.bindings.size;
  }
}
